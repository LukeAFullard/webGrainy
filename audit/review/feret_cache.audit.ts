// Audit: AnalysisSession minFeret cache coherence after edits vs fresh recomputation.
import { it, expect } from 'vitest';
import { AnalysisSession } from '../../src/modules/pipelineController';
import { computeGrainMorphometrics } from '../../src/modules/postprocessCore';
import { computeExtendedMorphometrics } from '../../src/modules/morphometricsExt';

function make() {
  const w = 120, h = 60;
  const m = new Int32Array(w * h);
  for (let y = 10; y < 40; y++) for (let x = 10; x < 50; x++) m[y * w + x] = 1;
  for (let y = 10; y < 50; y++) for (let x = 60; x < 110; x++) m[y * w + x] = 2;
  const s = new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: 'full' } as never,
    recommendation: { model: 'unet', confidence: 1, reason: 'x', metrics: {} } as never,
    masks: m, workingGrains: computeGrainMorphometrics(m, w, h, 0), excludeBorder: false, borderMargin: 0,
  });
  return { s, w, h };
}
function check(s: AnalysisSession, w: number, h: number, step: string) {
  s.getStats('minFeret');
  const masks = s.getWorkingMasks();
  const fresh = computeExtendedMorphometrics(masks, computeGrainMorphometrics(masks, w, h, 0), w, h, 1);
  const freshById = new Map(fresh.map((g) => [g.id, g.minFeretPx]));
  const mismatches = s.getWorkingGrains()
    .map((g) => ({ id: g.id, session: (g as { minFeretPx?: number }).minFeretPx, fresh: freshById.get(g.id) }))
    .filter((r) => r.fresh === undefined || r.session === undefined || Math.abs(r.session - r.fresh) > 1e-9);
  console.log(step, s.getWorkingGrains().length, JSON.stringify(mismatches));
  return mismatches.length;
}
it('cache stays coherent through edits', () => {
  const { s, w, h } = make();
  let bad = check(s, w, h, 'initial');
  console.log('addId', s.addPolygonGrain([{ x: 30, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 55 }, { x: 30, y: 55 }])); bad += check(s, w, h, 'addPolygon-overlapping');
  s.splitGrainAtLine(2, [{ x: 85, y: 0 }, { x: 85, y: 59 }]); bad += check(s, w, h, 'split');
  const ids = s.getWorkingGrains().map((g) => g.id).slice(0, 2);
  s.mergeGrains(ids); bad += check(s, w, h, 'merge');
  s.undo(); bad += check(s, w, h, 'undo');
  s.redo(); bad += check(s, w, h, 'redo');
  s.deleteGrain(s.getWorkingGrains()[0]!.id); bad += check(s, w, h, 'delete');
  expect(bad).toBe(0);
});
