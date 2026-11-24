/** Regression (re-audit blocker 3): project archives of any size (binary v2), v1 still imports. */
import { describe, expect, it } from 'vitest';
import {
  AnalysisSession,
  computeAllGrainMorphometrics,
  exportProjectArchive,
  getPhoto,
  getPhotoResult,
  importProjectArchive,
  listSitePhotos,
  listSites,
  savePhoto,
  savePhotoResult,
  saveSite,
  type SiteRecord,
} from '../src/index.js';
import { ARCHIVE_V2_MAGIC } from '../src/modules/projectStorage.js';
import { createProjectMockIDB } from './helpers/projectMockIdb.js';

const site: SiteRecord = { siteId: 'S', name: 'Bar', createdAt: 1, updatedAt: 1, options: { poolingMode: 'physical-area' }, photoOrder: [] };

function session(w = 40, h = 30): AnalysisSession {
  const masks = new Int32Array(w * h);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 20; x++) masks[y * w + x] = 7;
  masks[w * h - 1] = 70000; // > 16 bit
  return new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(w * h * 4).fill(9), width: w, height: h, originalWidth: w * 2, originalHeight: h * 2, effectiveScaleFactor: 0.5, scaleModeApplied: '0.5x' },
    recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
    masks,
    workingGrains: computeAllGrainMorphometrics(masks, w, h, 2),
  });
}

async function headerOf(blob: Blob): Promise<Record<string, unknown>> {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  expect(new TextDecoder().decode(head.subarray(0, 8))).toBe(ARCHIVE_V2_MAGIC);
  const len = new DataView(head.buffer).getUint32(8, true);
  return JSON.parse(await blob.slice(12, 12 + len).text());
}

describe('project archive v2', () => {
  it('round-trips photos, backups and sessions as binary (no base64, no working pixels)', async () => {
    const a = { indexedDB: createProjectMockIDB() };
    await saveSite({ ...site, photoOrder: ['P'] }, a);
    await savePhoto({
      photoId: 'P', siteId: 'S', label: 'q', width: 80, height: 60, addedAt: 1, included: true,
      imageBlob: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/jpeg' }),
      originalBackup: { imageBlob: new Blob([new Uint8Array([7, 7])], { type: 'image/png' }), width: 40, height: 30 },
    }, a);
    const s = session();
    await savePhotoResult({ photoId: 'P', status: 'done', serializedSession: s.toSerialized(), updatedAt: 1 }, a);
    const blob = await exportProjectArchive('S', a);
    const header = await headerOf(blob);
    expect(header['version']).toBe(2);
    expect(JSON.stringify(header)).not.toMatch(/Base64/);
    // Payload: 5 + 2 image bytes + 40*30*4 mask bytes; no working-image pixels kept.
    expect(header['payloadBytes']).toBe(5 + 2 + 40 * 30 * 4);

    const b = { indexedDB: createProjectMockIDB() };
    const id = await importProjectArchive(blob, b);
    const p = await getPhoto('P', b);
    expect(id).toBe('S');
    expect(Array.from(new Uint8Array(await p!.imageBlob.arrayBuffer()))).toEqual([1, 2, 3, 4, 5]);
    expect(p!.imageBlob.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await p!.originalBackup!.imageBlob.arrayBuffer()))).toEqual([7, 7]);
    const r = await getPhotoResult('P', b);
    const restored = AnalysisSession.fromSerialized(r!.serializedSession!);
    expect(Array.from(restored.getWorkingMasks())).toEqual(Array.from(s.getWorkingMasks()));
    expect(restored.getResult().grains.map((g) => g.id)).toEqual([7, 70000]);
    expect(restored.workingImage.effectiveScaleFactor).toBe(0.5);
  });

  it('exports and re-imports a project larger than the old 512 MB JSON limit', async () => {
    const a = { indexedDB: createProjectMockIDB() };
    const big = new Blob([new Uint8Array(12_000_000)], { type: 'image/jpeg' }); // shared: no copies
    const n = 46; // 46 x 12 MB = 552 MB > V8's maximum string length (old format: ~40 photos)
    await saveSite({ ...site, photoOrder: Array.from({ length: n }, (_, i) => `p${i}`) }, a);
    const ser = session().toSerialized();
    for (let i = 0; i < n; i++) {
      await savePhoto({ photoId: `p${i}`, siteId: 'S', label: `p${i}`, imageBlob: big, width: 4000, height: 3000, addedAt: 1, included: true }, a);
      await savePhotoResult({ photoId: `p${i}`, status: 'done', serializedSession: ser, updatedAt: 1 }, a);
    }
    const blob = await exportProjectArchive('S', a);
    expect(blob.size).toBeGreaterThan(552_000_000);
    const header = await headerOf(blob);
    expect(JSON.stringify(header).length).toBeLessThan(200_000);
    const b = { indexedDB: createProjectMockIDB() };
    await importProjectArchive(blob, b);
    const photos = await listSitePhotos('S', b);
    expect(photos).toHaveLength(n);
    expect(photos[n - 1]!.imageBlob.size).toBe(12_000_000);
  }, 120_000);

  it('still imports v1 JSON archives (base64)', async () => {
    const s = session().toSerialized();
    const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
    const v1 = {
      format: 'webgrainy-project', version: 1, exportedAt: 'x', site: { ...site, photoOrder: ['P'] },
      photos: [{ photoId: 'P', siteId: 'S', label: 'q', width: 80, height: 60, addedAt: 1, included: true, imageBase64: b64(new Uint8Array([4, 2])), imageMimeType: 'image/png' }],
      results: [{
        photoId: 'P', status: 'done', updatedAt: 1,
        serializedSession: {
          ...s, workingMasks: undefined,
          workingMasksBase64: b64(new Uint8Array(s.workingMasks.buffer)),
          workingImage: { ...s.workingImage, data: undefined, dataBase64: b64(new Uint8Array(40 * 30 * 4)) },
        },
      }],
    };
    const db = { indexedDB: createProjectMockIDB() };
    await importProjectArchive(new Blob([JSON.stringify(v1)]), db);
    expect(Array.from(new Uint8Array(await (await getPhoto('P', db))!.imageBlob.arrayBuffer()))).toEqual([4, 2]);
    expect(AnalysisSession.fromSerialized((await getPhotoResult('P', db))!.serializedSession!).getResult().grainCount).toBe(2);
  });

  it('rejects byte references outside the payload', async () => {
    const a = { indexedDB: createProjectMockIDB() };
    await saveSite({ ...site, photoOrder: ['P'] }, a);
    await savePhoto({ photoId: 'P', siteId: 'S', label: 'q', width: 8, height: 8, addedAt: 1, included: true, imageBlob: new Blob([new Uint8Array(4)]) }, a);
    const blob = await exportProjectArchive('S', a);
    const header = await headerOf(blob);
    (header['photos'] as Array<{ imageRef: { length: number } }>)[0]!.imageRef.length = 999;
    const h = new TextEncoder().encode(JSON.stringify(header));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, h.byteLength, true);
    const tampered = new Blob([new TextEncoder().encode(ARCHIVE_V2_MAGIC), len, h, new Uint8Array(4)]);
    await expect(importProjectArchive(tampered, { indexedDB: createProjectMockIDB() })).rejects.toThrow(/invalid byte reference/);
  });
});

describe('rectification backup in project files', () => {
  it('round-trips the photo before rectification, with its own enhancement backup', async () => {
    const a = { indexedDB: createProjectMockIDB() };
    await saveSite({ ...site, photoOrder: ['P'] }, a);
    const cal = { mmPerPx: 2, pointA: { x: 0, y: 0 }, pointB: { x: 10, y: 0 }, physicalLengthMm: 20, pixelDistance: 10 };
    await savePhoto({
      photoId: 'P', siteId: 'S', label: 'q', width: 200, height: 120, addedAt: 1, included: true,
      imageBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      rectifyBackup: {
        imageBlob: new Blob([new Uint8Array([4, 5, 6, 7])], { type: 'image/jpeg' }), width: 80, height: 60, calibration: cal,
        originalBackup: { imageBlob: new Blob([new Uint8Array([8, 9])], { type: 'image/jpeg' }), width: 40, height: 30 },
      },
    }, a);
    const b = { indexedDB: createProjectMockIDB() };
    await importProjectArchive(await exportProjectArchive('S', a), b);
    const [p] = await listSitePhotos('S', b);
    const rb = p!.rectifyBackup!;
    expect([rb.width, rb.height, rb.calibration?.mmPerPx]).toEqual([80, 60, 2]);
    expect([...new Uint8Array(await rb.imageBlob.arrayBuffer())]).toEqual([4, 5, 6, 7]);
    expect([...new Uint8Array(await rb.originalBackup!.imageBlob.arrayBuffer())]).toEqual([8, 9]);
    expect(rb.originalBackup!.width).toBe(40);
  });
});

describe('project import checks (audit S12)', () => {
  /** Re-assemble a v2 archive with an edited header and the original payload. */
  async function withHeader(blob: Blob, edit: (h: Record<string, unknown>) => void): Promise<Blob> {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const oldLen = new DataView(head.buffer).getUint32(8, true);
    const header = await headerOf(blob);
    edit(header);
    const h = new TextEncoder().encode(JSON.stringify(header));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, h.byteLength, true);
    return new Blob([new TextEncoder().encode(ARCHIVE_V2_MAGIC), len, h, blob.slice(12 + oldLen)]);
  }
  async function twoPhotoArchive(): Promise<Blob> {
    const a = { indexedDB: createProjectMockIDB() };
    await saveSite({ ...site, photoOrder: ['P1', 'P2'] }, a);
    for (const id of ['P1', 'P2']) {
      await savePhoto({ photoId: id, siteId: 'S', label: id, width: 80, height: 60, addedAt: 1, included: true, imageBlob: new Blob([new Uint8Array(4)]) }, a);
      await savePhotoResult({ photoId: id, status: 'done', serializedSession: session().toSerialized(), updatedAt: 1 }, a);
    }
    return exportProjectArchive('S', a);
  }

  it('rejects two results sharing one mask, and a mask of the wrong size, before decoding it', async () => {
    const blob = await twoPhotoArchive();
    type R = { serializedSession: { workingMasksRef: unknown; workingImage: { width: number } } };
    const shared = await withHeader(blob, (h) => {
      const rs = h['results'] as R[];
      rs[1]!.serializedSession.workingMasksRef = rs[0]!.serializedSession.workingMasksRef;
    });
    await expect(importProjectArchive(shared, { indexedDB: createProjectMockIDB() })).rejects.toThrow(/bytes shared with/);
    const wrong = await withHeader(blob, (h) => {
      (h['results'] as R[])[0]!.serializedSession.workingImage.width = 41;
    });
    await expect(importProjectArchive(wrong, { indexedDB: createProjectMockIDB() })).rejects.toThrow(/mask size does not match/);
  });

  it('F-08: rejects photos or masks pointing into the same bytes, even at different offsets', async () => {
    const blob = await twoPhotoArchive();
    type P = { imageRef: { offset: number; length: number } };
    const samePhoto = await withHeader(blob, (h) => {
      const ps = h['photos'] as P[];
      ps[1]!.imageRef = { ...ps[0]!.imageRef };
    });
    await expect(importProjectArchive(samePhoto, { indexedDB: createProjectMockIDB() })).rejects.toThrow(/bytes shared with/);
    type R = { serializedSession: { workingMasksRef: { offset: number; length: number } } };
    const overlapping = await withHeader(blob, (h) => {
      const rs = h['results'] as R[];
      const m0 = rs[0]!.serializedSession.workingMasksRef;
      rs[1]!.serializedSession.workingMasksRef = { offset: m0.offset + 4, length: m0.length };
    });
    await expect(importProjectArchive(overlapping, { indexedDB: createProjectMockIDB() })).rejects.toThrow(/bytes shared with|invalid byte reference/);
  });

  it('F-08: rejects a duplicate result, and does not decode results of photos not in the file', async () => {
    const blob = await twoPhotoArchive();
    type R = { photoId: string };
    const dup = await withHeader(blob, (h) => {
      (h['results'] as R[])[1]!.photoId = 'P1';
    });
    await expect(importProjectArchive(dup, { indexedDB: createProjectMockIDB() })).rejects.toThrow(/duplicate result/);
    const orphan = await withHeader(blob, (h) => {
      const r = (h['results'] as Array<R & { serializedSession: { workingImage: { width: number } } }>)[1]!;
      r.photoId = 'ghost';
      r.serializedSession.workingImage.width = 41; // would fail if it were decoded
    });
    const db = { indexedDB: createProjectMockIDB() };
    await importProjectArchive(orphan, db);
    expect((await listSitePhotos('S', db)).map((p) => p.photoId).sort()).toEqual(['P1', 'P2']);
  });

  it('F-08: caps exclusion areas', async () => {
    const blob = await twoPhotoArchive();
    const many = await withHeader(blob, (h) => {
      (h['photos'] as Array<Record<string, unknown>>)[0]!['roiConfig'] = {
        exclusionPolygons: [],
        exclusionStrokes: [{ points: [{ x: 1, y: 1 }], radiusPx: 1e9 }],
      };
    });
    await expect(importProjectArchive(many, { indexedDB: createProjectMockIDB() })).rejects.toThrow(/radius/);
  });

  it('F-28: refuses a site id that is a prototype name', async () => {
    const blob = await withHeader(await twoPhotoArchive(), (h) => {
      (h['site'] as { siteId: string }).siteId = 'constructor';
    });
    await expect(importProjectArchive(blob, { indexedDB: createProjectMockIDB() })).rejects.toThrow(/siteId/);
  });

  it('keeps only photo ids of this file in photoOrder, each once', async () => {
    const blob = await withHeader(await twoPhotoArchive(), (h) => {
      (h['site'] as { photoOrder: string[] }).photoOrder = ['P2', 'ghost', 'P1', 'P2'];
    });
    const db = { indexedDB: createProjectMockIDB() };
    await importProjectArchive(blob, db);
    expect((await listSites(db))[0]!.photoOrder).toEqual(['P2', 'P1']);
  });
});

describe('archive limits match the analysis settings', () => {
  it('a project analysed with a large border margin (engine allows up to 1000 px) round-trips', async () => {
    const { AnalysisSession } = await import('../src/modules/analysisSession.js');
    const { exportProjectArchive, importProjectArchive, getPhotoResult, saveSite, savePhoto, savePhotoResult } = await import('../src/modules/projectStorage.js');
    const { createProjectMockIDB } = await import('./helpers/projectMockIdb.js');
    const { squareGrainSession } = await import('./helpers/squareSession.js');
    const sess = AnalysisSession.fromSerialized({ ...squareGrainSession([20, 30]).toSerialized(), borderMargin: 300 });
    const opts = { indexedDB: createProjectMockIDB() };
    await saveSite({ siteId: 'S', name: 'S', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p'] }, opts);
    await savePhoto({ photoId: 'p', siteId: 'S', label: 'p', imageBlob: new Blob([new Uint8Array(8)], { type: 'image/png' }), width: 600, height: 600, addedAt: 0, included: true }, opts);
    await savePhotoResult({ photoId: 'p', status: 'done', serializedSession: sess.toSerialized(), updatedAt: 0 }, opts);
    const target = { indexedDB: createProjectMockIDB() };
    const siteId = await importProjectArchive(await exportProjectArchive('S', opts), target);
    expect(siteId).toBe('S');
    expect((await getPhotoResult('p', target))?.serializedSession?.borderMargin).toBe(300);
  });
});

describe('imported places join existing places', () => {
  it('reuses an existing place spelling (case and spacing ignored) and tidies the name', async () => {
    const { exportProjectArchive, importProjectArchive, getSite, saveSite, savePhoto } = await import('../src/modules/projectStorage.js');
    const { createProjectMockIDB } = await import('./helpers/projectMockIdb.js');
    const src = { indexedDB: createProjectMockIDB() };
    await saveSite({ siteId: 'NEW', name: 'Spring', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p'], place: '  rakaia   REACH 3 ' }, src);
    await savePhoto({ photoId: 'p', siteId: 'NEW', label: 'p', imageBlob: new Blob([new Uint8Array(8)], { type: 'image/png' }), width: 10, height: 10, addedAt: 0, included: true }, src);
    const dst = { indexedDB: createProjectMockIDB() };
    await saveSite({ siteId: 'OLD', name: 'Autumn', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: [], place: 'Rakaia reach 3' }, dst);
    const id = await importProjectArchive(await exportProjectArchive('NEW', src), dst);
    expect((await getSite(id, dst))?.place).toBe('Rakaia reach 3');
    // A new place is kept, tidied.
    const dst2 = { indexedDB: createProjectMockIDB() };
    const id2 = await importProjectArchive(await exportProjectArchive('NEW', src), dst2);
    expect((await getSite(id2, dst2))?.place).toBe('rakaia REACH 3');
  });
});
