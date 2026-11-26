// Regression tests for numerical and statistical correctness. Several target mutations that
// previously survived the whole suite.
import { describe, expect, it } from 'vitest';
import {
  computeFolkWardStats,
  computeSedimentStats,
  computeWentworthProportions,
} from '../src/modules/sedimentStats.js';
import { evaluateGrainFlowQcV4, computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import {
  binomialConfidenceRanks,
  buildSiteExportMetadata,
  exportPooledGrainsCsv,
} from '../src/modules/siteAnalysis.js';
import { computeExtendedMorphometrics, computeFeretDiameters } from '../src/modules/morphometricsExt.js';
import { csvCell, metadataCommentLines } from '../src/modules/provenance.js';
import { computeBinomialCi } from '../src/modules/siteUncertainty.js';
import { AnalysisSession } from '../src/modules/pipelineController.js';
import { ScaleCalibrator } from '../src/modules/interactiveEditor.js';
import {
  getPhoto,
  getSite,
  importProjectArchive,
  saveSite,
} from '../src/modules/projectStorage.js';
import type { GrainMorphometrics, PsdPercentiles } from '../src/types/index.js';
import { createProjectMockIDB } from './helpers/projectMockIdb.js';

const grain = (id: number, b: number, extra: Partial<GrainMorphometrics> = {}): GrainMorphometrics => ({
  id,
  areaPx: (Math.PI * b * b) / 4,
  centroidX: 10,
  centroidY: 10,
  aAxisPx: b * 1.5,
  bAxisPx: b,
  dEqPx: b,
  orientationRad: 0,
  touchesBorder: false,
  bbox: [0, 0, 1, 1],
  ...extra,
});

/** Builds a symmetric PSD in mm with prescribed phi spreads (phi_p = -log2 D_{100-p}). */
function psdFromPhi(phi: Record<number, number>): PsdPercentiles {
  const d = (p: number) => 2 ** -phi[p]!;
  return {
    D5: d(95), D10: d(90), D16: d(84), D25: d(75), D50: d(50),
    D75: d(25), D84: d(16), D90: d(10), D95: d(5),
  };
}

describe('F-19 binomial CI ranks (Eaton et al. 2019) vs independent scipy computation', () => {
  // [n, p, alpha, lowerRank, upperRank] from scipy.stats.binom with linear rank interpolation.
  const ref: Array<[number, number, number, number, number]> = [
    [100, 0.5, 0.05, 39.682404, 59.317596],
    [100, 0.16, 0.05, 8.609961, 22.979287],
    [100, 0.84, 0.1, 77.255165, 89.367393],
    [400, 0.5, 0.05, 179.903768, 219.096232],
    [37, 0.95, 0.05, 31.585837, 36.833211],
    [1000, 0.84, 0.05, 816.446867, 861.896289],
  ];
  it.each(ref)('n=%i p=%f alpha=%f', (n, p, alpha, le, ue) => {
    const r = binomialConfidenceRanks(n, p, alpha);
    expect(r.le).toBeCloseTo(le, 3);
    expect(r.ue).toBeCloseTo(ue, 3);
  });
});

describe('binomial CI: ranks to sizes (audit S2)', () => {
  it('centres the D50 interval on the sample median (0-based ranks on the midpoint CDF)', () => {
    // Sizes 2^1..2^10: log2 interpolation is linear in the exponent, so log2(size) = 1 + 0-based rank.
    const values = Array.from({ length: 10 }, (_, i) => 2 ** (i + 1));
    const ci = computeBinomialCi(values, values.map(() => 1), 'number-weighted', 0.95);
    const { le, ue } = binomialConfidenceRanks(10, 0.5, 0.05);
    expect(Math.log2(ci.lower.D50)).toBeCloseTo(1 + le, 9);
    expect(Math.log2(ci.upper.D50)).toBeCloseTo(1 + ue, 9);
    expect((Math.log2(ci.lower.D50) + Math.log2(ci.upper.D50)) / 2).toBeCloseTo(5.5, 9); // sample median 2^5.5
  });

  it('has no jump between the exact (n <= 5000) and normal (n > 5000) rank formulas', () => {
    for (const p of [0.05, 0.16, 0.5, 0.84, 0.95]) {
      for (const alpha of [0.05, 0.1]) {
        const a = binomialConfidenceRanks(5000, p, alpha);
        const b = binomialConfidenceRanks(5001, p, alpha);
        // One more grain moves the ranks by about p; the old formula jumped by up to a rank.
        expect(Math.abs(b.le - a.le - p)).toBeLessThan(0.05);
        expect(Math.abs(b.ue - a.ue - p)).toBeLessThan(0.05);
      }
    }
  });
});

describe('Folk & Ward class thresholds (Folk & Ward 1957)', () => {
  const sortingLabelFor = (sigma: number): string => {
    // Symmetric phi distribution: sorting = s/2 + s/3.3 with phi16=-s/2.. chosen below.
    const s = sigma / (0.5 + 1 / 3.3);
    const fw = computeFolkWardStats(
      psdFromPhi({ 5: -s, 10: -0.8 * s, 16: -s, 25: -s / 2, 50: 0, 75: s / 2, 84: s, 90: 0.8 * s, 95: s }),
    );
    expect(fw!.sortingPhi).toBeCloseTo(sigma, 9);
    return fw!.sortingLabel;
  };
  it('sorting class boundaries', () => {
    expect(sortingLabelFor(0.34)).toBe('Very Well Sorted');
    expect(sortingLabelFor(0.36)).toBe('Well Sorted');
    expect(sortingLabelFor(0.49)).toBe('Well Sorted');
    expect(sortingLabelFor(0.51)).toBe('Moderately Well Sorted');
    expect(sortingLabelFor(0.99)).toBe('Moderately Sorted');
    expect(sortingLabelFor(1.01)).toBe('Poorly Sorted');
    expect(sortingLabelFor(2.01)).toBe('Very Poorly Sorted');
  });
  it('coarse tail in mm gives negative (coarse) phi skewness', () => {
    const fw = computeFolkWardStats(
      psdFromPhi({ 5: -6, 10: -5, 16: -4.5, 25: -3.4, 50: -3, 75: -2.7, 84: -2.6, 90: -2.5, 95: -2.4 }),
    );
    expect(fw!.skewnessPhi).toBeLessThan(-0.1);
    expect(fw!.skewnessLabel).toMatch(/Coarse Skewed/);
  });
});

describe('Wentworth class edges (2 / 64 / 256 mm)', () => {
  it('assigns grains exactly at the edges to the coarser class', () => {
    const w = computeWentworthProportions([
      grain(1, 10, { bAxisMm: 1.99, areaPx: 1 }),
      grain(2, 10, { bAxisMm: 2, areaPx: 1 }),
      grain(3, 10, { bAxisMm: 63.9, areaPx: 1 }),
      grain(4, 10, { bAxisMm: 64, areaPx: 1 }),
      grain(5, 10, { bAxisMm: 255.9, areaPx: 1 }),
      grain(6, 10, { bAxisMm: 256, areaPx: 1 }),
    ])!;
    expect(w.sandPct).toBeCloseTo(100 / 6, 9);
    expect(w.gravelPct).toBeCloseTo(200 / 6, 9);
    expect(w.cobblePct).toBeCloseTo(200 / 6, 9);
    expect(w.boulderPct).toBeCloseTo(100 / 6, 9);
  });
});

describe('Flow QC magnitude weighting (F5)', () => {
  // Disk grain with ideal inward radial flows; a sector of pixels has reversed flows.
  const W = 41;
  const H = 41;
  const cx = 20;
  const cy = 20;
  const build = (badMagnitude: number) => {
    const flowY = new Float32Array(W * H);
    const flowX = new Float32Array(W * H);
    const idx: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dy = y - cy;
        const dx = x - cx;
        const r = Math.hypot(dy, dx);
        if (r > 15) continue;
        const i = y * W + x;
        idx.push(i);
        const bad = dx > 3 && Math.abs(dy) < dx; // ~25% of the disk
        const mag = bad ? badMagnitude : 5;
        const sign = bad ? 1 : -1; // bad pixels point outward
        flowY[i] = r > 0 ? (sign * mag * dy) / r : 0;
        flowX[i] = r > 0 ? (sign * mag * dx) / r : 0;
      }
    }
    return evaluateGrainFlowQcV4(idx, flowY, flowX, W, H, 0.45);
  };
  it('down-weights near-zero-magnitude disagreeing flows but rejects strong ones', () => {
    expect(build(0.01).passed).toBe(true);
    expect(build(5).passed).toBe(false);
  });
});

describe('F-06 Feret diameters', () => {
  it('rotating calipers on an axis-aligned 20x80 pixel rectangle', () => {
    const W = 120;
    const H = 60;
    const masks = new Int32Array(W * H);
    for (let y = 20; y < 40; y++) for (let x = 20; x < 100; x++) masks[y * W + x] = 1;
    const g = computeGrainMorphometrics(masks, W, H, 0)[0]!;
    const e = computeExtendedMorphometrics(masks, [g], W, H, 1, 0.5)[0]!;
    expect(e.minFeretPx).toBeCloseTo(20, 9);
    expect(e.maxFeretPx).toBeCloseTo(Math.hypot(20, 80), 9);
    expect(e.minFeretMm).toBeCloseTo(10, 9);
    // Moment-ellipse b differs from the caliper width for non-elliptical shapes.
    expect(g.bAxisPx).toBeGreaterThan(e.minFeretPx * 1.1);
  });
  it('handles degenerate hulls', () => {
    expect(computeFeretDiameters([])).toEqual({ minFeret: 0, maxFeret: 0 });
    expect(computeFeretDiameters([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toEqual({ minFeret: 0, maxFeret: 5 });
  });
});

describe('F-14 / F-15 sample-size and calibration warnings', () => {
  it('suppresses Folk & Ward for n=1 and warns for small n', () => {
    const r = computeSedimentStats([grain(1, 10, { bAxisMm: 5, dEqMm: 5 })]);
    expect(r.folkWard).toBeNull();
    expect(r.warnings?.join(' ')).toMatch(/Only 1 grain/);
  });
  it('warns on mixed calibration instead of silently reporting px', () => {
    const r = computeSedimentStats([grain(1, 10, { bAxisMm: 5, dEqMm: 5 }), grain(2, 40)]);
    expect(r.unit).toBe('px');
    expect(r.warnings?.join(' ')).toMatch(/Mixed calibration/);
  });
  it('warns when uncalibrated', () => {
    const grains = Array.from({ length: 120 }, (_, i) => grain(i + 1, 10 + (i % 7)));
    expect(computeSedimentStats(grains).warnings).toEqual([
      expect.stringMatching(/Uncalibrated/),
    ]);
  });
});

describe('F-11 CSV formula injection', () => {
  it('neutralises formula-leading cells but keeps numbers', () => {
    expect(csvCell('=1+2.jpg')).toBe("'=1+2.jpg");
    expect(csvCell('@SUM(1)')).toBe("'@SUM(1)");
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc");
    expect(csvCell('-1.5e3')).toBe('-1.5e3');
    expect(csvCell(-2)).toBe('-2');
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(metadataCommentLines({ a: { b: 'x\ny' } })).toEqual(['# a.b: x y']);
  });
});

// ---- Session-level: ROI-aware statistics (F-07) and provenance (F-10) ----------------
function makeSession(): AnalysisSession {
  const w = 64;
  const h = 32;
  const masks = new Int32Array(w * h);
  // Grain 1: 10x10 at left; grain 2: 20x20 at right.
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) masks[y * w + x] = 1;
  for (let y = 5; y < 25; y++) for (let x = 35; x < 55; x++) masks[y * w + x] = 2;
  return new AnalysisSession({
    workingImage: {
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
      originalWidth: w,
      originalHeight: h,
      effectiveScaleFactor: 1,
      scaleModeApplied: 'full',
    } as never,
    recommendation: {
      model: 'unet',
      confidence: 1,
      reason: 'test',
      metrics: {} as never,
    } as never,
    masks,
    workingGrains: computeGrainMorphometrics(masks, w, h, 2),
    excludeBorder: true,
    borderMargin: 2,
    provenance: {
      appVersion: 'test',
      ortVersion: 'test',
      analyzedAt: '2026-01-01T00:00:00.000Z',
      modelId: 'ig2_unet_fp32',
      modelFile: 'ig2_unet_fp32.onnx',
      modelRevision: 'rev',
      modelSha256: 'abc123',
      postProcess: { flowThreshold: 0.45 },
    },
  });
}

describe('F-07 ROI / exclusion applies to single-photo statistics', () => {
  it('excluding a grain changes n and D50, and is flagged in the CSV', () => {
    const s = makeSession();
    expect(s.getStats().includedGrains).toBe(2);
    const d50Before = s.getStats().areaWeightedB.D50;
    s.setRoiConfig({
      exclusionPolygons: [[{ x: 30, y: 0 }, { x: 63, y: 0 }, { x: 63, y: 31 }, { x: 30, y: 31 }]],
      exclusionStrokes: [],
    });
    expect(s.getStats().includedGrains).toBe(1);
    expect(s.getRoiExcludedGrainCount()).toBe(1);
    expect(s.getStats().areaWeightedB.D50).toBeLessThan(d50Before);
    const csv = s.exportCsv().split('\n');
    const cols = csv[0]!.split(',');
    const inRoi = cols.indexOf('in_roi');
    expect(inRoi).toBeGreaterThan(0);
    expect(csv.slice(1).map((l) => l.split(',')[inRoi])).toEqual(['true', 'false']);
    // The stats flag agrees (border exclusion does not apply to these interior grains).
    const inStats = cols.indexOf('included_in_stats');
    expect(csv.slice(1).map((l) => l.split(',')[inStats])).toEqual(['true', 'false']);
    expect(cols).toEqual(expect.arrayContaining(['orientation_deg', 'circularity', 'solidity', 'aspect_ratio']));
    const summary = s.exportSummaryCsv();
    expect(summary).toContain('fabric,mean_axial_orientation_deg');
    // Uncalibrated: pixel size classes (as in the dashboard histogram).
    expect(summary).toMatch(/\nsize_class_px_x2,\d/);
    // Only the grain inside the ROI counts in the photo's fabric statistics.
    expect(summary).toContain('fabric,grain_count,1,count');
  });
});

describe('F-10 provenance in exports', () => {
  it('summary JSON/CSV, GeoJSON, SVG and commented CSV carry model hash and versions', () => {
    const s = makeSession();
    const json = JSON.parse(s.exportSummaryJson()) as { metadata: Record<string, any>; unit: string };
    expect(json.unit).toBe('px');
    expect(json.metadata.analysis.modelSha256).toBe('abc123');
    expect(json.metadata.sizeMetricDefinition).toMatch(/not a sieve or caliper/i);
    expect(json.metadata.notice).toMatch(/unofficial/i);
    expect(s.exportSummaryCsv()).toContain('metadata,analysis.modelSha256,abc123,meta');
    expect(JSON.parse(s.exportGeoJson()).metadata.analysis.postProcess.flowThreshold).toBe(0.45);
    expect(s.exportSvg()).toContain('<metadata id="webgrainy-provenance">');
    const withMeta = s.exportCsv({ includeMetadata: true }).split('\n');
    expect(withMeta[0]).toMatch(/^# generator: webGrainy/);
    expect(withMeta.find((l) => !l.startsWith('#'))).toMatch(/^grain_id,/);
  });
  it('serialisation round-trips provenance', () => {
    const s = AnalysisSession.fromSerialized(makeSession().toSerialized());
    expect(s.getProvenance()?.modelSha256).toBe('abc123');
  });
  it('site metadata lists per-photo model hashes, and pooled CSV neutralises labels', async () => {
    const entries = [
      { photoId: 'p1', label: '=HYPERLINK("x").jpg', included: true, session: makeSession() },
    ];
    const meta = buildSiteExportMetadata(entries, undefined, { minSizeMm: 13, bootstrapReplicates: 2000, bootstrapTwoStage: true });
    expect(meta['siteSettings']).toMatchObject({ minSizeMm: 13, bootstrapReplicates: 2000, bootstrapTwoStage: true, bootstrapSeed: 42 });
    expect((meta['photos'] as Array<Record<string, unknown>>)[0]!['modelSha256']).toBe('abc123');
    const csv = await exportPooledGrainsCsv(entries, undefined, { metadata: meta }).text();
    const rows = csv.split('\n').filter((l) => !l.startsWith('#'));
    expect(rows[0]).toContain('min_feret_px');
    expect(rows[1]).toMatch(/^p1,"'=HYPERLINK\(""x""\)\.jpg",/);
  });
});

// ---- Archive import hardening (F-13) ---------------------------------------------------
function archiveJson(overrides: { maskLen?: number; protoKey?: boolean } = {}): string {
  const w = 4;
  const h = 4;
  const b64 = (n: number) => Buffer.from(new Uint8Array(n)).toString('base64');
  const photo: Record<string, unknown> = {
    photoId: 'ph-1', siteId: 'site-1', label: 'a.jpg', width: 4, height: 4,
    addedAt: 1, included: true, imageBase64: b64(4), imageMimeType: 'text/html',
  };
  const text = JSON.stringify({
    format: 'webgrainy-project',
    version: 1,
    exportedAt: 'x',
    site: { siteId: 'site-1', name: 'Bar', createdAt: 1, updatedAt: 1, options: {}, photoOrder: ['ph-1'] },
    photos: [photo],
    results: [
      {
        photoId: 'ph-1',
        status: 'done',
        updatedAt: 1,
        serializedSession: {
          version: 1,
          workingMasksBase64: b64((overrides.maskLen ?? w * h) * 4),
          workingImage: { width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, dataBase64: b64(w * h * 4) },
          recommendation: { model: 'unet', confidence: 1, reason: 'x', metrics: {} },
          excludeBorder: true,
          borderMargin: 2,
        },
      },
    ],
  });
  return overrides.protoKey
    ? text.replace('"label":"a.jpg"', '"label":"a.jpg","__proto__":{"polluted":true}')
    : text;
}

describe('F-13 archive import validation', () => {
  it('rejects a mask/dimension mismatch before writing anything', async () => {
    const idb = createProjectMockIDB();
    await expect(importProjectArchive(archiveJson({ maskLen: 5 }), { indexedDB: idb })).rejects.toThrow(
      /mask length/,
    );
    expect(await getSite('site-1', { indexedDB: idb })).toBeUndefined();
  });

  it('never overwrites an existing site with the same id', async () => {
    const idb = createProjectMockIDB();
    await saveSite(
      { siteId: 'site-1', name: 'Existing', createdAt: 0, updatedAt: 0, options: {} as never, photoOrder: [] },
      { indexedDB: idb },
    );
    const newId = await importProjectArchive(archiveJson(), { indexedDB: idb });
    expect(newId).not.toBe('site-1');
    expect((await getSite('site-1', { indexedDB: idb }))?.name).toBe('Existing');
    const imported = await getSite(newId, { indexedDB: idb });
    expect(imported?.name).toBe('Bar (imported)');
    const pid = imported!.photoOrder[0]!;
    const photo = await getPhoto(pid, { indexedDB: idb });
    expect(photo?.siteId).toBe(newId);
    // Non-image MIME types from untrusted archives are neutralised.
    expect(photo?.imageBlob.type).toBe('application/octet-stream');
  });

  it('strips prototype-pollution keys', async () => {
    const idb = createProjectMockIDB();
    await importProjectArchive(archiveJson({ protoKey: true }), { indexedDB: idb });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    const photo = await getPhoto('ph-1', { indexedDB: idb });
    expect(Object.prototype.hasOwnProperty.call(photo, '__proto__')).toBe(false);
  });
});

describe('audit B14: grains.csv after editing', () => {
  it('fills Feret widths for grains added after Feret was computed, and has area_mm2 when calibrated', () => {
    const s = makeSession();
    s.setCalibration(ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 10, y: 0 }, 20, 'mm'));
    s.ensureFeret();
    expect(s.addPolygonGrain([{ x: 20, y: 18 }, { x: 30, y: 18 }, { x: 30, y: 28 }, { x: 20, y: 28 }])).toBeGreaterThan(0);
    const lines = s.exportCsv().split('\n');
    const cols = lines[0]!.split(',');
    const rows = lines.slice(1).map((l) => l.split(','));
    expect(rows.length).toBe(3);
    for (const name of ['min_feret_px', 'max_feret_px', 'min_feret_mm', 'max_feret_mm', 'area_mm2']) {
      const i = cols.indexOf(name);
      expect(i, name).toBeGreaterThan(0);
      for (const r of rows) expect(Number(r[i]), `${name} of grain ${r[0]}`).toBeGreaterThan(0);
    }
    const area = cols.indexOf('area_px');
    const areaMm2 = cols.indexOf('area_mm2');
    expect(Number(rows[0]![areaMm2])).toBeCloseTo(Number(rows[0]![area]) * 4, 9); // 2 mm/px
  });
});
