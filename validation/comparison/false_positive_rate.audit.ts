/**
 * False-positive rate of the survey-change test (compare view, "change over time").
 *
 * Two surveys of the SAME, unchanged bed are simulated and compared with the app's own
 * computeComparedSites / surveyChanges; the share of D50 changes with p < 0.05 should be
 * near 5%. Grains are lognormal (sd 0.6 in ln units, median 40 mm, 250 per photo); each
 * photo's median varies by `patch` (sd in ln units) to mimic patch-to-patch variation.
 *
 * Run: npx vitest run --config validation/comparison/vitest.config.ts
 *
 * Before the fixes, one-photo surveys gave ~30% false "significant" changes at patch 0.15
 * (their bootstrap only resamples grains) and 2-4 photo surveys 17-40% (z-test on a cluster
 * bootstrap with few clusters). One-photo surveys now get no p-value; the others use a Welch
 * t-test with each site's photo-corrected SE (larger of the bootstrap SE x sqrt(n/(n-1)) and
 * the leave-one-photo-out jackknife SE). Prints a markdown table (D16 / D50 / D84).
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { computeComparedSites, surveyChanges } from '../../src/modules/siteComparison';
import { mulberry32 } from '../../src/modules/siteUncertainty';

function fakeSession(sizesMm: number[], mmPerPx = 0.5) {
  const grains = sizesMm.map((d, i) => {
    const bPx = d / mmPerPx;
    const area = (Math.PI * bPx * bPx) / 4 * 1.3;
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

it('false-positive rate of survey-change D50 p-values on an unchanged bed', () => {
  const N = Number(process.env.FPR_TRIALS ?? 150);
  const rows: string[] = [];
  for (const [photos, patch] of [[1, 0.15], [2, 0.15], [3, 0.15], [5, 0.15], [10, 0.15], [20, 0.15], [3, 0.3], [5, 0.3], [10, 0.3], [20, 0.3], [6, 0]] as const) {
    const rand = mulberry32(1000 + photos * 7 + Math.round(patch * 100));
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const photo = () => {
      const m = Math.log(40) + patch * gauss();
      return Array.from({ length: 250 }, () => Math.exp(m + 0.6 * gauss()));
    };
    const survey = (name: string, date: string) => ({
      siteId: name, name, place: 'P', surveyDate: date,
      inputs: Array.from({ length: photos }, (_, i) => ({ photoId: `${name}${i}`, label: `${name}${i}`, included: true, session: fakeSession(photo()) })),
    });
    const sig = { D16: 0, D50: 0, D84: 0 };
    let tested = 0;
    for (let t = 0; t < N; t++) {
      const sites = computeComparedSites([survey(`a${t}`, '2024-01-01'), survey(`b${t}`, '2025-01-01')] as never, {
        poolingMode: 'physical-area', bootstrapReplicates: 500, minBaxisPx: 0, harmonizeCutoff: false,
      });
      const ch = surveyChanges(sites)[0]!.changes;
      if (Number.isFinite(ch.D50.p)) tested++;
      for (const k of ['D16', 'D50', 'D84'] as const) if (ch[k].p < 0.05) sig[k]++;
    }
    const pct = (v: number) => `${((100 * v) / N).toFixed(1)}%`;
    rows.push(`| ${photos} | ${patch.toFixed(2)} | ${tested} / ${N} | ${pct(sig.D16)} | ${pct(sig.D50)} | ${pct(sig.D84)} |`);
  }
  const table = ['| Photos per survey | Patch sd | p given | D16 p < 0.05 | D50 p < 0.05 | D84 p < 0.05 |', '| ---: | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n');
  // Vitest hides console output of passing tests: keep the table in a file as well.
  writeFileSync('validation/comparison/false_positive_rate_results.md', `${N} trials per row, 500 bootstrap replicates, seeds as in the script.\n\n${table}\n`);
  console.log(table);
});
