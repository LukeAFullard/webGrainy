import { describe, expect, it } from 'vitest';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { computeGrainMorphometricsForIds } from '../src/modules/interactiveEditor.js';
import { ellipseRotationDeg, majorAxisDirection } from '../src/modules/orientationGeometry.js';

/** Rasterises a filled ellipse whose major axis points along screen angle `phiDeg` (x right, y down, clockwise). */
function ellipseMask(W: number, H: number, phiDeg: number, a = 20, b = 7): Int32Array {
  const m = new Int32Array(W * H);
  const phi = (phiDeg * Math.PI) / 180;
  const cx = W / 2, cy = H / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x - cx) * Math.cos(phi) + (y - cy) * Math.sin(phi);
      const v = -(x - cx) * Math.sin(phi) + (y - cy) * Math.cos(phi);
      if ((u / a) ** 2 + (v / b) ** 2 <= 1) m[y * W + x] = 1;
    }
  }
  return m;
}

/** Axial angle difference in degrees (0–90). */
function axialDiff(aDeg: number, bDeg: number): number {
  const d = (((aDeg - bDeg) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

describe('grain orientation and overlay geometry', () => {
  for (const phi of [0, 30, 45, 60, 90, 120, 135, 160]) {
    it(`ellipse overlay and vector follow a grain whose major axis is at ${phi}° on screen`, () => {
      const W = 64, H = 64;
      const masks = ellipseMask(W, H, phi);
      const [core] = computeGrainMorphometrics(masks, W, H);
      const [edited] = computeGrainMorphometricsForIds(masks, W, H, [1]);
      for (const g of [core!, edited!]) {
        const dir = majorAxisDirection(g.orientationRad);
        const vecDeg = (Math.atan2(dir.dy, dir.dx) * 180) / Math.PI;
        expect(axialDiff(vecDeg, phi)).toBeLessThan(2);
        // SVG rotate(φ) maps the ellipse's rx (major) axis to (cos φ, sin φ) on screen.
        expect(axialDiff(ellipseRotationDeg(g.orientationRad), phi)).toBeLessThan(2);
      }
      // Automatic and hand-edited grains use the same convention.
      expect(axialDiff((core!.orientationRad * 180) / Math.PI, (edited!.orientationRad * 180) / Math.PI)).toBeLessThan(1e-6);
    });
  }
});
