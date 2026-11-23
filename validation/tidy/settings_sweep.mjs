#!/usr/bin/env node
// Which analysis settings reduce the stray "specks" (detached grain fragments) that Tidy outlines
// cleans up, and at what cost? Runs the app's analysis of the 40 held-out ImageGrains 2.0 test
// images with the default settings and with one setting changed at a time, before and after Tidy,
// and scores outline agreement (PQ) and D50 error against the hand outlines, and counts fragments.
// Model outputs are cached per image, so settings that change only post-processing reuse one
// inference.
//
//   npm run build
//   node validation/tidy/settings_sweep.mjs unet        # MAX_MINUTES=<n> stops early; run again to continue
//
// Per-image results: .cache/sweep_<model>/<uid>.json; summary: validation/tidy/settings_sweep_<model>.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as ort from 'onnxruntime-web';
import { chromium } from 'playwright';
import UTIF from 'utif2';
import { ImageGrainsEngine, computeAllGrainMorphometrics, computeSedimentStats } from '../../dist/index.js';
import { resizeLabelsNearest } from '../../dist/modules/exportFormats.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const kind = process.argv[2] === 'cpsam' ? 'cpsam' : 'unet';
const weightsPath = join(ROOT, '.cache', kind === 'unet' ? 'ig2_unet_fp32.98e76b13.onnx' : 'ig2_cpsam_int8_wo_fp32scale.98e76b13.onnx');
const OUTDIR = join(ROOT, '.cache', `sweep_${kind}`);
mkdirSync(OUTDIR, { recursive: true });
const MAX_MS = Number(process.env.MAX_MINUTES ?? Infinity) * 60_000;
const t0 = Date.now();

const CONFIGS = {
  default: {},
  cellprob_m0p5: { postProcess: { cellprobThreshold: -0.5 } },
  cellprob_0p5: { postProcess: { cellprobThreshold: 0.5 } },
  cellprob_1: { postProcess: { cellprobThreshold: 1.0 } },
  flow_0p3: { postProcess: { flowThreshold: 0.3 } },
  flow_0p6: { postProcess: { flowThreshold: 0.6 } },
  seed_4: { postProcess: { minSeedDensity: 4 } },
  niter_400: { postProcess: { niter: 400 } },
  minsize_60: { postProcess: { minSize: 60 } },
  full_res: { scaleMode: '1.0x' },
  enlarge_1p5: { fineGrainUpscale: 1.5 },
};
const ONLY = process.env.CONFIGS ? process.env.CONFIGS.split(',') : Object.keys(CONFIGS);

const rows = readFileSync(join(ROOT, 'validation/heldout/heldout_manifest.csv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split(',')).filter((c) => c[2] === 'test').map((c) => ({ uid: c[0], site: c[1], image: c[3], mask: c[4] }));
const local = (p) => join(ROOT, '.cache', 'ig2', p.replaceAll('/', '__'));

const browser = await chromium.launch();
const page = await browser.newPage();
async function decode(path) {
  const out = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    const px = c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
    let s = '';
    for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000));
    return { w: bmp.width, h: bmp.height, rgba: btoa(s) };
  }, readFileSync(path).toString('base64'));
  return { width: out.w, height: out.h, data: new Uint8ClampedArray(Buffer.from(out.rgba, 'base64')) };
}
function readMask(path) {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ifd = UTIF.decode(ab)[0];
  UTIF.decodeImage(ab, ifd);
  const w = ifd.width, h = ifd.height, bps = ifd.t258?.[0] ?? 8, d = ifd.data;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const little = new Uint8Array(ab)[0] === 0x49;
  const out = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = bps === 8 ? d[i] : bps === 16 ? dv.getUint16(i * 2, little) : dv.getUint32(i * 4, little);
  return { w, h, labels: out };
}
function pq(gt, pred) {
  const area = (m) => { const a = new Map(); for (const v of m) if (v > 0) a.set(v, (a.get(v) ?? 0) + 1); return a; };
  const ag = area(gt), ap = area(pred);
  const inter = new Map();
  for (let i = 0; i < gt.length; i++) if (gt[i] > 0 && pred[i] > 0) { const k = gt[i] * 4294967296 + pred[i]; inter.set(k, (inter.get(k) ?? 0) + 1); }
  let tp = 0, iouSum = 0;
  for (const [k, n] of inter) {
    const g = Math.floor(k / 4294967296), p = k - g * 4294967296;
    const iou = n / (ag.get(g) + ap.get(p) - n);
    if (iou > 0.5) { tp++; iouSum += iou; }
  }
  const fp = ap.size - tp, fn = ag.size - tp;
  return { pq: tp + fp + fn === 0 ? 1 : iouSum / (tp + 0.5 * fp + 0.5 * fn), tp, fp, fn };
}
const d50 = (grains) => computeSedimentStats(grains, { excludeBorder: true, sizeMetric: 'bAxis', minBaxisPx: 15 }).areaWeightedB.D50;
const err = (a, g) => (Number.isFinite(a) && Number.isFinite(g) && g > 0 ? (Math.abs(a - g) / g) * 100 : NaN);
function multipart(masks, w) {
  const parts = new Map();
  const seen = new Uint8Array(masks.length);
  for (let s = 0; s < masks.length; s++) {
    const l = masks[s];
    if (l <= 0 || seen[s]) continue;
    parts.set(l, (parts.get(l) ?? 0) + 1);
    const q = [s]; seen[s] = 1;
    while (q.length) { const p = q.pop(); const x = p % w; for (const n of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (n >= 0 && n < masks.length && !seen[n] && masks[n] === l) { seen[n] = 1; q.push(n); } }
  }
  let mp = 0, extra = 0;
  for (const n of parts.values()) if (n > 1) { mp++; extra += n - 1; }
  return { multipart: mp, fragments: extra };
}

// Caching session: identical tile inputs (same image, same scale) return the cached outputs.
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 4);
const real = await ort.InferenceSession.create(readFileSync(weightsPath), { executionProviders: ['wasm'] });
let cache = new Map();
let inferences = 0;
const session = {
  inputNames: real.inputNames, outputNames: real.outputNames,
  async run(feeds, opts) {
    const h = createHash('sha1');
    for (const k of Object.keys(feeds).sort()) { const t = feeds[k]; h.update(k); h.update(String(t.dims)); h.update(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)); }
    const key = h.digest('hex');
    const hit = cache.get(key);
    if (hit) return hit;
    inferences++;
    const out = await real.run(feeds, opts);
    const copy = {};
    for (const [k, v] of Object.entries(out)) copy[k] = new ort.Tensor(v.type, v.data.slice(), v.dims);
    cache.set(key, copy);
    return copy;
  },
  async release() {},
};
const engine = new ImageGrainsEngine({ useWorker: false, sessionFactory: async () => session });
await engine.initialize();

for (const [i, row] of rows.entries()) {
  const file = join(OUTDIR, `${row.uid}.json`);
  const done = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const todo = ONLY.filter((c) => !(c in done));
  if (!todo.length) continue;
  if (Date.now() - t0 > MAX_MS) { console.log('Stopped (time); run again to continue.'); break; }
  cache = new Map();
  const img = await decode(local(row.image));
  const gt = readMask(local(row.mask));
  const gtD50 = d50(computeAllGrainMorphometrics(gt.labels, gt.w, gt.h, 2));
  for (const c of todo) {
    const t1 = Date.now();
    const s = await engine.analyzeImage(img, { model: kind, cpsamWeights: 'int8', scaleMode: 'auto', ...CONFIGS[c] });
    const wi = s.workingImage;
    const atPhoto = () => resizeLabelsNearest(s.getWorkingMasks(), wi.width, wi.height, wi.originalWidth, wi.originalHeight);
    const mp = multipart(s.getWorkingMasks(), wi.width);
    const b = { ...pq(gt.labels, atPhoto()), d50err: err(s.getStats('bAxis', { minBaxisPx: 15 }).areaWeightedB.D50, gtD50), grains: s.getResult().grainCount, ...mp };
    s.tidyOutlines();
    const a = { ...pq(gt.labels, atPhoto()), d50err: err(s.getStats('bAxis', { minBaxisPx: 15 }).areaWeightedB.D50, gtD50), grains: s.getResult().grainCount };
    done[c] = { before: b, after: a, workW: wi.width, sec: (Date.now() - t1) / 1000 };
    writeFileSync(file, JSON.stringify(done));
  }
  const d = done.default;
  console.log(`${i + 1}/${rows.length} ${row.uid} (${inferences} tile runs so far): default PQ ${d?.before.pq.toFixed(3)} frags ${d?.before.fragments}; ` +
    todo.map((c) => `${c} ${done[c].before.pq.toFixed(3)}/${done[c].before.fragments}`).join(', '));
}
await browser.close();

// Summary, once every image has every setting.
const all = rows.map((r) => join(OUTDIR, `${r.uid}.json`)).filter(existsSync).map((f) => JSON.parse(readFileSync(f, 'utf8')));
if (all.length === rows.length && all.every((d) => ONLY.every((c) => c in d))) {
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const median = (v) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const LABEL = {
    default: 'Defaults', cellprob_m0p5: 'Cellprob threshold −0.5', cellprob_0p5: 'Cellprob threshold +0.5', cellprob_1: 'Cellprob threshold +1',
    flow_0p3: 'Flow threshold 0.3', flow_0p6: 'Flow threshold 0.6', seed_4: 'Seed density 4', niter_400: 'Flow steps 400',
    minsize_60: 'Min size 60 px²', full_res: 'Image scale 1.0x Full', enlarge_1p5: 'Enlarge ×1.5',
  };
  const lines = [
    `# Settings and stray fragments (${kind === 'unet' ? 'U-Net' : 'Cellpose-SAM INT8'})`,
    '',
    'The 40 held-out test images of the ImageGrains 2.0 data, analysed with the defaults and with one setting changed at a time,',
    'then with **Tidy outlines**. Fragments: extra 4-connected pieces of grains (each grain should be one piece); PQ: outline',
    'agreement with the hand outlines (IoU > 0.5); D50 error: area-weighted b-axis D50 (interior grains, 15 px cutoff) against the',
    'hand outlines. Photos better / worse: PQ changed by more than 0.005 against the defaults. Produced by',
    '`validation/tidy/settings_sweep.mjs`.',
    '',
    '| Setting | Mean PQ | Mean PQ after Tidy | Median D50 error | Mean D50 error | Fragments | Grains in pieces | Grains | Photos better / worse (PQ) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const c of ONLY) {
    const r = all.map((d) => d[c]);
    const b = all.filter((d) => d[c].before.pq > d.default.before.pq + 0.005).length;
    const w = all.filter((d) => d[c].before.pq < d.default.before.pq - 0.005).length;
    lines.push(`| ${LABEL[c] ?? c} | ${mean(r.map((x) => x.before.pq)).toFixed(3)} | ${mean(r.map((x) => x.after.pq)).toFixed(3)} | ${median(r.map((x) => x.before.d50err)).toFixed(1)}% | ${mean(r.map((x) => x.before.d50err)).toFixed(1)}% | ${r.reduce((a, x) => a + x.before.fragments, 0)} | ${r.reduce((a, x) => a + x.before.multipart, 0)} | ${r.reduce((a, x) => a + x.before.grains, 0)} | ${c === 'default' ? '–' : `${b} / ${w}`} |`);
  }
  const big = all.filter((d) => d.full_res && d.full_res.workW !== d.default.workW).length;
  lines.push('', `*Image scale 1.0x Full* differs from *Auto* only for photos larger than 1024 px: ${big} of the 40 test images.`, '');
  writeFileSync(join(ROOT, 'validation', 'tidy', `settings_sweep_${kind}.md`), lines.join('\n'));
  console.log(`Wrote validation/tidy/settings_sweep_${kind}.md`);
}
