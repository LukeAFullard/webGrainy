// Dump webGrainy's real Cellpose-SAM network output (dist/ build: normalizeRgbJoint99 +
// runCpsamTiledInference, WASM) for parity checks. Writes <uid>.f32 = [flowY, flowX, cellprob].
// Usage: node validation/parity/dump_ours.mjs <cpsam.onnx> <outdir> <img.rgba:W:H> [...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import * as ort from 'onnxruntime-web';
import { normalizeRgbJoint99 } from '../../dist/modules/imagePreprocess.js';
import { runCpsamTiledInference } from '../../dist/modules/onnxInference.js';
const [model, outdir, ...items] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 4);
const s = await ort.InferenceSession.create(readFileSync(model), { executionProviders: ['wasm'] });
for (const it of items) {
  const [p, w, h] = it.split(':'); const W = Number(w), H = Number(h);
  const rgba = new Uint8ClampedArray(readFileSync(p));
  const t = Date.now();
  const o = await runCpsamTiledInference(s, normalizeRgbJoint99(rgba, W, H), W, H, { batchSize: 1 });
  const buf = new Float32Array(3 * W * H); buf.set(o.flowY, 0); buf.set(o.flowX, W * H); buf.set(o.cellprob, 2 * W * H);
  writeFileSync(`${outdir}/${basename(p).replace(/\.rgba$/, '')}.f32`, Buffer.from(buf.buffer));
  console.log(basename(p), `${W}x${H}`, `${((Date.now() - t) / 1000).toFixed(0)} s`);
}
