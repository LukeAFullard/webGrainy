import type { ModelId, Point2D, StorageQuotaInfo } from '../types/index.js';
import {
  clearModelCache,
  checkStorageQuota,
  deleteCachedModel,
  downloadModel,
} from '../modules/modelCache.js';
import {
  AnalysisSession,
  ImageGrainsEngine,
} from '../modules/pipelineController.js';
import {
  importSiteArchive,
  listSitePhotos,
  listSites,
  getPhotoResult,
  runSiteBatch,
  savePhoto as dbSavePhoto,
  savePhotoResult,
  saveSite,
  type PhotoRecord,
  type SiteRecord,
} from '../modules/projectStorage.js';
import { computeFabricRoseStats } from '../modules/morphometricsExt.js';
import { aspectRatioCounts, sizeHistogramFromWentworth } from '../modules/histograms.js';
import { rectifyPerspective } from '../modules/roiAndRectify.js';
import {
  buildSiteInputs,
  computeWorkspaceReports,
  effectiveRoi,
} from '../modules/siteWorkspace.js';
import type { SitePhotoInput } from '../modules/siteAnalysis.js';
import {
  COMPARE_COLORS,
  compareD50,
  comparisonCsv,
  computeComparedSites,
  loadStoredSiteInputs,
  type SiteForComparison,
} from '../modules/siteComparison.js';
import { ScaleCalibrator } from '../modules/interactiveEditor.js';
import {
  renderAspectRatioHistogramSvg,
  renderConvergenceChartSvg,
  renderFabricRoseSvg,
  renderJackknifeChartSvg,
  renderPsdChartSvg,
  renderSizeHistogramSvg,
  renderComparePsdSvg,
  renderCompareSizeHistogramSvg,
} from './charts.js';
import { CanvasViewport } from './canvasViewport.js';
import { parseJpegExifMetadata } from './exif.js';
import { helpButton, isHelpKey, renderHelpModalHtml } from './help.js';
import { logicalCores, wasmThreadsFor } from '../modules/onnxInference.js';
import { GUIDE_HIDDEN_KEY, guideInputFrom, guideSteps, renderGuideHtml } from './onboarding.js';
import { EXPORTED_ONCE_KEY, readFlag, writeFlag } from './prefs.js';
import { backupStatus, markSiteBackedUp, markSiteChanged, readBackupRecords } from './backup.js';
import { ScreenWakeLock } from './wakeLock.js';
import { DoneSignal, NOTIFY_PREF_KEY, requestNotifyPermission } from './doneSignal.js';
import { loadAnalysisParams, saveAnalysisParams } from './savedSettings.js';
import { applyEvent, newActivity, renderActivityHtml, startPhoto, type ActivityState } from './progress.js';
import { CPU_THREADS_KEY, readCpuThreadPref } from './cpuThreads.js';
import { svgToPngBlob, withSvgMetadata } from './chartExport.js';
import { baseExportMetadata } from '../modules/provenance.js';
import {
  handleExportAction,
  triggerBlobDownload,
  renderAboutModalHtml,
  renderExportModalHtml,
  renderModelsModalHtml,
} from './modals.js';
import {
  AppStore,
  createInitialState,
  toAnalysisConfig,
  defaultAnalysisParams,
  type AppState,
  type DashboardTab,
  type EditorToolMode,
} from './state.js';

/** Remembers which `details[data-keep-open]` blocks are open across innerHTML re-renders. */
function captureOpenDetails(root: HTMLElement): Set<string> {
  const open = new Set<string>();
  root.querySelectorAll<HTMLDetailsElement>('details[data-keep-open]').forEach((d) => {
    if (d.open) open.add(d.dataset['keepOpen'] ?? '');
  });
  return open;
}

function restoreOpenDetails(root: HTMLElement, open: Set<string>): void {
  root.querySelectorAll<HTMLDetailsElement>('details[data-keep-open]').forEach((d) => {
    if (open.has(d.dataset['keepOpen'] ?? '')) d.open = true;
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function yieldToMain(): Promise<void> {
  const w = window as unknown as { scheduler?: { yield?: () => Promise<void> } };
  if (w.scheduler && typeof w.scheduler.yield === 'function') {
    await w.scheduler.yield();
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const lightSchemeQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

function isLightColorScheme(): boolean {
  return lightSchemeQuery?.matches ?? false;
}

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Analysis settings are remembered between visits (this browser only).
const store = new AppStore({ ...createInitialState(), analysisParams: loadAnalysisParams() });
let lastSavedParams = store.getState().analysisParams;
store.subscribe((st) => {
  if (st.analysisParams !== lastSavedParams) {
    lastSavedParams = st.analysisParams;
    saveAnalysisParams(st.analysisParams);
  }
});

/** Saves a photo record and notes that its site has changes not yet backed up. */
async function savePhoto(photo: PhotoRecord): Promise<void> {
  markSiteChanged(photo.siteId);
  await dbSavePhoto(photo);
}

// Long jobs keep the screen awake and say when they are done (tab title, optional notification).
const wakeLock = new ScreenWakeLock();
const doneSignal = new DoneSignal();
/** True while "Analyse all sites" runs, so the inner open-site batch does not end the job signals. */
let allSitesJobActive = false;

// Browser storage use, refreshed after jobs; shown in the Site panel.
let storageInfo: { usage: number; quota: number; persisted: boolean } | null = null;
async function refreshStorageInfo(): Promise<void> {
  try {
    if (!navigator.storage?.estimate) return;
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    storageInfo = { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
    renderSidebar(store.getState());
  } catch {
    /* not available: no storage line */
  }
}

// CPU thread preference ('auto' = cores − 1), saved per browser; applies on page load.
const cpuThreadPref = readCpuThreadPref();
const cpuThreads = wasmThreadsFor(cpuThreadPref);

const engine = new ImageGrainsEngine({
  useWorker: true,
  workerFactory: () =>
    new Worker('./workers/grainPostprocess.worker.js', { type: 'module' }),
  sessionCreateOptions: {
    wasmPaths: './ort/',
    ...(cpuThreads !== undefined ? { numThreads: cpuThreads } : {}),
  },
});

engine.onProgress((stage, detail) => {
  if (
    stage === 'warning' &&
    detail &&
    typeof detail === 'object' &&
    'message' in detail &&
    typeof (detail as { message?: unknown }).message === 'string'
  ) {
    store.setState({ statusMessage: (detail as { message: string }).message });
    if ((detail as { code?: unknown }).code === 'webgpu-device-lost') {
      void refreshCapabilities();
    }
  }
});

/** Asks for a site name; returns null if cancelled. Trims and limits to 120 characters. */
function askSiteName(message: string, current: string): string | null {
  const raw = window.prompt(message, current);
  if (raw === null) return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
  return name.length > 0 ? name : current;
}

// ---- Getting-started guide (hidden flag and "exported once" are per browser) ----
let guideHidden = readFlag(GUIDE_HIDDEN_KEY);
let exportedOnce = readFlag(EXPORTED_ONCE_KEY);

function guideHtml(state: AppState): string {
  return guideHidden ? '' : renderGuideHtml(guideSteps(guideInputFrom(state, exportedOnce)));
}

// ---- Analysis activity bar (stage, tiles, time left, cancel) ----
let activity: ActivityState | null = null;
let activityRaf: number | null = null;
function scheduleActivityRender(): void {
  if (activityRaf !== null) return;
  activityRaf = requestAnimationFrame(() => {
    activityRaf = null;
    renderActivityBar();
  });
}
function renderActivityBar(): void {
  const el = document.getElementById('activity-bar');
  if (!el) return;
  if (activity === null) {
    el.hidden = true;
    el.innerHTML = '';
    document.body.classList.remove('has-activity');
    return;
  }
  el.hidden = false;
  document.body.classList.add('has-activity');
  el.innerHTML = renderActivityHtml(activity);
}
engine.onProgress((stage, detail) => {
  if (activity === null) return;
  activity = applyEvent(activity, stage, detail, performance.now());
  scheduleActivityRender();
});

let viewport: CanvasViewport | null = null;
let batchAbortController: AbortController | null = null;
const modelAbortControllers = new Map<ModelId, AbortController>();
let cachedQuota: StorageQuotaInfo | null = null;
let lastAnnouncedMsg = '';

// Persistent DOM containers created once
let topbarEl!: HTMLElement;
let sidebarEl!: HTMLElement;
let toolbarEl!: HTMLElement;
let subToolbarEl!: HTMLElement;
let footerEl!: HTMLElement;
let inspectorEl!: HTMLElement;
let emptyStateEl!: HTMLElement;
let dashboardEl!: HTMLElement;
let appDialogEl!: HTMLDialogElement;
let srAnnouncerEl!: HTMLElement;
let fileInputEl!: HTMLInputElement;
let archiveInputEl!: HTMLInputElement;

function announceStatus(message: string): void {
  if (!srAnnouncerEl || !message || message === lastAnnouncedMsg) return;
  lastAnnouncedMsg = message;
  srAnnouncerEl.textContent = message;
}

function getActiveSite(state: AppState): SiteRecord | null {
  return state.sites.find((s) => s.siteId === state.activeSiteId) ?? null;
}

function getActivePhoto(state: AppState): PhotoRecord | null {
  return state.photos.find((p) => p.photoId === state.activePhotoId) ?? null;
}

function recomputeReports(): void {
  const state = store.getState();
  store.setState(computeWorkspaceReports(state));
  // The comparison includes the active site, so keep it in step.
  if (state.dashboardScope === 'compare') void refreshComparison();
}

async function refreshCapabilities(): Promise<void> {
  try {
    const capabilities = await engine.initialize();
    cachedQuota = await checkStorageQuota().catch(() => null);
    store.setState({ capabilities });
  } catch (err) {
    store.setState({
      statusMessage: `Engine init warning: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function loadSiteData(siteId: string): Promise<void> {
  const state = store.getState();
  // Revoke the previous thumbnails only after the new ones are in state: revoking them
  // up front left <img> elements pointing at dead blob: URLs if anything re-rendered the
  // sidebar during the awaits below (net::ERR_FILE_NOT_FOUND).
  const staleThumbUrls = [...state.thumbUrls.values()];

  // The previously active site may have new results: reload sites for comparison when needed.
  storedSiteInputsCache.clear();
  const photos = await listSitePhotos(siteId);
  const sessions = new Map<string, AnalysisSession>();
  const photoStatuses = new Map<string, 'pending' | 'running' | 'done' | 'error'>();
  const photoErrors = new Map<string, string>();
  const thumbUrls = new Map<string, string>();

  for (const p of photos) {
    thumbUrls.set(p.photoId, URL.createObjectURL(p.imageBlob));
    const res = await getPhotoResult(p.photoId);
    if (res) {
      photoStatuses.set(p.photoId, res.status === 'running' ? 'pending' : res.status);
      if (res.errorMessage) photoErrors.set(p.photoId, res.errorMessage);
      if (res.serializedSession) {
        try {
          const sess = AnalysisSession.fromSerialized(res.serializedSession);
          if (p.calibration) sess.setCalibration(p.calibration);
          if (p.roiConfig) sess.setRoiConfig(effectiveRoi(p, store.getState().siteOptions));
          sessions.set(p.photoId, sess);
        } catch {
          photoStatuses.set(p.photoId, 'pending');
        }
      }
    } else {
      photoStatuses.set(p.photoId, 'pending');
    }
  }

  const site = state.sites.find((s) => s.siteId === siteId);
  store.setState({
    activeSiteId: siteId,
    photos,
    activePhotoId: photos[0]?.photoId ?? null,
    sessions,
    photoStatuses,
    photoErrors,
    thumbUrls,
    siteOptions: site ? { ...site.options } : state.siteOptions,
    selectedGrainIds: new Set(),
    inspectedGrainId: null,
  });
  for (const url of staleThumbUrls) URL.revokeObjectURL(url);

  recomputeReports();
  await syncViewport(true);
}

async function createDefaultOrLoadSites(): Promise<void> {
  let sites = await listSites();
  if (sites.length === 0) {
    const defaultSite: SiteRecord = {
      siteId: makeId('site'),
      name: 'Field Site 1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      options: store.getState().siteOptions,
      photoOrder: [],
    };
    await saveSite(defaultSite);
    sites = [defaultSite];
  }
  store.setState({ sites });
  const first = sites[0];
  if (first) {
    await loadSiteData(first.siteId);
  }
}

async function syncViewport(fitToView = false): Promise<void> {
  if (!viewport) return;
  const state = store.getState();
  const photo = getActivePhoto(state);
  const session = photo ? state.sessions.get(photo.photoId) ?? null : null;
  await viewport.setPhotoAndSession(photo, session, fitToView);
  viewport.updateToolAndOverlays({
    tool: state.activeTool,
    overlays: state.overlays,
    selectedIds: state.selectedGrainIds,
    inspectedId: state.inspectedGrainId,
    minBaxisPx: state.siteOptions.minBaxisPx ?? 15,
    calPoints: state.pendingCalibrationPoints,
    rectifyPoints: state.pendingRectifyPoints,
  });
}

async function handleFilesAdded(files: FileList | File[]): Promise<void> {
  const state = store.getState();
  const site = getActiveSite(state);
  if (!site) return;

  const added: PhotoRecord[] = [];
  let taskDeadline = performance.now() + 50;
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue;
    try {
      const bmp = await createImageBitmap(file);
      const width = bmp.width;
      const height = bmp.height;
      bmp.close();

      const metadata = await parseJpegExifMetadata(file).catch(() => undefined);
      const photo: PhotoRecord = {
        photoId: makeId('photo'),
        siteId: site.siteId,
        label: file.name,
        imageBlob: file,
        width,
        height,
        addedAt: Date.now(),
        included: true,
        ...(metadata !== undefined ? { metadata } : {}),
      };
      await savePhoto(photo);
      await savePhotoResult({
        photoId: photo.photoId,
        status: 'pending',
        updatedAt: Date.now(),
      });
      added.push(photo);
    } catch (err) {
      store.setState({
        statusMessage: `Failed to import ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (performance.now() >= taskDeadline) {
      await yieldToMain();
      taskDeadline = performance.now() + 50;
    }
  }

  if (added.length > 0) {
    const updatedSite: SiteRecord = {
      ...site,
      photoOrder: [...site.photoOrder, ...added.map((p) => p.photoId)],
      updatedAt: Date.now(),
    };
    await saveSite(updatedSite);
    const sites = await listSites();
    store.setState({ sites, statusMessage: `Added ${added.length} photo(s) locally` });
    await loadSiteData(site.siteId);
    const lastAdded = added[added.length - 1];
    if (lastAdded) {
      store.setState({ activePhotoId: lastAdded.photoId });
      await syncViewport(true);
    }
  }
}

/**
 * Analyses every not-yet-analysed photo in every site: the open site first (so its results
 * appear as usual), then the others, whose results are saved for when they are opened or
 * compared.
 */
async function runAllSites(): Promise<void> {
  const start = store.getState();
  if (start.batchRunning) return;
  const activeId = start.activeSiteId;
  allSitesJobActive = true;
  void wakeLock.acquire();
  try {
    await runAllSitesInner(activeId);
  } finally {
    allSitesJobActive = false;
    void wakeLock.release();
  }
}

async function runAllSitesInner(activeId: string | null): Promise<void> {
  doneSignal.start(store.getState().photos.length);
  await runBatch();
  if (lastBatchCancelled) {
    doneSignal.finish(true, '', false);
    return; // Cancel stops the whole job, not just the open site.
  }
  const others = store.getState().sites.filter((s) => s.siteId !== activeId);
  // Count pending photos per site, so the progress bar can show the whole job.
  const pendingBySite: Array<{ siteId: string; name: string; count: number }> = [];
  for (const site of others) {
    let count = 0;
    for (const p of await listSitePhotos(site.siteId)) {
      const r = await getPhotoResult(p.photoId);
      if (!r || r.status === 'pending' || r.status === 'error' || r.status === 'running') count++;
    }
    if (count > 0) pendingBySite.push({ siteId: site.siteId, name: site.name, count });
  }
  const total = pendingBySite.reduce((n, s) => n + s.count, 0);
  if (total === 0) {
    store.setState({ statusMessage: 'All photos in all sites are analysed.' });
    doneSignal.finish(false, 'All photos in all sites are analysed.', notifyWhenDone());
    return;
  }
  doneSignal.start(total);
  batchAbortController = new AbortController();
  const analysisConfig = toAnalysisConfig(store.getState().analysisParams);
  activity = newActivity(total);
  renderActivityBar();
  store.setState({ batchRunning: true, statusMessage: `Analysing ${total} photo(s) in ${pendingBySite.length} other site(s)…` });
  let counter = 0;
  let done = 0;
  let failed = 0;
  try {
    for (const site of pendingBySite) {
      if (batchAbortController.signal.aborted) break;
      const res = await runSiteBatch({
        siteId: site.siteId,
        engine,
        analysisConfig,
        signal: batchAbortController.signal,
        onPhotoStart: (photo) => {
          counter += 1;
          doneSignal.progress(counter - 1, total);
          if (activity) {
            activity = startPhoto(activity, counter, `${site.name} · ${photo.label}`);
            scheduleActivityRender();
          }
        },
      });
      done += res.completed;
      failed += res.failed;
      if (res.completed > 0) markSiteChanged(site.siteId);
    }
    const aborted = batchAbortController.signal.aborted;
    store.setState({
      statusMessage: aborted
        ? `Cancelled: ${done} of ${total} photos in other sites analysed.`
        : `All sites analysed: ${done} done, ${failed} failed in other sites.`,
    });
    doneSignal.finish(aborted, `All sites: ${done} photos analysed${failed > 0 ? `, ${failed} failed` : ''}.`, notifyWhenDone());
  } catch (err) {
    store.setState({ statusMessage: `Batch error: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    batchAbortController = null;
    store.setState({ batchRunning: false, batchProgress: null });
    activity = null;
    renderActivityBar();
    storedSiteInputsCache.clear();
    doneSignal.finish(true, '', false); // no-op unless an error ended the job early
    void refreshStorageInfo();
    if (store.getState().dashboardScope === 'compare') void refreshComparison();
  }
}

/** Saves the photo's fine-grain enlargement choice and re-analyses it. */
async function setFineGrainUpscale(photo: PhotoRecord, factor: number | undefined): Promise<void> {
  const { fineGrainUpscale: _old, ...rest } = photo.analysisConfig ?? {};
  const updated: PhotoRecord = {
    ...photo,
    analysisConfig: factor !== undefined ? { ...rest, fineGrainUpscale: factor } : rest,
  };
  await savePhoto(updated);
  store.setState({ photos: store.getState().photos.map((p) => (p.photoId === photo.photoId ? updated : p)) });
  await runBatch([photo.photoId]);
}

let lastBatchCancelled = false;

async function runBatch(photoIds?: string[]): Promise<void> {
  lastBatchCancelled = false;
  const state = store.getState();
  const site = getActiveSite(state);
  if (!site || state.batchRunning) return;

  batchAbortController = new AbortController();
  const analysisConfig = toAnalysisConfig(state.analysisParams);
  activity = newActivity(photoIds?.length ?? state.photos.length);
  let photoCounter = 0;
  void wakeLock.acquire();
  if (!allSitesJobActive) doneSignal.start(photoIds?.length ?? state.photos.length);
  renderActivityBar();
  store.setState({
    batchRunning: true,
    batchProgress: {
      completed: 0,
      total: photoIds?.length ?? state.photos.length,
      currentPhotoId: '',
      currentLabel: 'Starting…',
    },
    statusMessage: 'Running local segmentation…',
  });

  try {
    const result = await runSiteBatch({
      siteId: site.siteId,
      engine,
      ...(photoIds !== undefined ? { photoIds } : {}),
      analysisConfig,
      signal: batchAbortController.signal,
      onProgress: (p) => {
        store.setState({ batchProgress: p });
        if (!allSitesJobActive) doneSignal.progress(p.completed, p.total);
        if (activity && p.total > 0 && activity.photoTotal !== p.total) {
          activity = { ...activity, photoTotal: p.total };
          scheduleActivityRender();
        }
      },
      onPhotoStart: (photo) => {
        photoCounter += 1;
        if (activity) {
          activity = startPhoto(activity, photoCounter, photo.label);
          scheduleActivityRender();
        }
        const nextStatuses = new Map(store.getState().photoStatuses);
        nextStatuses.set(photo.photoId, 'running');
        store.setState({ photoStatuses: nextStatuses });
      },
      onPhotoComplete: (photo, session) => {
        const prev = store.getState();
        const roi = effectiveRoi(prev.photos.find((p) => p.photoId === photo.photoId) ?? photo, prev.siteOptions);
        if (roi) session.setRoiConfig(roi);
        const nextSessions = new Map(prev.sessions);
        nextSessions.set(photo.photoId, session);
        const nextStatuses = new Map(prev.photoStatuses);
        nextStatuses.set(photo.photoId, 'done');
        markSiteChanged(site.siteId);
        const nextErrors = new Map(prev.photoErrors);
        nextErrors.delete(photo.photoId);
        store.setState({
          sessions: nextSessions,
          photoStatuses: nextStatuses,
          photoErrors: nextErrors,
        });
        recomputeReports();
        if (store.getState().activePhotoId === photo.photoId) {
          void syncViewport(false);
        }
      },
      onPhotoError: (photo, err) => {
        const prev = store.getState();
        const nextStatuses = new Map(prev.photoStatuses);
        nextStatuses.set(photo.photoId, 'error');
        const nextErrors = new Map(prev.photoErrors);
        nextErrors.set(photo.photoId, err.message);
        store.setState({
          photoStatuses: nextStatuses,
          photoErrors: nextErrors,
        });
      },
    });

    lastBatchCancelled = result.aborted;
    if (!allSitesJobActive) {
      doneSignal.finish(
        result.aborted,
        `${site.name}: ${result.completed} photo${result.completed === 1 ? '' : 's'} analysed${result.failed > 0 ? `, ${result.failed} failed` : ''}.`,
        notifyWhenDone(),
      );
    }
    const errs = store.getState().photoErrors;
    const firstFailure = result.failedPhotoIds
      .map((id) => errs.get(id))
      .find((m): m is string => typeof m === 'string' && m.length > 0);
    store.setState({
      statusMessage: result.aborted
        ? `Batch cancelled (${result.completed}/${result.total} completed)`
        : `Batch complete: ${result.completed} done, ${result.failed} failed` +
          (firstFailure ? ` — ${firstFailure}` : '') +
          (engine.getWebGpuDisabledReason() !== null
            ? ' · GPU was reset: running on CPU; reload the page to use the GPU again'
            : ''),
    });
  } catch (err) {
    store.setState({
      statusMessage: `Batch error: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    batchAbortController = null;
    store.setState({ batchRunning: false, batchProgress: null });
    activity = null;
    renderActivityBar();
    void wakeLock.release();
    if (!allSitesJobActive) doneSignal.finish(true, '', false); // no-op unless an error ended the job early
    recomputeReports();
    await refreshCapabilities();
    if (!allSitesJobActive) void refreshStorageInfo();
  }
}

async function persistActiveSession(photoId: string, session: AnalysisSession): Promise<void> {
  const owner = store.getState().photos.find((p) => p.photoId === photoId);
  if (owner) markSiteChanged(owner.siteId);
  await savePhotoResult({
    photoId,
    status: 'done',
    serializedSession: session.toSerialized(),
    updatedAt: Date.now(),
  });
}

async function applyCalibrationToActive(
  ptA: Point2D,
  ptB: Point2D,
  lengthVal: number,
  unit: 'mm' | 'cm',
): Promise<void> {
  const state = store.getState();
  const photo = getActivePhoto(state);
  if (!photo) return;
  const cal = ScaleCalibrator.calibrate(ptA, ptB, lengthVal, unit);
  const updatedPhoto: PhotoRecord = { ...photo, calibration: cal };
  await savePhoto(updatedPhoto);

  const session = state.sessions.get(photo.photoId);
  if (session) {
    session.setCalibration(cal);
    await persistActiveSession(photo.photoId, session);
  }

  const photos = state.photos.map((p) => (p.photoId === photo.photoId ? updatedPhoto : p));
  store.setState({
    photos,
    pendingCalibrationPoints: [],
    statusMessage: `Calibrated ${photo.label}: ${cal.mmPerPx.toFixed(4)} mm/px`,
  });
  recomputeReports();
  await syncViewport(false);
}

async function applyRectificationToActive(
  corners: [Point2D, Point2D, Point2D, Point2D],
  physWidthMm: number,
  physHeightMm: number,
): Promise<void> {
  const state = store.getState();
  const photo = getActivePhoto(state);
  if (!photo) return;

  const bmp = await createImageBitmap(photo.imageBlob);
  const off = document.createElement('canvas');
  off.width = bmp.width;
  off.height = bmp.height;
  const ctx = off.getContext('2d');
  if (!ctx) {
    bmp.close();
    return;
  }
  ctx.drawImage(bmp, 0, 0);
  const imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();

  const rectified = rectifyPerspective(
    { data: imgData.data, width: imgData.width, height: imgData.height },
    {
      srcCorners: corners,
      physicalWidthMm: physWidthMm,
      physicalHeightMm: physHeightMm,
      paddingPx: 40,
      maxOutputDimPx: 2048,
    },
  );

  const outCanvas = document.createElement('canvas');
  outCanvas.width = rectified.width;
  outCanvas.height = rectified.height;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) return;
  const outImgData = new ImageData(
    new Uint8ClampedArray(rectified.data),
    rectified.width,
    rectified.height,
  );
  outCtx.putImageData(outImgData, 0, 0);

  const newBlob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode rectified PNG'))),
      'image/png',
    );
  });

  const cal = ScaleCalibrator.calibrate(
    { x: rectified.roiRectInOutput[0], y: rectified.roiRectInOutput[1] },
    {
      x: rectified.roiRectInOutput[0] + rectified.roiRectInOutput[2],
      y: rectified.roiRectInOutput[1],
    },
    physWidthMm,
    'mm',
  );

  const updatedPhoto: PhotoRecord = {
    ...photo,
    imageBlob: newBlob,
    width: rectified.width,
    height: rectified.height,
    calibration: cal,
  };
  await savePhoto(updatedPhoto);
  await savePhotoResult({
    photoId: photo.photoId,
    status: 'pending',
    updatedAt: Date.now(),
  });

  const oldUrl = state.thumbUrls.get(photo.photoId);
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  const nextThumbs = new Map(state.thumbUrls);
  nextThumbs.set(photo.photoId, URL.createObjectURL(newBlob));

  const nextSessions = new Map(state.sessions);
  nextSessions.delete(photo.photoId);
  const nextStatuses = new Map(state.photoStatuses);
  nextStatuses.set(photo.photoId, 'pending');

  store.setState({
    photos: state.photos.map((p) => (p.photoId === photo.photoId ? updatedPhoto : p)),
    thumbUrls: nextThumbs,
    sessions: nextSessions,
    photoStatuses: nextStatuses,
    pendingRectifyPoints: [],
    activeTool: 'inspect',
    statusMessage: `Rectified ${photo.label} (${rectified.width}×${rectified.height}px, ${cal.mmPerPx.toFixed(4)} mm/px). Ready to re-analyze.`,
  });
  recomputeReports();
  await syncViewport(true);
}

// ============================================================================
// UI Renderers
// ============================================================================

function renderTopbar(state: AppState): void {
  const caps = state.capabilities;
  const gpuLabel = engine.getWebGpuDisabledReason() !== null
    ? 'GPU reset · CPU mode (reload for GPU)'
    : caps
    ? caps.hasWebGPU
      ? caps.hasShaderF16 === true
        ? 'WebGPU FP16'
        : caps.hasShaderF16 === false
          ? 'WebGPU (No FP16)'
          : 'WebGPU Ready'
      : `${caps.hasWasmSimd ? 'WASM SIMD' : 'WASM Basic'} · ${
          cpuThreads ?? 1
        } CPU thread${(cpuThreads ?? 1) === 1 ? '' : 's'}`
    : 'Initializing…';
  const swLabel =
    state.swStatus === 'ready'
      ? 'SW Offline Ready'
      : state.swStatus === 'registering'
        ? 'SW Registering'
        : 'SW Local/File';

  // One compact engine chip (details on hover/long-press), plus Offline only when offline.
  const engineShort = engine.getWebGpuDisabledReason() !== null
    ? 'CPU (GPU reset)'
    : caps
      ? caps.hasWebGPU && caps.hasShaderF16 !== false
        ? 'GPU'
        : `CPU · ${cpuThreads ?? 1} thread${(cpuThreads ?? 1) === 1 ? '' : 's'}`
      : 'Starting…';
  const engineTitle = `Engine: ${gpuLabel}. ${swLabel.replace('SW', 'Offline cache:')}. ${state.isOnline ? 'Online' : 'Offline'}.`;
  topbarEl.innerHTML = `
    <div class="topbar-left">
      <div class="brand">
        <span>webGrainy</span>
        <span class="brand-sub">Grain sizes from photos · runs on your device</span>
      </div>
    </div>
    <div class="topbar-center">
      <span class="status-pill ${caps?.hasWebGPU || caps?.hasWasmSimd ? 'ok' : ''}" title="${esc(engineTitle)}">
        <span class="dot" aria-hidden="true"></span>${esc(engineShort)}<span class="sr-only"> — ${esc(engineTitle)}</span>
      </span>
      ${state.isOnline ? '' : `<span class="status-pill warn" title="Analysis still works with models already downloaded."><span class="dot" aria-hidden="true"></span>Offline</span>`}
    </div>
    <div class="topbar-right">
      <button type="button" class="btn btn-sm" data-open-modal="models">Models</button>
      <button type="button" class="btn btn-sm" data-open-modal="export">Export</button>
      <button type="button" class="btn btn-sm" data-open-help="">Help</button>
      <button type="button" class="btn btn-sm" data-open-modal="about">About</button>
    </div>
  `;
}

function renderSidebar(state: AppState): void {
  const activeSite = getActiveSite(state);
  const p = state.analysisParams;
  const pendingCount = state.photos.filter((ph) => {
    const st = state.photoStatuses.get(ph.photoId);
    return !st || st === 'pending' || st === 'error';
  }).length;
  // Settings start collapsed (progressive disclosure); the summary says what is in use.
  const prevDetailsOpen = sidebarEl.querySelector<HTMLDetailsElement>('details.settings-block')?.open ?? false;
  const defaults = defaultAnalysisParams();
  const changedCount = (Object.keys(defaults) as Array<keyof typeof defaults>).filter((k) => p[k] !== defaults[k]).length;
  const modelSummary =
    p.model === 'auto' ? 'Auto model' : p.model === 'unet' ? 'U-Net' : `CP-SAM${p.cpsamWeights === 'auto' ? '' : ` ${p.cpsamWeights.toUpperCase()}`}`;
  const settingsSummary = `${modelSummary} · ${changedCount === 0 ? 'tested defaults' : `${changedCount} setting${changedCount === 1 ? '' : 's'} changed`}`;
  const analysedCount = state.photos.filter((ph) => state.photoStatuses.get(ph.photoId) === 'done').length;
  const prevPhotoScroll = sidebarEl.querySelector('.photo-list')?.scrollTop ?? 0;

  const keptOpenSidebar = captureOpenDetails(sidebarEl);
  const guide = guideHtml(state);
  sidebarEl.innerHTML = `
    ${guide ? `<div class="panel-section">${guide}</div>` : ''}
    <div class="panel-section">
      <div class="panel-header">
        <span class="panel-title">Site</span>
        <div class="row">
          <button type="button" class="btn btn-sm" data-action="rename-site" title="Rename this site" ${activeSite ? '' : 'disabled'}>Rename</button>
          <button type="button" class="btn btn-sm" data-action="new-site" title="Create a new site">+ New</button>

          <button type="button" class="btn btn-sm" data-action="import-archive" title="Open a saved .webgrainy.json project">Open</button>
        </div>
      </div>
      <select class="select" id="site-select" aria-label="Select active field site">
        ${state.sites
          .map(
            (s) =>
              `<option value="${esc(s.siteId)}" ${s.siteId === activeSite?.siteId ? 'selected' : ''}>${esc(s.name)} (${s.photoOrder.length})</option>`,
          )
          .join('')}
      </select>
      ${backupLineHtml(state, analysedCount)}
      ${state.sites.length > 1 ? `<button type="button" class="btn btn-sm" style="margin-top:6px;width:100%;" data-action="analyse-all-sites" title="Analyse every photo that is not analysed yet, in all ${state.sites.length} sites" ${state.batchRunning ? 'disabled' : ''}>Analyse all sites (${state.sites.length})</button>` : ''}
    </div>

    <div class="panel-section">
      <div class="panel-header">
        <span class="panel-title">Photos (${state.photos.length}${analysedCount > 0 ? ` · ${analysedCount} analysed` : ''})</span>
        <div class="row">
          ${
            state.batchRunning
              ? `<button type="button" class="btn btn-sm btn-danger" data-action="cancel-batch">Cancel</button>`
              : pendingCount > 0
                ? `<button type="button" class="btn btn-sm btn-primary" data-action="run-batch">Analyse ${pendingCount === state.photos.length ? (pendingCount === 1 ? 'photo' : `all ${pendingCount}`) : `${pendingCount} new`}</button>`
                : ''
          }
        </div>
      </div>

      <button type="button" class="dropzone" id="photo-dropzone">
        <span class="dropzone-text">${state.photos.length === 0 ? '<strong>Add photos</strong> — tap to choose, or drop them here' : 'Add more photos — tap or drop here'}</span>
        <span style="display:block;font-size:0.65rem;color:var(--text-muted);margin-top:2px;">Photos stay on your device</span>
      </button>


      <div class="photo-list" style="margin-top:8px;">
        ${
          state.photos.length === 0
            ? ''
            : state.photos
                .map((ph) => {
                  const status = state.photoStatuses.get(ph.photoId) ?? 'pending';
                  const sess = state.sessions.get(ph.photoId);
                  const recModel = sess?.recommendation.model;
                  const thumb = state.thumbUrls.get(ph.photoId) ?? '';
                  const isActive = ph.photoId === state.activePhotoId;
                  const errMsg = status === 'error' ? state.photoErrors.get(ph.photoId) ?? 'Analysis failed (no details reported).' : '';
                  return `
                    <div class="photo-item ${isActive ? 'active' : ''}">
                      <input type="checkbox" data-toggle-include="${esc(ph.photoId)}" ${ph.included ? 'checked' : ''} aria-label="Include ${esc(ph.label)} in site aggregate" title="Include in site aggregate" />
                      <button type="button" class="photo-select-btn" data-photo-id="${esc(ph.photoId)}" aria-current="${isActive ? 'true' : 'false'}">
                        <img class="photo-thumb" src="${thumb}" alt="" />
                        <span class="photo-meta">
                          <span class="photo-name" title="${esc(ph.label)}">${esc(ph.label)}</span>
                          <span class="photo-sub">
                            ${ph.width}×${ph.height}${ph.calibration ? ` · ${ph.calibration.mmPerPx.toFixed(3)}mm/px` : ' · uncal'}
                            ${recModel ? ` · ${recModel}` : ''}
                          </span>
                        </span>
                        <span class="badge ${status}"${errMsg ? ` title="${esc(errMsg)}"` : ''}>${status}</span>
                      </button>
                      ${errMsg ? `<div class="photo-error" role="alert">${esc(errMsg)}</div>` : ''}
                      ${
                        state.siteOptions.poolingMode === 'facies-weighted'
                          ? `<label class="photo-facies">Facies weight ${helpButton('faciesWeight')}
                              <input class="input" type="number" step="0.05" min="0" max="100" value="${ph.faciesWeight ?? 1}" data-photo-facies="${esc(ph.photoId)}" aria-label="Facies weight for ${esc(ph.label)}" />
                            </label>`
                          : ''
                      }
                    </div>
                  `;
                })
                .join('')
        }
      </div>
    </div>

    <div class="panel-section">
      <details class="settings-block" ${prevDetailsOpen ? 'open' : ''}>
        <summary>Analysis settings <span class="summary-note">${esc(settingsSummary)}</span></summary>
        <div class="row-between" style="margin-top:6px;">
          <span class="field-hint">The defaults are the tested settings. Changes apply to the next analysis.</span>
          <button type="button" class="btn btn-sm" data-open-help="">Settings help</button>
        </div>
        <div class="grid-2" style="margin-top:8px;">
          <label class="field-label">
            <span class="label-row">Model ${helpButton('model')}</span>
            <select class="select" data-param="model">
              <option value="auto" ${p.model === 'auto' ? 'selected' : ''}>Auto</option>
              <option value="unet" ${p.model === 'unet' ? 'selected' : ''}>U-Net (fast)</option>
              <option value="cpsam" ${p.model === 'cpsam' ? 'selected' : ''}>CP-SAM (accurate)${state.capabilities?.isMobile ? ' – not for phones' : ''}</option>
            </select>
          </label>
          ${
            p.model === 'unet'
              ? ''
              : `<label class="field-label">
            <span class="label-row">CP-SAM weights ${helpButton('cpsamWeights')}</span>
            <select class="select" data-param="cpsamWeights">
              <option value="auto" ${p.cpsamWeights === 'auto' ? 'selected' : ''}>Auto</option>
              <option value="fp16" ${p.cpsamWeights === 'fp16' ? 'selected' : ''}>FP16 (617 MB)</option>
              <option value="int8" ${p.cpsamWeights === 'int8' ? 'selected' : ''}>INT8 (316 MB)</option>
              <option value="fp4" ${p.cpsamWeights === 'fp4' ? 'selected' : ''}>FP4 (183 MB)</option>
            </select>
          </label>`
          }
          <label class="field-label">
            <span class="label-row">Scale Mode ${helpButton('scaleMode')}</span>
            <select class="select" data-param="scaleMode">
              <option value="auto" ${p.scaleMode === 'auto' ? 'selected' : ''}>Auto (≤1024px)</option>
              <option value="1.0x" ${p.scaleMode === '1.0x' ? 'selected' : ''}>1.0x Full</option>
              <option value="0.5x" ${p.scaleMode === '0.5x' ? 'selected' : ''}>0.5x</option>
              <option value="0.25x" ${p.scaleMode === '0.25x' ? 'selected' : ''}>0.25x</option>
            </select>
          </label>
        </div>
        <label class="checkbox-label" style="margin-top:8px;">
          <input type="checkbox" data-param="excludeBorder" ${p.excludeBorder ? 'checked' : ''} /> Exclude border grains ${helpButton('excludeBorder')}
        </label>
        <details class="advanced-block" style="margin-top:8px;" data-keep-open="fine-tuning">
          <summary>Fine-tuning</summary>
          <div class="grid-2" style="margin-top:6px;">
          <label class="field-label">
            <span class="label-row">Flow Threshold ${helpButton('flowThreshold')}</span>
            <input class="input" type="number" step="0.05" min="0.05" max="1" value="${p.flowThreshold}" data-param="flowThreshold" />
          </label>
          <label class="field-label">
            <span class="label-row">Cellprob Thresh ${helpButton('cellprobThreshold')}</span>
            <input class="input" type="number" step="0.1" min="-4" max="4" value="${p.cellprobThreshold}" data-param="cellprobThreshold" />
          </label>
          <label class="field-label">
            <span class="label-row">Min Size (px²) ${helpButton('minSize')}</span>
            <input class="input" type="number" step="1" min="4" max="500" value="${p.minSize}" data-param="minSize" />
          </label>
          <label class="field-label">
            <span class="label-row">Max Area Frac ${helpButton('maxGrainAreaFraction')}</span>
            <input class="input" type="number" step="0.01" min="0.01" max="1" value="${p.maxGrainAreaFraction}" data-param="maxGrainAreaFraction" />
          </label>
          <label class="field-label">
            <span class="label-row">Border margin (px) ${helpButton('excludeBorderMargin')}</span>
            <input class="input" type="number" step="1" min="0" max="100" value="${p.excludeBorderMargin}" data-param="excludeBorderMargin" />
          </label>
          </div>
        </details>
        <details class="advanced-block" style="margin-top:8px;" data-keep-open="advanced-analysis">
          <summary>Advanced (rarely needed)</summary>
          <div class="grid-2" style="margin-top:6px;">
            <label class="field-label">
              <span class="label-row">Flow steps ${helpButton('niter')}</span>
              <input class="input" type="number" step="10" min="50" max="1000" value="${p.niter}" data-param="niter" />
            </label>
            <label class="field-label" style="grid-column: 1 / -1;">
              <span class="label-row">Inference pipeline ${helpButton('inferencePipeline')}</span>
              <select class="select" data-param="inferencePipeline">
                <option value="cellpose" ${p.inferencePipeline === 'cellpose' ? 'selected' : ''}>Cellpose (matches ImageGrains)</option>
                <option value="legacy" ${p.inferencePipeline === 'legacy' ? 'selected' : ''}>Legacy (webGrainy ≤ v1.1)</option>
              </select>
            </label>
            <label class="field-label">
              <span class="label-row">Seed density ${helpButton('minSeedDensity')}</span>
              <input class="input" type="number" step="1" min="1" max="20" value="${p.minSeedDensity}" data-param="minSeedDensity" />
            </label>
          </div>
          ${(() => {
            const cores = logicalCores();
            const auto = wasmThreadsFor('auto');
            const opts = cores === undefined ? [] : Array.from({ length: cores }, (_, i) => i + 1);
            return `<label class="field-label" style="margin-top:6px;">
              <span class="label-row">CPU threads ${helpButton('cpuThreads')}</span>
              <select class="select" data-cpu-threads="">
                <option value="auto" ${cpuThreadPref === 'auto' ? 'selected' : ''}>Auto${auto !== undefined ? ` (${auto} of ${cores})` : ''}</option>
                ${opts.map((n) => `<option value="${n}" ${cpuThreadPref === n ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
              ${self.crossOriginIsolated ? '' : '<span class="field-hint">Multi-threading is unavailable on this page (not cross-origin isolated): the CPU uses 1 thread.</span>'}
            </label>`;
          })()}
          ${
            typeof Notification !== 'undefined'
              ? `<label class="checkbox-label" style="margin-top:6px;">
                  <input type="checkbox" data-notify-done="" ${notifyWhenDone() ? 'checked' : ''} /> Notify me when a long analysis finishes ${helpButton('notifyWhenDone')}
                </label>`
              : ''
          }
          <label class="checkbox-label" style="margin-top:6px;">
            <input type="checkbox" data-param="skipTilesOutsideRoi" ${p.skipTilesOutsideRoi ? 'checked' : ''} /> Skip areas outside the ROI (faster) ${helpButton('skipTilesOutsideRoi')}
          </label>
          <div class="clahe-block" style="margin-top:8px;">
            <label class="checkbox-label">
              <input type="checkbox" data-param="applyClahe" ${p.applyClahe ? 'checked' : ''} /> Apply CLAHE (contrast boost) ${helpButton('applyClahe')}
            </label>
            <span class="field-hint">Not recommended: it lowered accuracy with both models in testing.</span>
            ${
              p.applyClahe
                ? `<label class="field-label" style="margin-top:4px;">
                    <span class="label-row">CLAHE clip ${helpButton('claheClipLimit')}</span>
                    <input class="input" type="number" step="0.5" min="1" max="8" value="${p.claheClipLimit}" data-param="claheClipLimit" />
                  </label>`
                : ''
            }
          </div>
          <span class="field-hint" style="margin-top:6px;">Settings are remembered in this browser for your next visit.</span>
          <button type="button" class="btn btn-sm" data-action="reset-analysis-params" style="margin-top:6px;">Reset analysis settings to defaults</button>
        </details>
        <button type="button" class="btn btn-sm" data-action="run-active" style="margin-top:8px;" ${!state.activePhotoId || state.batchRunning ? 'disabled' : ''} title="Re-analyse the photo shown in the middle with these settings">Re-analyse this photo</button>
      </details>
    </div>
  `;
  restoreOpenDetails(sidebarEl, keptOpenSidebar);

  const photoListEl = sidebarEl.querySelector('.photo-list');
  if (photoListEl && prevPhotoScroll > 0) {
    photoListEl.scrollTop = prevPhotoScroll;
  }
}

function renderToolbarAndOverlays(state: AppState): void {
  const activePhoto = getActivePhoto(state);
  const session = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;

  // Tools grouped by task; grain-editing tools only appear once the photo has results.
  const groups: Array<{ label: string; tools: Array<{ id: EditorToolMode; label: string; title: string }> }> = [
    { label: '', tools: [{ id: 'inspect', label: 'Inspect', title: 'Tap or click a grain to see its measurements' }] },
    {
      label: 'Scale',
      tools: [
        { id: 'calibrate', label: 'Calibrate', title: 'Mark two points a known distance apart (ruler, quadrat) to get sizes in mm' },
        { id: 'rectify', label: 'Rectify', title: 'Correct a photo taken at an angle using four corners of a rectangle' },
      ],
    },
    {
      label: 'Exclude',
      tools: [
        { id: 'excludePoly', label: 'Area', title: 'Draw a polygon around things to leave out (rulers, boots, water)' },
        { id: 'excludeBrush', label: 'Brush', title: 'Paint over things to leave out' },
      ],
    },
    ...(session
      ? [
          {
            label: 'Edit grains',
            tools: [
              { id: 'split' as EditorToolMode, label: 'Split', title: 'Draw a line across a grain to split it in two' },
              { id: 'merge' as EditorToolMode, label: 'Merge', title: 'Select grains that are really one stone, then press Merge' },
              { id: 'delete' as EditorToolMode, label: 'Delete', title: 'Tap or click a wrong outline to remove it' },
              { id: 'addPolygon' as EditorToolMode, label: 'Add', title: 'Draw the outline of a missed grain' },
            ],
          },
        ]
      : []),
  ];

  toolbarEl.innerHTML = `
    ${groups
      .map(
        (g) => `<span class="tool-group" role="group" ${g.label ? `aria-label="${g.label}"` : ''}>${g.label ? `<span class="tool-group-label">${g.label}</span>` : ''}${g.tools
          .map(
            (t) =>
              `<button type="button" class="btn btn-sm ${state.activeTool === t.id ? 'active' : ''}" aria-pressed="${state.activeTool === t.id ? 'true' : 'false'}" data-tool="${t.id}" title="${esc(t.title)}">${t.label}</button>`,
          )
          .join('')}</span>`,
      )
      .join('')}
    ${helpButton('editing')}
    ${
      state.activeTool === 'merge' && state.selectedGrainIds.size >= 2
        ? `<button type="button" class="btn btn-sm btn-primary" data-action="commit-merge">Merge (${state.selectedGrainIds.size})</button>`
        : ''
    }
    ${
      state.activeTool === 'split' || state.activeTool === 'addPolygon' || state.activeTool === 'excludePoly'
        ? `<button type="button" class="btn btn-sm btn-primary" data-action="finish-shape" title="Same as double-click or Enter">Finish shape</button>
           <button type="button" class="btn btn-sm" data-action="cancel-shape" title="Same as Esc">Cancel shape</button>`
        : ''
    }
    <span class="tool-group">
      ${session ? `<button type="button" class="btn btn-sm" data-action="undo" ${session.canUndo ? '' : 'disabled'}>Undo</button>
      <button type="button" class="btn btn-sm" data-action="redo" ${session.canRedo ? '' : 'disabled'}>Redo</button>` : ''}
      <button type="button" class="btn btn-sm" data-action="fit-view" ${activePhoto ? '' : 'disabled'} title="Fit the photo to the view">Fit</button>
    </span>
  `;

  const ov = state.overlays;
  let toolPrompt = '';
  if (state.activeTool === 'calibrate') {
    toolPrompt = `
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span>Calibrate (${state.pendingCalibrationPoints.length}/2 pts):</span>
      <select class="select" id="cal-preset" aria-label="Calibration reference preset" style="width:auto;padding:2px 6px;">
        <option value="100|mm">100 mm Ruler</option>
        <option value="25|mm">25 mm Coin</option>
        <option value="500|mm">500 mm Quadrat</option>
        <option value="custom">Custom…</option>
      </select>
      <input class="input" id="cal-length" type="number" value="100" step="1" min="0.1" aria-label="Calibration length" style="width:65px;padding:2px 6px;" />
      <select class="select" id="cal-unit" aria-label="Calibration unit" style="width:auto;padding:2px 6px;">
        <option value="mm">mm</option>
        <option value="cm">cm</option>
      </select>
      <button type="button" class="btn btn-sm" data-action="copy-scale-all" ${activePhoto?.calibration ? '' : 'disabled'}>Copy Scale to Site</button>
    `;
  } else if (state.activeTool === 'rectify') {
    toolPrompt = `
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span>4-Pt Rectify (${state.pendingRectifyPoints.length}/4 TL→TR→BR→BL):</span>
      <input class="input" id="rect-w" type="number" value="500" step="10" min="10" aria-label="Rectification physical width in mm" style="width:60px;padding:2px 6px;" title="Width (mm)" />×
      <input class="input" id="rect-h" type="number" value="500" step="10" min="10" aria-label="Rectification physical height in mm" style="width:60px;padding:2px 6px;" title="Height (mm)" />mm
    `;
  }

  const keptOpen = captureOpenDetails(subToolbarEl);
  const onCount = [ov.instanceIds, ov.wentworthColors, ov.ellipses, ov.orientations, ov.borderTruncated, ov.loupe].filter(Boolean).length;
  subToolbarEl.innerHTML = `
    <details class="display-menu" data-keep-open="display">
      <summary>Display <span class="summary-note">${onCount} on</span></summary>
      <div class="display-options">
        <label class="checkbox-label"><input type="checkbox" data-ov="instanceIds" ${ov.instanceIds ? 'checked' : ''} /> Grain IDs</label>
        <label class="checkbox-label"><input type="checkbox" data-ov="wentworthColors" ${ov.wentworthColors ? 'checked' : ''} /> Size colours (Wentworth)</label>
        <label class="checkbox-label"><input type="checkbox" data-ov="ellipses" ${ov.ellipses ? 'checked' : ''} /> Ellipses (a/b axes)</label>
        <label class="checkbox-label"><input type="checkbox" data-ov="orientations" ${ov.orientations ? 'checked' : ''} /> Orientation lines</label>
        <label class="checkbox-label"><input type="checkbox" data-ov="borderTruncated" ${ov.borderTruncated ? 'checked' : ''} /> Mark edge/too-small grains</label>
        <label class="checkbox-label"><input type="checkbox" data-ov="loupe" ${ov.loupe ? 'checked' : ''} /> Magnifier (${ov.loupeZoom}×)</label>
        <label class="checkbox-label">Outline opacity <input type="range" min="0" max="1" step="0.05" value="${ov.opacity}" data-ov="opacity" style="width:80px;" /></label>
      </div>
    </details>
    ${toolPrompt}
  `;
  restoreOpenDetails(subToolbarEl, keptOpen);
}

function renderViewportExtras(state: AppState): void {
  const activePhoto = getActivePhoto(state);
  const session = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;
  emptyStateEl.style.display = activePhoto ? 'none' : 'flex';

  const pt = viewport?.getCursorImgPt();
  const zoomPct = viewport ? Math.round(viewport.getZoom() * 100) : 100;
  footerEl.innerHTML = `
    <span>${esc(state.statusMessage)}</span>
    <span>${activePhoto ? `${activePhoto.width}×${activePhoto.height}px | Zoom ${zoomPct}%` : ''}${pt ? ` | (${Math.round(pt.x)}, ${Math.round(pt.y)})` : ''}</span>
  `;

  if (!state.batchRunning) {
    announceStatus(state.statusMessage);
  }

  if (state.inspectedGrainId !== null && session && activePhoto) {
    const grain = session.getResult().grains.find((g) => g.id === state.inspectedGrainId);
    if (grain) {
      const ext = session.getExtendedGrain(grain.id);
      inspectorEl.style.display = 'block';
      inspectorEl.innerHTML = `
        <div class="row-between" style="margin-bottom:4px;">
          <strong>Grain #${grain.id}</strong>${
            session.getRoiFilterResult()?.excludedGrainIds.has(grain.id)
              ? ' <span class="badge warn" title="Outside the ROI or inside an excluded area: not counted in the statistics">not counted</span>'
              : ''
          }
          <button type="button" class="btn btn-sm" data-action="close-inspector" aria-label="Close grain inspector">×</button>
        </div>
        <div style="font-family:var(--font-mono);line-height:1.5;">
          <div title="Minor axis of the moment-equivalent ellipse (not a caliper b-axis)">b (ellipse minor): ${grain.bAxisMm !== undefined ? `${grain.bAxisMm.toFixed(2)} mm` : `${grain.bAxisPx.toFixed(1)} px`}</div>
          <div title="Major axis of the moment-equivalent ellipse">a (ellipse major): ${grain.aAxisMm !== undefined ? `${grain.aAxisMm.toFixed(2)} mm` : `${grain.aAxisPx.toFixed(1)} px`}</div>
          <div>d_eq: ${grain.dEqMm !== undefined ? `${grain.dEqMm.toFixed(2)} mm` : `${grain.dEqPx.toFixed(1)} px`}</div>
          ${
            ext
              ? `<div title="Minimum Feret (rotating-calipers) width of the pixel-edge convex hull">min-Feret: ${ext.minFeretMm !== undefined ? `${ext.minFeretMm.toFixed(2)} mm` : `${ext.minFeretPx.toFixed(1)} px`}</div>
                 <div title="Maximum Feret diameter of the pixel-edge convex hull">max-Feret: ${ext.maxFeretMm !== undefined ? `${ext.maxFeretMm.toFixed(2)} mm` : `${ext.maxFeretPx.toFixed(1)} px`}</div>`
              : ''
          }
          <div>Area: ${grain.areaMm2 !== undefined ? `${grain.areaMm2.toFixed(1)} mm²` : `${grain.areaPx.toFixed(0)} px²`}</div>
          ${
            ext
              ? `<div>Aspect (b/a): ${ext.aspectRatio.toFixed(3)} · Circ: ${ext.circularity.toFixed(3)}</div>
                 <div>Solidity: ${ext.solidity.toFixed(3)} · Ψ₂D: ${ext.sphericity2D.toFixed(3)}</div>`
              : ''
          }
          <div>Border: ${grain.touchesBorder ? 'Yes (excluded)' : 'No'}</div>
        </div>
      `;
      return;
    }
  }
  inspectorEl.style.display = 'none';
}

// ---- Charts: each chart can be downloaded as SVG or PNG (rendered in the light theme) ----
const chartRenderers = new Map<string, { title: string; render: (light: boolean) => string }>();

function chartBox(id: string, title: string, render: (light: boolean) => string, light: boolean): string {
  chartRenderers.set(id, { title, render });
  return `<div class="chart-box" data-chart-id="${esc(id)}">${render(light)}
    <div class="chart-actions">
      <button type="button" class="btn btn-xs" data-chart-dl="${esc(id)}" data-fmt="svg" title="Download as SVG (vector, for reports)" aria-label="Download ${esc(title)} as SVG">SVG</button>
      <button type="button" class="btn btn-xs" data-chart-dl="${esc(id)}" data-fmt="png" title="Download as PNG image" aria-label="Download ${esc(title)} as PNG">PNG</button>
    </div>
  </div>`;
}

/** Saves a dashboard chart (light theme, with provenance metadata) as SVG or PNG. */
async function downloadChart(id: string, format: 'svg' | 'png'): Promise<void> {
  const chart = chartRenderers.get(id);
  if (!chart) return;
  const state = store.getState();
  const site = getActiveSite(state);
  const photo = getActivePhoto(state);
  const isSite = state.dashboardScope === 'site';
  const svg = withSvgMetadata(chart.render(true), {
    ...baseExportMetadata(),
    chart: chart.title,
    scope: isSite ? 'site' : 'photo',
    ...(site ? { siteName: site.name } : {}),
    ...(!isSite && photo ? { photo: photo.label } : {}),
    sizeMetric: state.siteOptions.sizeMetric ?? 'bAxis',
    poolingMode: state.siteOptions.poolingMode,
  });
  const base = [site?.name ?? 'site', !isSite && photo ? photo.label : '', id]
    .filter((s) => s.length > 0)
    .join('_')
    .replace(/[^a-zA-Z0-9_-]+/g, '_');
  try {
    const blob = format === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : await svgToPngBlob(svg, 3);
    triggerBlobDownload(blob, `${base}.${format}`);
  } catch (err) {
    store.setState({ statusMessage: `Could not save the chart: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function scopeButtonsHtml(scope: AppState['dashboardScope']): string {
  const b = (id: AppState['dashboardScope'], label: string, title: string): string =>
    `<button type="button" class="btn btn-sm ${scope === id ? 'active' : ''}" aria-pressed="${scope === id ? 'true' : 'false'}" data-scope="${id}" title="${title}">${label}</button>`;
  return (
    b('photo', 'This photo', 'Results for the photo shown') +
    b('site', 'Whole site', 'Pooled results for all included photos of this site') +
    b('compare', 'Compare sites', 'Overlay and compare the results of several sites')
  );
}

// ---- Compare sites: other sites' saved results are loaded once and cached until the site changes ----
const storedSiteInputsCache = new Map<string, SitePhotoInput[]>();
let comparisonRun = 0;

async function refreshComparison(): Promise<void> {
  const run = ++comparisonRun;
  const state = store.getState();
  const chosen = state.sites.filter((s) => state.compareSiteIds === null || state.compareSiteIds.includes(s.siteId));
  store.setState({ comparison: { loading: true, sites: state.comparison?.sites ?? [], error: null } });
  try {
    const entries: SiteForComparison[] = [];
    for (const site of chosen) {
      let inputs: SitePhotoInput[];
      if (site.siteId === state.activeSiteId) {
        inputs = buildSiteInputs(store.getState());
      } else {
        inputs = storedSiteInputsCache.get(site.siteId) ?? (await loadStoredSiteInputs(site.siteId, state.siteOptions));
        storedSiteInputsCache.set(site.siteId, inputs);
      }
      // Colour by the site's position in the full list, so it does not change with the selection.
      const color = COMPARE_COLORS[state.sites.indexOf(site) % COMPARE_COLORS.length]!;
      entries.push({ siteId: site.siteId, name: site.name, inputs, color });
    }
    if (run !== comparisonRun) return;
    // Same settings for every site, so the comparison is like for like.
    const opts = store.getState();
    const sites = computeComparedSites(
      entries,
      opts.compareInPixels ? { ...opts.siteOptions, unit: 'px' } : opts.siteOptions,
    );
    store.setState({ comparison: { loading: false, sites, error: null } });
  } catch (err) {
    if (run !== comparisonRun) return;
    store.setState({ comparison: { loading: false, sites: [], error: err instanceof Error ? err.message : String(err) } });
  }
}

function renderCompareHtml(state: AppState, lightTheme: boolean): string {
  const cmp = state.comparison;
  const chosen = new Set(state.compareSiteIds ?? state.sites.map((s) => s.siteId));
  const colorOf = new Map((cmp?.sites ?? []).map((s) => [s.siteId, s.color]));
  const picker = state.sites
    .map(
      (s) => `<label class="checkbox-label compare-site">
        <input type="checkbox" data-compare-site="${esc(s.siteId)}" ${chosen.has(s.siteId) ? 'checked' : ''} />
        <span class="swatch" style="background:${colorOf.get(s.siteId) ?? 'transparent'}"></span>${esc(s.name)} <span class="summary-note">(${s.photoOrder.length} photos)</span>
      </label>`,
    )
    .join('');
  const withReport = (cmp?.sites ?? []).filter((s) => s.report !== null);
  const units = new Set(withReport.map((s) => s.report!.unit));
  const mixedUnits = units.size > 1;
  const plotted = mixedUnits ? withReport.filter((s) => s.report!.unit === 'mm') : withReport;
  const unit = (plotted[0]?.report?.unit ?? 'mm') as 'mm' | 'px';
  const step: 0.5 | 1 = state.histogramStepPhi === 0.5 ? 0.5 : 1;
  const v = (n: number | undefined | null, d = 1): string => (n === undefined || n === null || !Number.isFinite(n) ? '—' : n.toFixed(d));
  const table = withReport.length
    ? `<div class="table-scroll"><table class="stats-table compare-table">
        <thead><tr><th>Site</th><th>Photos / grains</th><th>D16</th><th>D50 (95% CI)</th><th>D84</th><th>Dg / σg</th><th>Sauter</th><th>Sorting φ</th><th>Gravel / cobble %</th></tr></thead>
        <tbody>${withReport
          .map((s) => {
            const r = s.report!;
            return `<tr><th scope="row"><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</th>
              <td>${r.includedPhotoCount} / ${r.validGrainCount}</td><td>${v(r.psd.D16)}</td>
              <td>${v(r.psd.D50)} (${v(r.bootstrapCi.lower.D50)}–${v(r.bootstrapCi.upper.D50)})</td><td>${v(r.psd.D84)}</td>
              <td>${v(r.extra?.geometricMean)} / ${v(r.extra?.geometricSd, 2)}</td><td>${v(r.extra?.sauterMeanD32)}</td>
              <td>${v(r.folkWard?.sortingPhi, 2)}</td><td>${r.wentworth ? `${v(r.wentworth.gravelPct, 0)} / ${v(r.wentworth.cobblePct, 0)}` : '—'}</td></tr>`;
          })
          .join('')}</tbody></table></div>
        <p class="field-hint">Sizes in ${unit}. All sites use the same statistics settings (${esc(state.siteOptions.poolingMode)}, ${esc(state.siteOptions.sizeMetric ?? 'bAxis')}).</p>`
    : '';
  const pairs = compareD50(plotted);
  const pairHtml = pairs.length
    ? `<details class="advanced-block" data-keep-open="compare-pairs" open>
        <summary>D50 differences between sites <span class="summary-note">approximate</span></summary>
        <table class="stats-table"><tbody>${pairs
          .map(
            (c) => `<tr><th scope="row">${esc(c.a)} ÷ ${esc(c.b)}<span class="stats-note">${c.p < 0.05 ? 'likely different (p &lt; 0.05)' : 'no clear difference'}</span></th>
              <td>${c.ratio.toFixed(2)}× (${c.ratioLo.toFixed(2)}–${c.ratioHi.toFixed(2)})<br/>p ${c.p < 0.001 ? '&lt; 0.001' : `= ${c.p.toFixed(3)}`}</td></tr>`,
          )
          .join('')}</tbody></table>
        <p class="field-hint">Ratio of D50s with a 95% interval, from each site's bootstrap interval on a log scale (z-test). A screening check, not a formal two-sample test. ${helpButton('compareSites')}</p>
      </details>`
    : '';
  const problems = (cmp?.sites ?? []).filter((s) => s.report === null || (mixedUnits && s.report.unit !== 'mm'));
  const problemHtml = problems.length
    ? `<div class="warning-banner compare-problems">${problems
        .map(
          (s) => `<div class="row-between" style="gap:8px;align-items:flex-start;">
            <span><strong>${esc(s.name)}:</strong> ${esc(s.report === null ? s.error ?? 'no results' : 'not calibrated (sizes in px), so it cannot be plotted with calibrated sites')}</span>
            ${s.siteId !== state.activeSiteId ? `<button type="button" class="btn btn-sm" data-action="open-site" data-site-id="${esc(s.siteId)}" title="Open this site to calibrate or analyse its photos">Open</button>` : ''}
          </div>`,
        )
        .join('')}</div>`
    : '';
  const anyUncalibrated = (cmp?.sites ?? []).some((s) => (s.error ?? '').includes('No scale yet') || s.report?.unit === 'px');
  const pixelsToggle =
    anyUncalibrated || state.compareInPixels
      ? `<label class="checkbox-label" style="margin-top:6px;">
          <input type="checkbox" data-action="toggle-compare-px" ${state.compareInPixels ? 'checked' : ''} />
          Compare in pixels instead of mm <span class="summary-note">only meaningful if all photos were taken with the same camera at the same height</span>
        </label>`
      : '';
  const psdSeries = plotted.map((s) => ({ name: s.name, color: s.color, psd: s.report!.psd, ciLower: s.report!.bootstrapCi.lower, ciUpper: s.report!.bootstrapCi.upper }));
  const histSeries = plotted.map((s) => ({
    name: s.name,
    color: s.color,
    hist: sizeHistogramFromWentworth((step === 0.5 ? s.report!.wentworthHistogram05Phi : s.report!.wentworthHistogram10Phi) ?? [], step),
  }));
  return `
    <div class="panel-section">
      <div class="row-between" style="margin-bottom:6px;">
        <span class="panel-title">Results</span>
        <div class="row">${scopeButtonsHtml('compare')}</div>
      </div>
      <div class="compare-picker">${picker || '<span class="field-hint">Create more sites (Site → + New) to compare them.</span>'}</div>
      ${cmp?.loading ? '<div class="basis-banner">Loading the chosen sites…</div>' : ''}
      ${cmp?.error ? `<div class="warning-banner">${esc(cmp.error)}</div>` : ''}
      ${problemHtml}
      ${pixelsToggle}
      ${table}
      ${
        plotted.length
          ? `<div class="row" style="margin-top:8px;">
              <button type="button" class="btn btn-sm ${state.psdXAxis === 'mm' ? 'active' : ''}" data-psd-x="mm">${unit} (log)</button>
              ${unit === 'mm' ? `<button type="button" class="btn btn-sm ${state.psdXAxis === 'phi' ? 'active' : ''}" data-psd-x="phi">phi (φ)</button>` : ''}
              <button type="button" class="btn btn-sm" data-action="export-comparison" style="margin-left:auto;">Download comparison CSV</button>
            </div>
            ${chartBox('compare-psd', 'Cumulative grain-size distributions by site', (light) => renderComparePsdSvg(psdSeries, unit, state.psdXAxis, light), lightTheme)}
            ${unit === 'mm' ? `<div class="row" style="margin-top:8px;">
              <button type="button" class="btn btn-sm ${step === 0.5 ? 'active' : ''}" data-phi-step="0.5">Narrow classes (0.5 φ)</button>
              <button type="button" class="btn btn-sm ${step === 1 ? 'active' : ''}" data-phi-step="1.0">Wide classes (1 φ)</button>
            </div>
            ${chartBox('compare-size', 'Size distributions by site', (light) => renderCompareSizeHistogramSvg(histSeries, light), lightTheme)}` : ''}
            ${pairHtml}`
          : ''
      }
    </div>`;
}

function renderDashboard(state: AppState): void {
  chartRenderers.clear();
  if (state.dashboardScope === 'compare') {
    const kept = captureOpenDetails(dashboardEl);
    const scroll = dashboardEl.scrollTop;
    dashboardEl.innerHTML = renderCompareHtml(state, isLightColorScheme());
    restoreOpenDetails(dashboardEl, kept);
    dashboardEl.scrollTop = scroll;
    return;
  }
  const report = state.siteReport;
  const single = state.singlePhotoStats;
  const activePhoto = getActivePhoto(state);
  const activeSession = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;
  const isSite = state.dashboardScope === 'site';
  const lightTheme = isLightColorScheme();

  const activeMetric = state.siteOptions.sizeMetric ?? 'bAxis';
  const psd = isSite
    ? report?.psd
    : activeMetric === 'minFeret'
      ? single?.areaWeightedMinFeret ?? single?.areaWeightedB
      : activeMetric === 'dEq'
        ? single?.areaWeightedDEq
        : single?.areaWeightedB;
  const unit = isSite ? (report?.unit ?? 'px') : (single?.unit ?? 'px');
  const fw = isSite ? report?.folkWard : single?.folkWard;
  const basisLabel = isSite
    ? report?.statisticalBasisLabel ??
      (state.siteReportError
        ? `Site statistics unavailable: ${state.siteReportError}`
        : 'Add & analyze photos to compute site statistics')
    : 'Single-Photo Area-Weighted (Grid-by-Number Equivalent)';

  let tabContent = '';
  if (state.dashboardTab === 'psd') {
    const psdSvg = (light: boolean): string => psd
      ? renderPsdChartSvg({
          psd,
          unit,
          xAxis: state.psdXAxis,
          title: isSite ? 'Pooled Site Cumulative PSD' : 'Active Photo Cumulative PSD',
          subtitle: isSite && report ? `${report.includedPhotoCount} photos, n=${report.validGrainCount}` : undefined,
          ciLower: isSite ? report?.bootstrapCi.lower : undefined,
          ciUpper: isSite ? report?.bootstrapCi.upper : undefined,
          perPhotoCurves: isSite ? report?.perPhoto : undefined,
          lightTheme: light,
        })
      : `<svg viewBox="0 0 400 220" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="220" fill="${light ? '#ffffff' : '#0c1014'}"/><text x="200" y="110" text-anchor="middle" fill="${light ? '#4a5568' : '#8fa0b2'}" font-size="12" font-family="system-ui, sans-serif">No segmented grains yet</text></svg>`;

    const step: 0.5 | 1 = state.histogramStepPhi === 0.5 ? 0.5 : 1;
    const sizeHist = isSite
      ? sizeHistogramFromWentworth((step === 0.5 ? report?.wentworthHistogram05Phi : report?.wentworthHistogram10Phi) ?? [], step)
      : activeSession
        ? activeSession.getSizeHistogram(step, activeMetric)
        : sizeHistogramFromWentworth([], step);
    tabContent = `
      <div class="row-between" style="margin-top:8px;">
        <div class="row">
          <button type="button" class="btn btn-sm ${state.psdXAxis === 'mm' ? 'active' : ''}" aria-pressed="${state.psdXAxis === 'mm' ? 'true' : 'false'}" data-psd-x="mm">mm (log₁₀)</button>
          <button type="button" class="btn btn-sm ${state.psdXAxis === 'phi' ? 'active' : ''}" aria-pressed="${state.psdXAxis === 'phi' ? 'true' : 'false'}" data-psd-x="phi">phi (φ)</button>
        </div>
        ${
          isSite && report
            ? `<span style="font-size:0.65rem;color:var(--text-secondary);">${Math.round(report.bootstrapCi.confidenceLevel * 100)}% CI: [${report.bootstrapCi.lower.D50.toFixed(1)}, ${report.bootstrapCi.upper.D50.toFixed(1)}] ${unit}</span>`
            : ''
        }
      </div>
      ${chartBox('cumulative-psd', 'Cumulative grain-size distribution', psdSvg, lightTheme)}
      <div class="row" style="margin-top:8px;">
        <button type="button" class="btn btn-sm ${step === 0.5 ? 'active' : ''}" aria-pressed="${step === 0.5 ? 'true' : 'false'}" data-phi-step="0.5">Narrow classes (${sizeHist.unit === 'mm' ? '0.5 φ' : '×√2'})</button>
        <button type="button" class="btn btn-sm ${step === 1 ? 'active' : ''}" aria-pressed="${step === 1 ? 'true' : 'false'}" data-phi-step="1.0">Wide classes (${sizeHist.unit === 'mm' ? '1 φ' : '×2'})</button>
      </div>
      ${chartBox('size-distribution', 'Grain-size distribution histogram', (light) => renderSizeHistogramSvg(sizeHist, light, isSite ? 'Site Size Distribution (area-weighted %)' : 'Photo Size Distribution (area-weighted %)'), lightTheme)}
      ${
        fw
          ? `<div class="stat-grid" style="margin-top:8px;">
              <div class="stat-card"><div class="stat-label">Folk &amp; Ward Mean</div><div class="stat-value">${fw.meanMm.toFixed(1)} mm</div><div class="stat-sub">${fw.meanPhi.toFixed(2)} φ</div></div>
              <div class="stat-card"><div class="stat-label">Sorting (σ_I)</div><div class="stat-value">${fw.sortingPhi.toFixed(2)} φ</div><div class="stat-sub">${esc(fw.sortingLabel)}</div></div>
              <div class="stat-card"><div class="stat-label">Skew / Kurt</div><div class="stat-value">${fw.skewnessPhi.toFixed(2)}</div><div class="stat-sub">${esc(fw.skewnessLabel)} · K=${fw.kurtosisPhi.toFixed(2)}</div></div>
            </div>`
          : ''
      }
      ${(() => {
        const x = isSite ? report?.extra ?? null : single?.extra ?? null;
        if (!x || x.n === 0) return '';
        const v = (n: number | null, d = 1): string => (n === null || !Number.isFinite(n) ? '—' : n.toFixed(d));
        const row = (label: string, val: string, note: string): string =>
          `<tr><th scope="row">${label}<span class="stats-note">${note}</span></th><td>${val}</td></tr>`;
        return `<details class="advanced-block more-stats" style="margin-top:8px;" data-keep-open="more-stats">
          <summary>More statistics <span class="summary-note">Sauter mean ${v(x.sauterMeanD32)} ${unit} · Dg ${v(x.geometricMean)} ${unit}</span></summary>
          <table class="stats-table">
            <tbody>
              ${row('Sauter mean D[3,2]', `${v(x.sauterMeanD32)} ${unit}`, 'Σd³/Σd², each grain once; = area-weighted mean size')}
              ${row('De Brouckère mean D[4,3]', `${v(x.deBrouckereMeanD43)} ${unit}`, 'Σd⁴/Σd³, each grain once')}
              ${row('Arithmetic mean D[1,0]', `${v(x.arithmeticMeanD10)} ${unit}`, 'each grain once')}
              ${row('Geometric mean Dg', `${v(x.geometricMean)} ${unit}`, 'same weighting as the PSD')}
              ${row('Geometric SD σg', v(x.geometricSd, 2), '1 = uniform; larger = wider spread')}
              ${row('D30 / D60 / D65', `${v(x.D30)} / ${v(x.D60)} / ${v(x.D65)} ${unit}`, 'D65: Einstein roughness')}
              ${row('Uniformity Cu', v(x.uniformityCu, 2), 'D60/D10')}
              ${row('Curvature Cc', v(x.curvatureCc, 2), 'D30²/(D10·D60)')}
              ${row('Trask sorting So', v(x.traskSorting, 2), '√(D75/D25)')}
              ${row('Span', v(x.span, 2), '(D90−D10)/D50')}
              ${row('Fredle index', v(x.fredleIndex, 1), 'Dg/So (spawning-gravel quality)')}
              ${
                x.momentMeanPhi !== null
                  ? row('Moments (φ)', `${v(x.momentMeanPhi, 2)} / ${v(x.momentSortingPhi, 2)} / ${v(x.momentSkewness, 2)} / ${v(x.momentKurtosis, 2)}`, 'mean / sorting / skewness / kurtosis (method of moments)')
                  : ''
              }
            </tbody>
          </table>
          <p class="field-hint">Included in the summary CSV and JSON exports. ${helpButton('moreStats')}</p>
        </details>`;
      })()}
    `;
  } else if (state.dashboardTab === 'adequacy') {
    const adeq = report?.adequacy;

    tabContent = `
      ${
        adeq
          ? `<div class="stat-grid" style="margin-top:8px;">
              <div class="stat-card"><div class="stat-label">Adequacy</div><div class="stat-value">${esc(adeq.rating)}</div><div class="stat-sub">n_eff = ${Math.round(adeq.effectiveGrainCount)} (100/200/400)</div></div>
              <div class="stat-card"><div class="stat-label">Max Clast Ratio</div><div class="stat-value">${(adeq.largestClastAreaRatio * 100).toFixed(1)}%</div><div class="stat-sub">${adeq.largestClastWarning === 'none' ? 'OK (<5%)' : esc(adeq.largestClastWarning.toUpperCase())}</div></div>
              <div class="stat-card"><div class="stat-label">Cutoff (mm)</div><div class="stat-value">${report?.dCutoffCommonMm !== null && report?.dCutoffCommonMm !== undefined ? report.dCutoffCommonMm.toFixed(2) : '—'}</div><div class="stat-sub">${report?.excludedTruncationCount ?? 0} trunc excl</div></div>
            </div>`
          : ''
      }
      ${chartBox('convergence', 'D50 convergence with number of photos', (light) => renderConvergenceChartSvg(report?.convergence ?? [], light), lightTheme)}
      ${chartBox('jackknife', 'Leave-one-photo-out influence on D50', (light) => renderJackknifeChartSvg(report?.jackknife ?? null, light), lightTheme)}
    `;
  } else if (state.dashboardTab === 'shape') {
    // Cached on the session (recomputed only when its results change).
    // Same grains as the statistics (inside the ROI, border rule applied), so n matches.
    const ratios = activeSession ? activeSession.getExtendedStatsGrains().map((g) => g.aspectRatio) : [];
    const arCounts = aspectRatioCounts(ratios, 10);
    const packingInfo = activeSession ? activeSession.getRoiFilterResult() : null;

    tabContent = `
      ${
        packingInfo
          ? `<div class="basis-banner" style="margin-top:8px;">Clast packing: ${packingInfo.clastPackingPct.toFixed(1)}% · Exposed matrix: ${packingInfo.exposedMatrixPct.toFixed(1)}% (inside the ROI)</div>`
          : ''
      }
      ${chartBox('aspect-ratio', 'Aspect ratio (b/a) distribution', (light) => renderAspectRatioHistogramSvg(arCounts, light), lightTheme)}
      <p class="field-hint">Grain shape for this photo. The size distribution is on the PSD tab.</p>
    `;
  } else {
    const rose =
      isSite && report
        ? report.fabricRose
        : activeSession
          ? activeSession.getFabricRose()
          : computeFabricRoseStats([], { weighted: true, binCount: 12 });
    tabContent = `
      ${chartBox('fabric-rose', 'Grain orientation (fabric) rose', (light) => renderFabricRoseSvg(rose, light), lightTheme)}
      ${
        rose.grainCount > 0
          ? `<div class="stat-grid" style="margin-top:8px;">
              <div class="stat-card"><div class="stat-label">Mean orientation</div><div class="stat-value">${rose.meanAxialDeg.toFixed(0)}°</div><div class="stat-sub">0° = up–down in the photo</div></div>
              <div class="stat-card"><div class="stat-label">Alignment (R)</div><div class="stat-value">${rose.resultantLength.toFixed(2)}</div><div class="stat-sub">0 = random, 1 = all parallel</div></div>
              <div class="stat-card"><div class="stat-label">Rayleigh p</div><div class="stat-value">${rose.rayleighP === null ? '—' : rose.rayleighP < 0.001 ? '&lt;0.001' : rose.rayleighP.toFixed(3)}</div><div class="stat-sub">${rose.rayleighP !== null && rose.rayleighP < 0.05 ? 'preferred direction' : 'no clear direction'} · n = ${rose.grainCount}</div></div>
            </div>`
          : ''
      }
      <div class="basis-banner">
        Axial 180° double-angle statistics (Curray 1956; Mardia &amp; Jupp 2000). 0° = Image Vertical (Top/Bottom), 90° = Image Horizontal.
      </div>
    `;
  }

  const prevDashScroll = dashboardEl.scrollTop;

  const metricNoteText =
    activeMetric === 'minFeret'
      ? 'Size metric: minimum Feret (rotating-calipers) width of the pixel-edge convex hull — closest 2D analogue of a caliper b-axis.'
      : activeMetric === 'dEq'
        ? "Size metric: equal-area circle diameter (d_eq = sqrt(4*Area/pi)) of each grain's visible 2D outline."
        : "Size metric: minor axis of the moment-equivalent ellipse of each grain's visible outline — not a sieve or caliper b-axis.";

  const keptOpenDashboard = captureOpenDetails(dashboardEl);
  dashboardEl.innerHTML = `
    <div class="panel-section">
      <div class="row-between" style="margin-bottom:6px;">
        <span class="panel-title">Results</span>
        <div class="row">
          ${scopeButtonsHtml(state.dashboardScope)}
        </div>
      </div>
      <div class="basis-banner">${esc(basisLabel)}${
        !isSite && single
          ? ` · n = ${single.includedGrains}${activeSession && activeSession.getRoiExcludedGrainCount() > 0 ? ` (${activeSession.getRoiExcludedGrainCount()} excluded by ROI)` : ''}`
          : ''
      }</div>
      ${(() => {
        const warns = [...(isSite ? report?.warnings ?? [] : single?.warnings ?? [])];
        // ROI enlarged after an analysis that skipped tiles outside the old ROI.
        const stale = (isSite ? state.photos.filter((p) => p.included) : activePhoto ? [activePhoto] : [])
          .map((p) => ({ p, f: state.sessions.get(p.photoId)?.getUnanalysedRoiFraction() ?? 0 }))
          .filter((x) => x.f > 0.001);
        if (stale.length > 0) {
          warns.unshift(
            isSite
              ? `${stale.length} photo(s) have ROI areas that were not analysed (the ROI was enlarged or an exclusion removed after analysis): ${stale.map((x) => x.p.label).join(', ')}. Re-analyse them.`
              : `${(stale[0]!.f * 100).toFixed(1)}% of this photo's ROI was not analysed (the ROI was enlarged or an exclusion removed after analysis). Re-analyse this photo to include it.`,
          );
        }
        return warns.length > 0
          ? `<div class="warning-banner" role="alert">${warns.map(esc).join('<br/>')}</div>`
          : '';
      })()}
      ${(() => {
        if (isSite || !activeSession || !activePhoto) return '';
        const hint = activeSession.getFineGrainHint();
        if (hint.enlarged !== null) {
          return `<div class="basis-banner row-between" style="gap:8px;">
            <span>Analysed enlarged ×${hint.enlarged} for fine grains.</span>
            <button type="button" class="btn btn-sm" data-action="fine-grain-undo" ${state.batchRunning ? 'disabled' : ''}>Undo</button>
          </div>`;
        }
        if (!hint.suggest) return '';
        return `<div class="info-banner">
          <strong>Fine grains detected</strong> (median about ${hint.medianWorkingBPx!.toFixed(0)} px). U-Net finds more of them if the photo is enlarged ×1.5 first: in testing on 40 photos this gave better outlines with no site getting worse, and takes about 20–50% longer. ${helpButton('fineGrainUpscale')}
          <div style="margin-top:6px;"><button type="button" class="btn btn-sm btn-primary" data-action="fine-grain-rerun" ${state.batchRunning ? 'disabled' : ''}>Re-analyse enlarged ×1.5</button></div>
        </div>`;
      })()}
      <div class="stat-grid" style="margin-top:8px;">
        <div class="stat-card"><div class="stat-label">D<sub>16</sub></div><div class="stat-value">${psd ? psd.D16.toFixed(1) : '—'}</div><div class="stat-sub">${unit}</div></div>
        <div class="stat-card"><div class="stat-label">D<sub>50</sub> (median)</div><div class="stat-value">${psd ? psd.D50.toFixed(1) : '—'}</div><div class="stat-sub">${unit}</div></div>
        <div class="stat-card"><div class="stat-label">D<sub>84</sub></div><div class="stat-value">${psd ? psd.D84.toFixed(1) : '—'}</div><div class="stat-sub">${unit}</div></div>
      </div>
      <p class="metric-note">${esc(metricNoteText)}</p>
      <details class="advanced-block stats-settings" style="margin-top:8px;" data-keep-open="stats-settings">
        <summary>Statistics settings <span class="summary-note">${({ 'physical-area': 'area-weighted', 'equal-photo': 'equal-photo', 'virtual-wolman-grid': 'Wolman grid', 'number-weighted': 'number-weighted', 'facies-weighted': 'facies-weighted' } as Record<string, string>)[state.siteOptions.poolingMode] ?? state.siteOptions.poolingMode} · ${activeMetric === 'bAxis' ? 'b-axis' : activeMetric}</span></summary>
        <div style="margin-top:6px;">
      <div class="grid-2">
        <label class="field-label">
          <span class="label-row">Pooling Mode ${helpButton('poolingMode')}</span>
          <select class="select" data-site-opt="poolingMode">
            <option value="physical-area" ${state.siteOptions.poolingMode === 'physical-area' ? 'selected' : ''}>Physical Area-Weighted</option>
            <option value="equal-photo" ${state.siteOptions.poolingMode === 'equal-photo' ? 'selected' : ''}>Equal-Photo Weighted</option>
            <option value="virtual-wolman-grid" ${state.siteOptions.poolingMode === 'virtual-wolman-grid' ? 'selected' : ''}>Virtual Wolman Grid</option>
            <option value="number-weighted" ${state.siteOptions.poolingMode === 'number-weighted' ? 'selected' : ''}>Number-Weighted</option>
            <option value="facies-weighted" ${state.siteOptions.poolingMode === 'facies-weighted' ? 'selected' : ''}>Facies-Weighted</option>
          </select>
        </label>
        <label class="field-label">
          <span class="label-row">Size Metric ${helpButton('sizeMetric')}</span>
          <select class="select" data-site-opt="sizeMetric">
            <option value="bAxis" ${activeMetric === 'bAxis' ? 'selected' : ''}>b-axis (ellipse minor)</option>
            <option value="minFeret" ${activeMetric === 'minFeret' ? 'selected' : ''}>min-Feret (caliper width)</option>
            <option value="dEq" ${activeMetric === 'dEq' ? 'selected' : ''}>d_eq (equal-area circle)</option>
          </select>
        </label>
        <label class="field-label">
          <span class="label-row">Field-count cutoff (mm) ${helpButton('minSizeMm')}</span>
          <input class="input" type="number" step="0.5" min="0" max="256" value="${state.siteOptions.minSizeMm ?? 0}" data-site-opt="minSizeMm" />
        </label>
        <label class="field-label">
          <span class="label-row">Min b-axis (px) ${helpButton('minBaxisPx')}</span>
          <input class="input" type="number" step="1" min="0" max="50" value="${state.siteOptions.minBaxisPx ?? 15}" data-site-opt="minBaxisPx" />
        </label>
        <label class="field-label">
          <span class="label-row">Exclusion overlap ${helpButton('maxExcludedFraction')}</span>
          <input class="input" type="number" step="0.05" min="0" max="1" value="${state.siteOptions.maxExcludedFraction ?? 0.1}" data-site-opt="maxExcludedFraction" />
        </label>
      </div>
      <div style="margin-top:6px;">
        <label class="checkbox-label">
          <input type="checkbox" data-site-opt="harmonizePhysicalCutoff" ${state.siteOptions.harmonizePhysicalCutoff !== false ? 'checked' : ''} /> Harmonize Cutoff ${helpButton('harmonizePhysicalCutoff')}
        </label>
      </div>
      <details class="advanced-block" style="margin-top:6px;" data-keep-open="uncertainty">
        <summary>Uncertainty &amp; sampling</summary>
        <div class="grid-2" style="margin-top:6px;">
          <label class="field-label">
            <span class="label-row">Confidence level ${helpButton('confidenceLevel')}</span>
            <select class="select" data-site-opt="confidenceLevel" data-numeric="true">
              <option value="0.95" ${(state.siteOptions.confidenceLevel ?? 0.95) === 0.95 ? 'selected' : ''}>95%</option>
              <option value="0.9" ${state.siteOptions.confidenceLevel === 0.9 ? 'selected' : ''}>90%</option>
            </select>
          </label>
          <label class="field-label">
            <span class="label-row">Bootstrap repeats ${helpButton('bootstrapReplicates')}</span>
            <input class="input" type="number" step="50" min="50" max="5000" value="${state.siteOptions.bootstrapReplicates ?? 500}" data-site-opt="bootstrapReplicates" />
          </label>
          <label class="field-label">
            <span class="label-row">Bootstrap seed ${helpButton('bootstrapSeed')}</span>
            <input class="input" type="number" step="1" min="0" max="2147483647" value="${state.siteOptions.bootstrapSeed ?? 42}" data-site-opt="bootstrapSeed" />
          </label>
          <label class="field-label">
            <span class="label-row">Virtual Wolman points ${helpButton('wolmanPointsPerPhoto')}</span>
            <input class="input" type="number" step="10" min="10" max="2000" value="${state.siteOptions.wolmanPointsPerPhoto ?? 100}" data-site-opt="wolmanPointsPerPhoto" />
          </label>
        </div>
        <label class="checkbox-label" style="margin-top:6px;">
          <input type="checkbox" data-site-opt="bootstrapTwoStage" ${state.siteOptions.bootstrapTwoStage ? 'checked' : ''} /> Two-stage bootstrap ${helpButton('bootstrapTwoStage')}
        </label>
      </details>
        </div>
      </details>
    </div>

    <div class="tabs" role="tablist" aria-label="Dashboard analyses">
      ${(['psd', 'adequacy', 'shape', 'fabric'] as DashboardTab[])
        .map((tab) => {
          const selected = state.dashboardTab === tab;
          const label =
            tab === 'psd'
              ? 'PSD'
              : tab === 'adequacy'
                ? 'Adequacy'
                : tab === 'shape'
                  ? 'Shape'
                  : 'Fabric';
          return `<button type="button" class="tab-btn" role="tab" id="tab-${tab}" aria-selected="${selected ? 'true' : 'false'}" aria-controls="dashboard-tabpanel" tabindex="${selected ? '0' : '-1'}" data-tab="${tab}">${label}</button>`;
        })
        .join('')}
    </div>

    <div class="panel-section" id="dashboard-tabpanel" role="tabpanel" aria-labelledby="tab-${state.dashboardTab}" style="border-bottom:none;">
      ${tabContent}
    </div>
  `;
  restoreOpenDetails(dashboardEl, keptOpenDashboard);

  dashboardEl.scrollTop = prevDashScroll;
}

function renderModals(state: AppState): void {
  if (!appDialogEl) return;
  if (state.activeModal === 'models') {
    appDialogEl.innerHTML = renderModelsModalHtml(state, cachedQuota);
  } else if (state.activeModal === 'export') {
    appDialogEl.innerHTML = renderExportModalHtml(state);
  } else if (state.activeModal === 'about') {
    appDialogEl.innerHTML = renderAboutModalHtml();
  } else if (state.activeModal === 'help') {
    appDialogEl.innerHTML = renderHelpModalHtml(state.helpTopic);
  } else {
    if (appDialogEl.open) {
      appDialogEl.close();
    }
    appDialogEl.innerHTML = '';
    return;
  }

  if (!appDialogEl.open) {
    appDialogEl.showModal();
  }
}

let prevRenderState: AppState | null = null;

function notifyWhenDone(): boolean {
  return readFlag(NOTIFY_PREF_KEY) && typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

/** "Last backed up" line with a Back up now button, and the browser storage status. */
function backupLineHtml(state: AppState, analysedCount: number): string {
  const site = getActiveSite(state);
  if (!site) return '';
  const status = backupStatus(readBackupRecords()[site.siteId], analysedCount > 0);
  const storage = storageInfo
    ? `<span class="field-hint">Browser storage: ${formatBytes(storageInfo.usage)} used${storageInfo.quota > 0 ? ` of ${formatBytes(storageInfo.quota)}` : ''} · ${
        storageInfo.persisted ? 'protected from automatic clearing' : 'the browser may clear it if space runs low'
      } ${helpButton('backup')}</span>`
    : '';
  if (analysedCount === 0 && status.backedUpAt === null) return storage ? `<div class="backup-line">${storage}</div>` : '';
  return `<div class="backup-line ${status.needsBackup ? 'needs-backup' : ''}">
    <div class="row" style="justify-content:space-between;gap:6px;">
      <span>${status.needsBackup ? '⚠ ' : ''}Last backed up: ${esc(status.ago)}${status.needsBackup && status.backedUpAt !== null ? ' (changed since)' : ''}</span>
      <button type="button" class="btn btn-sm ${status.needsBackup ? 'btn-primary' : ''}" data-export="site-archive" title="Save this site (photos and results) as a .webgrainy.json project file">Back up now</button>
    </div>
    ${status.needsBackup ? '<span class="field-hint">Your work is stored only in this browser. Save a project file to keep it safe or move it to another computer.</span>' : ''}
    ${storage}
  </div>`;
}

function renderAll(state: AppState): void {
  const prev = prevRenderState;
  prevRenderState = state;

  if (
    !prev ||
    prev.capabilities !== state.capabilities ||
    prev.isOnline !== state.isOnline ||
    prev.swStatus !== state.swStatus
  ) {
    renderTopbar(state);
  }

  if (
    !prev ||
    prev.sites !== state.sites ||
    prev.activeSiteId !== state.activeSiteId ||
    prev.photos !== state.photos ||
    prev.activePhotoId !== state.activePhotoId ||
    prev.photoStatuses !== state.photoStatuses ||
    prev.sessions !== state.sessions ||
    prev.thumbUrls !== state.thumbUrls ||
    prev.batchRunning !== state.batchRunning ||
    prev.batchProgress !== state.batchProgress ||
    prev.analysisParams !== state.analysisParams ||
    prev.photoErrors !== state.photoErrors ||
    prev.siteOptions.poolingMode !== state.siteOptions.poolingMode
  ) {
    renderSidebar(state);
  }

  if (
    !prev ||
    prev.activePhotoId !== state.activePhotoId ||
    prev.activeTool !== state.activeTool ||
    prev.overlays !== state.overlays ||
    prev.selectedGrainIds !== state.selectedGrainIds ||
    prev.pendingCalibrationPoints !== state.pendingCalibrationPoints ||
    prev.pendingRectifyPoints !== state.pendingRectifyPoints ||
    prev.sessions !== state.sessions ||
    prev.photos !== state.photos ||
    prev.siteReport !== state.siteReport ||
    prev.siteReportError !== state.siteReportError ||
    prev.singlePhotoStats !== state.singlePhotoStats
  ) {
    renderToolbarAndOverlays(state);
  }

  renderViewportExtras(state);

  if (
    !prev ||
    prev.siteReport !== state.siteReport ||
    prev.siteReportError !== state.siteReportError ||
    prev.singlePhotoStats !== state.singlePhotoStats ||
    prev.dashboardScope !== state.dashboardScope ||
    prev.batchRunning !== state.batchRunning ||
    prev.comparison !== state.comparison ||
    prev.compareSiteIds !== state.compareSiteIds ||
    prev.sites !== state.sites ||
    prev.dashboardTab !== state.dashboardTab ||
    prev.psdXAxis !== state.psdXAxis ||
    prev.histogramStepPhi !== state.histogramStepPhi ||
    prev.siteOptions !== state.siteOptions ||
    prev.activePhotoId !== state.activePhotoId ||
    prev.sessions !== state.sessions ||
    prev.photos !== state.photos
  ) {
    renderDashboard(state);
  }

  if (
    !prev ||
    prev.activeModal !== state.activeModal ||
    prev.helpTopic !== state.helpTopic ||
    (state.activeModal === 'models' &&
      (prev.modelDownloads !== state.modelDownloads || prev.capabilities !== state.capabilities)) ||
    (state.activeModal === 'export' &&
      (prev.siteReport !== state.siteReport ||
        prev.activeSiteId !== state.activeSiteId ||
        prev.activePhotoId !== state.activePhotoId ||
        prev.sessions !== state.sessions))
  ) {
    renderModals(state);
  }
}

// ============================================================================
// Bootstrap & Event Delegation
// ============================================================================

function mountShell(): void {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <header class="topbar" id="topbar"></header>
    <main class="workspace">
      <aside class="sidebar-left" id="sidebar-left" aria-label="Site and Photo Workspace"></aside>
      <section class="viewport-center" aria-label="Grain Inspection Viewport">
        <div class="toolbar" id="toolbar"></div>
        <div class="sub-toolbar" id="sub-toolbar"></div>
        <div class="canvas-stage" id="canvas-stage" tabindex="0" role="region" aria-label="Grain segmentation canvas. Use arrow keys to pan, plus or minus to zoom, 0 to fit.">
          <canvas class="canvas-layer" id="base-canvas"></canvas>
          <canvas class="canvas-layer" id="mask-canvas"></canvas>
          <svg class="svg-overlay" id="svg-overlay"></svg>
          <canvas class="loupe-canvas" id="loupe-canvas"></canvas>
          <div class="viewport-empty" id="viewport-empty">
            <div class="empty-title">Measure grain sizes from photos of gravel</div>
            <div>Add photos to start. Everything runs in your browser; nothing is uploaded.</div>
            <button type="button" class="btn btn-primary empty-cta" data-action="add-photos">Add photos</button>
            <div class="empty-hint">Or drop photos anywhere on the left panel. Zoom: pinch or mouse wheel · Move: two fingers, Space+drag or middle mouse.</div>
          </div>
          <div class="inspector-card" id="inspector-card" style="display:none;"></div>
        </div>
        <div class="viewport-footer" id="viewport-footer"></div>
      </section>
      <aside class="dashboard-right" id="dashboard-right" aria-label="Scientific Dashboard"></aside>
    </main>
    <div class="activity-bar" id="activity-bar" role="status" aria-live="polite" hidden></div>
    <dialog id="app-dialog" class="app-dialog" closedby="any" aria-labelledby="dialog-title"></dialog>
    <div id="sr-announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>
    <input type="file" id="photo-file-input" accept="image/*" multiple style="display:none;" />
    <input type="file" id="archive-file-input" accept=".json,.webgrainy.json" style="display:none;" />
  `;

  topbarEl = document.getElementById('topbar')!;
  sidebarEl = document.getElementById('sidebar-left')!;
  toolbarEl = document.getElementById('toolbar')!;
  subToolbarEl = document.getElementById('sub-toolbar')!;
  footerEl = document.getElementById('viewport-footer')!;
  inspectorEl = document.getElementById('inspector-card')!;
  emptyStateEl = document.getElementById('viewport-empty')!;
  dashboardEl = document.getElementById('dashboard-right')!;
  appDialogEl = document.getElementById('app-dialog') as HTMLDialogElement;
  srAnnouncerEl = document.getElementById('sr-announcer')!;
  fileInputEl = document.getElementById('photo-file-input') as HTMLInputElement;
  archiveInputEl = document.getElementById('archive-file-input') as HTMLInputElement;

  appDialogEl.addEventListener('close', () => {
    if (store.getState().activeModal !== null) {
      store.setState({ activeModal: null });
    }
  });

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    let pointerDownOutside = false;
    appDialogEl.addEventListener('pointerdown', (e) => {
      if (e.target !== appDialogEl) {
        pointerDownOutside = false;
        return;
      }
      const r = appDialogEl.getBoundingClientRect();
      pointerDownOutside =
        e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    });
    appDialogEl.addEventListener('pointerup', (e) => {
      if (!pointerDownOutside || e.target !== appDialogEl) {
        pointerDownOutside = false;
        return;
      }
      pointerDownOutside = false;
      const r = appDialogEl.getBoundingClientRect();
      const stillOutside =
        e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (stillOutside && appDialogEl.open) {
        appDialogEl.close();
      }
    });
  }

  viewport = new CanvasViewport(
    document.getElementById('canvas-stage')!,
    document.getElementById('base-canvas') as HTMLCanvasElement,
    document.getElementById('mask-canvas') as HTMLCanvasElement,
    document.getElementById('svg-overlay') as unknown as SVGSVGElement,
    document.getElementById('loupe-canvas') as HTMLCanvasElement,
    {
      onInspectGrain: (grainId) => {
        store.setState({ inspectedGrainId: grainId });
        void syncViewport(false);
      },
      onToggleSelectGrain: (grainId) => {
        const next = new Set(store.getState().selectedGrainIds);
        if (next.has(grainId)) next.delete(grainId);
        else next.add(grainId);
        store.setState({ selectedGrainIds: next });
        void syncViewport(false);
      },
      onSplitLine: (grainId, points) => {
        const state = store.getState();
        const photo = getActivePhoto(state);
        const session = photo ? state.sessions.get(photo.photoId) : null;
        if (!photo || !session) return;
        const ok = session.splitGrain(grainId, points);
        if (ok) {
          void persistActiveSession(photo.photoId, session);
          recomputeReports();
          viewport?.markMasksDirty();
        }
      },
      onDeleteGrain: (grainId) => {
        const state = store.getState();
        const photo = getActivePhoto(state);
        const session = photo ? state.sessions.get(photo.photoId) : null;
        if (!photo || !session) return;
        if (session.deleteGrain(grainId)) {
          void persistActiveSession(photo.photoId, session);
          recomputeReports();
          viewport?.markMasksDirty();
        }
      },
      onAddPolygon: (points) => {
        const state = store.getState();
        const photo = getActivePhoto(state);
        const session = photo ? state.sessions.get(photo.photoId) : null;
        if (!photo || !session) return;
        if (session.addPolygonGrain(points) > 0) {
          void persistActiveSession(photo.photoId, session);
          recomputeReports();
          viewport?.markMasksDirty();
        }
      },
      onAddExclusionPolygon: (points) => {
        const state = store.getState();
        const photo = getActivePhoto(state);
        if (!photo) return;
        const prev = photo.roiConfig ?? { exclusionPolygons: [], exclusionStrokes: [] };
        const updated: PhotoRecord = {
          ...photo,
          roiConfig: {
            ...prev,
            exclusionPolygons: [...prev.exclusionPolygons, points],
          },
        };
        if (updated.roiConfig) state.sessions.get(photo.photoId)?.setRoiConfig(effectiveRoi(updated, state.siteOptions));
        void savePhoto(updated);
        store.setState({
          photos: state.photos.map((p) => (p.photoId === photo.photoId ? updated : p)),
        });
        recomputeReports();
        void syncViewport(false);
      },
      onAddExclusionStroke: (points, radiusPx) => {
        const state = store.getState();
        const photo = getActivePhoto(state);
        if (!photo) return;
        const prev = photo.roiConfig ?? { exclusionPolygons: [], exclusionStrokes: [] };
        const updated: PhotoRecord = {
          ...photo,
          roiConfig: {
            ...prev,
            exclusionStrokes: [...prev.exclusionStrokes, { points, radiusPx }],
          },
        };
        if (updated.roiConfig) state.sessions.get(photo.photoId)?.setRoiConfig(effectiveRoi(updated, state.siteOptions));
        void savePhoto(updated);
        store.setState({
          photos: state.photos.map((p) => (p.photoId === photo.photoId ? updated : p)),
        });
        recomputeReports();
        void syncViewport(false);
      },
      onCalibrationPoint: (pt) => {
        const prev = store.getState().pendingCalibrationPoints;
        const next = prev.length >= 2 ? [pt] : [...prev, pt];
        store.setState({ pendingCalibrationPoints: next });
        if (next.length === 2) {
          const lenEl = document.getElementById('cal-length') as HTMLInputElement | null;
          const unitEl = document.getElementById('cal-unit') as HTMLSelectElement | null;
          const lenVal = Math.max(0.1, Number(lenEl?.value ?? 100));
          const unit = (unitEl?.value === 'cm' ? 'cm' : 'mm') as 'mm' | 'cm';
          void applyCalibrationToActive(next[0]!, next[1]!, lenVal, unit);
        } else {
          void syncViewport(false);
        }
      },
      onRectifyPoint: (pt) => {
        const prev = store.getState().pendingRectifyPoints;
        const next = prev.length >= 4 ? [pt] : [...prev, pt];
        store.setState({ pendingRectifyPoints: next });
        if (next.length === 4) {
          const wEl = document.getElementById('rect-w') as HTMLInputElement | null;
          const hEl = document.getElementById('rect-h') as HTMLInputElement | null;
          const pw = Math.max(10, Number(wEl?.value ?? 500));
          const ph = Math.max(10, Number(hEl?.value ?? 500));
          void applyRectificationToActive(
            [next[0]!, next[1]!, next[2]!, next[3]!],
            pw,
            ph,
          );
        } else {
          void syncViewport(false);
        }
      },
    },
  );
}

function attachDelegatedHandlers(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const helpBtn = target.closest<HTMLElement>('[data-help], [data-open-help]');
    if (helpBtn) {
      // Help buttons sit inside <label>s: don't let the click toggle the control.
      e.preventDefault();
      const key = helpBtn.dataset['help'];
      store.setState({ activeModal: 'help', helpTopic: key && isHelpKey(key) ? key : null });
      return;
    }

    const modalBtn = target.closest<HTMLElement>('[data-open-modal]');
    if (modalBtn) {
      const m = modalBtn.dataset['openModal'] as AppState['activeModal'];
      store.setState({ activeModal: m });
      if (m === 'export' && !exportedOnce) {
        exportedOnce = true;
        writeFlag(EXPORTED_ONCE_KEY, true);
        renderSidebar(store.getState());
      }
      return;
    }

    if (target.closest('[data-action="close-modal"]')) {
      store.setState({ activeModal: null });
      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (actionEl) {
      const act = actionEl.dataset['action'];
      const state = store.getState();
      if (act === 'fine-grain-rerun' || act === 'fine-grain-undo') {
        const photo = getActivePhoto(state);
        if (photo && !state.batchRunning) void setFineGrainUpscale(photo, act === 'fine-grain-rerun' ? 1.5 : undefined);
        return;
      }
      if (act === 'open-site') {
        const id = actionEl.dataset['siteId'];
        if (id) {
          store.setState({ dashboardScope: 'photo' });
          void loadSiteData(id);
        }
        return;
      }
      if (act === 'toggle-compare-px') {
        store.setState({ compareInPixels: (actionEl as HTMLInputElement).checked });
        void refreshComparison();
        return;
      }
      if (act === 'analyse-all-sites') {
        void runAllSites();
        return;
      }
      if (act === 'export-comparison') {
        const cmp = state.comparison;
        if (cmp && cmp.sites.length > 0) {
          const csv = comparisonCsv(cmp.sites, {
            ...baseExportMetadata(),
            poolingMode: state.siteOptions.poolingMode,
            sizeMetric: state.siteOptions.sizeMetric ?? 'bAxis',
            sites: cmp.sites.map((s) => s.name).join('; '),
          });
          triggerBlobDownload(new Blob([csv], { type: 'text/csv' }), 'site_comparison.csv');
        }
        return;
      }
      if (act === 'add-photos') {
        fileInputEl.click();
        return;
      }
      if (act === 'hide-guide' || act === 'show-guide') {
        guideHidden = act === 'hide-guide';
        writeFlag(GUIDE_HIDDEN_KEY, guideHidden);
        if (act === 'show-guide') store.setState({ activeModal: null });
        renderSidebar(store.getState());
        if (act === 'show-guide') sidebarEl.scrollTop = 0;
        return;
      }
      if (act === 'reset-analysis-params') {
        store.setState({ analysisParams: defaultAnalysisParams(), statusMessage: 'Analysis settings reset to the tested defaults.' });
        return;
      }
      if (act === 'new-site') {
        const name = askSiteName('Name for the new site (e.g. river and reach):', `Field Site ${state.sites.length + 1}`);
        if (name === null) return;
        const newSite: SiteRecord = {
          siteId: makeId('site'),
          name,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          options: state.siteOptions,
          photoOrder: [],
        };
        void saveSite(newSite).then(async () => {
          const sites = await listSites();
          store.setState({ sites });
          await loadSiteData(newSite.siteId);
        });
      } else if (act === 'rename-site') {
        const site = getActiveSite(state);
        if (!site) return;
        const name = askSiteName('New name for this site:', site.name);
        if (name === null || name === site.name) return;
        const renamed: SiteRecord = { ...site, name, updatedAt: Date.now() };
        void saveSite(renamed).then(async () => {
          store.setState({ sites: await listSites(), statusMessage: `Site renamed to "${name}".` });
          if (store.getState().dashboardScope === 'compare') void refreshComparison();
        });
      } else if (act === 'import-archive') {
        archiveInputEl.click();
      } else if (act === 'run-batch') {
        void runBatch();
      } else if (act === 'cancel-batch') {
        batchAbortController?.abort();
      } else if (act === 'run-active' && state.activePhotoId) {
        void runBatch([state.activePhotoId]);
      } else if (act === 'fit-view') {
        viewport?.fitToScreen();
      } else if (act === 'finish-shape') {
        viewport?.finishShape();
      } else if (act === 'cancel-shape') {
        viewport?.cancelShape();
      } else if (act === 'close-inspector') {
        store.setState({ inspectedGrainId: null });
        void syncViewport(false);
      } else if (act === 'undo' || act === 'redo') {
        const photo = getActivePhoto(state);
        const sess = photo ? state.sessions.get(photo.photoId) : null;
        if (photo && sess) {
          const ok = act === 'undo' ? sess.undo() : sess.redo();
          if (ok) {
            void persistActiveSession(photo.photoId, sess);
            recomputeReports();
            viewport?.markMasksDirty();
          }
        }
      } else if (act === 'commit-merge') {
        const photo = getActivePhoto(state);
        const sess = photo ? state.sessions.get(photo.photoId) : null;
        if (photo && sess && state.selectedGrainIds.size >= 2) {
          if (sess.mergeGrains(Array.from(state.selectedGrainIds))) {
            store.setState({ selectedGrainIds: new Set() });
            void persistActiveSession(photo.photoId, sess);
            recomputeReports();
            viewport?.markMasksDirty();
          }
        }
      } else if (act === 'copy-scale-all') {
        const active = getActivePhoto(state);
        if (active?.calibration) {
          const cal = active.calibration;
          void Promise.all(
            state.photos.map(async (ph) => {
              if (ph.photoId === active.photoId) return ph;
              const updated: PhotoRecord = { ...ph, calibration: cal };
              await savePhoto(updated);
              const sess = state.sessions.get(ph.photoId);
              if (sess) {
                sess.setCalibration(cal);
                await persistActiveSession(ph.photoId, sess);
              }
              return updated;
            }),
          ).then((photos) => {
            store.setState({
              photos,
              statusMessage: `Copied scale (${cal.mmPerPx.toFixed(4)} mm/px) to all photos in site`,
            });
            recomputeReports();
          });
        }
      } else if (act === 'download-model') {
        const modelId = actionEl.dataset['modelId'] as ModelId;
        const ctrl = new AbortController();
        modelAbortControllers.set(modelId, ctrl);
        const nextDl = new Map(state.modelDownloads);
        nextDl.set(modelId, { active: true, percent: 0, loadedBytes: 0, totalBytes: 0, speedMBps: 0 });
        store.setState({ modelDownloads: nextDl });
        void downloadModel(modelId, {
          signal: ctrl.signal,
          requireCache: true,
          onProgress: (prog) => {
            const m = new Map(store.getState().modelDownloads);
            m.set(modelId, { active: true, ...prog });
            store.setState({ modelDownloads: m });
          },
        })
          .then(async () => {
            const m = new Map(store.getState().modelDownloads);
            m.delete(modelId);
            store.setState({ modelDownloads: m });
            await refreshCapabilities();
          })
          .catch((err) => {
            const m = new Map(store.getState().modelDownloads);
            m.set(modelId, {
              active: false,
              percent: 0,
              loadedBytes: 0,
              totalBytes: 0,
              speedMBps: 0,
              error: err instanceof Error ? err.message : String(err),
            });
            store.setState({ modelDownloads: m });
          })
          .finally(() => {
            modelAbortControllers.delete(modelId);
          });
      } else if (act === 'cancel-model-dl') {
        const modelId = actionEl.dataset['modelId'] as ModelId;
        modelAbortControllers.get(modelId)?.abort();
      } else if (act === 'delete-model') {
        const modelId = actionEl.dataset['modelId'] as ModelId;
        void deleteCachedModel(modelId).then(() => refreshCapabilities());
      } else if (act === 'clear-model-cache') {
        void clearModelCache().then(() => refreshCapabilities());
      }
      return;
    }

    const exportBtn = target.closest<HTMLElement>('[data-export]');
    if (exportBtn) {
      const kind = exportBtn.dataset['export'];
      if (kind) {
        const st = store.getState();
        const activePhoto = getActivePhoto(st);
        const activeSession = activePhoto ? st.sessions.get(activePhoto.photoId) ?? null : null;
        const exportSite = getActiveSite(st);
        void handleExportAction(
          kind,
          exportSite,
          activePhoto,
          activeSession,
          st.siteReport,
          buildSiteInputs(st),
          st.psdXAxis,
          st.siteOptions.sizeMetric ?? 'bAxis',
          st.siteOptions,
        ).then((saved) => {
          if (saved && kind === 'site-archive' && exportSite) {
            markSiteBackedUp(exportSite.siteId);
            renderSidebar(store.getState());
          }
        });
      }
      return;
    }

    const toolBtn = target.closest<HTMLElement>('[data-tool]');
    if (toolBtn) {
      const tool = toolBtn.dataset['tool'] as EditorToolMode;
      store.setState({
        activeTool: tool,
        selectedGrainIds: new Set(),
        pendingCalibrationPoints: [],
        pendingRectifyPoints: [],
      });
      void syncViewport(false);
      return;
    }

    const tabBtn = target.closest<HTMLElement>('[data-tab]');
    if (tabBtn) {
      store.setState({ dashboardTab: tabBtn.dataset['tab'] as DashboardTab });
      return;
    }

    const scopeBtn = target.closest<HTMLElement>('[data-scope]');
    if (scopeBtn) {
      const scope = scopeBtn.dataset['scope'] as 'site' | 'photo' | 'compare';
      store.setState({ dashboardScope: scope });
      if (scope === 'compare') void refreshComparison();
      return;
    }

    const psdXBtn = target.closest<HTMLElement>('[data-psd-x]');
    if (psdXBtn) {
      store.setState({ psdXAxis: psdXBtn.dataset['psdX'] as 'mm' | 'phi' });
      return;
    }

    const chartDl = target.closest<HTMLElement>('[data-chart-dl]');
    if (chartDl) {
      void downloadChart(chartDl.dataset['chartDl'] ?? '', chartDl.dataset['fmt'] === 'png' ? 'png' : 'svg');
      return;
    }

    const phiBtn = target.closest<HTMLElement>('[data-phi-step]');
    if (phiBtn) {
      store.setState({ histogramStepPhi: Number(phiBtn.dataset['phiStep']) === 1 ? 1.0 : 0.5 });
      return;
    }

    if (target.closest('#photo-dropzone')) {
      fileInputEl.click();
      return;
    }

    const photoRow = target.closest<HTMLElement>('[data-photo-id]');
    if (photoRow && !(target instanceof HTMLInputElement)) {
      const pid = photoRow.dataset['photoId'];
      if (pid && pid !== store.getState().activePhotoId) {
        store.setState({
          activePhotoId: pid,
          selectedGrainIds: new Set(),
          inspectedGrainId: null,
        });
        recomputeReports();
        void syncViewport(true);
      }
    }
  });

  dashboardEl.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const tab = target?.closest<HTMLElement>('[role="tab"][data-tab]');
    if (!tab) return;

    const order: DashboardTab[] = ['psd', 'adequacy', 'shape', 'fabric'];
    const current = tab.dataset['tab'] as DashboardTab;
    const idx = order.indexOf(current);
    if (idx === -1) return;

    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') {
      nextIdx = (idx + 1) % order.length;
    } else if (e.key === 'ArrowLeft') {
      nextIdx = (idx - 1 + order.length) % order.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = order.length - 1;
    }
    if (nextIdx === null) return;

    e.preventDefault();
    const nextTab = order[nextIdx]!;
    store.setState({ dashboardTab: nextTab });
    document.getElementById(`tab-${nextTab}`)?.focus();
  });

  document.addEventListener('change', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    if (target.id === 'site-select') {
      const siteId = (target as HTMLSelectElement).value;
      void loadSiteData(siteId);
      return;
    }

    if (target.id === 'cal-preset') {
      const val = (target as HTMLSelectElement).value;
      if (val !== 'custom') {
        const [len, unit] = val.split('|');
        const lenEl = document.getElementById('cal-length') as HTMLInputElement | null;
        const unitEl = document.getElementById('cal-unit') as HTMLSelectElement | null;
        if (lenEl && len) lenEl.value = len;
        if (unitEl && unit) unitEl.value = unit;
      }
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset['photoFacies']) {
      const pid = target.dataset['photoFacies'];
      const st = store.getState();
      const ph = st.photos.find((p) => p.photoId === pid);
      const w = Number(target.value);
      if (ph && Number.isFinite(w) && w >= 0) {
        const updated: PhotoRecord = { ...ph, faciesWeight: w };
        void savePhoto(updated);
        store.setState({ photos: st.photos.map((p) => (p.photoId === pid ? updated : p)) });
        recomputeReports();
      }
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset['toggleInclude']) {
      const pid = target.dataset['toggleInclude'];
      const st = store.getState();
      const ph = st.photos.find((p) => p.photoId === pid);
      if (ph) {
        const updated: PhotoRecord = { ...ph, included: target.checked };
        void savePhoto(updated);
        store.setState({
          photos: st.photos.map((p) => (p.photoId === pid ? updated : p)),
        });
        recomputeReports();
      }
      return;
    }

    const ovKey = target.dataset['ov'];
    if (ovKey) {
      const st = store.getState();
      const nextOv = { ...st.overlays };
      if (ovKey === 'opacity' && target instanceof HTMLInputElement) {
        nextOv.opacity = Number(target.value);
      } else if (target instanceof HTMLInputElement) {
        (nextOv as Record<string, unknown>)[ovKey] = target.checked;
      }
      store.setState({ overlays: nextOv });
      void syncViewport(false);
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset['notifyDone'] !== undefined) {
      const box = target;
      if (!box.checked) {
        writeFlag(NOTIFY_PREF_KEY, false);
        return;
      }
      void requestNotifyPermission().then((ok) => {
        writeFlag(NOTIFY_PREF_KEY, ok);
        box.checked = ok;
        store.setState({
          statusMessage: ok
            ? 'You will be notified when an analysis longer than a minute finishes while this tab is in the background.'
            : 'Notifications are blocked for this site in the browser settings.',
        });
      });
      return;
    }

    if (target instanceof HTMLSelectElement && target.dataset['cpuThreads'] !== undefined) {
      try {
        if (target.value === 'auto') localStorage.removeItem(CPU_THREADS_KEY);
        else localStorage.setItem(CPU_THREADS_KEY, target.value);
      } catch {
        /* storage blocked: the choice lasts for this view only */
      }
      store.setState({ statusMessage: 'CPU threads saved. Reload the page to apply (the CPU runtime fixes its thread count when it starts).' });
      return;
    }

    const paramKey = target.dataset['param'];
    if (paramKey) {
      const st = store.getState();
      const next = { ...st.analysisParams };
      if (target instanceof HTMLInputElement && target.type === 'checkbox') {
        (next as Record<string, unknown>)[paramKey] = target.checked;
      } else if (target instanceof HTMLInputElement && target.type === 'number') {
        (next as Record<string, unknown>)[paramKey] = Number(target.value);
      } else if (target instanceof HTMLSelectElement) {
        (next as Record<string, unknown>)[paramKey] = target.value;
      }
      store.setState({ analysisParams: next });
      if (paramKey === 'excludeBorder' && target instanceof HTMLInputElement) {
        // Border exclusion only filters statistics, so apply it to analysed photos now.
        for (const sess of st.sessions.values()) sess.setExcludeBorder(target.checked);
        recomputeReports();
        void syncViewport(false);
      }
      return;
    }

    const compareSite = target instanceof HTMLInputElement ? target.dataset['compareSite'] : undefined;
    if (compareSite !== undefined) {
      const st = store.getState();
      const current = new Set(st.compareSiteIds ?? st.sites.map((s) => s.siteId));
      if ((target as HTMLInputElement).checked) current.add(compareSite);
      else current.delete(compareSite);
      store.setState({ compareSiteIds: st.sites.map((s) => s.siteId).filter((id) => current.has(id)) });
      void refreshComparison();
      return;
    }

    const siteOptKey = target.dataset['siteOpt'];
    if (siteOptKey) {
      const st = store.getState();
      const nextOpts = { ...st.siteOptions };
      if (target instanceof HTMLInputElement && target.type === 'checkbox') {
        (nextOpts as Record<string, unknown>)[siteOptKey] = target.checked;
      } else if (target instanceof HTMLInputElement && target.type === 'number') {
        (nextOpts as Record<string, unknown>)[siteOptKey] = Number(target.value);
      } else if (target instanceof HTMLSelectElement) {
        (nextOpts as Record<string, unknown>)[siteOptKey] =
          target.dataset['numeric'] === 'true' ? Number(target.value) : target.value;
      }
      const activeSite = getActiveSite(st);
      if (activeSite) {
        void saveSite({ ...activeSite, options: nextOpts, updatedAt: Date.now() });
      }
      store.setState({ siteOptions: nextOpts });
      if (siteOptKey === 'maxExcludedFraction') {
        storedSiteInputsCache.clear(); // other sites' ROIs use the tolerance too
        for (const ph of st.photos) {
          if (ph.roiConfig) st.sessions.get(ph.photoId)?.setRoiConfig(effectiveRoi(ph, nextOpts));
        }
      }
      recomputeReports();
      void syncViewport(false);
    }
  });

  fileInputEl.addEventListener('change', () => {
    if (fileInputEl.files && fileInputEl.files.length > 0) {
      void handleFilesAdded(fileInputEl.files);
      fileInputEl.value = '';
    }
  });

  archiveInputEl.addEventListener('change', () => {
    const file = archiveInputEl.files?.[0];
    if (file) {
      void importSiteArchive(file).then(async (siteId) => {
        const sites = await listSites();
        store.setState({ sites, statusMessage: 'Imported .webgrainy.json archive' });
        await loadSiteData(siteId);
      });
      archiveInputEl.value = '';
    }
  });

  // Drag & drop on sidebar
  sidebarEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.getElementById('photo-dropzone')?.classList.add('dragover');
  });
  sidebarEl.addEventListener('dragleave', () => {
    document.getElementById('photo-dropzone')?.classList.remove('dragover');
  });
  sidebarEl.addEventListener('drop', (e) => {
    e.preventDefault();
    document.getElementById('photo-dropzone')?.classList.remove('dragover');
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void handleFilesAdded(e.dataTransfer.files);
    }
  });

  // Keyboard shortcuts Ctrl+Z / Ctrl+Y
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      const st = store.getState();
      const ph = getActivePhoto(st);
      const sess = ph ? st.sessions.get(ph.photoId) : null;
      if (ph && sess && sess.undo()) {
        e.preventDefault();
        void persistActiveSession(ph.photoId, sess);
        recomputeReports();
        viewport?.markMasksDirty();
      }
    } else if (
      (e.ctrlKey || e.metaKey) &&
      (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))
    ) {
      const st = store.getState();
      const ph = getActivePhoto(st);
      const sess = ph ? st.sessions.get(ph.photoId) : null;
      if (ph && sess && sess.redo()) {
        e.preventDefault();
        void persistActiveSession(ph.photoId, sess);
        recomputeReports();
        viewport?.markMasksDirty();
      }
    }
  });

  lightSchemeQuery?.addEventListener('change', () => {
    renderDashboard(store.getState());
  });

  window.addEventListener('online', () => store.setState({ isOnline: true }));
  window.addEventListener('offline', () => store.setState({ isOnline: false }));
}

async function registerServiceWorker(): Promise<void> {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    store.setState({ swStatus: 'registering' });
    try {
      const hadController = Boolean(navigator.serviceWorker.controller);
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      // A waiting worker never activates on a plain reload, so activate it explicitly and
      // ask the user to reload once the new version controls the page.
      const activateWaiting = (worker: ServiceWorker | null): void => {
        worker?.postMessage({ type: 'SKIP_WAITING' });
      };
      if (reg.waiting && hadController) activateWaiting(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            activateWaiting(installing);
          }
        });
      });
      // The service worker adds COOP/COEP headers, but a page is only cross-origin
      // isolated if its own navigation response carried them. On the first visit (or
      // after an update from a version without the headers) reload once so WASM threads
      // can be used. Guarded per tab session so it can never loop.
      const reloadForIsolation = (): void => {
        if ((self as { crossOriginIsolated?: boolean }).crossOriginIsolated === true) return;
        if (!navigator.serviceWorker.controller || store.getState().batchRunning) return;
        try {
          if (sessionStorage.getItem('webgrainy-coi-reload') === '1') return;
          sessionStorage.setItem('webgrainy-coi-reload', '1');
        } catch {
          return; // storage unavailable: don't risk a reload loop
        }
        location.reload();
      };
      if (hadController) reloadForIsolation();
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) {
          reloadForIsolation();
          return;
        }
        if (hadController) {
          store.setState({
            statusMessage:
              'A new version of webGrainy was installed. Save your work and reload the page to use it.',
          });
        }
      });
      store.setState({ swStatus: 'ready' });
    } catch {
      store.setState({ swStatus: 'error' });
    }
  } else {
    store.setState({ swStatus: 'unsupported' });
  }
}

function setupLaunchQueue(): void {
  const w = window as unknown as {
    launchQueue?: {
      setConsumer: (
        cb: (launchParams: {
          files?: ReadonlyArray<{ getFile: () => Promise<File> }>;
        }) => void,
      ) => void;
    };
  };
  if (!w.launchQueue || typeof w.launchQueue.setConsumer !== 'function') return;

  w.launchQueue.setConsumer((launchParams) => {
    const handles = launchParams.files;
    if (!handles || handles.length === 0) return;
    void (async () => {
      const files = await Promise.all(handles.map((h) => h.getFile()));
      const archiveFiles = files.filter(
        (f) => f.name.endsWith('.webgrainy.json') || f.name.endsWith('.json'),
      );
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));

      for (const archive of archiveFiles) {
        try {
          const siteId = await importSiteArchive(archive);
          const sites = await listSites();
          store.setState({ sites, statusMessage: `Opened ${archive.name}` });
          await loadSiteData(siteId);
        } catch (err) {
          store.setState({
            statusMessage: `Failed to open ${archive.name}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      if (imageFiles.length > 0) {
        await handleFilesAdded(imageFiles);
      }
    })();
  });
}

async function bootstrap(): Promise<void> {
  mountShell();
  attachDelegatedHandlers();
  store.subscribe(renderAll);
  void refreshStorageInfo();
  renderAll(store.getState());

  await Promise.all([
    refreshCapabilities(),
    registerServiceWorker(),
    createDefaultOrLoadSites(),
  ]);
  setupLaunchQueue();
}

void bootstrap();
