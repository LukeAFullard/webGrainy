import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import type { BatchRunOptions, BatchRunResult, PhotoRecord, PhotoResultRecord, SiteRecord } from '../src/modules/projectStorage.js';
import { AppStore, createInitialState } from '../src/ui/state.js';
import { createWorkspaceActions, SITE_PHOTO_SOFT_LIMIT, type WorkspaceStorage } from '../src/ui/workspaceActions.js';

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
    deleteSite: async (id: string) => {
      for (const p of [...photos.values()]) if (p.siteId === id) { photos.delete(p.photoId); results.delete(p.photoId); }
      sites.delete(id);
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

function setup(
  world: ReturnType<typeof fakeWorld>,
  overrides: {
    rectify?: () => Promise<unknown>;
    enhance?: () => Promise<unknown>;
    ifSiteNotOpen?: (siteId: string, openHere: string | null, fn: () => Promise<void>) => Promise<boolean>;
    retentionSince?: () => number;
  } = {},
) {
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
      rectify: (overrides.rectify ?? (async () => null)) as never,
      ...(overrides.enhance ? { enhance: overrides.enhance as never } : {}),
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
    ...(overrides.ifSiteNotOpen ? { ifSiteNotOpen: overrides.ifSiteNotOpen } : {}),
    // Existing tests' sites have 1970 dates: the retention clock starts "now" unless a test sets it.
    retentionSince: overrides.retentionSince ?? (() => Date.now()),
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

  it('warns (without refusing) when a site grows beyond the soft photo limit', async () => {
    const world = fakeWorld();
    const ids = Array.from({ length: SITE_PHOTO_SOFT_LIMIT }, (_, i) => `p${i}`);
    world.sites.set('a', site('a', ids));
    for (const id of ids) world.photos.set(id, photo(id, 'a'));
    const { store, actions } = setup(world);
    await actions.createDefaultOrLoadSites();
    await actions.handleFilesAdded([new File(['x'], 'one-more.jpg', { type: 'image/jpeg' })]);
    expect(world.sites.get('a')!.photoOrder).toHaveLength(SITE_PHOTO_SOFT_LIMIT + 1);
    expect(store.getState().statusMessage).toMatch(/101 photos.*splitting/);
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

  it('clears stale singlePhotoStats when adding a new unanalysed photo', async () => {
    const world = fakeWorld();
    world.sites.set('a', site('a', ['p1']));
    world.photos.set('p1', photo('p1', 'a'));
    const { store, actions } = setup(world);
    await actions.createDefaultOrLoadSites();
    await actions.runBatch();
    expect(store.getState().singlePhotoStats).not.toBeNull();

    await actions.handleFilesAdded([new File(['x'], 'two.jpg', { type: 'image/jpeg' })]);
    expect(store.getState().activePhotoId).not.toBe('p1');
    expect(store.getState().singlePhotoStats).toBeNull();
  });

  it('clears pendingRectifyPoints and reports status when rectification fails or returns null', async () => {
    const world = fakeWorld();
    world.sites.set('a', site('a', ['p1']));
    world.photos.set('p1', photo('p1', 'a'));
    const corners = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];

    // Case 1: images.rectify throws
    const throwing = setup(world, {
      rectify: async () => {
        throw new Error('degenerate quad');
      },
    });
    await throwing.actions.createDefaultOrLoadSites();
    throwing.store.setState({ pendingRectifyPoints: corners });
    await throwing.actions.applyRectificationToActive(corners, 100, 100);
    expect(throwing.store.getState().pendingRectifyPoints).toEqual([]);
    expect(throwing.store.getState().statusMessage).toContain('Rectification failed: degenerate quad');

    // Case 2: images.rectify returns null
    const returningNull = setup(world, { rectify: async () => null });
    await returningNull.actions.createDefaultOrLoadSites();
    returningNull.store.setState({ pendingRectifyPoints: corners });
    await returningNull.actions.applyRectificationToActive(corners, 100, 100);
    expect(returningNull.store.getState().pendingRectifyPoints).toEqual([]);
    expect(returningNull.store.getState().statusMessage).toContain('Rectification failed:');
  });

  it('regression: rectification and enhancement keep every image step in the provenance history', async () => {
    const world = fakeWorld();
    world.sites.set('a', site('a', ['p1']));
    const enhancement = {
      kind: 'upscale-2x' as const, modelId: 'pulse_2x_fp32', modelName: 'PULSE 2x', modelSha256: 'abc', scaleFactor: 2, appliedAt: '2026-01-01T00:00:00Z',
    };
    world.photos.set('p1', { ...photo('p1', 'a'), metadata: { cameraModel: 'X', enhancement } });
    const corners = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }] as [
      { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number },
    ];
    const cal = { mmPerPx: 0.5, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 50, pixelDistance: 100 };
    const deblur = {
      kind: 'deblur' as const, modelId: 'richardson_lucy_tv_deblur', modelName: 'RL', modelSha256: '', scaleFactor: 1, appliedAt: '2026-01-03T00:00:00Z',
    };
    const { store, actions } = setup(world, {
      rectify: async () => ({ blob: new Blob(['r']), width: 200, height: 120, calibration: cal }),
      enhance: async () => ({ blob: new Blob(['e']), width: 200, height: 120, enhancement: deblur }),
    });
    await actions.createDefaultOrLoadSites();
    await actions.applyRectificationToActive(corners, 100, 60);
    let saved = world.photos.get('p1')!;
    expect(saved.metadata?.enhancement).toBeUndefined(); // the new raster is not the enhanced one
    expect(saved.metadata?.cameraModel).toBe('X');
    expect(saved.metadata?.processingHistory?.map((x) => x.step)).toEqual(['enhancement', 'rectification']);
    expect(saved.metadata?.processingHistory?.[0]).toMatchObject({ modelId: 'pulse_2x_fp32' });
    expect(saved.metadata?.processingHistory?.[1]).toMatchObject({ physicalWidthMm: 100, physicalHeightMm: 60, outputWidth: 200, mmPerPx: 0.5 });

    expect(store.getState().photos[0]!.photoId).toBe('p1');
    await actions.enhanceActivePhoto('deblur');
    saved = world.photos.get('p1')!;
    expect(saved.metadata?.enhancement?.modelId).toBe('richardson_lucy_tv_deblur');
    expect(saved.metadata?.processingHistory?.map((x) => x.step)).toEqual(['enhancement', 'rectification', 'enhancement']);
  });

  it('Undo rectify restores the photo as it was before the first rectification, also after enhancing it', async () => {
    const world = fakeWorld();
    world.sites.set('a', site('a', ['p1']));
    const origBlob = new Blob(['original']);
    const origCal = { mmPerPx: 2, pointA: { x: 0, y: 0 }, pointB: { x: 10, y: 0 }, physicalLengthMm: 20, pixelDistance: 10, source: 'manual' as const };
    const roi = { exclusionPolygons: [[{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }]], exclusionStrokes: [] };
    world.photos.set('p1', { ...photo('p1', 'a'), imageBlob: origBlob, calibration: origCal, roiConfig: roi, metadata: { cameraModel: 'X' } });
    const corners = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }] as [
      { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number },
    ];
    const cal = { mmPerPx: 0.5, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 50, pixelDistance: 100 };
    const deblur = { kind: 'deblur' as const, modelId: 'richardson_lucy_tv_deblur', modelName: 'RL', modelSha256: '', scaleFactor: 1, appliedAt: '2026-01-03T00:00:00Z' };
    const { store, actions } = setup(world, {
      rectify: async () => ({ blob: new Blob(['r']), width: 200, height: 120, calibration: cal }),
      enhance: async () => ({ blob: new Blob(['e']), width: 200, height: 120, enhancement: deblur }),
    });
    await actions.createDefaultOrLoadSites();
    const before = world.photos.get('p1')!;
    await actions.applyRectificationToActive(corners, 100, 60);
    await actions.applyRectificationToActive(corners, 100, 60); // a second rectification keeps the first backup
    await actions.enhanceActivePhoto('deblur');
    expect(world.photos.get('p1')!.rectifyBackup?.imageBlob).toBe(origBlob);
    await actions.undoRectificationActive();
    const restored = world.photos.get('p1')!;
    expect(restored.imageBlob).toBe(origBlob);
    expect([restored.width, restored.height]).toEqual([before.width, before.height]);
    expect(restored.calibration).toEqual(origCal);
    expect(restored.roiConfig).toEqual(roi);
    expect(restored.metadata).toEqual({ cameraModel: 'X' });
    expect(restored.rectifyBackup).toBeUndefined();
    expect(restored.originalBackup).toBeUndefined();
    expect(store.getState().photoStatuses.get('p1')).toBe('pending');
  });

  it('Undo rectify brings back an enhancement backup the photo had before rectification', async () => {
    const world = fakeWorld();
    world.sites.set('a', site('a', ['p1']));
    const enhanced = { imageBlob: new Blob(['pre-enhance']), width: 100, height: 60 };
    world.photos.set('p1', { ...photo('p1', 'a'), originalBackup: enhanced });
    const corners = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }] as [
      { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number },
    ];
    const cal = { mmPerPx: 0.5, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 50, pixelDistance: 100 };
    const { actions } = setup(world, { rectify: async () => ({ blob: new Blob(['r']), width: 200, height: 120, calibration: cal }) });
    await actions.createDefaultOrLoadSites();
    await actions.applyRectificationToActive(corners, 100, 60);
    expect(world.photos.get('p1')!.originalBackup).toBeUndefined(); // Revert does not apply to the rectified image
    await actions.undoRectificationActive();
    expect(world.photos.get('p1')!.originalBackup).toEqual(enhanced);
  });

  it('re-calibrating an analysed photo multiple times updates stats every time (never stuck at first value)', async () => {
    const world = fakeWorld();
    world.sites.set('a', {
      ...site('a', ['p1']),
      options: { poolingMode: 'physical-area', minBaxisPx: 0 },
    });
    world.photos.set('p1', photo('p1', 'a'));
    const { store, actions } = setup(world);
    await actions.createDefaultOrLoadSites();
    await actions.runBatch();

    const pxD50 = store.getState().singlePhotoStats!.areaWeightedB.D50;

    // 1st calibration: 100 px = 100 mm -> 1 mm/px
    await actions.applyCalibrationToActive({ x: 0, y: 0 }, { x: 100, y: 0 }, 100, 'mm');
    expect(store.getState().singlePhotoStats!.areaWeightedB.D50).toBeCloseTo(pxD50 * 1, 3);
    expect(store.getState().siteReport!.psd.D50).toBeCloseTo(pxD50 * 1, 3);

    // 2nd calibration: 100 px = 500 mm -> 5 mm/px
    await actions.applyCalibrationToActive({ x: 0, y: 0 }, { x: 100, y: 0 }, 500, 'mm');
    expect(store.getState().singlePhotoStats!.areaWeightedB.D50).toBeCloseTo(pxD50 * 5, 3);
    expect(store.getState().siteReport!.psd.D50).toBeCloseTo(pxD50 * 5, 3);

    // 3rd calibration: 100 px = 25 cm (250 mm) -> 2.5 mm/px
    await actions.applyCalibrationToActive({ x: 0, y: 0 }, { x: 100, y: 0 }, 25, 'cm');
    expect(store.getState().singlePhotoStats!.areaWeightedB.D50).toBeCloseTo(pxD50 * 2.5, 3);
    expect(store.getState().siteReport!.psd.D50).toBeCloseTo(pxD50 * 2.5, 3);
  });
});

describe('sites are removed after the chosen days without use', () => {
  const DAY = 86_400_000;
  /** In-memory localStorage for the download ("backup") records, restored after each test. */
  function withLocalStorage(): { restore: () => void } {
    const data = new Map<string, string>();
    const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) },
    });
    return { restore: () => (prev ? Object.defineProperty(globalThis, 'localStorage', prev) : delete (globalThis as { localStorage?: unknown }).localStorage) };
  }

  it('at start-up removes only expired sites with nothing to lose; keeps un-downloaded work for the user to decide', async () => {
    const ls = withLocalStorage();
    try {
      const { markSiteBackedUp, markSiteChanged } = await import('../src/ui/backup.js');
      const world = fakeWorld();
      const now = Date.now();
      const add = (id: string, ageDays: number, withPhoto = true) => {
        world.sites.set(id, { ...site(id, withPhoto ? [`${id}p`] : []), updatedAt: now - ageDays * DAY, createdAt: now - ageDays * DAY });
        if (withPhoto) {
          world.photos.set(`${id}p`, photo(`${id}p`, id));
          world.results.set(`${id}p`, { photoId: `${id}p`, status: 'error', updatedAt: 0 });
        }
      };
      add('downloaded', 40); // results downloaded after the last change: removed
      markSiteChanged('downloaded', now - 45 * DAY);
      markSiteBackedUp('downloaded', now - 41 * DAY);
      add('unsaved', 40); // never downloaded: kept
      add('changed', 40); // changed after the last download: kept
      markSiteBackedUp('changed', now - 50 * DAY);
      markSiteChanged('changed', now - 40 * DAY);
      add('empty', 40, false); // no photos: nothing to lose, removed
      add('busy', 45); // open in another tab: never removed
      markSiteBackedUp('busy', now - 44 * DAY);
      add('recent', 3);
      const { store, actions } = setup(world, {
        ifSiteNotOpen: async (id, here, fn) => {
          if (id === 'busy' || id === here) return false;
          await fn();
          return true;
        },
        retentionSince: () => 0,
      });
      store.setState({ retentionDays: 30 });
      await actions.purgeExpiredSites();
      expect([...world.sites.keys()].sort()).toEqual(['busy', 'changed', 'recent', 'unsaved']);
      expect(world.photos.has('downloadedp')).toBe(false);
      expect(world.photos.has('unsavedp')).toBe(true);
      expect(store.getState().retentionHeld.sort()).toEqual(['changed', 'unsaved']);
      expect(store.getState().retentionNotice).toMatch(/Removed from this browser after 30 days without use: .*Site downloaded \(results downloaded/);
      expect(store.getState().retentionNotice).not.toMatch(/Site (unsaved|changed)/);

      // Opening a kept site restarts its clock and takes it off the list; removing one is explicit.
      await actions.loadSiteData('unsaved');
      expect(store.getState().retentionHeld).toEqual(['changed']);
      expect(await actions.removeHeldSite('changed')).toBe(true);
      expect(world.sites.has('changed')).toBe(false);
      expect(store.getState().retentionHeld).toEqual([]);
    } finally {
      ls.restore();
    }
  });

  it('without download records (e.g. cleared localStorage) no site with photos is removed automatically', async () => {
    const world = fakeWorld();
    world.sites.set('old', { ...site('old', ['oldp']), updatedAt: 0, createdAt: 0 });
    world.photos.set('oldp', photo('oldp', 'old'));
    const { store, actions } = setup(world, { retentionSince: () => 0 });
    store.setState({ retentionDays: 7 });
    await actions.createDefaultOrLoadSites();
    expect(world.sites.has('old')).toBe(true);
    expect(store.getState().retentionNotice).toBeNull();
  });

  it('sites that existed before this feature get the full period, not removal at once', async () => {
    const world = fakeWorld();
    world.sites.set('legacy', { ...site('legacy', []), updatedAt: 0, createdAt: 0 });
    const { store, actions } = setup(world, { retentionSince: () => Date.now() - 2 * DAY });
    store.setState({ retentionDays: 7 });
    expect(await actions.purgeExpiredSites()).toEqual([]);
    expect(await actions.purgeExpiredSites(Date.now() + 6 * DAY)).toEqual(['legacy']);
  });

  it('keeps everything when the choice is "until I delete them"', async () => {
    const world = fakeWorld();
    world.sites.set('ancient', { ...site('ancient', []), updatedAt: 0, createdAt: 0 });
    const { store, actions } = setup(world);
    store.setState({ retentionDays: 0 });
    await actions.createDefaultOrLoadSites();
    expect(world.sites.has('ancient')).toBe(true);
    expect(store.getState().retentionNotice).toBeNull();
  });

  it('never removes the site open in this tab', async () => {
    const world = fakeWorld();
    world.sites.set('mine', { ...site('mine', []), updatedAt: 0, createdAt: 0 });
    const { store, actions } = setup(world, { ifSiteNotOpen: async (id, here, fn) => (id === here ? false : (await fn(), true)), retentionSince: () => 0 });
    store.setState({ retentionDays: 7, activeSiteId: 'mine' });
    expect(await actions.purgeExpiredSites()).toEqual([]);
    expect(world.sites.has('mine')).toBe(true);
  });
});

describe('browser storage full', () => {
  it('shows the storage-full notice and keeps the finished photo in the page', async () => {
    const { StorageFullError } = await import('../src/modules/projectStorage.js');
    const { squareGrainSession } = await import('./helpers/squareSession.js');
    const world = fakeWorld();
    world.sites.set('a', site('a', ['p1']));
    world.photos.set('p1', photo('p1', 'a'));
    const { store, actions } = setup(world);
    await actions.createDefaultOrLoadSites();
    world.storage.runSiteBatch = async (o) => {
      const p = world.photos.get('p1')!;
      o.onPhotoComplete?.(p, squareGrainSession([20, 30]) as never);
      throw new StorageFullError(p.label);
    };
    await actions.runBatch();
    const st = store.getState();
    expect(st.storageFullNotice).toMatch(/p1\.jpg was analysed but could not be saved/);
    expect(st.sessions.has('p1')).toBe(true);
    expect(st.photoStatuses.get('p1')).toBe('done');
  });

  it('removeSites removes the given sites but never the one open here', async () => {
    const world = fakeWorld();
    for (const id of ['a', 'b', 'c']) world.sites.set(id, site(id, []));
    const { store, actions } = setup(world, { ifSiteNotOpen: async (id, here, fn) => (id === here ? false : (await fn(), true)) });
    await actions.loadSiteData('a');
    const removed = await actions.removeSites([...world.sites.values()], 'Removed to free space');
    expect(removed.sort()).toEqual(['b', 'c']);
    expect([...world.sites.keys()]).toEqual(['a']);
    expect(store.getState().retentionNotice).toMatch(/^Removed to free space: Site b \(results never downloaded\); Site c/);
  });
  it('F-03: loads the active site in its photo order, not storage key order', async () => {
    const world = fakeWorld();
    // Stored (key) order z, a, m; the site's order is m, z, a.
    for (const id of ['z', 'a', 'm']) world.photos.set(id, photo(id, 's'));
    world.sites.set('s', site('s', ['m', 'z', 'a']));
    const { store, actions } = setup(world);
    store.setState({ sites: [...world.sites.values()] });
    await actions.loadSiteData('s');
    expect(store.getState().photos.map((p) => p.photoId)).toEqual(['m', 'z', 'a']);
  });
  it('F-11: storage that cannot be opened at start-up is reported, and Try again recovers', async () => {
    const world = fakeWorld();
    const listSites = world.storage.listSites;
    world.storage.listSites = async () => { throw new DOMException('The user denied permission to access the database.', 'InvalidStateError'); };
    const { store, actions } = setup(world);
    await expect(actions.createDefaultOrLoadSites()).resolves.toBeUndefined();
    expect(store.getState().storageOpenError).toMatch(/InvalidStateError/);
    world.storage.listSites = listSites;
    await actions.createDefaultOrLoadSites();
    expect(store.getState().storageOpenError).toBeNull();
    expect(store.getState().sites).toHaveLength(1);
  });
});
