import {
  checkStorageQuota,
} from '../modules/modelCache.js';
import {
  ImageGrainsEngine,
} from '../modules/pipelineController.js';
import * as projectStorage from '../modules/projectStorage.js';
import {
  importSiteArchive,
  isProjectArchiveFileName,
  type PhotoRecord,
  type SiteRecord,
} from '../modules/projectStorage.js';
import { broadcastNoticeChannel, createSyncedRecords } from '../modules/recordSync.js';
import { rectifyPerspective } from '../modules/roiAndRectify.js';
import { sizeCutoffExplanation } from '../modules/sedimentStats.js';
import {
  buildSiteInputs,
  photoCutoffs,
} from '../modules/siteWorkspace.js';
import { CanvasViewport } from './canvasViewport.js';
import { parseJpegExifMetadata } from './exif.js';
import { OrtWorkerHost } from '../modules/ortWorkerSession.js';
import { manageSwUpdates, type SwUpdateController } from './swUpdate.js';
import { isSupportedImageFile, isTiffFile } from '../modules/tiffDecode.js';
import { renderHelpModalHtml } from './help.js';
import { wasmThreadsFor } from '../modules/onnxInference.js';
import { GUIDE_HIDDEN_KEY, guideInputFrom, guideSteps, renderGuideHtml } from './onboarding.js';
import { EXPORTED_ONCE_KEY, SKIP_LANDING_KEY, readFlag, readRetentionDaysRaw, writeFlag } from './prefs.js';
import { parseRetentionDays } from '../modules/retention.js';
import { buildResultsBundle } from '../modules/resultsBundle.js';
import { renderPrintablePsdSvg } from './charts.js';
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
import { countFlagged, grainFlags, navGrainsFor } from './grainNav.js';
import { createWorkspaceActions, getActivePhoto, getActiveSite, STALE_BUILD_MESSAGE } from './workspaceActions.js';
import { buildPrintableReport } from './reportBuilder.js';
import { APP_SHELL_HTML } from './shellHtml.js';
import { computeBlurScoreFromBlob, decodeTiffFileToPng, enhanceWithCanvas, rectifyWithCanvas } from './imageCanvas.js';
import { applyEvent, newActivity, renderActivityHtml, startPhoto, type ActivityState } from './progress.js';
import { CPU_THREADS_KEY, readCpuThreadPref } from './cpuThreads.js';
import { svgToPngBlob, withSvgMetadata } from './chartExport.js';
import { baseExportMetadata } from '../modules/provenance.js';
import {
  handleExportAction,
  triggerBlobDownload,
  renderAboutModalHtml,
  renderExportModalHtml,
  renderDownloadResultsModalHtml,
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

// Whether this tab was in the workspace, so a reload (manual, or the one-off reload for
// cross-origin isolation) returns there instead of to the landing page.
const IN_WORKSPACE_KEY = 'webgrainy-in-workspace';
function readTabFlag(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeTabFlag(key: string, on: boolean): void {
  try {
    if (on) sessionStorage.setItem(key, '1');
    else sessionStorage.removeItem(key);
  } catch {
    // storage unavailable: nothing to remember
  }
}

// Analysis settings are remembered between visits (this browser only).
const store = new AppStore({
  ...createInitialState(),
  analysisParams: loadAnalysisParams(),
  showLanding: !skipLanding && !readTabFlag(IN_WORKSPACE_KEY),
});
let lastShowLanding = store.getState().showLanding;
store.subscribe((st) => {
  if (st.showLanding !== lastShowLanding) {
    lastShowLanding = st.showLanding;
    writeTabFlag(IN_WORKSPACE_KEY, !st.showLanding);
  }
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
// Photo and site records stay consistent when the app is open in several tabs: saves merge
// with what another tab saved, and the other tabs refresh (modules/recordSync.ts).
const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;
const noticeChannel = broadcastNoticeChannel();
const syncedRecords = createSyncedRecords(
  {
    listSites: () => projectStorage.listSites(),
    getSite: (id) => projectStorage.getSite(id),
    saveSite: (x) => projectStorage.saveSite(x),
    listSitePhotos: (id) => projectStorage.listSitePhotos(id),
    getPhoto: (id) => projectStorage.getPhoto(id),
    savePhoto: (x) => projectStorage.savePhoto(x),
    deletePhoto: (id) => projectStorage.deletePhoto(id),
  },
  {
    tabId: TAB_ID,
    channel: noticeChannel,
    hooks: {
      onMerged: (kind, rec) => {
        const st = store.getState();
        if (kind === 'photo') {
          const p = rec as PhotoRecord;
          store.setState({ photos: st.photos.map((x) => (x.photoId === p.photoId ? p : x)) });
        } else {
          const site = rec as SiteRecord;
          store.setState({ sites: st.sites.map((x) => (x.siteId === site.siteId ? site : x)) });
        }
      },
    },
  },
);
const listSites = (): Promise<SiteRecord[]> => syncedRecords.listSites();
const saveSite = (site: SiteRecord): Promise<void> => syncedRecords.saveSite(site);

const actions = createWorkspaceActions({
  storage: {
    listSitePhotos: (id) => syncedRecords.listSitePhotos(id),
    listSites,
    getPhotoResult: (id) => projectStorage.getPhotoResult(id),
    runSiteBatch: (o) => projectStorage.runSiteBatch(o),
    savePhoto: (x) => syncedRecords.savePhoto(x),
    savePhotoResult: (r) => projectStorage.savePhotoResult(r),
    saveSite,
    deletePhoto: (id) => syncedRecords.deletePhoto(id),
    deleteSite: (id) => projectStorage.deleteSite(id),
  },
  notifyRecords: (siteIds, photoIds) => syncedRecords.notify(siteIds, photoIds),
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
    enhance: (image, kind, onProgress) => {
      const threads = wasmThreadsFor(readCpuThreadPref());
      return enhanceWithCanvas(image, kind, {
        wasmPaths: './ort/',
        ...(threads !== undefined ? { numThreads: threads } : {}),
        ...(ortWorkerHost ? { wasmWorker: ortWorkerHost } : {}),
      }, onProgress);
    },
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
// Another tab saved records or results: refresh this tab's copy (serialised, latest wins).
let refreshing: Promise<void> = Promise.resolve();
noticeChannel?.onMessage((notice) => {
  if (notice.from === TAB_ID) return;
  refreshing = refreshing.then(() => actions.refreshFromStorage(notice)).catch(() => undefined);
});

const {
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
    ...photoCutoffs(state.siteOptions, state.siteReport, photo?.photoId),
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
    <span>${state.staleBuild ? `<button type="button" class="btn btn-xs btn-primary" data-action="reload-stale" ${state.batchRunning ? 'disabled title="Available when the analysis finishes"' : 'title="A newer version was installed in another tab. Reload to use it (your data is kept)."'}>Reload now</button> ` : ''}${state.updateReady ? `<button type="button" class="btn btn-xs btn-primary" data-action="apply-update" ${state.batchRunning || state.enhancing ? 'disabled title="Available when the analysis finishes"' : 'title="A new version is installed. Reload to use it (your data is kept)."'}>Reload to update</button> ` : ''}${esc(state.statusMessage)}</span>
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
      // Name the rule and the numbers: "below cutoff" alone was read as the segmentation
      // Min Size (px² / mm²), which is a different setting.
      const cutoffWhy = sizeCutoffExplanation(grain, {
        ...photoCutoffs(state.siteOptions, state.siteReport, activePhoto.photoId),
        sizeMetric: state.siteOptions.sizeMetric ?? 'bAxis',
      });
      if (cutoffWhy) exclReasons.push(`below cutoff: ${cutoffWhy}`);
      inspectorEl.style.display = 'block';
      inspectorEl.innerHTML = `
        <div class="row-between" style="margin-bottom:4px;">
          <strong>Grain #${grain.id}</strong>${
            exclReasons.length > 0
              ? ` <span class="badge warn" title="Excluded from the size statistics">not counted</span>`
              : ''
          }
          <button type="button" class="btn btn-sm" data-action="close-inspector" aria-label="Close grain inspector">×</button>
        </div>
        ${
          exclReasons.length > 0
            ? `<div class="field-hint" data-grain-excluded style="margin-bottom:4px;">Not counted: ${esc(exclReasons.join('; '))}.${cutoffWhy ? ' Change it under Results: <em>Min b-axis (px)</em> or <em>Field-count cutoff (mm)</em>. <em>Min Size</em> in the analysis settings is a different setting (a noise filter during segmentation).' : ''}</div>`
            : ''
        }
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
          <div>Border: ${grain.touchesBorder ? (session?.excludesBorderGrains === false ? 'Yes (counted: border grains are kept)' : 'Yes (excluded)') : 'No'}</div>
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
  } else if (state.activeModal === 'download-results') {
    appDialogEl.innerHTML = renderDownloadResultsModalHtml(state);
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
    prev.siteOptions.poolingMode !== state.siteOptions.poolingMode ||
    prev.retentionDays !== state.retentionDays ||
    prev.retentionNotice !== state.retentionNotice ||
    prev.retentionHeld !== state.retentionHeld ||
    prev.storageFullNotice !== state.storageFullNotice
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
    (state.activeModal === 'download-results' &&
      (prev.downloadIncludeProject !== state.downloadIncludeProject || prev.exportCountedOnly !== state.exportCountedOnly || prev.downloadingResults !== state.downloadingResults)) ||
    (state.activeModal === 'export' &&
      (prev.siteReport !== state.siteReport ||
        prev.exportCountedOnly !== state.exportCountedOnly ||
        prev.exportWhat !== state.exportWhat ||
        prev.exportFormat !== state.exportFormat ||
        prev.exportCoords !== state.exportCoords ||
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

  app.innerHTML = APP_SHELL_HTML;

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
        if (grainId === null) {
          store.setState({ statusMessage: 'Split: the line does not cross a grain. Draw it across the grain, from one side to the other.' });
          return;
        }
        const ok = session.splitGrain(grainId, points);
        if (!ok) {
          store.setState({ statusMessage: 'Split: the line did not cut this grain into two pieces. Draw it right across the grain, from edge to edge.' });
        } else {
          const patch: Partial<AppState> = {};
          if (state.inspectedGrainId === grainId) patch.inspectedGrainId = null;
          if (state.selectedGrainIds.has(grainId)) {
            const nextSel = new Set(state.selectedGrainIds);
            nextSel.delete(grainId);
            patch.selectedGrainIds = nextSel;
          }
          if (Object.keys(patch).length > 0) store.setState(patch);
          void persistActiveSession(photo.photoId, session).catch((err: unknown) => {
            actions.reportSaveFailure(err, 'this outline edit');
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
            actions.reportSaveFailure(err, 'this outline edit');
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
            actions.reportSaveFailure(err, 'this outline edit');
          });
          recomputeReports();
          viewport?.markMasksDirty();
        }
      },
      onAddExclusionPolygon: (points) => {
        actions.updateActiveRoi((prev) => ({ ...prev, exclusionPolygons: [...prev.exclusionPolygons, points] }), 'this exclusion area');
      },
      onAddExclusionStroke: (points, radiusPx) => {
        actions.updateActiveRoi((prev) => ({ ...prev, exclusionStrokes: [...prev.exclusionStrokes, { points, radiusPx }] }), 'this exclusion area');
      },
      onSetRoiPolygon: (points) => {
        // One ROI per photo: drawing a new one replaces the old.
        actions.updateActiveRoi((prev) => ({ ...prev, roiPolygon: points }), 'this region of interest');
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
    storage: {
      // Every site edit from the UI (statistics settings, name, place, survey date) changes what
      // a download would contain: note it so the backup reminder and retention see it.
      saveSite: (site) => {
        markSiteChanged(site.siteId);
        return saveSite(site);
      },
      listSites,
    },
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
      reloadPage: () => location.reload(),
      downloadResults,
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
      const printBtn = win.document.querySelector('[data-print]');
      if (printBtn && !printBtn.hasAttribute('data-bound')) {
        printBtn.setAttribute('data-bound', '');
        printBtn.addEventListener('click', () => win.print());
      }
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
  const html = await buildPrintableReport(st, site, report);
  store.setState({ statusMessage: 'Printable report ready.' });
  return html;
}

/** "Download results": every result file of the open site in one .zip (see resultsBundle.ts). */
async function downloadResults(includeProject: boolean): Promise<void> {
  const st = store.getState();
  const site = getActiveSite(st);
  if (!site) return;
  store.setState({ downloadingResults: true, statusMessage: 'Preparing the results download…' });
  try {
    const reportHtml = st.siteReport ? await buildReport() : null;
    const { blob, filename } = await buildResultsBundle({
      site,
      photos: st.photos,
      siteInputs: buildSiteInputs(st),
      siteReport: st.siteReport,
      siteOptions: st.siteOptions,
      sizeMetric: st.siteOptions.sizeMetric ?? 'bAxis',
      psdXAxis: st.psdXAxis,
      renderPsdSvg: renderPrintablePsdSvg,
      reportHtml,
      includeProject,
      countedGrainsOnly: st.exportCountedOnly,
    });
    triggerBlobDownload(blob, filename);
    markSiteBackedUp(site.siteId);
    renderSidebar(store.getState());
    store.setState({
      activeModal: null,
      statusMessage: `Downloaded ${filename} (${(blob.size / 1e6).toFixed(1)} MB)${includeProject ? ', with the project file' : ': results only; keep your original photos'}.`,
    });
  } catch (err) {
    store.setState({ statusMessage: `Could not prepare the download: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    store.setState({ downloadingResults: false });
  }
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
    st.exportCountedOnly,
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
          syncedRecords.notify([siteId], []);
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
          syncedRecords.notify([siteId], []);
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
        addMessageListener: (cb) => navigator.serviceWorker.addEventListener('message', (e) => cb(e.data)),
        onStale: () =>
          store.setState({
            staleBuild: true,
            updateReady: false,
            statusMessage: STALE_BUILD_MESSAGE,
          }),
      });
      // The service worker adds COOP/COEP headers, but a page is only cross-origin
      // isolated if its own navigation response carried them. On the first visit (or
      // after an update from a version without the headers) reload once so WASM threads
      // can be used. Guarded per tab session so it can never loop.
      // Only reload while the user is on the landing page and nothing is running: a reload in the
      // workspace would cut off whatever they are doing (calibrating, importing, typing). Otherwise
      // wait until they are back on the landing page; until then the CPU uses one thread.
      const canReloadNow = (st: AppState): boolean => st.showLanding && !st.batchRunning && st.enhancing !== true;
      let waitingToReload = false;
      const reloadForIsolation = (): void => {
        if ((self as { crossOriginIsolated?: boolean }).crossOriginIsolated === true) return;
        if (!navigator.serviceWorker.controller) return;
        try {
          if (sessionStorage.getItem('webgrainy-coi-reload') === '1') return;
        } catch {
          return; // storage unavailable: don't risk a reload loop
        }
        if (!canReloadNow(store.getState())) {
          if (!waitingToReload) {
            waitingToReload = true;
            store.subscribe((st) => {
              if (waitingToReload && canReloadNow(st)) {
                waitingToReload = false;
                reloadForIsolation();
              }
            });
          }
          return;
        }
        try {
          sessionStorage.setItem('webgrainy-coi-reload', '1');
        } catch {
          return;
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
          syncedRecords.notify([siteId], []);
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

  // How long sites stay in this browser (Site panel); read before sites are loaded, since
  // start-up removes expired sites first.
  store.setState({ retentionDays: parseRetentionDays(readRetentionDaysRaw()) });
  // Ask the browser not to clear this site's storage on its own (Chrome may otherwise when
  // the disk is low). Removal then follows the user's choice only.
  void navigator.storage?.persist?.().then(() => refreshStorageInfo()).catch(() => undefined);

  await Promise.all([
    refreshCapabilities(),
    registerServiceWorker(),
    createDefaultOrLoadSites(),
  ]);
  setupLaunchQueue();
  // A tab left open for days still removes sites past their date (hourly check).
  setInterval(() => void actions.purgeExpiredSites().catch(() => undefined), 3_600_000);
}

void bootstrap();
