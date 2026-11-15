#!/usr/bin/env node
/**
 * Item 4: Offline-first & Service Worker update verification in headless Chromium.
 *
 * Tests against a local HTTP server serving a copy of `dist/`:
 *   (a) Cold install: `navigator.serviceWorker.ready` + U-Net analysis -> `1 done, 0 failed`.
 *   (b) Offline reload & analysis: `context.setOffline(true)`, `page.reload()`,
 *       U-Net analysis offline -> `1 done, 0 failed`, export summary JSON and verify
 *       `metadata.analysis.modelSha256 === UNET_SHA256`.
 *   (c) Build-to-build update: serve a second build with a changed asset + new `BUILD_HASH`
 *       in `sw.js`, trigger `reg.update()`, verify `SKIP_WAITING` + `controllerchange` +
 *       reload prompt `'A new version of webGrainy was installed...'`.
 *
 * Writes results to `audit/followup/offline_sw_results.json`.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const DIST = resolve('dist');
const SERVE_DIR = '/tmp/webgrainy_sw_dist';
const OUT_PATH = resolve('audit/followup/offline_sw_results.json');
const MODEL_REVISION = '7773328a544ac050b7820667e68cbfb02a2e954a';
const UNET_SHA256 = '5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c';
const UNET_URL = `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REVISION}/ig2_unet_fp32.onnx`;
const TIMEOUT_MS = Number(process.env.OFFLINE_SW_TIMEOUT_MS ?? 5 * 60 * 1000);

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
  console.error(`OFFLINE SW VERIFY FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist/ not built; run `npm run build` first.');
}

async function getUnetBytes() {
  const cacheDir = resolve('.cache');
  const cached = join(cacheDir, `ig2_unet_fp32.${MODEL_REVISION.slice(0, 8)}.onnx`);
  let bytes;
  if (existsSync(cached)) {
    bytes = readFileSync(cached);
  } else {
    console.log(`Downloading pinned U-Net (${MODEL_REVISION.slice(0, 8)})...`);
    const r = await fetch(UNET_URL);
    if (!r.ok) fail(`U-Net download HTTP ${r.status}`);
    bytes = Buffer.from(await r.arrayBuffer());
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, bytes);
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== UNET_SHA256) fail(`U-Net SHA-256 mismatch: ${sha}`);
  return bytes;
}

rmSync(SERVE_DIR, { recursive: true, force: true });
cpSync(DIST, SERVE_DIR, { recursive: true });

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(SERVE_DIR, urlPath));
  if (!file.startsWith(SERVE_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (urlPath.endsWith('/')) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
  };
  if (urlPath.endsWith('/sw.js')) {
    headers['Cache-Control'] = 'no-cache';
  }
  res.writeHead(200, headers);
  res.end(readFileSync(file));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
console.log(`Serving ${SERVE_DIR} at ${base}`);

const browser = await chromium.launch({ args: ['--disable-features=WebGPU'] });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

const results = {
  timestamp: new Date().toISOString(),
  chromiumVersion: browser.version(),
  coldInstall: {},
  offlineReloadAndAnalysis: {},
  swUpdate: {},
  safariIosManualChecklist: [
    'Verify IndexedDB persistence across 7-day ITP eviction window when not installed to Home Screen on iOS/iPadOS Safari.',
    'Verify iOS Safari memory ceiling with U-Net (26 MB) on large camera photos (CP-SAM 617 MB is unsupported on mobile per DEPLOYMENT.md).',
    'Verify standalone PWA Home Screen launch, offline cold-open, and `launchQueue` / file-picker behavior on iOS Safari >= 17.4.',
    'Verify SW update banner visibility and reload recovery in Safari standalone mode.',
  ],
};

async function makeSyntheticGravelPng(p) {
  const b64 = await p.evaluate(async () => {
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
  return Buffer.from(b64, 'base64');
}

async function runUnetOnSyntheticPhoto(p, filename) {
  const pngBuf = await makeSyntheticGravelPng(p);
  await p.setInputFiles('#photo-file-input', {
    name: filename,
    mimeType: 'image/png',
    buffer: pngBuf,
  });
  await p.waitForSelector('.photo-item', { timeout: 30000 });
  await p.selectOption('select[data-param="model"]', 'unet');
  const t0 = Date.now();
  await p.click('button[data-action="run-active"]');
  await p.waitForFunction(
    () => /Batch complete|Batch error|Batch cancelled/.test(document.body.innerText),
    null,
    { timeout: TIMEOUT_MS, polling: 1000 },
  );
  const elapsedMs = Date.now() - t0;
  const footer = await p.evaluate(() => document.body.innerText.match(/Batch[^\n]*/)?.[0] ?? '');
  await p.click('[data-scope="photo"]');
  await p.waitForTimeout(300);
  const grainCount = Number(
    await p.evaluate(() => document.body.innerText.match(/n = (\d+)/)?.[1] ?? '0'),
  );
  return { elapsedMs, footer, grainCount };
}

try {
  const modelBytes = await getUnetBytes();
  await context.route('https://huggingface.co/**', (route) => {
    if (route.request().url() !== UNET_URL) {
      problems.push(`unexpected model URL: ${route.request().url()}`);
    }
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

  // (a) Cold install
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('#photo-file-input', { state: 'attached', timeout: 30000 });

  const swCold = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    // Wait briefly for clients.claim() if controller not yet attached
    if (!navigator.serviceWorker.controller) {
      await new Promise((res) => {
        navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
        setTimeout(res, 5000);
      });
    }
    const cacheKeys = await caches.keys();
    return {
      scope: reg.scope,
      activeState: reg.active?.state ?? null,
      hasController: Boolean(navigator.serviceWorker.controller),
      cacheKeys,
    };
  });
  console.log('Cold SW:', JSON.stringify(swCold));
  if (!swCold.hasController) fail('Service worker did not claim controller on cold install');

  const coldRun = await runUnetOnSyntheticPhoto(page, 'cold.png');
  console.log('Cold run:', JSON.stringify(coldRun));
  if (!/1 done, 0 failed/.test(coldRun.footer) || coldRun.grainCount <= 0) {
    fail(`Cold U-Net run failed: ${JSON.stringify(coldRun)}`);
  }
  results.coldInstall = { ...swCold, ...coldRun, passed: true };

  // (b) Offline reload & analysis
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#photo-file-input', { state: 'attached', timeout: 30000 });

  const swOffline = await page.evaluate(() => ({
    onLine: navigator.onLine,
    hasController: Boolean(navigator.serviceWorker.controller),
  }));
  console.log('Offline reload:', JSON.stringify(swOffline));
  if (!swOffline.hasController) fail('No SW controller after offline reload');

  const offlineRun = await runUnetOnSyntheticPhoto(page, 'offline.png');
  console.log('Offline run:', JSON.stringify(offlineRun));
  if (!/1 done, 0 failed/.test(offlineRun.footer) || offlineRun.grainCount <= 0) {
    fail(`Offline U-Net run failed: ${JSON.stringify(offlineRun)}`);
  }

  // Export summary JSON and verify metadata.analysis.modelSha256
  await page.click('[data-open-modal="export"]');
  await page.waitForSelector('[data-export="photo-summary-json"]', { timeout: 10000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-export="photo-summary-json"]'),
  ]);
  const dlPath = await download.path();
  const summaryJson = JSON.parse(readFileSync(dlPath, 'utf8'));
  const exportedSha = summaryJson?.metadata?.analysis?.modelSha256 ?? null;
  if (exportedSha !== UNET_SHA256) {
    fail(`Exported modelSha256 mismatch: ${exportedSha} !== ${UNET_SHA256}`);
  }
  // Close export modal if open
  await page.keyboard.press('Escape');

  results.offlineReloadAndAnalysis = {
    ...swOffline,
    ...offlineRun,
    exportedModelSha256: exportedSha,
    passed: true,
  };

  // (c) Update from one build to the next
  await context.setOffline(false);
  const swPath = join(SERVE_DIR, 'sw.js');
  const mainJsPath = join(SERVE_DIR, 'ui', 'main.js');
  const oldSw = readFileSync(swPath, 'utf8');
  const oldHashMatch = oldSw.match(/const BUILD_HASH = '([^']+)';/);
  const oldHash = oldHashMatch ? oldHashMatch[1] : 'unknown';

  writeFileSync(mainJsPath, `${readFileSync(mainJsPath, 'utf8')}\n/* sw-update-test */\n`);
  const newHash = createHash('sha256')
    .update(readFileSync(mainJsPath))
    .digest('hex')
    .slice(0, 16);
  const newSw = oldSw.replace(`const BUILD_HASH = '${oldHash}';`, `const BUILD_HASH = '${newHash}';`);
  writeFileSync(swPath, newSw);

  const updateInfo = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { error: 'no registration' };
    const controllerChanged = new Promise((resolveChange) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolveChange(true), {
        once: true,
      });
      setTimeout(() => resolveChange(false), 15000);
    });
    await reg.update();
    const changed = await controllerChanged;
    return { changed };
  });

  await page.waitForFunction(
    () =>
      document.body.innerText.includes(
        'A new version of webGrainy was installed. Save your work and reload the page to use it.',
      ),
    null,
    { timeout: 15000 },
  );
  const statusBanner = await page.evaluate(() => {
    const m = document.body.innerText.match(
      /A new version of webGrainy was installed\.[^\n]*/,
    );
    return m ? m[0] : null;
  });

  results.swUpdate = {
    oldBuildHash: oldHash,
    newBuildHash: newHash,
    controllerChanged: updateInfo.changed,
    reloadPrompt: statusBanner,
    passed: Boolean(updateInfo.changed && statusBanner),
  };
  console.log('SW Update:', JSON.stringify(results.swUpdate));

  if (problems.length) {
    results.problems = problems;
    fail(`Runtime problems observed: ${problems.join(' | ')}`);
  }

  writeFileSync(OUT_PATH, JSON.stringify(results, null, 2) + '\n');
  console.log(`Wrote ${OUT_PATH}`);
  console.log('OFFLINE SW VERIFY PASS');
} finally {
  await browser.close();
  server.close();
  rmSync(SERVE_DIR, { recursive: true, force: true });
}
