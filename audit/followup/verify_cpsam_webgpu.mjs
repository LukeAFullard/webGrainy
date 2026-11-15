#!/usr/bin/env node
/**
 * Ready-to-run Playwright verification script for ig2_cpsam_fp16.onnx on a real
 * WebGPU `shader-f16` host (modeled on scripts/smoke-dist.mjs).
 *
 * Measures:
 *   - WebGPU adapter availability & `shader-f16` feature support
 *   - Model download/cache behavior (pinned commit 7773328a, SHA-256 verified)
 *   - Peak JS heap / memory metrics via performance.memory (when exposed)
 *   - Inference + post-processing wall time (vs 13-16 s/image claim)
 *   - `device.lost` / console error behavior
 *   - Optional comparison against Python ONNX Runtime tile reference JSON
 *
 * Usage:
 *   npm run build
 *   node audit/followup/verify_cpsam_webgpu.mjs
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const DIST = resolve('dist');
const MODEL_REVISION = '7773328a544ac050b7820667e68cbfb02a2e954a';
const CPSAM_SHA256 = '944a114a0cb1a3a215c11affefe7211caac6da2b74895c496d5a7b5a23b6230d';
const CPSAM_URL = `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REVISION}/ig2_cpsam_fp16.onnx`;
const TIMEOUT_MS = Number(process.env.CPSAM_TIMEOUT_MS ?? 10 * 60 * 1000);
const OUT_PATH = resolve('audit/followup/cpsam_webgpu_results.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

function fail(msg) {
  console.error(`CPSAM WEBGPU VERIFY FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist/ not built; run `npm run build` first.');
}

async function getCpsamBytes() {
  let bytes;
  if (process.env.MODEL_PATH) {
    bytes = readFileSync(process.env.MODEL_PATH);
  } else {
    const cacheDir = resolve('.cache');
    const cached = join(cacheDir, `ig2_cpsam_fp16.${MODEL_REVISION.slice(0, 8)}.onnx`);
    if (existsSync(cached)) {
      bytes = readFileSync(cached);
    } else {
      console.log(`Downloading pinned CP-SAM FP16 (${MODEL_REVISION.slice(0, 8)})...`);
      const r = await fetch(CPSAM_URL);
      if (!r.ok) fail(`CP-SAM download HTTP ${r.status}`);
      bytes = Buffer.from(await r.arrayBuffer());
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cached, bytes);
    }
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== CPSAM_SHA256) fail(`CP-SAM SHA-256 mismatch: ${sha}`);
  return bytes;
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(DIST, urlPath));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (urlPath.endsWith('/')) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// Launch Chromium WITH WebGPU enabled (do not pass --disable-features=WebGPU).
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const httpErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('response', (r) => {
  if (r.status() >= 400) httpErrors.push(`HTTP ${r.status()} ${r.url()}`);
});

const report = {
  timestamp: new Date().toISOString(),
  webgpu: null,
  downloadMs: null,
  inferenceAndPostprocessMs: null,
  peakJsHeapBytes: null,
  grainCount: null,
  d50Px: null,
  footer: null,
  deviceLostObserved: false,
  consoleErrors,
  pageErrors,
  httpErrors,
  referenceComparison: null,
};

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('#photo-file-input', { state: 'attached', timeout: 30000 });

  // Probe WebGPU adapter + shader-f16 + attach device.lost observer.
  const gpuProbe = await page.evaluate(async () => {
    if (!navigator.gpu) return { hasNavigatorGpu: false };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { hasNavigatorGpu: true, hasAdapter: false };
    const hasShaderF16 = adapter.features.has('shader-f16');
    const info = adapter.info ?? {};
    let deviceLostReason = null;
    try {
      const dev = await adapter.requestDevice(
        hasShaderF16 ? { requiredFeatures: ['shader-f16'] } : {},
      );
      dev.lost.then((lostInfo) => {
        window.__webgpuDeviceLost = lostInfo?.reason ?? 'lost';
      });
    } catch (e) {
      deviceLostReason = String(e);
    }
    return {
      hasNavigatorGpu: true,
      hasAdapter: true,
      hasShaderF16,
      vendor: info.vendor ?? null,
      architecture: info.architecture ?? null,
      deviceLostReason,
    };
  });
  report.webgpu = gpuProbe;
  console.log('WebGPU probe:', JSON.stringify(gpuProbe));

  if (!gpuProbe.hasAdapter || !gpuProbe.hasShaderF16) {
    console.warn('WebGPU adapter or shader-f16 is unavailable on this host; skipping live CP-SAM run.');
    writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    process.exit(gpuProbe.hasAdapter ? 2 : 3);
  }

  const modelBytes = await getCpsamBytes();
  const dlStart = Date.now();
  await page.route('https://huggingface.co/**', (route) => {
    return route.fulfill({
      status: 200,
      body: modelBytes,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(modelBytes.length),
        'access-control-allow-origin': '*',
      },
    });
  });

  // Generate synthetic 512x512 gravel test image (exercises 4+ overlapping 256x256 tiles).
  const pngB64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(512, 512);
    const g = c.getContext('2d');
    g.fillStyle = '#3a3630';
    g.fillRect(0, 0, 512, 512);
    let seed = 13;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 140; i++) {
      const r = 10 + rnd() * 20;
      const x = r + rnd() * (512 - 2 * r);
      const y = r + rnd() * (512 - 2 * r);
      const grad = g.createRadialGradient(x - r / 3, y - r / 3, 1, x, y, r);
      const v = 150 + Math.floor(rnd() * 90);
      grad.addColorStop(0, `rgb(${v},${v - 8},${v - 20})`);
      grad.addColorStop(1, `rgb(${v - 70},${v - 76},${v - 86})`);
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(x, y, r, r * (0.6 + rnd() * 0.35), rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of buf) s += String.fromCharCode(b);
    return btoa(s);
  });

  await page.setInputFiles('#photo-file-input', {
    name: 'cpsam_512.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngB64, 'base64'),
  });
  await page.waitForSelector('.photo-item', { timeout: 30000 });
  await page.selectOption('select[data-param="model"]', 'cpsam');
  const tStart = Date.now();
  await page.click('button[data-action="run-active"]');

  let peakHeap = 0;
  const memSampler = setInterval(async () => {
    try {
      const h = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
      if (h > peakHeap) peakHeap = h;
    } catch {
      // ignore if page navigated/closed
    }
  }, 250);

  await page.waitForFunction(
    () => /Batch complete|Batch error|Batch cancelled/.test(document.body.innerText),
    null,
    { timeout: TIMEOUT_MS, polling: 1000 },
  );
  clearInterval(memSampler);

  report.inferenceAndPostprocessMs = Date.now() - tStart;
  report.downloadMs = Date.now() - dlStart - report.inferenceAndPostprocessMs;
  report.peakJsHeapBytes = peakHeap || null;
  report.footer = await page.evaluate(() => document.body.innerText.match(/Batch[^\n]*/)?.[0] ?? '');
  report.deviceLostObserved = await page.evaluate(() => Boolean(window.__webgpuDeviceLost));

  await page.click('[data-scope="photo"]');
  await page.waitForTimeout(500);
  const bodyText = await page.evaluate(() => document.body.innerText);
  report.grainCount = Number(bodyText.match(/n = (\d+)/)?.[1] ?? '0');
  const d50Match = bodyText.match(/D50[^0-9]*([0-9]+(?:\.[0-9]+)?)/);
  report.d50Px = d50Match ? Number(d50Match[1]) : null;

  if (process.env.REFERENCE_TILES_JSON && existsSync(process.env.REFERENCE_TILES_JSON)) {
    const ref = JSON.parse(readFileSync(process.env.REFERENCE_TILES_JSON, 'utf8'));
    report.referenceComparison = {
      refGrainCount: ref.grainCount ?? null,
      refD50Px: ref.d50Px ?? null,
      deltaGrainCount: ref.grainCount != null ? report.grainCount - ref.grainCount : null,
      deltaD50Px: ref.d50Px != null && report.d50Px != null ? report.d50Px - ref.d50Px : null,
    };
  }

  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log('Report written to', OUT_PATH);
  if (!/1 done, 0 failed/.test(report.footer) || report.grainCount <= 0) {
    fail(`CP-SAM run did not succeed: ${report.footer}`);
  }
} finally {
  await browser.close();
  server.close();
}
