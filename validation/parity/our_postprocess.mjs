// Turn dumped network outputs into masks with webGrainy's own post-processor
// (flowsToMasksBrowser, app defaults), as the app does. Writes <uid>.i32 next to inputs.
// Usage: node validation/parity/our_postprocess.mjs <dir> <img.rgba:W:H> [...]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { flowsToMasksBrowser, DEFAULT_POSTPROCESS_OPTIONS } from '../../dist/modules/postprocessCore.js';
const [dir, ...items] = process.argv.slice(2);
for (const it of items) {
  const [p, w, h] = it.split(':'); const W = Number(w), H = Number(h); const n = W * H;
  const uid = basename(p).replace(/\.rgba$/, '');
  const a = new Float32Array(readFileSync(`${dir}/${uid}.f32`).buffer.slice(0));
  const r = flowsToMasksBrowser(a.subarray(0, n), a.subarray(n, 2 * n), a.subarray(2 * n, 3 * n), W, H, { ...DEFAULT_POSTPROCESS_OPTIONS });
  writeFileSync(`${dir}/${uid}.i32`, Buffer.from(r.masks.buffer));
}
console.log('done', dir);
