import { describe, expect, it } from 'vitest';
import { computeExtraGrainStats } from '../src/modules/grainStatsExtra.js';

describe('extra grain statistics', () => {
  it('computes moment-ratio means exactly', () => {
    const d = [2, 4, 8];
    const x = computeExtraGrainStats(d, [1, 1, 1], { D10: 2, D25: 2.5, D50: 4, D75: 6, D90: 8 }, 'mm');
    expect(x.arithmeticMeanD10).toBeCloseTo(14 / 3, 12);
    expect(x.sauterMeanD32).toBeCloseTo((8 + 64 + 512) / (4 + 16 + 64), 12); // 6.952…
    expect(x.deBrouckereMeanD43).toBeCloseTo((16 + 256 + 4096) / (8 + 64 + 512), 12);
    // Geometric mean of 2, 4, 8 = 4; σg = exp(sd(ln d)) = 2^(sqrt(2/3)).
    expect(x.geometricMean).toBeCloseTo(4, 12);
    expect(x.geometricSd).toBeCloseTo(2 ** Math.sqrt(2 / 3), 12);
    // φ moments: φ = −1, −2, −3 → mean −2, sorting sqrt(2/3), symmetric.
    expect(x.momentMeanPhi).toBeCloseTo(-2, 12);
    expect(x.momentSortingPhi).toBeCloseTo(Math.sqrt(2 / 3), 12);
    expect(x.momentSkewness).toBeCloseTo(0, 12);
    expect(x.momentKurtosis).toBeCloseTo(1.5, 12);
    expect(x.traskSorting).toBeCloseTo(Math.sqrt(6 / 2.5), 12);
    expect(x.span).toBeCloseTo((8 - 2) / 4, 12);
    expect(x.fredleIndex).toBeCloseTo(4 / Math.sqrt(6 / 2.5), 12);
    expect(x.D30).toBeLessThanOrEqual(x.D60);
    expect(x.D60).toBeLessThanOrEqual(x.D65);
    expect(x.D30).toBeGreaterThanOrEqual(2);
    expect(x.D65).toBeLessThanOrEqual(8);
  });

  it('Sauter mean equals the area-weighted mean diameter when area ∝ d²', () => {
    const d = Array.from({ length: 200 }, (_, i) => 1 + (i % 37) * 0.7);
    const area = d.map((v) => (Math.PI / 4) * v * v);
    const x = computeExtraGrainStats(d, area, { D10: 1, D25: 1, D50: 1, D75: 1, D90: 1 }, 'px');
    const aw = d.reduce((s, v, i) => s + v * area[i]!, 0) / area.reduce((s, a) => s + a, 0);
    expect(x.sauterMeanD32).toBeCloseTo(aw, 10);
    expect(x.momentMeanPhi).toBeNull(); // no φ without mm
  });

  it('handles an empty sample', () => {
    const x = computeExtraGrainStats([], [], { D10: 0, D25: 0, D50: 0, D75: 0, D90: 0 }, 'mm');
    expect(x.n).toBe(0);
    expect(Number.isNaN(x.sauterMeanD32)).toBe(true);
  });
});
