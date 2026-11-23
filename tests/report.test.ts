import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import type { SiteRecord } from '../src/modules/projectStorage.js';
import { analyzeSite, exportSiteSummaryCsv, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { buildSiteReportHtml, DEFAULT_REPORT_OPTIONS, PRINT_SCRIPT, sanitizeReportOptions } from '../src/ui/report.js';

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

  it('says when the photo count capped the adequacy rating (3 photos: at most Adequate)', () => {
    const capped = { ...report, adequacy: { ...report.adequacy, rating: 'Adequate' as const, limitedByPhotoCount: true } };
    const h = buildSiteReportHtml({ site, report: capped, generatedAt: 'x', metadata: {}, settings: [], psdSvg: '', histogramSvg: '', photos: [] });
    expect(h).toContain('<strong>Adequate</strong> (capped: 3 photos (5 or more needed for a higher rating))');
    expect(html.includes('capped:')).toBe(report.adequacy.limitedByPhotoCount);
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
    // One static script, only to make Print work when the file is opened on its own (the app's
    // CSP blocks it in the pop-up, where the app binds the button instead).
    expect(html).not.toMatch(/onclick=/i);
    expect(html.match(/<script/gi)).toHaveLength(1);
    expect(html).toContain(PRINT_SCRIPT);
    expect((html.match(/data:image\/svg\+xml;base64,/g) ?? []).length).toBe(3);
  });

  it('lists every percentile with its interval, a row per photo, and a scale bar on calibrated photos', () => {
    for (const k of ['D5', 'D10', 'D16', 'D25', 'D50', 'D75', 'D84', 'D90', 'D95']) {
      expect(html, k).toContain(`data-csv="psd/${k}"`);
      expect(html, k).toContain(`data-csv="psd_bootstrap_ci_lo/${k}"`);
    }
    expect(html).toContain('Results by photo');
    expect((html.match(/<td class="lbl">/g) ?? []).length).toBe(3);
    expect(html).toContain('Page " counter(page) " of " counter(pages)');
    // Site name in the CSS page footer: plain text, cannot close the <style> tag.
    expect(html).toContain('content: "Reach  A  & B · grain-size report"');
    const withBar = buildSiteReportHtml({
      site, report, generatedAt: 'x', metadata: {}, settings: [], psdSvg: '', histogramSvg: null,
      photos: [{ label: 'a.jpg', validGrainCount: 1, D50: 20, mmPerPx: 0.5, widthPx: 4000, heightPx: 3000, outlierReasons: [] }],
    });
    // 4000 px x 0.5 mm = 2 m wide: a 20 cm bar is 10 % of the width.
    expect(withBar).toContain('<div class="sbar" style="width:10.00%"></div><div class="slabel">20 cm</div>');
    expect(html).not.toContain('class="sbar"'); // no size: no bar
  });

  describe('options', () => {
    const base = {
      site,
      report,
      generatedAt: '2026-11-18T10:00:00.000Z',
      metadata: {},
      settings: [] as Array<[string, string]>,
      psdSvg: '<svg id="psd"></svg>',
      histogramSvg: '<svg id="hist"></svg>',
      photos: report.perPhoto.map((p) => ({ label: p.label, validGrainCount: p.validGrainCount, D50: p.D50, outlierReasons: [], outlineSvg: '<svg viewBox="0 0 1 1"></svg>' })),
    };
    const sections = (h: string): string[] => [...h.matchAll(/<h2><span class="no">(\d+)<\/span>([^<]+)<\/h2>/g)].map((m) => `${m[1]} ${m[2]}`);

    it('adds shape, fabric and uncertainty figures, numbered in reading order, with numbers from the CSV', async () => {
      const h = buildSiteReportHtml({ ...base, shapeSvg: '<svg id="shape"></svg>', fabricSvg: '<svg id="rose"></svg>', convergenceSvg: '<svg id="conv"></svg>', jackknifeSvg: '<svg id="jk"></svg>' });
      expect(sections(h)).toEqual([
        '1 Grain-size distribution', '2 Distribution statistics', '3 Grain shape and fabric', '4 Sample adequacy and checks',
        '5 Results by photo', '6 Photos', '7 Methods, settings and software', '8 References (please cite)',
      ]);
      const figs = [...h.matchAll(/Figure (\d+)\./g)].map((m) => Number(m[1]));
      expect(figs).toEqual([1, 2, 3, 4, 5, 6]);
      expect(h.indexOf('id="psd"')).toBeLessThan(h.indexOf('id="shape"'));
      expect(h.indexOf('id="rose"')).toBeLessThan(h.indexOf('id="conv"'));
      const csv = await exportSiteSummaryCsv(report, { exportedAt: 'x' }).text();
      const rows = new Map(csv.split('\n').map((l) => l.split(',')).map((c) => [`${c[0]}/${c[1]}`, c[2]!]));
      for (const key of ['shape/median_aspect_ratio_b_over_a', 'fabric/mean_axial_orientation_deg', 'fabric/resultant_length_R']) {
        const m = h.match(new RegExp(`data-csv="${key}" data-value="([^"]+)"`));
        expect(m, key).not.toBeNull();
        expect(rows.get(key), key).toBe(m![1]);
      }
    });

    it('leaves out what is switched off, without gaps in the numbering', () => {
      const h = buildSiteReportHtml({
        ...base,
        shapeSvg: '<svg id="shape"></svg>',
        convergenceSvg: '<svg id="conv"></svg>',
        options: { photoOverlay: 'outlines', photosPerRow: 2, includePhotos: false, includeShapeFabric: false, includeUncertainty: false },
      });
      expect(h).not.toContain('id="shape"');
      expect(h).not.toContain('id="conv"');
      expect(h).not.toContain('Photos</h2>');
      expect(sections(h).map((x) => x.split(' ')[0])).toEqual(['1', '2', '3', '4', '5', '6']);
    });

    it('draws the chosen overlay with its legend, one photo per row, or photos only', () => {
      const legend = [{ label: 'Cobble (64–256 mm)', fill: 'rgba(1, 2, 3, 0.5)', stroke: 'rgba(1, 2, 3, 1)' }];
      const w = buildSiteReportHtml({ ...base, overlayLegend: legend, options: { ...DEFAULT_REPORT_OPTIONS, photoOverlay: 'wentworth', photosPerRow: 1 } });
      expect(w).toContain('<div class="photos single">');
      expect(w).toContain('Cobble (64–256 mm)');
      expect(w).not.toContain('Detected grain outlines');
      expect(w).toContain('class="outlines"');
      const none = buildSiteReportHtml({ ...base, options: { ...DEFAULT_REPORT_OPTIONS, photoOverlay: 'none' } });
      expect(none).not.toContain('class="outlines"');
      expect(none).toContain('<div class="photos">');
    });

    it('reads stored options safely', () => {
      expect(sanitizeReportOptions(null)).toEqual(DEFAULT_REPORT_OPTIONS);
      expect(sanitizeReportOptions({ photoOverlay: '<x>', photosPerRow: 7, includePhotos: 'yes', includeShapeFabric: false })).toEqual({ ...DEFAULT_REPORT_OPTIONS, includeShapeFabric: false });
      expect(sanitizeReportOptions({ photoOverlay: 'counted', photosPerRow: 1 })).toMatchObject({ photoOverlay: 'counted', photosPerRow: 1 });
    });
  });

  it('colours report photos by Wentworth class (the Display colours), faint when not counted', async () => {
    const { reportOverlaySvg, overlayLegend } = await import('../src/ui/reportBuilder.js');
    const sess = inputs[0]!.session;
    const seen = new Set<number>();
    const all = new Set(sess.getResult().grains.map((g) => g.id));
    const svg = reportOverlaySvg(sess, 'wentworth', 'bAxis', all, seen);
    // 1 mm/px grains of 10-40 px: fine-medium and coarse gravel.
    expect([...seen].sort()).toEqual([1, 2]);
    expect(svg).toContain('fill="rgba(59, 158, 255, 0.5)"');
    expect(svg).toContain('fill="rgba(46, 204, 113, 0.5)"');
    expect(overlayLegend('wentworth', seen).map((l) => l.label)).toEqual(['Fine–medium gravel (2–16 mm)', 'Coarse gravel (16–64 mm)']);
    const faint = reportOverlaySvg(sess, 'wentworth', 'bAxis', new Set(), new Set());
    expect(faint).not.toContain('0.5)"');
    const counted = reportOverlaySvg(sess, 'counted', 'bAxis', new Set([[...all][0]!]), new Set());
    expect(counted.match(/stroke="#0369a1"/g)).toHaveLength(1);
    expect(counted).toContain('stroke="#e53e3e"');
  });
});
