/**
 * Regression tests for the 2026-11 production-readiness review findings.
 */
import { describe, expect, it } from 'vitest';
import { computeFabricRoseStats } from '../src/modules/morphometricsExt.js';
import { majorAxisDirection, orientationFromMoments } from '../src/modules/orientationGeometry.js';
import { renderCompositionBarsSvg, renderFabricRoseSvg } from '../src/ui/charts.js';
import type { GrainMorphometrics } from '../src/types/index.js';
import { validateSiteCalibration } from '../src/modules/siteCalibration.js';
import type { SitePhotoInput } from '../src/modules/siteTypes.js';
import { comparisonStatistics } from '../src/ui/compareReport.js';
import type { ComparisonView } from '../src/ui/comparisonView.js';
import { createHash } from 'node:crypto';
import { PARAM_RANGES, parseParamInput, sanitizeAnalysisParams } from '../src/ui/savedSettings.js';
import { POSTPROCESS_LIMITS } from '../src/modules/postprocessCore.js';
import { PRINT_SCRIPT_SHA256, PRINT_SCRIPT_SOURCE, REPORT_CSP, reportDocument } from '../src/ui/report.js';

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

describe('F-06: printable report footer and CSP', () => {
  it('no control character can end the CSS footer string', () => {
    const html = reportDocument('t', 'Reach\f}}body{background:red}/*\u000b\u2028x', '<p>body</p>');
    const footer = /content: "([^"]*)"; font/.exec(html)?.[1] ?? '';
    expect(footer).not.toMatch(/[\u0000-\u001f\u2028]/);
    expect(footer).toContain('}}body{background:red}');
    // Still one @page rule: the injected braces stayed inside the string.
    expect(html.match(/@bottom-left \{ content: "[^"]*"; font/g)).toHaveLength(1);
  });

  it('carries a CSP that blocks the network and allows only the Print script', () => {
    const html = reportDocument('t', 'f', '');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(REPORT_CSP).toMatch(/default-src 'none'/);
    expect(createHash('sha256').update(PRINT_SCRIPT_SOURCE).digest('base64')).toBe(PRINT_SCRIPT_SHA256);
  });
});

describe('F-09: composition chart is well-formed XML', () => {
  it('escapes "<" in the class labels', () => {
    const svg = renderCompositionBarsSvg([{ name: 'A & <B>', color: '#000', w: { sandPct: 30, gravelPct: 40, cobblePct: 20, boulderPct: 10 } }]);
    // A "<" not starting a tag name or closing tag is a fatal XML error (breaks SVG / PNG export).
    expect(svg).not.toMatch(/<(?![a-zA-Z/])/);
    expect(svg).toContain('Sand (&lt; 2 mm)');
  });
});

describe('F-14: settings the UI accepts are settings the analysis accepts', () => {
  it('rejects a seed density below 1', () => {
    expect(parseParamInput('minSeedDensity', '0')).toHaveProperty('error');
    expect(parseParamInput('minSeedDensity', '0.5')).toHaveProperty('error');
    expect(parseParamInput('minSeedDensity', '1')).toEqual({ value: 1 });
    expect(sanitizeAnalysisParams({ minSeedDensity: 0 }).minSeedDensity).not.toBe(0);
  });

  it('every UI range lies inside the post-processing limits', () => {
    for (const [key, range] of Object.entries(PARAM_RANGES)) {
      const lim = (POSTPROCESS_LIMITS as Record<string, readonly [number, number, boolean]>)[key];
      if (!lim || !range) continue;
      expect(range[0], key).toBeGreaterThanOrEqual(lim[0]);
      expect(range[1], key).toBeLessThanOrEqual(lim[1]);
    }
  });
});
