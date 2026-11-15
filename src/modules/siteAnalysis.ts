import type {
  FolkWardStats,
  GrainMorphometrics,
  PsdPercentiles,
  SizeMetric,
  WentworthProportions,
} from '../types/index.js';
import {
  computeExtendedMorphometrics,
  computeFabricRoseStats,
  computeWentworthHistogram,
  type ExtendedGrainMorphometrics,
  type FabricRoseStats,
  type WentworthBin,
} from './morphometricsExt.js';
import type { AnalysisSession } from './pipelineController.js';
import {
  baseExportMetadata,
  csvCell,
  metadataCommentLines,
  metadataSummaryRows,
} from './provenance.js';
import {
  buildValidBedMask,
  filterGrainsByRoiAndExclusion,
  type RoiExclusionConfig,
  type ValidBedMask,
} from './roiAndRectify.js';
import {
  computeFolkWardStats,
  computePsdPercentiles,
  filterBorderGrains,
} from './sedimentStats.js';

export type PoolingMode =
  | 'physical-area'
  | 'equal-photo'
  | 'virtual-wolman-grid'
  | 'number-weighted'
  | 'facies-weighted';

export interface SitePhotoMetadata {
  timestamp?: string;
  gps?: { lat: number; lon: number };
  notes?: string;
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
   * field count's 13 mm minimum turned a -42% D50 gap into +3% (audit/k1/).
   */
  minSizeMm?: number;
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
  rating: SampleAdequacyRating;
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
  dCutoffCommonMm: number | null;
  excludedTruncationCount: number;
  excludedTruncationAreaMm2: number;
  psd: PsdPercentiles;
  folkWard: FolkWardStats | null;
  wentworth: WentworthProportions | null;
  wentworthHistogram05Phi: WentworthBin[];
  wentworthHistogram10Phi: WentworthBin[];
  fabricRose: FabricRoseStats;
  bootstrapMode: 'cluster' | 'two-stage-cluster' | 'single-photo-grain-fallback';
  bootstrapSeed: number;
  bootstrapReplicates: number;
  bootstrapCi: PsdConfidenceInterval;
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

const PSD_KEYS: ReadonlyArray<keyof PsdPercentiles> = [
  'D5',
  'D10',
  'D16',
  'D25',
  'D50',
  'D75',
  'D84',
  'D90',
  'D95',
];

const PERCENTILE_NUMS = [5, 10, 16, 25, 50, 75, 84, 90, 95] as const;

export function getStatisticalBasisLabel(mode: PoolingMode): string {
  switch (mode) {
    case 'physical-area':
      return 'Area-Weighted (Grid-by-Number / Sieve-Equivalent, Kellerhals & Bray 1971)';
    case 'equal-photo':
      return 'Equal-Photo Area-Weighted (Normalized Grid-by-Number Equivalent)';
    case 'virtual-wolman-grid':
      return 'Virtual Wolman Grid-by-Number (Discrete Point Count, Kellerhals & Bray 1971)';
    case 'number-weighted':
      return 'Number-Weighted (Area-by-Number Frequency — NOT Sieve-Equivalent)';
    case 'facies-weighted':
      return 'Facies-Weighted Area-Normalized (Stratified Grid-by-Number Equivalent)';
  }
}

/**
 * Deterministic seeded PRNG (Mulberry32).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Validates calibration consistency across all included photos in a site.
 */
export function validateSiteCalibration(
  photos: readonly SitePhotoInput[],
  options?: Pick<SiteAnalysisOptions, 'poolingMode' | 'unit' | 'allowEqualPhotoFallback'>,
): SiteCalibrationValidation {
  const included = photos.filter((p) => p.included);
  if (included.length === 0) {
    return {
      valid: false,
      unit: 'px',
      calibratedPhotoIds: [],
      uncalibratedPhotoIds: [],
      warnings: ['No included photos available for site analysis.'],
      message: 'No included photos available for site analysis.',
    };
  }

  const calibratedPhotoIds: string[] = [];
  const uncalibratedPhotoIds: string[] = [];

  for (const p of included) {
    const cal = p.session.getCalibration();
    if (cal !== undefined && Number.isFinite(cal.mmPerPx) && cal.mmPerPx > 0) {
      calibratedPhotoIds.push(p.photoId);
    } else {
      uncalibratedPhotoIds.push(p.photoId);
    }
  }

  const requestedUnit = options?.unit;
  const allowFallback =
    options?.allowEqualPhotoFallback === true &&
    options?.poolingMode === 'equal-photo';

  if (uncalibratedPhotoIds.length === 0) {
    return {
      valid: true,
      unit: 'mm',
      calibratedPhotoIds,
      uncalibratedPhotoIds: [],
      warnings: [],
      message: 'All included photos are calibrated in mm.',
    };
  }

  if (calibratedPhotoIds.length === 0) {
    if (requestedUnit === 'px' || allowFallback) {
      return {
        valid: true,
        unit: 'px',
        calibratedPhotoIds: [],
        uncalibratedPhotoIds,
        warnings: [
          'Photos are uncalibrated; pooling in pixel units (physical mm metrics unavailable).',
        ],
        message: 'Uncalibrated pixel-unit pooling active.',
      };
    }
    return {
      valid: false,
      unit: 'uncalibrated',
      calibratedPhotoIds: [],
      uncalibratedPhotoIds,
      warnings: [],
      message: `Cannot pool in physical mm units: ${uncalibratedPhotoIds.length} photo(s) lack mmPerPx calibration (${uncalibratedPhotoIds.join(', ')}). Calibrate all photos or switch to unit='px'.`,
    };
  }

  // Mixed calibration state
  if (requestedUnit === 'px' || allowFallback) {
    return {
      valid: true,
      unit: 'px',
      calibratedPhotoIds,
      uncalibratedPhotoIds,
      warnings: [
        `Mixed calibration detected (${uncalibratedPhotoIds.join(', ')} uncalibrated): using pixel/normalized fallback; results may be biased if camera heights differ.`,
      ],
      message: 'Mixed calibration bypassed via pixel/equal-photo fallback.',
    };
  }

  return {
    valid: false,
    unit: 'mixed',
    calibratedPhotoIds,
    uncalibratedPhotoIds,
    warnings: [],
    message: `Mixed calibration state: cannot pool in physical mm units because some included photos lack mmPerPx (${uncalibratedPhotoIds.join(', ')}). Calibrate missing photos, exclude them, or switch to unit='px'.`,
  };
}

interface PreparedGrain {
  grain: GrainMorphometrics;
  sizeVal: number;
  areaVal: number;
  gridHits: number;
}

interface PreparedPhoto {
  input: SitePhotoInput;
  mmPerPx?: number;
  rawGrainCount: number;
  preCutoffGrains: GrainMorphometrics[];
  validGrains: PreparedGrain[];
  excludedTruncationCount: number;
  excludedTruncationAreaMm2: number;
  sampledBedAreaPx: number;
  sampledBedAreaMm2?: number;
  clastPackingPct: number;
  exposedMatrixPct: number;
  gridGrainHits: number;
  gridMatrixHits: number;
  gridSubCutoffHits: number;
  faciesWeight: number;
}

function emptyPsd(): PsdPercentiles {
  return {
    D5: Number.NaN,
    D10: Number.NaN,
    D16: Number.NaN,
    D25: Number.NaN,
    D50: Number.NaN,
    D75: Number.NaN,
    D84: Number.NaN,
    D90: Number.NaN,
    D95: Number.NaN,
  };
}

function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] ?? Number.NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const vLo = sorted[lo] ?? Number.NaN;
  const vHi = sorted[hi] ?? Number.NaN;
  if (lo === hi) return vLo;
  return vLo + (pos - lo) * (vHi - vLo);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return quantileSorted(sorted, 0.5);
}

function computeVirtualWolmanHits(
  session: AnalysisSession,
  validBedMask: ValidBedMask,
  validGrainIds: ReadonlySet<number>,
  subCutoffGrainIds: ReadonlySet<number>,
  options: SiteAnalysisOptions,
  mmPerPx: number | undefined,
  unit: 'mm' | 'px',
): {
  hitCounts: Map<number, number>;
  gridGrainHits: number;
  gridMatrixHits: number;
  gridSubCutoffHits: number;
} {
  const result = session.getResult();
  const masks = result.masks;
  const workW = result.width;
  const workH = result.height;
  const origW = session.workingImage.originalWidth;
  const origH = session.workingImage.originalHeight;
  const sWork = session.workingImage.effectiveScaleFactor;

  const hitCounts = new Map<number, number>();
  let gridGrainHits = 0;
  let gridMatrixHits = 0;
  let gridSubCutoffHits = 0;

  const samplePoints: Array<{ x: number; y: number }> = [];

  if (
    options.wolmanGridSpacingMm !== undefined &&
    options.wolmanGridSpacingMm > 0 &&
    unit === 'mm' &&
    mmPerPx !== undefined &&
    mmPerPx > 0
  ) {
    const stepPx = options.wolmanGridSpacingMm / mmPerPx;
    if (Number.isFinite(stepPx) && stepPx > 0) {
      for (let y = 0.5 * stepPx; y < origH; y += stepPx) {
        for (let x = 0.5 * stepPx; x < origW; x += stepPx) {
          samplePoints.push({ x, y });
        }
      }
    }
  } else if (validBedMask.validPixelCount > 0) {
    let minX = 0;
    let minY = 0;
    let boxW = origW;
    let boxH = origH;

    if (validBedMask.validPixelCount < workW * workH) {
      let minWx = workW;
      let maxWx = -1;
      let minWy = workH;
      let maxWy = -1;
      for (let wy = 0; wy < workH; wy++) {
        const rowOffset = wy * workW;
        for (let wx = 0; wx < workW; wx++) {
          if (validBedMask.valid[rowOffset + wx] === 1) {
            if (wx < minWx) minWx = wx;
            if (wx > maxWx) maxWx = wx;
            if (wy < minWy) minWy = wy;
            if (wy > maxWy) maxWy = wy;
          }
        }
      }
      if (maxWx >= minWx && maxWy >= minWy) {
        minX = Math.max(0, minWx / sWork);
        minY = Math.max(0, minWy / sWork);
        const maxX = Math.min(origW, (maxWx + 1) / sWork);
        const maxY = Math.min(origH, (maxWy + 1) / sWork);
        boxW = Math.max(1e-6, maxX - minX);
        boxH = Math.max(1e-6, maxY - minY);
      }
    }

    const targetK = Math.max(1, Math.round(options.wolmanPointsPerPhoto ?? 100));
    const cols = Math.max(1, Math.ceil(Math.sqrt((targetK * boxW) / Math.max(1e-6, boxH))));
    const rows = Math.max(1, Math.ceil(targetK / cols));
    const stepX = boxW / cols;
    const stepY = boxH / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        samplePoints.push({
          x: minX + (c + 0.5) * stepX,
          y: minY + (r + 0.5) * stepY,
        });
      }
    }
  }

  for (const pt of samplePoints) {
    const wx = Math.min(workW - 1, Math.max(0, Math.round(pt.x * sWork)));
    const wy = Math.min(workH - 1, Math.max(0, Math.round(pt.y * sWork)));
    const idx = wy * workW + wx;
    if (validBedMask.valid[idx] === 0) {
      continue;
    }
    const label = masks[idx] ?? 0;
    if (label === 0) {
      gridMatrixHits++;
    } else if (validGrainIds.has(label)) {
      hitCounts.set(label, (hitCounts.get(label) ?? 0) + 1);
      gridGrainHits++;
    } else if (subCutoffGrainIds.has(label)) {
      gridSubCutoffHits++;
    }
  }

  return { hitCounts, gridGrainHits, gridMatrixHits, gridSubCutoffHits };
}

function buildPooledArrays(
  photos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  sampledGrainsOverride?: ReadonlyArray<readonly PreparedGrain[]>,
): {
  values: number[];
  weights: number[];
  grains: GrainMorphometrics[];
  photoWeightsPct: number[];
} {
  const values: number[] = [];
  const weights: number[] = [];
  const grainsOut: GrainMorphometrics[] = [];
  const photoRawTotals = new Array<number>(photos.length).fill(0);

  let totalFacies = 0;
  if (poolingMode === 'facies-weighted') {
    for (const p of photos) {
      totalFacies += p.faciesWeight;
    }
  }

  for (let pIdx = 0; pIdx < photos.length; pIdx++) {
    const p = photos[pIdx];
    if (p === undefined) continue;
    const grains = sampledGrainsOverride ? sampledGrainsOverride[pIdx] ?? [] : p.validGrains;
    if (grains.length === 0) continue;

    let photoAreaSum = 0;
    if (poolingMode === 'equal-photo' || poolingMode === 'facies-weighted') {
      for (const g of grains) {
        photoAreaSum += g.areaVal;
      }
    }

    const faciesNorm =
      poolingMode === 'facies-weighted'
        ? totalFacies > 0
          ? p.faciesWeight / totalFacies
          : 1 / photos.length
        : 1;

    let photoWeightSum = 0;
    for (const g of grains) {
      let w = 0;
      switch (poolingMode) {
        case 'physical-area':
          w = g.areaVal;
          break;
        case 'equal-photo':
          w = photoAreaSum > 0 ? g.areaVal / photoAreaSum : 0;
          break;
        case 'virtual-wolman-grid':
          w = g.gridHits;
          break;
        case 'number-weighted':
          w = 1;
          break;
        case 'facies-weighted':
          w = photoAreaSum > 0 ? faciesNorm * (g.areaVal / photoAreaSum) : 0;
          break;
      }
      if (w > 0 && Number.isFinite(g.sizeVal) && g.sizeVal > 0) {
        values.push(g.sizeVal);
        weights.push(w);
        grainsOut.push(g.grain);
        photoWeightSum += w;
      }
    }
    photoRawTotals[pIdx] = photoWeightSum;
  }

  let grandTotal = 0;
  for (const t of photoRawTotals) grandTotal += t;
  const photoWeightsPct = photoRawTotals.map((t) =>
    grandTotal > 0 ? (t / grandTotal) * 100 : 0,
  );

  return { values, weights, grains: grainsOut, photoWeightsPct };
}

function lnGamma(z: number): number {
  const g = 7;
  const p = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  const zm1 = z - 1;
  let x = p[0] ?? 1;
  for (let i = 1; i < g + 2; i++) {
    x += (p[i] ?? 0) / (zm1 + i);
  }
  const t = zm1 + g + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (zm1 + 0.5) * Math.log(t) -
    t +
    Math.log(x)
  );
}

export function binomialConfidenceRanks(
  n: number,
  p: number,
  alpha: number,
): { le: number; ue: number } {
  if (n <= 0) {
    return { le: 0, ue: 0 };
  }
  if (n > 5000) {
    const z = alpha <= 0.055 ? 1.959963984540054 : 1.6448536269514722;
    const sd = Math.sqrt(n * p * (1 - p));
    const le = Math.max(0, Math.floor(n * p - z * sd));
    const ue = Math.min(n, Math.ceil(n * p + z * sd));
    return { le, ue };
  }

  const lnN = lnGamma(n + 1);
  const lnP = Math.log(p);
  const lnQ = Math.log(1 - p);

  // Binomial CDF F(m) = P(X <= m). Ranks are found where F crosses alpha/2 and
  // 1 - alpha/2 and linearly interpolated between integer ranks (Eaton et al. 2019,
  // GSDtools), rather than snapped to the conservative integer.
  const lowTarget = alpha / 2;
  const highTarget = 1 - alpha / 2;
  let prevCum = 0;
  let cum = 0;
  let le = 0;
  let ue = n;
  let foundLe = false;
  let foundUe = false;

  for (let m = 0; m <= n; m++) {
    const logPmf =
      lnN - lnGamma(m + 1) - lnGamma(n - m + 1) + m * lnP + (n - m) * lnQ;
    prevCum = cum;
    cum += Math.exp(logPmf);
    if (!foundLe && cum >= lowTarget) {
      const frac = cum > prevCum ? (lowTarget - prevCum) / (cum - prevCum) : 0;
      le = Math.max(0, m - 1 + frac);
      foundLe = true;
    }
    if (!foundUe && cum >= highTarget) {
      const frac = cum > prevCum ? (highTarget - prevCum) / (cum - prevCum) : 0;
      ue = Math.min(n, m - 1 + frac);
      foundUe = true;
      break;
    }
  }

  return { le, ue };
}

function evalWeightedLog2PsdAtProb(
  sortedPairs: ReadonlyArray<{ v: number; w: number }>,
  cdf: Float64Array,
  prob: number,
): number {
  const count = sortedPairs.length;
  if (count === 0) return Number.NaN;
  const firstCdf = cdf[0] ?? 0;
  const lastCdf = cdf[count - 1] ?? 1;
  const firstV = sortedPairs[0]?.v ?? Number.NaN;
  const lastV = sortedPairs[count - 1]?.v ?? Number.NaN;

  if (prob <= firstCdf) return firstV;
  if (prob >= lastCdf) return lastV;

  let lo = 0;
  let hi = count - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if ((cdf[mid] ?? 0) <= prob) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const c0 = cdf[lo] ?? 0;
  const c1 = cdf[hi] ?? 1;
  const v0 = sortedPairs[lo]?.v ?? 1;
  const v1 = sortedPairs[hi]?.v ?? 1;
  if (c1 === c0) return v1;
  const t = (prob - c0) / (c1 - c0);
  const log2Val = Math.log2(v0) + t * (Math.log2(v1) - Math.log2(v0));
  return 2 ** log2Val;
}

function computeBinomialCi(
  values: readonly number[],
  weights: readonly number[],
  poolingMode: PoolingMode,
  confidenceLevel: 0.9 | 0.95,
): BinomialCiResult {
  const alpha = confidenceLevel === 0.9 ? 0.1 : 0.05;
  const pairs: Array<{ v: number; w: number }> = [];
  let sumW = 0;
  let sumW2 = 0;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const w = weights[i];
    if (
      v !== undefined &&
      w !== undefined &&
      Number.isFinite(v) &&
      Number.isFinite(w) &&
      v > 0 &&
      w > 0
    ) {
      pairs.push({ v, w });
      sumW += w;
      sumW2 += w * w;
    }
  }

  if (pairs.length === 0 || sumW <= 0) {
    return {
      confidenceLevel,
      sampleSizeUsed: 0,
      isKishApproximation: false,
      lower: emptyPsd(),
      upper: emptyPsd(),
    };
  }

  pairs.sort((a, b) => a.v - b.v);
  const cdf = new Float64Array(pairs.length);
  let cumSum = 0;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (pair === undefined) continue;
    cumSum += pair.w;
    cdf[i] = (cumSum - 0.5 * pair.w) / sumW;
  }

  const isKish =
    poolingMode !== 'number-weighted' && poolingMode !== 'virtual-wolman-grid';
  const rawN = isKish
    ? (sumW * sumW) / Math.max(1e-12, sumW2)
    : sumW;
  const nUsed = Math.max(1, Math.round(rawN));

  const lower = emptyPsd();
  const upper = emptyPsd();

  for (let i = 0; i < PERCENTILE_NUMS.length; i++) {
    const pNum = PERCENTILE_NUMS[i];
    const key = PSD_KEYS[i];
    if (pNum === undefined || key === undefined) continue;
    const { le, ue } = binomialConfidenceRanks(nUsed, pNum / 100, alpha);
    lower[key] = evalWeightedLog2PsdAtProb(pairs, cdf, le / nUsed);
    upper[key] = evalWeightedLog2PsdAtProb(pairs, cdf, ue / nUsed);
  }

  return {
    confidenceLevel,
    sampleSizeUsed: nUsed,
    isKishApproximation: isKish,
    lower,
    upper,
  };
}

function runBootstrap(
  photos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  unit: 'mm' | 'px',
  replicates: number,
  seed: number,
  twoStage: boolean,
  confidenceLevel: 0.9 | 0.95,
): {
  mode: 'cluster' | 'two-stage-cluster' | 'single-photo-grain-fallback';
  psdCi: PsdConfidenceInterval;
  folkWardCi: FolkWardConfidenceInterval | null;
} {
  const alpha = confidenceLevel === 0.9 ? 0.1 : 0.05;
  const qLo = alpha / 2;
  const qHi = 1 - alpha / 2;
  const rand = mulberry32(seed);
  const B = Math.max(1, Math.round(replicates));

  const dists: Record<keyof PsdPercentiles, number[]> = {
    D5: [],
    D10: [],
    D16: [],
    D25: [],
    D50: [],
    D75: [],
    D84: [],
    D90: [],
    D95: [],
  };

  const fwMeanPhi: number[] = [];
  const fwSortingPhi: number[] = [];
  const fwSkewnessPhi: number[] = [];
  const fwKurtosisPhi: number[] = [];
  const fwMeanMm: number[] = [];

  const nPhotos = photos.length;
  const isSinglePhoto = nPhotos === 1;
  const mode: 'cluster' | 'two-stage-cluster' | 'single-photo-grain-fallback' =
    isSinglePhoto
      ? 'single-photo-grain-fallback'
      : twoStage
        ? 'two-stage-cluster'
        : 'cluster';

  for (let b = 0; b < B; b++) {
    let values: number[];
    let weights: number[];

    if (isSinglePhoto) {
      const onlyPhoto = photos[0];
      if (!onlyPhoto || onlyPhoto.validGrains.length === 0) continue;
      const gCount = onlyPhoto.validGrains.length;
      const resampled: PreparedGrain[] = [];
      for (let i = 0; i < gCount; i++) {
        const gIdx = Math.floor(rand() * gCount);
        const g = onlyPhoto.validGrains[gIdx];
        if (g !== undefined) resampled.push(g);
      }
      const pooled = buildPooledArrays([onlyPhoto], poolingMode, [resampled]);
      values = pooled.values;
      weights = pooled.weights;
    } else {
      const sampledPhotos: PreparedPhoto[] = [];
      const sampledGrains: PreparedGrain[][] = [];
      for (let k = 0; k < nPhotos; k++) {
        const pIdx = Math.floor(rand() * nPhotos);
        const p = photos[pIdx];
        if (p === undefined) continue;
        sampledPhotos.push(p);
        if (twoStage && p.validGrains.length > 0) {
          const gList: PreparedGrain[] = [];
          const gCount = p.validGrains.length;
          for (let i = 0; i < gCount; i++) {
            const gIdx = Math.floor(rand() * gCount);
            const g = p.validGrains[gIdx];
            if (g !== undefined) gList.push(g);
          }
          sampledGrains.push(gList);
        } else {
          sampledGrains.push(p.validGrains);
        }
      }
      const pooled = buildPooledArrays(sampledPhotos, poolingMode, sampledGrains);
      values = pooled.values;
      weights = pooled.weights;
    }

    if (values.length === 0) continue;
    const psd = computePsdPercentiles(values, weights);
    for (const key of PSD_KEYS) {
      const val = psd[key];
      if (Number.isFinite(val)) {
        dists[key].push(val);
      }
    }

    if (unit === 'mm') {
      const fw = computeFolkWardStats(psd);
      if (fw !== null) {
        fwMeanPhi.push(fw.meanPhi);
        fwSortingPhi.push(fw.sortingPhi);
        fwSkewnessPhi.push(fw.skewnessPhi);
        fwKurtosisPhi.push(fw.kurtosisPhi);
        fwMeanMm.push(fw.meanMm);
      }
    }
  }

  const lower = emptyPsd();
  const upper = emptyPsd();
  for (const key of PSD_KEYS) {
    const arr = dists[key];
    arr.sort((a, b) => a - b);
    lower[key] = quantileSorted(arr, qLo);
    upper[key] = quantileSorted(arr, qHi);
  }

  let folkWardCi: FolkWardConfidenceInterval | null = null;
  if (unit === 'mm' && fwMeanPhi.length > 0) {
    fwMeanPhi.sort((a, b) => a - b);
    fwSortingPhi.sort((a, b) => a - b);
    fwSkewnessPhi.sort((a, b) => a - b);
    fwKurtosisPhi.sort((a, b) => a - b);
    fwMeanMm.sort((a, b) => a - b);

    folkWardCi = {
      meanPhi: [quantileSorted(fwMeanPhi, qLo), quantileSorted(fwMeanPhi, qHi)],
      sortingPhi: [
        quantileSorted(fwSortingPhi, qLo),
        quantileSorted(fwSortingPhi, qHi),
      ],
      skewnessPhi: [
        quantileSorted(fwSkewnessPhi, qLo),
        quantileSorted(fwSkewnessPhi, qHi),
      ],
      kurtosisPhi: [
        quantileSorted(fwKurtosisPhi, qLo),
        quantileSorted(fwKurtosisPhi, qHi),
      ],
      meanMm: [quantileSorted(fwMeanMm, qLo), quantileSorted(fwMeanMm, qHi)],
    };
  }

  return {
    mode,
    psdCi: { confidenceLevel, lower, upper },
    folkWardCi,
  };
}

function getGrainSize(
  grain: GrainMorphometrics,
  sizeMetric: SizeMetric,
  unit: 'mm' | 'px',
): number {
  if (sizeMetric === 'dEq') {
    return unit === 'mm' ? (grain.dEqMm ?? grain.dEqPx) : grain.dEqPx;
  }
  if (sizeMetric === 'minFeret') {
    const px = grain.minFeretPx ?? grain.bAxisPx;
    return unit === 'mm' ? (grain.minFeretMm ?? px) : px;
  }
  return unit === 'mm' ? (grain.bAxisMm ?? grain.bAxisPx) : grain.bAxisPx;
}

function getGrainMmSize(
  grain: GrainMorphometrics,
  sizeMetric: SizeMetric,
): number | undefined {
  if (sizeMetric === 'dEq') return grain.dEqMm;
  if (sizeMetric === 'minFeret') return grain.minFeretMm;
  return grain.bAxisMm;
}

function computeSiteWentworth(
  photos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  sizeMetric: SizeMetric = 'bAxis',
): WentworthProportions | null {
  const { grains, weights } = buildPooledArrays(photos, poolingMode);
  if (grains.length === 0) return null;

  let sand = 0;
  let gravel = 0;
  let cobble = 0;
  let boulder = 0;
  let total = 0;

  for (let i = 0; i < grains.length; i++) {
    const grain = grains[i];
    const w = weights[i] ?? 0;
    if (grain === undefined || !Number.isFinite(w) || w <= 0) continue;

    const d = getGrainMmSize(grain, sizeMetric);
    if (typeof d !== 'number' || !Number.isFinite(d)) {
      return null;
    }
    total += w;
    if (d < 2) sand += w;
    else if (d < 64) gravel += w;
    else if (d < 256) cobble += w;
    else boulder += w;
  }

  if (total <= 0) return null;
  return {
    sandPct: (sand / total) * 100,
    gravelPct: (gravel / total) * 100,
    cobblePct: (cobble / total) * 100,
    boulderPct: (boulder / total) * 100,
  };
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

  // Compute common physical cutoff if harmonizing in mm
  let dCutoffCommonMm: number | null = null;
  if (unit === 'mm' && harmonize && minBaxisPx > 0) {
    let maxCutoff = 0;
    for (const p of includedInputs) {
      const mmPerPx = p.session.getCalibration()?.mmPerPx ?? 0;
      const c = minBaxisPx * mmPerPx;
      if (c > maxCutoff) maxCutoff = c;
    }
    dCutoffCommonMm = maxCutoff;
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
        input.roiConfig,
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
  let jackknife: JackknifeSensitivityReport | null = null;
  const d50WithoutMap = new Map<string, number>();

  if (preparedPhotos.length >= 2) {
    const perPhotoJack: JackknifePhotoSensitivity[] = [];
    for (let j = 0; j < preparedPhotos.length; j++) {
      const target = preparedPhotos[j];
      if (target === undefined) continue;
      const subset = preparedPhotos.filter((_, idx) => idx !== j);
      const subPool = buildPooledArrays(subset, options.poolingMode);
      const subPsd = computePsdPercentiles(subPool.values, subPool.weights);

      d50WithoutMap.set(target.input.photoId, subPsd.D50);

      const deltaD16 = subPsd.D16 - psd.D16;
      const deltaD50 = subPsd.D50 - psd.D50;
      const deltaD84 = subPsd.D84 - psd.D84;
      const relPctD16 = psd.D16 > 0 ? (deltaD16 / psd.D16) * 100 : 0;
      const relPctD50 = psd.D50 > 0 ? (deltaD50 / psd.D50) * 100 : 0;
      const relPctD84 = psd.D84 > 0 ? (deltaD84 / psd.D84) * 100 : 0;
      const highInfluence =
        Math.abs(relPctD16) > 10 ||
        Math.abs(relPctD50) > 10 ||
        Math.abs(relPctD84) > 10;

      perPhotoJack.push({
        photoId: target.input.photoId,
        label: target.input.label,
        D16Without: subPsd.D16,
        D50Without: subPsd.D50,
        D84Without: subPsd.D84,
        deltaD16,
        deltaD50,
        deltaD84,
        relPctD16,
        relPctD50,
        relPctD84,
        highInfluence,
      });
    }

    const n = perPhotoJack.length;
    const mean16 =
      perPhotoJack.reduce((s, r) => s + r.D16Without, 0) / n;
    const mean50 =
      perPhotoJack.reduce((s, r) => s + r.D50Without, 0) / n;
    const mean84 =
      perPhotoJack.reduce((s, r) => s + r.D84Without, 0) / n;
    const factor = (n - 1) / n;
    const seD16 = Math.sqrt(
      factor * perPhotoJack.reduce((s, r) => s + (r.D16Without - mean16) ** 2, 0),
    );
    const seD50 = Math.sqrt(
      factor * perPhotoJack.reduce((s, r) => s + (r.D50Without - mean50) ** 2, 0),
    );
    const seD84 = Math.sqrt(
      factor * perPhotoJack.reduce((s, r) => s + (r.D84Without - mean84) ** 2, 0),
    );

    jackknife = { perPhoto: perPhotoJack, seD16, seD50, seD84 };
  }

  // Cumulative Convergence Curve (1 .. N)
  const convergence: ConvergencePoint[] = [];
  let runningGrains = 0;
  for (let k = 1; k <= preparedPhotos.length; k++) {
    const prefix = preparedPhotos.slice(0, k);
    const last = prefix[k - 1];
    if (last === undefined) continue;
    runningGrains += last.validGrains.length;

    if (k === preparedPhotos.length) {
      const ciLo = boot.psdCi.lower.D50;
      const ciHi = boot.psdCi.upper.D50;
      const width = ciHi - ciLo;
      const relHalf = psd.D50 > 0 ? (width / (2 * psd.D50)) * 100 : Number.NaN;
      convergence.push({
        photoCount: k,
        photoId: last.input.photoId,
        label: last.input.label,
        cumulativeGrains: runningGrains,
        D16: psd.D16,
        D50: psd.D50,
        D84: psd.D84,
        ciLoD50: ciLo,
        ciHiD50: ciHi,
        ciWidthD50: width,
        relativeHalfWidthD50Pct: relHalf,
      });
    } else {
      const subPool = buildPooledArrays(prefix, options.poolingMode);
      const subPsd = computePsdPercentiles(subPool.values, subPool.weights);
      const subBoot = runBootstrap(
        prefix,
        options.poolingMode,
        unit,
        Math.min(bootstrapReplicates, 250),
        bootstrapSeed + k,
        bootstrapTwoStage,
        confidenceLevel,
      );
      const ciLo = subBoot.psdCi.lower.D50;
      const ciHi = subBoot.psdCi.upper.D50;
      const width = ciHi - ciLo;
      const relHalf =
        subPsd.D50 > 0 ? (width / (2 * subPsd.D50)) * 100 : Number.NaN;
      convergence.push({
        photoCount: k,
        photoId: last.input.photoId,
        label: last.input.label,
        cumulativeGrains: runningGrains,
        D16: subPsd.D16,
        D50: subPsd.D50,
        D84: subPsd.D84,
        ciLoD50: ciLo,
        ciHiD50: ciHi,
        ciWidthD50: width,
        relativeHalfWidthD50Pct: relHalf,
      });
    }
  }

  // Sample Adequacy & Outlier Flags
  const validGrainCount = preparedPhotos.reduce((s, p) => s + p.validGrains.length, 0);
  const totalGridHits = preparedPhotos.reduce((s, p) => s + p.gridGrainHits, 0);
  const effectiveGrainCount =
    options.poolingMode === 'virtual-wolman-grid'
      ? totalGridHits
      : validGrainCount;

  const rating: SampleAdequacyRating =
    effectiveGrainCount < 100
      ? 'Insufficient'
      : effectiveGrainCount < 200
        ? 'Minimal'
        : effectiveGrainCount < 400
          ? 'Adequate'
          : 'High Precision';

  let maxArea = 0;
  let sumArea = 0;
  for (const p of preparedPhotos) {
    for (const vg of p.validGrains) {
      if (vg.areaVal > maxArea) maxArea = vg.areaVal;
      sumArea += vg.areaVal;
    }
  }
  const largestClastAreaRatio = sumArea > 0 ? maxArea / sumArea : 0;
  const largestClastWarning: 'none' | 'moderate' | 'critical' =
    largestClastAreaRatio > 0.1
      ? 'critical'
      : largestClastAreaRatio > 0.05
        ? 'moderate'
        : 'none';

  if (largestClastWarning === 'critical') {
    warnings.push(
      `Largest clast accounts for ${(largestClastAreaRatio * 100).toFixed(1)}% (> 10%) of total grain area.`,
    );
  } else if (largestClastWarning === 'moderate') {
    warnings.push(
      `Largest clast accounts for ${(largestClastAreaRatio * 100).toFixed(1)}% (> 5%) of total grain area.`,
    );
  }

  const mmPerPxList = preparedPhotos
    .map((p) => p.mmPerPx)
    .filter((v): v is number => v !== undefined && v > 0);
  const medianMmPerPx = median(mmPerPxList);

  const outlierPhotos: Array<{
    photoId: string;
    label: string;
    reasons: string[];
  }> = [];
  const perPhoto: PerPhotoSiteBreakdown[] = [];

  for (let i = 0; i < preparedPhotos.length; i++) {
    const p = preparedPhotos[i];
    if (p === undefined) continue;
    const pPool = buildPooledArrays([p], options.poolingMode);
    const pPsd = computePsdPercentiles(pPool.values, pPool.weights);

    const reasons: string[] = [];
    if (p.validGrains.length < 15) {
      reasons.push(`Low grain count (${p.validGrains.length} < 15)`);
    }
    const d50Without = d50WithoutMap.get(p.input.photoId);
    if (
      d50Without !== undefined &&
      d50Without > 0 &&
      pPsd.D50 > 0 &&
      Math.abs(Math.log2(pPsd.D50 / d50Without)) > 1.0
    ) {
      reasons.push('D50 deviates > 1.0 phi (2x) from rest of site');
    }
    if (
      p.mmPerPx !== undefined &&
      Number.isFinite(medianMmPerPx) &&
      medianMmPerPx > 0 &&
      (p.mmPerPx > 3 * medianMmPerPx || p.mmPerPx < medianMmPerPx / 3)
    ) {
      reasons.push('Scale mmPerPx deviates > 3x from site median');
    }

    if (reasons.length > 0) {
      outlierPhotos.push({
        photoId: p.input.photoId,
        label: p.input.label,
        reasons,
      });
    }

    perPhoto.push({
      photoId: p.input.photoId,
      label: p.input.label,
      included: true,
      ...(p.mmPerPx !== undefined ? { mmPerPx: p.mmPerPx } : {}),
      rawGrainCount: p.rawGrainCount,
      validGrainCount: p.validGrains.length,
      excludedTruncationCount: p.excludedTruncationCount,
      sampledBedAreaPx: p.sampledBedAreaPx,
      ...(p.sampledBedAreaMm2 !== undefined
        ? { sampledBedAreaMm2: p.sampledBedAreaMm2 }
        : {}),
      clastPackingPct: p.clastPackingPct,
      exposedMatrixPct: p.exposedMatrixPct,
      gridGrainHits: p.gridGrainHits,
      gridMatrixHits: p.gridMatrixHits,
      gridSubCutoffHits: p.gridSubCutoffHits,
      D16: pPsd.D16,
      D50: pPsd.D50,
      D84: pPsd.D84,
      weightContributionPct: photoWeightsPct[i] ?? 0,
      outlierReasons: reasons,
    });
  }

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
    wentworth,
    wentworthHistogram05Phi,
    wentworthHistogram10Phi,
    fabricRose,
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

/** CSV cell with quoting and spreadsheet formula-injection neutralisation (OWASP). */
function csvEscape(val: string | number | boolean): string {
  return csvCell(val);
}

/**
 * Provenance block for site-level exports: app/ORT versions, notices, and the
 * model hash, parameters, and calibration used for each included photo.
 */
export function buildSiteExportMetadata(
  entries: readonly SitePhotoInput[],
  report?: SiteAnalysisReport,
): Record<string, unknown> {
  const photos = entries
    .filter((e) => e.included)
    .map((e) => {
      const prov = e.session.getProvenance();
      const cal = e.session.getCalibration();
      return {
        photoId: e.photoId,
        label: e.label,
        mmPerPx: cal?.mmPerPx ?? null,
        effectiveScaleFactor: e.session.workingImage.effectiveScaleFactor,
        roiApplied: e.roiConfig !== undefined,
        ...(prov !== undefined
          ? {
              modelId: prov.modelId,
              modelSha256: prov.modelSha256,
              modelRevision: prov.modelRevision,
              executionProvider: prov.executionProvider ?? null,
              analyzedAt: prov.analyzedAt,
              analyzedWithAppVersion: prov.appVersion,
              postProcess: prov.postProcess ?? null,
            }
          : { provenance: 'unavailable (analysed before provenance tracking)' }),
      };
    });
  return {
    ...baseExportMetadata(),
    ...(report !== undefined
      ? {
          poolingMode: report.poolingMode,
          sizeMetric: report.sizeMetric,
          unit: report.unit,
          bootstrapConfidenceLevel: report.bootstrapCi.confidenceLevel,
        }
      : {}),
    photos,
  };
}

/**
 * Exports a multi-image site summary report as a JSON Blob.
 */
export function exportSiteSummaryJson(
  report: SiteAnalysisReport,
  metadata: Record<string, unknown> = baseExportMetadata(),
): Blob {
  return new Blob([JSON.stringify({ metadata, ...report }, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
}

/**
 * Exports a multi-image site summary report as a structured CSV Blob.
 */
export function exportSiteSummaryCsv(
  report: SiteAnalysisReport,
  metadata: Record<string, unknown> = baseExportMetadata(),
): Blob {
  const lines: string[] = ['section,metric,value,unit'];
  lines.push(...metadataSummaryRows(metadata));

  lines.push(`metadata,pooling_mode,${csvEscape(report.poolingMode)},mode`);
  lines.push(
    `metadata,statistical_basis,${csvEscape(report.statisticalBasisLabel)},label`,
  );
  lines.push(`metadata,unit,${report.unit},unit`);
  lines.push(`metadata,size_metric,${report.sizeMetric},metric`);
  lines.push(
    `metadata,included_photo_count,${report.includedPhotoCount},count`,
  );
  lines.push(`metadata,total_grain_count,${report.totalGrainCount},count`);
  lines.push(`metadata,valid_grain_count,${report.validGrainCount},count`);
  lines.push(
    `metadata,d_cutoff_common_mm,${report.dCutoffCommonMm ?? ''},mm`,
  );
  lines.push(
    `metadata,excluded_truncation_count,${report.excludedTruncationCount},count`,
  );
  lines.push(
    `metadata,excluded_truncation_area_mm2,${report.excludedTruncationAreaMm2},mm2`,
  );
  lines.push(`metadata,adequacy_rating,${csvEscape(report.adequacy.rating)},label`);
  lines.push(
    `metadata,bootstrap_mode,${csvEscape(report.bootstrapMode)},mode`,
  );
  lines.push(`metadata,bootstrap_seed,${report.bootstrapSeed},seed`);
  lines.push(
    `metadata,bootstrap_replicates,${report.bootstrapReplicates},count`,
  );

  for (const key of PSD_KEYS) {
    lines.push(`psd,${key},${report.psd[key]},${report.unit}`);
    lines.push(
      `psd_bootstrap_ci_lo,${key},${report.bootstrapCi.lower[key]},${report.unit}`,
    );
    lines.push(
      `psd_bootstrap_ci_hi,${key},${report.bootstrapCi.upper[key]},${report.unit}`,
    );
    lines.push(
      `psd_binomial_ci_lo,${key},${report.binomialCi.lower[key]},${report.unit}`,
    );
    lines.push(
      `psd_binomial_ci_hi,${key},${report.binomialCi.upper[key]},${report.unit}`,
    );
  }

  if (report.folkWard !== null) {
    const fw = report.folkWard;
    lines.push(`folk_ward,mean_phi,${fw.meanPhi},phi`);
    lines.push(`folk_ward,sorting_phi,${fw.sortingPhi},phi`);
    lines.push(`folk_ward,skewness_phi,${fw.skewnessPhi},phi`);
    lines.push(`folk_ward,kurtosis_phi,${fw.kurtosisPhi},phi`);
    lines.push(`folk_ward,mean_mm,${fw.meanMm},mm`);
    lines.push(`folk_ward,sorting_label,${csvEscape(fw.sortingLabel)},label`);
    lines.push(`folk_ward,skewness_label,${csvEscape(fw.skewnessLabel)},label`);
    lines.push(`folk_ward,kurtosis_label,${csvEscape(fw.kurtosisLabel)},label`);
  }

  if (report.wentworth !== null) {
    const w = report.wentworth;
    lines.push(`wentworth,sand_pct,${w.sandPct},%`);
    lines.push(`wentworth,gravel_pct,${w.gravelPct},%`);
    lines.push(`wentworth,cobble_pct,${w.cobblePct},%`);
    lines.push(`wentworth,boulder_pct,${w.boulderPct},%`);
  }

  for (const p of report.perPhoto) {
    lines.push(
      `per_photo,${csvEscape(p.photoId)}_D50,${p.D50},${report.unit}`,
    );
    lines.push(
      `per_photo,${csvEscape(p.photoId)}_valid_grains,${p.validGrainCount},count`,
    );
    lines.push(
      `per_photo,${csvEscape(p.photoId)}_weight_pct,${p.weightContributionPct},%`,
    );
  }

  for (let i = 0; i < report.citations.length; i++) {
    const cit = report.citations[i];
    if (cit !== undefined) {
      lines.push(`citation,ref_${i + 1},${csvEscape(cit)},text`);
    }
  }

  return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

/**
 * Exports all pooled grains across included photos with `photo_id`, `photo_name`,
 * `mm_per_px`, standard morphometrics, and extended 2D shape metrics.
 */
export function exportPooledGrainsCsv(
  entries: readonly SitePhotoInput[],
  _report?: SiteAnalysisReport,
  options?: { metadata?: Record<string, unknown> },
): Blob {
  const header = [
    'photo_id',
    'photo_name',
    'mm_per_px',
    'grain_id',
    'centroid_x',
    'centroid_y',
    'area_px',
    'a_axis_px',
    'b_axis_px',
    'd_eq_px',
    'area_mm2',
    'a_axis_mm',
    'b_axis_mm',
    'd_eq_mm',
    'orientation_rad',
    'touches_border',
    'perimeter_px',
    'perimeter_mm',
    'circularity',
    'aspect_ratio',
    'elongation',
    'convex_area_px',
    'convex_area_mm2',
    'solidity',
    'sphericity_2d',
    'min_feret_px',
    'max_feret_px',
    'min_feret_mm',
    'max_feret_mm',
  ].join(',');

  const lines: string[] =
    options?.metadata !== undefined
      ? [...metadataCommentLines(options.metadata), header]
      : [header];

  for (const entry of entries) {
    if (!entry.included) continue;
    const res = entry.session.getResult();
    const cal = entry.session.getCalibration();
    const mmPerPx = cal?.mmPerPx;
    const excludeBorder = entry.session.getExcludeBorder();
    const borderFiltered = filterBorderGrains(res.grains, excludeBorder);
    const sWork = entry.session.workingImage.effectiveScaleFactor;

    const grains =
      entry.roiConfig !== undefined
        ? filterGrainsByRoiAndExclusion(
            res.masks,
            borderFiltered,
            res.width,
            res.height,
            sWork,
            entry.roiConfig,
            mmPerPx,
          ).includedGrains
        : borderFiltered;

    const extGrains: ExtendedGrainMorphometrics[] = computeExtendedMorphometrics(
      res.masks,
      grains,
      res.width,
      res.height,
      sWork,
      mmPerPx,
      entry.session.getHullCache(),
    );

    for (const g of extGrains) {
      lines.push(
        [
          csvEscape(entry.photoId),
          csvEscape(entry.label),
          mmPerPx ?? '',
          g.id,
          g.centroidX,
          g.centroidY,
          g.areaPx,
          g.aAxisPx,
          g.bAxisPx,
          g.dEqPx,
          g.areaMm2 ?? '',
          g.aAxisMm ?? '',
          g.bAxisMm ?? '',
          g.dEqMm ?? '',
          g.orientationRad,
          g.touchesBorder,
          g.perimeterPx,
          g.perimeterMm ?? '',
          g.circularity,
          g.aspectRatio,
          g.elongation,
          g.convexAreaPx,
          g.convexAreaMm2 ?? '',
          g.solidity,
          g.sphericity2D,
          g.minFeretPx,
          g.maxFeretPx,
          g.minFeretMm ?? '',
          g.maxFeretMm ?? '',
        ].join(','),
      );
    }
  }

  return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

export const exportSiteGrainsCsv = exportPooledGrainsCsv;
