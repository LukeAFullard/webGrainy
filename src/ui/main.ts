import {
  checkStorageQuota,
} from '../modules/modelCache.js';
import {
  ImageGrainsEngine,
} from '../modules/pipelineController.js';
import {
  importSiteArchive,
  isProjectArchiveFileName,
  listSites,
  saveSite,
  type PhotoRecord,
} from '../modules/projectStorage.js';
import { rectifyPerspective } from '../modules/roiAndRectify.js';
import { grainPassesSizeCutoffs } from '../modules/sedimentStats.js';
import {
  buildSiteInputs,
  effectiveRoi,
} from '../modules/siteWorkspace.js';
import { CanvasViewport } from './canvasViewport.js';
import { parseJpegExifMetadata } from './exif.js';
import { computeBlurScoreFromRgba, computeEffectiveDetectionLimit } from '../modules/photoQuality.js';
import { enhanceImageBuffer, type EnhanceKind, type EnhanceProgressEvent } from '../modules/imageEnhance.js';
import { OrtWorkerHost } from '../modules/ortWorkerSession.js';
import { manageSwUpdates, type SwUpdateController } from './swUpdate.js';
import { decodeTiffBuffer, isSupportedImageFile, isTiffFile } from '../modules/tiffDecode.js';
import { renderHelpModalHtml } from './help.js';
import { wasmThreadsFor } from '../modules/onnxInference.js';
import { GUIDE_HIDDEN_KEY, guideInputFrom, guideSteps, renderGuideHtml } from './onboarding.js';
import { EXPORTED_ONCE_KEY, SKIP_LANDING_KEY, readFlag, writeFlag } from './prefs.js';
import { markSiteBackedUp, markSiteChanged } from './backup.js';
import { ScreenWakeLock } from './wakeLock.js';
import { DoneSignal, NOTIFY_PREF_KEY, requestNotifyPermission } from './doneSignal.js';
import { loadAnalysisParams, saveAnalysisParams } from './savedSettings.js';
import { renderTopbarHtml } from './panels/topbar.js';
import { renderLandingHtml, isWorkflowStepId } from './panels/landing.js';
import { renderSidebarHtml, type StorageInfo } from './panels/sidebar.js';
import { renderToolbarHtml } from './panels/toolbar.js';
import { renderDashboardHtml } from './panels/dashboard.js';
import { renderCompareHtml } from './panels/compare.js';
import { esc, type ChartRegistry } from './panels/html.js';
import type { ControlLike, ElementLike, EventContext } from './events/context.js';
import { routeChange, routeClick } from './events/router.js';
import { handleDashboardKey } from './events/dashboard.js';
import { handleLandingKey } from './events/sidebar.js';
import { handleShortcutKey } from './events/shortcuts.js';
import { renderShortcutsModalHtml } from './shortcuts.js';
import { buildSiteReportHtml, type ReportPhoto } from './report.js';
import { renderPsdChartSvg, renderSizeHistogramSvg } from './charts.js';
import { sizeHistogramFromWentworth } from '../modules/histograms.js';
import { countFlagged, grainFlags, navGrainsFor } from './grainNav.js';
import { createWorkspaceActions, getActivePhoto, getActiveSite, rectifyWithCanvas } from './workspaceActions.js';
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
  type AppState,
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

// Landing overview preference (saved per browser; defaults to showing overview on first visit).
let skipLanding = readFlag(SKIP_LANDING_KEY);

// Analysis settings are remembered between visits (this browser only).
const store = new AppStore({
  ...createInitialState(),
  analysisParams: loadAnalysisParams(),
  showLanding: !skipLanding,
});
let lastSavedParams = store.getState().analysisParams;
store.subscribe((st) => {
  if (st.analysisParams !== lastSavedParams) {
    lastSavedParams = st.analysisParams;
    saveAnalysisParams(st.analysisParams);
  }
});

/** Saves a photo record and notes that its site has changes not yet backed up. */
// Long jobs keep the screen awake and say when they are done (tab title, optional notification).
const wakeLock = new ScreenWakeLock();
const doneSignal = new DoneSignal();

// Browser storage use, refreshed after jobs; shown in the Site panel.
let storageInfo: StorageInfo | null = null;
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

// CPU (WASM) inference runs in its own worker so the page never freezes during analysis.
const ortWorkerHost =
  typeof Worker !== 'undefined'
    ? new OrtWorkerHost(() => new Worker('./workers/ortWasm.worker.js', { type: 'module' }))
    : undefined;

const engine = new ImageGrainsEngine({
  useWorker: true,
  workerFactory: () =>
    new Worker('./workers/grainPostprocess.worker.js', { type: 'module' }),
  sessionCreateOptions: {
    wasmPaths: './ort/',
    ...(cpuThreads !== undefined ? { numThreads: cpuThreads } : {}),
    ...(ortWorkerHost ? { wasmWorker: ortWorkerHost } : {}),
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

// ---- App actions (data changes), with the screen hooks they need ----
const actions = createWorkspaceActions({
  store,
  engine,
  batchEngine: engine,
  checkStorageQuota,
  images: {
    prepareFile: async (file) => {
      if (!isTiffFile(file)) return null;
      return decodeTiffFileToPng(file);
    },
    imageSize: async (file) => {
      const bmp = await createImageBitmap(file);
      const size = { width: bmp.width, height: bmp.height };
      bmp.close();
      return size;
    },
    metadata: async (file) => {
      const [exif, blurScore] = await Promise.all([
        parseJpegExifMetadata(file),
        computeBlurScoreFromBlob(file),
      ]);
      if (!exif && blurScore === undefined) return undefined;
      return { ...(exif ?? {}), ...(blurScore !== undefined ? { blurScore } : {}) };
    },
    rectify: (image, corners, w, h) => rectifyWithCanvas(image, corners, w, h, rectifyPerspective),
    enhance: (image, kind, onProgress) => enhanceWithCanvas(image, kind, onProgress),
  },
  syncViewport: (fit) => syncViewport(fit),
  activity: {
    begin: (total) => {
      activity = newActivity(total);
      renderActivityBar();
    },
    photoStarted: (index, label) => {
      if (!activity) return;
      activity = startPhoto(activity, index, label);
      scheduleActivityRender();
    },
    setTotal: (total) => {
      if (activity && activity.photoTotal !== total) {
        activity = { ...activity, photoTotal: total };
        scheduleActivityRender();
      }
    },
    end: () => {
      activity = null;
      renderActivityBar();
    },
  },
  job: {
    acquireWakeLock: () => void wakeLock.acquire(),
    releaseWakeLock: () => void wakeLock.release(),
    start: (total) => doneSignal.start(total),
    progress: (c, t) => doneSignal.progress(c, t),
    finish: (cancelled, body) => doneSignal.finish(cancelled, body, notifyWhenDone()),
  },
  markSiteChanged,
  onStorageChanged: () => void refreshStorageInfo(),
  makeId,
  yieldToMain,
});
const {
  savePhoto,
  recomputeReports,
  refreshCapabilities,
  loadSiteData,
  createDefaultOrLoadSites,
  handleFilesAdded,
  persistActiveSession,
  applyCalibrationToActive,
  applyRectificationToActive,
} = actions;
let lastAnnouncedMsg = '';

// Persistent DOM containers created once
let landingEl!: HTMLElement;
let topbarEl!: HTMLElement;
let workspaceEl!: HTMLElement;
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
    minSizeMm: state.siteOptions.minSizeMm ?? 0,
    sizeMetric: state.siteOptions.sizeMetric ?? 'bAxis',
    calPoints: state.pendingCalibrationPoints,
    rectifyPoints: state.pendingRectifyPoints,
  });
}

function renderLanding(state: AppState): void {
  if (!landingEl) return;
  landingEl.innerHTML = renderLandingHtml(state, {
    gpuReset: engine.getWebGpuDisabledReason() !== null,
    cpuThreads,
    skipLanding,
  });
}

function renderTopbar(state: AppState): void {
  topbarEl.innerHTML = renderTopbarHtml(state, { gpuReset: engine.getWebGpuDisabledReason() !== null, cpuThreads });
}

function renderSidebar(state: AppState): void {
  const settingsOpen = sidebarEl.querySelector<HTMLDetailsElement>('details.settings-block')?.open ?? false;
  const prevPhotoScroll = sidebarEl.querySelector('.photo-list')?.scrollTop ?? 0;
  const keptOpenSidebar = captureOpenDetails(sidebarEl);
  sidebarEl.innerHTML = renderSidebarHtml(state, {
    guideHtml: guideHtml(state),
    settingsOpen,
    cpuThreadPref,
    cpuThreads,
    crossOriginIsolated: self.crossOriginIsolated,
    canNotify: typeof Notification !== 'undefined',
    notifyWhenDone: notifyWhenDone(),
    storageInfo,
  });
  restoreOpenDetails(sidebarEl, keptOpenSidebar);

  const photoListEl = sidebarEl.querySelector('.photo-list');
  if (photoListEl && prevPhotoScroll > 0) {
    photoListEl.scrollTop = prevPhotoScroll;
  }
}

function renderToolbarAndOverlays(state: AppState): void {
  const html = renderToolbarHtml(state);
  toolbarEl.innerHTML = html.toolbar;
  const keptOpen = captureOpenDetails(subToolbarEl);
  subToolbarEl.innerHTML = html.subToolbar;
  restoreOpenDetails(subToolbarEl, keptOpen);
}

function renderViewportExtras(state: AppState): void {
  const activePhoto = getActivePhoto(state);
  const session = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;
  emptyStateEl.style.display = activePhoto ? 'none' : 'flex';

  const pt = viewport?.getCursorImgPt();
  const zoomPct = viewport ? Math.round(viewport.getZoom() * 100) : 100;
  footerEl.innerHTML = `
    <span>${state.updateReady ? `<button type="button" class="btn btn-xs btn-primary" data-action="apply-update" ${state.batchRunning || state.enhancing ? 'disabled title="Available when the analysis finishes"' : 'title="A new version is installed. Reload to use it (your data is kept)."'}>Reload to update</button> ` : ''}${esc(state.statusMessage)}</span>
    <span>${activePhoto ? `${activePhoto.width}×${activePhoto.height}px | Zoom ${zoomPct}%` : ''}${pt ? ` | (${Math.round(pt.x)}, ${Math.round(pt.y)})` : ''}</span>
  `;

  if (!state.batchRunning) {
    announceStatus(state.statusMessage);
  }

  if (state.inspectedGrainId !== null && session && activePhoto) {
    const grain = session.getResult().grains.find((g) => g.id === state.inspectedGrainId);
    if (grain) {
      const ext = session.getExtendedGrain(grain.id);
      const exclReasons: string[] = [];
      if (session.getRoiFilterResult()?.excludedGrainIds.has(grain.id)) exclReasons.push('ROI');
      if (session.getExcludeBorder() && grain.touchesBorder) exclReasons.push('edge');
      if (
        !grainPassesSizeCutoffs(grain, {
          minBaxisPx: state.siteOptions.minBaxisPx ?? 15,
          minSizeMm: state.siteOptions.minSizeMm ?? 0,
          sizeMetric: state.siteOptions.sizeMetric ?? 'bAxis',
        })
      ) {
        exclReasons.push('below cutoff');
      }
      inspectorEl.style.display = 'block';
      inspectorEl.innerHTML = `
        <div class="row-between" style="margin-bottom:4px;">
          <strong>Grain #${grain.id}</strong>${
            exclReasons.length > 0
              ? ` <span class="badge warn" title="Excluded from PSD statistics (${esc(exclReasons.join(', '))})">not counted (${esc(exclReasons.join(', '))})</span>`
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
        ${(() => {
          const flags = grainFlags({
            id: grain.id,
            areaPx: grain.areaPx,
            touchesBorder: grain.touchesBorder,
            ...(ext ? { aspectRatio: ext.aspectRatio } : {}),
            excluded: session.getRoiFilterResult()?.excludedGrainIds.has(grain.id) ?? false,
          });
          return flags.length > 0 ? `<div class="inspector-flags">Check: ${esc(flags.join('; '))}</div>` : '';
        })()}
        <div class="inspector-nav" role="group" aria-label="Grain navigation">
          <button type="button" class="btn btn-xs" data-action="grain-nav" data-nav="prev" title="Previous grain">◀ Prev</button>
          <button type="button" class="btn btn-xs" data-action="grain-nav" data-nav="next" title="Next grain">Next ▶</button>
          <button type="button" class="btn btn-xs" data-action="grain-nav" data-nav="largest" title="Show the largest grain">Largest</button>
          ${(() => {
            const n = countFlagged(navGrainsFor(session));
            return `<button type="button" class="btn btn-xs" data-action="grain-nav" data-nav="flagged" title="Next grain touching the edge, outside the ROI, or very elongated" ${n === 0 ? 'disabled' : ''}>Next flagged (${n})</button>`;
          })()}
        </div>
      `;
      return;
    }
  }
  inspectorEl.style.display = 'none';
}

// ---- Charts: each chart can be downloaded as SVG or PNG (rendered in the light theme) ----
const chartRenderers: ChartRegistry = new Map();


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



function renderDashboard(state: AppState): void {
  chartRenderers.clear();
  const kept = captureOpenDetails(dashboardEl);
  const scroll = dashboardEl.scrollTop;
  dashboardEl.innerHTML =
    state.dashboardScope === 'compare'
      ? renderCompareHtml(state, isLightColorScheme(), chartRenderers)
      : renderDashboardHtml(state, { lightTheme: isLightColorScheme(), charts: chartRenderers });
  restoreOpenDetails(dashboardEl, kept);
  dashboardEl.scrollTop = scroll;
}

function renderModals(state: AppState): void {
  if (!appDialogEl) return;
  if (state.activeModal === 'models') {
    appDialogEl.innerHTML = renderModelsModalHtml(state, actions.getCachedQuota());
  } else if (state.activeModal === 'export') {
    appDialogEl.innerHTML = renderExportModalHtml(state);
  } else if (state.activeModal === 'about') {
    appDialogEl.innerHTML = renderAboutModalHtml();
  } else if (state.activeModal === 'help') {
    appDialogEl.innerHTML = renderHelpModalHtml(state.helpTopic);
  } else if (state.activeModal === 'shortcuts') {
    appDialogEl.innerHTML = renderShortcutsModalHtml();
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



function renderAll(state: AppState): void {
  const prev = prevRenderState;
  prevRenderState = state;

  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.classList.toggle('is-landing', state.showLanding);
  }
  if (landingEl) {
    landingEl.hidden = !state.showLanding;
  }
  if (topbarEl) {
    topbarEl.hidden = state.showLanding;
  }
  if (workspaceEl) {
    workspaceEl.hidden = state.showLanding;
  }

  if (
    !prev ||
    prev.showLanding !== state.showLanding ||
    prev.landingStep !== state.landingStep ||
    prev.capabilities !== state.capabilities ||
    prev.isOnline !== state.isOnline ||
    prev.swStatus !== state.swStatus ||
    prev.photos.length !== state.photos.length ||
    prev.sites.length !== state.sites.length
  ) {
    renderLanding(state);
  }

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
    prev.photoFilter !== state.photoFilter ||
    prev.photoSelectMode !== state.photoSelectMode ||
    prev.selectedPhotoIds !== state.selectedPhotoIds ||
    prev.enhancing !== state.enhancing ||
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
    prev.singlePhotoStats !== state.singlePhotoStats ||
    prev.batchRunning !== state.batchRunning ||
    prev.enhancing !== state.enhancing
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
    prev.enhancing !== state.enhancing ||
    prev.comparison !== state.comparison ||
    prev.compareSiteIds !== state.compareSiteIds ||
    prev.compareByDate !== state.compareByDate ||
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

  if (prev && prev.showLanding && !state.showLanding) {
    void syncViewport(true);
  }
}

// ============================================================================
// Bootstrap & Event Delegation
// ============================================================================

function mountShell(): void {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="landing-shell" id="landing-shell" hidden></div>
    <header class="topbar" id="topbar"></header>
    <main class="workspace" id="workspace-main">
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
    <input type="file" id="photo-file-input" accept="image/*,.tif,.tiff" multiple style="display:none;" />
    <input type="file" id="archive-file-input" accept=".webgrainy,.json" style="display:none;" />
  `;

  landingEl = document.getElementById('landing-shell')!;
  topbarEl = document.getElementById('topbar')!;
  workspaceEl = document.getElementById('workspace-main')!;
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
          const patch: Partial<AppState> = {};
          if (state.inspectedGrainId === grainId) patch.inspectedGrainId = null;
          if (state.selectedGrainIds.has(grainId)) {
            const nextSel = new Set(state.selectedGrainIds);
            nextSel.delete(grainId);
            patch.selectedGrainIds = nextSel;
          }
          if (Object.keys(patch).length > 0) store.setState(patch);
          void persistActiveSession(photo.photoId, session).catch((err: unknown) => {
            store.setState({ statusMessage: `Could not save edit: ${err instanceof Error ? err.message : String(err)}` });
          });
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
          const patch: Partial<AppState> = {};
          if (state.inspectedGrainId === grainId) patch.inspectedGrainId = null;
          if (state.selectedGrainIds.has(grainId)) {
            const nextSel = new Set(state.selectedGrainIds);
            nextSel.delete(grainId);
            patch.selectedGrainIds = nextSel;
          }
          if (Object.keys(patch).length > 0) store.setState(patch);
          void persistActiveSession(photo.photoId, session).catch((err: unknown) => {
            store.setState({ statusMessage: `Could not save edit: ${err instanceof Error ? err.message : String(err)}` });
          });
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
          void persistActiveSession(photo.photoId, session).catch((err: unknown) => {
            store.setState({ statusMessage: `Could not save edit: ${err instanceof Error ? err.message : String(err)}` });
          });
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
        void savePhoto(updated).catch((err: unknown) => {
          store.setState({ statusMessage: `Could not save exclusion: ${err instanceof Error ? err.message : String(err)}` });
        });
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
        void savePhoto(updated).catch((err: unknown) => {
          store.setState({ statusMessage: `Could not save exclusion: ${err instanceof Error ? err.message : String(err)}` });
        });
        store.setState({
          photos: state.photos.map((p) => (p.photoId === photo.photoId ? updated : p)),
        });
        recomputeReports();
        void syncViewport(false);
      },
      onCalibrationPoint: (pt) => {
        const st = store.getState();
        // Read live DOM values BEFORE store.setState re-renders the toolbar (in case the user typed without blurring).
        const lenEl = document.getElementById('cal-length') as HTMLInputElement | null;
        const unitEl = document.getElementById('cal-unit') as HTMLSelectElement | null;
        const parsedLen = lenEl ? Number(lenEl.value) : st.calibrationLength;
        const lenVal = Math.max(0.1, Number.isFinite(parsedLen) && parsedLen > 0 ? parsedLen : st.calibrationLength);
        const unit: 'mm' | 'cm' = unitEl ? (unitEl.value === 'cm' ? 'cm' : 'mm') : st.calibrationUnit;
        const key = `${lenVal}|${unit}`;
        const preset = key === '100|mm' || key === '25|mm' || key === '500|mm' ? key : 'custom';

        const prev = st.pendingCalibrationPoints;
        const next = prev.length >= 2 ? [pt] : [...prev, pt];
        store.setState({
          pendingCalibrationPoints: next,
          calibrationLength: lenVal,
          calibrationUnit: unit,
          calibrationPreset: preset,
        });
        if (next.length === 2) {
          void applyCalibrationToActive(next[0]!, next[1]!, lenVal, unit);
        } else {
          void syncViewport(false);
        }
      },
      onRectifyPoint: (pt) => {
        const st = store.getState();
        // Read live DOM values BEFORE store.setState re-renders the toolbar.
        const wEl = document.getElementById('rect-w') as HTMLInputElement | null;
        const hEl = document.getElementById('rect-h') as HTMLInputElement | null;
        const parsedW = wEl ? Number(wEl.value) : st.rectifyWidthMm;
        const parsedH = hEl ? Number(hEl.value) : st.rectifyHeightMm;
        const pw = Math.max(10, Number.isFinite(parsedW) && parsedW > 0 ? parsedW : st.rectifyWidthMm);
        const ph = Math.max(10, Number.isFinite(parsedH) && parsedH > 0 ? parsedH : st.rectifyHeightMm);

        const prev = st.pendingRectifyPoints;
        const next = prev.length >= 4 ? [pt] : [...prev, pt];
        store.setState({
          pendingRectifyPoints: next,
          rectifyWidthMm: pw,
          rectifyHeightMm: ph,
        });
        if (next.length === 4) {
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

function transitionView(update: () => void, focusTargetId?: string): void {
  const focusAfter = () => {
    if (focusTargetId) {
      document.getElementById(focusTargetId)?.focus();
    }
  };
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<unknown> };
  };
  if (!doc.startViewTransition) {
    update();
    focusAfter();
    return;
  }
  try {
    const transition = doc.startViewTransition(() => {
      update();
    });
    void transition.finished.finally(focusAfter);
  } catch {
    update();
    focusAfter();
  }
}

/** Screen hooks and preferences the event handlers need (see events/context.ts). */
function eventContext(): EventContext {
  return {
    store,
    actions,
    storage: { saveSite, listSites },
    ui: {
      renderSidebar: () => renderSidebar(store.getState()),
      syncViewport,
      viewport: () => viewport,
      openPhotoPicker: () => fileInputEl.click(),
      openArchivePicker: () => archiveInputEl.click(),
      askSiteName,
      confirm: (message) => window.confirm(message),
      scrollSidebarToTop: () => {
        sidebarEl.scrollTop = 0;
      },
      downloadChart,
      download: triggerBlobDownload,
      runExport,
      openReport,
      setFieldValue: (id, value) => {
        const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        if (el) el.value = value;
      },
      focusTab: (tab) => document.getElementById(`tab-${tab}`)?.focus(),
      focusWorkflowTab: (step) => {
        const el = document.getElementById(`wf-tab-${step}`);
        if (!el) return;
        el.focus();
        try {
          el.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
            container: 'nearest',
          } as ScrollIntoViewOptions);
        } catch {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      },
      enterWorkspace: (tool) => {
        transitionView(() => {
          store.setState({
            showLanding: false,
            ...(tool ? { activeTool: tool } : {}),
          });
          window.scrollTo({ top: 0 });
        }, 'canvas-stage');
      },
      showLanding: () => {
        transitionView(() => {
          store.setState({ showLanding: true });
          window.scrollTo({ top: 0 });
        }, 'landing-heading');
      },
      focusGrain: (id) => viewport?.focusOnGrain(id),
      applyUpdate: () => swUpdates?.applyUpdate() ?? false,
      isTyping: () => {
        const el = document.activeElement;
        if (!el) return false;
        const tag = el.tagName.toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable;
      },
    },
    prefs: {
      setGuideHidden: (hidden) => {
        guideHidden = hidden;
        writeFlag(GUIDE_HIDDEN_KEY, hidden);
      },
      setSkipLanding: (skip) => {
        skipLanding = skip;
        writeFlag(SKIP_LANDING_KEY, skip);
        renderLanding(store.getState());
      },
      noteExportOpened: () => {
        if (exportedOnce) return;
        exportedOnce = true;
        writeFlag(EXPORTED_ONCE_KEY, true);
        renderSidebar(store.getState());
      },
      setNotifyWhenDone: (on) => writeFlag(NOTIFY_PREF_KEY, on),
      requestNotifyPermission,
      saveCpuThreads: (value) => {
        try {
          if (value === 'auto') localStorage.removeItem(CPU_THREADS_KEY);
          else localStorage.setItem(CPU_THREADS_KEY, value);
        } catch {
          /* storage blocked: the choice lasts for this view only */
        }
      },
    },
    makeId,
  };
}

/** Decodes a TIFF/GeoTIFF file via UTIF into a browser-universal lossless PNG blob. */
async function decodeTiffFileToPng(file: File) {
  const buf = await file.arrayBuffer();
  const decoded = decodeTiffBuffer(buf);
  const canvas = document.createElement('canvas');
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create 2D canvas context for TIFF decoding.');
  const imgData = new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height);
  ctx.putImageData(imgData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to encode decoded TIFF as PNG.'))), 'image/png');
  });
  const blurScore = await computeBlurScoreFromBlob(blob);
  const metadata =
    decoded.metadata || blurScore !== undefined
      ? { ...(decoded.metadata ?? {}), ...(blurScore !== undefined ? { blurScore } : {}) }
      : undefined;
  return {
    blob,
    width: decoded.width,
    height: decoded.height,
    ...(metadata ? { metadata } : {}),
    ...(decoded.calibration ? { calibration: decoded.calibration } : {}),
  };
}

/** Fast 256 px thumbnail Laplacian-variance sharpness check (0 MB, instant). */
async function computeBlurScoreFromBlob(blob: Blob): Promise<number | undefined> {
  try {
    const bmp = await createImageBitmap(blob);
    const maxSide = 256;
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(3, Math.round(bmp.width * k));
    c.height = Math.max(3, Math.round(bmp.height * k));
    const ctx = c.getContext('2d');
    if (!ctx) {
      bmp.close();
      return undefined;
    }
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    return computeBlurScoreFromRgba(img.data, img.width, img.height);
  } catch {
    return undefined;
  }
}

/** Decodes a photo blob, runs memory-isolated ONNX enhancement, and encodes back to PNG. */
async function enhanceWithCanvas(
  blob: Blob,
  kind: EnhanceKind,
  onProgress?: (ev: EnhanceProgressEvent) => void,
) {
  const bmp = await createImageBitmap(blob);
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = bmp.width;
  srcCanvas.height = bmp.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) {
    bmp.close();
    throw new Error('Could not create 2D canvas context.');
  }
  srcCtx.drawImage(bmp, 0, 0);
  bmp.close();
  const srcImg = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

  const threads = wasmThreadsFor(readCpuThreadPref());
  const enhanced = await enhanceImageBuffer(srcImg.data, srcImg.width, srcImg.height, kind, {
    sessionOptions: {
      wasmPaths: './ort/',
      ...(threads !== undefined ? { numThreads: threads } : {}),
      ...(ortWorkerHost ? { wasmWorker: ortWorkerHost } : {}),
    },
    ...(onProgress ? { onProgress } : {}),
  });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = enhanced.width;
  outCanvas.height = enhanced.height;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('Could not create output canvas context.');
  const outImgData = new ImageData(
    new Uint8ClampedArray(enhanced.data),
    enhanced.width,
    enhanced.height,
  );
  outCtx.putImageData(outImgData, 0, 0);

  const outBlob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to encode enhanced image.'))), 'image/png');
  });
  const blurScore = await computeBlurScoreFromBlob(outBlob);

  return {
    blob: outBlob,
    width: enhanced.width,
    height: enhanced.height,
    ...(blurScore !== undefined ? { blurScore } : {}),
    enhancement: {
      kind: enhanced.spec.kind,
      modelId: enhanced.spec.modelId,
      modelName: enhanced.spec.modelName,
      modelSha256: enhanced.spec.sha256,
      scaleFactor: enhanced.spec.scaleFactor,
      appliedAt: new Date().toISOString(),
    },
  };
}

/** A small JPEG of a photo for the printable report. */
async function photoThumbDataUrl(blob: Blob, maxSide: number): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return c.toDataURL('image/jpeg', 0.82);
  } catch {
    return undefined;
  }
}

/** Opens the printable site report. The tab is opened right away (pop-up blockers allow that) and filled in when ready. */
function openReport(): void {
  const win = window.open('', '_blank');
  void buildReport().then((html) => {
    if (!html) {
      win?.close();
      return;
    }
    const site = getActiveSite(store.getState());
    if (win && !win.closed) {
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.document.querySelector('[data-print]')?.addEventListener('click', () => win.print());
    } else {
      const name = (site?.name ?? 'site').replace(/[^a-zA-Z0-9_-]+/g, '_');
      triggerBlobDownload(new Blob([html], { type: 'text/html' }), `${name}_report.html`);
      store.setState({ statusMessage: 'Pop-ups are blocked, so the report was downloaded instead: open it and print it from the browser.' });
    }
  });
}

async function buildReport(): Promise<string | null> {
  const st = store.getState();
  const site = getActiveSite(st);
  const report = st.siteReport;
  if (!site || !report) {
    store.setState({ statusMessage: 'Analyse photos first: the report needs site results.' });
    return null;
  }
  store.setState({ statusMessage: 'Preparing the printable report…' });
  const photos: ReportPhoto[] = [];
  for (const p of report.perPhoto) {
    const rec = st.photos.find((x) => x.photoId === p.photoId);
    const thumb = rec ? await photoThumbDataUrl(rec.imageBlob, 480) : undefined;
    const sess = st.sessions.get(p.photoId);
    photos.push({
      label: p.label,
      ...(thumb ? { imageDataUrl: thumb } : {}),
      ...(sess ? { outlineSvg: sess.exportSvg() } : {}),
      validGrainCount: p.validGrainCount,
      D50: p.D50,
      ...(p.mmPerPx !== undefined ? { mmPerPx: p.mmPerPx } : {}),
      outlierReasons: p.outlierReasons,
    });
  }
  const firstSession = [...st.sessions.values()][0];
  const prov = firstSession?.getProvenance();
  const ap = st.analysisParams;
  const so = st.siteOptions;
  const hist = report.unit === 'mm' ? sizeHistogramFromWentworth(report.wentworthHistogram10Phi, 1) : null;

  const limitValues: number[] = [];
  const calibratedScales: number[] = [];
  let manualEditsCount = 0;
  let enhancedPhotosCount = 0;
  for (const p of report.perPhoto) {
    const rec = st.photos.find((x) => x.photoId === p.photoId);
    if (rec?.metadata?.enhancement) enhancedPhotosCount++;
    const sess = st.sessions.get(p.photoId);
    if (sess?.canUndo) manualEditsCount++;
    if (p.mmPerPx !== undefined && p.mmPerPx > 0) calibratedScales.push(p.mmPerPx);
    const lim = computeEffectiveDetectionLimit({
      minSizeWorkingPx: sess?.getProvenance()?.postProcess?.minSize ?? ap.minSize,
      ...(sess ? { effectiveScaleFactor: sess.workingImage.effectiveScaleFactor } : {}),
      ...(so.minBaxisPx !== undefined ? { minBaxisPx: so.minBaxisPx } : {}),
      ...(report.unit === 'mm' && p.mmPerPx !== undefined ? { mmPerPx: p.mmPerPx } : {}),
    });
    if (lim) limitValues.push(lim.value);
  }
  const detectionLimit = limitValues.length > 0 ? Math.max(...limitValues) : undefined;
  const resolutionRangeMmPerPx: [number, number] | undefined =
    calibratedScales.length > 0 ? [Math.min(...calibratedScales), Math.max(...calibratedScales)] : undefined;

  const html = buildSiteReportHtml({
    site,
    report,
    generatedAt: new Date().toISOString(),
    metadata: { ...baseExportMetadata(), ...(prov ?? {}) },
    settings: [
      ['Model', ap.model === 'auto' ? 'Auto (per photo)' : ap.model === 'unet' ? 'U-Net' : `Cellpose-SAM (${ap.cpsamWeights})`],
      ['Pooling', report.statisticalBasisLabel],
      ['Size metric', so.sizeMetric ?? 'bAxis'],
      ['Smallest grain counted', `${so.minBaxisPx ?? 15} px${so.minSizeMm ? ` and ${so.minSizeMm} mm` : ''}`],
      ['Flow threshold / cell probability', `${ap.flowThreshold} / ${ap.cellprobThreshold}`],
      ['Grains touching the photo edge', ap.excludeBorder ? 'left out' : 'counted'],
    ],
    ...(detectionLimit !== undefined ? { detectionLimit } : {}),
    manualEditsCount,
    ...(enhancedPhotosCount > 0 ? { enhancedPhotosCount } : {}),
    ...(resolutionRangeMmPerPx ? { resolutionRangeMmPerPx } : {}),
    psdSvg: renderPsdChartSvg({
      psd: report.psd,
      unit: report.unit,
      xAxis: st.psdXAxis,
      title: 'Cumulative grain-size distribution',
      subtitle: `${report.includedPhotoCount} photos, n=${report.validGrainCount}`,
      ciLower: report.bootstrapCi.lower,
      ciUpper: report.bootstrapCi.upper,
      perPhotoCurves: report.perPhoto,
      ...(detectionLimit !== undefined ? { detectionLimit } : {}),
      lightTheme: true,
    }),
    histogramSvg: hist && hist.bins.length > 0 ? renderSizeHistogramSvg(hist, true, 'Size distribution (area-weighted %, 1 φ classes)') : null,
    photos,
  });
  store.setState({ statusMessage: 'Printable report ready.' });
  return html;
}

/** Runs an export; a saved project file counts as a backup of the site. */
function runExport(kind: string): void {
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

function attachDelegatedHandlers(): void {
  const ctx = eventContext();
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    routeClick(target as unknown as ElementLike, () => e.preventDefault(), ctx);
  });

  dashboardEl.addEventListener('keydown', (e) => {
    handleDashboardKey(e.target as unknown as ElementLike | null, e, ctx);
  });

  landingEl.addEventListener('keydown', (e) => {
    handleLandingKey(e.target as unknown as ElementLike | null, e, ctx);
  });

  landingEl.addEventListener('beforematch', (e) => {
    const target = e.target as HTMLElement | null;
    const panel = target?.closest<HTMLElement>('[data-step-panel]');
    const step = panel?.dataset['stepPanel'];
    if (isWorkflowStepId(step)) {
      store.setState({ landingStep: step });
      const tab = document.getElementById(`wf-tab-${step}`);
      if (tab) {
        try {
          tab.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
            container: 'nearest',
          } as ScrollIntoViewOptions);
        } catch {
          tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    }
  });

  document.addEventListener('change', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    routeChange(target as unknown as ControlLike, ctx);
  });

  fileInputEl.addEventListener('change', () => {
    if (fileInputEl.files && fileInputEl.files.length > 0) {
      if (store.getState().showLanding) {
        store.setState({ showLanding: false });
      }
      void handleFilesAdded(fileInputEl.files);
      fileInputEl.value = '';
    }
  });

  archiveInputEl.addEventListener('change', () => {
    const file = archiveInputEl.files?.[0];
    if (file) {
      if (store.getState().showLanding) {
        store.setState({ showLanding: false });
      }
      void importSiteArchive(file)
        .then(async (siteId) => {
          const sites = await listSites();
          store.setState({ sites, statusMessage: 'Imported project archive' });
          await loadSiteData(siteId);
        })
        .catch((err: unknown) => {
          store.setState({
            statusMessage: `Failed to import ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
          });
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

  // Drag & drop on landing overview
  landingEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.getElementById('landing-dropzone')?.classList.add('dragover');
  });
  landingEl.addEventListener('dragleave', () => {
    document.getElementById('landing-dropzone')?.classList.remove('dragover');
  });
  landingEl.addEventListener('drop', (e) => {
    e.preventDefault();
    document.getElementById('landing-dropzone')?.classList.remove('dragover');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const allFiles = Array.from(files);
    const archive = allFiles.find((f) => isProjectArchiveFileName(f.name));
    const images = allFiles.filter((f) => !isProjectArchiveFileName(f.name));
    if (store.getState().showLanding) {
      store.setState({ showLanding: false });
    }
    if (archive) {
      void importSiteArchive(archive)
        .then(async (siteId) => {
          const sites = await listSites();
          store.setState({ sites, statusMessage: 'Imported project archive' });
          await loadSiteData(siteId);
        })
        .catch((err: unknown) => {
          store.setState({
            statusMessage: `Failed to import ${archive.name}: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    }
    if (images.length > 0) {
      void handleFilesAdded(images);
    }
  });

  // Keyboard shortcuts (table in shortcuts.ts; '?' shows them)
  window.addEventListener('keydown', (e) => handleShortcutKey(e, ctx));

  lightSchemeQuery?.addEventListener('change', () => {
    renderDashboard(store.getState());
  });

  window.addEventListener('online', () => store.setState({ isOnline: true }));
  window.addEventListener('offline', () => store.setState({ isOnline: false }));
}

let swUpdates: SwUpdateController | null = null;

async function registerServiceWorker(): Promise<void> {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    store.setState({ swStatus: 'registering' });
    try {
      const hadController = Boolean(navigator.serviceWorker.controller);
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      // New versions wait for the user's "Reload to update" (see swUpdate.ts): activating
      // one under a running page made it load mismatched worker / runtime files.
      swUpdates = manageSwUpdates(reg, {
        hadController,
        hasController: () => Boolean(navigator.serviceWorker.controller),
        reload: () => location.reload(),
        onUpdateReady: () => store.setState({ updateReady: true }),
        isBusy: () => store.getState().batchRunning || store.getState().enhancing === true,
        addControllerChangeListener: (cb) => navigator.serviceWorker.addEventListener('controllerchange', cb),
        onStateChange: (w, cb) => (w as ServiceWorker).addEventListener('statechange', cb),
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
        // First install: the page is now controlled; reload once for cross-origin isolation.
        if (!hadController) reloadForIsolation();
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
      if (store.getState().showLanding) {
        store.setState({ showLanding: false });
      }
      const files = await Promise.all(handles.map((h) => h.getFile()));
      const archiveFiles = files.filter((f) => isProjectArchiveFileName(f.name));
      const imageFiles = files.filter((f) => isSupportedImageFile(f));

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
