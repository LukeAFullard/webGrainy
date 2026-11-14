import { describe, expect, it } from 'vitest';
import { computeAllGrainMorphometrics } from '../src/modules/interactiveEditor.js';
import {
  computeConvexHull,
  computeExtendedMorphometrics,
  computeFabricRoseStats,
  computeWentworthHistogram,
} from '../src/modules/morphometricsExt.js';
import type { GrainMorphometrics } from '../src/types/index.js';

function makeGrain(
  id: number,
  overrides: Partial<GrainMorphometrics> = {},
): GrainMorphometrics {
  return {
    id,
    areaPx: 100,
    centroidX: 20,
    centroidY: 20,
    aAxisPx: 14,
    bAxisPx: 10,
    dEqPx: 11.28379,
    orientationRad: 0,
    touchesBorder: false,
    bbox: [15, 15, 25, 25],
    ...overrides,
  };
}

describe('morphometricsExt', () => {
  describe('computeConvexHull', () => {
    it('computes exact 2D convex hull via Andrew monotone chain', () => {
      const pts = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 5 }, // interior
        { x: 10, y: 10 },
        { x: 3, y: 2 }, // interior
        { x: 0, y: 10 },
      ];
      const hull = computeConvexHull(pts);
      expect(hull).toHaveLength(4);
      expect(hull).toContainEqual({ x: 0, y: 0 });
      expect(hull).toContainEqual({ x: 10, y: 0 });
      expect(hull).toContainEqual({ x: 10, y: 10 });
      expect(hull).toContainEqual({ x: 0, y: 10 });
    });
  });

  describe('computeExtendedMorphometrics', () => {
    it('computes Crofton perimeter, circularity, aspect ratio, solidity, and 2D sphericity on a synthetic disk', () => {
      const w = 100;
      const h = 100;
      const masks = new Int32Array(w * h);
      const r = 25;
      const cx = 50;
      const cy = 50;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) {
            masks[y * w + x] = 1;
          }
        }
      }

      const baseGrains = computeAllGrainMorphometrics(masks, w, h, 0);
      const ext = computeExtendedMorphometrics(masks, baseGrains, w, h, 1.0, 0.5);

      expect(ext).toHaveLength(1);
      const g = ext[0]!;
      const expectedPerimeter = 2 * Math.PI * r;
      expect(g.perimeterPx).toBeGreaterThan(expectedPerimeter * 0.95);
      expect(g.perimeterPx).toBeLessThan(expectedPerimeter * 1.05);
      expect(g.perimeterMm).toBeCloseTo(g.perimeterPx * 0.5, 6);
      expect(g.circularity).toBeGreaterThan(0.94);
      expect(g.circularity).toBeLessThanOrEqual(1.0);
      expect(g.aspectRatio).toBeCloseTo(1.0, 2);
      expect(g.elongation).toBeCloseTo(0.0, 2);
      expect(g.solidity).toBeGreaterThan(0.97);
      expect(g.solidity).toBeLessThanOrEqual(1.0);
      expect(g.sphericity2D).toBeGreaterThan(0.95);
      expect(g.convexAreaMm2).toBeCloseTo(g.convexAreaPx * 0.25, 6);
    });

    it('detects reduced solidity on a concave L-shaped grain and rescales by effectiveScaleFactor', () => {
      const w = 60;
      const h = 60;
      const masks = new Int32Array(w * h);
      // L-shape: vertical bar [10..17, 10..45] + horizontal bar [10..45, 38..45]
      for (let y = 10; y <= 45; y++) {
        for (let x = 10; x <= 17; x++) {
          masks[y * w + x] = 1;
        }
      }
      for (let y = 38; y <= 45; y++) {
        for (let x = 10; x <= 45; x++) {
          masks[y * w + x] = 1;
        }
      }

      const scale = 0.5;
      const workGrains = computeAllGrainMorphometrics(masks, w, h, 0);
      const origGrains = workGrains.map((g) => ({
        ...g,
        areaPx: g.areaPx / (scale * scale),
        centroidX: g.centroidX / scale,
        centroidY: g.centroidY / scale,
        aAxisPx: g.aAxisPx / scale,
        bAxisPx: g.bAxisPx / scale,
        dEqPx: g.dEqPx / scale,
        bbox: [
          g.bbox[0] / scale,
          g.bbox[1] / scale,
          g.bbox[2] / scale,
          g.bbox[3] / scale,
        ] as [number, number, number, number],
      }));

      const ext = computeExtendedMorphometrics(masks, origGrains, w, h, scale);
      const g = ext[0]!;
      expect(g.convexAreaPx).toBeGreaterThan(g.areaPx);
      expect(g.solidity).toBeLessThan(0.7);
      expect(g.solidity).toBeGreaterThan(0.3);
      expect(g.elongation).toBeGreaterThan(0.1);
    });
  });

  describe('computeFabricRoseStats', () => {
    it('treats -pi/2 and +pi/2 as identical axial orientations with R = 1.0', () => {
      const grains = [
        makeGrain(1, { orientationRad: -Math.PI / 2 }),
        makeGrain(2, { orientationRad: Math.PI / 2 }),
        makeGrain(3, { orientationRad: -Math.PI / 2 }),
        makeGrain(4, { orientationRad: Math.PI / 2 }),
      ];

      const stats = computeFabricRoseStats(grains, { binCount: 12 });
      expect(stats.grainCount).toBe(4);
      expect(stats.resultantLength).toBeCloseTo(1.0, 6);
      expect(stats.circularVariance).toBeCloseTo(0.0, 6);
      expect(Math.abs(stats.meanAngleRad)).toBeCloseTo(Math.PI / 2, 6);
      expect(stats.rayleighZ).toBeCloseTo(4.0, 6);
      expect(stats.rayleighP).toBeNull(); // n < 10
      expect(stats.bins).toHaveLength(12);
      const totalPct = stats.bins.reduce((s, b) => s + b.proportionPct, 0);
      expect(totalPct).toBeCloseTo(100, 6);
    });

    it('yields R near 0 for isotropic orientations and computes Rayleigh p-value when n >= 10', () => {
      const n = 36;
      const grains: GrainMorphometrics[] = [];
      for (let i = 0; i < n; i++) {
        const theta = -Math.PI / 2 + (i / n) * Math.PI;
        grains.push(makeGrain(i + 1, { orientationRad: theta }));
      }

      const stats = computeFabricRoseStats(grains, { binCount: 18 });
      expect(stats.grainCount).toBe(n);
      expect(stats.resultantLength).toBeLessThan(1e-6);
      expect(stats.circularVariance).toBeCloseTo(1.0, 6);
      expect(stats.rayleighZ).toBeLessThan(1e-6);
      expect(stats.rayleighP).not.toBeNull();
      expect(stats.rayleighP!).toBeCloseTo(1.0, 4);
      expect(stats.bins).toHaveLength(18);
    });

    it('supports area-weighted axial fabric statistics', () => {
      const grains = [
        makeGrain(1, { orientationRad: 0, areaPx: 900 }),
        makeGrain(2, { orientationRad: Math.PI / 2, areaPx: 100 }),
      ];
      const stats = computeFabricRoseStats(grains, { weighted: true });
      expect(stats.weighted).toBe(true);
      expect(stats.resultantLength).toBeCloseTo(0.8, 6);
      expect(stats.meanAngleRad).toBeCloseTo(0, 6);
    });
  });

  describe('computeWentworthHistogram', () => {
    it('bins calibrated grains into 1.0φ and 0.5φ Wentworth classes summing to 100%', () => {
      const grains = [
        makeGrain(1, { bAxisMm: 1.0, areaPx: 10 }),   // 0φ (Sand)
        makeGrain(2, { bAxisMm: 12.0, areaPx: 30 }),  // -3.58φ (Medium Gravel)
        makeGrain(3, { bAxisMm: 96.0, areaPx: 40 }),  // -6.58φ (Small Cobble)
        makeGrain(4, { bAxisMm: 300.0, areaPx: 20 }), // -8.23φ (Boulder)
      ];

      const bins1 = computeWentworthHistogram(grains, { stepPhi: 1.0 });
      const sum1 = bins1.reduce((s, b) => s + b.weightPct, 0);
      expect(sum1).toBeCloseTo(100, 6);
      expect(bins1.some((b) => b.wentworthClass === 'Sand' && b.grainCount === 1)).toBe(true);
      expect(bins1.some((b) => b.wentworthClass === 'Medium Gravel' && b.grainCount === 1)).toBe(true);
      expect(bins1.some((b) => b.wentworthClass === 'Small Cobble' && b.grainCount === 1)).toBe(true);
      expect(bins1.some((b) => b.wentworthClass === 'Boulder' && b.grainCount === 1)).toBe(true);

      const binsHalf = computeWentworthHistogram(grains, {
        stepPhi: 0.5,
        autoTrim: false,
      });
      expect(binsHalf).toHaveLength(32); // [-12, +4] at 0.5φ
      const sumHalf = binsHalf.reduce((s, b) => s + b.weightPct, 0);
      expect(sumHalf).toBeCloseTo(100, 6);
    });
  });
});
