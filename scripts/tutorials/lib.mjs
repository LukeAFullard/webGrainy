// Shared machinery for the tutorial videos (see scripts/record-tutorials.mjs).
//
// Videos are 1280x720: the screencast always captures at the window's CSS size, whatever
// the device scale factor, so a larger video would need a larger (smaller-text) window.
//
// A tutorial drives the BUILT app (dist/) in headless Chromium. Frames come from the
// Chrome DevTools screencast (sharper than Playwright's recordVideo), each stamped with
// its capture time, then ffmpeg joins them into an H.264 MP4. Because a headless browser
// shows no mouse, an overlay draws a cursor, click ripples, captions, highlight rings and
// title cards on top of the page. Long waits (model download, inference) can be sped up.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

export const ROOT = resolve(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, '.cache');
export const OUT = join(ROOT, 'tutorials', 'out');

const MODEL_REVISION = '98e76b1374dc22cfff8193aca71c308f2b4dd3b3';
const MODELS = {
  'ig2_unet_fp32.onnx': '5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c',
};

// Sample photos: ImageGrains demo data (K1 site), BSD-3-Clause, (c) 2023 David Mair.
// Pinned to a commit and checked by SHA-256 so every recording uses the same pixels.
const PHOTO_COMMIT = '52c12bf7a6317f4c24408647d499cfe2cb6a6ea2';
export const PHOTOS = {
  'K1_C2_385.jpg': 'a1c639254522a81806160b9ad1adf102559b8726024b1c02405da7b68cf27f8c',
  'K1_C3_0449.jpg': '19e3efb0ddc48ce477a789b64d0588ee018274f4aaa5796059974c6413a11d10',
};

/** Pixel size of each sample photo (to turn photo coordinates into screen positions). */
export const PHOTO_SIZE = {
  'K1_C2_385.jpg': { width: 1200, height: 1350 },
  'K1_C3_0449.jpg': { width: 1287, height: 1267 },
};

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

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function cached(name, url, expected) {
  const path = join(CACHE, name);
  if (!existsSync(path)) {
    console.log(`downloading ${name}...`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  }
  const got = sha256(path);
  if (got !== expected) throw new Error(`${name}: SHA-256 ${got}, expected ${expected}`);
  return path;
}

/** Local path of a sample photo (downloaded once into .cache/tutorial-photos/). */
export async function photo(name) {
  const url = `https://raw.githubusercontent.com/dmair1989/imagegrains/${PHOTO_COMMIT}/demo_data/K1/${name}`;
  return cached(join('tutorial-photos', name), url, PHOTOS[name]);
}

async function modelPath(file) {
  // Same cache file name as scripts/smoke-dist.mjs, so the weights are shared.
  const name = `${file.replace(/\.onnx$/, '')}.${MODEL_REVISION.slice(0, 8)}.onnx`;
  const url = `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REVISION}/${file}`;
  return cached(name, url, MODELS[file]);
}

/** Serves dist/ plus pinned model weights on 127.0.0.1. */
async function serve() {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/ not built; run `npm run build` first.');
  const models = {};
  for (const file of Object.keys(MODELS)) models[file] = await modelPath(file);
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const model = urlPath.match(/^\/__model\/(.+)$/)?.[1];
    if (model && models[model]) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(statSync(models[model]).size),
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      createReadStream(models[model]).pipe(res);
      return;
    }
    let file = normalize(join(DIST, urlPath));
    if (!file.startsWith(DIST)) return res.writeHead(403).end();
    if (urlPath.endsWith('/')) file = join(file, 'index.html');
    if (!existsSync(file)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}

// ---------------------------------------------------------------------------------------
// Overlay drawn inside the page. It lives on <html>, outside <body>, so app re-renders
// cannot remove it, and it never takes pointer events.
function overlayInit() {
  const install = () => {
    if (window.__tut) return;
    const root = document.createElement('div');
    root.id = '__tut';
    root.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;';
    // A manual popover lives in the top layer, like the app's modal <dialog>s; re-showing
    // it puts it above any dialog opened since.
    root.popover = 'manual';
    root.innerHTML = `
      <style>
        #__tut .cursor{position:fixed;left:0;top:0;width:26px;height:26px;transform:translate(-100px,-100px);transition:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
        #__tut .ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #1d64d8;background:rgba(29,100,216,.18);animation:__tutRipple .55s ease-out forwards}
        @keyframes __tutRipple{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
        #__tut .caption{position:fixed;left:50%;bottom:28px;transform:translate(-50%,12px);max-width:min(980px,86vw);padding:14px 22px;border-radius:12px;background:rgba(15,23,42,.92);color:#fff;font-size:21px;line-height:1.4;text-align:center;box-shadow:0 8px 28px rgba(0,0,0,.35);opacity:0;transition:opacity .35s,transform .35s}
        #__tut .caption.on{opacity:1;transform:translate(-50%,0)}
        #__tut .caption.top{bottom:auto;top:24px}
        #__tut .caption b{color:#9cc3ff;font-weight:600}
        #__tut .ring{position:fixed;border:3px solid #f59e0b;border-radius:10px;box-shadow:0 0 0 4000px rgba(15,23,42,.28),0 0 18px rgba(245,158,11,.7);opacity:0;transition:opacity .35s,left .45s,top .45s,width .45s,height .45s}
        #__tut .ring.on{opacity:1}
        #__tut .card{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;opacity:0;transition:opacity .5s;text-align:center;padding:40px}
        #__tut .card.on{opacity:1}
        #__tut .card .kicker{font-size:18px;letter-spacing:.14em;text-transform:uppercase;color:#9cc3ff}
        #__tut .card .title{font-size:46px;font-weight:700;max-width:1000px;line-height:1.15}
        #__tut .card .sub{font-size:22px;color:#cbd5e1;max-width:900px;line-height:1.45;white-space:pre-line}
        #__tut .card .sub.mono{font:17px/1.55 ui-monospace,Menlo,Consolas,monospace;text-align:left;background:rgba(0,0,0,.25);padding:14px 22px;border-radius:10px}
      </style>
      <svg class="cursor" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L18.6 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>
      <div class="ring"></div>
      <div class="caption"></div>
      <div class="card"><div class="kicker"></div><div class="title"></div><div class="sub"></div></div>`;
    document.documentElement.appendChild(root);
    const front = () => {
      if (!root.isConnected) document.documentElement.appendChild(root);
      try {
        if (root.matches(':popover-open')) root.hidePopover();
        root.showPopover();
      } catch {
        /* not yet rendered */
      }
    };
    front();
    // Keep the overlay above dialogs as they open.
    new MutationObserver(() => {
      if (document.querySelector('dialog[open]')) front();
    }).observe(document.body ?? document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'], childList: true });
    const $ = (s) => root.querySelector(s);
    const cursor = $('.cursor');
    addEventListener('mousemove', (e) => {
      cursor.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`;
    }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = 'ripple';
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      root.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    window.__tut = {
      front,
      caption(html, pos) {
        front();
        const c = $('.caption');
        if (!html) return c.classList.remove('on');
        c.innerHTML = html;
        c.classList.toggle('top', pos === 'top');
        c.classList.add('on');
      },
      ring(rect, pad = 6) {
        front();
        const r = $('.ring');
        if (!rect) return r.classList.remove('on');
        Object.assign(r.style, {
          left: `${rect.x - pad}px`, top: `${rect.y - pad}px`,
          width: `${rect.width + 2 * pad}px`, height: `${rect.height + 2 * pad}px`,
        });
        r.classList.add('on');
      },
      card(kicker, title, sub, mono) {
        front();
        const c = $('.card');
        if (title == null) return c.classList.remove('on');
        $('.kicker').textContent = kicker ?? '';
        $('.title').textContent = title;
        $('.sub').textContent = sub ?? '';
        $('.sub').classList.toggle('mono', !!mono);
        c.classList.add('on');
      },
    };
  };
  if (document.documentElement) install();
  else addEventListener('DOMContentLoaded', install);
  document.addEventListener('readystatechange', install);
}

// ---------------------------------------------------------------------------------------

/**
 * Opens the app and starts recording. Returns the tutorial "director": helpers that move
 * the cursor, click, caption and wait, plus finish() which writes the MP4.
 */
export async function startTutorial(name, { width = 1280, height = 720, prepare } = {}) {
  const { server, base } = await serve();
  const browser = await chromium.launch({ args: ['--disable-features=WebGPU'] });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.addInitScript(overlayInit);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  await page.route('https://huggingface.co/**', (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    if (!MODELS[file]) return route.abort();
    return route.fulfill({ status: 302, headers: { location: `${base}__model/${file}`, 'access-control-allow-origin': '*' } });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__tut);

  let view = null; // photo-to-stage transform while known: { file, z, px, py }
  let mouse = { x: width * 0.55, y: height * 0.6 };
  await page.mouse.move(mouse.x, mouse.y);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  const d = {
    page,
    base,
    wait: (ms) => page.waitForTimeout(d.instant ? Math.min(ms, 150) : ms),
    /** Seconds of reading time for a caption: about 3.3 words a second, at least 2.5 s. */
    readTime: (html) => Math.max(2500, (html.replace(/<[^>]+>/g, '').split(/\s+/).length / 3.3) * 1000),
    async caption(html, { hold, pos } = {}) {
      if (d.instant) return;
      await page.evaluate(([h, p]) => window.__tut.caption(h, p), [html, pos]);
      if (html && hold !== 0) await page.waitForTimeout(hold ?? d.readTime(html));
    },
    async card(kicker, title, sub, hold = 3500, { mono = false } = {}) {
      if (d.instant) return;
      await page.evaluate(([k, t, s, m]) => window.__tut.card(k, t, s, m), [kicker, title, sub, mono]);
      await page.waitForTimeout(hold);
      await page.evaluate(() => window.__tut.card(null, null));
      await page.waitForTimeout(600);
    },
    async ring(target, pad) {
      if (d.instant) return;
      if (!target) return page.evaluate(() => window.__tut.ring(null));
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      // The app re-renders panels often: retry if the element is replaced mid-way.
      for (let attempt = 0; ; attempt++) {
        try {
          await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
          const box = await loc.boundingBox({ timeout: 5000 });
          if (!box) throw new Error(`not visible: ${target}`);
          await page.evaluate(([b, p]) => window.__tut.ring(b, p), [box, pad]);
          return;
        } catch (e) {
          if (attempt >= 3) throw e;
          await page.waitForTimeout(300);
        }
      }
    },
    async moveTo(x, y, ms = 650) {
      if (d.instant) {
        await page.mouse.move(x, y);
        mouse = { x, y };
        return;
      }
      const from = { ...mouse };
      const steps = Math.max(8, Math.round(ms / 16));
      for (let i = 1; i <= steps; i++) {
        const k = ease(i / steps);
        await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
        await page.waitForTimeout(ms / steps);
      }
      mouse = { x, y };
    },
    /** Glides to the centre of an element (or a point inside it given as fractions). */
    async point(target, { fx = 0.5, fy = 0.5, ms } = {}) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      await loc.scrollIntoViewIfNeeded();
      const box = await loc.boundingBox();
      if (!box) throw new Error(`not visible: ${target}`);
      await d.moveTo(box.x + box.width * fx, box.y + box.height * fy, ms);
      return loc;
    },
    async click(target, opts = {}) {
      await d.point(target, opts);
      await d.wait(250);
      await page.mouse.down();
      await page.waitForTimeout(90);
      await page.mouse.up();
      await d.wait(opts.after ?? 500);
    },
    /** Clicks a button that opens a file picker and answers it with `files`. */
    async chooseFiles(target, files, opts) {
      const chooser = page.waitForEvent('filechooser');
      await d.click(target, opts);
      await (await chooser).setFiles(files);
    },
    /**
     * Screen position of a photo pixel, assuming the photo is fitted to the view (press
     * Fit first): the viewer fits the photo inside the stage with a 12 px margin.
     */
    async photoPoint(file, x, y) {
      const r = await page.locator('#canvas-stage').boundingBox();
      if (!view || view.file !== file) {
        const { width: w, height: h } = PHOTO_SIZE[file];
        const z = Math.max(0.05, Math.min(4, Math.min((r.width - 24) / w, (r.height - 24) / h)));
        view = { file, z, px: (r.width - w * z) / 2, py: (r.height - h * z) / 2 };
      }
      return { x: r.x + view.px + x * view.z, y: r.y + view.py + y * view.z };
    },
    /** Zooms by wheel notches (negative = in) about a photo pixel, tracking the view. */
    async zoomAt(file, x, y, notches, opts) {
      const p = await d.photoPoint(file, x, y);
      await d.moveTo(p.x, p.y, opts?.ms);
      const r = await page.locator('#canvas-stage').boundingBox();
      const sx = p.x - r.x, sy = p.y - r.y;
      for (let i = 0; i < Math.abs(notches); i++) {
        const f = notches < 0 ? 1.14 : 1 / 1.14;
        const z = Math.max(0.1, Math.min(24, view.z * f));
        view = { ...view, z, px: sx - (sx - view.px) * (z / view.z), py: sy - (sy - view.py) * (z / view.z) };
        await page.mouse.wheel(0, notches < 0 ? -100 : 100);
        await page.waitForTimeout(d.instant ? 30 : 110);
      }
    },
    /** Presses Fit (the view tracking then assumes the fitted photo). */
    async fit(opts) {
      await d.click('[data-action="fit-view"]', opts);
      view = null;
    },
    /** Glides to a photo pixel and clicks it. */
    async clickPhoto(file, x, y, opts = {}) {
      const p = await d.photoPoint(file, x, y);
      await d.moveTo(p.x, p.y, opts.ms);
      await d.wait(200);
      await page.mouse.down();
      await page.waitForTimeout(80);
      await page.mouse.up();
      await d.wait(opts.after ?? 400);
    },
    /** Shows a photo by clicking its row in the photo list. */
    async openPhoto(file, opts) {
      await d.click(page.locator('.photo-item', { hasText: file }).first(), opts);
      view = null;
    },
    /** Types into a field, a character at a time. */
    async type(target, text, { clear = true, delay = 90 } = {}) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      await d.click(loc, { after: 150 });
      if (clear) await loc.fill('');
      await loc.pressSequentially(text, { delay: d.instant ? 0 : delay });
    },
    /** Answers the next window.prompt() (site names) with `value`. */
    answerPrompt(value) {
      page.once('dialog', (dlg) => dlg.accept(value));
    },
    /** Clicks something that downloads a file; returns the saved file's path. */
    async download(target, opts) {
      const dl = page.waitForEvent('download');
      await d.click(target, opts);
      const file = await dl;
      const dir = join(OUT, 'downloads');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, file.suggestedFilename());
      await file.saveAs(path);
      return path;
    },
    /** Waits for the batch to end; fails unless every photo finished. */
    async waitForBatch() {
      await page.waitForFunction(() => /Batch complete|Batch error|Batch cancelled/.test(document.body.innerText), null, {
        timeout: 15 * 60 * 1000, polling: 500,
      });
      const footer = await page.evaluate(() => document.body.innerText.match(/Batch[^\n]*/)?.[0] ?? '');
      if (!/Batch complete: \d+ done, 0 failed/.test(footer)) throw new Error(`analysis failed: ${footer}`);
    },
    /** Scrolls the wheel over the cursor's position, `clicks` notches (negative zooms in). */
    async wheel(clicks, gap = 110) {
      for (let i = 0; i < Math.abs(clicks); i++) {
        await page.mouse.wheel(0, Math.sign(clicks) * 100);
        await page.waitForTimeout(gap);
      }
    },
    /** Playback speed for frames captured from now on (e.g. 8 while a model runs). */
    speed(x) {
      speed = x;
    },
    problems,
    /** While true (during prepare), moves and pauses are instant and captions are skipped. */
    instant: false,
    async finish({ fps = 30, tail = 1500 } = {}) {
      await page.waitForTimeout(tail);
      await cdp.send('Page.stopScreencast').catch(() => {});
      await browser.close();
      server.close();
      if (frames.length < 2) throw new Error('no frames captured');
      // ffmpeg concat list: each frame lasts until the next one (scaled by its speed).
      const lines = [];
      for (let i = 0; i < frames.length; i++) {
        const next = i + 1 < frames.length ? frames[i + 1].t : frames[i].t + tail / 1000;
        const dur = Math.max(0.001, (next - frames[i].t) / frames[i].speed);
        lines.push(`file '${frames[i].file}'`, `duration ${dur.toFixed(4)}`);
      }
      lines.push(`file '${frames.at(-1).file}'`);
      const list = join(frameDir, 'list.txt');
      writeFileSync(list, `${lines.join('\n')}\n`);
      const mp4 = join(OUT, `${name}.mp4`);
      execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', mp4,
      ]);
      if (!process.env.KEEP_FRAMES) rmSync(frameDir, { recursive: true, force: true });
      return mp4;
    },
  };
  if (prepare) {
    d.instant = true;
    await prepare(d);
    d.instant = false;
  }
  // Screencast frames, each with its capture time and the playback speed at that moment.
  const frameDir = join(OUT, `${name}.frames`);
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const frames = [];
  let speed = 1;
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = join(frameDir, `f${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000, speed });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const startCast = () => cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 92, maxWidth: width, maxHeight: height, everyNthFrame: 1,
  });
  await startCast();
  await page.waitForTimeout(300);
  return d;
}
