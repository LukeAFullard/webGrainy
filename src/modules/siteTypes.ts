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

export interface SitePhotoMetadata {
  timestamp?: string;
  gps?: { lat: number; lon: number };
  cameraMake?: string;
  cameraModel?: string;
  focalLength35mm?: number;
  blurScore?: number;
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
  /** Mean diameters (incl. Sauter), geometric and moment statistics, percentile ratios. */
  extra: ExtraGrainStats | null;
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
