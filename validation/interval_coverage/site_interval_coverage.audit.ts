/**
 * Coverage of the site interval in every pooling mode (and the two-stage bootstrap).
 *
 * Simulated bed: each photo's median varies between photos ("patch sd", ln units); grains are
 * lognormal within a photo (sd 0.6). Grains are drawn as squares into a real label mask, so the
 * virtual Wolman grid samples pixels as in the app. The truth for each mode is that mode's
 * estimate pooled over many photos of the same process (its consistency target). A 95% interval
 * should contain it about 95% of the time.
 *
 * Run: npx vitest run --config validation/interval_coverage/vitest.config.ts
 * (COVERAGE_TRIALS sets trials per row; writes site_interval_coverage_results.md.)
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { AnalysisSession } from '../../src/modules/analysisSession';
import { computeAllGrainMorphometrics } from '../../src/modules/interactiveEditor';
import { analyzeSite, type PoolingMode, type SitePhotoInput } from '../../src/modules/siteAnalysis';
import { mulberry32 } from '../../src/modules/siteUncertainty';

const W = 600;
const MM_PER_PX = 0.5;

/** A photo: grains of median exp(m) mm drawn as squares (side ~ b-axis) packed into a W x W mask. */
function photo(rand: () => number, gauss: () => number, m: number, id: string, faciesWeight: number): SitePhotoInput {
  const masks = new Int32Array(W * W);
  let x0 = 4, y0 = 4, rowH = 0, gid = 1;
  for (;;) {
    const sidePx = Math.max(4, Math.round(Math.exp(m + 0.6 * gauss()) / MM_PER_PX / 1.155));
    if (x0 + sidePx + 4 > W) { x0 = 4; y0 += rowH + 4; rowH = 0; }
    if (y0 + sidePx + 4 > W) break;
    for (let y = y0; y < y0 + sidePx; y++) masks.fill(gid, y * W + x0, y * W + x0 + sidePx);
    gid++; x0 += sidePx + 4; rowH = Math.max(rowH, sidePx);
    if (gid > 4000) break;
  }
  const session = new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(0), width: W, height: W, originalWidth: W, originalHeight: W, effectiveScaleFactor: 1, scaleModeApplied: '1.0x' },
    recommendation: { model: 'unet', metrics: {} } as never,
    masks,
    workingGrains: computeAllGrainMorphometrics(masks, W, W, 2),
    excludeBorder: true,
    borderMargin: 2,
    calibration: { mmPerPx: MM_PER_PX, pointA: { x: 0, y: 0 }, pointB: { x: 1, y: 0 }, physicalLengthMm: MM_PER_PX, pixelDistance: 1 },
  });
  void rand;
  return { photoId: id, label: id, included: true, session, faciesWeight };
}

function sampler(seed: number, patch: number) {
  const rand = mulberry32(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  let k = 0;
  return () => photo(rand, gauss, Math.log(20) + patch * gauss(), `p${k++}`, 0.5 + rand());
}

const opts = (mode: PoolingMode, twoStage: boolean) => ({
  poolingMode: mode, bootstrapReplicates: 300, bootstrapTwoStage: twoStage, minBaxisPx: 15, harmonizeCutoff: false, wolmanPointsPerPhoto: 400,
});

it('site interval coverage by pooling mode', () => {
  const N = Number(process.env.COVERAGE_TRIALS ?? 150);
  const rows: string[] = [];
  const cases: Array<[PoolingMode, boolean]> = [
    ['physical-area', false], ['physical-area', true], ['equal-photo', false], ['number-weighted', false], ['facies-weighted', false], ['virtual-wolman-grid', false],
  ];
  for (const patch of [0.15, 0.3]) {
    for (const [mode, twoStage] of cases) {
      // Truth: the same estimator pooled over many photos.
      const big = sampler(77, patch);
      const truth = analyzeSite(Array.from({ length: 300 }, big), { ...opts(mode, false), bootstrapReplicates: 1 }).psd;
      const cells: string[] = [];
      for (const n of [3, 5, 10]) {
        const next = sampler(1000 + n, patch);
        let c50 = 0, c84 = 0;
        for (let t = 0; t < N; t++) {
          const r = analyzeSite(Array.from({ length: n }, next), opts(mode, twoStage));
          if (r.bootstrapCi.lower.D50 <= truth.D50 && truth.D50 <= r.bootstrapCi.upper.D50) c50++;
          if (r.bootstrapCi.lower.D84 <= truth.D84 && truth.D84 <= r.bootstrapCi.upper.D84) c84++;
        }
        cells.push(`${((100 * c50) / N).toFixed(0)}% / ${((100 * c84) / N).toFixed(0)}%`);
      }
      rows.push(`| ${mode}${twoStage ? ' (two-stage)' : ''} | ${patch.toFixed(2)} | ${cells.join(' | ')} |`);
    }
  }
  const table = ['| Pooling mode | Patch sd | 3 photos (D50 / D84) | 5 photos | 10 photos |', '| --- | ---: | ---: | ---: | ---: |', ...rows].join('\n');
  writeFileSync('validation/interval_coverage/site_interval_coverage_results.md', `${N} trials per cell, 300 bootstrap replicates; nominal 95%.\n\n${table}\n`);
  console.log(table);
});
