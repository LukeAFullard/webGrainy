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
  savePhoto,
  savePhotoResult,
  saveSite,
  type PhotoRecord,
  type SiteRecord,
} from '../modules/projectStorage.js';
import {
  computeExtendedMorphometrics,
  computeFabricRoseStats,
  computeWentworthHistogram,
} from '../modules/morphometricsExt.js';
import {
  rectifyPerspective,
  filterGrainsByRoiAndExclusion,
} from '../modules/roiAndRectify.js';
import {
  analyzeSite,
  type SitePhotoInput,
} from '../modules/siteAnalysis.js';
import { ScaleCalibrator } from '../modules/interactiveEditor.js';
import {
  renderAspectRatioHistogramSvg,
  renderConvergenceChartSvg,
  renderFabricRoseSvg,
  renderJackknifeChartSvg,
  renderPsdChartSvg,
  renderWentworthHistogramSvg,
} from './charts.js';
import { CanvasViewport } from './canvasViewport.js';
import { parseJpegExifMetadata } from './exif.js';
import {
  handleExportAction,
  renderAboutModalHtml,
  renderExportModalHtml,
  renderModelsModalHtml,
} from './modals.js';
import {
  AppStore,
  toAnalysisConfig,
  type AppState,
  type DashboardTab,
  type EditorToolMode,
} from './state.js';

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

const store = new AppStore();

const engine = new ImageGrainsEngine({
  useWorker: true,
  workerFactory: () =>
    new Worker('./workers/grainPostprocess.worker.js', { type: 'module' }),
  sessionCreateOptions: { wasmPaths: './ort/' },
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

function buildSiteInputs(state: AppState): SitePhotoInput[] {
  const inputs: SitePhotoInput[] = [];
  for (const photo of state.photos) {
    const session = state.sessions.get(photo.photoId);
    if (!session) continue;
    inputs.push({
      photoId: photo.photoId,
      label: photo.label,
      included: photo.included,
      session,
      ...(photo.roiConfig !== undefined ? { roiConfig: photo.roiConfig } : {}),
      ...(photo.faciesWeight !== undefined ? { faciesWeight: photo.faciesWeight } : {}),
      ...(photo.metadata !== undefined ? { metadata: photo.metadata } : {}),
    });
  }
  return inputs;
}

function recomputeReports(): void {
  const state = store.getState();
  const activePhoto = getActivePhoto(state);
  const activeSession = activePhoto
    ? state.sessions.get(activePhoto.photoId) ?? null
    : null;
  const singlePhotoStats = activeSession ? activeSession.getStats() : null;

  const siteInputs = buildSiteInputs(state);
  let siteReport = null;
  let siteReportError: string | null = null;
  if (siteInputs.some((p) => p.included)) {
    try {
      siteReport = analyzeSite(siteInputs, state.siteOptions);
    } catch (err) {
      siteReport = null;
      siteReportError = err instanceof Error ? err.message : String(err);
    }
  }

  store.setState({ singlePhotoStats, siteReport, siteReportError });
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
  for (const url of state.thumbUrls.values()) {
    URL.revokeObjectURL(url);
  }

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
          if (p.roiConfig) sess.setRoiConfig(p.roiConfig);
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

async function runBatch(photoIds?: string[]): Promise<void> {
  const state = store.getState();
  const site = getActiveSite(state);
  if (!site || state.batchRunning) return;

  batchAbortController = new AbortController();
  const analysisConfig = toAnalysisConfig(state.analysisParams);
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
      },
      onPhotoStart: (photo) => {
        const nextStatuses = new Map(store.getState().photoStatuses);
        nextStatuses.set(photo.photoId, 'running');
        store.setState({ photoStatuses: nextStatuses });
      },
      onPhotoComplete: (photo, session) => {
        const prev = store.getState();
        const roi = prev.photos.find((p) => p.photoId === photo.photoId)?.roiConfig ?? photo.roiConfig;
        if (roi) session.setRoiConfig(roi);
        const nextSessions = new Map(prev.sessions);
        nextSessions.set(photo.photoId, session);
        const nextStatuses = new Map(prev.photoStatuses);
        nextStatuses.set(photo.photoId, 'done');
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

    const errs = store.getState().photoErrors;
    const firstFailure = result.failedPhotoIds
      .map((id) => errs.get(id))
      .find((m): m is string => typeof m === 'string' && m.length > 0);
    store.setState({
      statusMessage: result.aborted
        ? `Batch cancelled (${result.completed}/${result.total} completed)`
        : `Batch complete: ${result.completed} done, ${result.failed} failed` +
          (firstFailure ? ` — ${firstFailure}` : ''),
    });
  } catch (err) {
    store.setState({
      statusMessage: `Batch error: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    batchAbortController = null;
    store.setState({ batchRunning: false, batchProgress: null });
    recomputeReports();
    await refreshCapabilities();
  }
}

async function persistActiveSession(photoId: string, session: AnalysisSession): Promise<void> {
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
  const gpuLabel = caps
    ? caps.hasWebGPU
      ? 'WebGPU Ready'
      : caps.hasWasmSimd
        ? 'WASM SIMD'
        : 'WASM Basic'
    : 'Initializing…';
  const swLabel =
    state.swStatus === 'ready'
      ? 'SW Offline Ready'
      : state.swStatus === 'registering'
        ? 'SW Registering'
        : 'SW Local/File';

  topbarEl.innerHTML = `
    <div class="topbar-left">
      <div class="brand">
        <span>webGrainy</span>
        <span class="brand-sub">ImageGrains 2.0 Web</span>
      </div>
      <span class="privacy-badge">100% Local Processing — No Data Leaves Your Device</span>
    </div>
    <div class="topbar-center">
      <span class="status-pill ${caps?.hasWebGPU || caps?.hasWasmSimd ? 'ok' : ''}">
        <span class="dot" aria-hidden="true"></span>${gpuLabel}
      </span>
      <span class="status-pill ${state.swStatus === 'ready' ? 'ok' : ''}">
        <span class="dot" aria-hidden="true"></span>${swLabel}
      </span>
      <span class="status-pill ${state.isOnline ? '' : 'warn'}">
        <span class="dot" aria-hidden="true"></span>${state.isOnline ? 'Online (HF Ready)' : 'Offline Mode'}
      </span>
    </div>
    <div class="topbar-right">
      <button type="button" class="btn btn-sm" data-open-modal="models">Models (${caps?.cachedModels.length ?? 0}/2)</button>
      <button type="button" class="btn btn-sm" data-open-modal="export">Export</button>
      <button type="button" class="btn btn-sm" data-open-modal="about">About &amp; Citations</button>
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
  const prevDetailsOpen = sidebarEl.querySelector('details')?.open ?? true;
  const prevPhotoScroll = sidebarEl.querySelector('.photo-list')?.scrollTop ?? 0;

  sidebarEl.innerHTML = `
    <div class="panel-section">
      <div class="panel-header">
        <span class="panel-title">Site Workspace</span>
        <div class="row">
          <button type="button" class="btn btn-sm" data-action="new-site">+ Site</button>
          <button type="button" class="btn btn-sm" data-action="import-archive">Import</button>
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
    </div>

    <div class="panel-section">
      <div class="panel-header">
        <span class="panel-title">Photos (${state.photos.length})</span>
        <div class="row">
          ${
            state.batchRunning
              ? `<button type="button" class="btn btn-sm btn-danger" data-action="cancel-batch">Cancel</button>`
              : `<button type="button" class="btn btn-sm btn-primary" data-action="run-batch" ${state.photos.length === 0 ? 'disabled' : ''}>Run Pending (${pendingCount})</button>`
          }
        </div>
      </div>

      <button type="button" class="dropzone" id="photo-dropzone">
        <span class="dropzone-text">Drop gravel photos here or <strong>click to browse</strong></span>
        <span style="display:block;font-size:0.65rem;color:var(--text-muted);margin-top:2px;">Local-only EXIF &amp; dimension parsing</span>
      </button>

      ${
        state.batchRunning && state.batchProgress
          ? `<div style="margin-top:8px;">
              <div class="row-between" style="font-size:0.7rem;margin-bottom:3px;">
                <span>${esc(state.batchProgress.currentLabel)}</span>
                <span>${state.batchProgress.completed}/${state.batchProgress.total}</span>
              </div>
              <progress class="native-progress" value="${state.batchProgress.completed}" max="${Math.max(1, state.batchProgress.total)}" aria-label="Batch segmentation progress"></progress>
            </div>`
          : ''
      }

      <div class="photo-list" style="margin-top:8px;">
        ${
          state.photos.length === 0
            ? `<div style="font-size:0.7rem;color:var(--text-muted);padding:8px 0;">No photos in this site yet.</div>`
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
                    </div>
                  `;
                })
                .join('')
        }
      </div>
    </div>

    <div class="panel-section">
      <details ${prevDetailsOpen ? 'open' : ''}>
        <summary>Inference &amp; Post-Processing Controls</summary>
        <div class="grid-2" style="margin-top:8px;">
          <label class="field-label">
            Model
            <select class="select" data-param="model">
              <option value="auto" ${p.model === 'auto' ? 'selected' : ''}>Auto (Router)</option>
              <option value="unet" ${p.model === 'unet' ? 'selected' : ''}>U-Net (25MB)</option>
              <option value="cpsam" ${p.model === 'cpsam' ? 'selected' : ''}>CP-SAM (588MB)</option>
            </select>
          </label>
          <label class="field-label">
            Scale Mode
            <select class="select" data-param="scaleMode">
              <option value="auto" ${p.scaleMode === 'auto' ? 'selected' : ''}>Auto (≤1024px)</option>
              <option value="1.0x" ${p.scaleMode === '1.0x' ? 'selected' : ''}>1.0x Full</option>
              <option value="0.5x" ${p.scaleMode === '0.5x' ? 'selected' : ''}>0.5x</option>
              <option value="0.25x" ${p.scaleMode === '0.25x' ? 'selected' : ''}>0.25x</option>
            </select>
          </label>
          <label class="field-label">
            Flow Threshold
            <input class="input" type="number" step="0.05" min="0.05" max="1" value="${p.flowThreshold}" data-param="flowThreshold" />
          </label>
          <label class="field-label">
            Cellprob Thresh
            <input class="input" type="number" step="0.1" min="-4" max="4" value="${p.cellprobThreshold}" data-param="cellprobThreshold" />
          </label>
          <label class="field-label">
            Min Size (px²)
            <input class="input" type="number" step="1" min="4" max="500" value="${p.minSize}" data-param="minSize" />
          </label>
          <label class="field-label">
            Max Area Frac
            <input class="input" type="number" step="0.01" min="0.01" max="0.9" value="${p.maxGrainAreaFraction}" data-param="maxGrainAreaFraction" />
          </label>
          <label class="field-label">
            Min b-axis (px)
            <input class="input" type="number" step="1" min="0" max="50" value="${state.siteOptions.minBaxisPx ?? 15}" data-site-opt="minBaxisPx" />
          </label>
          <label class="field-label">
            CLAHE Clip
            <input class="input" type="number" step="0.5" min="1" max="8" value="${p.claheClipLimit}" data-param="claheClipLimit" />
          </label>
        </div>
        <div class="row-between" style="margin-top:8px;">
          <label class="checkbox-label">
            <input type="checkbox" data-param="applyClahe" ${p.applyClahe ? 'checked' : ''} /> Apply CLAHE
          </label>
          <button type="button" class="btn btn-sm" data-action="run-active" ${!state.activePhotoId || state.batchRunning ? 'disabled' : ''}>Analyze Active Photo</button>
        </div>
      </details>
    </div>
  `;

  const photoListEl = sidebarEl.querySelector('.photo-list');
  if (photoListEl && prevPhotoScroll > 0) {
    photoListEl.scrollTop = prevPhotoScroll;
  }
}

function renderToolbarAndOverlays(state: AppState): void {
  const activePhoto = getActivePhoto(state);
  const session = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;

  const tools: Array<{ id: EditorToolMode; label: string }> = [
    { id: 'inspect', label: 'Inspect' },
    { id: 'split', label: 'Split' },
    { id: 'merge', label: 'Merge' },
    { id: 'delete', label: 'Delete' },
    { id: 'addPolygon', label: '+ Polygon' },
    { id: 'excludePoly', label: 'Excl Poly' },
    { id: 'excludeBrush', label: 'Excl Brush' },
    { id: 'calibrate', label: 'Calibrate' },
    { id: 'rectify', label: '4-Pt Rectify' },
  ];

  toolbarEl.innerHTML = `
    ${tools
      .map(
        (t) =>
          `<button type="button" class="btn btn-sm ${state.activeTool === t.id ? 'active' : ''}" aria-pressed="${state.activeTool === t.id ? 'true' : 'false'}" data-tool="${t.id}">${t.label}</button>`,
      )
      .join('')}
    ${
      state.activeTool === 'merge' && state.selectedGrainIds.size >= 2
        ? `<button type="button" class="btn btn-sm btn-primary" data-action="commit-merge">Merge (${state.selectedGrainIds.size})</button>`
        : ''
    }
    <span class="toolbar-sep" aria-hidden="true"></span>
    <button type="button" class="btn btn-sm" data-action="undo" ${session?.canUndo ? '' : 'disabled'}>Undo</button>
    <button type="button" class="btn btn-sm" data-action="redo" ${session?.canRedo ? '' : 'disabled'}>Redo</button>
    <button type="button" class="btn btn-sm" data-action="fit-view" ${activePhoto ? '' : 'disabled'}>Fit</button>
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

  subToolbarEl.innerHTML = `
    <label class="checkbox-label"><input type="checkbox" data-ov="instanceIds" ${ov.instanceIds ? 'checked' : ''} /> IDs</label>
    <label class="checkbox-label"><input type="checkbox" data-ov="wentworthColors" ${ov.wentworthColors ? 'checked' : ''} /> Wentworth</label>
    <label class="checkbox-label"><input type="checkbox" data-ov="ellipses" ${ov.ellipses ? 'checked' : ''} /> a/b Ellipses</label>
    <label class="checkbox-label"><input type="checkbox" data-ov="orientations" ${ov.orientations ? 'checked' : ''} /> Vectors</label>
    <label class="checkbox-label"><input type="checkbox" data-ov="borderTruncated" ${ov.borderTruncated ? 'checked' : ''} /> Border/Trunc</label>
    <label class="checkbox-label">Opacity <input type="range" min="0" max="1" step="0.05" value="${ov.opacity}" data-ov="opacity" style="width:65px;" /></label>
    <label class="checkbox-label"><input type="checkbox" data-ov="loupe" ${ov.loupe ? 'checked' : ''} /> Loupe (${ov.loupeZoom}×)</label>
    ${toolPrompt}
  `;
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
      const ext = computeExtendedMorphometrics(
        session.getWorkingMasks(),
        [grain],
        session.workingImage.width,
        session.workingImage.height,
        session.workingImage.effectiveScaleFactor,
        session.getCalibration()?.mmPerPx,
      )[0];
      inspectorEl.style.display = 'block';
      inspectorEl.innerHTML = `
        <div class="row-between" style="margin-bottom:4px;">
          <strong>Grain #${grain.id}</strong>
          <button type="button" class="btn btn-sm" data-action="close-inspector" aria-label="Close grain inspector">×</button>
        </div>
        <div style="font-family:var(--font-mono);line-height:1.5;">
          <div title="Minor axis of the moment-equivalent ellipse (not a caliper b-axis)">b (ellipse minor): ${grain.bAxisMm !== undefined ? `${grain.bAxisMm.toFixed(2)} mm` : `${grain.bAxisPx.toFixed(1)} px`}</div>
          <div title="Major axis of the moment-equivalent ellipse">a (ellipse major): ${grain.aAxisMm !== undefined ? `${grain.aAxisMm.toFixed(2)} mm` : `${grain.aAxisPx.toFixed(1)} px`}</div>
          <div>d_eq: ${grain.dEqMm !== undefined ? `${grain.dEqMm.toFixed(2)} mm` : `${grain.dEqPx.toFixed(1)} px`}</div>
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

function renderDashboard(state: AppState): void {
  const report = state.siteReport;
  const single = state.singlePhotoStats;
  const activePhoto = getActivePhoto(state);
  const activeSession = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;
  const isSite = state.dashboardScope === 'site';
  const lightTheme = isLightColorScheme();

  const psd = isSite ? report?.psd : single?.areaWeightedB;
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
    const svg = psd
      ? renderPsdChartSvg({
          psd,
          unit,
          xAxis: state.psdXAxis,
          title: isSite ? 'Pooled Site Cumulative PSD' : 'Active Photo Cumulative PSD',
          subtitle: isSite && report ? `${report.includedPhotoCount} photos, n=${report.validGrainCount}` : undefined,
          ciLower: isSite ? report?.bootstrapCi.lower : undefined,
          ciUpper: isSite ? report?.bootstrapCi.upper : undefined,
          perPhotoCurves: isSite ? report?.perPhoto : undefined,
          lightTheme,
        })
      : `<svg viewBox="0 0 400 220" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="220" fill="${lightTheme ? '#ffffff' : '#0c1014'}"/><text x="200" y="110" text-anchor="middle" fill="${lightTheme ? '#4a5568' : '#8fa0b2'}" font-size="12" font-family="system-ui, sans-serif">No segmented grains yet</text></svg>`;

    tabContent = `
      <div class="row-between" style="margin-top:8px;">
        <div class="row">
          <button type="button" class="btn btn-sm ${state.psdXAxis === 'mm' ? 'active' : ''}" aria-pressed="${state.psdXAxis === 'mm' ? 'true' : 'false'}" data-psd-x="mm">mm (log₁₀)</button>
          <button type="button" class="btn btn-sm ${state.psdXAxis === 'phi' ? 'active' : ''}" aria-pressed="${state.psdXAxis === 'phi' ? 'true' : 'false'}" data-psd-x="phi">phi (φ)</button>
        </div>
        ${
          report
            ? `<span style="font-size:0.65rem;color:var(--text-secondary);">${Math.round(report.bootstrapCi.confidenceLevel * 100)}% CI: [${report.bootstrapCi.lower.D50.toFixed(1)}, ${report.bootstrapCi.upper.D50.toFixed(1)}] ${unit}</span>`
            : ''
        }
      </div>
      <div class="chart-box">${svg}</div>
      ${
        fw
          ? `<div class="stat-grid" style="margin-top:8px;">
              <div class="stat-card"><div class="stat-label">Folk &amp; Ward Mean</div><div class="stat-value">${fw.meanMm.toFixed(1)} mm</div><div class="stat-sub">${fw.meanPhi.toFixed(2)} φ</div></div>
              <div class="stat-card"><div class="stat-label">Sorting (σ_I)</div><div class="stat-value">${fw.sortingPhi.toFixed(2)} φ</div><div class="stat-sub">${esc(fw.sortingLabel)}</div></div>
              <div class="stat-card"><div class="stat-label">Skew / Kurt</div><div class="stat-value">${fw.skewnessPhi.toFixed(2)}</div><div class="stat-sub">${esc(fw.skewnessLabel)} · K=${fw.kurtosisPhi.toFixed(2)}</div></div>
            </div>`
          : ''
      }
    `;
  } else if (state.dashboardTab === 'adequacy') {
    const adeq = report?.adequacy;
    const convSvg = renderConvergenceChartSvg(report?.convergence ?? [], lightTheme);
    const jackSvg = renderJackknifeChartSvg(report?.jackknife ?? null, lightTheme);
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
      <div class="chart-box">${convSvg}</div>
      <div class="chart-box">${jackSvg}</div>
    `;
  } else if (state.dashboardTab === 'shape') {
    const bins =
      state.histogramStepPhi === 0.5
        ? report?.wentworthHistogram05Phi ?? []
        : report?.wentworthHistogram10Phi ?? [];
    const activeGrains = activeSession ? activeSession.getResult().grains : [];
    const extGrains =
      activeSession && activeGrains.length > 0
        ? computeExtendedMorphometrics(
            activeSession.getWorkingMasks(),
            activeGrains,
            activeSession.workingImage.width,
            activeSession.workingImage.height,
            activeSession.workingImage.effectiveScaleFactor,
            activeSession.getCalibration()?.mmPerPx,
          )
        : [];
    const packingInfo =
      activeSession && activePhoto?.roiConfig
        ? filterGrainsByRoiAndExclusion(
            activeSession.getWorkingMasks(),
            activeSession.getResult().grains,
            activeSession.workingImage.width,
            activeSession.workingImage.height,
            activeSession.workingImage.effectiveScaleFactor,
            activePhoto.roiConfig,
            activeSession.getCalibration()?.mmPerPx,
          )
        : null;

    tabContent = `
      <div class="row-between" style="margin-top:8px;">
        <div class="row">
          <button type="button" class="btn btn-sm ${state.histogramStepPhi === 0.5 ? 'active' : ''}" aria-pressed="${state.histogramStepPhi === 0.5 ? 'true' : 'false'}" data-phi-step="0.5">0.5 φ bins</button>
          <button type="button" class="btn btn-sm ${state.histogramStepPhi === 1.0 ? 'active' : ''}" aria-pressed="${state.histogramStepPhi === 1.0 ? 'true' : 'false'}" data-phi-step="1.0">1.0 φ bins</button>
        </div>
        ${
          packingInfo
            ? `<span style="font-size:0.7rem;color:var(--text-secondary);">Clast Packing: ${packingInfo.clastPackingPct.toFixed(1)}% · Matrix: ${packingInfo.exposedMatrixPct.toFixed(1)}%</span>`
            : ''
        }
      </div>
      <div class="chart-box">${renderWentworthHistogramSvg(bins, lightTheme)}</div>
      <div class="chart-box">${renderAspectRatioHistogramSvg(extGrains, lightTheme)}</div>
    `;
  } else {
    const rose =
      isSite && report
        ? report.fabricRose
        : computeFabricRoseStats(activeSession ? activeSession.getResult().grains : [], {
            weighted: true,
            binCount: 12,
          });
    tabContent = `
      <div class="chart-box">${renderFabricRoseSvg(rose, lightTheme)}</div>
      <div class="basis-banner">
        Axial 180° double-angle statistics (Curray 1956; Mardia &amp; Jupp 2000). 0° = Image Vertical (Top/Bottom), 90° = Image Horizontal.
      </div>
    `;
  }

  const prevDashScroll = dashboardEl.scrollTop;

  dashboardEl.innerHTML = `
    <div class="panel-section">
      <div class="row-between" style="margin-bottom:6px;">
        <span class="panel-title">Scientific Dashboard</span>
        <div class="row">
          <button type="button" class="btn btn-sm ${isSite ? 'active' : ''}" aria-pressed="${isSite ? 'true' : 'false'}" data-scope="site">Pooled Site</button>
          <button type="button" class="btn btn-sm ${!isSite ? 'active' : ''}" aria-pressed="${!isSite ? 'true' : 'false'}" data-scope="photo">Active Photo</button>
        </div>
      </div>
      <div class="grid-2">
        <label class="field-label">
          Pooling Mode
          <select class="select" data-site-opt="poolingMode">
            <option value="physical-area" ${state.siteOptions.poolingMode === 'physical-area' ? 'selected' : ''}>Physical Area-Weighted</option>
            <option value="equal-photo" ${state.siteOptions.poolingMode === 'equal-photo' ? 'selected' : ''}>Equal-Photo Weighted</option>
            <option value="virtual-wolman-grid" ${state.siteOptions.poolingMode === 'virtual-wolman-grid' ? 'selected' : ''}>Virtual Wolman Grid</option>
            <option value="number-weighted" ${state.siteOptions.poolingMode === 'number-weighted' ? 'selected' : ''}>Number-Weighted</option>
            <option value="facies-weighted" ${state.siteOptions.poolingMode === 'facies-weighted' ? 'selected' : ''}>Facies-Weighted</option>
          </select>
        </label>
        <label class="field-label" style="justify-content:flex-end;">
          <span class="checkbox-label" style="margin-top:16px;">
            <input type="checkbox" data-site-opt="harmonizePhysicalCutoff" ${state.siteOptions.harmonizePhysicalCutoff !== false ? 'checked' : ''} /> Harmonize Cutoff
          </span>
        </label>
      </div>
      <div class="basis-banner">${esc(basisLabel)}${
        !isSite && single
          ? ` · n = ${single.includedGrains}${activeSession && activeSession.getRoiExcludedGrainCount() > 0 ? ` (${activeSession.getRoiExcludedGrainCount()} excluded by ROI)` : ''}`
          : ''
      }</div>
      ${(() => {
        const warns = isSite ? report?.warnings ?? [] : single?.warnings ?? [];
        return warns.length > 0
          ? `<div class="warning-banner" role="alert">${warns.map(esc).join('<br/>')}</div>`
          : '';
      })()}
      <div class="stat-grid" style="margin-top:8px;">
        <div class="stat-card"><div class="stat-label">D₁₆</div><div class="stat-value">${psd ? psd.D16.toFixed(1) : '—'}</div><div class="stat-sub">${unit}</div></div>
        <div class="stat-card"><div class="stat-label">D₅₀ (Median)</div><div class="stat-value">${psd ? psd.D50.toFixed(1) : '—'}</div><div class="stat-sub">${unit}</div></div>
        <div class="stat-card"><div class="stat-label">D₈₄</div><div class="stat-value">${psd ? psd.D84.toFixed(1) : '—'}</div><div class="stat-sub">${unit}</div></div>
      </div>
      <p class="metric-note">Size metric: minor axis of the moment-equivalent ellipse of each grain's visible outline — not a sieve or caliper b-axis (see min Feret in the pooled grains CSV).</p>
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
    prev.siteOptions.minBaxisPx !== state.siteOptions.minBaxisPx
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
            <div>Drop or select gravel photos in the left sidebar</div>
            <div style="font-size:0.75rem;">Wheel / ± = Zoom · Arrows / Space / Middle-Drag = Pan · Ctrl+Z/Y = Undo/Redo</div>
          </div>
          <div class="inspector-card" id="inspector-card" style="display:none;"></div>
        </div>
        <div class="viewport-footer" id="viewport-footer"></div>
      </section>
      <aside class="dashboard-right" id="dashboard-right" aria-label="Scientific Dashboard"></aside>
    </main>
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
        if (updated.roiConfig) state.sessions.get(photo.photoId)?.setRoiConfig(updated.roiConfig);
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
        if (updated.roiConfig) state.sessions.get(photo.photoId)?.setRoiConfig(updated.roiConfig);
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

    const modalBtn = target.closest<HTMLElement>('[data-open-modal]');
    if (modalBtn) {
      const m = modalBtn.dataset['openModal'] as AppState['activeModal'];
      store.setState({ activeModal: m });
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
      if (act === 'new-site') {
        const newSite: SiteRecord = {
          siteId: makeId('site'),
          name: `Field Site ${state.sites.length + 1}`,
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
        void handleExportAction(
          kind,
          getActiveSite(st),
          activePhoto,
          activeSession,
          st.siteReport,
          buildSiteInputs(st),
          st.psdXAxis,
        );
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
      store.setState({ dashboardScope: scopeBtn.dataset['scope'] as 'site' | 'photo' });
      return;
    }

    const psdXBtn = target.closest<HTMLElement>('[data-psd-x]');
    if (psdXBtn) {
      store.setState({ psdXAxis: psdXBtn.dataset['psdX'] as 'mm' | 'phi' });
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
        (nextOpts as Record<string, unknown>)[siteOptKey] = target.value;
      }
      const activeSite = getActiveSite(st);
      if (activeSite) {
        void saveSite({ ...activeSite, options: nextOpts, updatedAt: Date.now() });
      }
      store.setState({ siteOptions: nextOpts });
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
      navigator.serviceWorker.addEventListener('controllerchange', () => {
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
  renderAll(store.getState());

  await Promise.all([
    refreshCapabilities(),
    registerServiceWorker(),
    createDefaultOrLoadSites(),
  ]);
  setupLaunchQueue();
}

void bootstrap();
