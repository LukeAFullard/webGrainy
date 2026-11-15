// Dump webGrainy's real U-Net network output (dist/: normalizeGray + runUnetInference, WASM).
// Usage: node audit/parity/dump_ours_unet.mjs <unet.onnx> <outdir> <img.rgba:W:H> [...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import * as ort from 'onnxruntime-web';
import { normalizeGray } from '../../dist/modules/imagePreprocess.js';
import { runUnetInference } from '../../dist/modules/onnxInference.js';
const [model, outdir, ...items] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 2);
const s = await ort.InferenceSession.create(readFileSync(model), { executionProviders: ['wasm'] });
for (const it of items) {
  const [p, w, h] = it.split(':'); const W = Number(w), H = Number(h);
  const o = await runUnetInference(s, normalizeGray(new Uint8ClampedArray(readFileSync(p)), W, H), W, H);
  const buf = new Float32Array(3 * W * H); buf.set(o.flowY, 0); buf.set(o.flowX, W * H); buf.set(o.cellprob, 2 * W * H);
  writeFileSync(`${outdir}/${basename(p).replace(/\.rgba$/, '')}.f32`, Buffer.from(buf.buffer));
  console.log(basename(p), 'done');
}
