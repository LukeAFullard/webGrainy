// Audit: end-to-end drive of the built app with the real U-Net ONNX model served locally
// (HF URL is intercepted and fulfilled from a local, SHA-256-verified copy).
// Usage: node audit/browser_e2e.cjs <model.onnx> <image.png> [url]
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [modelPath, imgPath, url = 'http://127.0.0.1:8765/'] = process.argv.slice(2);
  const browser = await chromium.launch({ args: (process.env.NOGPU ? ['--disable-features=WebGPU','--disable-gpu'] : ['--enable-unsafe-webgpu']) });
  const page = await browser.newPage();
  const reqs = []; const errs = []; const external = [];
  page.on('request', r => { reqs.push(r.method() + ' ' + r.url()); if (!r.url().startsWith(url)) external.push(r.url()); });
  page.on('response', r => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('console', m => { if (['error','warning'].includes(m.type())) errs.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  const body = fs.readFileSync(modelPath);
  await page.route('https://huggingface.co/**', route => route.fulfill({ status: 200, body, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'access-control-allow-origin': '*' } }));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.setInputFiles('#photo-file-input', imgPath);
  await page.waitForTimeout(2000);
  await page.selectOption('select[data-param="model"]', 'unet');
  await page.waitForTimeout(300);
  const t0 = Date.now();
  await page.click('button[data-action="run-active"]');
  let status = '';
  for (let i = 0; i < (Number(process.env.WAIT)||240); i++) {
    await page.waitForTimeout(1000);
    status = await page.evaluate(() => document.querySelector('footer, .footer, #footer')?.innerText ?? '');
    if (/grains|fail|error|complete|segmented/i.test(status) && !/running|infer|post|load|download/i.test(status)) break;
  }
  const secs = (Date.now() - t0) / 1000;
  const dash = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: process.env.SHOT || '/tmp/claude-0/e2e.png' });
  console.log(JSON.stringify({ secs, status, external: [...new Set(external)], errors: errs, requests: [...new Set(reqs)].filter(r => !r.includes('/ort/') || true).slice(0, 40), dashExcerpt: dash.slice(dash.indexOf('Folk') - 400, dash.indexOf('Folk') + 400) }, null, 2));
  await browser.close();
})();
