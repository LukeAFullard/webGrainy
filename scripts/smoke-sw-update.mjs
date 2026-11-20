#!/usr/bin/env node
// Service-worker update check with two builds and several tabs (headless Chromium).
//
// Simulates a deployment while the app is open: build v1 is dist/; build v2 is a copy of it
// with a different service-worker hash, build id and worker file. Checks that
//   1. opening another tab after the deploy does NOT switch an already-open tab to v2
//      (its workers must stay v1), and the update is offered instead;
//   2. when the user does update in one tab, the other tab locks itself ("Reload now").
//
// Usage: npm run build && node scripts/smoke-sw-update.mjs
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
let root = V1;
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(root, p));
  if (p.endsWith('/')) file = join(file, 'index.html');
  if (!file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
