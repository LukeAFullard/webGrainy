/**
 * The results of one photo analysis: grain masks and measurements, edits (split, merge,
 * delete, add) with undo/redo, calibration, ROI filtering, statistics, cached derived
 * values, and the photo exports (CSV, JSON, PNG mask, GeoJSON, SVG).
 */
import type {
  CalibrationResult,
  GrainMorphometrics,
  ModelRecommendation,
  Point2D,
  PostProcessResult,
  SedimentStatsReport,
  SerializedAnalysisSession,
  SizeMetric,
  WorkingImageResult,
} from '../types/index.js';
import { unanalysedValidFraction } from './roiTileSkip.js';
import {
  addPolygonGrain as editorAddPolygonGrain,
  computeAllGrainMorphometrics,
  deleteGrain as editorDeleteGrain,
  MaskEditHistory,
  mergeGrains as editorMergeGrains,
  ScaleCalibrator,
  splitGrainAtLine as editorSplitGrainAtLine,
} from './interactiveEditor.js';
import {
  computeExtendedMorphometrics,
  computeFabricRoseStats,
  computeWentworthHistogram,
  type ExtendedGrainMorphometrics,
  type FabricRoseStats,
  type GrainHullCache,
} from './morphometricsExt.js';
import { photoSizeHistogram, type SizeHistogram } from './histograms.js';
import { buildContourGeoJson, buildContourSvg, encodeMaskPng, encodeMaskPngCompressed, resizeLabelsNearest } from './exportFormats.js';
import { computeSedimentStats, filterBorderGrains, grainPassesSizeCutoffs, summaryCsvRows } from './sedimentStats.js';
import {
  type AnalysisProvenance,
  baseExportMetadata,
  metadataCommentLines,
  csvCell,
  metadataSummaryRows,
} from './provenance.js';
import { filterGrainsByRoiAndExclusion, type ExclusionFilterResult, type RoiExclusionConfig } from './roiAndRectify.js';

function cloneGrain(grain: GrainMorphometrics): GrainMorphometrics {
  return {
    ...grain,
    bbox: [grain.bbox[0], grain.bbox[1], grain.bbox[2], grain.bbox[3]],
  };
}

function rescaleGrainToOriginal(
  grain: GrainMorphometrics,
  scaleFactor: number,
): GrainMorphometrics {
  if (scaleFactor === 1 || scaleFactor <= 0) {
    return cloneGrain(grain);
  }
  const inv = 1 / scaleFactor;
  const invSq = inv * inv;
  return {
    ...grain,
    centroidX: grain.centroidX * inv,
    centroidY: grain.centroidY * inv,
    aAxisPx: grain.aAxisPx * inv,
    bAxisPx: grain.bAxisPx * inv,
    dEqPx: grain.dEqPx * inv,
    ...(grain.minFeretPx !== undefined ? { minFeretPx: grain.minFeretPx * inv } : {}),
    ...(grain.maxFeretPx !== undefined ? { maxFeretPx: grain.maxFeretPx * inv } : {}),
    areaPx: grain.areaPx * invSq,
    bbox: [
      grain.bbox[0] * inv,
      grain.bbox[1] * inv,
      grain.bbox[2] * inv,
      grain.bbox[3] * inv,
    ],
  };
}

/**
 * Reactive analysis session holding segmentation masks, morphometrics,
 * undo/redo edit history, spatial calibration, statistics, and synchronous exports.
 */
/** Working-image median b-axis (px) below which enlarging ×1.5 helped U-Net (audit/preprocessing). */
export const FINE_GRAIN_MEDIAN_PX = 20;

export class AnalysisSession {
  readonly workingImage: WorkingImageResult;
  readonly recommendation: ModelRecommendation;

  private readonly workingMasks: Int32Array;
  private workingGrains: GrainMorphometrics[];
  private grains: GrainMorphometrics[];
  private stats: SedimentStatsReport;
  private calibration: CalibrationResult | undefined;
  private excludeBorder: boolean;
  private readonly borderMargin: number;
  private roiConfig: RoiExclusionConfig | undefined;
  private readonly provenance: AnalysisProvenance | undefined;
  private roiExcludedGrainCount = 0;
  private readonly history = new MaskEditHistory();
  private readonly hullCache: GrainHullCache = new Map();
  /** Derived values computed on demand; cleared whenever the results change. */
  private derivedCache: {
    extended?: ExtendedGrainMorphometrics[];
    extendedById?: Map<number, ExtendedGrainMorphometrics>;
    roiFilter?: ExclusionFilterResult | null;
    fabric?: FabricRoseStats;
    sizeHistograms?: Map<string, SizeHistogram>;
  } = {};
  private readonly listeners = new Set<(session: AnalysisSession) => void>();

  constructor(params: {
    workingImage: WorkingImageResult;
    recommendation: ModelRecommendation;
    masks: Int32Array;
    workingGrains: GrainMorphometrics[];
    calibration?: CalibrationResult;
    excludeBorder?: boolean;
    borderMargin?: number;
    roiConfig?: RoiExclusionConfig;
    provenance?: AnalysisProvenance;
  }) {
    // The working-image pixels are only needed while the network runs. Not keeping them
    // saves ~4 MB per photo in memory, in browser storage and in project archives.
    this.workingImage = { ...params.workingImage, data: new Uint8ClampedArray(0) };
    this.roiConfig = params.roiConfig;
    this.provenance = params.provenance;
    this.recommendation = params.recommendation;
    this.workingMasks = params.masks;
    this.workingGrains = params.workingGrains.map(cloneGrain);
    this.calibration = params.calibration;
    this.excludeBorder = params.excludeBorder ?? true;
    this.borderMargin = params.borderMargin ?? 2;
    this.grains = [];
    this.stats = computeSedimentStats([], { excludeBorder: this.excludeBorder });
    this.recomputeDerivedState(false);
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  getHullCache(): GrainHullCache {
    return this.hullCache;
  }

  /**
   * Lazily computes and caches `minFeretPx` / `maxFeretPx` (and `minFeretMm` / `maxFeretMm`
   * when calibrated) on all grains in this session, reusing `this.hullCache`.
   */
  ensureFeret(): void {
    const missing = this.workingGrains.filter((g) => g.minFeretPx === undefined);
    if (missing.length === 0) return;

    const ext = computeExtendedMorphometrics(
      this.workingMasks,
      missing,
      this.workingImage.width,
      this.workingImage.height,
      1,
      undefined,
      this.hullCache,
    );
    const byId = new Map<number, { minFeretPx: number; maxFeretPx: number }>();
    for (const e of ext) {
      byId.set(e.id, { minFeretPx: e.minFeretPx, maxFeretPx: e.maxFeretPx });
    }
    for (const wg of this.workingGrains) {
      const f = byId.get(wg.id);
      if (f !== undefined) {
        wg.minFeretPx = f.minFeretPx;
        wg.maxFeretPx = f.maxFeretPx;
      }
    }
    this.recomputeDerivedState(false);
  }

  getResult(): PostProcessResult {
    return {
      masks: this.workingMasks,
      width: this.workingImage.width,
      height: this.workingImage.height,
      grains: this.grains.map(cloneGrain),
      grainCount: this.grains.length,
    };
  }

  getStats(
    sizeMetric: SizeMetric = 'bAxis',
    cutoffs?: { minBaxisPx?: number; minSizeMm?: number },
  ): SedimentStatsReport {
    const minBaxisPx = Math.max(0, cutoffs?.minBaxisPx ?? 0);
    const minSizeMm = Math.max(0, cutoffs?.minSizeMm ?? 0);
    if (sizeMetric === 'bAxis' && minBaxisPx === 0 && minSizeMm === 0) {
      return this.stats;
    }
    if (sizeMetric === 'minFeret') {
      this.ensureFeret();
    }
    return computeSedimentStats(this.getStatsGrains(), {
      excludeBorder: this.excludeBorder,
      sizeMetric,
      minBaxisPx,
      minSizeMm,
    });
  }

  getCalibration(): CalibrationResult | undefined {
    return this.calibration;
  }

  getExcludeBorder(): boolean {
    return this.excludeBorder;
  }

  getBorderMargin(): number {
    return this.borderMargin;
  }

  /** Reproducibility record (model hash, parameters, versions) for this analysis. */
  getProvenance(): AnalysisProvenance | undefined {
    return this.provenance;
  }

  getRoiConfig(): RoiExclusionConfig | undefined {
    return this.roiConfig;
  }

  /**
   * Fraction of the current ROI's valid area that was not analysed, because tiles outside
   * the ROI were skipped and the ROI was enlarged (or exclusions removed) afterwards.
   * 0 when nothing was skipped. Above 0, the photo should be re-analysed.
   */
  getUnanalysedRoiFraction(): number {
    const skip = this.provenance?.tileSkipping;
    if (skip === undefined) return 0;
    return unanalysedValidFraction(
      this.workingImage.width,
      this.workingImage.height,
      this.workingImage.effectiveScaleFactor,
      this.roiConfig,
      skip.analysedRects,
    );
  }

  /** Number of grains removed from statistics by the ROI / exclusion masks. */
  getRoiExcludedGrainCount(): number {
    return this.roiExcludedGrainCount;
  }

  /**
   * Sets the analysis ROI / exclusion configuration (original-image coordinates).
   * Statistics and tabular exports only include grains inside the valid bed area,
   * consistent with site-level pooling.
   */
  setRoiConfig(config: RoiExclusionConfig | undefined): void {
    this.roiConfig = config;
    this.recomputeDerivedState(true);
  }

  /**
   * Metadata block attached to every export of this session. `photo` adds photo-level
   * provenance the session does not know (e.g. `imageProcessing`: enhancement and
   * rectification steps applied before analysis).
   */
  getExportMetadata(photo?: Record<string, unknown>): Record<string, unknown> {
    const wi = this.workingImage;
    return {
      ...baseExportMetadata(),
      ...(this.provenance !== undefined ? { analysis: this.provenance } : {}),
      ...(photo !== undefined ? { photo } : {}),
      image: {
        originalWidth: wi.originalWidth,
        originalHeight: wi.originalHeight,
        workingWidth: wi.width,
        workingHeight: wi.height,
        effectiveScaleFactor: wi.effectiveScaleFactor,
        coordinateSystem: 'original-image pixels (x right, y down)',
      },
      calibration:
        this.calibration !== undefined
          ? {
              mmPerPx: this.calibration.mmPerPx,
              method:
                this.calibration.source === 'rectification'
                  ? 'perspective rectification (four corners of a reference rectangle)'
                  : this.calibration.source === 'geotiff'
                    ? 'GeoTIFF pixel size (ground distance)'
                    : this.calibration.source === 'copied'
                      ? `copied from photo "${this.calibration.copiedFrom ?? 'unknown'}"`
                      : 'two-point',
              referenceLengthMm: this.calibration.physicalLengthMm,
              referencePixelDistance: this.calibration.pixelDistance,
            }
          : 'uncalibrated (all sizes in original-image pixels)',
      excludeBorder: this.excludeBorder,
      borderMarginWorkingPx: this.borderMargin,
      roiApplied: this.roiConfig !== undefined,
      roiExcludedGrains: this.roiExcludedGrainCount,
    };
  }

  getWorkingMasks(): Int32Array {
    return this.workingMasks;
  }

  getWorkingGrains(): GrainMorphometrics[] {
    return this.workingGrains.map(cloneGrain);
  }

  toSerialized(): SerializedAnalysisSession {
    return {
      version: 1,
      workingMasks: this.workingMasks.slice(),
      workingImage: {
        ...this.workingImage,
        data: this.workingImage.data.slice(),
      },
      recommendation: {
        ...this.recommendation,
        metrics: { ...this.recommendation.metrics },
      },
      ...(this.calibration !== undefined
        ? {
            calibration: {
              ...this.calibration,
              pointA: { ...this.calibration.pointA },
              pointB: { ...this.calibration.pointB },
            },
          }
        : {}),
      excludeBorder: this.excludeBorder,
      borderMargin: this.borderMargin,
      ...(this.provenance !== undefined ? { provenance: { ...this.provenance } } : {}),
    };
  }

  static fromSerialized(data: SerializedAnalysisSession): AnalysisSession {
    if (!data || data.version !== 1) {
      throw new Error('Unsupported serialized AnalysisSession version.');
    }
    const { workingImage, workingMasks, recommendation, calibration, excludeBorder, borderMargin } =
      data;
    const provenance = data.provenance;
    const expectedLen = workingImage.width * workingImage.height;
    if (
      workingImage.width <= 0 ||
      workingImage.height <= 0 ||
      workingMasks.length !== expectedLen
    ) {
      throw new RangeError(
        `Serialized workingMasks length (${workingMasks.length}) does not match ${workingImage.width}x${workingImage.height}.`,
      );
    }

    const masksCopy =
      workingMasks instanceof Int32Array
        ? workingMasks.slice()
        : new Int32Array(workingMasks);
    const workingImageCopy: WorkingImageResult = {
      ...workingImage,
      data:
        workingImage.data instanceof Uint8ClampedArray
          ? workingImage.data.slice()
          : new Uint8ClampedArray(workingImage.data),
    };
    const workingGrains = computeAllGrainMorphometrics(
      masksCopy,
      workingImageCopy.width,
      workingImageCopy.height,
      borderMargin,
    );

    return new AnalysisSession({
      workingImage: workingImageCopy,
      recommendation: {
        ...recommendation,
        metrics: { ...recommendation.metrics },
      },
      masks: masksCopy,
      workingGrains,
      calibration,
      excludeBorder,
      borderMargin,
      ...(provenance !== undefined ? { provenance } : {}),
    });
  }

  subscribe(listener: (session: AnalysisSession) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  splitGrainAtLine(
    grainId: number,
    linePoints: readonly Point2D[],
    options?: { minSize?: number },
  ): boolean {
    const s = this.workingImage.effectiveScaleFactor;
    const scaledPoints =
      s !== 1 && s > 0
        ? linePoints.map((pt) => ({ x: pt.x * s, y: pt.y * s }))
        : linePoints;

    const prevMasks = this.workingMasks.slice();
    const prevGrains = this.workingGrains.map(cloneGrain);

    const res = editorSplitGrainAtLine(
      this.workingMasks,
      grainId,
      scaledPoints,
      this.workingImage.width,
      this.workingImage.height,
      options?.minSize,
      {
        borderMargin: this.borderMargin,
        grains: this.workingGrains,
      },
    );

    if (!res.applied || !res.bbox) {
      return false;
    }

    const nextGrains =
      res.grains ??
      computeAllGrainMorphometrics(
        this.workingMasks,
        this.workingImage.width,
        this.workingImage.height,
        this.borderMargin,
      );

    this.history.push({
      bbox: res.bbox,
      imageWidth: this.workingImage.width,
      before: MaskEditHistory.extractBboxSlice(
        prevMasks,
        this.workingImage.width,
        res.bbox,
      ),
      after: MaskEditHistory.extractBboxSlice(
        this.workingMasks,
        this.workingImage.width,
        res.bbox,
      ),
      grainsBefore: prevGrains,
      grainsAfter: nextGrains.map(cloneGrain),
      label: 'split',
    });

    this.hullCache.delete(grainId);
    for (const id of res.newGrainIds) {
      this.hullCache.delete(id);
    }
    this.workingGrains = nextGrains;
    this.recomputeDerivedState(true);
    return true;
  }

  splitGrain(
    grainId: number,
    linePoints: readonly Point2D[],
    options?: { minSize?: number },
  ): boolean {
    return this.splitGrainAtLine(grainId, linePoints, options);
  }

  mergeGrains(grainIds: readonly number[]): boolean {
    const prevMasks = this.workingMasks.slice();
    const prevGrains = this.workingGrains.map(cloneGrain);

    const res = editorMergeGrains(
      this.workingMasks,
      grainIds,
      this.workingImage.width,
      this.workingImage.height,
      {
        borderMargin: this.borderMargin,
        grains: this.workingGrains,
      },
    );

    if (!res.applied || !res.bbox) {
      return false;
    }

    const nextGrains =
      res.grains ??
      computeAllGrainMorphometrics(
        this.workingMasks,
        this.workingImage.width,
        this.workingImage.height,
        this.borderMargin,
      );

    this.history.push({
      bbox: res.bbox,
      imageWidth: this.workingImage.width,
      before: MaskEditHistory.extractBboxSlice(
        prevMasks,
        this.workingImage.width,
        res.bbox,
      ),
      after: MaskEditHistory.extractBboxSlice(
        this.workingMasks,
        this.workingImage.width,
        res.bbox,
      ),
      grainsBefore: prevGrains,
      grainsAfter: nextGrains.map(cloneGrain),
      label: 'merge',
    });

    for (const id of grainIds) {
      this.hullCache.delete(id);
    }
    for (const id of res.newGrainIds) {
      this.hullCache.delete(id);
    }
    this.workingGrains = nextGrains;
    this.recomputeDerivedState(true);
    return true;
  }

  deleteGrain(grainId: number): boolean {
    const prevMasks = this.workingMasks.slice();
    const prevGrains = this.workingGrains.map(cloneGrain);

    const res = editorDeleteGrain(
      this.workingMasks,
      grainId,
      this.workingImage.width,
      this.workingImage.height,
      {
        borderMargin: this.borderMargin,
        grains: this.workingGrains,
      },
    );

    if (!res.applied || !res.bbox) {
      return false;
    }

    const nextGrains =
      res.grains ??
      computeAllGrainMorphometrics(
        this.workingMasks,
        this.workingImage.width,
        this.workingImage.height,
        this.borderMargin,
      );

    this.history.push({
      bbox: res.bbox,
      imageWidth: this.workingImage.width,
      before: MaskEditHistory.extractBboxSlice(
        prevMasks,
        this.workingImage.width,
        res.bbox,
      ),
      after: MaskEditHistory.extractBboxSlice(
        this.workingMasks,
        this.workingImage.width,
        res.bbox,
      ),
      grainsBefore: prevGrains,
      grainsAfter: nextGrains.map(cloneGrain),
      label: 'delete',
    });

    this.hullCache.delete(grainId);
    this.workingGrains = nextGrains;
    this.recomputeDerivedState(true);
    return true;
  }

  addPolygonGrain(
    polygonPoints: readonly Point2D[],
    options?: { minSize?: number },
  ): number {
    const s = this.workingImage.effectiveScaleFactor;
    const scaledPoints =
      s !== 1 && s > 0
        ? polygonPoints.map((pt) => ({ x: pt.x * s, y: pt.y * s }))
        : polygonPoints;

    const prevMasks = this.workingMasks.slice();
    const prevGrains = this.workingGrains.map(cloneGrain);

    const res = editorAddPolygonGrain(
      this.workingMasks,
      scaledPoints,
      this.workingImage.width,
      this.workingImage.height,
      options?.minSize,
      {
        borderMargin: this.borderMargin,
        grains: this.workingGrains,
      },
    );

    const newGrainId = res.newGrainIds[0] ?? 0;
    if (!res.applied || !res.bbox || newGrainId <= 0) {
      return 0;
    }

    const nextGrains =
      res.grains ??
      computeAllGrainMorphometrics(
        this.workingMasks,
        this.workingImage.width,
        this.workingImage.height,
        this.borderMargin,
      );

    this.history.push({
      bbox: res.bbox,
      imageWidth: this.workingImage.width,
      before: MaskEditHistory.extractBboxSlice(
        prevMasks,
        this.workingImage.width,
        res.bbox,
      ),
      after: MaskEditHistory.extractBboxSlice(
        this.workingMasks,
        this.workingImage.width,
        res.bbox,
      ),
      grainsBefore: prevGrains,
      grainsAfter: nextGrains.map(cloneGrain),
      label: 'addPolygon',
    });

    this.hullCache.delete(newGrainId);
    this.workingGrains = nextGrains;
    this.recomputeDerivedState(true);
    return newGrainId;
  }

  undo(): boolean {
    const entry = this.history.undo(this.workingMasks);
    if (!entry) {
      return false;
    }
    this.hullCache.clear();
    this.workingGrains = entry.grainsBefore
      ? entry.grainsBefore.map(cloneGrain)
      : computeAllGrainMorphometrics(
          this.workingMasks,
          this.workingImage.width,
          this.workingImage.height,
          this.borderMargin,
        );
    this.recomputeDerivedState(true);
    return true;
  }

  redo(): boolean {
    const entry = this.history.redo(this.workingMasks);
    if (!entry) {
      return false;
    }
    this.hullCache.clear();
    this.workingGrains = entry.grainsAfter
      ? entry.grainsAfter.map(cloneGrain)
      : computeAllGrainMorphometrics(
          this.workingMasks,
          this.workingImage.width,
          this.workingImage.height,
          this.borderMargin,
        );
    this.recomputeDerivedState(true);
    return true;
  }

  setCalibration(calibration: CalibrationResult | undefined): void {
    this.calibration = calibration;
    this.recomputeDerivedState(true);
  }

  calibrateScale(
    pointA: Point2D,
    pointB: Point2D,
    physicalLength: number,
    unit: 'mm' | 'cm' = 'mm',
  ): CalibrationResult {
    const cal = ScaleCalibrator.calibrate(pointA, pointB, physicalLength, unit);
    this.setCalibration(cal);
    return cal;
  }

  setExcludeBorder(excludeBorder: boolean): void {
    this.excludeBorder = excludeBorder;
    this.recomputeDerivedState(true);
  }

  /**
   * Per-grain table in original-image coordinates. Grains excluded by the ROI are
   * flagged in `in_roi`. With `includeMetadata`, `# key: value` provenance lines are
   * prepended (read with e.g. `pandas.read_csv(path, comment='#')`).
   */
  exportCsv(options?: {
    includeMetadata?: boolean;
    photoMetadata?: Record<string, unknown>;
    /** Size metric and cutoffs used by the summaries, so `included_in_stats` matches them. */
    sizeMetric?: SizeMetric;
    cutoffs?: { minBaxisPx?: number; minSizeMm?: number };
  }): string {
    const sizeMetric = options?.sizeMetric ?? 'bAxis';
    const statsIds = new Set(this.statsGrainsForSummaries(sizeMetric, options?.cutoffs).map((g) => g.id));
    const hasFeret = this.grains.some((g) => g.minFeretPx !== undefined);
    const header =
      'grain_id,centroid_x,centroid_y,area_px,a_axis_px,b_axis_px,d_eq_px,a_axis_mm,b_axis_mm,d_eq_mm' +
      (hasFeret ? ',min_feret_px,max_feret_px,min_feret_mm,max_feret_mm' : '') +
      ',touches_border' +
      (this.roiConfig !== undefined ? ',in_roi' : '') +
      ',included_in_stats,orientation_rad,orientation_deg,perimeter_px,perimeter_mm,circularity,aspect_ratio,elongation,convex_area_px,convex_area_mm2,solidity,sphericity_2d';
    const lines: string[] = options?.includeMetadata
      ? [...metadataCommentLines(this.getExportMetadata(options.photoMetadata)), header]
      : [header];
    const inRoi =
      this.roiConfig !== undefined
        ? new Set(this.getStatsGrains().map((g) => g.id))
        : null;
    const ext = new Map(this.getExtendedGrains().map((e) => [e.id, e]));
    const opt = (v: number | undefined): number | string => (v === undefined ? '' : v);

    for (const g of this.grains) {
      const e = ext.get(g.id);
      const row = [
        g.id,
        g.centroidX,
        g.centroidY,
        g.areaPx,
        g.aAxisPx,
        g.bAxisPx,
        g.dEqPx,
        g.aAxisMm !== undefined ? g.aAxisMm : '',
        g.bAxisMm !== undefined ? g.bAxisMm : '',
        g.dEqMm !== undefined ? g.dEqMm : '',
        ...(hasFeret
          ? [
              g.minFeretPx !== undefined ? g.minFeretPx : '',
              g.maxFeretPx !== undefined ? g.maxFeretPx : '',
              g.minFeretMm !== undefined ? g.minFeretMm : '',
              g.maxFeretMm !== undefined ? g.maxFeretMm : '',
            ]
          : []),
        g.touchesBorder,
        ...(inRoi !== null ? [inRoi.has(g.id)] : []),
        statsIds.has(g.id),
        g.orientationRad,
        (g.orientationRad * 180) / Math.PI,
        opt(e?.perimeterPx),
        opt(e?.perimeterMm),
        opt(e?.circularity),
        opt(e?.aspectRatio),
        opt(e?.elongation),
        opt(e?.convexAreaPx),
        opt(e?.convexAreaMm2),
        opt(e?.solidity),
        opt(e?.sphericity2D),
      ].join(',');
      lines.push(row);
    }

    return lines.join('\n');
  }

  exportSummaryJson(
    sizeMetric: SizeMetric = 'bAxis',
    cutoffs?: { minBaxisPx?: number; minSizeMm?: number },
    photoMetadata?: Record<string, unknown>,
  ): string {
    return JSON.stringify(
      { metadata: this.getExportMetadata(photoMetadata), ...this.getStats(sizeMetric, cutoffs) },
      null,
      2,
    );
  }

  exportSummaryCsv(
    sizeMetric: SizeMetric = 'bAxis',
    cutoffs?: { minBaxisPx?: number; minSizeMm?: number },
    photoMetadata?: Record<string, unknown>,
  ): string {
    return [
      'section,metric,value,unit',
      ...metadataSummaryRows(this.getExportMetadata(photoMetadata)),
      ...summaryCsvRows(this.getStats(sizeMetric, cutoffs)),
      ...this.summaryExtrasCsv(sizeMetric, cutoffs),
    ].join('\n');
  }

  /** Grains that count in the statistics: inside the ROI, border rule applied, and optional size cutoffs. */
  private statsGrainsForSummaries(
    sizeMetric: SizeMetric = 'bAxis',
    cutoffs?: { minBaxisPx?: number; minSizeMm?: number },
  ): GrainMorphometrics[] {
    const minBaxisPx = Math.max(0, cutoffs?.minBaxisPx ?? 0);
    const minSizeMm = Math.max(0, cutoffs?.minSizeMm ?? 0);
    if (sizeMetric === 'minFeret' && (minBaxisPx > 0 || minSizeMm > 0)) {
      this.ensureFeret();
    }
    const base = filterBorderGrains(this.getStatsGrains(), this.excludeBorder);
    if (minBaxisPx <= 0 && minSizeMm <= 0) return base;
    return base.filter((g) => grainPassesSizeCutoffs(g, { minBaxisPx, minSizeMm, sizeMetric }));
  }

  /**
   * Summary rows also shown in the dashboard: size-class histograms (area-weighted, 1 φ and
   * 0.5 φ bins), fabric (orientation) statistics, and warnings.
   */
  private summaryExtrasCsv(
    sizeMetric: SizeMetric,
    cutoffs?: { minBaxisPx?: number; minSizeMm?: number },
  ): string[] {
    const out: string[] = [];
    const grains = this.statsGrainsForSummaries(sizeMetric, cutoffs);
    if (this.calibration === undefined) {
      // Uncalibrated: power-of-two pixel classes (the same as the dashboard histogram).
      for (const step of [1, 0.5] as const) {
        const h = this.getSizeHistogram(step, sizeMetric, cutoffs);
        const sec = step === 1 ? 'size_class_px_x2' : 'size_class_px_xsqrt2';
        for (const b of h.bins) {
          const label = csvCell(`${+b.lo.toFixed(2)}-${+b.hi.toFixed(2)} px`);
          out.push(`${sec},${label},${b.weightPct},% (area-weighted)`);
          out.push(`${sec}_count,${label},${b.count},count`);
        }
      }
    }
    for (const step of [1.0, 0.5] as const) {
      const bins = this.calibration === undefined ? [] : computeWentworthHistogram(grains, { stepPhi: step, weighted: true, sizeMetric });
      const sec = step === 1 ? 'size_class_1phi' : 'size_class_05phi';
      for (const b of bins) {
        out.push(`${sec},${csvCell(`${b.label} [${b.mmMin}-${b.mmMax} mm]`)},${b.weightPct},% (area-weighted)`);
        out.push(`${sec}_count,${csvCell(`${b.label} [${b.mmMin}-${b.mmMax} mm]`)},${b.grainCount},count`);
      }
    }
    const f = this.getFabricRose(sizeMetric, cutoffs);
    out.push(`fabric,grain_count,${f.grainCount},count`);
    out.push(`fabric,mean_axial_orientation_deg,${f.meanAxialDeg},deg (0 = image vertical)`);
    out.push(`fabric,resultant_length_R,${f.resultantLength},ratio`);
    out.push(`fabric,circular_variance,${f.circularVariance},ratio`);
    out.push(`fabric,rayleigh_z,${f.rayleighZ},stat`);
    out.push(`fabric,rayleigh_p,${f.rayleighP ?? ''},p`);
    for (const b of f.bins) out.push(`fabric_bin,${b.startDeg}-${b.endDeg}deg,${b.proportionPct},%`);
    const warnings = this.getStats(sizeMetric, cutoffs).warnings ?? [];
    warnings.forEach((w, i) => out.push(`warning,${i + 1},${csvCell(w)},text`));
    return out;
  }

  /**
   * Label mask, its size, and PNG text chunks. `original` (default) resizes the working-image
   * labels to the photo's pixel grid (nearest neighbour), so the mask overlays the photo and
   * matches the CSV / GeoJSON coordinates. The `webgrainy` iTXt chunk holds the provenance
   * metadata and the mask geometry (JSON).
   */
  private maskForExport(
    bitDepth: 16 | 32,
    options?: { resolution?: 'original' | 'working'; photoMetadata?: Record<string, unknown> },
  ): { masks: Int32Array; width: number; height: number; text: Record<string, string> } {
    const wi = this.workingImage;
    const resolution = options?.resolution ?? 'original';
    const width = resolution === 'original' ? wi.originalWidth : wi.width;
    const height = resolution === 'original' ? wi.originalHeight : wi.height;
    const masks =
      resolution === 'original'
        ? resizeLabelsNearest(this.workingMasks, wi.width, wi.height, width, height)
        : this.workingMasks;
    const meta = {
      ...this.getExportMetadata(options?.photoMetadata),
      mask: {
        resolution: resolution === 'original' ? 'original-image pixels' : 'working-image pixels',
        width,
        height,
        workingWidth: wi.width,
        workingHeight: wi.height,
        effectiveScaleFactor: wi.effectiveScaleFactor,
        resampling: resolution === 'original' && (width !== wi.width || height !== wi.height) ? 'nearest-neighbour from working-image labels' : 'none',
        idEncoding: bitDepth === 16 ? '16-bit grayscale grain_id (clamped to 65535)' : '32-bit grain_id, big-endian in RGBA bytes',
        background: 0,
      },
    };
    return {
      masks,
      width,
      height,
      text: {
        Description: `webGrainy grain label mask (${meta.mask.resolution}); pixel value = grain_id in the grains CSV, 0 = background.`,
        webgrainy: JSON.stringify(meta),
      },
    };
  }

  exportMaskPng(
    bitDepth: 16 | 32 = 16,
    options?: { resolution?: 'original' | 'working'; photoMetadata?: Record<string, unknown> },
  ): Uint8Array {
    const m = this.maskForExport(bitDepth, options);
    return encodeMaskPng(m.masks, m.width, m.height, bitDepth, { text: m.text });
  }

  /** As `exportMaskPng`, deflate-compressed where the platform supports it (much smaller files). */
  async exportMaskPngCompressed(
    bitDepth: 16 | 32 = 16,
    options?: { resolution?: 'original' | 'working'; photoMetadata?: Record<string, unknown> },
  ): Promise<Uint8Array> {
    const m = this.maskForExport(bitDepth, options);
    return encodeMaskPngCompressed(m.masks, m.width, m.height, bitDepth, { text: m.text });
  }

  /** Outlines in original-image coordinates, with measurements and provenance. */
  exportGeoJson(photoMetadata?: Record<string, unknown>): string {
    const grainById = new Map(this.grains.map((g) => [g.id, g]));
    return JSON.stringify(
      buildContourGeoJson(this.workingMasks, this.workingGrains, this.workingImage.width, this.workingImage.height, {
        scaleInv: this.outputScaleInv(),
        propertiesFor: (wg) => grainById.get(wg.id) ?? wg,
        // RFC 7946 §6.1 foreign member: provenance & coordinate system.
        metadata: this.getExportMetadata(photoMetadata),
      }),
    );
  }

  exportSvg(photoMetadata?: Record<string, unknown>): string {
    return buildContourSvg(this.workingMasks, this.workingGrains, this.workingImage.width, this.workingImage.height, {
      scaleInv: this.outputScaleInv(),
      outWidth: this.workingImage.originalWidth,
      outHeight: this.workingImage.originalHeight,
      metadata: this.getExportMetadata(photoMetadata),
    });
  }

  /** Factor from working-image to original-image coordinates. */
  private outputScaleInv(): number {
    const s = this.workingImage.effectiveScaleFactor;
    return s !== 1 && s > 0 ? 1 / s : 1;
  }

  /** Grains eligible for statistics: all grains, minus those excluded by the ROI config. */
  private getStatsGrains(): GrainMorphometrics[] {
    const res = this.getRoiFilterResult();
    this.roiExcludedGrainCount = res === null ? 0 : this.grains.length - res.includedGrains.length;
    return res === null ? this.grains : res.includedGrains;
  }

  /**
   * ROI / exclusion filtering of the current grains (with clast packing and exposed-matrix
   * percentages), or null without an ROI. Cached until the results change.
   */
  getRoiFilterResult(): ExclusionFilterResult | null {
    if (this.derivedCache.roiFilter === undefined) {
      this.derivedCache.roiFilter =
        this.roiConfig === undefined || this.grains.length === 0
          ? null
          : filterGrainsByRoiAndExclusion(
              this.workingMasks,
              this.grains,
              this.workingImage.width,
              this.workingImage.height,
              this.workingImage.effectiveScaleFactor,
              this.roiConfig,
              this.calibration?.mmPerPx,
            );
    }
    return this.derivedCache.roiFilter;
  }

  /** Shape measures (perimeter, circularity, solidity, Feret, …) for every grain. Cached. */
  getExtendedGrains(): ExtendedGrainMorphometrics[] {
    if (this.derivedCache.extended === undefined) {
      this.derivedCache.extended = computeExtendedMorphometrics(
        this.workingMasks,
        this.grains,
        this.workingImage.width,
        this.workingImage.height,
        this.workingImage.effectiveScaleFactor,
        this.calibration?.mmPerPx,
        this.hullCache,
      );
    }
    return this.derivedCache.extended;
  }

  /**
   * Whether to suggest re-analysing enlarged ×1.5 for fine gravel. Rule from the
   * pre-processing benchmark (audit/preprocessing): U-Net results, not already enlarged,
   * at least 5 grains, and a median b-axis below 20 px in the working image. On the 40-image
   * benchmark this raised outline accuracy (PQ +0.025, 95% CI +0.007 to +0.049) with no site
   * getting worse. The threshold was chosen after seeing the test set, so it is offered, not
   * applied automatically.
   */
  getFineGrainHint(): { suggest: boolean; medianWorkingBPx: number | null; enlarged: number | null } {
    const enlarged = this.provenance?.fineGrainUpscale ?? null;
    const b = this.workingGrains.filter((g) => !g.touchesBorder).map((g) => g.bAxisPx).sort((x, y) => x - y);
    const median = b.length > 0 ? (b.length % 2 ? b[(b.length - 1) / 2]! : (b[b.length / 2 - 1]! + b[b.length / 2]!) / 2) : null;
    const isUnet = this.provenance?.modelId === 'ig2_unet_fp32';
    return {
      suggest: isUnet && enlarged === null && b.length >= 5 && median !== null && median < FINE_GRAIN_MEDIAN_PX,
      medianWorkingBPx: median,
      enlarged,
    };
  }

  /** Shape measures of the grains that count in the statistics (inside the ROI, border rule, cutoffs). */
  getExtendedStatsGrains(
    sizeMetric: SizeMetric = 'bAxis',
    cutoffs?: { minBaxisPx?: number; minSizeMm?: number },
  ): ExtendedGrainMorphometrics[] {
    const ids = new Set(this.statsGrainsForSummaries(sizeMetric, cutoffs).map((g) => g.id));
    return this.getExtendedGrains().filter((g) => ids.has(g.id));
  }

  /** Shape measures for one grain (e.g. the grain inspector). */
  getExtendedGrain(id: number): ExtendedGrainMorphometrics | undefined {
    if (this.derivedCache.extendedById === undefined) {
      this.derivedCache.extendedById = new Map(this.getExtendedGrains().map((g) => [g.id, g]));
    }
    return this.derivedCache.extendedById.get(id);
  }

  /**
   * Area-weighted size histogram of the grains that count in the statistics (φ classes in
   * mm when calibrated, power-of-two px classes otherwise). Cached per step and metric.
   */
  getSizeHistogram(
    step: 0.5 | 1 = 1,
    sizeMetric: SizeMetric = 'bAxis',
    cutoffs?: { minBaxisPx?: number; minSizeMm?: number },
  ): SizeHistogram {
    const minBaxisPx = Math.max(0, cutoffs?.minBaxisPx ?? 0);
    const minSizeMm = Math.max(0, cutoffs?.minSizeMm ?? 0);
    const key = `${step}|${sizeMetric}|${minBaxisPx}|${minSizeMm}`;
    const cache = (this.derivedCache.sizeHistograms ??= new Map());
    let h = cache.get(key);
    if (h === undefined) {
      const filtered = this.statsGrainsForSummaries(sizeMetric, { minBaxisPx, minSizeMm });
      h = photoSizeHistogram(filtered, { step, sizeMetric });
      cache.set(key, h);
    }
    return h;
  }

  /**
   * Area-weighted orientation (fabric) statistics of the grains that count in the
   * statistics (inside the ROI, border rule, and optional cutoffs applied). Cached when unfiltered.
   */
  getFabricRose(
    sizeMetric: SizeMetric = 'bAxis',
    cutoffs?: { minBaxisPx?: number; minSizeMm?: number },
  ): FabricRoseStats {
    const minBaxisPx = Math.max(0, cutoffs?.minBaxisPx ?? 0);
    const minSizeMm = Math.max(0, cutoffs?.minSizeMm ?? 0);
    if (minBaxisPx === 0 && minSizeMm === 0) {
      if (this.derivedCache.fabric === undefined) {
        this.derivedCache.fabric = computeFabricRoseStats(this.statsGrainsForSummaries(), { weighted: true, binCount: 12 });
      }
      return this.derivedCache.fabric;
    }
    return computeFabricRoseStats(
      this.statsGrainsForSummaries(sizeMetric, { minBaxisPx, minSizeMm }),
      { weighted: true, binCount: 12 },
    );
  }

  private recomputeDerivedState(notify: boolean): void {
    this.derivedCache = {};
    const s = this.workingImage.effectiveScaleFactor;
    let derived = this.workingGrains.map((g) => rescaleGrainToOriginal(g, s));
    if (this.calibration !== undefined) {
      derived = ScaleCalibrator.scaleAllMorphometrics(
        derived,
        this.calibration,
      );
    }
    this.grains = derived;
    this.stats = computeSedimentStats(this.getStatsGrains(), {
      excludeBorder: this.excludeBorder,
    });
    if (notify) {
      for (const listener of this.listeners) {
        listener(this);
      }
    }
  }
}
