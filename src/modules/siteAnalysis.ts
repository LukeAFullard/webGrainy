/**
 * Site analysis: pools the photos of a site into one grain-size sample and reports the PSD,
 * uncertainty, adequacy and per-photo breakdown (`analyzeSite`). The parts live in
 * siteTypes, siteCalibration, sitePooling, siteUncertainty, siteAdequacy and siteExportFormats;
 * this module re-exports their public API so existing imports keep working.
 */
import type { GrainMorphometrics, SizeMetric } from '../types/index.js';
import { computeExtraGrainStats } from './grainStatsExtra.js';
import { computeFabricRoseStats, computeWentworthHistogram } from './morphometricsExt.js';
import { buildValidBedMask, filterGrainsByRoiAndExclusion, type ValidBedMask } from './roiAndRectify.js';
import { computeFolkWardStats, computePsdPercentiles, filterBorderGrains } from './sedimentStats.js';
import { DEFAULT_POSTPROCESS_OPTIONS } from './postprocessCore.js';
import type { AnalysisSession } from './pipelineController.js';
import { assessSampleAdequacy, buildPerPhotoBreakdown } from './siteAdequacy.js';
import { validateSiteCalibration, withExclusionTolerance } from './siteCalibration.js';
import { getStatisticalBasisLabel, type PreparedGrain, type PreparedPhoto, computeVirtualWolmanHits, buildPooledArrays, getGrainSize, getGrainMmSize, computeSiteWentworth } from './sitePooling.js';
import { type SitePhotoInput, type SiteAnalysisOptions, type SiteAnalysisReport, SITE_BIBLIOGRAPHIC_CITATIONS } from './siteTypes.js';
import { computeBinomialCi, runBootstrap, computeJackknife, computeConvergence } from './siteUncertainty.js';

// Public API: re-exports the parts from the site modules.
export * from './siteTypes.js';
export { validateSiteCalibration, withExclusionTolerance } from './siteCalibration.js';
export { getStatisticalBasisLabel } from './sitePooling.js';
export { binomialConfidenceRanks, mulberry32 } from './siteUncertainty.js';
export {
  buildSiteExportMetadata,
  exportPooledGrainsCsv,
  exportSiteGrainsCsv,
  exportSiteSummaryCsv,
  exportSiteSummaryJson,
} from './siteExportFormats.js';

/**
 * Smallest grain size (original-photo px) a photo's analysis can resolve: the equal-area
 * diameter of the segmentation area floor (`minSize`, in working-image px) converted back
 * to the photo with `effectiveScaleFactor`, or `minBaxisPx` if larger. Photos shrunk for
 * analysis (auto scale on large photos) have a higher floor than `minBaxisPx` alone.
 */
export function photoDetectionLimitPx(session: AnalysisSession, minBaxisPx: number): number {
  const minSize = session.getProvenance()?.postProcess?.['minSize'] ?? DEFAULT_POSTPROCESS_OPTIONS.minSize;
  const s = session.workingImage.effectiveScaleFactor;
  const floorPx =
    Number.isFinite(minSize) && minSize > 0 && Number.isFinite(s) && s > 0
      ? (2 * Math.sqrt(minSize / Math.PI)) / s
      : 0;
  return Math.max(Math.max(0, minBaxisPx), floorPx);
}

/**
 * Runs complete multi-image site pooling, truncation harmonization,
 * uncertainty quantification (Cluster Bootstrap + Eaton 2019 Binomial CI + Jackknife),
 * convergence analysis, and adequacy diagnostics.
 */
export function analyzeSite(
  photos: readonly SitePhotoInput[],
  options: SiteAnalysisOptions,
): SiteAnalysisReport {
  const validation = validateSiteCalibration(photos, options);
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const unit: 'mm' | 'px' = validation.unit === 'mm' ? 'mm' : 'px';
  const sizeMetric: SizeMetric = options.sizeMetric ?? 'bAxis';
  const minBaxisPx = Math.max(0, options.minBaxisPx ?? 15);
  const harmonize =
    unit === 'mm' &&
    (options.harmonizeCutoff ?? options.harmonizePhysicalCutoff ?? true);
  const bootstrapReplicates = Math.max(
    1,
    Math.round(options.bootstrapReplicates ?? 1000),
  );
  const bootstrapSeed = options.bootstrapSeed ?? 42;
  const bootstrapTwoStage = options.bootstrapTwoStage ?? false;
  const confidenceLevel = options.confidenceLevel ?? 0.95;

  const warnings: string[] = [...validation.warnings];
  const includedInputs = photos.filter((p) => p.included);

  // Compute common physical cutoff if harmonizing in mm: the coarsest photo's smallest
  // resolvable size (detection floor at its working resolution, or minBaxisPx if larger).
  let dCutoffCommonMm: number | null = null;
  if (unit === 'mm' && harmonize) {
    let maxCutoff = 0;
    for (const p of includedInputs) {
      const mmPerPx = p.session.getCalibration()?.mmPerPx ?? 0;
      const c = photoDetectionLimitPx(p.session, minBaxisPx) * mmPerPx;
      if (c > maxCutoff) maxCutoff = c;
    }
    dCutoffCommonMm = maxCutoff > 0 ? maxCutoff : null;
  }
  const minSizeMm = options.minSizeMm;
  if (unit === 'mm' && minSizeMm !== undefined && Number.isFinite(minSizeMm) && minSizeMm > 0) {
    dCutoffCommonMm = Math.max(dCutoffCommonMm ?? 0, minSizeMm);
  } else if (unit !== 'mm' && minSizeMm !== undefined && minSizeMm > 0) {
    warnings.push(
      `Lower size cutoff of ${minSizeMm} mm ignored: photos are not all calibrated in mm.`,
    );
  }

  const preparedPhotos: PreparedPhoto[] = [];
  let totalGrainCount = 0;
  let excludedTruncationCount = 0;
  let excludedTruncationAreaMm2 = 0;
  let gridMatrixHitsTotal = 0;
  let gridSubCutoffHitsTotal = 0;

  for (const input of includedInputs) {
    if (sizeMetric === 'minFeret') {
      input.session.ensureFeret();
    }
    const res = input.session.getResult();
    const excludeBorder = input.session.getExcludeBorder();
    const cal = input.session.getCalibration();
    const mmPerPx =
      cal !== undefined && Number.isFinite(cal.mmPerPx) && cal.mmPerPx > 0
        ? cal.mmPerPx
        : undefined;
    const sWork = input.session.workingImage.effectiveScaleFactor;

    totalGrainCount += res.grains.length;
    const borderFiltered = filterBorderGrains(res.grains, excludeBorder);

    let preCutoffGrains: GrainMorphometrics[];
    let validBedMask: ValidBedMask;
    let sampledBedAreaPx: number;
    let sampledBedAreaMm2: number | undefined;
    let clastPackingPct: number;
    let exposedMatrixPct: number;

    if (input.roiConfig !== undefined) {
      const roiRes = filterGrainsByRoiAndExclusion(
        res.masks,
        borderFiltered,
        res.width,
        res.height,
        sWork,
        withExclusionTolerance(input.roiConfig, options.maxExcludedFraction),
        mmPerPx,
      );
      preCutoffGrains = roiRes.includedGrains;
      validBedMask = roiRes.validBedMask;
      sampledBedAreaPx = roiRes.sampledBedAreaPx;
      sampledBedAreaMm2 = roiRes.sampledBedAreaMm2;
      clastPackingPct = roiRes.clastPackingPct;
      exposedMatrixPct = roiRes.exposedMatrixPct;
    } else {
      preCutoffGrains = borderFiltered;
      validBedMask = buildValidBedMask(res.width, res.height, sWork, {
        exclusionPolygons: [],
        exclusionStrokes: [],
      });
      sampledBedAreaPx =
        input.session.workingImage.originalWidth *
        input.session.workingImage.originalHeight;
      sampledBedAreaMm2 =
        mmPerPx !== undefined ? sampledBedAreaPx * mmPerPx * mmPerPx : undefined;
      let areaSum = 0;
      for (const g of preCutoffGrains) areaSum += g.areaPx;
      clastPackingPct =
        sampledBedAreaPx > 0
          ? Math.min(100, (areaSum / sampledBedAreaPx) * 100)
          : 0;
      exposedMatrixPct = Math.max(0, 100 - clastPackingPct);
    }

    const postCutoffGrains: GrainMorphometrics[] = [];
    const subCutoffGrainIds = new Set<number>();
    let photoTruncCount = 0;
    let photoTruncAreaMm2 = 0;

    for (const g of preCutoffGrains) {
      const pxSize = getGrainSize(g, sizeMetric, 'px');
      const mmSize = getGrainMmSize(g, sizeMetric);
      const failsPx = minBaxisPx > 0 && pxSize < minBaxisPx;
      const failsCommonMm =
        dCutoffCommonMm !== null &&
        mmSize !== undefined &&
        mmSize < dCutoffCommonMm;

      if (failsPx || failsCommonMm) {
        photoTruncCount++;
        subCutoffGrainIds.add(g.id);
        if (g.areaMm2 !== undefined) {
          photoTruncAreaMm2 += g.areaMm2;
        }
        continue;
      }
      postCutoffGrains.push(g);
    }

    excludedTruncationCount += photoTruncCount;
    excludedTruncationAreaMm2 += photoTruncAreaMm2;

    const validGrainIds = new Set(postCutoffGrains.map((g) => g.id));
    let hitCounts = new Map<number, number>();
    let gridGrainHits = 0;
    let gridMatrixHits = 0;
    let gridSubCutoffHits = 0;

    if (options.poolingMode === 'virtual-wolman-grid') {
      const wolman = computeVirtualWolmanHits(
        input.session,
        validBedMask,
        validGrainIds,
        subCutoffGrainIds,
        options,
        mmPerPx,
        unit,
      );
      hitCounts = wolman.hitCounts;
      gridGrainHits = wolman.gridGrainHits;
      gridMatrixHits = wolman.gridMatrixHits;
      gridSubCutoffHits = wolman.gridSubCutoffHits;
      gridMatrixHitsTotal += gridMatrixHits;
      gridSubCutoffHitsTotal += gridSubCutoffHits;
    }

    const validGrains: PreparedGrain[] = postCutoffGrains.map((g) => {
      const sizeVal = getGrainSize(g, sizeMetric, unit);
      const areaVal = unit === 'mm' ? (g.areaMm2 ?? g.areaPx) : g.areaPx;
      return {
        grain: g,
        sizeVal,
        areaVal,
        gridHits: hitCounts.get(g.id) ?? 0,
      };
    });

    preparedPhotos.push({
      input,
      ...(mmPerPx !== undefined ? { mmPerPx } : {}),
      rawGrainCount: res.grains.length,
      preCutoffGrains,
      validGrains,
      excludedTruncationCount: photoTruncCount,
      excludedTruncationAreaMm2: photoTruncAreaMm2,
      sampledBedAreaPx,
      ...(sampledBedAreaMm2 !== undefined ? { sampledBedAreaMm2 } : {}),
      clastPackingPct,
      exposedMatrixPct,
      gridGrainHits,
      gridMatrixHits,
      gridSubCutoffHits,
      faciesWeight: Math.max(0, input.faciesWeight ?? 1),
      detectionLimitPx: photoDetectionLimitPx(input.session, minBaxisPx),
    });
  }

  const {
    values,
    weights,
    grains: pooledGrains,
    photoWeightsPct,
  } = buildPooledArrays(preparedPhotos, options.poolingMode);
  const psd = computePsdPercentiles(values, weights);
  const folkWard = unit === 'mm' ? computeFolkWardStats(psd) : null;
  const extra =
    values.length > 0
      ? computeExtraGrainStats(
          values,
          weights,
          psd,
          unit,
          options.poolingMode === 'virtual-wolman-grid' ? { multiplicity: weights } : undefined,
        )
      : null;
  const wentworth =
    unit === 'mm'
      ? computeSiteWentworth(preparedPhotos, options.poolingMode, sizeMetric)
      : null;

  const wentworthHistogram05Phi =
    unit === 'mm'
      ? computeWentworthHistogram(pooledGrains, {
          stepPhi: 0.5,
          weighted: options.poolingMode !== 'number-weighted',
          weights,
          sizeMetric,
        })
      : [];
  const wentworthHistogram10Phi =
    unit === 'mm'
      ? computeWentworthHistogram(pooledGrains, {
          stepPhi: 1.0,
          weighted: options.poolingMode !== 'number-weighted',
          weights,
          sizeMetric,
        })
      : [];
  const fabricRose = computeFabricRoseStats(pooledGrains, {
    weighted: options.poolingMode !== 'number-weighted',
    weights,
  });

  // Shape: b/a aspect ratio of every pooled grain once (number basis).
  const ratios = pooledGrains
    .map((g) => (g.aAxisPx > 0 ? g.bAxisPx / g.aAxisPx : Number.NaN))
    .filter((r) => Number.isFinite(r))
    .sort((a, b) => a - b);
  const aspectRatioCounts = new Array<number>(10).fill(0);
  for (const r of ratios) aspectRatioCounts[Math.min(9, Math.max(0, Math.floor(r * 10)))]!++;
  const mid = ratios.length / 2;
  const medianAspectRatio =
    ratios.length === 0 ? Number.NaN : ratios.length % 2 ? ratios[Math.floor(mid)]! : (ratios[mid - 1]! + ratios[mid]!) / 2;

  const boot = runBootstrap(
    preparedPhotos,
    options.poolingMode,
    unit,
    bootstrapReplicates,
    bootstrapSeed,
    bootstrapTwoStage,
    confidenceLevel,
  );
  if (boot.mode === 'single-photo-grain-fallback') {
    warnings.push(
      'Single-photo site: cluster bootstrap fell back to within-photo grain resampling; inter-photo spatial variance is not captured.',
    );
  }

  const binomialCi = computeBinomialCi(
    values,
    weights,
    options.poolingMode,
    confidenceLevel,
  );

  // Jackknife leave-one-photo-out sensitivity
  const { jackknife, d50WithoutMap } = computeJackknife(preparedPhotos, options.poolingMode, psd);

  // Cumulative Convergence Curve (1 .. N)
  const convergence = computeConvergence(preparedPhotos, psd, boot, {
    poolingMode: options.poolingMode,
    unit,
    bootstrapReplicates,
    bootstrapSeed,
    bootstrapTwoStage,
    confidenceLevel,
  });

  // Sample Adequacy & Outlier Flags
  const { validGrainCount, effectiveGrainCount, rating, largestClastAreaRatio, largestClastWarning } =
    assessSampleAdequacy(preparedPhotos, options.poolingMode, warnings, weights);
  const { outlierPhotos, perPhoto } = buildPerPhotoBreakdown(
    preparedPhotos,
    options.poolingMode,
    d50WithoutMap,
    photoWeightsPct,
  );

  return {
    poolingMode: options.poolingMode,
    statisticalBasisLabel: getStatisticalBasisLabel(options.poolingMode),
    unit,
    sizeMetric,
    includedPhotoCount: preparedPhotos.length,
    totalGrainCount,
    validGrainCount,
    dCutoffCommonMm,
    excludedTruncationCount,
    excludedTruncationAreaMm2,
    psd,
    folkWard,
    extra,
    wentworth,
    wentworthHistogram05Phi,
    wentworthHistogram10Phi,
    fabricRose,
    shape: { aspectRatioCounts, medianAspectRatio, n: ratios.length },
    bootstrapMode: boot.mode,
    bootstrapSeed,
    bootstrapReplicates,
    bootstrapCi: boot.psdCi,
    folkWardCi: boot.folkWardCi,
    binomialCi,
    jackknife,
    convergence,
    adequacy: {
      rating,
      effectiveGrainCount,
      largestClastAreaRatio,
      largestClastWarning,
      outlierPhotos,
    },
    perPhoto,
    gridMatrixHitsTotal,
    gridSubCutoffHitsTotal,
    warnings,
    citations: [...SITE_BIBLIOGRAPHIC_CITATIONS],
  };
}
