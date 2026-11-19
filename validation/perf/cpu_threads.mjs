// Audit/perf: where does CPU time go, and how much do WASM threads help?
// Measures U-Net inference (1024x768), CP-SAM one 256x256 tile, and post-processing,
// at several ort.env.wasm.numThreads settings. Each thread count runs in a fresh
// process because ORT fixes the thread pool at first session creation.
// Usage: node validation/perf/cpu_threads.mjs <unet.onnx> <cpsam.onnx> [threads...]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [unet, cpsam, ...ts] = process.argv.slice(2);
if (process.env.CHILD) {
  const ort = await import('onnxruntime-web');
  const { readFileSync } = await import('node:fs');
  const { float32ArrayToFloat16Bits } = await import('../../dist/modules/onnxInference.js');
  const { flowsToMasksBrowser } = await import('../../dist/modules/postprocessCore.js');
  ort.env.wasm.numThreads = Number(process.env.CHILD);
  const out = {};
  const W = 1024, H = 768; // U-Net needs multiples of 16
  const s1 = await ort.InferenceSession.create(readFileSync(unet), { executionProviders: ['wasm'] });
  const x = new Float32Array(2 * W * H); for (let i = 0; i < W * H; i++) x[i] = 0.5 + 0.4 * Math.sin(i * 0.013) * Math.cos(i * 0.0007);
  await s1.run({ image: new ort.Tensor('float32', x.slice(0, 2 * 64 * 64), [1, 2, 64, 64]) }); // warm-up
  let t = performance.now();
  const r = await s1.run({ image: new ort.Tensor('float32', x, [1, 2, H, W]) });
  out.unet_1024x768_s = (performance.now() - t) / 1000;
  const o = r[s1.outputNames[0]].data; const n = W * H;
  t = performance.now();
  const pp = flowsToMasksBrowser(o.subarray(0, n), o.subarray(n, 2 * n), o.subarray(2 * n, 3 * n), W, H);
  out.postprocess_1024x768_s = (performance.now() - t) / 1000; out.grains = pp.grainCount;
  const s2 = await ort.InferenceSession.create(readFileSync(cpsam), { executionProviders: ['wasm'] });
  const tile = new Float32Array(3 * 256 * 256); for (let i = 0; i < tile.length; i++) tile[i] = Math.sin(i * 0.001) * 0.5;
  t = performance.now();
  await s2.run({ image: new ort.Tensor('float16', float32ArrayToFloat16Bits(tile), [1, 3, 256, 256]) });
  out.cpsam_tile_s = (performance.now() - t) / 1000;
  console.log(JSON.stringify(out));
} else {
  for (const n of ts.length ? ts : ['1', '2', '4', '8']) {
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), unet, cpsam], { env: { ...process.env, CHILD: n }, encoding: 'utf8', timeout: 1800000 });
    const line = (res.stdout || '').trim().split('\n').pop();
    console.log(`threads=${n}`, line || res.stderr.slice(-300));
  }
}
