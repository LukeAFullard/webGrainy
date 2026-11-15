// Drives dist/gpucheck.html served under a /webGrainy/ sub-path (as on GitHub Pages),
// with software WebGPU (SwiftShader) and the real model served in place of Hugging Face.
// Usage: node audit/review/gpucheck_page_test.cjs <model.onnx> <unet|cpsam>
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
const [modelPath, kind = 'unet'] = process.argv.slice(2);
const DIST = path.resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith('/webGrainy/')) { res.writeHead(404); return res.end(); }
  let f = path.normalize(path.join(DIST, p.slice('/webGrainy/'.length)));
  if (p.endsWith('/')) f = path.join(f, 'index.html');
  if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}/webGrainy/`;
  const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'] });
  const page = await browser.newPage();
  const errs = []; const notFound = [];
  page.on('console', (m) => m.type() === 'error' && !/onnxruntime|WGSL|CommandBuffer|validation/.test(m.text()) && errs.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('response', (r) => r.status() === 404 && notFound.push(r.url()));
  const body = fs.readFileSync(modelPath);
  await page.route('https://huggingface.co/**', (r) => r.fulfill({ status: 200, body, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'access-control-allow-origin': '*' } }));
  await page.goto(base + 'gpucheck.html', { waitUntil: 'networkidle' });
  await page.selectOption('#model', kind);
  await page.click('#run');
  await page.waitForFunction(() => !document.getElementById('report-actions').hidden, null, { timeout: 1800000, polling: 2000 });
  const status = await page.textContent('#status');
  const report = await page.evaluate(() => window.__gpuCheckReport);
  await page.screenshot({ path: process.env.SHOT || '/tmp/claude-0/gpucheck.png', fullPage: true });
  console.log(JSON.stringify({ status, webgpu: report.webgpu, providers: [report.webgpuProvider, report.wasmProvider], cases: (report.cases || []).map((c) => ({ case: c.case, verdict: c.verdict, maskPQ: c.maskPQ, grains: `${c.grainsWebgpu}/${c.grainsWasm}`, err: (c.webgpuError || c.wasmError || '').slice(0, 120) })), notFound, errors: errs }, null, 2));
  await browser.close(); server.close();
});
