/**
 * Regression (audit C2): site settings from a project file are untrusted. A file with an
 * enormous bootstrap count and a far-future date froze the page on every start-up (the site
 * sorted first, opened automatically and its report took hours on the main thread).
 */
import { describe, expect, it } from 'vitest';
import { clampRecordTime, sanitizeSiteOptions } from '../src/modules/siteOptions.js';
import { exportProjectArchive, getSite, importProjectArchive, listSites, savePhoto, savePhotoResult, saveSite } from '../src/modules/projectStorage.js';
import { computeVirtualWolmanHits } from '../src/modules/sitePooling.js';
import { createProjectMockIDB } from './helpers/projectMockIdb.js';
import { squareGrainSession } from './helpers/squareSession.js';

describe('sanitizeSiteOptions', () => {
  it('keeps every value the app can set', () => {
    const app = {
      poolingMode: 'virtual-wolman-grid', sizeMetric: 'minFeret', minBaxisPx: 15, harmonizePhysicalCutoff: true,
      wolmanPointsPerPhoto: 100, bootstrapReplicates: 500, bootstrapSeed: 42, bootstrapTwoStage: false,
      confidenceLevel: 0.9, minSizeMm: 13, maxExcludedFraction: 0.1,
    };
    expect(sanitizeSiteOptions(app)).toEqual(app);
  });

  it('drops values outside what the app can set', () => {
    const out = sanitizeSiteOptions({
      poolingMode: 'evil', sizeMetric: 'x', bootstrapReplicates: 2e9, wolmanPointsPerPhoto: 1e12, wolmanGridSpacingMm: 1e-9,
      confidenceLevel: 0.5, minBaxisPx: -5, maxExcludedFraction: 3, bootstrapSeed: 1.5, bootstrapTwoStage: 'yes', __proto__x: 1,
    });
    expect(out).toEqual({ poolingMode: 'physical-area' });
    expect(sanitizeSiteOptions(null)).toEqual({ poolingMode: 'physical-area' });
    expect(sanitizeSiteOptions([1])).toEqual({ poolingMode: 'physical-area' });
  });

  it('clamps record times to the past', () => {
    expect(clampRecordTime(8.64e15, 1000)).toBe(1000);
    expect(clampRecordTime(-1, 1000)).toBe(0);
    expect(clampRecordTime('x', 1000)).toBe(1000);
    expect(clampRecordTime(500, 1000)).toBe(500);
  });
});

describe('importing a tampered project', () => {
  it('stores sanitised options and no future dates', async () => {
    const a = { indexedDB: createProjectMockIDB() };
    await saveSite({ siteId: 'S', name: 'Shared', createdAt: 1, updatedAt: 1, options: { poolingMode: 'physical-area', bootstrapReplicates: 500 }, photoOrder: ['P'] } as never, a);
    const sess = squareGrainSession([20, 25, 30, 35], { mmPerPx: 0.5 });
    await savePhoto({ photoId: 'P', siteId: 'S', label: 'p.jpg', width: 600, height: 600, addedAt: 1, included: true, imageBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) } as never, a);
    await savePhotoResult({ photoId: 'P', status: 'done', serializedSession: sess.toSerialized(), updatedAt: 1 }, a);
    const bytes = new Uint8Array(await (await exportProjectArchive('S', a)).arrayBuffer());
    const hlen = new DataView(bytes.buffer).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hlen)));
    header.site.options = { poolingMode: 'physical-area', bootstrapReplicates: 2e9, wolmanPointsPerPhoto: 1e12, confidenceLevel: 0.5 };
    header.site.updatedAt = 8.64e15;
    header.site.createdAt = 8.64e15;
    const nh = new TextEncoder().encode(JSON.stringify(header));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, nh.byteLength, true);
    const tampered = new Blob([bytes.subarray(0, 8), len, nh, bytes.subarray(12 + hlen)]);

    const b = { indexedDB: createProjectMockIDB() };
    const before = Date.now();
    const id = await importProjectArchive(tampered, b);
    const site = (await getSite(id, b))!;
    expect(site.options).toEqual({ poolingMode: 'physical-area' });
    expect(site.updatedAt).toBeLessThanOrEqual(Date.now());
    expect(site.updatedAt).toBeGreaterThanOrEqual(before);
    expect(site.createdAt).toBeLessThanOrEqual(Date.now());
    expect((await listSites(b)).length).toBe(1);
  });
});

describe('virtual Wolman grid size is bounded', () => {
  it('never lays more than 10,000 points per photo', () => {
    const sess = squareGrainSession([20, 25, 30], { mmPerPx: 0.5 });
    const res = sess.getResult();
    const valid = { valid: new Uint8Array(res.width * res.height).fill(1), validPixelCount: res.width * res.height } as never;
    const ids = new Set(res.grains.map((g) => g.id));
    const count = (o: object) => {
      const r = computeVirtualWolmanHits(sess, valid, ids, new Set(), { poolingMode: 'virtual-wolman-grid', ...o }, 0.5, 'mm');
      return r.gridGrainHits + r.gridMatrixHits + r.gridSubCutoffHits;
    };
    expect(count({ wolmanPointsPerPhoto: 1e12 })).toBeLessThanOrEqual(10_000);
    expect(count({ wolmanGridSpacingMm: 1e-9 })).toBeLessThanOrEqual(10_500);
  });
});
