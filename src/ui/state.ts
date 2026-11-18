import type { ComparedSite } from '../modules/siteComparison.js';
import type { PhotoFilter } from './photoList.js';
import type { HelpKey } from './help.js';
import { DEFAULT_POSTPROCESS_OPTIONS } from '../modules/postprocessCore.js';
import type {
  AnalysisConfig,
  EngineCapabilities,
  ModelId,
  ModelKind,
  CpsamWeights,
  Point2D,
  ScaleMode,
  SedimentStatsReport,
} from '../types/index.js';
import type { AnalysisSession } from '../modules/pipelineController.js';
import type {
  PhotoProcessStatus,
  PhotoRecord,
  SiteRecord,
} from '../modules/projectStorage.js';
import type {
  SiteAnalysisOptions,
  SiteAnalysisReport,
} from '../modules/siteAnalysis.js';

export type EditorToolMode =
  | 'inspect'
  | 'split'
  | 'merge'
  | 'delete'
  | 'addPolygon'
  | 'excludePoly'
  | 'excludeBrush'
  | 'calibrate'
  | 'rectify';

export type DashboardTab = 'psd' | 'adequacy' | 'shape' | 'fabric';
export type ModalKind = 'models' | 'export' | 'about' | 'help' | 'shortcuts' | null;
export type SwStatus = 'unsupported' | 'registering' | 'ready' | 'error';

export interface OverlaySettings {
  instanceIds: boolean;
  wentworthColors: boolean;
  ellipses: boolean;
  orientations: boolean;
  borderTruncated: boolean;
  opacity: number;
  loupe: boolean;
  loupeZoom: 2 | 4;
}

export interface UiAnalysisParams {
  model: ModelKind | 'auto';
  /** Cellpose-SAM weight file: auto / fp16 / int8 / fp4. */
  cpsamWeights: CpsamWeights;
  scaleMode: ScaleMode;
  applyClahe: boolean;
  claheClipLimit: number;
  excludeBorder: boolean;
  flowThreshold: number;
  cellprobThreshold: number;
  minSize: number;
  maxGrainAreaFraction: number;
  /** Border-touch margin in working-resolution px (next analysis). */
  excludeBorderMargin: number;
  /** Advanced: flow-integration steps. */
  niter: number;
  /** Advanced: minimum converging pixels to seed a grain. */
  minSeedDensity: number;
  /** Advanced: inference tiling pipeline. */
  inferencePipeline: 'cellpose' | 'legacy';
  /** Skip inference tiles outside the photo's ROI / exclusions. */
  skipTilesOutsideRoi: boolean;
}

export interface AppState {
  capabilities: EngineCapabilities | null;
  isOnline: boolean;
  swStatus: SwStatus;

  sites: SiteRecord[];
  activeSiteId: string | null;
  photos: PhotoRecord[];
  activePhotoId: string | null;

  sessions: Map<string, AnalysisSession>;
  photoStatuses: Map<string, PhotoProcessStatus>;
  photoErrors: Map<string, string>;
  thumbUrls: Map<string, string>;

  siteReport: SiteAnalysisReport | null;
  singlePhotoStats: SedimentStatsReport | null;
  /** Why site pooling failed (e.g. uncalibrated photos), shown in the dashboard. */
  siteReportError: string | null;
  dashboardScope: 'site' | 'photo' | 'compare';
  /** Sites chosen for comparison (null = all sites). */
  compareSiteIds: string[] | null;
  /** Compare sites in pixels (when they are not calibrated). */
  compareInPixels: boolean;
  /** Comparison results for the chosen sites (computed asynchronously). */
  comparison: { loading: boolean; sites: ComparedSite[]; error: string | null } | null;
  dashboardTab: DashboardTab;
  psdXAxis: 'mm' | 'phi';
  histogramStepPhi: 0.5 | 1.0;

  activeTool: EditorToolMode;
  overlays: OverlaySettings;
  selectedGrainIds: Set<number>;
  /** Which photos the photo list shows. */
  photoFilter: PhotoFilter;
  /** Photo list in select mode (checkboxes for bulk actions). */
  photoSelectMode: boolean;
  selectedPhotoIds: Set<string>;
  inspectedGrainId: number | null;
  pendingCalibrationPoints: Point2D[];
  pendingRectifyPoints: Point2D[];

  analysisParams: UiAnalysisParams;
  siteOptions: SiteAnalysisOptions;

  batchRunning: boolean;
  batchProgress: {
    completed: number;
    total: number;
    currentPhotoId: string;
    currentLabel: string;
    stageDetail?: string;
  } | null;

  activeModal: ModalKind;
  /** Topic shown first in the help dialog (null = full settings list). */
  helpTopic: HelpKey | null;
  modelDownloads: Map<
    ModelId,
    {
      active: boolean;
      percent: number;
      loadedBytes: number;
      totalBytes: number;
      speedMBps: number;
      error?: string;
    }
  >;
  statusMessage: string;
}

export function createInitialState(): AppState {
  return {
    capabilities: null,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    swStatus: 'unsupported',

    sites: [],
    activeSiteId: null,
    photos: [],
    activePhotoId: null,

    sessions: new Map(),
    photoStatuses: new Map(),
    photoErrors: new Map(),
    thumbUrls: new Map(),

    siteReport: null,
    singlePhotoStats: null,
    siteReportError: null,
    // Start with the photo being looked at; the user can switch to the whole site.
    dashboardScope: 'photo',
    compareSiteIds: null,
    compareInPixels: false,
    comparison: null,
    dashboardTab: 'psd',
    psdXAxis: 'mm',
    histogramStepPhi: 0.5,

    activeTool: 'inspect',
    overlays: {
      instanceIds: true,
      wentworthColors: false,
      ellipses: false,
      orientations: false,
      borderTruncated: true,
      opacity: 0.45,
      loupe: false,
      loupeZoom: 2,
    },
    selectedGrainIds: new Set(),
    photoFilter: 'all',
    photoSelectMode: false,
    selectedPhotoIds: new Set(),
    inspectedGrainId: null,
    pendingCalibrationPoints: [],
    pendingRectifyPoints: [],

    analysisParams: defaultAnalysisParams(),
    siteOptions: {
      poolingMode: 'physical-area',
      sizeMetric: 'bAxis',
      minBaxisPx: 15,
      harmonizePhysicalCutoff: true,
      wolmanPointsPerPhoto: 100,
      bootstrapReplicates: 500,
      bootstrapSeed: 42,
      bootstrapTwoStage: false,
      confidenceLevel: 0.95,
      minSizeMm: 0,
      maxExcludedFraction: 0.1,
    },

    batchRunning: false,
    batchProgress: null,

    activeModal: null,
    helpTopic: null,
    modelDownloads: new Map(),
    statusMessage: 'Ready — 100% local browser workspace',
  };
}

export class AppStore {
  private state: AppState;
  private readonly listeners = new Set<(state: AppState) => void>();

  constructor(initial?: AppState) {
    this.state = initial ?? createInitialState();
  }

  getState(): AppState {
    return this.state;
  }

  setState(updater: Partial<AppState> | ((prev: AppState) => AppState)): void {
    if (typeof updater === 'function') {
      this.state = updater(this.state);
    } else {
      this.state = { ...this.state, ...updater };
    }
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function toAnalysisConfig(
  params: UiAnalysisParams,
): Omit<AnalysisConfig, 'signal' | 'onProgress' | 'calibration'> {
  return {
    model: params.model,
    cpsamWeights: params.cpsamWeights,
    scaleMode: params.scaleMode,
    applyClahe: params.applyClahe,
    claheClipLimit: params.claheClipLimit,
    excludeBorder: params.excludeBorder,
    inferencePipeline: params.inferencePipeline,
    skipTilesOutsideRoi: params.skipTilesOutsideRoi,
    postProcess: {
      flowThreshold: params.flowThreshold,
      cellprobThreshold: params.cellprobThreshold,
      minSize: params.minSize,
      maxGrainAreaFraction: params.maxGrainAreaFraction,
      excludeBorderMargin: params.excludeBorderMargin,
      niter: params.niter,
      minSeedDensity: params.minSeedDensity,
    },
  };
}

/** Default analysis settings: the engine defaults, i.e. the benchmarked configuration. */
export function defaultAnalysisParams(): UiAnalysisParams {
  return {
  model: 'auto',
  cpsamWeights: 'auto',
  scaleMode: 'auto',
  applyClahe: false,
  claheClipLimit: 2.0,
  excludeBorder: true,
  // Single source of truth: the engine defaults, which match the configuration
  // benchmarked in full_dataset_validation_report.md (flow 0.45, min size 30 px).
  flowThreshold: DEFAULT_POSTPROCESS_OPTIONS.flowThreshold,
  cellprobThreshold: DEFAULT_POSTPROCESS_OPTIONS.cellprobThreshold,
  minSize: DEFAULT_POSTPROCESS_OPTIONS.minSize,
  maxGrainAreaFraction: DEFAULT_POSTPROCESS_OPTIONS.maxGrainAreaFraction,
  excludeBorderMargin: DEFAULT_POSTPROCESS_OPTIONS.excludeBorderMargin,
  niter: DEFAULT_POSTPROCESS_OPTIONS.niter,
  minSeedDensity: DEFAULT_POSTPROCESS_OPTIONS.minSeedDensity,
    inferencePipeline: 'cellpose',
  skipTilesOutsideRoi: true,
};
}
