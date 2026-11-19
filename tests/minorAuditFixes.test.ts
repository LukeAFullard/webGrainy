/** Regression tests for the minor issues from the 2026-11-19 scientific audit. */
import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeWentworthHistogram } from '../src/modules/morphometricsExt.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { computeSedimentStats, computeWentworthProportions, grainSizeIn, summaryCsvRows } from '../src/modules/sedimentStats.js';
import { getGrainSize } from '../src/modules/sitePooling.js';
import type { GrainMorphometrics } from '../src/types/index.js';

function grain(over: Partial<GrainMorphometrics>): GrainMorphometrics {
  return {
    id: 1, areaPx: 100, centroidX: 50, centroidY: 50, aAxisPx: 20, bAxisPx: 10, dEqPx: 11.3,
    orientationRad: 0, touchesBorder: false, bbox: [40, 40, 60, 60], ...over,
  };
}

describe('unit-safe grain sizes (never a px value labelled mm)', () => {
  it('derives a missing min-Feret mm value from the grain\'s own scale', () => {
    const g = grain({ bAxisMm: 5, aAxisMm: 10, dEqMm: 5.65, minFeretPx: 12 }); // 0.5 mm/px, no minFeretMm
    expect(grainSizeIn(g, 'minFeret', 'mm')).toBeCloseTo(6, 12);
    expect(getGrainSize(g, 'minFeret', 'mm')).toBeCloseTo(6, 12);
    expect(grainSizeIn(g, 'minFeret', 'px')).toBe(12);
  });

  it('returns NaN (grain skipped) rather than a px number when no mm scale exists', () => {
    const g = grain({ minFeretPx: 12 });
    expect(grainSizeIn(g, 'minFeret', 'mm')).toBeNaN();
    expect(grainSizeIn(g, 'bAxis', 'mm')).toBeNaN();
    expect(getGrainSize(g, 'dEq', 'mm')).toBeNaN();
  });

  it('keeps mm statistics in mm when min-Feret mm values are missing', () => {
    const grains = [10, 12, 14, 16].map((b, i) => grain({ id: i + 1, bAxisPx: b, bAxisMm: b / 2, dEqMm: b / 2, minFeretPx: b + 1 }));
    const r = computeSedimentStats(grains, { sizeMetric: 'minFeret' });
    expect(r.unit).toBe('mm');
    expect(r.areaWeightedMinFeret!.D95).toBeLessThan(9); // px values would be up to 17
  });
});

describe('summary CSV', () => {
  it('reports grains removed by the size cutoffs', () => {
    const grains = [5, 20, 30].map((b, i) => grain({ id: i + 1, bAxisPx: b }));
    const rows = summaryCsvRows(computeSedimentStats(grains, { minBaxisPx: 15 }));
    expect(rows).toContain('summary,excluded_cutoff_grains,1,count');
  });
});

describe('Wentworth class boundaries agree between histogram and class percentages', () => {
  it.each([
    [2, 'Very Fine Gravel', 'gravelPct'],
    [64, 'Small Cobble', 'cobblePct'],
    [256, 'Boulder', 'boulderPct'],
  ] as const)('%d mm', (d, histClass, pct) => {
    const g = grain({ bAxisMm: d, dEqMm: d, aAxisMm: d * 2 });
    const bins = computeWentworthHistogram([g], { stepPhi: 1, autoTrim: false });
    const hit = bins.find((b) => b.grainCount > 0)!;
    expect(hit.wentworthClass).toBe(histClass);
    expect(hit.mmMin).toBe(d);
    expect(computeWentworthProportions([g])![pct]).toBe(100);
  });

  it('a grain just under 2 mm is sand in both', () => {
    const g = grain({ bAxisMm: 1.999, dEqMm: 1.999 });
    expect(computeWentworthHistogram([g], { stepPhi: 0.5 }).find((b) => b.grainCount > 0)!.wentworthClass).toBe('Sand');
    expect(computeWentworthProportions([g])!.sandPct).toBe(100);
  });
});

describe('per-grain CSV included_in_stats', () => {
  it('follows the size cutoffs used by the summaries', () => {
    const w = 100, h = 60;
    const masks = new Int32Array(w * h);
    const square = (id: number, x0: number, s: number): void => {
      for (let y = 10; y < 10 + s; y++) for (let x = x0; x < x0 + s; x++) masks[y * w + x] = id;
    };
    square(1, 5, 8); // b ~ 9 px
    square(2, 30, 30); // b ~ 35 px
    const s = new AnalysisSession({
      workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: '1.0x' },
      recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
      masks,
      workingGrains: computeGrainMorphometrics(masks, w, h, 2),
    });
    const col = (csv: string): string[] => {
      const [head, ...rows] = csv.split('\n');
      const i = head!.split(',').indexOf('included_in_stats');
      return rows.map((r) => r.split(',')[i]!);
    };
    expect(col(s.exportCsv())).toEqual(['true', 'true']);
    expect(col(s.exportCsv({ cutoffs: { minBaxisPx: 15 } }))).toEqual(['false', 'true']);
    expect(s.getStats('bAxis', { minBaxisPx: 15 }).includedGrains).toBe(1);
  });
});
