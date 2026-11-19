/** Regression (re-audit blocker 1): the fast site bootstrap must reproduce the reference. */
import { describe, expect, it } from 'vitest';
import { computeConvergence, computeJackknife, convergenceCheckpoints, MAX_CONVERGENCE_CI_POINTS, mulberry32, runBootstrap, runBootstrapReference } from '../src/modules/siteUncertainty.js';
import { buildPooledArrays } from '../src/modules/sitePooling.js';
import { computePsdPercentiles } from '../src/modules/sedimentStats.js';
import type { PreparedPhoto } from '../src/modules/sitePooling.js';
import type { PoolingMode } from '../src/modules/siteTypes.js';

function photos(nPhotos: number, perPhoto: number, seed: number): PreparedPhoto[] {
  const r = mulberry32(seed);
  return Array.from({ length: nPhotos }, (_, p) => ({
    input: { photoId: `p${p}`, label: `p${p}`, included: true } as never,
    rawGrainCount: perPhoto,
    preCutoffGrains: [],
    validGrains: Array.from({ length: perPhoto }, (_, g) => {
      const size = 5 * Math.exp(1.2 * (r() + r() + r() - 1.5)) * (1 + p * 0.03); // continuous: no ties
      return {
        grain: { id: g + 1 } as never,
        sizeVal: g === 3 ? Number.NaN : size, // one grain that never counts
        areaVal: size * size * (0.6 + 0.4 * r()),
        gridHits: Math.floor(r() * 3),
      };
    }),
    excludedTruncationCount: 0,
    excludedTruncationAreaMm2: 0,
    sampledBedAreaPx: 1,
    clastPackingPct: 50,
    exposedMatrixPct: 50,
    gridGrainHits: 0,
    gridMatrixHits: 0,
    gridSubCutoffHits: 0,
    faciesWeight: (p % 3) + 0.5,
    detectionLimitPx: 0,
  }));
}

const modes: PoolingMode[] = ['physical-area', 'equal-photo', 'virtual-wolman-grid', 'number-weighted', 'facies-weighted'];

describe('fast site bootstrap', () => {
  for (const mode of modes) {
    for (const twoStage of [false, true]) {
      for (const n of [1, 4]) {
        it(`matches the reference: ${mode}, ${twoStage ? 'two-stage' : 'cluster'}, ${n} photo(s)`, () => {
          const ph = photos(n, 40, n * 7 + modes.indexOf(mode));
          const a = runBootstrap(ph, mode, 'mm', 150, 42, twoStage, 0.95);
          const b = runBootstrapReference(ph, mode, 'mm', 150, 42, twoStage, 0.95);
          expect(a.mode).toBe(b.mode);
          for (const k of Object.keys(b.psdCi.lower) as Array<keyof typeof b.psdCi.lower>) {
            expect(a.psdCi.lower[k]).toBeCloseTo(b.psdCi.lower[k], 9);
            expect(a.psdCi.upper[k]).toBeCloseTo(b.psdCi.upper[k], 9);
          }
          expect(a.folkWardCi!.sortingPhi[0]).toBeCloseTo(b.folkWardCi!.sortingPhi[0], 9);
          expect(a.folkWardCi!.meanMm[1]).toBeCloseTo(b.folkWardCi!.meanMm[1], 9);
        });
      }
    }
  }

  it('is fast for a large site (60 photos x 300 grains, 1000 replicates)', () => {
    const ph = photos(60, 300, 3);
    const t = performance.now();
    runBootstrap(ph, 'physical-area', 'mm', 1000, 42, false, 0.95);
    expect(performance.now() - t).toBeLessThan(5000); // reference: ~20 s
  });

  it('jackknife leave-one-out PSDs equal a fresh pool of the other photos', () => {
    const ph = photos(5, 30, 11);
    const full = computePsdPercentiles(...(Object.values(buildPooledArrays(ph, 'equal-photo')).slice(0, 2) as [number[], number[]]));
    const { jackknife } = computeJackknife(ph, 'equal-photo', full);
    ph.forEach((_p, j) => {
      const sub = buildPooledArrays(ph.filter((_, i) => i !== j), 'equal-photo');
      const ref = computePsdPercentiles(sub.values, sub.weights);
      expect(jackknife!.perPhoto[j]!.D50Without).toBeCloseTo(ref.D50, 9);
      expect(jackknife!.perPhoto[j]!.D84Without).toBeCloseTo(ref.D84, 9);
    });
  });

  it('convergence: D-values at every photo count, CI at bounded checkpoints, last = full bootstrap', () => {
    expect([...convergenceCheckpoints(5)]).toEqual([1, 2, 3, 4, 5]);
    const cps = convergenceCheckpoints(60);
    expect(cps.size).toBe(MAX_CONVERGENCE_CI_POINTS);
    expect(cps.has(1) && cps.has(60)).toBe(true);
    const ph = photos(40, 50, 5);
    const pooled = buildPooledArrays(ph, 'physical-area');
    const psd = computePsdPercentiles(pooled.values, pooled.weights);
    const boot = runBootstrap(ph, 'physical-area', 'mm', 200, 42, false, 0.95);
    const conv = computeConvergence(ph, psd, boot, {
      poolingMode: 'physical-area', unit: 'mm', bootstrapReplicates: 200, bootstrapSeed: 42, bootstrapTwoStage: false, confidenceLevel: 0.95,
    });
    expect(conv).toHaveLength(40);
    const withCi = conv.filter((c) => Number.isFinite(c.ciLoD50));
    expect(withCi.length).toBe(MAX_CONVERGENCE_CI_POINTS);
    expect(conv.every((c) => Number.isFinite(c.D50))).toBe(true);
    // Every prefix D50 equals a fresh pool of the first k photos.
    for (const k of [1, 7, 23]) {
      const sub = buildPooledArrays(ph.slice(0, k), 'physical-area');
      expect(conv[k - 1]!.D50).toBeCloseTo(computePsdPercentiles(sub.values, sub.weights).D50, 9);
    }
    expect(conv[39]!.ciLoD50).toBe(boot.psdCi.lower.D50);
  });

  it('whole uncertainty pipeline stays fast for 60 photos x 300 grains (was ~44 s)', () => {
    const ph = photos(60, 300, 9);
    const t = performance.now();
    const pooled = buildPooledArrays(ph, 'physical-area');
    const psd = computePsdPercentiles(pooled.values, pooled.weights);
    const boot = runBootstrap(ph, 'physical-area', 'mm', 1000, 42, false, 0.95);
    computeJackknife(ph, 'physical-area', psd);
    computeConvergence(ph, psd, boot, {
      poolingMode: 'physical-area', unit: 'mm', bootstrapReplicates: 1000, bootstrapSeed: 42, bootstrapTwoStage: false, confidenceLevel: 0.95,
    });
    expect(performance.now() - t).toBeLessThan(4000); // ~0.6 s here; generous for slow CI
  });
});
