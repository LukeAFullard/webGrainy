// Verify the service worker makes the app cross-origin isolated on a host that sends NO
// COOP/COEP headers, that it reloads at most once, and that analysis still works.
// Usage: node audit/review/sw_isolation_check.cjs <url> <unet.onnx>
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [url, modelPath] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--disable-features=WebGPU'] });
  const page = await browser.newPage();
  const errs = []; let navs = 0;
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
  const body = fs.readFileSync(modelPath);
  await page.route('https://huggingface.co/**', (r) => r.fulfill({ status: 200, body, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'access-control-allow-origin': '*' } }));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000); // SW install + one reload
  await page.waitForLoadState('networkidle');
  const s1 = await page.evaluate(() => ({ coi: self.crossOriginIsolated, controlled: !!navigator.serviceWorker.controller, sab: typeof SharedArrayBuffer !== 'undefined' }));
  // Second plain reload: must stay isolated and must not trigger another automatic reload.
  const before = navs;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const s2 = await page.evaluate(() => self.crossOriginIsolated);
  const extraReloads = navs - before - 1;
  // Analysis works under isolation (multi-threaded WASM).
  const png = await page.evaluate(async () => {
    const c = new OffscreenCanvas(384, 288); const g = c.getContext('2d');
    g.fillStyle = '#3a3630'; g.fillRect(0, 0, 384, 288); let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 70; i++) { const rad = 8 + r() * 16, x = rad + r() * (384 - 2 * rad), y = rad + r() * (288 - 2 * rad); g.fillStyle = `rgb(${180 + r() * 60 | 0},170,150)`; g.beginPath(); g.ellipse(x, y, rad, rad * 0.8, r() * 3, 0, 7); g.fill(); }
    const b = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); let t = ''; for (const v of b) t += String.fromCharCode(v); return btoa(t);
  });
  await page.setInputFiles('#photo-file-input', { name: 'iso.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForSelector('.photo-item');
  await page.selectOption('select[data-param="model"]', 'unet');
  await page.click('button[data-action="run-active"]');
  await page.waitForFunction(() => /Batch complete|Batch error/.test(document.body.innerText), null, { timeout: 300000 });
  const footer = await page.evaluate(() => document.body.innerText.match(/Batch[^\n]*/)?.[0]);
  const threads = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /ort-wasm.*\.mjs/.test(e.name)).length);
  console.log(JSON.stringify({ afterFirstVisit: s1, isolatedAfterReload: s2, extraAutomaticReloads: extraReloads, analysis: footer, ortModuleLoads: threads, errors: errs }, null, 2));
  await browser.close();
})();
