/**
 * Regression (audit C1): the reported site interval must cover the truth about as often as it
 * says, also with few photos, and an interval that cannot be estimated must be flagged.
 *
 * Simulated bed: each photo's median varies between photos (patch sd 0.3 in ln units), grains
 * are lognormal within a photo (sd 0.6). The truth is the area-weighted D50 of the same process
 * over 2000 photos. Before the fix, the percentile cluster bootstrap covered it in about 45%
 * (2 photos), 64% (3), 77% (5) and 79% (10) of sites; the t-interval on the log scale (SE = larger
 * of bootstrap SE x sqrt(n/(n-1)) and jackknife SE) about 90-97%.
 */
import { describe, expect, it } from 'vitest';
import { analyzeSite, exportSiteSummaryCsv, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { computePsdPercentiles } from '../src/modules/sedimentStats.js';
import { mulberry32 } from '../src/modules/siteUncertainty.js';
import { maxRatingForPhotos } from '../src/modules/siteAdequacy.js';

function fakeSession(sizesMm: number[], mmPerPx = 0.5) {
  const grains = sizesMm.map((d, i) => {
    const bPx = d / mmPerPx;
    const area = ((Math.PI * bPx * bPx) / 4) * 1.3;
    return {
      id: i + 1, areaPx: area, areaMm2: area * mmPerPx ** 2, centroidX: 10, centroidY: 10,
      aAxisPx: bPx * 1.4, bAxisPx: bPx, dEqPx: bPx * 1.15, aAxisMm: bPx * 1.4 * mmPerPx, bAxisMm: d,
      dEqMm: bPx * 1.15 * mmPerPx, orientationRad: 0, touchesBorder: false, bbox: [0, 0, 1, 1],
    };
  });
  return {
    getResult: () => ({ grains, masks: new Int32Array(16), width: 4, height: 4, grainCount: grains.length }),
    getCalibration: () => ({ mmPerPx, pointA: { x: 0, y: 0 }, pointB: { x: 1, y: 0 }, physicalLengthMm: mmPerPx, pixelDistance: 1 }),
    getExcludeBorder: () => true,
    getProvenance: () => ({ postProcess: { minSize: 1 }, modelId: 'x' }),
    ensureFeret: () => {},
    workingImage: { effectiveScaleFactor: 1, width: 4, height: 4, originalWidth: 4000, originalHeight: 3000 },
  };
}

const MU = Math.log(40);
const SIGMA = 0.6;
const PATCH = 0.3;
const GRAINS = 150;

function sampler(seed: number) {
  const rand = mulberry32(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return (): number[] => {
    const m = MU + PATCH * gauss();
    return Array.from({ length: GRAINS }, () => Math.exp(m + SIGMA * gauss()));
  };
}

const inputs = (name: string, photos: number[][]): SitePhotoInput[] =>
  photos.map((s, i) => ({ photoId: `${name}${i}`, label: `${name}${i}.jpg`, included: true, session: fakeSession(s) as never }));

const opts = { poolingMode: 'physical-area' as const, bootstrapReplicates: 200, minBaxisPx: 0, harmonizeCutoff: false };

describe('site interval (calibrated for few photos)', () => {
  const photo = sampler(99);
  const vals: number[] = [];
  const w: number[] = [];
  for (let p = 0; p < 2000; p++) for (const d of photo()) { vals.push(d); w.push(d * d); }
  const truth = computePsdPercentiles(vals, w).D50;

  for (const n of [3, 10]) {
    it(`covers the true D50 close to 95% with ${n} photos (raw percentile interval does not)`, () => {
      const next = sampler(1000 + n);
      const trials = 80;
      let cov = 0;
      let rawCov = 0;
      for (let t = 0; t < trials; t++) {
        const r = analyzeSite(inputs('s', Array.from({ length: n }, next)), opts);
        if (r.bootstrapCi.lower.D50 <= truth && truth <= r.bootstrapCi.upper.D50) cov++;
        if (r.bootstrapPercentileCi.lower.D50 <= truth && truth <= r.bootstrapPercentileCi.upper.D50) rawCov++;
      }
      expect(cov / trials).toBeGreaterThanOrEqual(0.85);
      expect(cov).toBeGreaterThan(rawCov);
    });
  }

  it('is centred on the site value and wider than the raw interval', () => {
    const next = sampler(7);
    const r = analyzeSite(inputs('s', Array.from({ length: 4 }, next)), opts);
    const lo = r.bootstrapCi.lower.D50;
    const hi = r.bootstrapCi.upper.D50;
    expect(Math.log(r.psd.D50) - Math.log(lo)).toBeCloseTo(Math.log(hi) - Math.log(r.psd.D50), 9);
    expect(hi / lo).toBeGreaterThan(r.bootstrapPercentileCi.upper.D50 / r.bootstrapPercentileCi.lower.D50);
    expect(r.ciStatus).toBe('few-photos');
    expect(r.warnings.some((m) => m.includes('Only 4 photos'))).toBe(true);
  });

  it('flags the same photo added twice instead of showing a zero-width interval', () => {
    const p = sampler(5)();
    const r = analyzeSite(inputs('dup', [p, p]), opts);
    expect(r.ciStatus).toBe('degenerate');
    expect(Number.isNaN(r.bootstrapCi.lower.D50)).toBe(true);
    expect(Number.isNaN(r.bootstrapCi.upper.D50)).toBe(true);
    expect(r.warnings.some((m) => m.includes('same photo added twice'))).toBe(true);
  });

  it('exports the interval status and leaves unavailable bounds empty (not "NaN")', async () => {
    const p = sampler(5)();
    const csv = await exportSiteSummaryCsv(analyzeSite(inputs('dup', [p, p]), opts)).text();
    expect(csv).toContain('metadata,ci_status,degenerate,label');
    expect(csv).toContain('psd_bootstrap_ci_lo,D50,,mm');
    expect(csv).not.toMatch(/psd_bootstrap_ci_(lo|hi),D\d+,NaN/);
    const few = await exportSiteSummaryCsv(analyzeSite(inputs('s', Array.from({ length: 3 }, sampler(8))), opts)).text();
    expect(few).toContain('metadata,ci_status,few-photos,label');
  });

  it('enough photos: no few-photo warning, status ok', () => {
    const next = sampler(11);
    const r = analyzeSite(inputs('s', Array.from({ length: 6 }, next)), opts);
    expect(r.ciStatus).toBe('ok');
    expect(r.warnings.some((m) => m.includes('photos: the'))).toBe(false);
  });

  it('single photo keeps the grain bootstrap and its warning', () => {
    const r = analyzeSite(inputs('one', [sampler(3)()]), opts);
    expect(r.ciStatus).toBe('single-photo');
    expect(r.bootstrapCi).toEqual(r.bootstrapPercentileCi);
  });

  it('caps the adequacy rating by the number of photos', () => {
    expect(maxRatingForPhotos(1)).toBe('Minimal');
    expect(maxRatingForPhotos(2)).toBe('Adequate');
    expect(maxRatingForPhotos(5)).toBe('High Precision');
    const big = sampler(21);
    const twoBig = [0, 1].map(() => Array.from({ length: 20 }, big).flat()); // 2 photos x 3000 grains
    const r = analyzeSite(inputs('big', twoBig), opts);
    expect(r.adequacy.effectiveGrainCount).toBeGreaterThanOrEqual(400);
    expect(r.adequacy.rating).toBe('Adequate');
    expect(r.adequacy.limitedByPhotoCount).toBe(true);
  });

  it('bounds untrusted options (repeats, confidence level)', () => {
    const next = sampler(13);
    const r = analyzeSite(inputs('s', Array.from({ length: 3 }, next)), { ...opts, bootstrapReplicates: 2e9, confidenceLevel: 0.5 as never });
    expect(r.bootstrapReplicates).toBe(10_000);
    expect(r.bootstrapCi.confidenceLevel).toBe(0.95);
  });
});
