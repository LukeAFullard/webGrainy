// Dump network outputs of the upstream-exact Cellpose pipelines in dist/
// (runUnetCellposeInference / runCpsamCellposeInference), WASM backend.
// Usage: node validation/parity/dump_ours_cellpose.mjs <unet|cpsam> <model.onnx> <outdir> <img.rgba:W:H> [...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import * as ort from 'onnxruntime-web';
import { runUnetCellposeInference, runCpsamCellposeInference } from '../../dist/modules/onnxInference.js';
const [kind, model, outdir, ...items] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 4);
const s = await ort.InferenceSession.create(readFileSync(model), { executionProviders: ['wasm'] });
for (const it of items) {
  const [p, w, h] = it.split(':'); const W = Number(w), H = Number(h);
  const rgba = new Uint8ClampedArray(readFileSync(p));
  const t = Date.now();
  const o = kind === 'unet'
    ? await runUnetCellposeInference(s, rgba, W, H)
    : await runCpsamCellposeInference(s, rgba, W, H);
  const buf = new Float32Array(3 * W * H); buf.set(o.flowY, 0); buf.set(o.flowX, W * H); buf.set(o.cellprob, 2 * W * H);
  writeFileSync(`${outdir}/${basename(p).replace(/\.rgba$/, '')}.f32`, Buffer.from(buf.buffer));
  console.log(kind, basename(p), `${((Date.now() - t) / 1000).toFixed(0)} s`);
}
