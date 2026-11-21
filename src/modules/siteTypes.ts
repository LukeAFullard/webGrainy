/**
 * Types of the site analysis inputs, options and report, and the citations the report lists.
 * Split out of siteAnalysis.ts, which re-exports the public parts.
 */
import type { FolkWardStats, PsdPercentiles, SizeMetric, WentworthProportions } from '../types/index.js';
import type { ExtraGrainStats } from './grainStatsExtra.js';
import type { FabricRoseStats, WentworthBin } from './morphometricsExt.js';
import type { AnalysisSession } from './pipelineController.js';
import type { RoiExclusionConfig } from './roiAndRectify.js';

export type PoolingMode =
  | 'physical-area'
  | 'equal-photo'
  | 'virtual-wolman-grid'
  | 'number-weighted'
  | 'facies-weighted';

export interface PhotoEnhancementInfo {
  kind: 'upscale-2x' | 'deblur';
  modelId: string;
  modelName: string;
  modelSha256: string;
  scaleFactor: number;
  appliedAt: string;
}

/** A perspective rectification applied to the photo before analysis. */
export interface PhotoRectificationInfo {
  /** Reference quadrilateral corners (TL, TR, BR, BL) in the input image's pixels. */
  corners: Array<{ x: number; y: number }>;
  physicalWidthMm: number;
  physicalHeightMm: number;
  outputWidth: number;
  outputHeight: number;
  mmPerPx: number;
  appliedAt: string;
}

/** One image-modifying step applied before analysis, in the order applied. */
export type PhotoProcessingStep =
  | ({ step: 'enhancement' } & PhotoEnhancementInfo)
  | ({ step: 'rectification' } & PhotoRectificationInfo);

/**
 * Every image-modifying step applied to a photo (enhancement, rectification), oldest first.
 * Falls back to the current `enhancement` record for photos saved before the history existed.
 */
export function photoProcessingHistory(meta: SitePhotoMetadata | undefined): PhotoProcessingStep[] {
  if (meta?.processingHistory !== undefined) return meta.processingHistory.map((s) => ({ ...s }));
  return meta?.enhancement !== undefined ? [{ step: 'enhancement', ...meta.enhancement }] : [];
}

/**
 * Pixel-to-map transform of a georeferenced photo (from its GeoTIFF). With (u, v) the
 * pixel-CORNER coordinates of the raster (pixel (0,0) spans 0..1 on both axes):
 * X = a + b u + c v,  Y = d + e u + f v  (map units of the CRS).
 */
export interface PhotoGeoreference {
  transform: [number, number, number, number, number, number];
  /** EPSG code of the CRS, or null when the file uses a user-defined CRS. */
  epsg: number | null;
  /** 'projected' (metres/feet) or 'geographic' (degrees). */
  kind: 'projected' | 'geographic' | 'unknown';
  /** Raster size the transform belongs to (the photo must still have this size). */
  width: number;
  height: number;
}

export interface SitePhotoMetadata {
  timestamp?: string;
  gps?: { lat: number; lon: number };
  cameraMake?: string;
  cameraModel?: string;
  focalLength35mm?: number;
  blurScore?: number;
  /** The enhancement of the current image (cleared by a later rectification). */
  enhancement?: PhotoEnhancementInfo;
  /** Provenance: every image-modifying step, kept across later steps (see photoProcessingHistory). */
  processingHistory?: PhotoProcessingStep[];
  notes?: string;
  /** Map georeferencing from the photo's GeoTIFF, if it had one. */
  georef?: PhotoGeoreference;
}

export interface SitePhotoInput {
  photoId: string;
  label: string;
  included: boolean;
  session: AnalysisSession;
  roiConfig?: RoiExclusionConfig;
  faciesWeight?: number;
  metadata?: SitePhotoMetadata;
}

export type SitePhotoEntry = SitePhotoInput;

export interface SiteAnalysisOptions {
  poolingMode: PoolingMode;
  unit?: 'mm' | 'px';
  allowEqualPhotoFallback?: boolean;
  sizeMetric?: SizeMetric;
  minBaxisPx?: number;
  /**
   * Lower size cutoff in mm (calibrated sites only), e.g. the smallest clast a field
   * Wolman/pebble count records. Grains below it are excluded before pooling, so photo
   * and field distributions describe the same size range. At the K1 site, matching the
   * field count's 13 mm minimum turned a -42% D50 gap into +3% (validation/k1/).
   */
  minSizeMm?: number;
  /**
   * Exclusion overlap tolerance: a grain is dropped when more than this fraction of its
   * area lies inside ROI-excluded regions (0 = drop on any overlap, 1 = only if fully
   * inside). Overrides the per-photo value when set. Default 0.10.
   */
  maxExcludedFraction?: number;
  harmonizeCutoff?: boolean;
  harmonizePhysicalCutoff?: boolean;
  wolmanGridSpacingMm?: number;
  wolmanPointsPerPhoto?: number;
  bootstrapReplicates?: number;
  bootstrapSeed?: number;
  bootstrapTwoStage?: boolean;
  confidenceLevel?: 0.9 | 0.95;
}

export interface SiteCalibrationValidation {
  valid: boolean;
  unit: 'mm' | 'px' | 'mixed' | 'uncalibrated';
  calibratedPhotoIds: string[];
  uncalibratedPhotoIds: string[];
  warnings: string[];
  message: string;
}

export interface PsdConfidenceInterval {
  confidenceLevel: 0.9 | 0.95;
  lower: PsdPercentiles;
  upper: PsdPercentiles;
}

export interface FolkWardConfidenceInterval {
  meanPhi: [number, number];
  sortingPhi: [number, number];
  skewnessPhi: [number, number];
  kurtosisPhi: [number, number];
  meanMm: [number, number];
}

export interface BinomialCiResult {
  confidenceLevel: 0.9 | 0.95;
  sampleSizeUsed: number;
  isKishApproximation: boolean;
  lower: PsdPercentiles;
  upper: PsdPercentiles;
}

export interface JackknifePhotoSensitivity {
  photoId: string;
  label: string;
  D16Without: number;
  D50Without: number;
  D84Without: number;
  deltaD16: number;
  deltaD50: number;
  deltaD84: number;
  relPctD16: number;
  relPctD50: number;
  relPctD84: number;
  highInfluence: boolean;
}

export interface JackknifeSensitivityReport {
  perPhoto: JackknifePhotoSensitivity[];
  seD16: number;
  seD50: number;
  seD84: number;
  /** Jackknife standard error of ln(Dx) for every percentile (used by the site interval). */
  logSe: PsdPercentiles;
}

export interface ConvergencePoint {
  photoCount: number;
  photoId: string;
  label: string;
  cumulativeGrains: number;
  D16: number;
  D50: number;
  D84: number;
  ciLoD50: number;
  ciHiD50: number;
  ciWidthD50: number;
  relativeHalfWidthD50Pct: number;
}

export type SampleAdequacyRating =
  | 'Insufficient'
  | 'Minimal'
  | 'Adequate'
  | 'High Precision';

export interface SampleAdequacyReport {
  /** Rating from the effective grain count, capped by the number of photos (see siteAdequacy). */
  rating: SampleAdequacyRating;
  /** True when the photo count, not the grain count, limits the rating. */
  limitedByPhotoCount: boolean;
  effectiveGrainCount: number;
  largestClastAreaRatio: number;
  largestClastWarning: 'none' | 'moderate' | 'critical';
  outlierPhotos: Array<{
    photoId: string;
    label: string;
    reasons: string[];
  }>;
}

export interface PerPhotoSiteBreakdown {
  photoId: string;
  label: string;
  included: boolean;
  mmPerPx?: number;
  rawGrainCount: number;
  validGrainCount: number;
  excludedTruncationCount: number;
  sampledBedAreaPx: number;
  sampledBedAreaMm2?: number;
  clastPackingPct: number;
  exposedMatrixPct: number;
  gridGrainHits: number;
  gridMatrixHits: number;
  gridSubCutoffHits: number;
  D16: number;
  D50: number;
  D84: number;
  weightContributionPct: number;
  /**
   * Smallest resolvable grain size in original-photo px: the segmentation area floor at the
   * photo's working resolution (or `minBaxisPx` if larger). Used for the harmonised cutoff.
   */
  detectionLimitPx?: number;
  outlierReasons: string[];
}

export interface SiteAnalysisReport {
  poolingMode: PoolingMode;
  statisticalBasisLabel: string;
  unit: 'mm' | 'px';
  sizeMetric: SizeMetric;
  includedPhotoCount: number;
  totalGrainCount: number;
  validGrainCount: number;
  /** Pixel size cutoff applied (original-photo px, active size metric). */
  minBaxisPx: number;
  dCutoffCommonMm: number | null;
  excludedTruncationCount: number;
  excludedTruncationAreaMm2: number;
  psd: PsdPercentiles;
  folkWard: FolkWardStats | null;
  /** Mean diameters (incl. Sauter), geometric and moment statistics, percentile ratios. */
  extra: ExtraGrainStats | null;
  wentworth: WentworthProportions | null;
  wentworthHistogram05Phi: WentworthBin[];
  wentworthHistogram10Phi: WentworthBin[];
  fabricRose: FabricRoseStats;
  /** Grain shape of the pooled grains (each counted once): b/a in 10 bins over [0, 1]. */
  shape: { aspectRatioCounts: number[]; medianAspectRatio: number; n: number };
  bootstrapMode: 'cluster' | 'two-stage-cluster' | 'single-photo-grain-fallback';
  bootstrapSeed: number;
  bootstrapReplicates: number;
  /**
   * Reported site interval: the cluster-bootstrap interval made honest for few photos (t-interval
   * on the log scale, `calibrateSiteInterval`). NaN where it cannot be estimated.
   */
  bootstrapCi: PsdConfidenceInterval;
  /** The raw percentile cluster-bootstrap interval (too narrow with few photos; kept for the site comparison test). */
  bootstrapPercentileCi: PsdConfidenceInterval;
  /**
   * How far `bootstrapCi` can be trusted: 'ok'; 'few-photos' (fewer than 5 photos: approximate);
   * 'single-photo' (grain resampling only: no patch-to-patch variation); 'degenerate' (photos
   * give identical results, e.g. the same photo twice: no interval).
   */
  ciStatus: 'ok' | 'few-photos' | 'single-photo' | 'degenerate';
  /**
   * Standard error of ln(Dx) behind `bootstrapCi` (larger of the bootstrap SE x sqrt(n/(n-1)) and
   * the leave-one-photo-out jackknife SE); NaN when not estimable or for a single photo. The site
   * comparison test uses it with n - 1 degrees of freedom per site.
   */
  ciLogSe: PsdPercentiles;
  folkWardCi: FolkWardConfidenceInterval | null;
  binomialCi: BinomialCiResult;
  jackknife: JackknifeSensitivityReport | null;
  convergence: ConvergencePoint[];
  adequacy: SampleAdequacyReport;
  perPhoto: PerPhotoSiteBreakdown[];
  gridMatrixHitsTotal: number;
  gridSubCutoffHitsTotal: number;
  warnings: string[];
  citations: string[];
}

export const SITE_BIBLIOGRAPHIC_CITATIONS: readonly string[] = [
  'Mair, D., Witz, G., Do Prado, A., et al. (2026). ImageGrains 2.0: Improved precision and generalization for grain segmentation. Earth Surface Dynamics, 14, 527-551. https://doi.org/10.5194/esurf-14-527-2026',
  'Mair, D., Do Prado, A. H., Garefalakis, P., Lechmann, A., Whittaker, A., & Schlunegger, F. (2022). Grain size of fluvial gravel bars from close-range UAV imagery - uncertainty in segmentation-based data. Earth Surface Dynamics, 10, 953-973. https://doi.org/10.5194/esurf-10-953-2022',
  'Eaton, B. C., Moore, R. D., & MacKenzie, L. G. (2019). Percentile-based grain size distribution analysis tools (GSDtools) - estimating confidence limits and hypothesis tests for comparing two samples. Earth Surface Dynamics, 7, 789-806. https://doi.org/10.5194/esurf-7-789-2019',
  'Kellerhals, R., & Bray, D. I. (1971). Sampling procedures for coarse fluvial sediments. Journal of the Hydraulics Division, ASCE, 97(HY8), 1165-1180.',
  'Graham, D. J., Rollet, A.-J., Piegay, H., & Rice, S. P. (2010). Maximizing the accuracy of image-based surface sediment sampling techniques. Water Resources Research, 46, W02508.',
  'Wolman, M. G. (1954). A method of sampling coarse river-bed material. Eos, Transactions American Geophysical Union, 35(6), 951-956.',
  'Bunte, K., & Abt, S. R. (2001). Sampling surface and subsurface particle-size distributions in wadable gravel- and cobble-bed streams. Gen. Tech. Rep. RMRS-GTR-74, USDA Forest Service.',
  'Detert, M., & Weitbrecht, V. (2012). Automatic object detection to analyze the geometry of gravel grains. River Flow 2012, 595-600.',
  'Purinton, B., & Bookhagen, B. (2019). Introducing PebbleCounts: a grain-sizing tool for photo surveys of dynamic gravel-bed rivers. Earth Surface Dynamics, 7, 859-877.',
  'Folk, R. L., & Ward, W. C. (1957). Brazos River bar: a study in the significance of grain size parameters. Journal of Sedimentary Petrology, 27(1), 3-26.',
];
