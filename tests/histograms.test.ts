import { describe, expect, it } from 'vitest';
import { aspectRatioCounts, photoSizeHistogram, sizeHistogramFromWentworth } from '../src/modules/histograms.js';
import type { GrainMorphometrics } from '../src/types/index.js';

const grain = (id: number, bPx: number, areaPx: number, bMm?: number): GrainMorphometrics =>
  ({ id, bAxisPx: bPx, aAxisPx: bPx * 1.5, dEqPx: bPx * 1.2, areaPx, centroidX: 0, centroidY: 0, orientationRad: 0, touchesBorder: false, bbox: [0, 0, 1, 1], ...(bMm !== undefined ? { bAxisMm: bMm, aAxisMm: bMm * 1.5, dEqMm: bMm * 1.2 } : {}) }) as GrainMorphometrics;

describe('size and shape histograms', () => {
  it('bins uncalibrated photos in power-of-two pixel classes, area-weighted, small to large', () => {
    const h = photoSizeHistogram([grain(1, 5, 20), grain(2, 6, 30), grain(3, 20, 300)], { step: 1 });
    expect(h.unit).toBe('px');
    expect(h.bins.map((b) => [b.lo, b.hi, b.count])).toEqual([[4, 8, 2], [8, 16, 0], [16, 32, 1]]);
    expect(h.bins[0]!.weightPct).toBeCloseTo((50 / 350) * 100, 10);
    expect(h.bins.reduce((s, b) => s + b.weightPct, 0)).toBeCloseTo(100, 10);
  });

  it('uses Wentworth φ classes when calibrated, ordered from small to large', () => {
    const h = photoSizeHistogram([grain(1, 10, 80, 3), grain(2, 40, 1200, 20)], { step: 1 });
    expect(h.unit).toBe('mm');
    expect(h.bins[0]!.lo).toBeLessThan(h.bins[h.bins.length - 1]!.lo);
    const withGrains = h.bins.filter((b) => b.count > 0);
    expect(withGrains.map((b) => [b.lo, b.hi])).toEqual([[2, 4], [16, 32]]);
    expect(withGrains[1]!.className).toMatch(/Gravel/);
  });

  it('converts site Wentworth bins and counts aspect ratios', () => {
    const h = sizeHistogramFromWentworth([{ phiMin: -2, phiMax: -1, mmMin: 2, mmMax: 4, label: '', wentworthClass: 'Granule', grainCount: 3, weightPct: 100 }], 1);
    expect(h).toMatchObject({ unit: 'mm', n: 3, bins: [{ lo: 2, hi: 4, className: 'Granule' }] });
    expect(aspectRatioCounts([0.05, 0.55, 0.99, 1, Number.NaN], 10)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 2]);
  });
});

import { prepareWorkingImage, upscaleWorkingImage } from '../src/modules/imagePreprocess.js';
describe('working image enlargement', () => {
  it('enlarges ×1.5 and scales effectiveScaleFactor so sizes map back to the photo', () => {
    const w = 40, h = 20;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(128);
    const wi = upscaleWorkingImage(prepareWorkingImage(rgba, w, h, '1.0x'), 1.5);
    expect([wi.width, wi.height, wi.effectiveScaleFactor]).toEqual([60, 30, 1.5]);
    expect(wi.data.length).toBe(60 * 30 * 4);
    expect(wi.data[100]).toBe(128);
    const shrunk = upscaleWorkingImage(prepareWorkingImage(rgba, w, h, '0.5x'), 1.5);
    expect(shrunk.effectiveScaleFactor).toBeCloseTo(0.75, 10);
  });
});
