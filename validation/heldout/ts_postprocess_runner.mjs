#!/usr/bin/env node
/**
 * Node.js runner for the actual shipped TypeScript post-processing engine
 * (`src/modules/postprocessCore.ts` + `src/modules/morphometricsExt.ts`).
 *
 * Uses `esbuild` from `node_modules` to bundle the TS modules on demand,
 * then executes `flowsToMasksBrowser` and `computeExtendedMorphometrics`
 * (including `computeFeretDiameters`) with frozen default settings.
 *
 * Usage:
 *   node validation/heldout/ts_postprocess_runner.mjs --selftest
 *   node validation/heldout/ts_postprocess_runner.mjs --input meta.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const BUNDLE_PATH = path.join(os.tmpdir(), 'webgrainy_ts_postprocess_bundle.mjs');

async function loadShippedTsEngine() {
  const postprocessSrc = path.join(REPO_ROOT, 'src', 'modules', 'postprocessCore.ts');
  const morphoSrc = path.join(REPO_ROOT, 'src', 'modules', 'morphometricsExt.ts');

  const srcMtime = Math.max(
    fs.statSync(postprocessSrc).mtimeMs,
    fs.statSync(morphoSrc).mtimeMs,
  );
  const bundleExists = fs.existsSync(BUNDLE_PATH);
  const needsBuild = !bundleExists || fs.statSync(BUNDLE_PATH).mtimeMs < srcMtime;

  if (needsBuild) {
    const entryContents = `
      export { DEFAULT_POSTPROCESS_OPTIONS, flowsToMasksBrowser } from ${JSON.stringify(postprocessSrc)};
      export { computeExtendedMorphometrics, computeFeretDiameters } from ${JSON.stringify(morphoSrc)};
    `;
    await esbuild.build({
      stdin: {
        contents: entryContents,
        resolveDir: REPO_ROOT,
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile: BUNDLE_PATH,
      logLevel: 'silent',
    });
  }

  return import(pathToFileURL(BUNDLE_PATH).href);
}

function runEngine(engine, flowY, flowX, cellprob, width, height, maxGrainAreaFraction) {
  const defaults = engine.DEFAULT_POSTPROCESS_OPTIONS;
  const options = {
    niter: defaults.niter, // 250
    cellprobThreshold: defaults.cellprobThreshold, // 0.0
    flowThreshold: defaults.flowThreshold, // 0.45
    minSize: defaults.minSize, // 30
    minSeedDensity: defaults.minSeedDensity, // 2
    excludeBorderMargin: defaults.excludeBorderMargin, // 2
    maxGrainAreaFraction:
      typeof maxGrainAreaFraction === 'number'
        ? maxGrainAreaFraction
        : defaults.maxGrainAreaFraction, // 0.15
  };

  const result = engine.flowsToMasksBrowser(
    flowY,
    flowX,
    cellprob,
    width,
    height,
    options,
  );

  const extended = engine.computeExtendedMorphometrics(
    result.masks,
    result.grains,
    width,
    height,
    1,
  );

  const grains = extended.map((g) => ({
    id: g.id,
    areaPx: g.areaPx,
    bAxisPx: g.bAxisPx,
    aAxisPx: g.aAxisPx,
    dEqPx: g.dEqPx,
    minFeretPx: g.minFeretPx,
    maxFeretPx: g.maxFeretPx,
    isBorder: Boolean(g.touchesBorder),
    touchesBorder: Boolean(g.touchesBorder),
  }));

  const interiorCount = grains.filter((g) => !g.touchesBorder).length;

  return {
    width,
    height,
    options,
    grainCount: result.grainCount,
    interiorCount,
    grains,
    masks: result.masks,
  };
}

function makeSyntheticFixture(width = 160, height = 160) {
  const nPix = width * height;
  const flowY = new Float32Array(nPix);
  const flowX = new Float32Array(nPix);
  const cellprob = new Float32Array(nPix).fill(-3.0);

  // Two interior grains + one large "sand sheet" (>15% of 160*160 = 3840 px)
  const blobs = [
    { cx: 35, cy: 35, rx: 14, ry: 10 }, // area ~440 px
    { cx: 120, cy: 40, rx: 16, ry: 16 }, // area ~804 px
    { cx: 80, cy: 112, rx: 48, ry: 34 }, // area ~5127 px (~20.0% > 15%)
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      for (const b of blobs) {
        const dx = (x - b.cx) / b.rx;
        const dy = (y - b.cy) / b.ry;
        if (dx * dx + dy * dy <= 1.0) {
          cellprob[idx] = 3.0;
          const vy = b.cy - y;
          const vx = b.cx - x;
          const mag = Math.hypot(vy, vx) + 1e-6;
          flowY[idx] = vy / mag;
          flowX[idx] = vx / mag;
          break;
        }
      }
    }
  }

  return { flowY, flowX, cellprob, width, height };
}

async function runSelfTest() {
  const engine = await loadShippedTsEngine();
  const { flowY, flowX, cellprob, width, height } = makeSyntheticFixture();

  const res015 = runEngine(engine, flowY, flowX, cellprob, width, height, 0.15);
  const res100 = runEngine(engine, flowY, flowX, cellprob, width, height, 1.0);

  console.log('=== TS Postprocess Runner Self-Test ===');
  console.log('Defaults:', JSON.stringify(engine.DEFAULT_POSTPROCESS_OPTIONS));
  console.log('maxGrainAreaFraction=0.15 -> grainCount:', res015.grainCount, 'interiorCount:', res015.interiorCount);
  console.log('  grains:', JSON.stringify(res015.grains));
  console.log('maxGrainAreaFraction=1.00 -> grainCount:', res100.grainCount, 'interiorCount:', res100.interiorCount);
  console.log('  grains:', JSON.stringify(res100.grains));

  if (res015.grainCount !== 2) {
    throw new Error(`Expected 2 grains with 0.15 guard, got ${res015.grainCount}`);
  }
  if (res100.grainCount !== 3) {
    throw new Error(`Expected 3 grains with 1.0 guard, got ${res100.grainCount}`);
  }
  for (const g of [...res015.grains, ...res100.grains]) {
    if (typeof g.isBorder !== 'boolean' || typeof g.touchesBorder !== 'boolean') {
      throw new Error(`Missing boolean border flags on grain ${g.id}: ${JSON.stringify(g)}`);
    }
    if (!(g.bAxisPx > 0 && g.dEqPx > 0 && g.minFeretPx > 0)) {
      throw new Error(`Invalid morphometrics on grain ${g.id}: ${JSON.stringify(g)}`);
    }
  }
  console.log('PASS: Both 0.15 and 1.0 emitted valid masks, border flags, and bAxisPx, dEqPx, minFeretPx.');
}

async function runFromInputFile(inputPath) {
  const meta = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const { dPPath, cellprobPath, width, height, maxGrainAreaFraction, outputJsonPath, outputMaskPath } = meta;
  const nPix = width * height;

  const dpBuf = fs.readFileSync(dPPath);
  const cpBuf = fs.readFileSync(cellprobPath);
  if (dpBuf.byteLength !== 2 * nPix * 4) {
    throw new Error(`dP byteLength ${dpBuf.byteLength} !== ${2 * nPix * 4}`);
  }
  if (cpBuf.byteLength !== nPix * 4) {
    throw new Error(`cellprob byteLength ${cpBuf.byteLength} !== ${nPix * 4}`);
  }

  const dpView = new Float32Array(dpBuf.buffer, dpBuf.byteOffset, 2 * nPix);
  const flowY = dpView.subarray(0, nPix);
  const flowX = dpView.subarray(nPix, 2 * nPix);
  const cellprob = new Float32Array(cpBuf.buffer, cpBuf.byteOffset, nPix);

  const engine = await loadShippedTsEngine();
  const res = runEngine(engine, flowY, flowX, cellprob, width, height, maxGrainAreaFraction);

  if (outputMaskPath) {
    const maskBytes = Buffer.from(res.masks.buffer, res.masks.byteOffset, res.masks.byteLength);
    fs.writeFileSync(outputMaskPath, maskBytes);
  }
  const { masks: _masks, ...jsonOut } = res;
  fs.writeFileSync(outputJsonPath, JSON.stringify(jsonOut));
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
  console.error('Usage: node validation/heldout/ts_postprocess_runner.mjs [--selftest | --input <meta.json>]');
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
