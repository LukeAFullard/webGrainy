/**
 * Coverage of the site interval on beds that vary more than site_interval_coverage.audit.ts
 * assumes (pre-publication audit S5).
 *
 * Every photo covers the same footprint, so fine patches give many more grains than coarse ones,
 * and the within-photo sorting varies between photos (ln sd 0.45-0.85). Two beds:
 * - "variable sorting": photo medians vary with patch sd 0.3;
 * - "outlier patches": as above, but 10% of photos are of a patch 3x coarser;
 * - "strong contrasts": outlier patches and patch sd 0.5, so grain counts per photo differ most.
 * Grains are drawn as squares into a real label mask, as in the other coverage script. The truth
 * for each mode is that mode's estimate pooled over 300 photos of the same bed.
 *
 * Run: npx vitest run --config validation/interval_coverage/vitest.config.ts variable_bed
 * (COVERAGE_TRIALS sets trials per cell, default 150; writes variable_bed_coverage_results.md.)
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { AnalysisSession } from '../../src/modules/analysisSession';
import { computeAllGrainMorphometrics } from '../../src/modules/interactiveEditor';
import { analyzeSite, type PoolingMode, type SitePhotoInput } from '../../src/modules/siteAnalysis';
import { mulberry32 } from '../../src/modules/siteUncertainty';

const W = 600;
const MM_PER_PX = 0.5;

function photo(gauss: () => number, m: number, sd: number, id: string): SitePhotoInput {
  const masks = new Int32Array(W * W);
  let x0 = 4, y0 = 4, rowH = 0, gid = 1;
  for (;;) {
    const sidePx = Math.min(200, Math.max(4, Math.round(Math.exp(m + sd * gauss()) / MM_PER_PX / 1.155)));
    if (x0 + sidePx + 4 > W) { x0 = 4; y0 += rowH + 4; rowH = 0; }
    if (y0 + sidePx + 4 > W) break;
    for (let y = y0; y < y0 + sidePx; y++) masks.fill(gid, y * W + x0, y * W + x0 + sidePx);
    gid++; x0 += sidePx + 4; rowH = Math.max(rowH, sidePx);
    if (gid > 6000) break;
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
  return { photoId: id, label: id, included: true, session };
}

type Bed = 'variable sorting' | 'outlier patches' | 'strong contrasts';

function sampler(seed: number, bed: Bed) {
  const rand = mulberry32(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  let k = 0;
  return () => {
    const outlier = bed !== 'variable sorting' && rand() < 0.1;
    const m = Math.log(12) + (outlier ? Math.log(3) : 0) + (bed === 'strong contrasts' ? 0.5 : 0.3) * gauss();
    return photo(gauss, m, 0.45 + 0.4 * rand(), `p${k++}`);
  };
}

const opts = (mode: PoolingMode) => ({
  poolingMode: mode, bootstrapReplicates: 300, minBaxisPx: 15, harmonizeCutoff: false,
});

it('site interval coverage on variable beds', () => {
  const N = Number(process.env.COVERAGE_TRIALS ?? 150);
  const rows: string[] = [];
  for (const bed of ['variable sorting', 'outlier patches', 'strong contrasts'] as const) {
    for (const mode of ['physical-area', 'number-weighted'] as const) {
      const truth = analyzeSite(Array.from({ length: 300 }, sampler(77, bed)), { ...opts(mode), bootstrapReplicates: 1 }).psd;
      const cells: string[] = [];
      for (const n of [5, 10, 20]) {
        const next = sampler(2000 + n + { 'variable sorting': 0, 'outlier patches': 500, 'strong contrasts': 900 }[bed], bed);
        const c = { D16: 0, D50: 0, D84: 0 };
        for (let t = 0; t < N; t++) {
          const r = analyzeSite(Array.from({ length: n }, next), opts(mode));
          for (const k of ['D16', 'D50', 'D84'] as const) {
            if (r.bootstrapCi.lower[k] <= truth[k] && truth[k] <= r.bootstrapCi.upper[k]) c[k]++;
          }
        }
        const pct = (v: number) => `${((100 * v) / N).toFixed(0)}%`;
        cells.push(`${pct(c.D16)} / ${pct(c.D50)} / ${pct(c.D84)}`);
      }
      rows.push(`| ${bed} | ${mode} | ${cells.join(' | ')} |`);
    }
  }
  const table = [
    '| Bed | Pooling mode | 5 photos (D16 / D50 / D84) | 10 photos | 20 photos |',
    '| --- | --- | ---: | ---: | ---: |',
    ...rows,
  ].join('\n');
  writeFileSync(
    'validation/interval_coverage/variable_bed_coverage_results.md',
    `${N} trials per cell, 300 bootstrap replicates; nominal 95%. Fixed photo footprint, within-photo ln sd 0.45-0.85, patch sd 0.3 (0.5 for strong contrasts); outlier patches: 10% of photos 3x coarser.\n\n${table}\n`,
  );
  console.log(table);
});
