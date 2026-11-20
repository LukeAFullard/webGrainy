/**
 * App actions: the operations that change data (storage, engine, app state), not the screen.
 * Everything they need comes in through `WorkspaceDeps`, so tests can pass a fake engine,
 * in-memory storage and no-op UI hooks. `main.ts` owns the DOM and calls these.
 */
import type { CalibrationResult, Point2D, StorageQuotaInfo } from '../types/index.js';
import { AnalysisSession } from '../modules/analysisSession.js';
import type { ImageGrainsEngine } from '../modules/engine.js';
import * as projectStorage from '../modules/projectStorage.js';
import type { PhotoRecord, SiteRecord } from '../modules/projectStorage.js';
import { buildSiteInputs, computeWorkspaceReports, effectiveRoi } from '../modules/siteWorkspace.js';
import type { SiteAnalysisOptions, SitePhotoInput } from '../modules/siteAnalysis.js';
import {
  COMPARE_COLORS,
  computeComparedSites,
  loadStoredSiteInputs,
  type SiteForComparison,
} from '../modules/siteComparison.js';
import { ScaleCalibrator } from '../modules/interactiveEditor.js';
import {
  scaleCalibrationAndRoi,
  type EnhanceKind,
  type EnhanceProgressEvent,
} from '../modules/imageEnhance.js';
import { isSupportedImageFile } from '../modules/tiffDecode.js';
import { photoProcessingHistory, type PhotoEnhancementInfo, type SitePhotoMetadata } from '../modules/siteTypes.js';
import { toAnalysisConfig, type AppState, type AppStore } from './state.js';

/** The storage functions the actions use (projectStorage by default). */
export type WorkspaceStorage = Pick<
  typeof projectStorage,
  'listSitePhotos' | 'listSites' | 'getPhotoResult' | 'runSiteBatch' | 'savePhoto' | 'savePhotoResult' | 'saveSite' | 'deletePhoto'
>;

/** The engine methods the actions use. */
export type WorkspaceEngine = Pick<ImageGrainsEngine, 'initialize' | 'getWebGpuDisabledReason'> &
  Partial<Pick<ImageGrainsEngine, 'releaseSessions'>>;

/** Activity bar (stages, tiles, time left) shown while a batch runs. */
export interface ActivityHooks {
  begin(totalPhotos: number): void;
  photoStarted(index: number, label: string): void;
  setTotal(totalPhotos: number): void;
  end(): void;
}

/** Long-job signals: screen wake lock and the tab-title / notification "done" signal. */
export interface JobHooks {
  acquireWakeLock(): void;
  releaseWakeLock(): void;
  start(total: number): void;
  progress(completed: number, total: number): void;
  finish(cancelled: boolean, body: string): void;
}

export interface ImageIo {
  /** Optional pre-import conversion (e.g. decoding TIFF/GeoTIFF to PNG + auto scale). */
  prepareFile?(file: File): Promise<{
    blob: Blob;
    width: number;
    height: number;
    metadata?: PhotoRecord['metadata'];
    calibration?: CalibrationResult;
  } | null>;
  /** Pixel size of an image file. */
  imageSize(file: Blob): Promise<{ width: number; height: number }>;
  /** Optional camera metadata (EXIF) of an image file. */
  metadata(file: File): Promise<PhotoRecord['metadata'] | undefined>;
  /** Perspective-corrects a photo; returns the new PNG and its size and scale. */
  rectify(
    image: Blob,
    corners: [Point2D, Point2D, Point2D, Point2D],
    physWidthMm: number,
    physHeightMm: number,
  ): Promise<{ blob: Blob; width: number; height: number; calibration: CalibrationResult } | null>;
  /** Optional memory-isolated AI enhancement (2x upscale or deblur). */
  enhance?(
    image: Blob,
    kind: EnhanceKind,
    onProgress?: (ev: EnhanceProgressEvent) => void,
  ): Promise<{
    blob: Blob;
    width: number;
    height: number;
    blurScore?: number;
    enhancement: PhotoEnhancementInfo;
  } | null>;
}

export interface WorkspaceDeps {
  store: AppStore;
  engine: WorkspaceEngine;
  /** Engine passed to the batch runner (the real one in the app). */
  batchEngine: Parameters<WorkspaceStorage['runSiteBatch']>[0]['engine'];
  storage?: WorkspaceStorage;
  /** Tells other open tabs that these sites / photos (records or results) changed. */
  notifyRecords?: (siteIds: string[], photoIds: string[]) => void;
  loadStoredSiteInputs?: typeof loadStoredSiteInputs;
  checkStorageQuota?: () => Promise<StorageQuotaInfo>;
  images: ImageIo;
  /** Redraws the photo viewport (optionally fitting the photo to view). */
  syncViewport(fitToView: boolean): Promise<void>;
  activity: ActivityHooks;
  job: JobHooks;
  /** Records that a site has changes not yet backed up. */
  markSiteChanged(siteId: string): void;
  /** Called after jobs that may change how much browser storage is used. */
  onStorageChanged(): void;
  makeId(prefix: string): string;
  yieldToMain(): Promise<void>;
  createObjectUrl?(blob: Blob): string;
  revokeObjectUrl?(url: string): void;
}

export function getActiveSite(state: AppState): SiteRecord | null {
  return state.sites.find((s) => s.siteId === state.activeSiteId) ?? null;
}

export function getActivePhoto(state: AppState): PhotoRecord | null {
  return state.photos.find((p) => p.photoId === state.activePhotoId) ?? null;
}

export type WorkspaceActions = ReturnType<typeof createWorkspaceActions>;

export function createWorkspaceActions(deps: WorkspaceDeps) {
  const { store, engine, images, activity, job } = deps;
  const storage = deps.storage ?? projectStorage;
  const loadStored = deps.loadStoredSiteInputs ?? loadStoredSiteInputs;
  const createUrl = deps.createObjectUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = deps.revokeObjectUrl ?? ((u: string) => URL.revokeObjectURL(u));

  let batchAbortController: AbortController | null = null;
  let lastBatchCancelled = false;
  /** True while "Analyse all sites" runs, so the inner open-site batch does not end the job signals. */
  let allSitesJobActive = false;
  let cachedQuota: StorageQuotaInfo | null = null;
  const storedSiteInputsCache = new Map<string, SitePhotoInput[]>();
  let comparisonRun = 0;

  /** Saves a photo record and notes that its site has changes not yet backed up. */
  async function savePhoto(photo: PhotoRecord): Promise<void> {
    deps.markSiteChanged(photo.siteId);
    await storage.savePhoto(photo);
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
      cachedQuota = deps.checkStorageQuota ? await deps.checkStorageQuota().catch(() => null) : null;
      store.setState({ capabilities });
    } catch (err) {
      store.setState({
        statusMessage: `Engine init warning: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** Reads a photo's stored result into the session / status / error maps. */
  async function loadPhotoResult(
    p: PhotoRecord,
    siteOptions: SiteAnalysisOptions,
    sessions: Map<string, AnalysisSession>,
    photoStatuses: Map<string, 'pending' | 'running' | 'done' | 'error'>,
    photoErrors: Map<string, string>,
  ): Promise<void> {
    sessions.delete(p.photoId);
    photoErrors.delete(p.photoId);
    const res = await storage.getPhotoResult(p.photoId);
    if (!res) {
      photoStatuses.set(p.photoId, 'pending');
      return;
    }
    photoStatuses.set(p.photoId, res.status === 'running' ? 'pending' : res.status);
    if (res.errorMessage) photoErrors.set(p.photoId, res.errorMessage);
    if (res.serializedSession) {
      try {
        const sess = AnalysisSession.fromSerialized(res.serializedSession);
        if (p.calibration) sess.setCalibration(p.calibration);
        if (p.roiConfig) sess.setRoiConfig(effectiveRoi(p, siteOptions));
        sessions.set(p.photoId, sess);
      } catch {
        photoStatuses.set(p.photoId, 'pending');
      }
    }
  }

  /**
   * Another tab changed these sites / photos: reload the site list, and the open site's
   * changed photos (records and results) in place, keeping the open photo. Skipped while
   * this tab analyses or enhances (its own writes would race); its next save still merges.
   */
  async function refreshFromStorage(notice: { siteIds: readonly string[]; photoIds: readonly string[] }): Promise<void> {
    const sites = await storage.listSites();
    const st = store.getState();
    const siteId = st.activeSiteId;
    const site = sites.find((x) => x.siteId === siteId);
    if (!siteId || !site || st.batchRunning || enhancing) {
      store.setState({ sites });
      return;
    }
    const touched = notice.siteIds.includes(siteId) || notice.photoIds.some((id) => st.photos.some((p) => p.photoId === id));
    if (!touched) {
      store.setState({ sites });
      return;
    }
    const siteOptions = { ...site.options };
    const photos = await storage.listSitePhotos(siteId);
    const changed = new Set(notice.photoIds);
    const sessions = new Map(st.sessions);
    const photoStatuses = new Map(st.photoStatuses);
    const photoErrors = new Map(st.photoErrors);
    const thumbUrls = new Map(st.thumbUrls);
    const ids = new Set(photos.map((p) => p.photoId));
    for (const [id, url] of st.thumbUrls) {
      if (!ids.has(id)) {
        revokeUrl(url);
        thumbUrls.delete(id);
        sessions.delete(id);
        photoStatuses.delete(id);
        photoErrors.delete(id);
      }
    }
    for (const p of photos) {
      const isNew = !st.thumbUrls.has(p.photoId);
      if (isNew || changed.has(p.photoId)) {
        if (!isNew && st.photos.find((x) => x.photoId === p.photoId)?.imageBlob !== p.imageBlob) {
          revokeUrl(st.thumbUrls.get(p.photoId)!);
          thumbUrls.set(p.photoId, createUrl(p.imageBlob));
        } else if (isNew) {
          thumbUrls.set(p.photoId, createUrl(p.imageBlob));
        }
        await loadPhotoResult(p, siteOptions, sessions, photoStatuses, photoErrors);
      }
    }
    const activePhotoId = st.activePhotoId !== null && ids.has(st.activePhotoId) ? st.activePhotoId : (photos[0]?.photoId ?? null);
    store.setState({ sites, photos, sessions, photoStatuses, photoErrors, thumbUrls, siteOptions, activePhotoId });
    recomputeReports();
    await deps.syncViewport(false);
  }

  async function loadSiteData(siteId: string): Promise<void> {
    const state = store.getState();
    // Revoke the previous thumbnails only after the new ones are in state: revoking them
    // up front left <img> elements pointing at dead blob: URLs if anything re-rendered the
    // sidebar during the awaits below (net::ERR_FILE_NOT_FOUND).
    const staleThumbUrls = [...state.thumbUrls.values()];

    // The previously active site may have new results: reload sites for comparison when needed.
    storedSiteInputsCache.clear();
    const photos = await storage.listSitePhotos(siteId);
    const sessions = new Map<string, AnalysisSession>();
    const photoStatuses = new Map<string, 'pending' | 'running' | 'done' | 'error'>();
    const photoErrors = new Map<string, string>();
    const thumbUrls = new Map<string, string>();

    const site = state.sites.find((s) => s.siteId === siteId);
    const nextSiteOptions = site ? { ...site.options } : state.siteOptions;

    for (const p of photos) {
      thumbUrls.set(p.photoId, createUrl(p.imageBlob));
      await loadPhotoResult(p, nextSiteOptions, sessions, photoStatuses, photoErrors);
    }

    store.setState({
      activeSiteId: siteId,
      photos,
      activePhotoId: photos[0]?.photoId ?? null,
      sessions,
      photoStatuses,
      photoErrors,
      thumbUrls,
      siteOptions: nextSiteOptions,
      selectedGrainIds: new Set(),
      inspectedGrainId: null,
      pendingCalibrationPoints: [],
      pendingRectifyPoints: [],
      photoFilter: 'all',
      photoSelectMode: false,
      selectedPhotoIds: new Set(),
    });
    for (const url of staleThumbUrls) revokeUrl(url);

    recomputeReports();
    await deps.syncViewport(true);
  }

  async function createDefaultOrLoadSites(): Promise<void> {
    let sites = await storage.listSites();
    if (sites.length === 0) {
      const defaultSite: SiteRecord = {
        siteId: deps.makeId('site'),
        name: 'Field Site 1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        options: store.getState().siteOptions,
        photoOrder: [],
      };
      await storage.saveSite(defaultSite);
      sites = [defaultSite];
    }
    store.setState({ sites });
    const first = sites[0];
    if (first) {
      await loadSiteData(first.siteId);
    }
  }

  async function handleFilesAdded(files: FileList | File[]): Promise<void> {
    const state = store.getState();
    const site = getActiveSite(state);
    if (!site) return;

    const added: PhotoRecord[] = [];
    let geoCalibratedCount = 0;
    let taskDeadline = performance.now() + 50;
    for (const file of Array.from(files)) {
      if (!isSupportedImageFile(file)) continue;
      try {
        const prepared = images.prepareFile ? await images.prepareFile(file) : null;
        const blob = prepared ? prepared.blob : file;
        const { width, height } = prepared
          ? { width: prepared.width, height: prepared.height }
          : await images.imageSize(file);
        const metadata = prepared
          ? prepared.metadata
          : await images.metadata(file).catch(() => undefined);
        if (prepared?.calibration) geoCalibratedCount++;
        const photo: PhotoRecord = {
          photoId: deps.makeId('photo'),
          siteId: site.siteId,
          label: file.name,
          imageBlob: blob,
          width,
          height,
          addedAt: Date.now(),
          included: true,
          ...(prepared?.calibration ? { calibration: prepared.calibration } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        };
        await savePhoto(photo);
        await storage.savePhotoResult({
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
        await deps.yieldToMain();
        taskDeadline = performance.now() + 50;
      }
    }

    if (added.length > 0) {
      const updatedSite: SiteRecord = {
        ...site,
        photoOrder: [...site.photoOrder, ...added.map((p) => p.photoId)],
        updatedAt: Date.now(),
      };
      await storage.saveSite(updatedSite);
      const sites = await storage.listSites();
      const geoNote =
        geoCalibratedCount > 0
          ? ` (${geoCalibratedCount} auto-calibrated from GeoTIFF scale)`
          : '';
      store.setState({ sites, statusMessage: `Added ${added.length} photo(s) locally${geoNote}` });
      await loadSiteData(site.siteId);
      const total = updatedSite.photoOrder.length;
      if (total > SITE_PHOTO_SOFT_LIMIT) {
        store.setState({
          statusMessage:
            `Added ${added.length} photo(s)${geoNote}. This site now has ${total} photos: above ${SITE_PHOTO_SOFT_LIMIT}, ` +
            'site statistics take a few seconds to update after each change and each analysed photo uses about 4 MB of memory. ' +
            'Consider splitting it into several sites (e.g. one per reach or survey).',
        });
      }
      const lastAdded = added[added.length - 1];
      if (lastAdded) {
        store.setState({ activePhotoId: lastAdded.photoId });
        recomputeReports();
        await deps.syncViewport(true);
      }
    }
  }

  /**
   * Analyses every not-yet-analysed photo in every site: the open site first (so its results
   * appear as usual), then the others, whose results are saved for when they are opened or
   * compared.
   */
  /** True (and says so) when a newer version took over this page: no new analyses. */
  function refuseIfStale(): boolean {
    if (!store.getState().staleBuild) return false;
    store.setState({ statusMessage: STALE_BUILD_MESSAGE });
    return true;
  }

  async function runAllSites(): Promise<void> {
    const start = store.getState();
    if (start.batchRunning || enhancing || refuseIfStale()) return;
    const activeId = start.activeSiteId;
    allSitesJobActive = true;
    job.acquireWakeLock();
    try {
      await runAllSitesInner(activeId);
    } finally {
      allSitesJobActive = false;
      job.releaseWakeLock();
    }
  }

  async function runAllSitesInner(activeId: string | null): Promise<void> {
    job.start(store.getState().photos.length);
    await runBatch();
    if (lastBatchCancelled) {
      job.finish(true, '');
      return; // Cancel stops the whole job, not just the open site.
    }
    const others = store.getState().sites.filter((s) => s.siteId !== activeId);
    // Count pending photos per site, so the progress bar can show the whole job.
    const pendingBySite: Array<{ siteId: string; name: string; count: number }> = [];
    for (const site of others) {
      let count = 0;
      for (const p of await storage.listSitePhotos(site.siteId)) {
        const r = await storage.getPhotoResult(p.photoId);
        if (!r || r.status === 'pending' || r.status === 'error' || r.status === 'running') count++;
      }
      if (count > 0) pendingBySite.push({ siteId: site.siteId, name: site.name, count });
    }
    const total = pendingBySite.reduce((n, s) => n + s.count, 0);
    if (total === 0) {
      store.setState({ statusMessage: 'All photos in all sites are analysed.' });
      job.finish(false, 'All photos in all sites are analysed.');
      return;
    }
    job.start(total);
    const controller = new AbortController();
    batchAbortController = controller;
    const analysisConfig = toAnalysisConfig(store.getState().analysisParams);
    activity.begin(total);
    store.setState({ batchRunning: true, statusMessage: `Analysing ${total} photo(s) in ${pendingBySite.length} other site(s)…` });
    let counter = 0;
    let done = 0;
    let failed = 0;
    try {
      for (const site of pendingBySite) {
        if (controller.signal.aborted) break;
        const res = await storage.runSiteBatch({
          siteId: site.siteId,
          engine: deps.batchEngine,
          analysisConfig,
          signal: controller.signal,
          onPhotoStart: (photo) => {
            counter += 1;
            job.progress(counter - 1, total);
            activity.photoStarted(counter, `${site.name} · ${photo.label}`);
          },
        });
        done += res.completed;
        failed += res.failed;
        if (res.completed > 0) deps.markSiteChanged(site.siteId);
      }
      const aborted = controller.signal.aborted;
      store.setState({
        statusMessage: aborted
          ? `Cancelled: ${done} of ${total} photos in other sites analysed.`
          : `All sites analysed: ${done} done, ${failed} failed in other sites.`,
      });
      job.finish(aborted, `All sites: ${done} photos analysed${failed > 0 ? `, ${failed} failed` : ''}.`);
    } catch (err) {
      store.setState({ statusMessage: `Batch error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      batchAbortController = null;
      store.setState({ batchRunning: false, batchProgress: null });
      activity.end();
      storedSiteInputsCache.clear();
      job.finish(true, ''); // no-op unless an error ended the job early
      deps.onStorageChanged();
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

  async function runBatch(photoIds?: string[]): Promise<void> {
    lastBatchCancelled = false;
    const state = store.getState();
    const site = getActiveSite(state);
    if (!site || state.batchRunning || enhancing || refuseIfStale()) return;

    const controller = new AbortController();
    batchAbortController = controller;
    const analysisConfig = toAnalysisConfig(state.analysisParams);
    const plannedTotal = photoIds?.length ?? state.photos.length;
    activity.begin(plannedTotal);
    let photoCounter = 0;
    job.acquireWakeLock();
    if (!allSitesJobActive) job.start(plannedTotal);
    store.setState({
      batchRunning: true,
      batchProgress: {
        completed: 0,
        total: plannedTotal,
        currentPhotoId: '',
        currentLabel: 'Starting…',
      },
      statusMessage: 'Running local segmentation…',
    });

    try {
      const result = await storage.runSiteBatch({
        siteId: site.siteId,
        engine: deps.batchEngine,
        ...(photoIds !== undefined ? { photoIds } : {}),
        analysisConfig,
        signal: controller.signal,
        onProgress: (p) => {
          store.setState({ batchProgress: p });
          if (!allSitesJobActive) job.progress(p.completed, p.total);
          if (p.total > 0) activity.setTotal(p.total);
        },
        onPhotoStart: (photo) => {
          photoCounter += 1;
          activity.photoStarted(photoCounter, photo.label);
          const nextStatuses = new Map(store.getState().photoStatuses);
          nextStatuses.set(photo.photoId, 'running');
          store.setState({ photoStatuses: nextStatuses });
        },
        onPhotoComplete: (photo, session) => {
          const prev = store.getState();
          const latestPhoto = prev.photos.find((p) => p.photoId === photo.photoId) ?? photo;
          const roi = effectiveRoi(latestPhoto, prev.siteOptions);
          if (roi) session.setRoiConfig(roi);
          // If the photo was calibrated after runSiteBatch read IndexedDB (or while saving),
          // keep the newer calibration on the completed session and persist it.
          const latestCal = latestPhoto.calibration;
          const sessCal = session.getCalibration();
          if (
            latestCal &&
            (!sessCal ||
              sessCal.mmPerPx !== latestCal.mmPerPx ||
              sessCal.physicalLengthMm !== latestCal.physicalLengthMm)
          ) {
            session.setCalibration(latestCal);
            void persistActiveSession(photo.photoId, session).catch(() => undefined);
          }
          const nextSessions = new Map(prev.sessions);
          nextSessions.set(photo.photoId, session);
          const nextStatuses = new Map(prev.photoStatuses);
          nextStatuses.set(photo.photoId, 'done');
          deps.markSiteChanged(site.siteId);
          deps.notifyRecords?.([site.siteId], [photo.photoId]);
          const nextErrors = new Map(prev.photoErrors);
          nextErrors.delete(photo.photoId);
          store.setState({
            sessions: nextSessions,
            photoStatuses: nextStatuses,
            photoErrors: nextErrors,
          });
          recomputeReports();
          if (store.getState().activePhotoId === photo.photoId) {
            void deps.syncViewport(false);
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
        job.finish(
          result.aborted,
          `${site.name}: ${result.completed} photo${result.completed === 1 ? '' : 's'} analysed${result.failed > 0 ? `, ${result.failed} failed` : ''}.`,
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
      activity.end();
      job.releaseWakeLock();
      if (!allSitesJobActive) job.finish(true, ''); // no-op unless an error ended the job early
      recomputeReports();
      await refreshCapabilities();
      if (!allSitesJobActive) deps.onStorageChanged();
    }
  }

  /** Includes or leaves out several photos from the site statistics. */
  async function setPhotosIncluded(photoIds: readonly string[], included: boolean): Promise<void> {
    const ids = new Set(photoIds);
    const st = store.getState();
    const photos = st.photos.map((p) => (ids.has(p.photoId) && p.included !== included ? { ...p, included } : p));
    for (const p of photos) if (ids.has(p.photoId)) await savePhoto(p);
    store.setState({ photos, statusMessage: `${included ? 'Included' : 'Left out'} ${ids.size} photo${ids.size === 1 ? '' : 's'}.` });
    recomputeReports();
  }

  /** Deletes photos (and their results) from the open site. */
  async function deletePhotos(photoIds: readonly string[]): Promise<void> {
    const st = store.getState();
    const site = getActiveSite(st);
    if (!site || st.batchRunning || enhancing) return;
    const ids = new Set(photoIds);
    for (const id of ids) await storage.deletePhoto(id);
    await storage.saveSite({ ...site, photoOrder: site.photoOrder.filter((id) => !ids.has(id)), updatedAt: Date.now() });
    deps.markSiteChanged(site.siteId);
    const sites = await storage.listSites();
    store.setState({ sites, selectedPhotoIds: new Set(), statusMessage: `Deleted ${ids.size} photo${ids.size === 1 ? '' : 's'}.` });
    await loadSiteData(site.siteId);
  }

  /** Stops the running batch (and, for "Analyse all sites", the whole job). */
  function cancelBatch(): void {
    batchAbortController?.abort();
  }

  async function persistActiveSession(photoId: string, session: AnalysisSession): Promise<void> {
    const owner = store.getState().photos.find((p) => p.photoId === photoId);
    if (owner) deps.markSiteChanged(owner.siteId);
    await storage.savePhotoResult({
      photoId,
      status: 'done',
      serializedSession: session.toSerialized(),
      updatedAt: Date.now(),
    });
    deps.notifyRecords?.(owner ? [owner.siteId] : [], [photoId]);
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
    let cal: CalibrationResult;
    try {
      cal = ScaleCalibrator.calibrate(ptA, ptB, lengthVal, unit);
    } catch (err) {
      store.setState({
        pendingCalibrationPoints: [],
        statusMessage: `Calibration failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      await deps.syncViewport(false);
      return;
    }

    const updatedPhoto: PhotoRecord = { ...photo, calibration: cal };
    const session = state.sessions.get(photo.photoId);
    if (session) {
      session.setCalibration(cal);
    }

    // Update live state & dashboard immediately so IndexedDB errors never block results from updating.
    const photos = store.getState().photos.map((p) => (p.photoId === photo.photoId ? updatedPhoto : p));
    store.setState({
      photos,
      pendingCalibrationPoints: [],
      statusMessage: `Calibrated ${photo.label}: ${cal.mmPerPx.toFixed(4)} mm/px`,
    });
    recomputeReports();
    await deps.syncViewport(false);

    try {
      await savePhoto(updatedPhoto);
      if (session) {
        await persistActiveSession(photo.photoId, session);
      }
    } catch (err) {
      store.setState({
        statusMessage: `Calibrated ${photo.label} (${cal.mmPerPx.toFixed(4)} mm/px), but could not save to browser storage: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function applyRectificationToActive(
    corners: [Point2D, Point2D, Point2D, Point2D],
    physWidthMm: number,
    physHeightMm: number,
  ): Promise<void> {
    const state = store.getState();
    if (state.batchRunning || enhancing) return;
    const photo = getActivePhoto(state);
    if (!photo) return;

    try {
      const rectified = await images.rectify(photo.imageBlob, corners, physWidthMm, physHeightMm);
      if (!rectified) {
        store.setState({
          pendingRectifyPoints: [],
          statusMessage: 'Rectification failed: could not compute perspective transform for those corners.',
        });
        await deps.syncViewport(false);
        return;
      }
      const cal: CalibrationResult = { ...rectified.calibration, source: 'rectification' };

      const latestBeforeSave = store.getState();
      const latestPhoto = latestBeforeSave.photos.find((p) => p.photoId === photo.photoId);
      if (!latestPhoto) {
        store.setState({ pendingRectifyPoints: [] });
        return;
      }

      const { roiConfig: _dropRoi, originalBackup: _dropBackup, metadata: oldMeta, ...photoBase } = latestPhoto;
      // The new image is a different raster: drop the current-enhancement record (its scale
      // factor no longer applies), but keep every step in the provenance history.
      const { enhancement: _dropEnh, ...restMeta } = oldMeta ?? {};
      const nextMeta: SitePhotoMetadata = {
        ...restMeta,
        processingHistory: [
          ...photoProcessingHistory(oldMeta),
          {
            step: 'rectification',
            corners: corners.map((c) => ({ x: c.x, y: c.y })),
            physicalWidthMm: physWidthMm,
            physicalHeightMm: physHeightMm,
            outputWidth: rectified.width,
            outputHeight: rectified.height,
            mmPerPx: cal.mmPerPx,
            appliedAt: new Date().toISOString(),
          },
        ],
      };
      const updatedPhoto: PhotoRecord = {
        ...photoBase,
        imageBlob: rectified.blob,
        width: rectified.width,
        height: rectified.height,
        calibration: cal,
        metadata: nextMeta,
      };
      await savePhoto(updatedPhoto);
      await storage.savePhotoResult({
        photoId: latestPhoto.photoId,
        status: 'pending',
        updatedAt: Date.now(),
      });

      const latestState = store.getState();
      const oldUrl = latestState.thumbUrls.get(latestPhoto.photoId);
      if (oldUrl) revokeUrl(oldUrl);
      const nextThumbs = new Map(latestState.thumbUrls);
      nextThumbs.set(latestPhoto.photoId, createUrl(rectified.blob));

      const nextSessions = new Map(latestState.sessions);
      nextSessions.delete(latestPhoto.photoId);
      const nextStatuses = new Map(latestState.photoStatuses);
      nextStatuses.set(latestPhoto.photoId, 'pending');

      store.setState({
        photos: latestState.photos.map((p) => (p.photoId === latestPhoto.photoId ? updatedPhoto : p)),
        thumbUrls: nextThumbs,
        sessions: nextSessions,
        photoStatuses: nextStatuses,
        pendingRectifyPoints: [],
        activeTool: 'inspect',
        statusMessage: `Rectified ${latestPhoto.label} (${rectified.width}×${rectified.height}px, ${cal.mmPerPx.toFixed(4)} mm/px). Ready to re-analyze.`,
      });
      recomputeReports();
      deps.onStorageChanged();
      await deps.syncViewport(true);
    } catch (err) {
      store.setState({
        pendingRectifyPoints: [],
        statusMessage: `Rectification failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      await deps.syncViewport(false);
    }
  }

  let enhancing = false;

  async function enhanceActivePhoto(kind: EnhanceKind): Promise<void> {
    if (enhancing || store.getState().batchRunning || refuseIfStale()) return;
    if (!images.enhance) {
      store.setState({ statusMessage: 'Image enhancement is not available in this environment.' });
      return;
    }
    const state = store.getState();
    const photo = getActivePhoto(state);
    if (!photo) return;

    enhancing = true;
    const isOnnxEnhance = kind === 'upscale-2x';
    const label = isOnnxEnhance ? 'PULSE 2× upscale' : 'Richardson–Lucy deblur';
    store.setState({
      enhancing: true,
      statusMessage: isOnnxEnhance
        ? `Releasing segmentation model and starting ${label}…`
        : `Starting ${label}…`,
    });
    try {
      // Strictly isolate memory for ONNX enhancers: unload any main segmentation session first.
      if (isOnnxEnhance) {
        await engine.releaseSessions?.();
      }

      const enhanced = await images.enhance(photo.imageBlob, kind, (ev) => {
        store.setState({ statusMessage: `${ev.message}` });
      });
      if (!enhanced) return;

      const latestState = store.getState();
      const latestPhoto = latestState.photos.find((p) => p.photoId === photo.photoId);
      if (!latestPhoto) return;

      const backup = latestPhoto.originalBackup ?? {
        imageBlob: latestPhoto.imageBlob,
        width: latestPhoto.width,
        height: latestPhoto.height,
        ...(latestPhoto.calibration ? { calibration: latestPhoto.calibration } : {}),
        ...(latestPhoto.roiConfig ? { roiConfig: latestPhoto.roiConfig } : {}),
        ...(latestPhoto.metadata ? { metadata: latestPhoto.metadata } : {}),
      };

      const scaled = scaleCalibrationAndRoi(
        latestPhoto.calibration,
        latestPhoto.roiConfig,
        enhanced.enhancement.scaleFactor,
      );

      const nextMetadata = {
        ...(latestPhoto.metadata ?? {}),
        ...(enhanced.blurScore !== undefined ? { blurScore: enhanced.blurScore } : {}),
        enhancement: enhanced.enhancement,
        processingHistory: [
          ...photoProcessingHistory(latestPhoto.metadata),
          { step: 'enhancement' as const, ...enhanced.enhancement },
        ],
      };

      const updatedPhoto: PhotoRecord = {
        ...latestPhoto,
        imageBlob: enhanced.blob,
        width: enhanced.width,
        height: enhanced.height,
        ...(scaled.calibration ? { calibration: scaled.calibration } : {}),
        ...(scaled.roiConfig ? { roiConfig: scaled.roiConfig } : {}),
        metadata: nextMetadata,
        originalBackup: backup,
      };
      await savePhoto(updatedPhoto);
      await storage.savePhotoResult({
        photoId: latestPhoto.photoId,
        status: 'pending',
        updatedAt: Date.now(),
      });

      const oldUrl = latestState.thumbUrls.get(latestPhoto.photoId);
      if (oldUrl) revokeUrl(oldUrl);
      const nextThumbs = new Map(latestState.thumbUrls);
      nextThumbs.set(latestPhoto.photoId, createUrl(enhanced.blob));

      const nextSessions = new Map(latestState.sessions);
      nextSessions.delete(latestPhoto.photoId);
      const nextStatuses = new Map(latestState.photoStatuses);
      nextStatuses.set(latestPhoto.photoId, 'pending');

      store.setState({
        photos: latestState.photos.map((p) => (p.photoId === latestPhoto.photoId ? updatedPhoto : p)),
        thumbUrls: nextThumbs,
        sessions: nextSessions,
        photoStatuses: nextStatuses,
        activeTool: 'inspect',
        statusMessage: `Enhanced ${latestPhoto.label} (${enhanced.enhancement.modelName}, ${enhanced.width}×${enhanced.height}px). Ready to analyse.`,
      });
      recomputeReports();
      deps.onStorageChanged();
      await deps.syncViewport(true);
    } catch (err) {
      store.setState({
        statusMessage: `Enhancement failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      enhancing = false;
      store.setState({ enhancing: false });
    }
  }

  async function revertActivePhotoEnhancement(): Promise<void> {
    if (enhancing || store.getState().batchRunning) return;
    const state = store.getState();
    const photo = getActivePhoto(state);
    if (!photo?.originalBackup) return;

    const orig = photo.originalBackup;
    const invScale = photo.width > 0 ? orig.width / photo.width : 1;
    const scaledBack = scaleCalibrationAndRoi(
      orig.calibration ? undefined : photo.calibration,
      orig.roiConfig ? undefined : photo.roiConfig,
      invScale,
    );
    const restoredCal = orig.calibration ?? scaledBack.calibration;
    const restoredRoi = orig.roiConfig ?? scaledBack.roiConfig;

    const { originalBackup: _drop, calibration: _c, roiConfig: _r, metadata: _m, ...base } = photo;
    const restoredPhoto: PhotoRecord = {
      ...base,
      imageBlob: orig.imageBlob,
      width: orig.width,
      height: orig.height,
      ...(restoredCal ? { calibration: restoredCal } : {}),
      ...(restoredRoi ? { roiConfig: restoredRoi } : {}),
      ...(orig.metadata ? { metadata: orig.metadata } : {}),
    };
    try {
      await savePhoto(restoredPhoto);
      await storage.savePhotoResult({
        photoId: photo.photoId,
        status: 'pending',
        updatedAt: Date.now(),
      });

      const latestState = store.getState();
      const oldUrl = latestState.thumbUrls.get(photo.photoId);
      if (oldUrl) revokeUrl(oldUrl);
      const nextThumbs = new Map(latestState.thumbUrls);
      nextThumbs.set(photo.photoId, createUrl(orig.imageBlob));

      const nextSessions = new Map(latestState.sessions);
      nextSessions.delete(photo.photoId);
      const nextStatuses = new Map(latestState.photoStatuses);
      nextStatuses.set(photo.photoId, 'pending');

      store.setState({
        photos: latestState.photos.map((p) => (p.photoId === photo.photoId ? restoredPhoto : p)),
        thumbUrls: nextThumbs,
        sessions: nextSessions,
        photoStatuses: nextStatuses,
        statusMessage: `Reverted ${photo.label} to original (${orig.width}×${orig.height}px). Ready to analyse.`,
      });
      recomputeReports();
      deps.onStorageChanged();
      await deps.syncViewport(true);
    } catch (err) {
      store.setState({
        statusMessage: `Revert failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

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
          inputs = storedSiteInputsCache.get(site.siteId) ?? (await loadStored(site.siteId, state.siteOptions));
          storedSiteInputsCache.set(site.siteId, inputs);
        }
        // Colour by the site's position in the full list, so it does not change with the selection.
        const color = COMPARE_COLORS[state.sites.indexOf(site) % COMPARE_COLORS.length]!;
        entries.push({
          siteId: site.siteId,
          name: site.name,
          inputs,
          color,
          ...(site.surveyDate ? { surveyDate: site.surveyDate } : {}),
          ...(site.place ? { place: site.place } : {}),
        });
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

  return {
    savePhoto,
    recomputeReports,
    refreshCapabilities,
    loadSiteData,
    refreshFromStorage,
    createDefaultOrLoadSites,
    handleFilesAdded,
    runBatch,
    runAllSites,
    setFineGrainUpscale,
    cancelBatch,
    setPhotosIncluded,
    deletePhotos,
    persistActiveSession,
    applyCalibrationToActive,
    applyRectificationToActive,
    enhanceActivePhoto,
    revertActivePhotoEnhancement,
    refreshComparison,
    /** Forget other sites' cached inputs (e.g. after a setting that changes them). */
    clearStoredSiteInputs(): void {
      storedSiteInputsCache.clear();
    },
    /** Storage quota from the last capability refresh (for the Models dialog). */
    getCachedQuota(): StorageQuotaInfo | null {
      return cachedQuota;
    },
  };
}

/**
 * Photos per site above which the app suggests splitting the site. Not a hard limit: photos
 * are analysed one at a time and archives have no size limit, but site statistics are
 * recomputed after every change (about 1 s per 100 photos) and every analysed photo keeps
 * its label mask in memory (about 3-4 MB).
 */
export const SITE_PHOTO_SOFT_LIMIT = 100;

/** Browser implementation of `ImageIo.rectify` (canvas + perspective correction). */
/** Shown when a newer version took over this page from another tab. */
export const STALE_BUILD_MESSAGE =
  'A newer version of webGrainy was installed in another tab. Reload this page before analysing (your data is kept).';

export async function rectifyWithCanvas(
  image: Blob,
  corners: [Point2D, Point2D, Point2D, Point2D],
  physWidthMm: number,
  physHeightMm: number,
  rectifyPerspective: typeof import('../modules/roiAndRectify.js').rectifyPerspective,
): Promise<{ blob: Blob; width: number; height: number; calibration: CalibrationResult } | null> {
  const bmp = await createImageBitmap(image);
  const off = document.createElement('canvas');
  off.width = bmp.width;
  off.height = bmp.height;
  const ctx = off.getContext('2d');
  if (!ctx) {
    bmp.close();
    return null;
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
  if (!outCtx) return null;
  outCtx.putImageData(new ImageData(new Uint8ClampedArray(rectified.data), rectified.width, rectified.height), 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode rectified PNG'))),
      'image/png',
    );
  });

  const calibration = ScaleCalibrator.calibrate(
    { x: rectified.roiRectInOutput[0], y: rectified.roiRectInOutput[1] },
    {
      x: rectified.roiRectInOutput[0] + rectified.roiRectInOutput[2],
      y: rectified.roiRectInOutput[1],
    },
    physWidthMm,
    'mm',
  );
  return { blob, width: rectified.width, height: rectified.height, calibration: { ...calibration, source: 'rectification' } };
}
