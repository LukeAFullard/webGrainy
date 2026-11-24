#!/usr/bin/env node
// Held-out benchmark with the app as shipped: the built engine (dist/) with the app's default
// analysis (upstream-exact Cellpose pipeline, Auto image scale, default post-processing,
// CPU/WASM) on the 40 test images of the ImageGrains 2.0 data, and the numbers the app itself
// reports for each photo (area-weighted b-axis D16/D50/D84 in photo px, interior grains,
// 15 px cutoff: session.getStats). Scored against the hand outlines by score_app_heldout.py.
//
//   npm run build
//   python3 -I validation/parity/fetch_ig2_files.py .cache/ig2 <image and mask paths from heldout_manifest.csv>
//   node validation/heldout/run_app_heldout.mjs unet          # or cpsam (INT8 weights, slow on CPU)
//   python3 -I validation/heldout/score_app_heldout.py         # needs numpy, scikit-image, pillow
//
// Writes .cache/heldout_app/<model>/<uid>.json (app stats) and <uid>.i32 (label mask resized to
// the photo with the app's own nearest-neighbour rule, as in its mask export).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as ort from 'onnxruntime-web';
import { chromium } from 'playwright';
import { ImageGrainsEngine, APP_VERSION } from '../../dist/index.js';
import { resizeLabelsNearest } from '../../dist/modules/exportFormats.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const kind = process.argv[2] === 'cpsam' ? 'cpsam' : 'unet';
const MODEL_REV = '98e76b1374dc22cfff8193aca71c308f2b4dd3b3';
const WEIGHTS = kind === 'unet'
  ? ['ig2_unet_fp32.onnx', '5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c']
  : ['ig2_cpsam_int8_wo_fp32scale.onnx', '2cda0be5b81f1d0c0ac36998beb9f741e11833aacd089c4f5cee92488bab6f43'];
const weightsPath = join(ROOT, '.cache', `${WEIGHTS[0].replace(/\.onnx$/, '')}.${MODEL_REV.slice(0, 8)}.onnx`);
if (!existsSync(weightsPath)) {
  const r = await fetch(`https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REV}/${WEIGHTS[0]}`);
  writeFileSync(weightsPath, Buffer.from(await r.arrayBuffer()));
}
if (createHash('sha256').update(readFileSync(weightsPath)).digest('hex') !== WEIGHTS[1]) throw new Error('model SHA-256 mismatch');

const rows = readFileSync(join(ROOT, 'validation/heldout/heldout_manifest.csv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split(',')).filter((c) => c[2] === 'test').map((c) => ({ uid: c[0], image: c[3] }));
const outDir = join(ROOT, '.cache', 'heldout_app', kind);
mkdirSync(outDir, { recursive: true });

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

ort.env.wasm.numThreads = Number(process.env.THREADS ?? 4);
const engine = new ImageGrainsEngine({
  useWorker: false,
  sessionFactory: async () => ort.InferenceSession.create(readFileSync(weightsPath), { executionProviders: ['wasm'] }),
});
await engine.initialize();
for (const [i, row] of rows.entries()) {
  const jsonPath = join(outDir, `${row.uid}.json`);
  if (existsSync(jsonPath)) continue; // resumable
  const img = await decode(join(ROOT, '.cache', 'ig2', row.image.replaceAll('/', '__'))); // fetch_ig2_files.py flattens paths
  const t0 = Date.now();
  const session = await engine.analyzeImage(img, { model: kind, cpsamWeights: 'int8', scaleMode: 'auto' });
  const stats = session.getStats('bAxis', { minBaxisPx: 15 });
  const wi = session.workingImage;
  const masks = resizeLabelsNearest(session.getWorkingMasks(), wi.width, wi.height, wi.originalWidth, wi.originalHeight);
  writeFileSync(join(outDir, `${row.uid}.i32`), Buffer.from(masks.buffer, masks.byteOffset, masks.byteLength));
  writeFileSync(jsonPath, JSON.stringify({
    uid: row.uid, appVersion: APP_VERSION, model: kind, width: wi.originalWidth, height: wi.originalHeight,
    effectiveScaleFactor: wi.effectiveScaleFactor, grains: stats.includedGrains, D16: stats.areaWeightedB.D16,
    D50: stats.areaWeightedB.D50, D84: stats.areaWeightedB.D84, seconds: (Date.now() - t0) / 1000,
  }));
  console.log(`${i + 1}/${rows.length} ${row.uid}: ${stats.includedGrains} grains, scale ${wi.effectiveScaleFactor.toFixed(2)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
await browser.close();
