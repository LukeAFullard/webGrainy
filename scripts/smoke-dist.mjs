#!/usr/bin/env node
// Browser smoke test of the BUILT app (dist/): the integration check that unit tests cannot
// replace (asset paths, service worker, ONNX Runtime loading, workers).
//
//   1. Serves dist/ on a local port and checks every service-worker precache asset is 200.
//   2. Loads the app headless and fails on any console error / HTTP >= 400 / CSP violation.
//   3. Unless SMOKE_SKIP_INFERENCE=1: obtains the pinned U-Net weights (MODEL_PATH, or
//      downloads the pinned revision and verifies SHA-256), serves them in place of the
//      Hugging Face URL, analyses a generated test image with the WASM backend, and
//      requires the photo to finish "done" with > 0 grains.
//   5. Imports a hostile project file (markup in every stored text field) into a fresh page
//      and fails if the page navigates away or any injected element appears.
//   4. Records main-thread long tasks during the analysis and fails if any is longer than
//      SMOKE_MAX_LONGTASK_MS (default 5000): CPU inference must run in the worker.
//
// SMOKE_MODEL=cpsam runs Cellpose-SAM (INT8 weights, 316 MB) on a small image instead of
// U-Net. Weights are served by the local server (a 302 from the Hugging Face URL), because
// passing a body that large through Playwright's protocol crashes the browser.
//
// Usage: npm run build && npm run test:e2e:browser
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const DIST = resolve('dist');
const MODEL_REVISION = '98e76b1374dc22cfff8193aca71c308f2b4dd3b3';
const MODELS = {
  unet: { file: 'ig2_unet_fp32.onnx', sha256: '5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c', select: 'unet' },
  cpsam: { file: 'ig2_cpsam_int8_wo_fp32scale.onnx', sha256: '2cda0be5b81f1d0c0ac36998beb9f741e11833aacd089c4f5cee92488bab6f43', select: 'cpsam', weights: 'int8' },
};
const SMOKE_MODEL = process.env.SMOKE_MODEL === 'cpsam' ? 'cpsam' : 'unet';
const M = MODELS[SMOKE_MODEL];
const MODEL_URL = `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REVISION}/${M.file}`;
const MAX_LONGTASK_MS = Number(process.env.SMOKE_MAX_LONGTASK_MS ?? 5000);
// Smaller image for Cellpose-SAM (several seconds per tile on a CPU).
const IMG = SMOKE_MODEL === 'cpsam' ? { w: 400, h: 300, n: 60, r0: 10, dr: 16 } : { w: 384, h: 288, n: 70, r0: 8, dr: 16 };
let modelFile = null;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15 * 60 * 1000);

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
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(join(DIST, 'index.html'))) fail('dist/ not built; run `npm run build` first.');

const server = createServer((req, res) => {
  if (req.url.startsWith('/__smoke_model') && modelFile) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(statSync(modelFile).size),
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(modelFile).pipe(res);
    return;
  }
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
console.log(`serving dist/ at ${base}`);

// 1. Precache assets declared by the stamped service worker must all exist.
const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
if (sw.includes('__WEBGRAINY_')) fail('dist/sw.js has unreplaced placeholders.');
const lists = [...sw.matchAll(/const (?:SHELL|ORT)_ASSETS = (\[[^\]]*\]);/g)].map((m) => JSON.parse(m[1]));
for (const asset of lists.flat()) {
  const r = await fetch(new URL(asset, base));
  if (!r.ok) fail(`precache asset ${asset} -> HTTP ${r.status}`);
}
console.log(`ok: ${lists.flat().length} precache assets reachable`);

// 1b. The build must stamp the source commit (every export records it as appCommit).
const mainJs = readFileSync(join(DIST, 'ui', 'main.js'), 'utf8');
const commit = mainJs.match(/BUILD_COMMIT = (?:true \? )?"([^"]*)"/)?.[1] ?? null;
if (mainJs.includes('__BUILD_COMMIT__') || commit === null || !/^[0-9a-f]{7,40}(-modified)?$/.test(commit)) {
  fail(`build commit not stamped into dist/ui/main.js (found ${commit})`);
}
console.log(`ok: build stamped with commit ${commit}`);

/** Path of the SHA-256-verified pinned weights (MODEL_PATH, or downloaded into .cache/). */
async function getModelFile() {
  let path = process.env.MODEL_PATH;
  if (!path) {
    const cacheDir = resolve('.cache');
    path = join(cacheDir, `${M.file.replace(/\.onnx$/, '')}.${MODEL_REVISION.slice(0, 8)}.onnx`);
    if (!existsSync(path)) {
      console.log(`downloading pinned ${SMOKE_MODEL} (${MODEL_REVISION.slice(0, 8)})...`);
      const r = await fetch(MODEL_URL);
      if (!r.ok) fail(`model download HTTP ${r.status}`);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(path, Buffer.from(await r.arrayBuffer()));
    }
  }
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (sha !== M.sha256) fail(`${SMOKE_MODEL} SHA-256 mismatch: ${sha}`);
  return path;
}

/** A tiny valid RGB PNG (for project files built here). */
function tinyPng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    td.copy(out, 4);
    out.writeUInt32BE(crc(td), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 120);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * A v1 (JSON) project file whose stored texts all carry markup: a meta refresh that would
 * navigate away and an element that must never appear in the page.
 */
function hostileProjectJson() {
  const X = '<meta http-equiv="refresh" content="0;url=https://example.com/smoke-phish"><b class="smoke-xss">x</b>';
  const w = 64;
  const masks = new Int32Array(w * w);
  for (let y = 10; y < 40; y++) for (let x = 10; x < 40; x++) masks[y * w + x] = 1;
  return JSON.stringify({
    format: 'webgrainy-project',
    version: 1,
    exportedAt: X,
    site: { siteId: 'smoke-hostile', name: `Site ${X}`, place: `Place ${X}`, photoOrder: ['h1'], options: { poolingMode: 'physical-area' }, createdAt: 1, updatedAt: Date.now() },
    photos: [{
      photoId: 'h1', siteId: 'smoke-hostile', label: `photo ${X}.png`, width: w, height: w, addedAt: 1, included: true,
      imageBase64: tinyPng(w, w).toString('base64'), imageMimeType: 'image/png',
      calibration: { mmPerPx: 0.5, pointA: { x: 0, y: 0 }, pointB: { x: 10, y: 0 }, physicalLengthMm: 5, pixelDistance: 10, source: 'copied', copiedFrom: X },
      metadata: { cameraMake: X, cameraModel: X, notes: X, timestamp: X, processingHistory: [{ step: 'enhancement', kind: 'upscale-2x', modelId: X, modelName: X, modelSha256: X, scaleFactor: 2, appliedAt: X }] },
    }],
    results: [{
      photoId: 'h1', status: 'done', updatedAt: 1,
      serializedSession: {
        version: 1,
        workingMasksBase64: Buffer.from(masks.buffer).toString('base64'),
        workingImage: { width: w, height: w, originalWidth: w, originalHeight: w, effectiveScaleFactor: 1, scaleModeApplied: '1.0x', dataBase64: '' },
        recommendation: { model: X, confidence: 1, rationale: X, metrics: {} },
        excludeBorder: true,
        borderMargin: 2,
        provenance: { appVersion: X, ortVersion: X, analyzedAt: X, modelId: 'ig2_unet_fp32', modelFile: X, modelRevision: X, modelSha256: X, executionProvider: X, inferencePipeline: X, scaleMode: X },
      },
    }],
  });
}

/** Step 5: a hostile project file must not navigate the page or inject markup. */
async function checkHostileProject(browser) {
  const context = await browser.newContext();
  const p = await context.newPage();
  const navigations = [];
  p.on('framenavigated', (f) => {
    if (f === p.mainFrame()) navigations.push(f.url());
  });
  await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'navigated away' }));
  await p.goto(base, { waitUntil: 'networkidle' });
  await p.waitForSelector('#archive-file-input', { state: 'attached', timeout: 30000 });
  await p.setInputFiles('#archive-file-input', { name: 'hostile.webgrainy.json', mimeType: 'application/json', buffer: Buffer.from(hostileProjectJson()) });
  await p.waitForFunction(() => /Imported project archive|Failed to import/.test(document.body.innerText), null, { timeout: 30000 });
  await p.waitForTimeout(2500);
  const left = navigations.filter((u) => !u.startsWith(base));
  if (left.length > 0) fail(`hostile project file navigated the page to ${left.join(', ')}`);
  const injected = await p.evaluate(() => document.querySelectorAll('.smoke-xss, body meta[http-equiv]').length);
  if (injected > 0) fail(`hostile project file injected ${injected} element(s) into the page`);
  if (!(await p.evaluate(() => document.body.innerText.includes('Imported project archive')))) fail('hostile project file was not imported (expected it to import with its texts shown as plain text)');
  await context.close();
  console.log('ok: hostile project file imported without navigation or injected markup');
}

const browser = await chromium.launch({ args: ['--disable-features=WebGPU'] });
const page = await browser.newPage();
await page.addInitScript(() => {
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push(e.duration);
  }).observe({ type: 'longtask', buffered: true });
});
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`);
});

try {
  const skipInference = process.env.SMOKE_SKIP_INFERENCE === '1';
  if (!skipInference) {
    modelFile = await getModelFile();
    await page.route('https://huggingface.co/**', (route) => {
      if (route.request().url() !== MODEL_URL) {
        problems.push(`unexpected model URL (not pinned): ${route.request().url()}`);
      }
      return route.fulfill({
        status: 302,
        headers: { location: `${base}__smoke_model`, 'access-control-allow-origin': '*' },
      });
    });
  }

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('#photo-file-input', { state: 'attached', timeout: 30000 });
  if (problems.length) fail(`page load: ${problems.join(' | ')}`);
  console.log('ok: app loaded without console errors');
  await checkHostileProject(browser);

  if (skipInference) {
    console.log('SMOKE PASS (inference skipped)');
  } else {
    // Small synthetic "gravel" image drawn in the browser.
    const pngB64 = await page.evaluate(async (img) => {
      const c = new OffscreenCanvas(img.w, img.h);
      const g = c.getContext('2d');
      g.fillStyle = '#3a3630';
      g.fillRect(0, 0, img.w, img.h);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < img.n; i++) {
        const r = img.r0 + rnd() * img.dr;
        const x = r + rnd() * (img.w - 2 * r);
        const y = r + rnd() * (img.h - 2 * r);
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
    }, IMG);
    await page.setInputFiles('#photo-file-input', {
      name: 'smoke.png',
      mimeType: 'image/png',
      buffer: Buffer.from(pngB64, 'base64'),
    });
    await page.waitForSelector('.photo-item', { timeout: 30000 });
    // Settings are collapsed by default: open them to choose the model.
    await page.click('details.settings-block > summary');
    await page.selectOption('select[data-param="model"]', M.select);
    if (M.weights) await page.selectOption('select[data-param="cpsamWeights"]', M.weights);
    await page.click('button[data-action="run-active"]');

    const t0 = Date.now();
    await page.waitForFunction(
      () => /Batch complete|Batch error|Batch cancelled/.test(document.body.innerText),
      null,
      { timeout: TIMEOUT_MS, polling: 2000 },
    );
    const footer = await page.evaluate(() => document.body.innerText.match(/Batch[^\n]*/)?.[0] ?? '');
    console.log(`analysis finished in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${footer}`);
    if (!/1 done, 0 failed/.test(footer)) fail(`analysis did not succeed: ${footer}`);
    const longTasks = await page.evaluate(() => window.__longTasks.slice());
    const longest = Math.max(0, ...longTasks);
    console.log(`main thread: ${longTasks.length} long tasks, longest ${(longest / 1000).toFixed(2)} s`);
    if (longest > MAX_LONGTASK_MS) {
      fail(`the page froze for ${(longest / 1000).toFixed(1)} s (limit ${MAX_LONGTASK_MS / 1000} s): CPU inference must run in its worker`);
    }
    // Switch to the single-photo view and require a numeric D50.
    await page.click('[data-scope="photo"]');
    await page.waitForTimeout(500);
    const nText = await page.evaluate(() => document.body.innerText.match(/n = (\d+)/)?.[1] ?? '0');
    if (Number(nText) <= 0) fail('no grains reported after analysis');
    // ROI tool: a small triangle in one corner leaves most grains outside it.
    await page.click('button[data-tool="roiPoly"]');
    const stage = await page.locator('#canvas-stage').boundingBox();
    if (!stage) fail('no photo canvas');
    for (const [fx, fy] of [[0.3, 0.3], [0.45, 0.3], [0.3, 0.45]]) {
      await page.mouse.click(stage.x + stage.width * fx, stage.y + stage.height * fy);
    }
    await page.click('button[data-action="finish-shape"]');
    await page.waitForTimeout(500);
    const roiText = await page.evaluate(() => document.body.innerText);
    if (!/\d+ excluded by ROI/.test(roiText)) fail('drawing an ROI excluded no grains');
    await page.click('button[data-action="clear-areas"]');
    await page.waitForTimeout(500);
    if (/\d+ excluded by ROI/.test(await page.evaluate(() => document.body.innerText))) fail('Clear areas did not remove the ROI');
    console.log('ok: ROI tool excludes grains outside it; Clear areas removes it');
    await page.click('button[data-tool="inspect"]');
    if (process.env.SMOKE_SCREENSHOT) {
      // Optional visual check: grain ellipses and orientation vectors over the photo.
      await page.click('details.display-menu > summary');
      if (await page.locator('details.more-stats > summary').count()) {
        await page.click('details.more-stats > summary');
        await page.locator('details.more-stats').scrollIntoViewIfNeeded();
      }
      for (const ov of ['ellipses', 'orientations']) {
        const box = page.locator(`input[data-ov="${ov}"]`);
        if ((await box.count()) && !(await box.isChecked())) await box.check();
      }
      await page.waitForTimeout(800);
      await page.screenshot({ path: process.env.SMOKE_SCREENSHOT });
      console.log(`screenshot: ${process.env.SMOKE_SCREENSHOT}`);
    }
    if (problems.length) fail(problems.join(' | '));
    console.log(`SMOKE PASS (n = ${nText} grains)`);
  }
} finally {
  await browser.close();
  server.close();
}
