import type { ComparedSite } from '../modules/siteComparison.js';
import type { PhotoFilter } from './photoList.js';
import { DEFAULT_SITE_OPTIONS } from '../modules/siteOptions.js';
import type { HelpKey } from './help.js';
import { DEFAULT_POSTPROCESS_OPTIONS } from '../modules/postprocessCore.js';
import { DEFAULT_RETENTION_DAYS } from '../modules/retention.js';
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
export type WorkflowStepId = 'calibrate' | 'exclude' | 'segment' | 'edit' | 'export';
export type ModalKind = 'models' | 'export' | 'download-results' | 'about' | 'help' | 'shortcuts' | null;
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
  /** A new app version is installed and waits for "Reload to update". */
  updateReady: boolean;
  /** A newer version took over this page from another tab: reload before analysing. */
  staleBuild: boolean;
  /** Days sites are kept in this browser after their last use (0 = until deleted). */
  retentionDays: number;
  /** What the last automatic removal deleted (shown until dismissed). */
  retentionNotice: string | null;
  /**
   * Expired sites kept because their work was never downloaded (or changed since): the user
   * chooses to download, keep (open) or remove them. Site ids.
   */
  retentionHeld: string[];
  /** Browser storage is full: what failed and what to do (shown until dismissed). */
  storageFullNotice: string | null;
  /** "Download results": also include the project file with the photos. */
  downloadIncludeProject: boolean;
  /** Outline / mask exports: only the grains counted in the statistics (default: every grain). */
  exportCountedOnly: boolean;
  /** Export dialog choices for outlines / mask / photo (see photoExportChoice). */
  exportWhat: string;
  exportFormat: string;
  exportCoords: string;
  /** A results download is being prepared. */
  downloadingResults: boolean;

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
  /** Compare sites: order by survey date and show the time-series chart. */
  compareByDate: boolean;
  /** Photo list in select mode (checkboxes for bulk actions). */
  photoSelectMode: boolean;
  selectedPhotoIds: Set<string>;
  /** "Copy scale to photos": the photo whose scale is being copied (select mode is on). */
  scaleCopySourceId: string | null;
  inspectedGrainId: number | null;
  pendingCalibrationPoints: Point2D[];
  pendingRectifyPoints: Point2D[];
  /** Controlled toolbar inputs for Calibrate and 4-Pt Rectify so re-renders never reset them. */
  calibrationPreset: string;
  calibrationLength: number;
  calibrationUnit: 'mm' | 'cm';
  rectifyWidthMm: number;
  rectifyHeightMm: number;

  analysisParams: UiAnalysisParams;
  siteOptions: SiteAnalysisOptions;

  batchRunning: boolean;
  /** True while an optional AI enhancement (2× Upscale / Deblur) is running. */
  enhancing?: boolean;
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
  /** Whether the full-page product overview / landing page is currently shown. */
  showLanding: boolean;
  /** Currently selected step in the landing page 5-step workflow walkthrough. */
  landingStep: WorkflowStepId;
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
    updateReady: false,
    staleBuild: false,
    retentionDays: DEFAULT_RETENTION_DAYS,
    retentionNotice: null,
    retentionHeld: [],
    storageFullNotice: null,
    downloadIncludeProject: false,
    exportCountedOnly: false,
    exportWhat: 'outlines',
    exportFormat: 'geojson',
    exportCoords: 'lonlat',
    downloadingResults: false,

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
    compareByDate: false,
    photoSelectMode: false,
    selectedPhotoIds: new Set(),
    scaleCopySourceId: null,
    inspectedGrainId: null,
    pendingCalibrationPoints: [],
    pendingRectifyPoints: [],
    calibrationPreset: '100|mm',
    calibrationLength: 100,
    calibrationUnit: 'mm',
    rectifyWidthMm: 500,
    rectifyHeightMm: 500,

    analysisParams: defaultAnalysisParams(),
    siteOptions: { ...DEFAULT_SITE_OPTIONS },

    batchRunning: false,
    enhancing: false,
    batchProgress: null,

    activeModal: null,
    helpTopic: null,
    showLanding: false,
    landingStep: 'calibrate',
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
  // benchmarked in validation/heldout (flow 0.45, min size 30 px).
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
