import { describe, expect, it } from 'vitest';
import {
  AnalysisSession,
  ImageGrainsEngine,
  computeAllGrainMorphometrics,
  deletePhoto,
  deleteSite,
  exportProjectArchive,
  getPhoto,
  getPhotoResult,
  getSite,
  importProjectArchive,
  listSitePhotos,
  listSites,
  runSiteBatch,
  savePhoto,
  savePhotoResult,
  saveSite,
  type ModelRecommendation,
  type PhotoRecord,
  type SiteRecord,
  type WorkingImageResult,
} from '../src/index.js';
import { createMockOnnxSession } from './e2e/helpers/mocks.js';

interface StoreEntry {
  keyPath: string;
  data: Map<string, unknown>;
}

function createProjectMockIDB(): IDBFactory {
  const stores = new Map<string, StoreEntry>();

  const makeReq = <T>(exec: () => T, onUpgrade?: (req: IDBOpenDBRequest) => void) => {
    const req: Record<string, unknown> = {
      result: undefined as unknown as T,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      try {
        if (onUpgrade) {
          onUpgrade(req as unknown as IDBOpenDBRequest);
          if (typeof req['onupgradeneeded'] === 'function') {
            (req['onupgradeneeded'] as (ev: unknown) => void)({ target: req });
          }
        }
        req['result'] = exec();
        if (typeof req['onsuccess'] === 'function') {
          (req['onsuccess'] as (ev: unknown) => void)({ target: req });
        }
      } catch (err) {
        req['error'] = err instanceof Error ? err : new Error(String(err));
        if (typeof req['onerror'] === 'function') {
          (req['onerror'] as (ev: unknown) => void)({ target: req });
        }
      }
    });
    return req;
  };

  const makeTx = () => {
    const tx: Record<string, unknown> = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore(name: string) {
        const entry = stores.get(name);
        if (!entry) {
          throw new Error(`Object store "${name}" not found`);
        }
        const wrapReq = <T>(fn: () => T) => {
          const r = makeReq(fn);
          const origSuccess = () => {
            queueMicrotask(() => {
              if (typeof tx['oncomplete'] === 'function') {
                (tx['oncomplete'] as () => void)();
              }
            });
          };
          queueMicrotask(origSuccess);
          return r as unknown as IDBRequest<T>;
        };
        return {
          get: (key: string) => wrapReq(() => entry.data.get(key)),
          getAll: () => wrapReq(() => Array.from(entry.data.values())),
          put: (val: Record<string, unknown>) =>
            wrapReq(() => {
              const k = String(val[entry.keyPath]);
              entry.data.set(k, val);
              return k;
            }),
          delete: (key: string) =>
            wrapReq(() => {
              entry.data.delete(key);
              return undefined;
            }),
          index: (idxName: string) => ({
            getAll: (query: string) =>
              wrapReq(() =>
                Array.from(entry.data.values()).filter(
                  (v) => (v as Record<string, unknown>)[idxName] === query,
                ),
              ),
          }),
        };
      },
    };
    return tx as unknown as IDBTransaction;
  };

  const db = {
    objectStoreNames: {
      contains: (name: string) => stores.has(name),
    },
    createObjectStore: (name: string, opts?: IDBObjectStoreParameters) => {
      const keyPath = typeof opts?.keyPath === 'string' ? opts.keyPath : 'id';
      if (!stores.has(name)) {
        stores.set(name, { keyPath, data: new Map() });
      }
      return { createIndex: () => ({}) };
    },
    transaction: () => makeTx(),
    close: () => undefined,
  } as unknown as IDBDatabase;

  return {
    open: () =>
      makeReq(
        () => db,
        (req) => {
          (req as unknown as { result: IDBDatabase }).result = db;
        },
      ) as unknown as IDBOpenDBRequest,
  } as unknown as IDBFactory;
}

function makeTestSession(): AnalysisSession {
  const w = 40;
  const h = 40;
  const masks = new Int32Array(w * h);
  for (let y = 12; y <= 28; y++) {
    for (let x = 12; x <= 28; x++) {
      masks[y * w + x] = 1;
    }
  }
  const workingImage: WorkingImageResult = {
    data: new Uint8ClampedArray(w * h * 4).fill(128),
    width: w,
    height: h,
    originalWidth: w,
    originalHeight: h,
    effectiveScaleFactor: 1,
    scaleModeApplied: '1.0x',
  };
  const recommendation: ModelRecommendation = {
    model: 'unet',
    confidence: 0.9,
    rationale: 'test',
    metrics: {
      sobelEntropy: 1,
      multiScaleContrastVar: 1,
      shadowGlareRange: 1,
      hasWebGPU: false,
      deviceMemoryGB: 8,
      elapsedMs: 1,
    },
  };
  const grains = computeAllGrainMorphometrics(masks, w, h, 2);
  return new AnalysisSession({
    workingImage,
    recommendation,
    masks,
    workingGrains: grains,
    calibration: {
      mmPerPx: 0.5,
      pointA: { x: 0, y: 0 },
      pointB: { x: 10, y: 0 },
      physicalLengthMm: 5,
      pixelDistance: 10,
    },
    excludeBorder: true,
    borderMargin: 2,
  });
}

describe('projectStorage', () => {
  it('round-trips AnalysisSession serialization and hydration', () => {
    const session = makeTestSession();
    const serialized = session.toSerialized();
    const hydrated = AnalysisSession.fromSerialized(serialized);

    expect(hydrated.getCalibration()?.mmPerPx).toBe(0.5);
    expect(hydrated.getExcludeBorder()).toBe(true);
    expect(hydrated.getBorderMargin()).toBe(2);
    expect(hydrated.getWorkingMasks()).toEqual(session.getWorkingMasks());
    expect(hydrated.getWorkingGrains().length).toBe(session.getWorkingGrains().length);
    expect(hydrated.getStats().areaWeightedB.D50).toBeCloseTo(
      session.getStats().areaWeightedB.D50,
      6,
    );
  });

  it('performs IndexedDB CRUD and .webgrainy.json archive export/import round-trips', async () => {
    const idb = createProjectMockIDB();
    const opts = { indexedDB: idb };

    const site: SiteRecord = {
      siteId: 'site-1',
      name: 'Gravel Bar A',
      createdAt: 1000,
      updatedAt: 2000,
      options: { poolingMode: 'physical-area' },
      photoOrder: ['ph-1'],
    };
    await saveSite(site, opts);
    expect((await getSite('site-1', opts))?.name).toBe('Gravel Bar A');
    expect((await listSites(opts)).length).toBe(1);

    const photo: PhotoRecord = {
      photoId: 'ph-1',
      siteId: 'site-1',
      label: 'Quadrat 1',
      imageBlob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
      width: 40,
      height: 40,
      addedAt: 1500,
      included: true,
    };
    await savePhoto(photo, opts);
    expect((await getPhoto('ph-1', opts))?.label).toBe('Quadrat 1');
    expect((await listSitePhotos('site-1', opts)).length).toBe(1);

    const session = makeTestSession();
    await savePhotoResult(
      {
        photoId: 'ph-1',
        status: 'done',
        serializedSession: session.toSerialized(),
        updatedAt: 2500,
      },
      opts,
    );

    const archiveBlob = await exportProjectArchive('site-1', opts);

    // Import into a fresh database
    const idb2 = createProjectMockIDB();
    const importedSiteId = await importProjectArchive(archiveBlob, { indexedDB: idb2 });
    expect(importedSiteId).toBe('site-1');

    const restoredSite = await getSite('site-1', { indexedDB: idb2 });
    expect(restoredSite?.name).toBe('Gravel Bar A');
    const restoredPhoto = await getPhoto('ph-1', { indexedDB: idb2 });
    expect(restoredPhoto?.width).toBe(40);
    const restoredBytes = new Uint8Array(await restoredPhoto!.imageBlob.arrayBuffer());
    expect(Array.from(restoredBytes)).toEqual([1, 2, 3, 4]);

    const restoredResult = await getPhotoResult('ph-1', { indexedDB: idb2 });
    expect(restoredResult?.status).toBe('done');
    const hydrated = AnalysisSession.fromSerialized(restoredResult!.serializedSession!);
    expect(hydrated.getStats().includedGrains).toBe(1);

    // Reject invalid archive
    await expect(
      importProjectArchive('{"format":"wrong","version":2}', { indexedDB: idb2 }),
    ).rejects.toThrow(/Unsupported archive/i);

    // Cascade delete
    await deletePhoto('ph-1', opts);
    expect(await getPhoto('ph-1', opts)).toBeUndefined();
    expect(await getPhotoResult('ph-1', opts)).toBeUndefined();
    await deleteSite('site-1', opts);
    expect(await getSite('site-1', opts)).toBeUndefined();
  });

  it('runs sequential batch processing with bitmap cleanup and AbortSignal cancellation', async () => {
    const idb = createProjectMockIDB();
    const opts = { indexedDB: idb };

    await saveSite(
      {
        siteId: 'site-batch',
        name: 'Batch Site',
        createdAt: 1000,
        updatedAt: 1000,
        options: { poolingMode: 'physical-area' },
        photoOrder: ['p1', 'p2'],
      },
      opts,
    );

    for (const id of ['p1', 'p2']) {
      await savePhoto(
        {
          photoId: id,
          siteId: 'site-batch',
          label: id,
          imageBlob: new Blob([new Uint8Array(16)]),
          width: 64,
          height: 64,
          addedAt: 1000,
          included: true,
        },
        opts,
      );
    }

    const engine = new ImageGrainsEngine({
      useWorker: false,
      sessionFactory: async () => createMockOnnxSession({ mode: 'unet' }),
    });

    let closeCount = 0;
    const controller = new AbortController();

    const result = await runSiteBatch({
      siteId: 'site-batch',
      engine,
      indexedDB: idb,
      signal: controller.signal,
      analysisConfig: { model: 'unet', scaleMode: '1.0x' },
      decodeImage: async () =>
        ({
          data: new Uint8ClampedArray(64 * 64 * 4).fill(100),
          width: 64,
          height: 64,
          close: () => {
            closeCount++;
          },
        }) as unknown as ImageBitmap,
      onPhotoComplete: (photo) => {
        if (photo.photoId === 'p1') {
          controller.abort();
        }
      },
    });

    expect(result.completed).toBe(1);
    expect(result.aborted).toBe(true);
    expect(result.completedPhotoIds).toEqual(['p1']);
    expect(closeCount).toBe(1);

    const p1Res = await getPhotoResult('p1', opts);
    expect(p1Res?.status).toBe('done');
    expect(p1Res?.serializedSession).toBeDefined();

    // Resume remaining photo without abort
    const resumed = await runSiteBatch({
      siteId: 'site-batch',
      engine,
      indexedDB: idb,
      analysisConfig: { model: 'unet', scaleMode: '1.0x' },
      decodeImage: async () =>
        ({
          data: new Uint8ClampedArray(64 * 64 * 4).fill(100),
          width: 64,
          height: 64,
          close: () => {
            closeCount++;
          },
        }) as unknown as ImageBitmap,
    });

    expect(resumed.completed).toBe(1);
    expect(resumed.aborted).toBe(false);
    expect(resumed.completedPhotoIds).toEqual(['p2']);
    expect(closeCount).toBe(2);

    await engine.dispose();
  });
});
