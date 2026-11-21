#!/usr/bin/env node
// How much larger the min-Feret D50 is than the b-axis D50 on the held-out photos (the figure in
// the size-metric help and the settings guide). Uses the app's own label masks from
// run_app_heldout.mjs (.cache/heldout_app/<model>/*.i32) and the built app (npm run build):
// area-weighted D50 of interior grains, 15 px cutoff, as the app reports it.
//
//   node validation/heldout/feret_ratio.mjs        # writes validation/heldout/feret_ratio_results.md
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AnalysisSession } from '../../dist/index.js';
import { computeAllGrainMorphometrics } from '../../dist/modules/interactiveEditor.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const rows = [];
for (const model of ['unet', 'cpsam']) {
  const dir = join(ROOT, '.cache', 'heldout_app', model);
  if (!existsSync(dir)) continue;
  const ratios = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const buf = readFileSync(join(dir, f.replace(/\.json$/, '.i32')));
    const masks = new Int32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const { width: w, height: h } = j;
    const s = new AnalysisSession({
      workingImage: { data: new Uint8ClampedArray(0), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: '1.0x' },
      recommendation: { model, metrics: {} },
      masks,
      workingGrains: computeAllGrainMorphometrics(masks, w, h, 2),
      excludeBorder: true,
      borderMargin: 2,
    });
    const b = s.getStats('bAxis', { minBaxisPx: 15 }).areaWeightedB.D50;
    const fr = s.getStats('minFeret', { minBaxisPx: 15 });
    const m = (fr.areaWeightedMinFeret ?? fr.areaWeightedB).D50;
    if (Number.isFinite(b) && Number.isFinite(m) && b > 0) ratios.push(m / b);
  }
  if (ratios.length === 0) continue;
  ratios.sort((a, b) => a - b);
  const q = (p) => ratios[Math.round(p * (ratios.length - 1))];
  const pct = (r) => `${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)}%`;
  rows.push(`| ${model === 'unet' ? 'U-Net' : 'Cellpose-SAM (INT8)'} | ${ratios.length} | ${pct(q(0.5))} | ${pct(q(0.25))} to ${pct(q(0.75))} | ${pct(ratios[0])} to ${pct(ratios.at(-1))} |`);
}
const md = [
  '# min-Feret vs b-axis D50 on the held-out photos',
  '',
  'Area-weighted D50 of interior grains (15 px cutoff) measured as minimum Feret width, relative to the',
  'moment-ellipse b-axis D50 of the same grains, on the app\'s own outlines of the 40 held-out test photos.',
  'Produced by `feret_ratio.mjs` from the masks written by `run_app_heldout.mjs`.',
  '',
  '| Model | Photos | Median difference | Middle half | Range |',
  '| --- | ---: | ---: | --- | --- |',
  ...rows,
  '',
].join('\n');
writeFileSync(join(ROOT, 'validation/heldout/feret_ratio_results.md'), md);
console.log(md);
