// Audit/perf: per-stage timing of the real engine inside headless Chromium (WASM backend),
// using the library build dist/index.js. Optional COOP/COEP headers enable WASM threads.
// Usage: node audit/perf/browser_stage_timing.mjs <unet.onnx> <rgba.raw> <w> <h> [--coi]
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';
const [model, raw, w, h, flag] = process.argv.slice(2);
const coi = flag === '--coi';
const DIST = resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/bench.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', ...(coi ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : {}) });
    return res.end('<!doctype html><title>bench</title>');
  }
  if (p === '/model.onnx') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(readFileSync(model)); }
  if (p === '/img.raw') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(readFileSync(raw)); }
  const f = normalize(join(DIST, p));
  if (!f.startsWith(DIST) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream', ...(coi ? { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' } : {}) });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--disable-features=WebGPU'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 200)); });
await page.goto(base + 'bench.html');
const result = await page.evaluate(async ({ W, H }) => {
  const lib = await import('./index.js');
  const marks = []; const t0 = performance.now();
  const modelBytes = new Uint8Array(await (await fetch('./model.onnx')).arrayBuffer());
  const rgba = new Uint8ClampedArray(await (await fetch('./img.raw')).arrayBuffer());
  const created = await lib.createInferenceSession(modelBytes, { wasmPaths: './ort/' });
  const engine = new lib.ImageGrainsEngine({
    sessionFactory: async () => created.session,
    workerFactory: () => new Worker('./workers/grainPostprocess.worker.js', { type: 'module' }),
  });
  await engine.initialize();
  let last = performance.now();
  engine.onProgress((stage) => {
    const now = performance.now();
    if (marks.length === 0 || marks[marks.length - 1].stage !== stage) { marks.push({ stage, startS: +((now - t0) / 1000).toFixed(2) }); }
    last = now;
  });
  const tA = performance.now();
  const session = await engine.analyzeImage({ data: rgba, width: W, height: H }, { model: 'unet', scaleMode: '1.0x' });
  return { crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, totalAnalyzeS: +((performance.now() - tA) / 1000).toFixed(2), grains: session.getResult().grainCount, stages: marks };
}, { W: Number(w), H: Number(h) });
console.log(JSON.stringify(result));
await browser.close(); server.close();
