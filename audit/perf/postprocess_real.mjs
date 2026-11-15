// Audit/perf: time each stage on a real photo (RGBA raw) with the real U-Net, CPU/WASM.
// Usage: node audit/perf/postprocess_real.mjs <unet.onnx> <rgba.raw> <width> <height> [threads]
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { normalizeGray } from '../../dist/modules/imagePreprocess.js';
import { runUnetInference } from '../../dist/modules/onnxInference.js';
import { flowsToMasksBrowser } from '../../dist/modules/postprocessCore.js';
const [model, raw, w, h, th = '4'] = process.argv.slice(2);
const W = Number(w), H = Number(h);
ort.env.wasm.numThreads = Number(th);
const rgba = new Uint8ClampedArray(readFileSync(raw));
const s = await ort.InferenceSession.create(readFileSync(model), { executionProviders: ['wasm'] });
let t = performance.now();
const out = await runUnetInference(s, normalizeGray(rgba, W, H), W, H);
const tInf = (performance.now() - t) / 1000;
t = performance.now();
const pp = flowsToMasksBrowser(out.flowY, out.flowX, out.cellprob, W, H);
const tPost = (performance.now() - t) / 1000;
console.log(JSON.stringify({ threads: Number(th), inference_s: +tInf.toFixed(2), postprocess_s: +tPost.toFixed(2), grains: pp.grainCount }));
