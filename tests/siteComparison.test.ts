import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { compareD50, comparisonCsv, computeComparedSites, normalCdf, COMPARE_COLORS } from '../src/modules/siteComparison.js';
import type { SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { buildComparisonView } from '../src/ui/comparisonView.js';

/** A photo with a grid of square grains of side `size` px (above the 15 px minimum b-axis). */
function photo(id: string, size: number, count = 40): SitePhotoInput {
  const per = Math.ceil(Math.sqrt(count));
  const w = per * (size + 6) + 10, h = w;
  const masks = new Int32Array(w * h);
  let g = 0;
  for (let gy = 0; gy < per; gy++) for (let gx = 0; gx < per && g < count; gx++) {
    g++;
    const s = size + ((gx + gy) % 3) - 1;
    for (let y = 5 + gy * (size + 6); y < 5 + gy * (size + 6) + s; y++) for (let x = 5 + gx * (size + 6); x < 5 + gx * (size + 6) + s; x++) masks[y * w + x] = g;
  }
  const session = new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: 'full' } as never,
    recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
    masks,
    workingGrains: computeGrainMorphometrics(masks, w, h, 2),
  });
  return { photoId: id, label: id, included: true, session };
}

const options = { poolingMode: 'physical-area' as const, unit: 'px' as const, bootstrapReplicates: 100, bootstrapSeed: 1 };

describe('site comparison', () => {
  it('computes each site with the same options and assigns distinct colours', () => {
    const sites = computeComparedSites(
      [
        { siteId: 'a', name: 'Fine reach', inputs: [photo('a1', 20), photo('a2', 22)] },
        { siteId: 'b', name: 'Coarse reach', inputs: [photo('b1', 44), photo('b2', 48)] },
        { siteId: 'c', name: 'Empty site', inputs: [] },
      ],
      options,
    );
    expect(sites.map((s) => s.color)).toEqual([COMPARE_COLORS[0], COMPARE_COLORS[1], COMPARE_COLORS[2]]);
    expect(sites[0]!.report!.psd.D50).toBeLessThan(sites[1]!.report!.psd.D50);
    expect(sites[2]!.report).toBeNull();
    expect(sites[2]!.error).toMatch(/No analysed photos/);

    const [pair] = compareD50(sites);
    expect(pair!.a).toBe('Fine reach');
    expect(pair!.ratio).toBeLessThan(0.6); // fine D50 is about half the coarse one
    expect(pair!.ratioLo).toBeLessThan(pair!.ratio);
    expect(pair!.ratioHi).toBeGreaterThan(pair!.ratio);
    expect(pair!.p).toBeLessThan(0.05);

    const csv = comparisonCsv(sites, { app: 'test' });
    expect(csv).toContain('site,Fine reach,D50,');
    expect(csv).toContain('site,Empty site,status,No analysed photos,text');
    expect(csv).toContain('d50_ratio,Fine reach vs Coarse reach,p_value_approx,');
  });

  it('similar sites are not flagged as different', () => {
    const sites = computeComparedSites(
      [
        { siteId: 'a', name: 'A', inputs: [photo('a1', 25), photo('a2', 27)] },
        { siteId: 'b', name: 'B', inputs: [photo('b1', 25), photo('b2', 27)] },
      ],
      options,
    );
    const [pair] = compareD50(sites);
    expect(pair!.ratio).toBeCloseTo(1, 1);
    expect(pair!.p).toBeGreaterThan(0.05);
  });

  it('regression: never compares a site in px with a site in mm (CSV included)', () => {
    const calibrated = (id: string, size: number): SitePhotoInput => {
      const p = photo(id, size);
      p.session.setCalibration({ mmPerPx: 0.5, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 50, pixelDistance: 100 });
      return p;
    };
    const groups = [
      { siteId: 'm1', name: 'Mm one', inputs: [calibrated('m1a', 30), calibrated('m1b', 32)] },
      { siteId: 'm2', name: 'Mm two', inputs: [calibrated('m2a', 30), calibrated('m2b', 32)] },
      { siteId: 'p', name: 'Px site', inputs: [photo('pa', 30), photo('pb', 32)] },
    ];
    // "Compare in pixels": every site, calibrated or not, is pooled in px and all are compared.
    const inPx = computeComparedSites(groups, options);
    expect(inPx.map((s) => s.report?.unit)).toEqual(['px', 'px', 'px']);
    expect(compareD50(inPx)).toHaveLength(3);
    // Equal-photo fallback: calibrated sites report in mm, the uncalibrated one in px.
    const sites = computeComparedSites(groups, {
      poolingMode: 'equal-photo',
      allowEqualPhotoFallback: true,
      bootstrapReplicates: 100,
      bootstrapSeed: 1,
    });
    expect(sites.map((s) => s.report?.unit)).toEqual(['mm', 'mm', 'px']);
    const pairs = compareD50(sites);
    expect(pairs.map((c) => `${c.a}|${c.b}`)).toEqual(['Mm one|Mm two']);
    const csv = comparisonCsv(sites, { app: 'test' });
    expect(csv).toContain('d50_ratio,Mm one vs Mm two,ratio,');
    expect(csv).not.toContain('Px site vs');
    expect(csv).not.toContain('vs Px site');
  });

  it('F-19: with mm and px sites mixed, the CSV Holm p-values are those shown on screen', () => {
    const calibrated = (id: string, size: number): SitePhotoInput => {
      const p = photo(id, size);
      p.session.setCalibration({ mmPerPx: 0.5, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 50, pixelDistance: 100 });
      return p;
    };
    const sites = computeComparedSites(
      [
        { siteId: 'm1', name: 'Mm one', inputs: [calibrated('m1a', 30), calibrated('m1b', 34)] },
        { siteId: 'm2', name: 'Mm two', inputs: [calibrated('m2a', 26), calibrated('m2b', 28)] },
        { siteId: 'p1', name: 'Px one', inputs: [photo('p1a', 30), photo('p1b', 32)] },
        { siteId: 'p2', name: 'Px two', inputs: [photo('p2a', 24), photo('p2b', 25)] },
      ],
      { poolingMode: 'equal-photo', allowEqualPhotoFallback: true, bootstrapReplicates: 100, bootstrapSeed: 1 },
    );
    expect(sites.map((s) => s.report?.unit)).toEqual(['mm', 'mm', 'px', 'px']);
    const view = buildComparisonView(sites, false, 1);
    const shown = view.pairs[0]!.byKey.D50!.pAdjusted;
    const csv = comparisonCsv(sites, {});
    const row = csv.split('\n').find((l) => l.startsWith('d50_ratio,Mm one vs Mm two,p_value_holm,'))!;
    expect(Number(row.split(',')[3])).toBeCloseTo(shown, 12);
    expect(csv).not.toContain('Px one vs Px two');
    expect(csv).toMatch(/site,Px one,status,"?Not compared/);
  });

  it('normal CDF is accurate', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1.6448536269514722)).toBeCloseTo(0.05, 6);
  });
});
