/** Audit S5: site statistics on tiny or zero-weight samples stay within their possible ranges. */
import { describe, expect, it } from 'vitest';
import { analyzeSite, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { squareGrainSession } from './helpers/squareSession.js';

const photo = (id: string, sides: number[], extra: Partial<SitePhotoInput> = {}): SitePhotoInput => ({
  photoId: id,
  label: id,
  included: true,
  session: squareGrainSession(sides, { mmPerPx: 1 }),
  ...extra,
});
const opts = { poolingMode: 'physical-area' as const, unit: 'mm' as const, minBaxisPx: 0, bootstrapReplicates: 200 };

describe('site statistics on small samples (audit S5)', () => {
  it('no Folk & Ward sorting for a single grain', () => {
    const r = analyzeSite([photo('p1', [30])], opts);
    expect(r.validGrainCount).toBe(1);
    expect(r.folkWard).toBeNull();
  });

  it('two photos: sorting and kurtosis intervals stay positive, skewness within [-1, 1]', () => {
    const r = analyzeSite([photo('fine', [25, 28, 30, 32]), photo('coarse', [25, 60, 100, 140])], opts);
    const ci = r.folkWardCi!;
    expect(ci).not.toBeNull();
    for (const [lo, hi] of [ci.sortingPhi, ci.kurtosisPhi]) {
      if (Number.isFinite(lo)) expect(lo).toBeGreaterThan(0);
      if (Number.isFinite(hi)) expect(hi).toBeGreaterThan(0);
    }
    for (const v of ci.skewnessPhi) if (Number.isFinite(v)) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });

  it('facies weights of 0: the jackknife SE uses the photos it can, never NaN', () => {
    const r = analyzeSite(
      [
        photo('a', [20, 30, 40], { faciesWeight: 1 }),
        photo('b', [25, 35, 45], { faciesWeight: 0 }),
        photo('c', [22, 32, 42], { faciesWeight: 0 }),
      ],
      { ...opts, poolingMode: 'facies-weighted' },
    );
    expect(r.jackknife).not.toBeNull();
    expect(Number.isNaN(r.jackknife!.seD50)).toBe(false);
  });
});
