/**
 * Shared TypeScript interface contracts for ImageGrains 2.0 Web.
 * Consumed across M1–M5 modules, Web Workers, and tests.
 */

export type ModelId =
  | 'ig2_unet_fp32'
  | 'ig2_cpsam_fp16'
  | 'ig2_cpsam_int8_wo_fp32scale'
  | 'ig2_cpsam_fp4_e2m1_lut';

/**
 * Which Cellpose-SAM weight file to use. All three gave the same accuracy on the 40-image
 * held-out benchmark (PQ 0.652–0.653, median D50 error 2.8–2.9%).
 * 'auto': FP16 on a WebGPU GPU with shader-f16, otherwise INT8 (faster on CPU, half the memory).
 */
export type CpsamWeights = 'auto' | 'fp16' | 'int8' | 'fp4';

export type ModelKind = 'unet' | 'cpsam';

export type ScaleMode = 'auto' | '1.0x' | '0.5x' | '0.25x';

export type ExecutionProvider = 'webgpu' | 'wasm';

export interface DownloadProgress {
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  speedMBps: number;
}

export interface CachedModelInfo {
  modelId: ModelId;
  fileName: string;
  sizeBytes: number;
  cachedAt: number;
  sha256?: string;
}

export interface StorageQuotaInfo {
  usageBytes: number;
  quotaBytes: number;
  availableBytes: number;
}

export interface ModelDownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  baseUrl?: string;
  forceRefresh?: boolean;
  /**
   * Throw if the model cannot be stored for offline use (explicit "Download" in the model
   * manager). Default false: during analysis a failed cache write is only a warning.
   */
  requireCache?: boolean;
}

export interface WorkingImageResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  effectiveScaleFactor: number;
  scaleModeApplied: Exclude<ScaleMode, 'auto'>;
}

export interface ModelRecommendation {
  model: ModelKind;
  confidence: number;
  rationale: string;
  metrics: {
    sobelEntropy: number;
    multiScaleContrastVar: number;
    shadowGlareRange: number;
    hasWebGPU: boolean;
    hasShaderF16?: boolean;
    deviceMemoryGB: number | null;
    elapsedMs: number;
  };
}

export interface InferenceProgress {
  completedTiles: number;
  totalTiles: number;
  percent: number;
}

export interface InferenceOutput {
  flowY: Float32Array;
  flowX: Float32Array;
  cellprob: Float32Array;
  width: number;
  height: number;
  /** Present when tiles were skipped (ROI): which areas the network actually saw. */
  tiling?: TileSkipRecord;
}

/** Record of an analysis that skipped tiles outside the ROI (working-image px). */
export interface TileSkipRecord {
  tilesRun: number;
  tilesTotal: number;
  /** Margin around the valid area that was always analysed. */
  marginPx: number;
  /** Analysed tile rectangles [x0, y0, x1, y1], end-exclusive. */
  analysedRects: Array<[number, number, number, number]>;
}

/** Region test in working-image px (end-exclusive): true = run inference there. */
export type RegionNeedTest = (x0: number, y0: number, x1: number, y1: number) => boolean;

export interface CpsamInferenceOptions {
  tileSize?: number;
  overlap?: number;
  /**
   * Tiles per `session.run` call (default 16). Use 1 on the WASM backend: a 16-tile
   * ViT-L batch exceeds the 4 GB wasm32 heap (std::bad_alloc on full-size photos), and
   * batching gives little speed-up on CPU.
   */
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: InferenceProgress) => void;
}

export interface PostProcessOptions {
  niter?: number;
  cellprobThreshold?: number;
  flowThreshold?: number;
  minSize?: number;
  minSeedDensity?: number;
  excludeBorderMargin?: number;
  maxGrainAreaFraction?: number;
}

export type SizeMetric = 'bAxis' | 'dEq' | 'minFeret';

export interface GrainMorphometrics {
  id: number;
  areaPx: number;
  centroidX: number;
  centroidY: number;
  aAxisPx: number;
  bAxisPx: number;
  dEqPx: number;
  orientationRad: number;
  touchesBorder: boolean;
  /** Bounding box as `[minX, minY, maxX, maxY]` inclusive. */
  bbox: [number, number, number, number];
  areaMm2?: number;
  aAxisMm?: number;
  bAxisMm?: number;
  dEqMm?: number;
  minFeretPx?: number;
  minFeretMm?: number;
  maxFeretPx?: number;
  maxFeretMm?: number;
}

export interface PostProcessResult {
  masks: Int32Array;
  width: number;
  height: number;
  grains: GrainMorphometrics[];
  grainCount: number;
}

export interface WorkerRequest {
  type: 'postprocess';
  requestId: string;
  flowY: Float32Array;
  flowX: Float32Array;
  cellprob: Float32Array;
  width: number;
  height: number;
  options?: PostProcessOptions;
}

export type WorkerResponse =
  | {
      type: 'result';
      requestId: string;
      result: PostProcessResult;
    }
  | {
      type: 'progress';
      requestId: string;
      stage: string;
      percent: number;
    }
  | {
      type: 'error';
      requestId: string;
      message: string;
    };

export interface Point2D {
  x: number;
  y: number;
}

export interface CalibrationResult {
  mmPerPx: number;
  pointA: Point2D;
  pointB: Point2D;
  physicalLengthMm: number;
  pixelDistance: number;
  /**
   * Where the scale came from: measured on the photo (default when absent), perspective
   * rectification, GeoTIFF georeferencing, or copied from another photo.
   */
  source?: 'manual' | 'rectification' | 'geotiff' | 'copied';
  /** Label of the photo a copied scale came from. */
  copiedFrom?: string;
}

export interface PsdPercentiles {
  D5: number;
  D10: number;
  D16: number;
  D25: number;
  D50: number;
  D75: number;
  D84: number;
  D90: number;
  D95: number;
}

export interface FolkWardStats {
  meanPhi: number;
  sortingPhi: number;
  skewnessPhi: number;
  kurtosisPhi: number;
  meanMm: number;
  sortingLabel: string;
  skewnessLabel: string;
  kurtosisLabel: string;
}

export interface WentworthProportions {
  sandPct: number;
  gravelPct: number;
  cobblePct: number;
  boulderPct: number;
}

export interface SedimentStatsReport {
  totalGrains: number;
  includedGrains: number;
  excludedBorderGrains: number;
  /** Grains excluded by minBaxisPx or minSizeMm cutoffs. */
  excludedCutoffGrains?: number;
  unit: 'px' | 'mm';
  areaWeightedB: PsdPercentiles;
  numberWeightedB: PsdPercentiles;
  areaWeightedDEq: PsdPercentiles;
  numberWeightedDEq: PsdPercentiles;
  areaWeightedMinFeret?: PsdPercentiles;
  numberWeightedMinFeret?: PsdPercentiles;
  folkWard: FolkWardStats | null;
  wentworth: WentworthProportions | null;
  /** Mean diameters (incl. Sauter), geometric and moment statistics, percentile ratios. */
  extra?: import('../modules/grainStatsExtra.js').ExtraGrainStats;
  /** Human-readable caveats (small n, uncalibrated, mixed calibration). */
  warnings?: string[];
}

/**
 * 'cellpose' (default): upstream-exact Cellpose tiling, which reproduces PyTorch ImageGrains.
 * 'legacy': the v1.1 webGrainy tiling (whole-image U-Net, reflect padding, Hanning blend).
 */
export type InferencePipeline = 'cellpose' | 'legacy';

export interface AnalysisConfig {
  model?: ModelKind | 'auto';
  /** Cellpose-SAM weight file (default 'auto'). Ignored for U-Net. */
  cpsamWeights?: CpsamWeights;
  /**
   * ROI / exclusions (original-image coordinates) used to skip inference tiles that lie
   * entirely outside the valid bed area plus a safety margin (Cellpose pipeline only).
   */
  inferenceRoi?: import('../modules/roiAndRectify.js').RoiExclusionConfig;
  /** Skip tiles outside the photo's ROI during batch analysis (default true). */
  skipTilesOutsideRoi?: boolean;
  inferencePipeline?: InferencePipeline;
  scaleMode?: ScaleMode;
  /**
   * Enlarge the working image by this factor before inference (e.g. 1.5). In testing this
   * helped U-Net on fine gravel (working median b-axis < 20 px); see audit/preprocessing.
   */
  fineGrainUpscale?: number;
  applyClahe?: boolean;
  claheClipLimit?: number;
  excludeBorder?: boolean;
  postProcess?: PostProcessOptions;
  calibration?: CalibrationResult;
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: unknown) => void;
}

export interface EngineCapabilities {
  hasWebGPU: boolean;
  hasShaderF16?: boolean;
  /** Phone or tablet: Auto uses U-Net, and Cellpose-SAM uses INT8 weights. */
  isMobile?: boolean;
  hasWasmSimd: boolean;
  deviceMemoryGB: number | null;
  cachedModels: CachedModelInfo[];
}

/** Everything needed to reproduce a single-photo analysis (see provenance.ts). */
export interface AnalysisProvenance {
  appVersion: string;
  ortVersion: string;
  analyzedAt: string;
  modelId: ModelId;
  modelFile: string;
  modelRevision: string;
  modelSha256: string;
  executionProvider?: string;
  inferencePipeline?: string;
  scaleMode?: string;
  /** Working image enlarged by this factor for fine gravel (U-Net), if any. */
  fineGrainUpscale?: number;
  effectiveScaleFactor?: number;
  applyClahe?: boolean;
  claheClipLimit?: number;
  postProcess?: Record<string, number>;
  /** Set when inference skipped tiles outside the ROI. */
  tileSkipping?: TileSkipRecord;
}

export interface SerializedAnalysisSession {
  version: 1;
  workingMasks: Int32Array;
  workingImage: WorkingImageResult;
  recommendation: ModelRecommendation;
  calibration?: CalibrationResult;
  excludeBorder: boolean;
  borderMargin: number;
  provenance?: AnalysisProvenance;
}

