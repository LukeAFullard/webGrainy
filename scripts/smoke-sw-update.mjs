#!/usr/bin/env node
// Service-worker update check with two builds and several tabs (headless Chromium).
//
// Simulates a deployment while the app is open: build v1 is dist/; build v2 is a copy of it
// with a different service-worker hash, build id, worker file and ONNX Runtime file. Files are
// served with `Cache-Control: max-age=600`, as GitHub Pages does, and v2 is deployed within that
// window. Checks that
//   1. opening another tab after the deploy does NOT switch an already-open tab to v2
//      (its workers must stay v1), and the update is offered instead;
//   2. when the user does update in one tab, the other tab locks itself ("Reload now");
//   3. the updated tab really runs v2: its code and runtime were not taken from the browser's
//      HTTP cache, which still holds v1 (production readiness review M1);
//   4. a deploy whose runtime file does not match its build (e.g. a CDN still serving the
//      previous file) is not installed, and the wrong file is not cached.
//
// Usage: npm run build && node scripts/smoke-sw-update.mjs
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const DIST = resolve('dist');
if (!existsSync(join(DIST, 'sw.js'))) {
  console.error('SW SMOKE FAIL: dist/ not built; run `npm run build` first.');
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), 'wg-sw-'));
const V1 = join(work, 'v1');
const V2 = join(work, 'v2');
cpSync(DIST, V1, { recursive: true });
cpSync(DIST, V2, { recursive: true });
const workerRel = join('workers', 'grainPostprocess.worker.js');
const buildDate = readFileSync(join(V1, workerRel), 'utf8').match(/20\d\d-\d\d-\d\dT[\d:.]+Z/)?.[0];
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
for (const f of walk(V2).filter((f) => /\.(js|mjs)$/.test(f))) {
  let t = readFileSync(f, 'utf8');
  if (buildDate) t = t.split(buildDate).join('2099-01-01T00:00:00.000Z');
  if (f.endsWith('sw.js')) t = t.replace(/const BUILD_HASH = '[0-9a-f]+'/, "const BUILD_HASH = 'v2v2v2v2v2v2v2v2'");
  if (f.endsWith(workerRel)) t += '\n/* BUILD-V2-WORKER */\n';
  writeFileSync(f, t);
}

// v2 also ships a different ONNX Runtime file, stamped into its service worker as a real build
// would; v3 is v2 with a service worker that expects a runtime file the server does not have.
const ORT_MJS = './ort/ort-wasm-simd-threaded.jsep.mjs';
function stampRuntime(dir, buildHash, expectedMjs, filesId) {
  const swFile = join(dir, 'sw.js');
  const before = readFileSync(swFile, 'utf8');
  const after = before
    .replace(/const BUILD_HASH = '[^']+'/, `const BUILD_HASH = '${buildHash}'`)
    .replace(/("\.\/ort\/ort-wasm-simd-threaded\.jsep\.mjs":")[0-9a-f]{64}/, `$1${createHash('sha256').update(expectedMjs).digest('hex')}`)
    .replace(/const ORT_FILES_ID = '[^']+'/, `const ORT_FILES_ID = '${filesId}'`);
  if ((after.match(/v[23]runtime|v[23]v[23]/g) ?? []).length < 2 || !after.includes(createHash('sha256').update(expectedMjs).digest('hex'))) {
    throw new Error('SW SMOKE: could not restamp dist/sw.js (did its ORT_SHA256 / ORT_FILES_ID format change?)');
  }
  writeFileSync(swFile, after);
}
appendFileSync(join(V2, ORT_MJS), '\n/* RUNTIME-V2 */\n');
stampRuntime(V2, 'v2v2v2v2v2v2v2v2', readFileSync(join(V2, ORT_MJS)), 'v2runtime');
const V3 = join(work, 'v3');
cpSync(V2, V3, { recursive: true });
stampRuntime(V3, 'v3v3v3v3v3v3v3v3', Buffer.concat([readFileSync(join(V2, ORT_MJS)), Buffer.from('/* RUNTIME-V3 */')]), 'v3runtime');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
let root = V1;
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(root, p));
  if (p.endsWith('/')) file = join(file, 'index.html');
  if (!file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
  // GitHub Pages' caching: the browser may reuse these files for 10 minutes without asking.
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'max-age=600' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const ctx = await chromium.launchPersistentContext(join(work, 'profile'), { args: ['--disable-features=WebGPU'] });
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'ok' : 'FAIL'}: ${msg}`);
  if (!ok) failures.push(msg);
};
const workerVersion = (page) =>
  page.evaluate(async () => ((await (await fetch('./workers/grainPostprocess.worker.js')).text()).includes('BUILD-V2-WORKER') ? 'v2' : 'v1'));
const serves = (page, rel, marker) => page.evaluate(async ([rel, marker]) => (await (await fetch(rel)).text()).includes(marker), [rel, marker]);
try {
  const a = await ctx.newPage();
  await a.goto(base, { waitUntil: 'networkidle' });
  await a.evaluate(() => navigator.serviceWorker.ready);
  await a.reload({ waitUntil: 'networkidle' });
  check(await a.evaluate(() => !!navigator.serviceWorker.controller), 'tab A (v1) is controlled by the service worker');

  root = V2; // deploy
  const b = await ctx.newPage();
  await b.goto(base, { waitUntil: 'networkidle' });
  await b.waitForTimeout(3000);
  const c = await ctx.newPage();
  await c.goto(base, { waitUntil: 'networkidle' });
  await c.waitForTimeout(4000);
  check((await workerVersion(a)) === 'v1', 'opening more tabs after a deploy leaves tab A on its own (v1) workers');
  check(await c.evaluate(() => !!document.querySelector('[data-action="apply-update"]')), 'the new tab offers "Reload to update"');

  await c.evaluate(() => document.querySelector('[data-action="apply-update"]')?.click());
  await c.waitForTimeout(4000);
  check(await a.evaluate(() => !!document.querySelector('[data-action="reload-stale"]')), 'after updating in another tab, tab A is locked ("Reload now")');
  check((await workerVersion(c)) === 'v2', 'after "Reload to update" the tab runs v2 code, not v1 from the HTTP cache (max-age=600)');
  check(await serves(c, ORT_MJS, 'RUNTIME-V2'), 'the updated ONNX Runtime is cached as v2, not the v1 file from the HTTP cache');

  root = V3; // a deploy whose runtime file is not the one its service worker was built with
  const d = await ctx.newPage();
  await d.goto(base, { waitUntil: 'networkidle' });
  await d.waitForTimeout(5000);
  check(!(await d.evaluate(() => !!document.querySelector('[data-action="apply-update"]'))), 'a build whose runtime file does not match is not installed (no update offered)');
  const wrongCached = await d.evaluate(async (rel) => {
    for (const k of await caches.keys()) {
      if (k.endsWith('-v3runtime') && (await (await caches.open(k)).match(rel))) return true;
    }
    return false;
  }, ORT_MJS);
  check(!wrongCached, 'the mismatching runtime file is not cached');
  check((await workerVersion(d)) === 'v2' && (await serves(d, ORT_MJS, 'RUNTIME-V2')), 'the tab keeps running the last good build (v2)');
} finally {
  await ctx.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`SW SMOKE FAIL: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('SW SMOKE PASS');
