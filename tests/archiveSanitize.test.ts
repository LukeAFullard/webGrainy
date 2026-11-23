/**
 * Regressions for the pre-publication audit (blocker B1 and import findings S1): an imported
 * .webgrainy project is untrusted. Its text must never reach the page as markup, and hidden or
 * inconsistent fields must not change later analyses or statistics, or break a site.
 */
import { describe, expect, it } from 'vitest';
import { createProjectMockIDB } from './helpers/projectMockIdb.js';
import { squareGrainSession } from './helpers/squareSession.js';
import {
  ARCHIVE_V2_MAGIC,
  exportProjectArchive,
  getPhotoResult,
  getSite,
  importProjectArchive,
  MAX_ARCHIVE_PHOTOS,
  listSitePhotos,
  savePhoto,
  savePhotoResult,
  saveSite,
} from '../src/modules/projectStorage.js';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { analyzeSite, buildSiteExportMetadata } from '../src/modules/siteAnalysis.js';
import { buildSiteInputs } from '../src/modules/siteWorkspace.js';
import { photoProcessingHistory } from '../src/modules/siteTypes.js';
import { photoGeoreference } from '../src/modules/georef.js';
import { sanitizeCalibration, sanitizePhotoMetadata, sanitizeProvenance, sanitizeRecommendation, workingScaleFromSizes } from '../src/modules/archiveSanitize.js';
import { ImageGrainsEngine, type InferenceSessionLike } from '../src/index.js';
import { createInitialState, type AppState } from '../src/ui/state.js';
import { renderSidebarHtml, type SidebarView } from '../src/ui/panels/sidebar.js';

const XSS = '<meta http-equiv="refresh" content="0;url=https://example.com/phish"><b class="xss">x</b>';

/** A real one-photo project archive (v2) split into its JSON header and binary payload. */
async function baseArchive(): Promise<{ header: Record<string, any>; payload: Uint8Array }> {
  const db = { indexedDB: createProjectMockIDB() };
  const sess = squareGrainSession(Array.from({ length: 40 }, (_, i) => 16 + (i % 20)), { mmPerPx: 0.5 });
  await saveSite({ siteId: 'S', name: 'Site', photoOrder: ['P'], options: { poolingMode: 'physical-area' }, createdAt: 1, updatedAt: 1 }, db);
  await savePhoto({ photoId: 'P', siteId: 'S', label: 'p.jpg', imageBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), width: 600, height: 600, addedAt: 1, included: true, calibration: sess.getCalibration()! }, db);
  await savePhotoResult({
    photoId: 'P',
    status: 'done',
    serializedSession: {
      ...sess.toSerialized(),
      provenance: { appVersion: '0.1.0', ortVersion: '1.31.1', analyzedAt: '2026-01-01T00:00:00Z', modelId: 'ig2_unet_fp32', modelFile: 'ig2_unet_fp32.onnx', modelRevision: 'r', modelSha256: 'a'.repeat(64), scaleMode: 'auto', postProcess: { minSize: 30, flowThreshold: 0.45 } },
    },
    updatedAt: 1,
  }, db);
  const buf = new Uint8Array(await (await exportProjectArchive('S', db)).arrayBuffer());
  const len = new DataView(buf.buffer).getUint32(8, true);
  return { header: JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + len))), payload: buf.subarray(12 + len) };
}

function pack(header: unknown, payload: Uint8Array): Blob {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, h.byteLength, true);
  return new Blob([new TextEncoder().encode(ARCHIVE_V2_MAGIC), len, h, payload as Uint8Array<ArrayBuffer>]);
}

async function importAndLoad(header: unknown, payload: Uint8Array) {
  const db = { indexedDB: createProjectMockIDB() };
  const siteId = await importProjectArchive(pack(header, payload), db);
  const site = (await getSite(siteId, db))!;
  const photos = await listSitePhotos(siteId, db);
  const result = (await getPhotoResult(photos[0]!.photoId, db))!;
  const session = AnalysisSession.fromSerialized(result.serializedSession!);
  if (photos[0]!.calibration) session.setCalibration(photos[0]!.calibration);
  return { site, photos, result, session };
}

describe('imported text never becomes markup', () => {
  it('an injected model name is replaced by a known value and the photo list shows only plain text', async () => {
    const { header, payload } = await baseArchive();
    header['results'][0].serializedSession.recommendation = { model: XSS, confidence: 'x', rationale: 7, metrics: { evil: XSS } };
    const { photos, result, session } = await importAndLoad(header, payload);
    const rec = result.serializedSession!.recommendation;
    expect(rec.model).toBe('unet');
    expect(JSON.stringify(rec)).not.toContain('<');

    const state: AppState = {
      ...createInitialState(),
      sites: [{ siteId: 's', name: 'S', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: [photos[0]!.photoId] }],
      activeSiteId: 's',
      photos,
      sessions: new Map([[photos[0]!.photoId, session]]),
      photoStatuses: new Map([[photos[0]!.photoId, 'done']] as const),
    };
    const view: SidebarView = { guideHtml: '', settingsOpen: false, cpuThreadPref: 'auto', cpuThreads: 2, crossOriginIsolated: true, canNotify: false, notifyWhenDone: false, storageInfo: null };
    expect(renderSidebarHtml(state, view)).toContain(' · unet');
  });

  it('the photo list never renders a stored model name as markup (records saved before this fix)', () => {
    const sess = squareGrainSession([20, 30], { mmPerPx: 0.5 });
    (sess as unknown as { recommendation: { model: string } }).recommendation = { model: XSS } as never;
    const state: AppState = {
      ...createInitialState(),
      sites: [{ siteId: 's', name: 'S', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p'] }],
      activeSiteId: 's',
      photos: [{ photoId: 'p', siteId: 's', label: 'p.jpg', imageBlob: new Blob([]), width: 600, height: 600, addedAt: 0, included: true }],
      sessions: new Map([['p', sess]]),
      photoStatuses: new Map([['p', 'done']] as const),
    };
    const html = renderSidebarHtml(state, { guideHtml: '', settingsOpen: false, cpuThreadPref: 'auto', cpuThreads: 2, crossOriginIsolated: true, canNotify: false, notifyWhenDone: false, storageInfo: null });
    expect(html).not.toContain('<meta');
    expect(html).not.toContain('class="xss"');
  });

  it('provenance strings are plain tokens; an unknown model drops the record', () => {
    const p = sanitizeProvenance({ modelId: 'ig2_unet_fp32', appVersion: XSS, modelSha256: XSS, scaleMode: XSS, executionProvider: 'webgpu', postProcess: { minSize: 30, flowThreshold: XSS, niter: 1e9 } }, 1)!;
    expect(p.appVersion).toBe('unknown');
    expect(p.modelSha256).toBe('unknown');
    expect(p.scaleMode).toBeUndefined();
    expect(p.executionProvider).toBe('webgpu');
    expect(p.postProcess).toEqual({ minSize: 30 });
    expect(p.modelFile).toBe('ig2_unet_fp32.onnx');
    expect(sanitizeProvenance({ modelId: XSS }, 1)).toBeUndefined();
    expect(sanitizeRecommendation(null, 'cpsam').model).toBe('cpsam');
  });

  it('keeps only the fields the app writes on photo, result and site records', async () => {
    const { header, payload } = await baseArchive();
    const ph = header['photos'][0];
    ph.evil = XSS;
    ph.metadata = { cameraMake: 'Canon', evil: XSS, gps: { lat: 'x', lon: 1e300 }, timestamp: XSS };
    ph.calibration = { ...ph.calibration, source: XSS, copiedFrom: 'p2.jpg', extra: 1 };
    header['results'][0].evil = XSS;
    header['results'][0].errorMessage = 'x'.repeat(10_000);
    header['site'].photoOrder = ['P', { a: 1 }, 42, null];
    header['site'].evil = XSS;
    const { site, photos, result } = await importAndLoad(header, payload);
    expect(Object.keys(photos[0]!)).not.toContain('evil');
    expect(photos[0]!.metadata).toEqual({ cameraMake: 'Canon' });
    expect(photos[0]!.calibration!.source).toBeUndefined();
    expect(photos[0]!.calibration!.copiedFrom).toBeUndefined(); // only kept for a copied scale
    expect(Object.keys(result)).not.toContain('evil');
    expect(result.errorMessage!.length).toBe(2000);
    expect(site.photoOrder).toEqual(['P']);
    expect(Object.keys(site)).not.toContain('evil');
  });
});

describe('imported settings cannot change later analyses or statistics', () => {
  it('a working scale that disagrees with the image sizes is recomputed (sizes stay correct)', async () => {
    const { header, payload } = await baseArchive();
    const reference = await importAndLoad(header, payload);
    header['results'][0].serializedSession.workingImage.effectiveScaleFactor = 4;
    const tampered = await importAndLoad(header, payload);
    expect(tampered.session.workingImage.effectiveScaleFactor).toBe(1);
    expect(tampered.session.getStats('bAxis').areaWeightedB.D50).toBe(reference.session.getStats('bAxis').areaWeightedB.D50);
  });

  it('refuses an analysis whose working and photo sizes do not match', async () => {
    const { header, payload } = await baseArchive();
    header['results'][0].serializedSession.workingImage.originalHeight = 300;
    await expect(importProjectArchive(pack(header, payload), { indexedDB: createProjectMockIDB() })).rejects.toThrow(/sizes are inconsistent/);
    expect(workingScaleFromSizes({ width: 1024, height: 768, originalWidth: 8064, originalHeight: 6048 })).toBeCloseTo(1024 / 8064, 12);
  });

  it('a photo keeps only its fine-grain enlargement setting, bounded', async () => {
    const { header, payload } = await baseArchive();
    header['photos'][0].analysisConfig = { model: 'cpsam', scaleMode: '1.0x', postProcess: { minSize: 1e7 }, inferencePipeline: 'evil', fineGrainUpscale: 64 };
    expect((await importAndLoad(header, payload)).photos[0]!.analysisConfig).toBeUndefined();
    header['photos'][0].analysisConfig = { model: 'cpsam', fineGrainUpscale: 1.5 };
    expect((await importAndLoad(header, payload)).photos[0]!.analysisConfig).toEqual({ fineGrainUpscale: 1.5 });
  });

  it('a malformed image-step history is dropped and the site still analyses and exports', async () => {
    const { header, payload } = await baseArchive();
    header['photos'][0].metadata = { processingHistory: 'nope' };
    const { photos, session } = await importAndLoad(header, payload);
    expect(photos[0]!.metadata).toBeUndefined();
    const inputs = buildSiteInputs({ photos, sessions: new Map([[photos[0]!.photoId, session]]), siteOptions: {} });
    expect(analyzeSite(inputs, { poolingMode: 'physical-area', bootstrapReplicates: 20 }).validGrainCount).toBeGreaterThan(0);
    expect(() => buildSiteExportMetadata(inputs)).not.toThrow();
  });

  it('records stored before this fix with a malformed history do not break a site', () => {
    for (const bad of ['nope', { a: 1 }, [null, 3]]) {
      const meta = { processingHistory: bad } as never;
      expect(() => photoProcessingHistory(meta)).not.toThrow();
      expect(() => photoGeoreference({ width: 10, height: 10, metadata: meta })).not.toThrow();
    }
  });

  it('a normal project keeps its provenance, scale and settings unchanged', async () => {
    const { header, payload } = await baseArchive();
    const { result, photos } = await importAndLoad(header, payload);
    const prov = result.serializedSession!.provenance!;
    expect(prov).toMatchObject({ appVersion: '0.1.0', modelId: 'ig2_unet_fp32', modelSha256: 'a'.repeat(64), scaleMode: 'auto', postProcess: { minSize: 30, flowThreshold: 0.45 } });
    expect(photos[0]!.calibration).toEqual(header['photos'][0].calibration);
  });
});

describe('engine: fine-grain enlargement is bounded', () => {
  const session = (): InferenceSessionLike => ({
    async run(feeds: Record<string, unknown>) {
      const t = feeds['image'] as { dims: readonly number[] };
      const n = (t.dims[2] ?? 0) * (t.dims[3] ?? 0);
      return { flows_cellprob: { data: new Float32Array(3 * n).fill(-5), dims: [1, 3, t.dims[2] ?? 0, t.dims[3] ?? 0] } };
    },
  });
  const img = { data: new Uint8ClampedArray(64 * 64 * 4).fill(120), width: 64, height: 64 };

  it('refuses factors above 2', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const engine = new ImageGrainsEngine({ sessionFactory: async () => session() });
    await expect(engine.analyzeImage(img, { model: 'unet', fineGrainUpscale: 64 })).rejects.toThrow(/fineGrainUpscale/);
    await expect(engine.analyzeImage(img, { model: 'unet', fineGrainUpscale: Number.NaN })).rejects.toThrow(/fineGrainUpscale/);
  });
});

describe('import size limits', () => {
  it('a file with more photos than any survey is refused before anything is written', async () => {
    const { header, payload } = await baseArchive();
    header['photos'] = Array.from({ length: MAX_ARCHIVE_PHOTOS + 1 }, (_, i) => ({ ...header['photos'][0], photoId: `P${i}` }));
    const db = { indexedDB: createProjectMockIDB() };
    await expect(importProjectArchive(pack(header, payload), db)).rejects.toThrow(/at most 10000 photos/);
  });
});

describe('scale and georeference checks (audit S12)', () => {
  it('rebuilds a non-positive stored length from the points', () => {
    const c = sanitizeCalibration({ mmPerPx: 0.5, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: -50, pixelDistance: 0 })!;
    expect(c.physicalLengthMm).toBe(50);
    expect(c.pixelDistance).toBe(100);
  });
  it('drops a singular transform or a non-positive size', () => {
    const g = (over: Record<string, unknown>) => sanitizePhotoMetadata({ georef: { transform: [1000, 0.01, 0, 5000, 0, -0.01], epsg: 2193, kind: 'projected', width: 10, height: 10, ...over } })?.georef;
    expect(g({})).toBeDefined();
    expect(g({ transform: [0, 0, 0, 0, 0, 0] })).toBeUndefined();
    expect(g({ width: -10 })).toBeUndefined();
    expect(g({ height: 0 })).toBeUndefined();
  });
});
