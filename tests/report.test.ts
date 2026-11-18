import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import type { SiteRecord } from '../src/modules/projectStorage.js';
import { analyzeSite, exportSiteSummaryCsv, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { buildSiteReportHtml } from '../src/ui/report.js';

const CAL = { pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, knownLength: 100, unit: 'mm', mmPerPx: 1, pixelDistance: 100 } as never;

function session(seed: number): AnalysisSession {
  const w = 240, h = 180;
  const masks = new Int32Array(w * h);
  let s = seed, id = 0;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 70; k++) {
    id++;
    const r = 8 + rnd() * 14, cx = r + rnd() * (w - 2 * r), cy = r + rnd() * (h - 2 * r);
    for (let y = Math.floor(cy - r); y < cy + r; y++) for (let x = Math.floor(cx - r); x < cx + r; x++) {
      if ((x - cx) ** 2 + ((y - cy) * 1.3) ** 2 <= r * r && masks[y * w + x] === 0) masks[y * w + x] = id;
    }
  }
  const sess = new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: 'full' } as never,
    recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
    masks,
    workingGrains: computeGrainMorphometrics(masks, w, h, 2),
    provenance: { appVersion: 't', ortVersion: 't', analyzedAt: '2026-01-01T00:00:00Z', modelId: 'ig2_unet_fp32', modelFile: 'x', modelRevision: 'r', modelSha256: 's' },
  });
  sess.setCalibration(CAL);
  return sess;
}

describe('printable site report', () => {
  const inputs: SitePhotoInput[] = [1, 2, 3].map((i) => {
    const s = session(i * 97);
    return { photoId: `p${i}`, label: `IMG <${i}>.jpg`, included: true, session: s, calibration: CAL } as SitePhotoInput;
  });
  const report = analyzeSite(inputs, { poolingMode: 'physical-area', bootstrapReplicates: 60, minBaxisPx: 5 });
  const site = { siteId: 's', name: 'Reach <A> & B', createdAt: 0, updatedAt: 0, options: {}, photoOrder: [] } as unknown as SiteRecord;
  const html = buildSiteReportHtml({
    site,
    report,
    generatedAt: '2026-11-18T10:00:00.000Z',
    metadata: { appVersion: '9.9.9', modelId: 'ig2_unet_fp32' },
    settings: [['Model', 'U-Net']],
    psdSvg: '<svg id="psd"></svg>',
    histogramSvg: '<svg id="hist"></svg>',
    photos: report.perPhoto.map((p) => ({ label: p.label, validGrainCount: p.validGrainCount, D50: p.D50, outlierReasons: p.outlierReasons, outlineSvg: '<svg viewBox="0 0 1 1"><path stroke-width="1"/></svg>' })),
  });

  it('has the same numbers as the site summary CSV', async () => {
    expect(report.unit).toBe('mm');
    const csv = await exportSiteSummaryCsv(report, { exportedAt: 'x' }).text();
    const rows = new Map(csv.split('\n').map((l) => l.split(',')).map((c) => [`${c[0]}/${c[1]}`, c[2]!]));
    const cells = [...html.matchAll(/data-csv="([^"]+)" data-value="([^"]+)">([^<]+)</g)];
    expect(cells.length).toBeGreaterThanOrEqual(20);
    for (const [, key, value, shown] of cells) {
      expect(rows.get(key!), key).toBe(value);
      const digits = shown!.includes('.') ? shown!.split('.')[1]!.length : 0;
      expect(shown, key).toBe(Number(value).toFixed(digits));
    }
    for (const key of ['psd/D50', 'psd_bootstrap_ci_lo/D50', 'psd_bootstrap_ci_hi/D84', 'folk_ward/sorting_phi', 'distribution/geometric_mean_Dg', 'wentworth/gravel_pct']) {
      expect(cells.some((c) => c[1] === key), key).toBe(true);
    }
  });

  it('is a printable page with the site, charts, photos, settings and citations', () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('@page { size: A4');
    expect(html).toContain('<h1>Reach &lt;A&gt; &amp; B</h1>');
    expect(html).toContain('<svg id="psd"></svg>');
    expect(html).toContain('<svg id="hist"></svg>');
    expect(html).toContain('IMG &lt;1&gt;.jpg');
    expect(html).toContain(report.adequacy.rating);
    expect(html).toContain('9.9.9');
    expect(html).toContain(report.citations[0]!.slice(0, 30));
    expect(html).not.toMatch(/onclick=|<script/i); // the app's CSP blocks inline scripts
    expect((html.match(/data:image\/svg\+xml;base64,/g) ?? []).length).toBe(3);
  });
});
