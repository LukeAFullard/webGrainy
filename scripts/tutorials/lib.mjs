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
        #__tut .intro{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px;background:radial-gradient(ellipse at 50% 38%,#21456f 0%,#0f172a 72%);color:#fff;opacity:0;transition:opacity .6s}
        #__tut .intro.on{opacity:1}
        #__tut .intro-logo{width:150px;height:150px;opacity:0;transform:scale(.55) rotate(-10deg);transition:transform 1s cubic-bezier(.2,1.5,.4,1),opacity .6s,width .8s,height .8s;filter:drop-shadow(0 10px 30px rgba(59,158,255,.35))}
        #__tut .intro-logo svg{width:100%;height:100%;display:block}
        #__tut .intro-brand{margin-top:22px;font-size:66px;font-weight:800;letter-spacing:-.015em;line-height:1;opacity:0;transform:translateY(16px);transition:opacity .7s .35s,transform .7s .35s,font-size .8s,margin .8s}
        #__tut .intro-brand span{color:#5ab0ff}
        #__tut .intro-tag{margin-top:14px;font-size:21px;color:#cbd5e1;letter-spacing:.02em;opacity:0;transition:opacity .7s .7s}
        #__tut .intro.s1 .intro-logo{opacity:1;transform:none}
        #__tut .intro.s1 .intro-brand,#__tut .intro.s1 .intro-tag{opacity:1;transform:none}
        #__tut .intro-rest{display:flex;flex-direction:column;align-items:center;gap:12px;max-height:0;opacity:0;overflow:hidden;transition:max-height .8s,opacity .6s .25s,margin .8s}
        #__tut .intro.s2 .intro-rest{max-height:360px;opacity:1;margin-top:30px}
        #__tut .intro.s2 .intro-logo{width:96px;height:96px}
        #__tut .intro.s2 .intro-brand{font-size:44px;margin-top:14px}
        #__tut .intro-rule{width:120px;height:3px;border-radius:2px;background:linear-gradient(90deg,#3b9eff,#2ecc71,#f5a623,#e74c3c)}
        #__tut .intro-kicker{font-size:18px;letter-spacing:.14em;text-transform:uppercase;color:#9cc3ff}
        #__tut .intro-title{font-size:44px;font-weight:700;max-width:1050px;line-height:1.15}
        #__tut .intro-sub{font-size:22px;color:#cbd5e1;max-width:900px;line-height:1.45}
        #__tut .intro-credit{position:absolute;left:0;right:0;bottom:22px;font-size:14px;color:#94a3b8;text-align:center}
        #__tut .imgpanel{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(15,23,42,.94);opacity:0;transition:opacity .5s}
        #__tut .imgpanel.on{opacity:1}
        #__tut .imgframe{width:min(1000px,84vw);height:76vh;overflow:hidden;border-radius:10px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.5)}
        #__tut .imgframe img{width:100%;display:block;transform:translateY(0)}
        #__tut .imgframe.contain{background:#0b1220}
        #__tut .imgframe.contain img{height:100%;object-fit:contain}
        #__tut .imglabel{color:#fff;font-size:20px;max-width:1000px;text-align:center}
      </style>
      <svg class="cursor" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L18.6 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>
      <div class="ring"></div>
      <div class="caption"></div>
      <div class="card"><div class="kicker"></div><div class="title"></div><div class="sub"></div></div>
      <div class="imgpanel"><div class="imgframe"><img alt=""></div><div class="imglabel"></div></div>
      <div class="intro"><div class="intro-logo"></div><div class="intro-brand">web<span>Grainy</span></div><div class="intro-tag"></div>
        <div class="intro-rest"><div class="intro-rule"></div><div class="intro-kicker"></div><div class="intro-title"></div><div class="intro-sub"></div></div><div class="intro-credit"></div></div>`;
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
      /** Full-screen brand card with the logo. stage 0 hides, 1 shows logo + name, 2 adds the text. */
      intro(stage, o = {}) {
        front();
        const c = $('.intro');
        if (o.logo) $('.intro-logo').innerHTML = o.logo;
        if (o.tag !== undefined) $('.intro-tag').textContent = o.tag;
        if (o.kicker !== undefined) $('.intro-kicker').textContent = o.kicker;
        if (o.title !== undefined) $('.intro-title').textContent = o.title;
        if (o.sub !== undefined) $('.intro-sub').textContent = o.sub;
        if (o.credit !== undefined) $('.intro-credit').textContent = o.credit;
        c.classList.toggle('on', stage > 0);
        c.classList.toggle('s1', stage > 0);
        c.classList.toggle('s2', stage > 1);
      },
      /** Shows an image (e.g. a screenshot of another tab) and optionally scrolls through it. */
      image(src, label, scrollMs) {
        front();
        const p = $('.imgpanel');
        const img = p.querySelector('img');
        if (!src) return p.classList.remove('on');
        img.style.transition = 'none';
        img.style.transform = 'translateY(0)';
        img.src = src;
        $('.imglabel').innerHTML = label ?? '';
        p.querySelector('.imgframe').classList.toggle('contain', !scrollMs);
        p.classList.add('on');
        if (scrollMs) {
          const go = () => {
            const frame = p.querySelector('.imgframe');
            const dy = Math.max(0, img.getBoundingClientRect().height - frame.getBoundingClientRect().height);
            setTimeout(() => {
              img.style.transition = `transform ${scrollMs}ms cubic-bezier(.45,0,.55,1)`;
              img.style.transform = `translateY(${-dy}px)`;
            }, 700);
          };
          if (img.complete) go(); else img.onload = go;
        }
      },
    };
  };
  if (document.documentElement) install();
  else addEventListener('DOMContentLoaded', install);
  document.addEventListener('readystatechange', install);
}

// ---------------------------------------------------------------------------------------


/** The app's logo (src/icon.svg), drawn on the intro and outro cards. */
const LOGO_SVG = readFileSync(join(ROOT, 'src', 'icon.svg'), 'utf8');
export const APP_URL = 'lukeafullard.github.io/webGrainy';
/**
 * Credit for the intro music that narrate.py adds (CC BY 4.0 asks for it), shown on the closing
 * card. TUTORIAL_MUSIC_CREDIT=0 leaves it out, for videos without that music.
 */
export const MUSIC_CREDIT = process.env.TUTORIAL_MUSIC_CREDIT === '0'
  ? ''
  : 'Music: "Inspired" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0';

/**
 * Narration pace. Captions stay on screen long enough to be read aloud by a voiceover at
 * TUTORIAL_WPS words a second (default 2.2, about 130 words a minute: the pace of the slower
 * narration voice), plus a short pause.
 */
const WPS = Number(process.env.TUTORIAL_WPS) > 0 ? Number(process.env.TUTORIAL_WPS) : 2.2;

/** Caption HTML as plain text for the transcript (D<sub>50</sub> → D50). */
export function plainText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const words = (text) => (text ? text.split(/\s+/).filter(Boolean).length : 0);

/** Milliseconds a line needs on screen to be read aloud. */
export const speakTime = (text) => Math.max(2500, (words(plainText(text)) / WPS) * 1000 + 800);

function stamp(sec, sep = ',') {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}
const short = (sec) => {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, '0')}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
};

/** Writes the on-screen text with its timing: .srt, .vtt, .transcript.md and .transcript.json. */
export function writeTranscript(name, meta, segments, duration) {
  const segs = segments.filter((x) => x.text).map((x) => ({ ...x, start: +x.start.toFixed(2), end: +Math.min(x.end, duration).toFixed(2) }));
  const srt = segs.map((x, i) => `${i + 1}\n${stamp(x.start)} --> ${stamp(x.end)}\n${x.text}\n`).join('\n');
  writeFileSync(join(OUT, `${name}.srt`), srt);
  const vtt = `WEBVTT\n\n${segs.map((x) => `${stamp(x.start, '.')} --> ${stamp(x.end, '.')}\n${x.text}\n`).join('\n')}`;
  writeFileSync(join(OUT, `${name}.vtt`), vtt);
  const json = { name, video: `${name}.mp4`, ...meta, wordsPerSecond: WPS, duration: +duration.toFixed(2), segments: segs };
  writeFileSync(join(OUT, `${name}.transcript.json`), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(join(OUT, `${name}.transcript.md`), transcriptMarkdown(json));
}

/** One video's transcript as Markdown: a timed voiceover script. */
export function transcriptMarkdown(t) {
  const lines = [
    `## ${t.index ? `${t.index}. ` : ''}${t.title}`,
    '',
    `Video \`${t.video}\` · ${short(t.duration)} long · chapter: ${t.chapter ?? '—'}`,
    '',
    '| Start | End | Time | Words | On-screen text (voiceover) |',
    '| ---: | ---: | ---: | ---: | :--- |',
    ...t.segments.map((x) => `| ${short(x.start)} | ${short(x.end)} | ${(x.end - x.start).toFixed(1)} s | ${words(x.text)} | ${x.kind === 'caption' ? '' : `*[${x.kind}]* `}${x.text.replace(/\|/g, '\\|')} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Opens the app and starts recording. Returns the tutorial "director": helpers that move
 * the cursor, click, caption and wait, plus intro(), outro() and finish() which writes the
 * MP4 and its timed transcript. `meta` = { index, total, title, chapter, summary, next }.
 */
export async function startTutorial(name, { width = 1280, height = 720, prepare, meta = {} } = {}) {
  const { server, base } = await serve();
  // Behind an HTTPS proxy (e.g. a sandbox), pages on other sites (tutorial 25) go through it.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({
    args: ['--disable-features=WebGPU'],
    ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}),
  });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, acceptDownloads: true });
  await context.addInitScript(overlayInit);
  let page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  await context.route('https://huggingface.co/**', (route) => {
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

  // Screencast frames, each with its capture time and the playback speed at that moment.
  const frameDir = join(OUT, `${name}.frames`);
  const frames = [];
  let speed = 1;
  let recording = false;

  // Video time (seconds into the MP4) of a wall-clock time, from the frames so far.
  const vt = { i: -1, at: 0 };
  const videoNow = () => {
    const t = Date.now() / 1000;
    if (!recording || frames.length === 0) return 0;
    while (vt.i + 1 < frames.length && frames[vt.i + 1].t <= t) {
      if (vt.i >= 0) vt.at += (frames[vt.i + 1].t - frames[vt.i].t) / frames[vt.i].speed;
      vt.i++;
    }
    if (vt.i < 0) return 0;
    return vt.at + Math.max(0, t - frames[vt.i].t) / frames[vt.i].speed;
  };

  // Transcript: every caption, card and title shown, with its start and end in video time.
  const segments = [];
  let open = null; // the caption on screen: { seg, need } (need = seconds to say it)
  const begin = (kind, text) => {
    const seg = { kind, text: plainText(text), start: videoNow(), end: null };
    segments.push(seg);
    return seg;
  };
  const end = (seg) => {
    if (seg && seg.end === null) seg.end = videoNow();
  };
  /** Waits until the caption on screen has been up long enough to be read aloud. */
  const letFinish = async () => {
    if (!open) return;
    for (let guard = 0; guard < 400; guard++) {
      const left = open.need - (videoNow() - open.seg.start);
      if (left <= 0.02) break;
      const s = frames.at(-1)?.speed ?? speed;
      await page.waitForTimeout(Math.min(400, Math.max(30, left * 1000 * s)));
    }
  };
  const closeCaption = async () => {
    if (!open) return;
    await letFinish();
    end(open.seg);
    open = null;
  };

  let cdp = null;
  let switchTab;
  const d = {
    page,
    context,
    base,
    meta,
    wait: (ms) => page.waitForTimeout(d.instant ? Math.min(ms, 150) : ms),
    /** Milliseconds a caption needs on screen to be read aloud (see TUTORIAL_WPS). */
    readTime: speakTime,
    /**
     * Shows a caption (HTML; null hides it). It stays up for its reading time (`hold`
     * overrides; 0 returns at once, leaving it up while the next steps run). A caption is
     * never replaced before it could be read aloud in full.
     */
    async caption(html, { hold, pos } = {}) {
      if (d.instant) return;
      await closeCaption();
      await page.evaluate(([h, p]) => window.__tut.caption(h, p), [html, pos]);
      if (!html) return;
      open = { seg: begin('caption', html), need: speakTime(html) / 1000 };
      if (hold !== 0) await page.waitForTimeout(hold ?? speakTime(html));
    },
    /** A full-screen text card. `say` is its narration (default: title, then sub). */
    async card(kicker, title, sub, hold, { mono = false, say } = {}) {
      if (d.instant) return;
      await closeCaption();
      await page.evaluate(() => window.__tut.caption(null));
      const text = say ?? [title, mono ? '' : sub].filter(Boolean).join('. ');
      await page.evaluate(([k, t, s, m]) => window.__tut.card(k, t, s, m), [kicker, title, sub, mono]);
      const seg = begin('card', text);
      await page.waitForTimeout(Math.max(hold ?? 3500, speakTime(text)));
      end(seg);
      await page.evaluate(() => window.__tut.card(null, null));
      await page.waitForTimeout(600);
    },
    /**
     * Shows an image full-screen (a PNG/JPEG Buffer, e.g. a screenshot of another tab),
     * scrolling through it if taller than the frame, with `say` as its narration.
     */
    async image(buf, { label = '', say, hold = 5000, scroll = true, type = 'jpeg' } = {}) {
      if (d.instant) return;
      await closeCaption();
      await page.evaluate(() => window.__tut.caption(null));
      const src = `data:image/${type};base64,${buf.toString('base64')}`;
      const ms = Math.max(hold, say ? speakTime(say) : 0);
      await page.evaluate(([s, l, sc]) => window.__tut.image(s, l, sc), [src, label, scroll ? ms - 1400 : 0]);
      const seg = begin('image', say ?? plainText(label));
      await page.waitForTimeout(ms);
      end(seg);
      await page.evaluate(() => window.__tut.image(null));
      await page.waitForTimeout(600);
    },
    /** Opening title: the logo and name, then the tutorial's number, title and summary. */
    async intro() {
      const { index, total, title, chapter, summary } = meta;
      const kicker = [index && total ? `Tutorial ${index} of ${total}` : 'Tutorial', chapter].filter(Boolean).join(' · ');
      await page.evaluate(([o]) => window.__tut.intro(1, o), [{
        logo: LOGO_SVG, tag: 'Grain sizes from photos · runs in your browser', kicker, title: title ?? '', sub: summary ?? '', credit: '',
      }]);
      const say = `webGrainy. ${index ? `Tutorial ${index}: ` : ''}${title ?? ''}.${summary ? ` ${summary}` : ''}`;
      const seg = begin('title', say);
      await page.waitForTimeout(1900);
      await page.evaluate(() => window.__tut.intro(2));
      await page.waitForTimeout(Math.max(3800, speakTime(say) - 1900));
      end(seg);
      await page.evaluate(() => window.__tut.intro(0));
      await page.waitForTimeout(700);
    },
    /** Closing card: the logo, the app's address and the next tutorial. */
    async outro() {
      await closeCaption();
      await page.evaluate(() => {
        window.__tut.caption(null);
        window.__tut.ring(null);
      });
      const next = meta.next;
      const o = {
        logo: LOGO_SVG, tag: APP_URL, credit: MUSIC_CREDIT,
        kicker: next ? 'Next' : 'End of the series',
        title: next ?? 'Thanks for watching',
        sub: next ? '' : 'Help (top right) explains every setting.',
      };
      await page.evaluate(([x]) => window.__tut.intro(1, x), [o]);
      const say = next ? `Next: ${next}.` : 'That is the end of the tutorial series. Thanks for watching.';
      const seg = begin('end', say);
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.__tut.intro(2));
      await page.waitForTimeout(Math.max(3500, speakTime(say)));
      end(seg);
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
    /** Highlights a screen rectangle { x, y, width, height }. */
    async ringRect(rect, pad) {
      if (d.instant) return;
      await page.evaluate(([b, p]) => window.__tut.ring(b, p), [rect, pad]);
    },
    /** Highlights a rectangle of a photo, given in photo pixels (the photo must be fitted). */
    async ringPhoto(file, x0, y0, x1, y1, pad) {
      const a = await d.photoPoint(file, x0, y0);
      const b = await d.photoPoint(file, x1, y1);
      await d.ringRect({ x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }, pad);
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
      // The app re-renders panels often: retry if the element is replaced mid-way.
      for (let attempt = 0; ; attempt++) {
        try {
          await loc.scrollIntoViewIfNeeded({ timeout: 10000 });
          const box = await loc.boundingBox({ timeout: 10000 });
          if (!box) throw new Error(`not visible: ${target}`);
          await d.moveTo(box.x + box.width * fx, box.y + box.height * fy, ms);
          return loc;
        } catch (e) {
          if (attempt >= 4) throw e;
          await page.waitForTimeout(400);
        }
      }
    },
    async click(target, opts = {}) {
      await d.point(target, opts);
      await d.wait(250);
      await page.mouse.down();
      await page.waitForTimeout(90);
      await page.mouse.up();
      await d.wait(opts.after ?? 500);
    },
    /** Chooses an option of a <select> with a visible click on it first. */
    async select(target, value, opts = {}) {
      const loc = typeof target === 'string' ? page.locator(target).first() : target;
      await d.point(loc, opts);
      await d.wait(300);
      await loc.selectOption(value);
      await d.wait(opts.after ?? 700);
    },
    /**
     * Opens `url` in a new tab in the background (the video stays on the current tab until
     * showTab). Returns the tab.
     */
    async openTab(url, { waitUntil = 'load' } = {}) {
      const tab = await context.newPage();
      await tab.goto(url, { waitUntil, timeout: 120000 });
      await page.bringToFront();
      return tab;
    },
    /** Cuts the video to another tab (from openTab) and makes it the tab the helpers drive. */
    async showTab(tab) {
      await switchTab(tab);
    },
    /** Glides to a screen position and clicks there (for apps drawn on a canvas). */
    async clickAt(x, y, { button = 'left', ms, after = 600 } = {}) {
      await d.moveTo(x, y, ms);
      await d.wait(200);
      await page.mouse.down({ button });
      await page.waitForTimeout(90);
      await page.mouse.up({ button });
      await d.wait(after);
    },
    /** Clicks a screen position that opens a file picker and answers it with `files`. */
    async chooseFilesAt(x, y, files, opts) {
      const chooser = page.waitForEvent('filechooser', { timeout: 30000 });
      await d.clickAt(x, y, opts);
      await (await chooser).setFiles(files);
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
    /** Forgets the photo-to-screen transform (after the layout of the view changed). */
    resetView() {
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
    /** Drags through photo pixels with the button held (e.g. the exclusion brush). */
    async dragPhoto(file, points, { ms = 1500 } = {}) {
      const pts = [];
      for (const [x, y] of points) pts.push(await d.photoPoint(file, x, y));
      await d.moveTo(pts[0].x, pts[0].y, 700);
      await page.mouse.down();
      const per = ms / Math.max(1, pts.length - 1);
      for (let i = 1; i < pts.length; i++) await d.moveTo(pts[i].x, pts[i].y, per);
      await page.mouse.up();
      await d.wait(500);
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
    /** Answers the next window.prompt() or confirm() with `value`. */
    answerPrompt(value) {
      page.once('dialog', (dlg) => dlg.accept(value));
    },
    /** Clicks something that downloads a file; returns the saved file's path. */
    async download(target, opts) {
      const dl = page.waitForEvent('download', { timeout: 120000 });
      await d.click(target, opts);
      const file = await dl;
      const dir = join(OUT, 'downloads');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, file.suggestedFilename());
      await file.saveAs(path);
      return path;
    },
    /** Clicks something that opens a new tab; returns that page once loaded. */
    async popup(target, opts) {
      const p = context.waitForEvent('page', { timeout: 120000 });
      await d.click(target, opts);
      const tab = await p;
      await tab.waitForLoadState('load');
      await page.bringToFront();
      return tab;
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
    /** Scrolls a panel (by element id) smoothly to `top` pixels. */
    async scrollPanel(id, top, ms = 700) {
      await page.evaluate(([i, t]) => document.getElementById(i)?.scrollTo({ top: t, behavior: 'smooth' }), [id, top]);
      await d.wait(ms);
    },
    /** Playback speed for frames captured from now on (e.g. 8 while a model runs). */
    speed(x) {
      speed = x;
    },
    videoNow,
    problems,
    /** While true (during prepare), moves and pauses are instant and captions are skipped. */
    instant: false,
    async finish({ fps = 30, tail = 1200 } = {}) {
      await closeCaption();
      await page.waitForTimeout(tail);
      const stopT = Date.now() / 1000;
      const duration = videoNow();
      for (const seg of segments) if (seg.end === null) seg.end = duration;
      await cdp.send('Page.stopScreencast').catch(() => {});
      await browser.close();
      server.close();
      if (frames.length < 2) throw new Error('no frames captured');
      // ffmpeg concat list: each frame lasts until the next one (scaled by its speed); the
      // last until recording stopped.
      const lines = [];
      for (let i = 0; i < frames.length; i++) {
        const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(stopT, frames[i].t + 0.05);
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
      writeTranscript(name, {
        index: meta.index, total: meta.total, title: meta.title, chapter: meta.chapter, summary: meta.summary,
      }, segments, duration);
      if (!process.env.KEEP_FRAMES) rmSync(frameDir, { recursive: true, force: true });
      return mp4;
    },
  };
  if (prepare) {
    d.instant = true;
    await prepare(d);
    d.instant = false;
  }
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  // Frame times come from Date.now() when each frame arrives, the same clock videoNow() uses.
  const startCast = async (p) => {
    const session = await context.newCDPSession(p);
    session.on('Page.screencastFrame', async ({ data, sessionId }) => {
      if (session !== cdp) return;
      const file = join(frameDir, `f${String(frames.length).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ file, t: Date.now() / 1000, speed });
      await session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    cdp = session;
    await session.send('Page.startScreencast', {
      format: 'jpeg', quality: 92, maxWidth: width, maxHeight: height, everyNthFrame: 1,
    });
  };
  /** Records another tab from now on (the video cuts to it), and points the helpers at it. */
  switchTab = async (p) => {
    await closeCaption();
    const old = cdp;
    cdp = null;
    await old?.send('Page.stopScreencast').catch(() => {});
    await old?.detach().catch(() => {});
    page = p;
    d.page = p;
    view = null;
    await p.bringToFront();
    await startCast(p);
    await p.mouse.move(mouse.x, mouse.y);
  };
  await startCast(page);
  recording = true;
  await page.waitForTimeout(300);
  return d;
}
