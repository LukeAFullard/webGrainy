// K1 investigation: run the shipped engine code (dist/) on a K1 photo with the pinned
// model on the WASM backend, at full resolution, and dump masks + per-grain metrics.
// Usage: node validation/k1/run_engine_k1.mjs <unet|cpsam> <model.onnx> <img.rgba> <w> <h> <outPrefix>
import { readFileSync, writeFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { normalizeGray, normalizeRgbJoint99 } from '../../dist/modules/imagePreprocess.js';
import { runUnetInference, runCpsamTiledInference } from '../../dist/modules/onnxInference.js';
import { flowsToMasksBrowser, DEFAULT_POSTPROCESS_OPTIONS } from '../../dist/modules/postprocessCore.js';
import { computeExtendedMorphometrics } from '../../dist/modules/morphometricsExt.js';
const [kind, model, raw, w, h, outPrefix] = process.argv.slice(2);
const W = Number(w), H = Number(h);
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 4);
const rgba = new Uint8ClampedArray(readFileSync(raw));
const s = await ort.InferenceSession.create(readFileSync(model), { executionProviders: ['wasm'] });
const t0 = Date.now();
const inf = kind === 'unet'
  ? await runUnetInference(s, normalizeGray(rgba, W, H), W, H)
  : await runCpsamTiledInference(s, normalizeRgbJoint99(rgba, W, H), W, H, { batchSize: Number(process.env.BATCH ?? 1), onProgress: (p) => process.stderr.write(`\r${p.percent}%`) });
const pp = flowsToMasksBrowser(inf.flowY, inf.flowX, inf.cellprob, W, H, { ...DEFAULT_POSTPROCESS_OPTIONS });
const ext = computeExtendedMorphometrics(pp.masks, pp.grains, W, H, 1);
writeFileSync(`${outPrefix}_masks.i32`, Buffer.from(pp.masks.buffer));
writeFileSync(`${outPrefix}_grains.json`, JSON.stringify({ W, H, kind, params: DEFAULT_POSTPROCESS_OPTIONS,
  grains: ext.map((g) => ({ id: g.id, area: g.areaPx, cx: g.centroidX, cy: g.centroidY, b: g.bAxisPx, a: g.aAxisPx, deq: g.dEqPx, minFeret: g.minFeretPx, border: g.touchesBorder })) }));
console.log(`\n${kind} ${outPrefix}: ${pp.grainCount} grains in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
