#!/usr/bin/env node
// Browser smoke test of the BUILT app (dist/). This is the integration check whose
// absence let the ORT path bug (AUDIT_REPORT F-01) ship with an all-green unit suite.
//
//   1. Serves dist/ on a local port and checks every service-worker precache asset is 200.
//   2. Loads the app headless and fails on any console error / HTTP >= 400 / CSP violation.
//   3. Unless SMOKE_SKIP_INFERENCE=1: obtains the pinned U-Net weights (MODEL_PATH, or
//      downloads the pinned revision and verifies SHA-256), serves them in place of the
//      Hugging Face URL, analyses a generated test image with the WASM backend, and
//      requires the photo to finish "done" with > 0 grains.
//
// Usage: npm run build && npm run test:e2e:browser
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const DIST = resolve('dist');
const MODEL_REVISION = '98e76b1374dc22cfff8193aca71c308f2b4dd3b3';
const UNET_SHA256 = '5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c';
const UNET_URL = `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REVISION}/ig2_unet_fp32.onnx`;
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

async function getModelBytes() {
  let bytes;
  if (process.env.MODEL_PATH) {
    bytes = readFileSync(process.env.MODEL_PATH);
  } else {
    const cacheDir = resolve('.cache');
    const cached = join(cacheDir, `ig2_unet_fp32.${MODEL_REVISION.slice(0, 8)}.onnx`);
    if (existsSync(cached)) {
      bytes = readFileSync(cached);
    } else {
      console.log(`downloading pinned U-Net (${MODEL_REVISION.slice(0, 8)})...`);
      const r = await fetch(UNET_URL);
      if (!r.ok) fail(`model download HTTP ${r.status}`);
      bytes = Buffer.from(await r.arrayBuffer());
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cached, bytes);
    }
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== UNET_SHA256) fail(`U-Net SHA-256 mismatch: ${sha}`);
  return bytes;
}

const browser = await chromium.launch({ args: ['--disable-features=WebGPU'] });
const page = await browser.newPage();
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
    const model = await getModelBytes();
    await page.route('https://huggingface.co/**', (route) => {
      if (route.request().url() !== UNET_URL) {
        problems.push(`unexpected model URL (not pinned): ${route.request().url()}`);
      }
      return route.fulfill({
        status: 200,
        body: model,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(model.length),
          'access-control-allow-origin': '*',
        },
      });
    });
  }

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('#photo-file-input', { state: 'attached', timeout: 30000 });
  if (problems.length) fail(`page load: ${problems.join(' | ')}`);
  console.log('ok: app loaded without console errors');

  if (skipInference) {
    console.log('SMOKE PASS (inference skipped)');
  } else {
    // Small synthetic "gravel" image drawn in the browser.
    const pngB64 = await page.evaluate(async () => {
      const c = new OffscreenCanvas(384, 288);
      const g = c.getContext('2d');
      g.fillStyle = '#3a3630';
      g.fillRect(0, 0, 384, 288);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 70; i++) {
        const r = 8 + rnd() * 16;
        const x = r + rnd() * (384 - 2 * r);
        const y = r + rnd() * (288 - 2 * r);
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
      name: 'smoke.png',
      mimeType: 'image/png',
      buffer: Buffer.from(pngB64, 'base64'),
    });
    await page.waitForSelector('.photo-item', { timeout: 30000 });
    // Settings are collapsed by default: open them to choose the model.
    await page.click('details.settings-block > summary');
    await page.selectOption('select[data-param="model"]', 'unet');
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
    // Switch to the single-photo view and require a numeric D50.
    await page.click('[data-scope="photo"]');
    await page.waitForTimeout(500);
    const nText = await page.evaluate(() => document.body.innerText.match(/n = (\d+)/)?.[1] ?? '0');
    if (Number(nText) <= 0) fail('no grains reported after analysis');
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
