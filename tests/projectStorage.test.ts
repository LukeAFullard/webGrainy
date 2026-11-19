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

import { createProjectMockIDB } from './helpers/projectMockIdb.js';

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

    // Round-trip a fine-grain upscaled session (effectiveScaleFactor = 1.5 > 1) with provenance
    const upMasks = new Int32Array(60 * 60);
    for (let y = 18; y <= 42; y++) for (let x = 18; x <= 42; x++) upMasks[y * 60 + x] = 1;
    const upSession = new AnalysisSession({
      workingImage: {
        data: new Uint8ClampedArray(60 * 60 * 4).fill(128),
        width: 60,
        height: 60,
        originalWidth: 40,
        originalHeight: 40,
        effectiveScaleFactor: 1.5,
        scaleModeApplied: '1.0x',
      },
      recommendation: session.recommendation,
      masks: upMasks,
      workingGrains: computeAllGrainMorphometrics(upMasks, 60, 60, 2),
      provenance: {
        appVersion: '1.1.0',
        ortVersion: '1.31.1',
        analyzedAt: '2026-01-01T00:00:00Z',
        modelId: 'ig2_unet_fp32',
        modelFile: 'x',
        modelRevision: 'r',
        modelSha256: 's',
        fineGrainUpscale: 1.5,
      },
    });
    await savePhotoResult(
      { photoId: 'ph-1', status: 'done', serializedSession: upSession.toSerialized(), updatedAt: 3000 },
      opts,
    );
    const upArchive = await exportProjectArchive('site-1', opts);
    const idb3 = createProjectMockIDB();
    await importProjectArchive(upArchive, { indexedDB: idb3 });
    const restoredUp = await getPhotoResult('ph-1', { indexedDB: idb3 });
    expect(restoredUp?.serializedSession?.workingImage.effectiveScaleFactor).toBe(1.5);
    expect(restoredUp?.serializedSession?.provenance?.fineGrainUpscale).toBe(1.5);

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
