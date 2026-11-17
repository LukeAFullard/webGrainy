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
    for (const kind of EXPORT_KINDS) {
      if (kind === 'site-archive') continue;
      const f = await buildExport(kind, ctx);
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
});
