// Audit: headless smoke test of built app. Usage: node audit/browser_smoke.cjs [url]
const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2] || 'http://127.0.0.1:8765/';
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const reqs = []; const errs = [];
  page.on('request', r => reqs.push(r.url()));
  page.on('console', m => { if (['error','warning'].includes(m.type())) errs.push(m.type()+': '+m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  const title = await page.title();
  const text = (await page.innerText('body')).slice(0, 600);
  // probe how ORT would resolve wasmPaths relative to the module
  const resolved = await page.evaluate(() => new URL('./ort/ort-wasm-simd-threaded.jsep.mjs', new URL('./ui/main.js', location.href)).href);
  const head = await page.evaluate(async (u) => (await fetch(u)).status, resolved);
  const coi = await page.evaluate(() => self.crossOriginIsolated);
  const swCtl = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r; });
  console.log(JSON.stringify({ title, coi, swRegistered: swCtl, ortResolvedFromModule: resolved, status: head, requests: [...new Set(reqs)], consoleErrors: errs, bodyStart: text }, null, 2));
  await browser.close();
})();
