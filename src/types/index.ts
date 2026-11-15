/**
 * Shared TypeScript interface contracts for ImageGrains 2.0 Web.
 * Consumed across M1–M5 modules, Web Workers, and tests.
 */

export type ModelId = 'ig2_unet_fp32' | 'ig2_cpsam_fp16';

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
}

export interface CpsamInferenceOptions {
  tileSize?: number;
  overlap?: number;
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
  unit: 'px' | 'mm';
  areaWeightedB: PsdPercentiles;
  numberWeightedB: PsdPercentiles;
  areaWeightedDEq: PsdPercentiles;
  numberWeightedDEq: PsdPercentiles;
  folkWard: FolkWardStats | null;
  wentworth: WentworthProportions | null;
  /** Human-readable caveats (small n, uncalibrated, mixed calibration). */
  warnings?: string[];
}

export interface AnalysisConfig {
  model?: ModelKind | 'auto';
  scaleMode?: ScaleMode;
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
  scaleMode?: string;
  effectiveScaleFactor?: number;
  applyClahe?: boolean;
  claheClipLimit?: number;
  postProcess?: Record<string, number>;
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

