import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import type { BatchRunOptions, BatchRunResult, PhotoRecord, PhotoResultRecord, SiteRecord } from '../src/modules/projectStorage.js';
import { AppStore, createInitialState } from '../src/ui/state.js';
import { createWorkspaceActions, type WorkspaceStorage } from '../src/ui/workspaceActions.js';

function session(): AnalysisSession {
  const w = 120, h = 80;
  const masks = new Int32Array(w * h);
  let id = 0;
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 5; gx++) {
    id++;
    for (let y = 8 + gy * 24; y < 20 + gy * 24; y++) for (let x = 8 + gx * 22; x < 22 + gx * 22; x++) masks[y * w + x] = id;
  }
  return new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: 'full' } as never,
    recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
    masks,
    workingGrains: computeGrainMorphometrics(masks, w, h, 2),
    provenance: { appVersion: 't', ortVersion: 't', analyzedAt: '2026-01-01T00:00:00Z', modelId: 'ig2_unet_fp32', modelFile: 'x', modelRevision: 'r', modelSha256: 's' },
  });
}

function site(siteId: string, photoIds: string[]): SiteRecord {
  return { siteId, name: `Site ${siteId}`, createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: photoIds } as SiteRecord;
}

function photo(photoId: string, siteId: string): PhotoRecord {
  return { photoId, siteId, label: `${photoId}.jpg`, imageBlob: new Blob(['x']), width: 120, height: 80, addedAt: 0, included: true };
}

/** In-memory storage; the batch "analyses" each queued photo, failing those listed in `failIds`. */
function fakeWorld(opts: { failIds?: string[]; abortAfter?: number } = {}) {
  const sites = new Map<string, SiteRecord>();
  const photos = new Map<string, PhotoRecord>();
  const results = new Map<string, PhotoResultRecord>();
  const batchCalls: Array<{ siteId: string; photoIds?: readonly string[] }> = [];
  let analysed = 0;
  const storage: WorkspaceStorage = {
    listSites: async () => [...sites.values()],
    listSitePhotos: async (siteId: string) => [...photos.values()].filter((p) => p.siteId === siteId),
    getPhotoResult: async (id: string) => results.get(id),
    savePhoto: async (p: PhotoRecord) => void photos.set(p.photoId, p),
    savePhotoResult: async (r: PhotoResultRecord) => void results.set(r.photoId, r),
    saveSite: async (s: SiteRecord) => void sites.set(s.siteId, s),
    deletePhoto: async (id: string) => {
      photos.delete(id);
      results.delete(id);
    },
    runSiteBatch: async (o: BatchRunOptions): Promise<BatchRunResult> => {
      batchCalls.push({ siteId: o.siteId, ...(o.photoIds ? { photoIds: o.photoIds } : {}) });
      const queue = [...photos.values()].filter(
        (p) => p.siteId === o.siteId && (o.photoIds ? o.photoIds.includes(p.photoId) : results.get(p.photoId)?.status !== 'done'),
      );
      const res: BatchRunResult = { siteId: o.siteId, total: queue.length, completed: 0, failed: 0, aborted: false, completedPhotoIds: [], failedPhotoIds: [] };
      for (const p of queue) {
        if (o.signal?.aborted) { res.aborted = true; break; }
        o.onPhotoStart?.(p);
        if (opts.failIds?.includes(p.photoId)) {
          res.failed++; res.failedPhotoIds.push(p.photoId);
          results.set(p.photoId, { photoId: p.photoId, status: 'error', errorMessage: 'boom', updatedAt: 0 });
          o.onPhotoError?.(p, new Error('boom'));
        } else {
          const s = session();
          res.completed++; res.completedPhotoIds.push(p.photoId);
          results.set(p.photoId, { photoId: p.photoId, status: 'done', serializedSession: s.toSerialized(), updatedAt: 0 });
          o.onPhotoComplete?.(p, s);
        }
        analysed++;
        o.onProgress?.({ completed: res.completed + res.failed, total: queue.length, currentPhotoId: p.photoId, currentLabel: p.label });
        if (opts.abortAfter !== undefined && analysed >= opts.abortAfter) actionsRef.current?.cancelBatch();
      }
      if (o.signal?.aborted) res.aborted = true;
      return res;
    },
  };
  const actionsRef: { current: ReturnType<typeof createWorkspaceActions> | null } = { current: null };
  return { sites, photos, results, storage, batchCalls, actionsRef };
}

function setup(world: ReturnType<typeof fakeWorld>) {
  const store = new AppStore(createInitialState());
  const log: string[] = [];
  const changed: string[] = [];
  let n = 0;
  const actions = createWorkspaceActions({
    store,
    engine: { initialize: async () => ({}) as never, getWebGpuDisabledReason: () => null },
    batchEngine: {} as never,
    storage: world.storage,
    loadStoredSiteInputs: async () => [],
    images: {
      imageSize: async () => ({ width: 120, height: 80 }),
      metadata: async () => undefined,
      rectify: async () => null,
    },
    syncViewport: async () => {},
    activity: {
      begin: (t) => log.push(`begin ${t}`),
      photoStarted: (i, l) => log.push(`photo ${i} ${l}`),
      setTotal: () => {},
      end: () => log.push('end'),
    },
    job: {
      acquireWakeLock: () => log.push('lock'),
      releaseWakeLock: () => log.push('unlock'),
      start: (t) => log.push(`job ${t}`),
      progress: () => {},
      finish: (c, b) => log.push(`finish ${c} ${b}`),
    },
    markSiteChanged: (id) => changed.push(id),
    onStorageChanged: () => {},
    makeId: (p) => `${p}_${++n}`,
    yieldToMain: async () => {},
    createObjectUrl: () => 'blob:x',
    revokeObjectUrl: () => {},
  });
  world.actionsRef.current = actions;
  return { store, actions, log, changed };
}

describe('workspace actions', () => {
  it('creates a default site on first start', async () => {
    const world = fakeWorld();
    const { store, actions } = setup(world);
    await actions.createDefaultOrLoadSites();
    expect(store.getState().sites.map((s) => s.name)).toEqual(['Field Site 1']);
    expect(store.getState().activeSiteId).toBe('site_1');
  });

  it('records statuses, errors and sessions during a batch', async () => {
    const world = fakeWorld({ failIds: ['p2'] });
    world.sites.set('a', site('a', ['p1', 'p2']));
    world.photos.set('p1', photo('p1', 'a'));
    world.photos.set('p2', photo('p2', 'a'));
    const { store, actions, log, changed } = setup(world);
    await actions.createDefaultOrLoadSites();
    await actions.runBatch();
    const st = store.getState();
    expect(st.photoStatuses.get('p1')).toBe('done');
    expect(st.photoStatuses.get('p2')).toBe('error');
    expect(st.photoErrors.get('p2')).toBe('boom');
    expect(st.sessions.has('p1')).toBe(true);
    expect(st.batchRunning).toBe(false);
    expect(st.statusMessage).toMatch(/Batch complete: 1 done, 1 failed — boom/);
    expect(changed).toContain('a');
    expect(log[0]).toBe('begin 2');
    expect(log).toContain('lock');
    expect(log).toContain('unlock');
    expect(log).toContain('finish false Site a: 1 photo analysed, 1 failed.');
  });

  it('analyses the other sites after the open one, and cancel stops the whole job', async () => {
    const world = fakeWorld();
    world.sites.set('a', site('a', ['p1']));
    world.sites.set('b', site('b', ['p2', 'p3']));
    for (const [id, s] of [['p1', 'a'], ['p2', 'b'], ['p3', 'b']] as const) world.photos.set(id, photo(id, s));
    const { store, actions, log } = setup(world);
    await actions.createDefaultOrLoadSites();
    await actions.runAllSites();
    expect(world.batchCalls.map((c) => c.siteId)).toEqual(['a', 'b']);
    expect(store.getState().statusMessage).toBe('All sites analysed: 2 done, 0 failed in other sites.');
    // The open-site batch inside "all sites" does not end the job signals early.
    expect(log.filter((l) => l.startsWith('finish'))).toEqual(['finish false All sites: 2 photos analysed.', 'finish true ']);
    expect(log.filter((l) => l === 'lock').length).toBe(log.filter((l) => l === 'unlock').length);

    const world2 = fakeWorld({ abortAfter: 1 });
    world2.sites.set('a', site('a', ['p1', 'p4']));
    world2.sites.set('b', site('b', ['p2']));
    for (const [id, s] of [['p1', 'a'], ['p4', 'a'], ['p2', 'b']] as const) world2.photos.set(id, photo(id, s));
    const ctx2 = setup(world2);
    await ctx2.actions.createDefaultOrLoadSites();
    await ctx2.actions.runAllSites();
    expect(world2.batchCalls.map((c) => c.siteId)).toEqual(['a']);
    expect(ctx2.store.getState().statusMessage).toMatch(/Batch cancelled \(1\/2 completed\)/);
  });

  it('saves the fine-grain choice and re-analyses just that photo', async () => {
    const world = fakeWorld();
    world.sites.set('a', site('a', ['p1', 'p2']));
    world.photos.set('p1', photo('p1', 'a'));
    world.photos.set('p2', photo('p2', 'a'));
    const { store, actions } = setup(world);
    await actions.createDefaultOrLoadSites();
    const p1 = store.getState().photos.find((p) => p.photoId === 'p1')!;
    await actions.setFineGrainUpscale(p1, 1.5);
    expect(world.photos.get('p1')!.analysisConfig?.fineGrainUpscale).toBe(1.5);
    expect(store.getState().photos.find((p) => p.photoId === 'p1')!.analysisConfig?.fineGrainUpscale).toBe(1.5);
    expect(world.batchCalls).toEqual([{ siteId: 'a', photoIds: ['p1'] }]);
    await actions.setFineGrainUpscale(store.getState().photos.find((p) => p.photoId === 'p1')!, undefined);
    expect(world.photos.get('p1')!.analysisConfig?.fineGrainUpscale).toBeUndefined();
  });

  it('bulk include/exclude and delete', async () => {
    const world = fakeWorld();
    world.sites.set('a', site('a', ['p1', 'p2', 'p3']));
    for (const id of ['p1', 'p2', 'p3']) world.photos.set(id, photo(id, 'a'));
    const { store, actions, changed } = setup(world);
    await actions.createDefaultOrLoadSites();
    await actions.setPhotosIncluded(['p1', 'p3'], false);
    expect(store.getState().photos.map((p) => p.included)).toEqual([false, true, false]);
    expect(world.photos.get('p3')!.included).toBe(false);
    store.setState({ selectedPhotoIds: new Set(['p1', 'p2']) });
    await actions.deletePhotos(['p1', 'p2']);
    expect(store.getState().photos.map((p) => p.photoId)).toEqual(['p3']);
    expect(world.sites.get('a')!.photoOrder).toEqual(['p3']);
    expect(world.photos.has('p1')).toBe(false);
    expect(store.getState().selectedPhotoIds.size).toBe(0);
    expect(changed).toContain('a');
  });

  it('adds image files to the open site and skips other files', async () => {
    const world = fakeWorld();
    world.sites.set('a', site('a', []));
    const { store, actions, changed } = setup(world);
    await actions.createDefaultOrLoadSites();
    await actions.handleFilesAdded([
      new File(['x'], 'one.jpg', { type: 'image/jpeg' }),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    ]);
    const st = store.getState();
    expect(st.photos.map((p) => p.label)).toEqual(['one.jpg']);
    expect(st.photoStatuses.get(st.photos[0]!.photoId)).toBe('pending');
    expect(world.sites.get('a')!.photoOrder).toHaveLength(1);
    expect(changed).toContain('a');
  });

  it('analyse -> calibrate updates singlePhotoStats and siteReport immediately even if IDB savePhotoResult fails, and re-analyse preserves calibration', async () => {
    const world = fakeWorld();
    world.sites.set('a', {
      ...site('a', ['p1']),
      options: { poolingMode: 'physical-area', minBaxisPx: 0 },
    });
    world.photos.set('p1', photo('p1', 'a'));
    const { store, actions } = setup(world);
    await actions.createDefaultOrLoadSites();

    // 1. Analyse uncalibrated first -> results in px
    await actions.runBatch();
    expect(store.getState().singlePhotoStats?.unit).toBe('px');
    expect(store.getState().singlePhotoStats?.includedGrains).toBeGreaterThan(0);
    const pxD50 = store.getState().singlePhotoStats!.areaWeightedB.D50;

    // Simulate IndexedDB quota/write failure during persistActiveSession
    const origSaveResult = world.storage.savePhotoResult;
    world.storage.savePhotoResult = async () => {
      throw new Error('QuotaExceededError');
    };

    // 2. Calibrate after analysis (100 px = 500 mm -> 5 mm/px)
    await actions.applyCalibrationToActive({ x: 0, y: 0 }, { x: 100, y: 0 }, 500, 'mm');
    expect(store.getState().singlePhotoStats?.unit).toBe('mm');
    expect(store.getState().singlePhotoStats!.areaWeightedB.D50).toBeCloseTo(pxD50 * 5, 3);
    expect(store.getState().siteReport?.unit).toBe('mm');
    expect(store.getState().siteReport!.psd.D50).toBeCloseTo(pxD50 * 5, 3);
    expect(store.getState().statusMessage).toContain('could not save to browser storage');

    // 3. Restore storage and re-analyse: even though fakeWorld's runSiteBatch creates an uncalibrated
    // session, onPhotoComplete preserves the live photo's calibration.
    world.storage.savePhotoResult = origSaveResult;
    await actions.runBatch(['p1']);
    expect(store.getState().singlePhotoStats?.unit).toBe('mm');
    expect(store.getState().singlePhotoStats!.areaWeightedB.D50).toBeCloseTo(pxD50 * 5, 3);
    expect(store.getState().siteReport?.unit).toBe('mm');
  });
});

