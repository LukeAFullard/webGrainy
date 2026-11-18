#!/usr/bin/env node
/**
 * Persistent Node.js worker & self-test for `audit/preprocessing/`.
 *
 * Uses the exact shipped TypeScript modules compiled into `dist/`:
 *   - `dist/modules/imagePreprocess.js` (`prepareWorkingImage`, `applyCLAHE`)
 *   - `dist/modules/onnxInference.js` (`runUnetCellposeInference`, `runCpsamCellposeInference`)
 *   - `dist/modules/postprocessCore.js` (`DEFAULT_POSTPROCESS_OPTIONS`, `flowsToMasksBrowser`)
 *
 * Usage:
 *   node audit/preprocessing/ts_preprocess_worker.mjs --selftest
 *   node audit/preprocessing/ts_preprocess_worker.mjs <worker_config.json>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

/**
 * Exact half-pixel bilinear RGBA resampler matching `prepareWorkingImage` in
 * `src/modules/imagePreprocess.ts`.
 */
export function bilinearResizeRgba(rgba, width, height, targetScale) {
  if (targetScale === 1.0) {
    return {
      data: new Uint8ClampedArray(rgba.subarray(0, width * height * 4)),
      width,
      height,
    };
  }
  const newWidth = Math.max(1, Math.round(width * targetScale));
  const newHeight = Math.max(1, Math.round(height * targetScale));
  const out = new Uint8ClampedArray(newWidth * newHeight * 4);

  const x0Arr = new Int32Array(newWidth);
  const x1Arr = new Int32Array(newWidth);
  const fxArr = new Float32Array(newWidth);
  for (let dx = 0; dx < newWidth; dx++) {
    const sx = Math.min(width - 1, Math.max(0, ((dx + 0.5) * width) / newWidth - 0.5));
    const x0 = Math.floor(sx);
    x0Arr[dx] = x0;
    x1Arr[dx] = Math.min(width - 1, x0 + 1);
    fxArr[dx] = sx - x0;
  }

  for (let dy = 0; dy < newHeight; dy++) {
    const sy = Math.min(height - 1, Math.max(0, ((dy + 0.5) * height) / newHeight - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    const row0 = y0 * width;
    const row1 = y1 * width;
    const dstRow = dy * newWidth;

    for (let dx = 0; dx < newWidth; dx++) {
      const x0 = x0Arr[dx];
      const x1 = x1Arr[dx];
      const fx = fxArr[dx];
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const p00 = (row0 + x0) * 4;
      const p10 = (row0 + x1) * 4;
      const p01 = (row1 + x0) * 4;
      const p11 = (row1 + x1) * 4;
      const dst = (dstRow + dx) * 4;

      out[dst] = Math.round(rgba[p00] * w00 + rgba[p10] * w10 + rgba[p01] * w01 + rgba[p11] * w11);
      out[dst + 1] = Math.round(rgba[p00 + 1] * w00 + rgba[p10 + 1] * w10 + rgba[p01 + 1] * w01 + rgba[p11 + 1] * w11);
      out[dst + 2] = Math.round(rgba[p00 + 2] * w00 + rgba[p10 + 2] * w10 + rgba[p01 + 2] * w01 + rgba[p11 + 2] * w11);
      out[dst + 3] = Math.round(rgba[p00 + 3] * w00 + rgba[p10 + 3] * w10 + rgba[p01 + 3] * w01 + rgba[p11 + 3] * w11);
    }
  }
  return { data: out, width: newWidth, height: newHeight };
}

export function applyGammaRgba(img, gamma) {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.round(255 * Math.pow(v / 255, gamma));
  }
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = lut[img.data[i]];
    out[i + 1] = lut[img.data[i + 1]];
    out[i + 2] = lut[img.data[i + 2]];
    out[i + 3] = img.data[i + 3];
  }
  return { data: out, width: img.width, height: img.height };
}

export function applyBrightnessFactorRgba(img, factor) {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.round(v * factor);
  }
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = lut[img.data[i]];
    out[i + 1] = lut[img.data[i + 1]];
    out[i + 2] = lut[img.data[i + 2]];
    out[i + 3] = img.data[i + 3];
  }
  return { data: out, width: img.width, height: img.height };
}

export function applyMedian3x3Rgba(img) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data.length);
  const buf = new Uint8Array(9);
  for (let y = 0; y < height; y++) {
    const ym1 = y > 0 ? y - 1 : 0;
    const yp1 = y + 1 < height ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const xm1 = x > 0 ? x - 1 : 0;
      const xp1 = x + 1 < width ? x + 1 : width - 1;
      const dst = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        buf[0] = data[(ym1 * width + xm1) * 4 + c];
        buf[1] = data[(ym1 * width + x) * 4 + c];
        buf[2] = data[(ym1 * width + xp1) * 4 + c];
        buf[3] = data[(y * width + xm1) * 4 + c];
        buf[4] = data[(y * width + x) * 4 + c];
        buf[5] = data[(y * width + xp1) * 4 + c];
        buf[6] = data[(yp1 * width + xm1) * 4 + c];
        buf[7] = data[(yp1 * width + x) * 4 + c];
        buf[8] = data[(yp1 * width + xp1) * 4 + c];
        buf.sort();
        out[dst + c] = buf[4];
      }
      out[dst + 3] = data[dst + 3];
    }
  }
  return { data: out, width, height };
}

export function applyPreprocessVariant(workImg, variant, applyCLAHE) {
  switch (variant) {
    case 'A':
    case 'A_baseline':
      return { img: workImg, upscale: 1.0 };
    case 'B':
    case 'B_clahe_2_0':
      return { img: applyCLAHE(workImg, 2.0, 8), upscale: 1.0 };
    case 'C':
    case 'C_clahe_3_0':
      return { img: applyCLAHE(workImg, 3.0, 8), upscale: 1.0 };
    case 'D':
    case 'D_upscale_1_5': {
      const resized = bilinearResizeRgba(workImg.data, workImg.width, workImg.height, 1.5);
      return { img: resized, upscale: resized.width / workImg.width };
    }
    case 'E':
    case 'E_upscale_2_0': {
      const resized = bilinearResizeRgba(workImg.data, workImg.width, workImg.height, 2.0);
      return { img: resized, upscale: resized.width / workImg.width };
    }
    case 'G_gamma07':
      return { img: applyGammaRgba(workImg, 0.7), upscale: 1.0 };
    case 'G_gamma14':
      return { img: applyGammaRgba(workImg, 1.4), upscale: 1.0 };
    case 'G_bright_p20':
      return { img: applyBrightnessFactorRgba(workImg, 1.2), upscale: 1.0 };
    case 'G_bright_m20':
      return { img: applyBrightnessFactorRgba(workImg, 0.8), upscale: 1.0 };
    case 'H_median3':
      return { img: applyMedian3x3Rgba(workImg), upscale: 1.0 };
    default:
      throw new Error(`Unknown preprocessing variant: ${variant}`);
  }
}

function makeProxySession(bridgeUrl) {
  return {
    async run({ image }) {
      const body = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
      const resp = await fetch(bridgeUrl, {
        method: 'POST',
        headers: {
          'x-dtype': String(image.type),
          'x-dims': image.dims.join(','),
        },
        body,
      });
      if (!resp.ok) {
        const msg = await resp.text().catch(() => '');
        throw new Error(`Bridge HTTP ${resp.status}: ${msg}`);
      }
      const ab = await resp.arrayBuffer();
      return { flows_cellprob: { data: new Float32Array(ab) } };
    },
  };
}

function rescaleGrainToOrig(g, invScale) {
  const invSq = invScale * invScale;
  return {
    id: g.id,
    areaPx: g.areaPx * invSq,
    bAxisPx: g.bAxisPx * invScale,
    aAxisPx: g.aAxisPx * invScale,
    dEqPx: g.dEqPx * invScale,
    touchesBorder: Boolean(g.touchesBorder),
  };
}

async function runSelfTest(repoDir) {
  const { prepareWorkingImage, applyCLAHE } = await import(
    pathToFileURL(path.join(repoDir, 'dist/modules/imagePreprocess.js')).href
  );
  const { runUnetCellposeInference, runCpsamCellposeInference } = await import(
    pathToFileURL(path.join(repoDir, 'dist/modules/onnxInference.js')).href
  );
  const { DEFAULT_POSTPROCESS_OPTIONS, flowsToMasksBrowser } = await import(
    pathToFileURL(path.join(repoDir, 'dist/modules/postprocessCore.js')).href
  );

  // Verify shipped defaults match benchmark assumptions
  if (
    DEFAULT_POSTPROCESS_OPTIONS.flowThreshold !== 0.45 ||
    DEFAULT_POSTPROCESS_OPTIONS.cellprobThreshold !== 0 ||
    DEFAULT_POSTPROCESS_OPTIONS.minSize !== 30 ||
    DEFAULT_POSTPROCESS_OPTIONS.maxGrainAreaFraction !== 0.4
  ) {
    throw new Error(`Unexpected DEFAULT_POSTPROCESS_OPTIONS: ${JSON.stringify(DEFAULT_POSTPROCESS_OPTIONS)}`);
  }

  const origW = 1280;
  const origH = 960;
  const rgba = new Uint8ClampedArray(origW * origH * 4);
  for (let i = 0; i < origW * origH; i++) {
    rgba[i * 4] = (i * 13) % 256;
    rgba[i * 4 + 1] = (i * 29) % 256;
    rgba[i * 4 + 2] = (i * 53) % 256;
    rgba[i * 4 + 3] = 255;
  }

  const work = prepareWorkingImage(rgba, origW, origH, 'auto');
  if (work.width !== 640 || work.height !== 480) {
    throw new Error(`Expected 640x480 working image, got ${work.width}x${work.height}`);
  }
  for (const v of ['A', 'B', 'C', 'D', 'E', 'G_gamma07', 'G_gamma14', 'G_bright_p20', 'G_bright_m20', 'H_median3']) {
    const res = applyPreprocessVariant(work, v, applyCLAHE);
    if (v === 'D' && (res.img.width !== 960 || res.img.height !== 720)) {
      throw new Error(`Expected 960x720 for D, got ${res.img.width}x${res.img.height}`);
    }
    if (v === 'E' && (res.img.width !== 1280 || res.img.height !== 960)) {
      throw new Error(`Expected 1280x960 for E, got ${res.img.width}x${res.img.height}`);
    }
  }

  let mockTiles = 0;
  const mockSess = {
    async run({ image }) {
      const [, , th, tw] = image.dims;
      return { flows_cellprob: { data: new Float32Array(3 * th * tw) } };
    },
  };
  const smallWork = prepareWorkingImage(rgba.subarray(0, 64 * 64 * 4), 64, 64, 'auto');
  await runUnetCellposeInference(mockSess, smallWork.data, smallWork.width, smallWork.height, {
    onProgress: (p) => { if (p?.totalTiles) mockTiles = p.totalTiles; },
  });
  await runCpsamCellposeInference(mockSess, smallWork.data, smallWork.width, smallWork.height, {
    onProgress: (p) => { if (p?.totalTiles) mockTiles = p.totalTiles; },
  });
  const pp = flowsToMasksBrowser(
    new Float32Array(64 * 64),
    new Float32Array(64 * 64),
    new Float32Array(64 * 64).fill(-2),
    64,
    64,
    DEFAULT_POSTPROCESS_OPTIONS,
  );
  const testScaled = rescaleGrainToOrig(
    { id: 1, areaPx: 400, bAxisPx: 20, aAxisPx: 30, dEqPx: 22.5, touchesBorder: false },
    1.0 / 0.5,
  );
  if (pp.grainCount !== 0 || mockTiles !== 1 || testScaled.bAxisPx !== 40 || testScaled.areaPx !== 1600) {
    throw new Error(`Self-test sanity failure: grainCount=${pp.grainCount}, mockTiles=${mockTiles}, testScaled=${JSON.stringify(testScaled)}`);
  }
  console.log('=== TS Preprocess Worker Self-Test ===');
  console.log(`Defaults: ${JSON.stringify(DEFAULT_POSTPROCESS_OPTIONS)}`);
  console.log('PASS: prepareWorkingImage, applyCLAHE, D(1.5x)/E(2.0x)/G/H, Cellpose inference & postprocess verified.');
}

async function runWorker(cfgPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const repoDir = cfg.repoDir || DEFAULT_REPO_DIR;
  const ort = await import(pathToFileURL(path.join(repoDir, 'node_modules/onnxruntime-web/dist/ort.node.min.mjs')).href);
  const { prepareWorkingImage, applyCLAHE } = await import(
    pathToFileURL(path.join(repoDir, 'dist/modules/imagePreprocess.js')).href
  );
  const { runUnetCellposeInference, runCpsamCellposeInference } = await import(
    pathToFileURL(path.join(repoDir, 'dist/modules/onnxInference.js')).href
  );
  const { DEFAULT_POSTPROCESS_OPTIONS, flowsToMasksBrowser } = await import(
    pathToFileURL(path.join(repoDir, 'dist/modules/postprocessCore.js')).href
  );

  let session;
  let loadMs = 0;
  if (cfg.bridgeUrl) {
    session = makeProxySession(cfg.bridgeUrl);
  } else {
    ort.env.wasm.numThreads = Number(cfg.numThreads ?? Math.min(4, os.cpus().length || 2));
    ort.env.wasm.simd = true;
    const t0 = performance.now();
    session = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(cfg.modelPath)), {
      executionProviders: ['wasm'],
    });
    loadMs = performance.now() - t0;
  }

  console.log('__WORKER_READY__:' + JSON.stringify({ loadMs }));

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let job;
    try {
      job = JSON.parse(line);
    } catch (err) {
      console.log('__WORKER_RESP__:' + JSON.stringify({ ok: false, error: `Bad job JSON: ${err?.message || err}` }));
      continue;
    }
    if (job.quit) break;
    try {
      const tPre0 = performance.now();
      let preImg;
      let workWidth;
      let workHeight;
      let totalScaleX;
      let totalScaleY;

      if (job.preWorkingRgbaPath) {
        // Caller supplied an already-preprocessed working RGBA buffer (e.g., OpenCV bilateral 5x5 after prepareWorkingImage('auto'))
        const buf = fs.readFileSync(job.preWorkingRgbaPath);
        preImg = {
          data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength),
          width: job.preWorkingWidth,
          height: job.preWorkingHeight,
        };
        workWidth = job.workWidth ?? job.preWorkingWidth;
        workHeight = job.workHeight ?? job.preWorkingHeight;
        totalScaleX = preImg.width / job.origWidth;
        totalScaleY = preImg.height / job.origHeight;
      } else {
        const rawBuf = fs.readFileSync(job.origRgbaPath);
        const origRgba = new Uint8ClampedArray(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
        const work = prepareWorkingImage(origRgba, job.origWidth, job.origHeight, 'auto');
        workWidth = work.width;
        workHeight = work.height;
        const prep = applyPreprocessVariant(work, job.variant || 'A', applyCLAHE);
        preImg = prep.img;
        totalScaleX = preImg.width / job.origWidth;
        totalScaleY = preImg.height / job.origHeight;
      }
      const preprocessMs = performance.now() - tPre0;

      let totalTiles = 0;
      let lastProgEmit = 0;
      const tInf0 = performance.now();
      const onProgress = (p) => {
        if (p && typeof p.totalTiles === 'number' && p.totalTiles > 0) {
          totalTiles = p.totalTiles;
          const done = Number(p.completedTiles || 0);
          const now = performance.now();
          if (job.reportProgress && done > 0 && (done === totalTiles || cfg.modelKind === 'cpsam' || (now - lastProgEmit) >= 2000)) {
            lastProgEmit = now;
            console.log('__WORKER_PROG__:' + JSON.stringify({
              completedTiles: done,
              totalTiles,
              percent: Number(p.percent ?? Math.round((done / totalTiles) * 100)),
              elapsedMs: now - tInf0,
            }));
          }
        }
      };

      const inferOut = cfg.modelKind === 'unet'
        ? await runUnetCellposeInference(session, preImg.data, preImg.width, preImg.height, { onProgress })
        : await runCpsamCellposeInference(session, preImg.data, preImg.width, preImg.height, { onProgress });
      const inferMs = performance.now() - tInf0;

      const tPp0 = performance.now();
      const ppOpts = {
        ...DEFAULT_POSTPROCESS_OPTIONS,
        maxGrainAreaFraction: typeof job.guard === 'number' ? job.guard : 0.4,
      };
      const pp = flowsToMasksBrowser(
        inferOut.flowY,
        inferOut.flowX,
        inferOut.cellprob,
        preImg.width,
        preImg.height,
        ppOpts,
      );
      const postprocessMs = performance.now() - tPp0;

      if (job.outMaskPath) {
        fs.writeFileSync(
          job.outMaskPath,
          Buffer.from(pp.masks.buffer, pp.masks.byteOffset, pp.masks.byteLength),
        );
      }

      // Compute working-px median b-axis (for variant F threshold selection & evaluation)
      const invScaleToWork = workWidth / preImg.width;
      const invScaleToOrig = 1.0 / totalScaleX;
      const workingGrains = pp.grains.map((g) => ({
        id: g.id,
        bAxisPx: g.bAxisPx * invScaleToWork,
        areaPx: g.areaPx * invScaleToWork * invScaleToWork,
        touchesBorder: Boolean(g.touchesBorder),
      }));
      const origGrains = pp.grains.map((g) => rescaleGrainToOrig(g, invScaleToOrig));

      console.log('__WORKER_RESP__:' + JSON.stringify({
        ok: true,
        origWidth: job.origWidth,
        origHeight: job.origHeight,
        workWidth,
        workHeight,
        infWidth: preImg.width,
        infHeight: preImg.height,
        totalScaleFactor: totalScaleX,
        totalScaleFactorY: totalScaleY,
        totalTiles,
        preprocessMs,
        inferMs,
        postprocessMs,
        grainCount: pp.grainCount,
        origGrains,
        workingGrains,
      }));
    } catch (err) {
      console.log('__WORKER_RESP__:' + JSON.stringify({ ok: false, error: String(err?.stack || err) }));
    }
  }

  rl.close();
  if (typeof session?.release === 'function') {
    await session.release().catch(() => {});
  }
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  await runSelfTest(DEFAULT_REPO_DIR);
} else if (args[0]) {
  await runWorker(args[0]);
} else {
  console.error('Usage: node audit/preprocessing/ts_preprocess_worker.mjs [--selftest | <worker_config.json>]');
  process.exit(2);
}
