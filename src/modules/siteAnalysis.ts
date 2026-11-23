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
import { withinSiteSettingDifferences } from './siteProvenance.js';
import { setStatsWeights } from './siteStatsWeights.js';
import { detectionLimitPx } from './grainSize.js';
import { DEFAULT_SITE_OPTIONS } from './siteOptions.js';
export { grainStatsWeight } from './siteStatsWeights.js';
import { aspectRatioCounts } from './histograms.js';
import { median, getStatisticalBasisLabel, type PreparedGrain, type PreparedPhoto, computeVirtualWolmanHits, buildPooledArrays, getGrainSize, computeSiteWentworth, siteCutoffReason } from './sitePooling.js';
import { type SitePhotoInput, type SiteAnalysisOptions, type SiteAnalysisReport, SITE_BIBLIOGRAPHIC_CITATIONS } from './siteTypes.js';
import { calibrateSiteInterval, computeBinomialCi, runBootstrap, computeJackknife, computeConvergence, MIN_PHOTOS_FOR_RELIABLE_CI } from './siteUncertainty.js';

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

/** Upper bound on bootstrap replicates (the app offers 50-5000). */
export const MAX_BOOTSTRAP_REPLICATES = 10_000;

/** Labels of photos whose counted grains are identical (e.g. the same photo added twice). */
function duplicatePhotoLabels(photos: readonly PreparedPhoto[]): string[][] {
  const bySig = new Map<string, string[]>();
  for (const p of photos) {
    if (p.validGrains.length === 0) continue;
    const sig = p.validGrains.map((g) => `${g.sizeVal}:${g.areaVal}`).sort().join('|');
    const list = bySig.get(sig) ?? [];
    list.push(p.input.label);
    bySig.set(sig, list);
  }
  return [...bySig.values()].filter((l) => l.length > 1);
}

/**
 * Smallest grain size (original-photo px) a photo's analysis can resolve: the equal-area
 * diameter of the segmentation area floor (`minSize`, in working-image px) converted back
 * to the photo with `effectiveScaleFactor`, or `minBaxisPx` if larger. Photos shrunk for
 * analysis (auto scale on large photos) have a higher floor than `minBaxisPx` alone.
 */
export function photoDetectionLimitPx(session: AnalysisSession, minBaxisPx: number): number {
  const minSize = session.getProvenance()?.postProcess?.['minSize'] ?? DEFAULT_POSTPROCESS_OPTIONS.minSize;
  return detectionLimitPx(minSize, session.workingImage.effectiveScaleFactor, minBaxisPx);
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
  // Bounded: options can come from a saved or imported project (see sanitizeSiteOptions).
  const bootstrapReplicates = Math.min(
    MAX_BOOTSTRAP_REPLICATES,
    Math.max(1, Math.round(Number.isFinite(options.bootstrapReplicates) ? options.bootstrapReplicates! : DEFAULT_SITE_OPTIONS.bootstrapReplicates)),
  );
  const bootstrapSeed = Number.isFinite(options.bootstrapSeed) ? options.bootstrapSeed! >>> 0 : 42;
  const bootstrapTwoStage = options.bootstrapTwoStage === true;
  const confidenceLevel: 0.9 | 0.95 = options.confidenceLevel === 0.9 ? 0.9 : 0.95;

  const warnings: string[] = [...validation.warnings];
  const includedInputs = photos.filter((p) => p.included);
  // Photos analysed differently (e.g. Auto chose U-Net for some photos and Cellpose-SAM for
  // others) have different size biases; pooling them silently would mix those biases.
  const differences = withinSiteSettingDifferences(includedInputs);
  if (differences.length > 0) {
    warnings.push(
      `Photos in this site were analysed differently (${differences.map((d) => `${d.setting}: ${d.values}`).join('; ')}). Their size biases differ, so the pooled statistics mix them: re-analyse all photos with the same settings (e.g. choose the model instead of Auto).`,
    );
  }

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
      if (siteCutoffReason(g, sizeMetric, minBaxisPx, dCutoffCommonMm) !== null) {
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
    photoIndex,
    photoWeightsPct,
  } = buildPooledArrays(preparedPhotos, options.poolingMode);
  const statsWeights = new Map<string, Map<number, number>>();
  pooledGrains.forEach((g, i) => {
    const photoId = preparedPhotos[photoIndex[i]!]!.input.photoId;
    const m = statsWeights.get(photoId) ?? new Map<number, number>();
    m.set(g.id, weights[i]!);
    statsWeights.set(photoId, m);
  });
  const psd = computePsdPercentiles(values, weights);
  // As for one photo: sorting, skewness and kurtosis need at least two grains.
  const folkWard = unit === 'mm' && values.length >= 2 ? computeFolkWardStats(psd) : null;
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
    .filter((r) => Number.isFinite(r));
  const aspectRatios = aspectRatioCounts(ratios, 10);
  const medianAspectRatio = median(ratios);

  const rawBoot = runBootstrap(
    preparedPhotos,
    options.poolingMode,
    unit,
    bootstrapReplicates,
    bootstrapSeed,
    bootstrapTwoStage,
    confidenceLevel,
  );
  if (rawBoot.mode === 'single-photo-grain-fallback') {
    warnings.push(
      'Single-photo site: cluster bootstrap fell back to within-photo grain resampling; inter-photo spatial variance is not captured.',
    );
  }
  // Leave-one-photo-out jackknife (also a second estimate of the site's standard error).
  const { jackknife, d50WithoutMap } = computeJackknife(preparedPhotos, options.poolingMode, psd);
  const calibrated = calibrateSiteInterval(rawBoot, { psd, folkWard }, preparedPhotos.length, confidenceLevel, jackknife?.logSe);
  const boot = { ...rawBoot, psdCi: calibrated.psdCi, folkWardCi: calibrated.folkWardCi };
  const duplicates = duplicatePhotoLabels(preparedPhotos);
  if (duplicates.length > 0) {
    warnings.push(
      `Identical results in ${duplicates.map((d) => d.join(' and ')).join('; ')}: the same photo added twice? Its grains are counted twice and the uncertainty is understated. Remove the duplicate.`,
    );
  }
  if (calibrated.status === 'degenerate') {
    warnings.push(
      'The photos give identical bootstrap results, so the uncertainty of some percentiles cannot be estimated (shown as not available). Check for duplicate photos and take more photos.',
    );
  } else if (calibrated.status === 'few-photos') {
    warnings.push(
      `Only ${preparedPhotos.length} photos: the ${Math.round(confidenceLevel * 100)}% interval is approximate and wide (t-interval with ${preparedPhotos.length - 1} degrees of freedom). Take at least ${MIN_PHOTOS_FOR_RELIABLE_CI} photos per site for a reliable interval.`,
    );
  }

  const binomialCi = computeBinomialCi(
    values,
    weights,
    options.poolingMode,
    confidenceLevel,
  );


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
  const { validGrainCount, effectiveGrainCount, rating, limitedByPhotoCount, largestClastAreaRatio, largestClastWarning } =
    assessSampleAdequacy(preparedPhotos, options.poolingMode, warnings, weights);
  if (validGrainCount > 0 && validGrainCount < 30) {
    warnings.push(
      `Only ${validGrainCount} grains counted: percentiles are highly uncertain and Folk & Ward classes are not meaningful (at least 100 recommended).`,
    );
  }
  const { outlierPhotos, perPhoto } = buildPerPhotoBreakdown(
    preparedPhotos,
    options.poolingMode,
    d50WithoutMap,
    photoWeightsPct,
  );

  const report: SiteAnalysisReport = {
    poolingMode: options.poolingMode,
    statisticalBasisLabel: getStatisticalBasisLabel(options.poolingMode),
    unit,
    sizeMetric,
    includedPhotoCount: preparedPhotos.length,
    totalGrainCount,
    validGrainCount,
    minBaxisPx,
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
    shape: { aspectRatioCounts: aspectRatios, medianAspectRatio, n: ratios.length },
    bootstrapMode: boot.mode,
    bootstrapSeed,
    bootstrapReplicates,
    bootstrapCi: boot.psdCi,
    bootstrapPercentileCi: rawBoot.psdCi,
    ciStatus: calibrated.status,
    ciLogSe: calibrated.logSe,
    folkWardCi: boot.folkWardCi,
    binomialCi,
    jackknife,
    convergence,
    adequacy: {
      rating,
      limitedByPhotoCount,
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
  setStatsWeights(report, statsWeights);
  return report;
}
