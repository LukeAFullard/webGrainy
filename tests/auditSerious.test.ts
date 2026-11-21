/**
 * Regressions for the serious audit findings:
 *  S1 survey/site comparison: shared photo-corrected SE, Holm-adjusted p-values;
 *  S2 one size cutoff for every file of a photo inside a site;
 *  S3 photos analysed differently are flagged; report provenance from each photo's record;
 *  S4 16-bit TIFFs keep their detail.
 */
import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeAllGrainMorphometrics } from '../src/modules/interactiveEditor.js';
import { analyzeSite, exportPooledGrainsCsv, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { buildExport } from '../src/modules/exports.js';
import { comparePercentile, computeComparedSites, holmAdjust, surveyChanges } from '../src/modules/siteComparison.js';
import { siteReportProvenance, withinSiteSettingDifferences } from '../src/modules/siteProvenance.js';
import { computeWorkspaceReports, photoCutoffs } from '../src/modules/siteWorkspace.js';
import { decodeTiffBuffer, rgba8From16Bit } from '../src/modules/tiffDecode.js';
import { squareGrainSession } from './helpers/squareSession.js';

/** Square grains of the given sides; `scale` = working ÷ photo size; optional model id. */
function session(sides: number[], opts: { scale?: number; mmPerPx?: number; modelId?: string; manualEdits?: number; w?: number } = {}): AnalysisSession {
  const w = opts.w ?? 1400;
  const h = w;
  const masks = new Int32Array(w * h);
  let x0 = 10, y0 = 10, rowH = 0, id = 1;
  for (const s of sides) {
    if (x0 + s + 10 > w) { x0 = 10; y0 += rowH + 10; rowH = 0; }
    for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) masks[y * w + x] = id;
    id++; x0 += s + 10; rowH = Math.max(rowH, s);
  }
  const scale = opts.scale ?? 1;
  return new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(0), width: w, height: h, originalWidth: Math.round(w / scale), originalHeight: Math.round(h / scale), effectiveScaleFactor: scale, scaleModeApplied: '1.0x' },
    recommendation: { model: 'unet', metrics: {} } as never,
    masks,
    workingGrains: computeAllGrainMorphometrics(masks, w, h, 2),
    excludeBorder: true,
    borderMargin: 2,
    calibration: { mmPerPx: opts.mmPerPx ?? 0.5, pointA: { x: 0, y: 0 }, pointB: { x: 1, y: 0 }, physicalLengthMm: 0.5, pixelDistance: 1 },
    ...(opts.modelId ? { provenance: { appVersion: 't', ortVersion: 't', analyzedAt: 'x', modelId: opts.modelId, modelFile: 'f', modelRevision: 'r', modelSha256: `sha-${opts.modelId}`, scaleMode: 'auto', inferencePipeline: 'cellpose', postProcess: { flowThreshold: 0.45, cellprobThreshold: 0, minSize: 30 } } as never } : {}),
    ...(opts.manualEdits ? { manualEdits: opts.manualEdits } : {}),
  });
}

const siteOptions = { poolingMode: 'physical-area' as const, sizeMetric: 'bAxis' as const, minBaxisPx: 15, harmonizePhysicalCutoff: true, bootstrapReplicates: 100, minSizeMm: 0, maxExcludedFraction: 0.1 };

describe('S2: one size cutoff for a photo inside a site', () => {
  // Photo A at full resolution, photo B analysed at 1/4 size: B's detection limit (12.4 mm)
  // becomes the common cutoff, which removes most of A's small grains.
  const A = session([...Array(150).fill(18), ...Array(20).fill(30), ...Array(6).fill(40)]);
  const B = session([...Array(30).fill(20), ...Array(20).fill(30)], { scale: 0.25, w: 900 });
  const inputs: SitePhotoInput[] = [
    { photoId: 'A', label: 'A.jpg', included: true, session: A },
    { photoId: 'B', label: 'B.jpg', included: true, session: B },
  ];
  const report = analyzeSite(inputs, siteOptions);
  const perA = report.perPhoto.find((p) => p.photoId === 'A')!;
  const ctx = { site: { siteId: 's', name: 'S' } as never, photo: { photoId: 'A', label: 'A.jpg', width: 1400, height: 1400 } as never, session: A, siteReport: report, siteInputs: inputs, psdXAxis: 'mm' as const, sizeMetric: 'bAxis' as const, siteOptions };

  it('the photo summary, grain table and site breakdown describe the same grains', async () => {
    expect(report.dCutoffCommonMm).toBeGreaterThan(12);
    const summary = await (await buildExport('photo-summary-csv', ctx))!.blob.text();
    const d50 = Number(summary.split('\n').find((l) => l.startsWith('area_weighted_b,D50,'))!.split(',')[2]);
    const included = Number(summary.split('\n').find((l) => l.startsWith('summary,included_grains,'))!.split(',')[2]);
    expect(included).toBe(perA.validGrainCount);
    expect(d50).toBeCloseTo(perA.D50, 6);
    const grains = (await (await buildExport('photo-grains-csv', ctx))!.blob.text()).split('\n').filter((l) => !l.startsWith('#'));
    const col = grains[0]!.split(',').indexOf('included_in_stats');
    const pooled = (await exportPooledGrainsCsv(inputs, report).text()).split('\n');
    const pc = pooled[0]!.split(',');
    const pooledA = pooled.slice(1).filter((l) => l.split(',')[pc.indexOf('photo_id')] === 'A' && l.split(',')[pc.indexOf('included_in_stats')] === 'true').length;
    expect(grains.slice(1).filter((l) => l.split(',')[col] === 'true').length).toBe(pooledA);
    expect(summary).toContain('sizeCutoffsApplied');
  });

  it('the photo dashboard statistics use the same cutoff', () => {
    const r = computeWorkspaceReports({
      photos: inputs.map((i) => ({ photoId: i.photoId, label: i.label, included: true }) as never),
      sessions: new Map(inputs.map((i) => [i.photoId, i.session])),
      activePhotoId: 'A',
      siteOptions,
    });
    expect(r.singlePhotoStats!.includedGrains).toBe(perA.validGrainCount);
    expect(r.singlePhotoStats!.areaWeightedB.D50).toBeCloseTo(perA.D50, 6);
  });

  it('a photo outside the site report keeps the photo-level cutoffs', () => {
    expect(photoCutoffs(siteOptions, report, 'other')).toEqual({ minBaxisPx: 15, minSizeMm: 0 });
    expect(photoCutoffs(siteOptions, report, 'A').minSizeMm).toBeCloseTo(report.dCutoffCommonMm!, 9);
    expect(photoCutoffs(siteOptions, null, 'A')).toEqual({ minBaxisPx: 15, minSizeMm: 0 });
  });
});

describe('S3: photos analysed differently, and report provenance', () => {
  const sizes = (k: number) => Array.from({ length: 40 }, (_, i) => 16 + ((i * 7 + k) % 25));
  const inputs: SitePhotoInput[] = [
    { photoId: 'p1', label: 'p1', included: true, session: session(sizes(1), { modelId: 'ig2_unet_fp32', w: 700 }) },
    { photoId: 'p2', label: 'p2', included: true, session: session(sizes(2), { modelId: 'ig2_cpsam_fp16', manualEdits: 3, w: 700 }) },
    { photoId: 'p3', label: 'p3', included: true, session: session(sizes(3), { modelId: 'ig2_cpsam_fp16', w: 700 }) },
  ];

  it('warns when photos of one site were analysed with different models', () => {
    expect(withinSiteSettingDifferences(inputs).map((d) => d.setting)).toContain('model weights');
    const r = analyzeSite(inputs, siteOptions);
    expect(r.warnings.some((w) => w.includes('analysed differently') && w.includes('ig2_cpsam_fp16 | ig2_unet_fp32'))).toBe(true);
    const same = analyzeSite(inputs.slice(1), siteOptions);
    expect(same.warnings.some((w) => w.includes('analysed differently'))).toBe(false);
  });

  it('report provenance lists every model and counts persisted manual edits', () => {
    const r = analyzeSite(inputs, siteOptions);
    const prov = siteReportProvenance(inputs, r, siteOptions);
    expect(prov.models).toEqual([
      { modelId: 'ig2_unet_fp32', modelSha256: 'sha-ig2_unet_fp32', photos: 1 },
      { modelId: 'ig2_cpsam_fp16', modelSha256: 'sha-ig2_cpsam_fp16', photos: 2 },
    ]);
    expect(prov.manualEditsCount).toBe(1);
    expect(prov.settings.find(([k]) => k === 'Model')![1]).toContain('ig2_unet_fp32 (1 photo) + ig2_cpsam_fp16 (2 photos)');
    expect(prov.settings.find(([k]) => k.startsWith('Flow threshold'))![1]).toBe('0.45 / 0');
    expect(prov.detectionLimit).toBeGreaterThan(0);
  });
});

describe('S1: comparison test', () => {
  it('Holm adjustment', () => {
    const adj = holmAdjust([0.01, 0.04, 0.03, Number.NaN, 0.5]);
    expect(adj[0]).toBeCloseTo(0.04, 12); // 4 x 0.01
    expect(adj[2]).toBeCloseTo(0.09, 12); // 3 x 0.03
    expect(adj[1]).toBeCloseTo(0.09, 12); // max(2 x 0.04, 0.09)
    expect(adj[4]).toBeCloseTo(0.5, 12);
    expect(Number.isNaN(adj[3]!)).toBe(true);
  });

  it('pairwise and survey tests use the site interval SE and report adjusted p-values', () => {
    const photosOf = (base: number, n: number, tag: string) =>
      Array.from({ length: n }, (_, k) => ({ photoId: `${tag}${k}`, label: `${tag}${k}`, included: true, session: squareGrainSession(Array.from({ length: 30 }, (_, i) => base + k + (i % 9)), { w: 700, h: 700, mmPerPx: 0.5 }) }));
    const sites = computeComparedSites(
      [
        { siteId: 'a', name: 'A', inputs: photosOf(20, 6, 'a'), place: 'P', surveyDate: '2024-01-01' },
        { siteId: 'b', name: 'B', inputs: photosOf(21, 6, 'b'), place: 'P', surveyDate: '2025-01-01' },
        { siteId: 'c', name: 'C', inputs: photosOf(40, 6, 'c') },
      ],
      { ...siteOptions, harmonizePhysicalCutoff: false },
    );
    const pairs = comparePercentile(sites, 'D50');
    expect(pairs).toHaveLength(3);
    for (const c of pairs) {
      expect(c.pAdjusted).toBeGreaterThanOrEqual(c.p);
      expect(c.basis).toBe('photos');
    }
    const ab = pairs.find((c) => c.a === 'A' && c.b === 'B')!;
    const rA = sites[0]!.report!;
    const rB = sites[1]!.report!;
    const s = Math.hypot(rA.ciLogSe.D50, rB.ciLogSe.D50);
    expect(Math.log(ab.ratioHi / ab.ratio)).toBeGreaterThan(s); // t > 1
    const ch = surveyChanges(sites);
    expect(ch).toHaveLength(1);
    expect(ch[0]!.changes.D50.pAdjusted).toBe(ch[0]!.changes.D50.p); // one survey change: no adjustment
  });
});

describe('S4: 16-bit TIFF', () => {
  function tiff16(W: number, H: number, spp: number, val: (x: number, y: number) => number): ArrayBuffer {
    const nTags = 10, ifdOff = 8, bpsOff = ifdOff + 2 + nTags * 12 + 4, dataOff = bpsOff + 16, bytes = W * H * spp * 2;
    const buf = new ArrayBuffer(dataOff + bytes);
    const dv = new DataView(buf);
    dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true); dv.setUint16(ifdOff, nTags, true);
    const tags: Array<[number, number, number, number]> = [[256, 3, 1, W], [257, 3, 1, H], [258, 3, spp, spp === 1 ? 16 : bpsOff], [259, 3, 1, 1], [262, 3, 1, spp === 1 ? 1 : 2], [273, 4, 1, dataOff], [277, 3, 1, spp], [278, 3, 1, H], [279, 4, 1, bytes], [284, 3, 1, 1]];
    tags.forEach(([t, ty, c, v], i) => { const o = ifdOff + 2 + i * 12; dv.setUint16(o, t, true); dv.setUint16(o + 2, ty, true); dv.setUint32(o + 4, c, true); if (ty === 3 && c === 1) dv.setUint16(o + 8, v, true); else dv.setUint32(o + 8, v, true); });
    for (let c = 0; c < 3; c++) dv.setUint16(bpsOff + 2 * c, 16, true);
    let p = dataOff;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < spp; c++) { dv.setUint16(p, val(x, y), true); p += 2; }
    return buf;
  }

  for (const spp of [1, 3]) {
    it(`12-bit data in a 16-bit ${spp === 1 ? 'grey' : 'RGB'} TIFF keeps 256 levels (was 16)`, () => {
      const img = decodeTiffBuffer(tiff16(256, 2, spp, (x) => Math.round((x / 255) * 4095)));
      const levels = new Set<number>();
      for (let i = 0; i < 256; i++) levels.add(img.data[i * 4]!);
      expect(levels.size).toBeGreaterThan(250);
      expect(Math.min(...levels)).toBe(0);
      expect(Math.max(...levels)).toBe(255);
      expect(img.metadata?.notes).toContain('16-bit TIFF converted to 8 bits');
    });
  }

  it('one hot pixel at 65535 does not squeeze 12-bit data into a few grey levels', () => {
    const img = decodeTiffBuffer(tiff16(256, 40, 1, (x, y) => (x === 7 && y === 3 ? 65535 : Math.round((x / 255) * 4095))));
    const levels = new Set<number>();
    for (let i = 0; i < 256; i++) levels.add(img.data[(256 * 10 + i) * 4]!);
    expect(levels.size).toBeGreaterThan(250);
    expect(img.data[(256 * 3 + 7) * 4]).toBe(255); // clipped, not wrapped
    expect(img.metadata?.notes).toContain('0–4095');
  });

  it('leaves 8-bit and unsupported layouts to UTIF', () => {
    expect(rgba8From16Bit({ width: 1, height: 1, data: new Uint8Array(4), t258: [8] })).toBeNull();
    expect(rgba8From16Bit({ width: 1, height: 1, data: new Uint8Array(6), t258: [16, 16, 16], t262: [2], t277: [3], t284: [2] })).toBeNull();
  });
});
