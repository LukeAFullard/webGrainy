#!/usr/bin/env node
/**
 * Node.js runner for webGrainy's default Cellpose inference pipeline
 * (`runUnetCellposeInference` / `runCpsamCellposeInference` in `dist/modules/onnxInference.js`).
 *
 * Supports either direct `onnxruntime-web` WASM execution (like `validation/parity/dump_ours_cellpose.mjs`)
 * or delegating single-tile `session.run({ image })` calls to a local Python `onnxruntime-gpu`
 * CUDA HTTP bridge when `cudaUrl` is provided in `meta.json`.
 *
 * Usage:
 *   node validation/heldout/ts_cellpose_runner.mjs --selftest
 *   node validation/heldout/ts_cellpose_runner.mjs --input meta.json
 */

import fs from 'node:fs';
import * as ort from 'onnxruntime-web';
import {
  runCpsamCellposeInference,
  runUnetCellposeInference,
} from '../../dist/modules/onnxInference.js';

function makeCudaProxySession(cudaUrl) {
  return {
    async run({ image }) {
      const body = Buffer.from(
        image.data.buffer,
        image.data.byteOffset,
        image.data.byteLength,
      );
      const resp = await fetch(cudaUrl, {
        method: 'POST',
        headers: {
          'x-dtype': String(image.type),
          'x-dims': image.dims.join(','),
        },
        body,
      });
      if (!resp.ok) {
        const msg = await resp.text().catch(() => '');
        throw new Error(`CUDA tile bridge HTTP ${resp.status}: ${msg}`);
      }
      const ab = await resp.arrayBuffer();
      return { flows_cellprob: { data: new Float32Array(ab) } };
    },
  };
}

async function runSelfTest() {
  if (typeof runUnetCellposeInference !== 'function') {
    throw new Error('runUnetCellposeInference export missing from dist/modules/onnxInference.js');
  }
  if (typeof runCpsamCellposeInference !== 'function') {
    throw new Error('runCpsamCellposeInference export missing from dist/modules/onnxInference.js');
  }

  const W = 40;
  const H = 32;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = i % 256;
    rgba[i * 4 + 1] = (i * 3) % 256;
    rgba[i * 4 + 2] = (i * 7) % 256;
    rgba[i * 4 + 3] = 255;
  }

  const mockSession = {
    async run({ image }) {
      const [, , th, tw] = image.dims;
      return { flows_cellprob: { data: new Float32Array(3 * th * tw) } };
    },
  };

  const outU = await runUnetCellposeInference(mockSession, rgba, W, H);
  const outC = await runCpsamCellposeInference(mockSession, rgba, W, H);
  for (const [name, out] of [['unet', outU], ['cpsam', outC]]) {
    if (out.flowY.length !== W * H || out.flowX.length !== W * H || out.cellprob.length !== W * H) {
      throw new Error(`Unexpected output shape for ${name}`);
    }
  }
  console.log('=== TS Cellpose Runner Self-Test ===');
  console.log(`PASS: dist/modules/onnxInference.js Cellpose exports verified (${W}x${H}).`);
}

async function runFromInputFile(inputPath) {
  const meta = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const {
    modelKind,
    modelPath,
    rgbaPath,
    width,
    height,
    outDpPath,
    outCpPath,
    cudaUrl,
    numThreads,
  } = meta;

  if (modelKind !== 'unet' && modelKind !== 'cpsam') {
    throw new Error(`Unsupported modelKind: ${modelKind}`);
  }
  const nPix = width * height;
  const rgbaBuf = fs.readFileSync(rgbaPath);
  if (rgbaBuf.byteLength !== nPix * 4) {
    throw new Error(`RGBA byteLength ${rgbaBuf.byteLength} !== ${nPix * 4}`);
  }
  const rgba = new Uint8ClampedArray(rgbaBuf.buffer, rgbaBuf.byteOffset, rgbaBuf.byteLength);

  let session;
  if (cudaUrl) {
    session = makeCudaProxySession(cudaUrl);
  } else {
    ort.env.wasm.numThreads = Number(numThreads ?? 4);
    session = await ort.InferenceSession.create(fs.readFileSync(modelPath), {
      executionProviders: ['wasm'],
    });
  }

  const out =
    modelKind === 'unet'
      ? await runUnetCellposeInference(session, rgba, width, height)
      : await runCpsamCellposeInference(session, rgba, width, height);

  const dp = new Float32Array(2 * nPix);
  dp.set(out.flowY, 0);
  dp.set(out.flowX, nPix);

  fs.writeFileSync(outDpPath, Buffer.from(dp.buffer, dp.byteOffset, dp.byteLength));
  fs.writeFileSync(
    outCpPath,
    Buffer.from(out.cellprob.buffer, out.cellprob.byteOffset, out.cellprob.byteLength),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    await runSelfTest();
    return;
  }
  const idx = args.indexOf('--input');
  if (idx !== -1 && args[idx + 1]) {
    await runFromInputFile(args[idx + 1]);
    return;
  }
  console.error(
    'Usage: node validation/heldout/ts_cellpose_runner.mjs [--selftest | --input <meta.json>]',
  );
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
