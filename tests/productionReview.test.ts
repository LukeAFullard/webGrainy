/**
 * Regression tests for the 2026-11 production-readiness review findings.
 */
import { describe, expect, it } from 'vitest';
import { computeFabricRoseStats } from '../src/modules/morphometricsExt.js';
import { majorAxisDirection, orientationFromMoments } from '../src/modules/orientationGeometry.js';
import { renderFabricRoseSvg } from '../src/ui/charts.js';
import type { GrainMorphometrics } from '../src/types/index.js';
import { validateSiteCalibration } from '../src/modules/siteCalibration.js';
import type { SitePhotoInput } from '../src/modules/siteTypes.js';
import { comparisonStatistics } from '../src/ui/compareReport.js';
import type { ComparisonView } from '../src/ui/comparisonView.js';

function grainAt(id: number, orientationRad: number): GrainMorphometrics {
  return {
    id,
    areaPx: 100,
    centroidX: 20,
    centroidY: 20,
    aAxisPx: 14,
    bAxisPx: 4,
    dEqPx: 11.28,
    orientationRad,
    touchesBorder: false,
    bbox: [15, 15, 25, 25],
  };
}

function meanLineDirection(svg: string): { dx: number; dy: number } {
  const m = /<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)" stroke="#d98300"/.exec(svg);
  if (!m) throw new Error('no mean-orientation line');
  const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number];
  const len = Math.hypot(x2 - x1, y2 - y1);
  return { dx: (x2 - x1) / len, dy: (y2 - y1) / len };
}

describe('F-01: fabric rose is drawn the same way round as the grains', () => {
  for (const [label, covXY] of [['\\ (top-left to bottom-right)', 1], ['/ (bottom-left to top-right)', -1]] as const) {
    it(`a ${label} grain plots its mean line parallel to the grain's major axis`, () => {
      // Pixels along y = x (covXY > 0) or y = -x (covXY < 0), slightly thickened.
      const theta = orientationFromMoments(10, 10, 9 * covXY);
      const grains = Array.from({ length: 12 }, (_, i) => grainAt(i + 1, theta));
      const rose = computeFabricRoseStats(grains);
      const axis = majorAxisDirection(theta);
      const drawn = meanLineDirection(renderFabricRoseSvg(rose));
      // Axial data: parallel or anti-parallel.
      expect(Math.abs(axis.dx * drawn.dx + axis.dy * drawn.dy)).toBeCloseTo(1, 2);
    });
  }

  it('puts the 90° label on the left, where a counter-clockwise 90° grain points', () => {
    const svg = renderFabricRoseSvg(computeFabricRoseStats([grainAt(1, Math.PI / 2)]));
    const m = /<text x="([\d.]+)" y="[\d.]+" text-anchor="end"[^>]*>90°<\/text>/.exec(svg);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(160);
  });
});

function fakePhoto(id: string, mmPerPx?: number): SitePhotoInput {
  const session = { getCalibration: () => (mmPerPx === undefined ? undefined : { mmPerPx }) };
  return { photoId: id, label: id, included: true, session } as unknown as SitePhotoInput;
}

describe('F-02: "Compare in pixels" is honoured for calibrated sites', () => {
  it('returns px when pixels are requested even though every photo is calibrated', () => {
    const v = validateSiteCalibration([fakePhoto('a', 0.5), fakePhoto('b', 0.4)], { poolingMode: 'physical-area', unit: 'px' });
    expect(v.valid).toBe(true);
    expect(v.unit).toBe('px');
  });

  it('still uses mm by default when every photo is calibrated', () => {
    expect(validateSiteCalibration([fakePhoto('a', 0.5)]).unit).toBe('mm');
  });

  it('labels the report from the unit actually used', () => {
    const mmView = { plotted: [], unit: 'mm', commonCutoffMm: null } as unknown as ComparisonView;
    const row = comparisonStatistics({}, mmView, true).find(([k]) => k === 'Compared in');
    expect(row?.[1]).toBe('mm');
    const pxView = { plotted: [], unit: 'px', commonCutoffMm: null } as unknown as ComparisonView;
    expect(comparisonStatistics({}, pxView, true).find(([k]) => k === 'Compared in')?.[1]).toMatch(/^pixels/);
  });
});
