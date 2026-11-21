/**
 * Power of the survey-change test (compare view, "change over time"): how often a real change
 * of the bed is reported with p < 0.05.
 *
 * Two surveys of one place are simulated; the later bed is 20% coarser (every grain size × 1.2,
 * so the true D16, D50 and D84 ratios are all 1.2). They are compared with the app's own
 * computeComparedSites / surveyChanges, as in false_positive_rate.audit.ts.
 *
 * Two bed models:
 * - "uniform sorting" (the false-positive script's bed): 250 lognormal grains per photo,
 *   median 40 mm, ln sd 0.6, each photo's median varying by the patch sd;
 * - "variable sorting": each photo covers the same footprint (1000 x 750 mm; grains fill
 *   50-80% of it, so coarse patches give fewer grains), the within-photo ln sd varies between
 *   photos (0.45-0.85) and the median by patch sd 0.3. Area-weighted percentiles depend on
 *   sorting, so this bed varies more from photo to photo, as real beds can.
 *
 * Run: npx vitest run --config validation/comparison/vitest.power.config.ts
 * (POWER_TRIALS sets trials per row, default 400; writes power_results.md.)
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { computeComparedSites, surveyChanges } from '../../src/modules/siteComparison';
import { mulberry32 } from '../../src/modules/siteUncertainty';

function fakeSession(grainsMm: Array<{ b: number; a: number }>, mmPerPx = 0.5) {
  const grains = grainsMm.map(({ b, a }, i) => {
    const bPx = b / mmPerPx;
    const aPx = a / mmPerPx;
    const area = (Math.PI * aPx * bPx) / 4;
    return {
      id: i + 1, areaPx: area, areaMm2: area * mmPerPx ** 2, centroidX: 10, centroidY: 10,
      aAxisPx: aPx, bAxisPx: bPx, dEqPx: 2 * Math.sqrt(area / Math.PI), aAxisMm: a, bAxisMm: b,
      dEqMm: 2 * Math.sqrt(area / Math.PI) * mmPerPx, orientationRad: 0, touchesBorder: false, bbox: [0, 0, 1, 1],
    };
  });
  return {
    getResult: () => ({ grains, masks: new Int32Array(16), width: 4, height: 4, grainCount: grains.length }),
    getCalibration: () => ({ mmPerPx, pointA: { x: 0, y: 0 }, pointB: { x: 1, y: 0 }, physicalLengthMm: mmPerPx, pixelDistance: 1 }),
    getExcludeBorder: () => true,
    getProvenance: () => ({ postProcess: { minSize: 1 }, modelId: 'x' }),
    getManualEditCount: () => 0,
    ensureFeret: () => {},
    workingImage: { effectiveScaleFactor: 1, width: 4, height: 4, originalWidth: 4000, originalHeight: 3000 },
  };
}

type Bed = 'uniform sorting' | 'variable sorting';

/** One photo of the bed, all sizes multiplied by `effect`. */
function photoMaker(bed: Bed, patch: number, rand: () => number) {
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return (effect: number) => {
    if (bed === 'uniform sorting') {
      const m = Math.log(40 * effect) + patch * gauss();
      // Same grain shape rule as false_positive_rate.audit.ts (area = pi/4 b^2 x 1.3).
      return fakeSession(Array.from({ length: 250 }, () => {
        const b = Math.exp(m + 0.6 * gauss());
        return { b, a: b * 1.3 };
      }));
    }
    const m = Math.log(25 * effect) + patch * gauss();
    const sd = 0.45 + 0.4 * rand();
    const packing = 0.5 + 0.3 * rand();
    // The changed bed is the same bed scaled by `effect` (every length, so also the footprint):
    // grain counts per photo are unchanged and only sizes differ.
    const footprint = 1000 * 750 * effect * effect;
    const grains: Array<{ b: number; a: number }> = [];
    let area = 0;
    while (area < packing * footprint && grains.length < 2500) {
      const b = Math.min(600 * effect, Math.exp(m + sd * gauss()));
      const a = b * (1.2 + rand());
      grains.push({ b, a });
      area += (Math.PI * a * b) / 4;
    }
    return fakeSession(grains);
  };
}

it('power of the survey-change test for a real 20% change', () => {
  const N = Number(process.env.POWER_TRIALS ?? 400);
  const EFFECT = 1.2;
  const rows: string[] = [];
  const cases: Array<[Bed, number]> = [['uniform sorting', 0.15], ['uniform sorting', 0.3], ['variable sorting', 0.3]];
  for (const [bed, patch] of cases) {
    for (const photos of [3, 5, 6, 10, 20]) {
      const rand = mulberry32(5000 + photos * 7 + Math.round(patch * 100) + (bed === 'variable sorting' ? 1000 : 0));
      const make = photoMaker(bed, patch, rand);
      const survey = (name: string, date: string, effect: number) => ({
        siteId: name, name, place: 'P', surveyDate: date,
        inputs: Array.from({ length: photos }, (_, i) => ({ photoId: `${name}${i}`, label: `${name}${i}`, included: true, session: make(effect) })),
      });
      const sig = { D16: 0, D50: 0, D84: 0 };
      let anyStar = 0;
      for (let t = 0; t < N; t++) {
        const sites = computeComparedSites([survey(`a${t}`, '2024-01-01', 1), survey(`b${t}`, '2025-01-01', EFFECT)] as never, {
          poolingMode: 'physical-area', bootstrapReplicates: 500, minBaxisPx: 0, harmonizeCutoff: false,
        });
        const ch = surveyChanges(sites)[0]!.changes;
        let starred = false;
        for (const k of ['D16', 'D50', 'D84'] as const) {
          if (ch[k].p < 0.05) sig[k]++;
          if (ch[k].pAdjusted < 0.05) starred = true;
        }
        if (starred) anyStar++;
      }
      const pct = (v: number) => `${((100 * v) / N).toFixed(1)}%`;
      rows.push(`| ${bed} | ${patch.toFixed(2)} | ${photos} | ${pct(sig.D16)} | ${pct(sig.D50)} | ${pct(sig.D84)} | ${pct(anyStar)} |`);
    }
  }
  const table = [
    '| Bed | Patch sd | Photos per survey | D16 p < 0.05 | D50 p < 0.05 | D84 p < 0.05 | Any of D16/D50/D84 p < 0.05 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
  ].join('\n');
  writeFileSync(
    'validation/comparison/power_results.md',
    `Power of the survey-change test: later survey 20% coarser (all sizes x ${EFFECT}). ${N} trials per row, 500 bootstrap replicates, seeds as in the script.\n\n${table}\n`,
  );
  console.log(table);
});
