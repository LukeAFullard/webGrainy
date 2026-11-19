#!/usr/bin/env node
/**
 * WebGPU vs CPU (WASM) parity check for the Cellpose inference pipeline, run in a real
 * browser with the app's own built code (dist/index.js).
 *
 * Background: in the Colab benchmark, ONNX Runtime's CUDA float16 backend diverged
 * from CPU/WASM on Cellpose-SAM tiles that include Cellpose's zero border. Browsers run
 * Cellpose-SAM on WebGPU, also in float16 (requires the `shader-f16` adapter feature),
 * so this checks whether WebGPU is affected.
 *
 * Cases (each through runUnetCellposeInference / runCpsamCellposeInference + the app's
 * post-processor), compared WebGPU vs WASM:
 *   photo        your photo (PHOTO=path.jpg|png) or a generated gravel image, 640x480
 *   one-tile     240x240: a single 256 px tile including the 8 px zero border
 *   small-padded 100x80: zero-padded up to 256 px (mostly zeros)
 *   all-black    256x256 of zeros after normalisation
 *
 * Reports per case: non-finite counts per backend, max/mean |diff| of flows and cell
 * probability, cell-probability sign agreement, grain count per backend, and mask
 * agreement (PQ between the WebGPU and WASM masks; 1.0 = identical).
 *
 * Usage (needs a machine with a WebGPU-capable GPU for the real test):
 *   npm run build
 *   MODEL=cpsam MODEL_PATH=/path/ig2_cpsam_fp16.onnx node validation/gpu/webgpu_vs_wasm.mjs
 *   MODEL=unet  MODEL_PATH=/path/ig2_unet_fp32.onnx  node validation/gpu/webgpu_vs_wasm.mjs
 * Optional: CASES=photo,one-tile,small-padded,all-black (subset), PHOTO=img.jpg, HEADED=1 (show the browser), CHROME=/path/to/chrome
 * (use your installed Chrome for best GPU support), SWIFTSHADER=1 (software WebGPU,
 * no float16; only for testing this script).
 * Writes validation/gpu/webgpu_vs_wasm_<model>.json
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const MODEL = process.env.MODEL ?? 'cpsam';
const MODEL_PATH = process.env.MODEL_PATH;
if (!MODEL_PATH || !existsSync(MODEL_PATH)) {
  console.error('Set MODEL_PATH to the downloaded ig2_cpsam_fp16.onnx or ig2_unet_fp32.onnx');
  process.exit(2);
}
const DIST = resolve('dist');
if (!existsSync(join(DIST, 'index.js'))) {
  console.error('dist/ not built: run `npm run build` first.');
  process.exit(2);
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const photoBytes = process.env.PHOTO ? readFileSync(process.env.PHOTO) : null;

const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/check.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>webgpu check</title>'); }
  if (p === '/model.onnx') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(readFileSync(MODEL_PATH)); }
  if (p === '/photo') { if (!photoBytes) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(photoBytes); }
  const f = normalize(join(DIST, p));
  if (!f.startsWith(DIST) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const args = ['--enable-unsafe-webgpu'];
if (process.env.SWIFTSHADER === '1') args.push('--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan');
const browser = await chromium.launch({
  headless: process.env.HEADED !== '1',
  args,
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
});
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
await page.goto(base + 'check.html');

const CASES = (process.env.CASES ?? 'photo,one-tile,small-padded,all-black').split(',');
const report = await page.evaluate(async ({ model, hasPhoto, cases }) => {
  const lib = await import('./index.js');
  const out = { model, browser: navigator.userAgent, cases: [] };
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  out.adapter = adapter
    ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, description: adapter.info?.description, shaderF16: adapter.features.has('shader-f16') }
    : null;
  if (!adapter) return { ...out, error: 'No WebGPU adapter available.' };
  const bytes = new Uint8Array(await (await fetch('./model.onnx')).arrayBuffer());

  const gpu = await lib.createInferenceSession(bytes, { wasmPaths: './ort/' });
  out.gpuSessionProvider = gpu.executionProvider;
  if (gpu.executionProvider !== 'webgpu') {
    out.warning = 'WebGPU session could not be created; the WebGPU side below actually ran on WASM.';
  }
  const cpu = await lib.createInferenceSession(bytes, { wasmPaths: './ort/', forceWasm: true });
  const run = model === 'unet' ? lib.runUnetCellposeInference : lib.runCpsamCellposeInference;

  async function makeImage(kind) {
    if (kind === 'photo' && hasPhoto) {
      const bmp = await createImageBitmap(await (await fetch('./photo')).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, bmp.width, bmp.height);
    }
    const [W, H] = kind === 'photo' ? [640, 480] : kind === 'one-tile' ? [240, 240] : kind === 'small-padded' ? [100, 80] : [256, 256];
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    if (kind !== 'all-black') {
      g.fillStyle = '#3a3630'; g.fillRect(0, 0, W, H);
      let s = 11; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const n = Math.round((W * H) / 900);
      for (let i = 0; i < n; i++) {
        const rad = 6 + r() * 18, x = r() * W, y = r() * H;
        const grd = g.createRadialGradient(x - rad / 3, y - rad / 3, 1, x, y, rad);
        const v = 140 + Math.floor(r() * 100);
        grd.addColorStop(0, `rgb(${v},${v - 6},${v - 18})`); grd.addColorStop(1, `rgb(${v - 70},${v - 75},${v - 85})`);
        g.fillStyle = grd; g.beginPath(); g.ellipse(x, y, rad, rad * (0.6 + r() * 0.35), r() * 3.14, 0, 6.29); g.fill();
      }
    }
    return g.getImageData(0, 0, W, H);
  }

  function pq(a, b) { // panoptic quality between two label images (IoU > 0.5 matching)
    const areaA = new Map(), areaB = new Map(), inter = new Map();
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x) areaA.set(x, (areaA.get(x) ?? 0) + 1);
      if (y) areaB.set(y, (areaB.get(y) ?? 0) + 1);
      if (x && y) { const k = x * 1e6 + y; inter.set(k, (inter.get(k) ?? 0) + 1); }
    }
    let sum = 0, tp = 0;
    for (const [k, v] of inter) {
      const x = Math.floor(k / 1e6), y = k % 1e6;
      const iou = v / (areaA.get(x) + areaB.get(y) - v);
      if (iou > 0.5) { sum += iou; tp++; }
    }
    const fp = areaB.size - tp, fn = areaA.size - tp;
    return tp + fp + fn === 0 ? 1 : sum / (tp + 0.5 * fp + 0.5 * fn);
  }

  for (const kind of cases) {
    const img = await makeImage(kind);
    const W = img.width, H = img.height, n = W * H;
    const rec = { case: kind, size: `${W}x${H}` };
    const res = {};
    for (const [name, s] of [['webgpu', gpu.session], ['wasm', cpu.session]]) {
      const t0 = performance.now();
      try {
        // bypass the app's plausibility guard here: we want to SEE invalid values
        res[name] = await run(s, img.data, W, H);
        rec[`${name}_seconds`] = +((performance.now() - t0) / 1000).toFixed(2);
      } catch (e) {
        rec[`${name}_error`] = String(e).slice(0, 300);
      }
    }
    if (res.webgpu && res.wasm) {
      const stat = (a, b) => {
        let maxD = 0, sumD = 0, nanA = 0, nanB = 0;
        for (let i = 0; i < a.length; i++) {
          if (!Number.isFinite(a[i])) { nanA++; continue; }
          if (!Number.isFinite(b[i])) { nanB++; continue; }
          const d = Math.abs(a[i] - b[i]); sumD += d; if (d > maxD) maxD = d;
        }
        return { maxAbsDiff: +maxD.toPrecision(4), meanAbsDiff: +(sumD / a.length).toPrecision(4), nonFiniteWebgpu: nanA, nonFiniteWasm: nanB };
      };
      rec.flowY = stat(res.webgpu.flowY, res.wasm.flowY);
      rec.flowX = stat(res.webgpu.flowX, res.wasm.flowX);
      rec.cellprob = stat(res.webgpu.cellprob, res.wasm.cellprob);
      let agree = 0;
      for (let i = 0; i < n; i++) if ((res.webgpu.cellprob[i] > 0) === (res.wasm.cellprob[i] > 0)) agree++;
      rec.cellprobSignAgreementPct = +((100 * agree) / n).toFixed(3);
      const mg = lib.flowsToMasksBrowser(res.webgpu.flowY, res.webgpu.flowX, res.webgpu.cellprob, W, H);
      const mw = lib.flowsToMasksBrowser(res.wasm.flowY, res.wasm.flowX, res.wasm.cellprob, W, H);
      rec.grainsWebgpu = mg.grainCount; rec.grainsWasm = mw.grainCount;
      rec.maskPQ_webgpu_vs_wasm = +pq(mw.masks, mg.masks).toFixed(4);
    }
    out.cases.push(rec);
  }
  return out;
}, { model: MODEL, hasPhoto: !!photoBytes, cases: CASES });

report.console = consoleLines.slice(0, 30);
await browser.close();
server.close();
const outPath = resolve(`validation/gpu/webgpu_vs_wasm_${MODEL}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`adapter: ${JSON.stringify(report.adapter)}  WebGPU session provider: ${report.gpuSessionProvider ?? '-'}`);
if (report.error) console.log('ERROR:', report.error);
if (report.warning) console.log('WARNING:', report.warning);
for (const c of report.cases ?? []) {
  if (c.webgpu_error || c.wasm_error) { console.log(`${c.case.padEnd(13)} ${c.size}  errors: webgpu=${c.webgpu_error ?? '-'} wasm=${c.wasm_error ?? '-'}`); continue; }
  console.log(`${c.case.padEnd(13)} ${c.size.padEnd(8)} time gpu/cpu ${c.webgpu_seconds}/${c.wasm_seconds} s | non-finite gpu ${c.cellprob.nonFiniteWebgpu + c.flowY.nonFiniteWebgpu + c.flowX.nonFiniteWebgpu} | max|diff| flow ${Math.max(c.flowY.maxAbsDiff, c.flowX.maxAbsDiff)} cellprob ${c.cellprob.maxAbsDiff} | sign agree ${c.cellprobSignAgreementPct}% | grains ${c.grainsWebgpu}/${c.grainsWasm} | mask PQ ${c.maskPQ_webgpu_vs_wasm}`);
}
console.log(`\nVerdict guide: mask PQ >= 0.95 and no non-finite values => WebGPU OK for this case.\nFull report: ${outPath}`);
