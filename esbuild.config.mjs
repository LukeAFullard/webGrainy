import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const srcDir = path.join(rootDir, 'src');
const modulesDir = path.join(srcDir, 'modules');
const distDir = path.join(rootDir, 'dist');
const ortSrcDir = path.join(rootDir, 'node_modules', 'onnxruntime-web', 'dist');
const ortDistDir = path.join(distDir, 'ort');

// 1. Clean and create dist/
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// 2. Dynamically discover src/modules/*.ts (excluding *.d.ts and *.test.ts) + src/index.ts
const entryPoints = [];

if (fs.existsSync(modulesDir)) {
  const files = fs.readdirSync(modulesDir);
  for (const file of files) {
    if (
      file.endsWith('.ts') &&
      !file.endsWith('.d.ts') &&
      !file.endsWith('.test.ts')
    ) {
      entryPoints.push(path.join(modulesDir, file));
    }
  }
}

const indexFile = path.join(srcDir, 'index.ts');
if (fs.existsSync(indexFile)) {
  entryPoints.push(indexFile);
} else {
  console.log('[build] Notice: src/index.ts not found; skipping index entry point.');
}

if (entryPoints.length > 0) {
  await build({
    entryPoints,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outbase: 'src',
    outdir: 'dist',
    sourcemap: true,
  });
  console.log(`[build] Bundled ${entryPoints.length} ESM entry point(s) to dist/.`);
} else {
  console.log('[build] Notice: No module entry points found to bundle.');
}

// 3. Bundle Web Worker if present
const workerFile = path.join(srcDir, 'workers', 'grainPostprocess.worker.ts');
if (fs.existsSync(workerFile)) {
  await build({
    entryPoints: [workerFile],
    outfile: path.join(distDir, 'workers', 'grainPostprocess.worker.js'),
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    bundle: true,
    sourcemap: true,
  });
  console.log('[build] Bundled grainPostprocess.worker.ts to dist/workers/grainPostprocess.worker.js.');
} else {
  console.log('[build] Notice: src/workers/grainPostprocess.worker.ts not found; skipping worker bundle.');
}

// 4. Copy onnxruntime-web WASM/MJS assets into dist/ort/ for zero-CDN offline execution
fs.mkdirSync(ortDistDir, { recursive: true });
if (fs.existsSync(ortSrcDir)) {
  const ortFiles = fs.readdirSync(ortSrcDir);
  let copiedCount = 0;
  for (const file of ortFiles) {
    if (file.endsWith('.wasm') || file.endsWith('.mjs')) {
      fs.copyFileSync(path.join(ortSrcDir, file), path.join(ortDistDir, file));
      copiedCount++;
    }
  }
  console.log(`[build] Copied ${copiedCount} onnxruntime-web asset(s) to dist/ort/.`);
} else {
  console.warn('[build] Warning: node_modules/onnxruntime-web/dist not found; dist/ort/ will be empty.');
}
