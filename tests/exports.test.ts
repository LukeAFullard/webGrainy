import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/pipelineController.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { analyzeSite } from '../src/modules/siteAnalysis.js';
import { buildExport, EXPORT_KINDS, isExportKind, type ExportContext } from '../src/modules/exports.js';
import type { PhotoRecord, SiteRecord } from '../src/modules/projectStorage.js';

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

describe('exports module', () => {
  const s = session();
  const site = { siteId: 's1', name: 'Rakaia reach 3', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: [] } as unknown as SiteRecord;
  const photo = { photoId: 'p1', label: 'IMG 001.jpg' } as unknown as PhotoRecord;
  const siteInputs = [{ photoId: 'p1', label: 'IMG 001.jpg', included: true, session: s }];
  const siteReport = analyzeSite(siteInputs, { poolingMode: 'physical-area', unit: 'px', bootstrapReplicates: 20 });
  const ctx: ExportContext = {
    site, photo, session: s, siteReport, siteInputs, psdXAxis: 'mm',
    renderPsdSvg: () => '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
  };

  it('builds every export kind with a sensible file name (except the archive, which needs storage)', async () => {
    // Map-coordinate exports need a georeferenced (GeoTIFF) photo.
    const photo = { ...ctx.photo!, width: s.workingImage.originalWidth, height: s.workingImage.originalHeight };
    const georef = { transform: [1000, 0.01, 0, 5000, 0, -0.01] as [number, number, number, number, number, number], epsg: 2193, kind: 'projected' as const, width: photo.width, height: photo.height };
    const geoCtx: ExportContext = { ...ctx, photo: { ...photo, metadata: { ...(photo.metadata ?? {}), georef } } };
    const geoKinds = new Set(['photo-geojson-map', 'photo-geojson-lonlat', 'photo-mask-worldfile', 'photo-mask-geotiff', 'photo-mask-auxxml']);
    for (const kind of EXPORT_KINDS) {
      if (kind === 'site-archive') continue;
      const f = await buildExport(kind, geoKinds.has(kind) ? geoCtx : ctx);
      expect(f, kind).not.toBeNull();
      expect(f!.blob.size, kind).toBeGreaterThan(0);
      expect(f!.filename, kind).toMatch(kind.startsWith('site') ? /^Rakaia_reach_3_/ : /^IMG_001_jpg_/);
    }
  });

  it('puts the site name and provenance in site exports', async () => {
    const csv = await (await buildExport('site-summary-csv', ctx))!.blob.text();
    expect(csv).toContain('metadata,siteName,Rakaia reach 3,meta');
    const svg = await (await buildExport('site-psd-svg', ctx))!.blob.text();
    expect(svg).toContain('<metadata id="webgrainy-provenance">');
  });

  it('returns null when the inputs are missing', async () => {
    const empty: ExportContext = { site: null, photo: null, session: null, siteReport: null, siteInputs: [], psdXAxis: 'mm' };
    for (const kind of EXPORT_KINDS) expect(await buildExport(kind, empty), kind).toBeNull();
    expect(isExportKind('photo-svg')).toBe(true);
    expect(isExportKind('nope')).toBe(false);
  });

  it('applies siteOptions cutoffs to photo-summary-json and photo-summary-csv', async () => {
    const looseJson = JSON.parse(await (await buildExport('photo-summary-json', { ...ctx, siteOptions: { minBaxisPx: 5 } }))!.blob.text());
    const strictJson = JSON.parse(await (await buildExport('photo-summary-json', { ...ctx, siteOptions: { minBaxisPx: 50 } }))!.blob.text());
    expect(looseJson.includedGrains).toBeGreaterThan(0);
    expect(strictJson.includedGrains).toBe(0);
    expect(strictJson.excludedCutoffGrains).toBe(looseJson.includedGrains);
  });
});

// ---- Regression: provenance of image processing, preprocessing and mask geometry ----
describe('exports provenance (regression)', () => {
  const enhancement = {
    kind: 'upscale-2x' as const, modelId: 'pulse_2x_fp32', modelName: 'PULSE 2x', modelSha256: 'abc', scaleFactor: 2, appliedAt: '2026-01-01T00:00:00Z',
  };
  const rectification = {
    corners: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    physicalWidthMm: 100, physicalHeightMm: 100, outputWidth: 120, outputHeight: 80, mmPerPx: 0.5, appliedAt: '2026-01-02T00:00:00Z',
  };

  /** A session analysed at half the photo's resolution, with full preprocessing provenance. */
  function shrunkSession(): AnalysisSession {
    const w = 60, h = 40;
    const masks = new Int32Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 25; x++) masks[y * w + x] = 1;
    for (let y = 22; y < 34; y++) for (let x = 30; x < 50; x++) masks[y * w + x] = 2;
    return new AnalysisSession({
      workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: 120, originalHeight: 80, effectiveScaleFactor: 0.5, scaleModeApplied: '0.5x' } as never,
      recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
      masks,
      workingGrains: computeGrainMorphometrics(masks, w, h, 2),
      provenance: {
        appVersion: 't', ortVersion: 't', analyzedAt: '2026-01-03T00:00:00Z', modelId: 'ig2_unet_fp32', modelFile: 'x', modelRevision: 'r', modelSha256: 's',
        inferencePipeline: 'cellpose', scaleMode: 'auto', applyClahe: true, claheClipLimit: 2, fineGrainUpscale: 1.5, effectiveScaleFactor: 0.5,
      },
    });
  }

  const s = shrunkSession();
  const photo = {
    photoId: 'p2', label: 'DJI 002.jpg', width: 120, height: 80,
    metadata: { processingHistory: [{ step: 'enhancement', ...enhancement }, { step: 'rectification', ...rectification }] },
  } as unknown as PhotoRecord;
  const siteInputs = [{ photoId: 'p2', label: 'DJI 002.jpg', included: true, session: s, metadata: photo.metadata! }];
  const siteReport = analyzeSite(siteInputs, { poolingMode: 'physical-area', unit: 'px', minBaxisPx: 0, bootstrapReplicates: 10 });
  const ctx: ExportContext = { site: null, photo, session: s, siteReport, siteInputs, psdXAxis: 'mm' };

  it('per-photo CSV and JSON exports record enhancement and rectification steps', async () => {
    const csv = await (await buildExport('photo-grains-csv', ctx))!.blob.text();
    expect(csv).toMatch(/# photo\.imageProcessing: .*"step":"enhancement".*"modelId":"pulse_2x_fp32".*"step":"rectification"/);
    const json = JSON.parse(await (await buildExport('photo-summary-json', ctx))!.blob.text());
    expect(json.metadata.photo.imageProcessing.map((x: { step: string }) => x.step)).toEqual(['enhancement', 'rectification']);
    const sumCsv = await (await buildExport('photo-summary-csv', ctx))!.blob.text();
    expect(sumCsv).toContain('metadata,photo.imageProcessing,');
    const geo = JSON.parse(await (await buildExport('photo-geojson', ctx))!.blob.text());
    expect(JSON.stringify(geo)).toContain('pulse_2x_fp32');
  });

  it('legacy photos with only an enhancement record still report it', async () => {
    const legacy = { ...photo, metadata: { enhancement } } as unknown as PhotoRecord;
    const json = JSON.parse(await (await buildExport('photo-summary-json', { ...ctx, photo: legacy }))!.blob.text());
    expect(json.metadata.photo.imageProcessing).toEqual([{ step: 'enhancement', ...enhancement }]);
  });

  it('site exports record each photo\'s preprocessing, image steps and detection limit', async () => {
    const json = JSON.parse(await (await buildExport('site-summary-json', ctx))!.blob.text());
    const p = json.metadata.photos[0];
    expect(p.applyClahe).toBe(true);
    expect(p.claheClipLimit).toBe(2);
    expect(p.scaleMode).toBe('auto');
    expect(p.inferencePipeline).toBe('cellpose');
    expect(p.fineGrainUpscale).toBe(1.5);
    expect(p.originalWidth).toBe(120);
    expect(p.workingWidth).toBe(60);
    expect(p.detectionLimitPx).toBeCloseTo((2 * Math.sqrt(30 / Math.PI)) / 0.5, 6);
    expect(p.imageProcessing.map((x: { step: string }) => x.step)).toEqual(['enhancement', 'rectification']);
  });

  it('mask PNG is at the photo\'s resolution, aligned with the CSV, with provenance in an iTXt chunk', async () => {
    const f = (await buildExport('photo-mask-16', ctx))!;
    const png = new Uint8Array(await f.blob.arrayBuffer());
    const dv = new DataView(png.buffer);
    expect(dv.getUint32(16)).toBe(120); // IHDR width = original
    expect(dv.getUint32(20)).toBe(80);
    // Walk the chunks: find iTXt "webgrainy" and decode the IDAT.
    let off = 8;
    let meta: Record<string, unknown> | null = null;
    const idat: Uint8Array[] = [];
    while (off < png.length) {
      const len = dv.getUint32(off);
      const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
      const data = png.subarray(off + 8, off + 8 + len);
      if (type === 'iTXt') {
        const kwEnd = data.indexOf(0);
        if (new TextDecoder().decode(data.subarray(0, kwEnd)) === 'webgrainy') {
          meta = JSON.parse(new TextDecoder().decode(data.subarray(kwEnd + 5)));
        }
      }
      if (type === 'IDAT') idat.push(data);
      off += 12 + len;
    }
    expect(meta).not.toBeNull();
    expect((meta as { mask: { resolution: string } }).mask.resolution).toBe('original-image pixels');
    expect(JSON.stringify(meta)).toContain('"step":"rectification"');
    const { inflateSync } = await import('node:zlib');
    const raw = inflateSync(Buffer.concat(idat));
    const at = (x: number, y: number): number => raw.readUInt16BE(y * (1 + 120 * 2) + 1 + x * 2);
    // Working grain 1 covers x 10..24, y 10..19 -> original x 20..49, y 20..39.
    expect(at(20, 20)).toBe(1);
    expect(at(49, 39)).toBe(1);
    expect(at(19, 20)).toBe(0);
    expect(at(50, 20)).toBe(0);
    // Grain 2 centroid in the CSV (original px) lands on label 2 in the mask.
    const g2 = s.getResult().grains.find((g) => g.id === 2)!;
    expect(at(Math.round(g2.centroidX), Math.round(g2.centroidY))).toBe(2);
    // Working resolution is still available on request.
    expect(new DataView(s.exportMaskPng(16, { resolution: 'working' }).buffer).getUint32(16)).toBe(60);
  });
});
