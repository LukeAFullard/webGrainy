#!/usr/bin/env node
// K1 field comparison with the app as shipped: the built engine (dist/) with the app's default
// analysis settings (upstream-exact Cellpose pipeline, Auto image scale, default
// post-processing, Tidy outlines after analysis, WASM backend) and the app's own site statistics (analyzeSite with
// DEFAULT_SITE_OPTIONS), with and without a field-count cutoff. Replaces the earlier
// run_engine_k1.mjs + analyze_k1.py numbers, which used the legacy full-resolution pipeline
// and a separate Python percentile routine.
//
//   npm run build
//   node validation/k1/run_app_k1.mjs            # both models; MODELS=unet for U-Net only
//
// Inputs are downloaded once into .cache/ and checked by SHA-256: the two K1 photos and the
// field b-axis count (dmair1989/imagegrains demo data, BSD-3-Clause, pinned commit) and the
// pinned model weights. Photos are decoded in headless Chromium (createImageBitmap, as the
// app does, EXIF orientation applied). Writes validation/k1/k1_app_results.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as ort from 'onnxruntime-web';
import { chromium } from 'playwright';
import {
  ImageGrainsEngine,
  analyzeSite,
  DEFAULT_SITE_OPTIONS,
  ScaleCalibrator,
  weightedPsdPercentiles,
  APP_VERSION,
} from '../../dist/index.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const CACHE = join(ROOT, '.cache');
const COMMIT = '52c12bf7a6317f4c24408647d499cfe2cb6a6ea2';
const DEMO = `https://raw.githubusercontent.com/dmair1989/imagegrains/${COMMIT}/demo_data`;
const MODEL_REV = '98e76b1374dc22cfff8193aca71c308f2b4dd3b3';
const HF = `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REV}`;
const FILES = {
  'K1_C2_385.jpg': [`${DEMO}/K1/K1_C2_385.jpg`, 'a1c639254522a81806160b9ad1adf102559b8726024b1c02405da7b68cf27f8c'],
  'K1_C3_0449.jpg': [`${DEMO}/K1/K1_C3_0449.jpg`, '19e3efb0ddc48ce477a789b64d0588ee018274f4aaa5796059974c6413a11d10'],
  'K1_field_measurement.csv': [`${DEMO}/K1_field_measurement.csv`, '467898f631485d8021b2b80763ac27eb86cae8476d6985abfe77bc268dea2b8e'],
};
const WEIGHTS = {
  ig2_unet_fp32: ['ig2_unet_fp32.onnx', '5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c'],
  ig2_cpsam_int8_wo_fp32scale: ['ig2_cpsam_int8_wo_fp32scale.onnx', '2cda0be5b81f1d0c0ac36998beb9f741e11833aacd089c4f5cee92488bab6f43'],
};
const MM_PER_PX = 0.39; // scale of both photos, from the upstream demo notebook
const CUTOFFS = [0, 10, 13, 16]; // mm; 13 = smallest clast in the field count

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
async function cached(name, url, expected) {
  const path = join(CACHE, name);
  if (!existsSync(path)) {
    console.log(`downloading ${name}...`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  }
  const got = sha256(readFileSync(path));
  if (got !== expected) throw new Error(`${name}: SHA-256 ${got}, expected ${expected}`);
  return path;
}

// ---- inputs -------------------------------------------------------------------------------
const paths = {};
for (const [name, [url, sha]] of Object.entries(FILES)) paths[name] = await cached(join('k1', name), url, sha);
const fieldMm = readFileSync(paths['K1_field_measurement.csv'], 'utf8').trim().split(/\r?\n/).slice(1).map((l) => Number(l) * 10);

async function decode(path) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const b64 = readFileSync(path).toString('base64');
  const out = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    const px = c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
    let s = '';
    for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000));
    return { w: bmp.width, h: bmp.height, rgba: btoa(s) };
  }, b64);
  await browser.close();
  return { width: out.w, height: out.h, data: new Uint8ClampedArray(Buffer.from(out.rgba, 'base64')) };
}

// ---- run ------------------------------------------------------------------------------------
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 4);
const models = (process.env.MODELS ?? 'unet,cpsam').split(',');
const images = [await decode(paths['K1_C2_385.jpg']), await decode(paths['K1_C3_0449.jpg'])];
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '–');
const pctDiff = (v, f) => `${v >= f ? '+' : ''}${((100 * (v - f)) / f).toFixed(0)}%`;
const fieldNum = weightedPsdPercentiles(fieldMm, fieldMm.map(() => 1), [16, 50, 84]);
const lines = [
  `# K1 field comparison with the shipped app (webGrainy ${APP_VERSION})`,
  '',
  'Produced by `node validation/k1/run_app_k1.mjs` (see the script header). Both K1 demo photos, 0.39 mm/px,',
  'app default analysis (Cellpose pipeline, Auto image scale, default post-processing, Tidy outlines after analysis, CPU/WASM) and',
  'the app\'s site statistics (`analyzeSite`, default settings: area-weighted, b-axis, 15 px cutoff, harmonised',
  'detection limit, 95% interval with the few-photo correction).',
  '',
  `Field count: n = ${fieldMm.length} b-axes, smallest ${Math.min(...fieldMm).toFixed(0)} mm. D16 / D50 / D84 = ${fmt(fieldNum.D16)} / ${fmt(fieldNum.D50)} / ${fmt(fieldNum.D84)} mm`,
  '(each stone once, the app\'s percentile rule).',
  '',
  '| Model | Field-count cutoff | Photo grains counted | D16 | D50 (95% interval) | D84 | D50 vs field | D84 vs field |',
  '| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
];
for (const kind of models) {
  const modelId = kind === 'unet' ? 'ig2_unet_fp32' : 'ig2_cpsam_int8_wo_fp32scale';
  const [file, sha] = WEIGHTS[modelId];
  const weightsPath = await cached(`${file.replace(/\.onnx$/, '')}.${MODEL_REV.slice(0, 8)}.onnx`, `${HF}/${file}`, sha);
  const engine = new ImageGrainsEngine({
    useWorker: false,
    sessionFactory: async () => ort.InferenceSession.create(readFileSync(weightsPath), { executionProviders: ['wasm'] }),
  });
  await engine.initialize();
  const inputs = [];
  for (const [i, img] of images.entries()) {
    const t0 = Date.now();
    const session = await engine.analyzeImage(img, {
      model: kind,
      cpsamWeights: 'int8',
      scaleMode: 'auto',
      calibration: ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 100 * MM_PER_PX),
    });
    console.log(`${kind} photo ${i + 1}: ${session.getResult().grainCount} grains, working scale ${session.workingImage.effectiveScaleFactor.toFixed(3)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    inputs.push({ photoId: `k1_${i}`, label: i === 0 ? 'K1_C2_385' : 'K1_C3_0449', included: true, session });
  }
  for (const cut of CUTOFFS) {
    const r = analyzeSite(inputs, { ...DEFAULT_SITE_OPTIONS, minSizeMm: cut });
    lines.push(`| ${kind === 'unet' ? 'U-Net' : 'Cellpose-SAM (INT8)'} | ${cut > 0 ? `${cut} mm` : `none (limit ${fmt(r.dCutoffCommonMm ?? 0)} mm)`} | ${r.validGrainCount} | ${fmt(r.psd.D16)} | ${fmt(r.psd.D50)} (${fmt(r.bootstrapCi.lower.D50)}–${fmt(r.bootstrapCi.upper.D50)}) | ${fmt(r.psd.D84)} | ${pctDiff(r.psd.D50, fieldNum.D50)} | ${pctDiff(r.psd.D84, fieldNum.D84)} |`);
  }
}
lines.push(
  '',
  'Caveats: one site and two photos, both of which overlap the ImageGrains training data (a consistency',
  'check, not an independent validation); the cutoff is the smallest clast in the field data, not a',
  'documented protocol; with 2 photos the interval is wide by design (t with 1 degree of freedom).',
  '',
);
writeFileSync(join(ROOT, 'validation', 'k1', 'k1_app_results.md'), lines.join('\n'));
console.log(lines.join('\n'));
