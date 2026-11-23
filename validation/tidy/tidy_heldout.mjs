#!/usr/bin/env node
// "Tidy outlines" (optional clean-up, src/modules/tidyGrains.ts) on the 40 held-out test images of
// the ImageGrains 2.0 data: the app's default analysis (as validation/heldout/run_app_heldout.mjs),
// then the same photos tidied. Compares outline agreement (PQ) and D50 error against the hand
// outlines before and after, counts fragments and holes, and renders before/after examples.
//
//   npm run build
//   python3 -I validation/parity/fetch_ig2_files.py .cache/ig2 <test image and mask paths from heldout_manifest.csv>
//   node validation/tidy/tidy_heldout.mjs unet        # or cpsam (INT8 weights, slow on CPU)
//
// Resumable: each image's result (and its before / after masks, for the examples) is cached in
// .cache/tidy_<model>/, and a run with MAX_MINUTES=<n> stops after about n minutes; run it again to
// continue. Writes validation/tidy/tidy_results_<model>.md, tidy_per_image_<model>.csv and example
// PNGs once all 40 images are done.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as ort from 'onnxruntime-web';
import { chromium } from 'playwright';
import UTIF from 'utif2';
import { APP_VERSION, ImageGrainsEngine, computeAllGrainMorphometrics, computeSedimentStats } from '../../dist/index.js';
import { resizeLabelsNearest } from '../../dist/modules/exportFormats.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const OUT = join(ROOT, 'validation', 'tidy');
const kind = process.argv[2] === 'cpsam' ? 'cpsam' : 'unet';
const MODEL_REV = '98e76b1374dc22cfff8193aca71c308f2b4dd3b3';
const WEIGHTS = kind === 'unet'
  ? ['ig2_unet_fp32.onnx', '5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c']
  : ['ig2_cpsam_int8_wo_fp32scale.onnx', '2cda0be5b81f1d0c0ac36998beb9f741e11833aacd089c4f5cee92488bab6f43'];
const weightsPath = join(ROOT, '.cache', `${WEIGHTS[0].replace(/\.onnx$/, '')}.${MODEL_REV.slice(0, 8)}.onnx`);
if (!existsSync(weightsPath)) {
  const r = await fetch(`https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REV}/${WEIGHTS[0]}`);
  writeFileSync(weightsPath, Buffer.from(await r.arrayBuffer()));
}
if (createHash('sha256').update(readFileSync(weightsPath)).digest('hex') !== WEIGHTS[1]) throw new Error('model SHA-256 mismatch');

const rows = readFileSync(join(ROOT, 'validation/heldout/heldout_manifest.csv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split(',')).filter((c) => c[2] === 'test').map((c) => ({ uid: c[0], site: c[1], image: c[3], mask: c[4] }));
const local = (p) => join(ROOT, '.cache', 'ig2', p.replaceAll('/', '__')); // fetch_ig2_files.py flattens paths
const CACHE = join(ROOT, '.cache', `tidy_${kind}`);
mkdirSync(CACHE, { recursive: true });
const MAX_MS = Number(process.env.MAX_MINUTES ?? Infinity) * 60_000;
const t0 = Date.now();
const i32 = (path) => { const b = readFileSync(path); return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

const browser = await chromium.launch();
const page = await browser.newPage();
async function decode(path) {
  const out = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    const px = c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
    let s = '';
    for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000));
    return { w: bmp.width, h: bmp.height, rgba: btoa(s) };
  }, readFileSync(path).toString('base64'));
  return { width: out.w, height: out.h, data: new Uint8ClampedArray(Buffer.from(out.rgba, 'base64')) };
}

/** Hand-outline label mask (TIFF, 8/16/32-bit integers). */
function readMask(path) {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ifd = UTIF.decode(ab)[0];
  UTIF.decodeImage(ab, ifd);
  const w = ifd.width, h = ifd.height, bps = ifd.t258?.[0] ?? 8, d = ifd.data;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const little = new Uint8Array(ab)[0] === 0x49;
  const out = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = bps === 8 ? d[i] : bps === 16 ? dv.getUint16(i * 2, little) : dv.getUint32(i * 4, little);
  return { w, h, labels: out };
}

/** Panoptic quality: grains matched one-to-one at IoU > 0.5. */
function pq(gt, pred) {
  const area = (m) => { const a = new Map(); for (const v of m) if (v > 0) a.set(v, (a.get(v) ?? 0) + 1); return a; };
  const ag = area(gt), ap = area(pred);
  const inter = new Map();
  for (let i = 0; i < gt.length; i++) if (gt[i] > 0 && pred[i] > 0) { const k = gt[i] * 4294967296 + pred[i]; inter.set(k, (inter.get(k) ?? 0) + 1); }
  let tp = 0, iouSum = 0;
  for (const [k, n] of inter) {
    const g = Math.floor(k / 4294967296), p = k - g * 4294967296;
    const iou = n / (ag.get(g) + ap.get(p) - n);
    if (iou > 0.5) { tp++; iouSum += iou; }
  }
  const fp = ap.size - tp, fn = ag.size - tp;
  return tp + fp + fn === 0 ? 1 : iouSum / (tp + 0.5 * fp + 0.5 * fn);
}

const d50 = (grains) => computeSedimentStats(grains, { excludeBorder: true, sizeMetric: 'bAxis', minBaxisPx: 15 }).areaWeightedB.D50;
const err = (a, g) => (Number.isFinite(a) && Number.isFinite(g) && g > 0 ? (Math.abs(a - g) / g) * 100 : NaN);
const median = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const mean = (v) => { const s = v.filter(Number.isFinite); return s.reduce((a, b) => a + b, 0) / s.length; };

/** Counts grains made of more than one 4-connected part, and enclosed holes, without changing the mask. */
function partsOf(masks, w) {
  const parts = new Map();
  const seen = new Uint8Array(masks.length);
  for (let s = 0; s < masks.length; s++) {
    const l = masks[s];
    if (l <= 0 || seen[s]) continue;
    parts.set(l, (parts.get(l) ?? 0) + 1);
    const q = [s]; seen[s] = 1;
    while (q.length) { const p = q.pop(); const x = p % w; for (const n of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (n >= 0 && n < masks.length && !seen[n] && masks[n] === l) { seen[n] = 1; q.push(n); } }
  }
  return [...parts.values()].filter((n) => n > 1).length;
}

ort.env.wasm.numThreads = Number(process.env.THREADS ?? 4);
const engine = new ImageGrainsEngine({
  useWorker: false,
  sessionFactory: async () => ort.InferenceSession.create(readFileSync(weightsPath), { executionProviders: ['wasm'] }),
});
await engine.initialize();

const results = [];
const examples = [];
let stopped = false;
for (const [i, row] of rows.entries()) {
  const cached = join(CACHE, `${row.uid}.json`);
  if (existsSync(cached)) {
    const { r, wi } = JSON.parse(readFileSync(cached, 'utf8'));
    results.push(r);
    examples.push({ r, row, wi });
    continue;
  }
  if (Date.now() - t0 > MAX_MS) {
    stopped = true;
    break;
  }
  const img = await decode(local(row.image));
  const gt = readMask(local(row.mask));
  const session = await engine.analyzeImage(img, { model: kind, cpsamWeights: 'int8', scaleMode: 'auto' });
  const wi = session.workingImage;
  const atPhoto = () => resizeLabelsNearest(session.getWorkingMasks(), wi.width, wi.height, wi.originalWidth, wi.originalHeight);
  const gtD50 = d50(computeAllGrainMorphometrics(gt.labels, gt.w, gt.h, 2));
  const before = { masks: atPhoto(), working: session.getWorkingMasks().slice(), d50: session.getStats('bAxis', { minBaxisPx: 15 }).areaWeightedB.D50, grains: session.getResult().grainCount };
  const multipart = partsOf(before.working, wi.width);
  const t = session.tidyOutlines();
  const after = { masks: atPhoto(), d50: session.getStats('bAxis', { minBaxisPx: 15 }).areaWeightedB.D50, grains: session.getResult().grainCount };
  const r = {
    uid: row.uid, site: row.site, grains: before.grains, multipartGrains: multipart,
    merged: t?.fragmentsMerged ?? 0, removed: t?.fragmentsRemoved ?? 0, splitOff: t?.fragmentsSplitOff ?? 0, holes: t?.holesFilled ?? 0,
    changedPct: t ? (t.changedPixels / (wi.width * wi.height)) * 100 : 0,
    pqBefore: pq(gt.labels, before.masks), pqAfter: pq(gt.labels, after.masks),
    d50ErrBefore: err(before.d50, gtD50), d50ErrAfter: err(after.d50, gtD50), d50ChangePct: ((after.d50 - before.d50) / before.d50) * 100,
  };
  results.push(r);
  const wiDims = { width: wi.width, height: wi.height };
  writeFileSync(join(CACHE, `${row.uid}.before.i32`), Buffer.from(before.working.buffer));
  writeFileSync(join(CACHE, `${row.uid}.after.i32`), Buffer.from(session.getWorkingMasks().slice().buffer));
  writeFileSync(cached, JSON.stringify({ r, wi: wiDims }));
  examples.push({ r, row, wi: wiDims });
  console.log(`${i + 1}/${rows.length} ${row.uid}: ${multipart} multi-part grains, ${r.merged}+${r.removed}+${r.splitOff} fragments, ${r.holes} holes; PQ ${r.pqBefore.toFixed(3)} -> ${r.pqAfter.toFixed(3)}; D50 err ${r.d50ErrBefore.toFixed(1)}% -> ${r.d50ErrAfter.toFixed(1)}%`);
}

if (stopped) {
  await browser.close();
  console.log(`Stopped after ${((Date.now() - t0) / 60_000).toFixed(0)} min: ${results.length} of ${rows.length} images done (cached in ${CACHE}). Run again to continue.`);
  process.exit(0);
}

// Before / after examples: the photos with the most multi-part grains, around the worst grain.
async function render(ex, file) {
  const { wi } = ex;
  const img = await decode(local(ex.row.image));
  const beforeMasks = i32(join(CACHE, `${ex.r.uid}.before.i32`));
  const afterMasks = i32(join(CACHE, `${ex.r.uid}.after.i32`));
  // Bounding box of the first grain with the most parts, padded.
  const ww = wi.width;
  const counts = new Map();
  const seen = new Uint8Array(beforeMasks.length);
  const box = new Map();
  for (let s = 0; s < beforeMasks.length; s++) {
    const l = beforeMasks[s];
    if (l <= 0) continue;
    const x = s % ww, y = (s - x) / ww;
    const b = box.get(l) ?? [x, y, x, y];
    box.set(l, [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]);
    if (seen[s]) continue;
    counts.set(l, (counts.get(l) ?? 0) + 1);
    const q = [s]; seen[s] = 1;
    while (q.length) { const p = q.pop(); const px = p % ww; for (const n of [px > 0 ? p - 1 : -1, px < ww - 1 ? p + 1 : -1, p - ww, p + ww]) if (n >= 0 && n < beforeMasks.length && !seen[n] && beforeMasks[n] === l) { seen[n] = 1; q.push(n); } }
  }
  const worst = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const [x0, y0, x1, y1] = box.get(worst);
  const pad = Math.max(12, Math.round((x1 - x0) * 0.6));
  const crop = [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(wi.width - 1, x1 + pad), Math.min(wi.height - 1, y1 + pad)];
  const png = await page.evaluate(async (a) => {
    const { w, h, rgbaB64, ws, hs, before, after, crop, worst, title } = a;
    const rgba = Uint8ClampedArray.from(atob(rgbaB64), (c) => c.charCodeAt(0));
    const toArr = (b64) => new Int32Array(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    const mb = toArr(before), ma = toArr(after);
    const photo = new OffscreenCanvas(w, h);
    photo.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    const [cx0, cy0, cx1, cy1] = crop;
    const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
    const S = Math.max(1, Math.floor(420 / Math.max(cw, ch))); // 1x for a large crop keeps the PNG small
    const sx = w / ws, sy = h / hs; // photo px per working px
    const pane = (masks, label) => {
      const c = new OffscreenCanvas(cw * S, ch * S + 22);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = true;
      g.drawImage(photo, cx0 * sx, cy0 * sy, cw * sx, ch * sy, 0, 22, cw * S, ch * S);
      // Grain fill (semi-transparent) and boundaries, per working pixel.
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const l = masks[(cy0 + y) * ws + cx0 + x];
        if (l <= 0) continue;
        g.fillStyle = l === worst ? 'rgba(0, 200, 255, 0.45)' : 'rgba(255, 140, 60, 0.30)';
        g.fillRect(x * S, 22 + y * S, S, S);
      }
      g.strokeStyle = '#111'; g.lineWidth = 1;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const l = masks[(cy0 + y) * ws + cx0 + x];
        if (l <= 0) continue;
        const at = (dx, dy) => { const X = cx0 + x + dx, Y = cy0 + y + dy; return X < 0 || Y < 0 || X >= ws || Y >= hs ? -1 : masks[Y * ws + X]; };
        g.beginPath();
        if (at(-1, 0) !== l) { g.moveTo(x * S, 22 + y * S); g.lineTo(x * S, 22 + (y + 1) * S); }
        if (at(1, 0) !== l) { g.moveTo((x + 1) * S, 22 + y * S); g.lineTo((x + 1) * S, 22 + (y + 1) * S); }
        if (at(0, -1) !== l) { g.moveTo(x * S, 22 + y * S); g.lineTo((x + 1) * S, 22 + y * S); }
        if (at(0, 1) !== l) { g.moveTo(x * S, 22 + (y + 1) * S); g.lineTo((x + 1) * S, 22 + (y + 1) * S); }
        g.stroke();
      }
      g.fillStyle = '#111'; g.font = '600 14px system-ui, sans-serif';
      g.fillText(label, 6, 16);
      return c;
    };
    const pb = pane(mb, 'Before (as analysed)');
    const pa = pane(ma, 'After Tidy outlines');
    const [l1, l2] = title.split(' | ');
    // Wide enough for the caption, so it is never cut off on a narrow crop.
    const font = '12px system-ui, sans-serif';
    const m = new OffscreenCanvas(1, 1).getContext('2d');
    m.font = font;
    const textW = Math.ceil(Math.max(m.measureText(l1).width, m.measureText(l2 ?? '').width)) + 12;
    const out = new OffscreenCanvas(Math.max(pb.width * 2 + 12, textW), pb.height + 44);
    const g = out.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(pb, 0, 0); g.drawImage(pa, pb.width + 12, 0);
    g.fillStyle = '#444'; g.font = font;
    g.fillText(l1, 6, out.height - 26);
    g.fillText(l2 ?? '', 6, out.height - 8);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, {
    w: img.width, h: img.height, rgbaB64: Buffer.from(img.data.buffer).toString('base64'), ws: wi.width, hs: wi.height,
    before: Buffer.from(beforeMasks.buffer).toString('base64'), after: Buffer.from(afterMasks.buffer).toString('base64'),
    crop, worst,
    title: `${ex.r.uid} (${kind === 'unet' ? 'U-Net' : 'Cellpose-SAM INT8'}), held-out test image; the grain with the most pieces in blue | In this photo: ${ex.r.merged} fragments joined a neighbouring grain, ${ex.r.removed} removed, ${ex.r.holes} holes filled; PQ ${ex.r.pqBefore.toFixed(3)} -> ${ex.r.pqAfter.toFixed(3)}`,
  });
  writeFileSync(file, Buffer.from(png, 'base64'));
}
mkdirSync(OUT, { recursive: true });
const top = [...examples].sort((a, b) => b.r.multipartGrains - a.r.multipartGrains).slice(0, 3);
for (const [k, ex] of top.entries()) await render(ex, join(OUT, `example_${kind}_${k + 1}.png`));
await browser.close();

// Results.
const n = results.length;
const imgsWith = results.filter((r) => r.multipartGrains > 0 || r.holes > 0).length;
const pqD = results.map((r) => r.pqAfter - r.pqBefore);
const d50D = results.map((r) => r.d50ErrAfter - r.d50ErrBefore);
const csv = ['uid,site,grains,multipart_grains,fragments_merged,fragments_removed,fragments_split_off,holes_filled,changed_pixels_pct,pq_before,pq_after,d50_err_before_pct,d50_err_after_pct,d50_change_pct',
  ...results.map((r) => [r.uid, r.site, r.grains, r.multipartGrains, r.merged, r.removed, r.splitOff, r.holes, r.changedPct.toFixed(4), r.pqBefore.toFixed(4), r.pqAfter.toFixed(4), r.d50ErrBefore.toFixed(3), r.d50ErrAfter.toFixed(3), r.d50ChangePct.toFixed(3)].join(','))].join('\n');
writeFileSync(join(OUT, `tidy_per_image_${kind}.csv`), `${csv}\n`);
const md = `# Tidy outlines on the held-out test images (${kind === 'unet' ? 'U-Net' : 'Cellpose-SAM INT8'})

webGrainy ${APP_VERSION}, default analysis (Cellpose pipeline, Auto image scale, CPU/WASM), 40 test images of the
ImageGrains 2.0 data (13 sites), then **Tidy outlines** on the same masks. PQ: outline agreement with the hand outlines
(grains matched at IoU > 0.5). D50 error: area-weighted b-axis D50 (interior grains, 15 px cutoff, photo px) against the
same statistic of the hand outlines. Produced by \`validation/tidy/tidy_heldout.mjs\`; per image: \`tidy_per_image_${kind}.csv\`.

| | Before | After Tidy |
|---|---:|---:|
| Mean PQ | ${mean(results.map((r) => r.pqBefore)).toFixed(3)} | ${mean(results.map((r) => r.pqAfter)).toFixed(3)} |
| Median D50 error | ${median(results.map((r) => r.d50ErrBefore)).toFixed(1)}% | ${median(results.map((r) => r.d50ErrAfter)).toFixed(1)}% |
| Mean D50 error | ${mean(results.map((r) => r.d50ErrBefore)).toFixed(1)}% | ${mean(results.map((r) => r.d50ErrAfter)).toFixed(1)}% |

- Images with detached fragments or enclosed holes: ${imgsWith} of ${n}; grains made of more than one piece: ${results.reduce((s, r) => s + r.multipartGrains, 0)} of ${results.reduce((s, r) => s + r.grains, 0)}.
- Fragments: ${results.reduce((s, r) => s + r.merged, 0)} joined a neighbouring grain, ${results.reduce((s, r) => s + r.removed, 0)} removed, ${results.reduce((s, r) => s + r.splitOff, 0)} became grains of their own; ${results.reduce((s, r) => s + r.holes, 0)} holes filled.
- Pixels changed: median ${median(results.map((r) => r.changedPct)).toFixed(3)}% of an image (max ${Math.max(...results.map((r) => r.changedPct)).toFixed(3)}%).
- Change per image (after − before): PQ median ${median(pqD).toFixed(4)} (range ${Math.min(...pqD).toFixed(4)} to ${Math.max(...pqD).toFixed(4)}); D50 error median ${median(d50D).toFixed(2)} percentage points (range ${Math.min(...d50D).toFixed(2)} to ${Math.max(...d50D).toFixed(2)}); D50 itself median ${median(results.map((r) => r.d50ChangePct)).toFixed(2)}%.

Examples (the photos with the most multi-part grains): ${top.map((_, k) => `\`example_${kind}_${k + 1}.png\``).join(', ')}.
`;
writeFileSync(join(OUT, `tidy_results_${kind}.md`), md);
console.log(md);
