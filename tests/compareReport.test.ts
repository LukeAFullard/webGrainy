/** Printable comparison report and the shared Compare sites view (site to site, and over time). */
import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { computeComparedSites, type SiteForComparison } from '../src/modules/siteComparison.js';
import type { SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { buildComparisonView } from '../src/ui/comparisonView.js';
import { buildCompareReportHtml, compareReportTitle, comparisonStatistics } from '../src/ui/compareReport.js';

/** A photo of 2:1 rectangular grains of side ~`size` px, at 1 mm/px. */
function photo(id: string, size: number, seed: number, modelId: 'ig2_unet_fp32' | 'ig2_cpsam_fp16' = 'ig2_unet_fp32'): SitePhotoInput {
  const count = 36;
  const per = 6;
  const w = per * (size + 6) + 10, h = w;
  const masks = new Int32Array(w * h);
  let g = 0;
  for (let gy = 0; gy < per; gy++) for (let gx = 0; gx < per; gx++) {
    g++;
    const s = size + ((gx * 7 + gy * 3 + seed) % 7) - 3;
    for (let y = 5 + gy * (size + 6); y < 5 + gy * (size + 6) + Math.max(4, Math.round(s / 2)); y++)
      for (let x = 5 + gx * (size + 6); x < 5 + gx * (size + 6) + s; x++) masks[y * w + x] = g;
  }
  void count;
  const session = new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(0), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: '1.0x' },
    recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
    masks,
    workingGrains: computeGrainMorphometrics(masks, w, h, 2),
    provenance: { appVersion: 't', ortVersion: 't', analyzedAt: 'x', modelId, modelFile: 'f', modelRevision: 'r', modelSha256: 's', scaleMode: 'auto', inferencePipeline: 'cellpose' },
    calibration: { mmPerPx: 1, pointA: { x: 0, y: 0 }, pointB: { x: 1, y: 0 }, physicalLengthMm: 1, pixelDistance: 1 },
  });
  return { photoId: id, label: id, included: true, session };
}

const opts = { poolingMode: 'physical-area' as const, bootstrapReplicates: 200, bootstrapSeed: 1, minBaxisPx: 0 };
const survey = (siteId: string, name: string, size: number, extra: Partial<SiteForComparison> = {}, photos = 5, modelId?: 'ig2_cpsam_fp16'): SiteForComparison => ({
  siteId,
  name,
  inputs: Array.from({ length: photos }, (_, i) => photo(`${siteId}p${i}`, size + (i % 3) * 2, i, modelId)),
  ...extra,
});

const build = (sites: ReturnType<typeof computeComparedSites>, byDate: boolean): string => {
  const view = buildComparisonView(sites, byDate, 1);
  return buildCompareReportHtml({
    view,
    byDate,
    psdXAxis: 'mm',
    histogramStepPhi: 1,
    generatedAt: '2026-11-23T09:00:00.000Z',
    statistics: comparisonStatistics({ sizeMetric: 'bAxis', minBaxisPx: 0, confidenceLevel: 0.95, bootstrapReplicates: 200, bootstrapSeed: 1 }, view, false),
    metadata: { appVersion: '9.9.9' },
  });
};
const sections = (h: string): string[] => [...h.matchAll(/<h2><span class="no">(\d+)<\/span>([^<]+)<\/h2>/g)].map((m) => `${m[1]} ${m[2]}`);

describe('comparison report: one place over time', () => {
  const sites = computeComparedSites(
    [
      survey('s3', 'R3 2026', 34, { place: 'R3', surveyDate: '2026-04-01' }),
      survey('s1', 'R3 2024', 22, { place: 'R3', surveyDate: '2024-04-01' }),
      survey('s2', 'R3 2025', 23, { place: 'R3', surveyDate: '2025-04-01' }),
    ],
    opts,
  );
  const html = build(sites, true);

  it('is titled for the place, oldest survey first, with the time chart and the change table', () => {
    expect(compareReportTitle(buildComparisonView(sites, true, 1), true)).toEqual({ kicker: 'Grain size over time', title: 'R3: 3 surveys' });
    expect(html).toContain('<h1>R3: 3 surveys</h1>');
    const order = ['R3 2024', 'R3 2025', 'R3 2026'].map((n) => html.indexOf(`</i>${n}<br>`));
    expect(order.every((p, i) => p > 0 && (i === 0 || p > order[i - 1]!))).toBe(true);
    expect(sections(html)).toEqual([
      '1 Summary by site', '2 Grain-size distributions', '3 Change over time', '4 Differences between sites',
      '5 Distribution statistics', '6 Grain shape and fabric', '7 Methods, settings and software', '8 References (please cite)',
    ]);
    expect(html).toContain('2024-04-01 → 2025-04-01');
    expect(html).toContain('2025-04-01 → 2026-04-01');
    // The 2026 survey is clearly coarser than 2025 (sizes 34 vs 23 px at 1 mm/px), with 5 photos each.
    const row = html.slice(html.indexOf('2025-04-01 → 2026-04-01'));
    expect(row.slice(0, row.indexOf('</tr>'))).toContain('<strong>*</strong>');
  });

  it('lists every pair with D16, D50 and D84 tests and the shared settings', () => {
    const pairs = html.slice(html.indexOf('Differences between sites'), html.indexOf('Distribution statistics</h2>'));
    expect(pairs.match(/<tr><th>R3 [^<]+ ÷ /g)).toHaveLength(3);
    expect(pairs.match(/×<\/strong>/g)).toHaveLength(9);
    expect(html).toContain('<dt>Confidence level</dt><dd>95%</dd>');
    expect(html).toContain('Holm, S. (1979)');
    expect(html.match(/Eaton, B\. C\./g)).toHaveLength(1);
    expect(html).toContain('@page { size: A4');
    expect(html).toContain('data-print');
  });

  it('without date order: a site-to-site comparison, no time section', () => {
    const h = build(sites, false);
    expect(h).toContain('<h1>Comparison of 3 sites</h1>');
    expect(h).not.toContain('Change over time');
    expect(sections(h).map((x) => Number(x.split(' ')[0]))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('comparison report: checks and safety', () => {
  it('flags sites analysed differently and highlights the setting', () => {
    const sites = computeComparedSites([survey('a', 'Bar A', 24), survey('b', 'Bar B', 26, {}, 5, 'ig2_cpsam_fp16')], opts);
    const h = build(sites, false);
    expect(h).toContain('Read this first');
    expect(h).toContain('Not analysed the same way.');
    expect(h).toMatch(/<tr class="differ"><th>[^<]*model/i);
  });

  it('notes one-photo sites and gives them no test', () => {
    const sites = computeComparedSites([survey('a', 'One', 24, {}, 1), survey('b', 'Five', 26)], opts);
    const h = build(sites, false);
    expect(h).toContain('no test (1 photo)');
    expect(h).toContain('one photo only');
  });

  it('matches the D16 / D50 / D84 tests of a pair by site, even when two sites share a name', () => {
    const sites = computeComparedSites([survey('a', 'Same', 22), survey('b', 'Same', 30), survey('c', 'Other', 26)], opts);
    const view = buildComparisonView(sites, false, 1);
    expect(view.pairs.map((p) => `${p.aId}-${p.bId}`)).toEqual(['a-b', 'a-c', 'b-c']);
    for (const p of view.pairs) {
      for (const k of ['D16', 'D50', 'D84'] as const) {
        expect(p.byKey[k]?.aId).toBe(p.aId);
        expect(p.byKey[k]?.bId).toBe(p.bId);
      }
    }
  });

  it('escapes site names and places everywhere, including the page footer', () => {
    const evil = '<img src=x onerror=alert(1)>"';
    const sites = computeComparedSites([survey('a', evil, 24, { place: evil, surveyDate: '2024-01-01' }), survey('b', 'B', 26, { place: evil, surveyDate: '2025-01-01' })], opts);
    const h = build(sites, true);
    expect(h).not.toContain('<img src=x');
    const footer = h.match(/@bottom-left \{ content: "([^"]*)"/)![1]!;
    expect(footer).not.toMatch(/[<>"]/);
  });
});
