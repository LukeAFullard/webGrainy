// Audit: can onnxruntime-web's WASM (CPU) EP run the native-FP16 CP-SAM graph?
// This is the fallback path when a WebGPU adapter lacks shader-f16.
// Usage: node audit/followup2/cpsam_wasm_fp16.mjs <ig2_cpsam_fp16.onnx>
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { float32ArrayToFloat16Bits, float16BitsToFloat32Array } from '../../dist/modules/onnxInference.js';
ort.env.wasm.numThreads = 1;
const bytes = readFileSync(process.argv[2]);
const t0 = Date.now();
let session;
try {
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  console.log(`session created in ${((Date.now() - t0) / 1000).toFixed(1)} s; inputs=${session.inputNames} outputs=${session.outputNames}`);
} catch (e) { console.log('SESSION CREATE FAILED:', String(e).slice(0, 400)); process.exit(0); }
const n = 3 * 256 * 256; const x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.001) * 0.5;
const t1 = Date.now();
try {
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float16', float32ArrayToFloat16Bits(x), [1, 3, 256, 256]) });
  const o = out[session.outputNames[0]];
  const data = o.data instanceof Uint16Array ? float16BitsToFloat32Array(o.data) : Float32Array.from(o.data);
  let finite = 0; for (const v of data) if (Number.isFinite(v)) finite++;
  console.log(`tile run OK in ${((Date.now() - t1) / 1000).toFixed(1)} s; out dims=${o.dims} type=${o.type} finite=${finite}/${data.length}`);
} catch (e) { console.log('RUN FAILED:', String(e).slice(0, 400)); }
