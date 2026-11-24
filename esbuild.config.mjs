import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { build } from 'esbuild';

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const ortPkg = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'package.json'), 'utf8'),
);
// Compile-time constants consumed by src/modules/provenance.ts
// The exact source revision, so every export can be traced to the code that produced it
// (the version number alone is not bumped for every deployment). CI: GITHUB_SHA.
function gitCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    const sha = execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha}-modified` : sha;
  } catch {
    return 'unknown';
  }
}
// Reproducible builds: the build date is SOURCE_DATE_EPOCH if set, else the commit's date, so the
// same commit always gives the same dist/ (and service-worker hash). A modified working tree uses
// the current time, so its BUILD_ID still differs from the commit's.
function buildDate(commit) {
  if (process.env.SOURCE_DATE_EPOCH) return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
  if (commit !== 'unknown' && !commit.endsWith('-modified')) {
    try {
      const t = execSync('git log -1 --format=%ct HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (/^\d+$/.test(t)) return new Date(Number(t) * 1000).toISOString();
    } catch {
      /* not a git checkout */
    }
  }
  return new Date().toISOString();
}
const commit = gitCommit();
const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __ORT_VERSION__: JSON.stringify(ortPkg.version),
  __BUILD_COMMIT__: JSON.stringify(commit),
  __BUILD_DATE__: JSON.stringify(buildDate(commit)),
};
console.log(`[build] webGrainy ${pkg.version} (commit ${define.__BUILD_COMMIT__})`);
// The default `onnxruntime-web` entry (ort.all / JSEP) loads exactly these two runtime
// files for both the WebGPU and the WASM execution providers. Nothing else is shipped.
const ORT_RUNTIME_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

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
    // Shared code goes to dist/chunks/, one level below dist/ like dist/modules/, so
    // `new URL('../workers/…', import.meta.url)` in engine code finds dist/workers/.
    chunkNames: 'chunks/[name]-[hash]',
    sourcemap: true,
    define,
  });
  console.log(`[build] Bundled ${entryPoints.length} ESM entry point(s) to dist/.`);
} else {
  console.log('[build] Notice: No module entry points found to bundle.');
}

// Browser bundles (page, workers, styles) are minified: about half the download. Names are kept
// (keepNames) so error classes and stack traces stay readable; source maps map back to src/.
const browserMinify = { minify: true, keepNames: true, banner: { js: `/*! webGrainy ${pkg.version} build ${commit} */` } };

// 3. Bundle Web Worker if present
const workerFile = path.join(srcDir, 'workers', 'grainPostprocess.worker.ts');
if (fs.existsSync(workerFile)) {
  await build({
    entryPoints: [workerFile],
    outfile: path.join(distDir, 'workers', 'grainPostprocess.worker.js'),
    ...browserMinify,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    bundle: true,
    sourcemap: true,
    define,
  });
  console.log('[build] Bundled grainPostprocess.worker.ts to dist/workers/grainPostprocess.worker.js.');
} else {
  console.log('[build] Notice: src/workers/grainPostprocess.worker.ts not found; skipping worker bundle.');
}

// 3b. Inference worker: runs WASM (CPU) onnxruntime-web sessions off the main thread.
await build({
  entryPoints: [path.join(srcDir, 'workers', 'ortWasm.worker.ts')],
  outfile: path.join(distDir, 'workers', 'ortWasm.worker.js'),
  ...browserMinify,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  bundle: true,
  sourcemap: true,
  define,
});
console.log('[build] Bundled ortWasm.worker.ts to dist/workers/ortWasm.worker.js.');

// 4. Copy onnxruntime-web WASM/MJS assets into dist/ort/ for zero-CDN offline execution
fs.mkdirSync(ortDistDir, { recursive: true });
if (fs.existsSync(ortSrcDir)) {
  let copiedCount = 0;
  for (const file of ORT_RUNTIME_FILES) {
    if (!fs.existsSync(path.join(ortSrcDir, file))) {
      throw new Error(`[build] Required onnxruntime-web asset missing: ${file}`);
    }
    fs.copyFileSync(path.join(ortSrcDir, file), path.join(ortDistDir, file));
    copiedCount++;
  }
  console.log(`[build] Copied ${copiedCount} onnxruntime-web asset(s) to dist/ort/.`);
} else {
  console.warn('[build] Warning: node_modules/onnxruntime-web/dist not found; dist/ort/ will be empty.');
}

// 5. Bundle browser UI (src/ui/main.ts -> dist/ui/main.js, src/ui/main.css -> dist/ui/main.css)
const uiEntry = path.join(srcDir, 'ui', 'main.ts');
const uiCssEntry = path.join(srcDir, 'ui', 'main.css');
const uiDistDir = path.join(distDir, 'ui');
fs.mkdirSync(uiDistDir, { recursive: true });

if (fs.existsSync(uiEntry)) {
  await build({
    entryPoints: [uiEntry],
    outfile: path.join(uiDistDir, 'main.js'),
    ...browserMinify,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    bundle: true,
    sourcemap: true,
    define,
  });
  console.log('[build] Bundled src/ui/main.ts to dist/ui/main.js.');
}

// 5b. GPU check page script (src/ui/gpucheck.ts -> dist/ui/gpucheck.js)
const gpuCheckEntry = path.join(srcDir, 'ui', 'gpucheck.ts');
if (fs.existsSync(gpuCheckEntry)) {
  await build({
    entryPoints: [gpuCheckEntry],
    outfile: path.join(uiDistDir, 'gpucheck.js'),
    ...browserMinify,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    bundle: true,
    sourcemap: true,
    define,
  });
  console.log('[build] Bundled src/ui/gpucheck.ts to dist/ui/gpucheck.js.');
}

if (fs.existsSync(uiCssEntry)) {
  await build({
    entryPoints: [uiCssEntry],
    outfile: path.join(uiDistDir, 'main.css'),
    bundle: true,
    minify: true,
    sourcemap: true,
  });
  console.log('[build] Bundled src/ui/main.css to dist/ui/main.css.');
}

// 6. Copy src/index.html, src/sw.js, src/manifest.webmanifest, and src/icon.svg -> dist/
for (const staticAsset of ['index.html', 'gpucheck.html', 'sw.js', 'manifest.webmanifest', 'icon.svg']) {
  const assetSrc = path.join(srcDir, staticAsset);
  if (fs.existsSync(assetSrc)) {
    fs.copyFileSync(assetSrc, path.join(distDir, staticAsset));
    console.log(`[build] Copied src/${staticAsset} to dist/${staticAsset}.`);
  }
}
// The licence and third-party notices travel with the deployed bundle (MIT / Zlib / BSD
// notices must accompany redistributed copies of the bundled code).
for (const [from, to] of [['LICENSE', 'LICENSE.txt'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md']]) {
  fs.copyFileSync(path.join(rootDir, from), path.join(distDir, to));
  console.log(`[build] Copied ${from} to dist/${to}.`);
}

// 6b. Every `new URL('<relative>', import.meta.url)` in the built code must name a file in dist/
//     (a library user's worker would otherwise 404).
{
  const missing = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'ort') walk(full);
      } else if (ent.name.endsWith('.js') && ent.name !== 'sw.js') {
        const code = fs.readFileSync(full, 'utf8');
        for (const m of code.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) {
          const target = path.resolve(path.dirname(full), m[1]);
          if (!fs.existsSync(target)) missing.push(`${path.relative(distDir, full)} -> ${m[1]}`);
        }
      }
    }
  };
  walk(distDir);
  if (missing.length > 0) {
    throw new Error(`[build] Relative URLs in the built code point to missing files:\n  ${missing.join('\n  ')}`);
  }
}

// 7. Stamp the service worker with a content hash + generated precache lists so every
//    release gets a fresh cache and code can never be served stale (no hand-bumping).
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './ui/main.js',
  './ui/main.css',
  './workers/grainPostprocess.worker.js',
  './workers/ortWasm.worker.js',
  './gpucheck.html',
  './ui/gpucheck.js',
  // Linked from the About dialog: available offline too.
  './LICENSE.txt',
  './THIRD_PARTY_NOTICES.md',
];
const ORT_ASSETS = ORT_RUNTIME_FILES.map((f) => `./ort/${f}`);
const hash = crypto.createHash('sha256');
for (const rel of SHELL_ASSETS.slice(1)) {
  hash.update(rel);
  hash.update(fs.readFileSync(path.join(distDir, rel)));
}
const buildHash = hash.digest('hex').slice(0, 16);
const swPath = path.join(distDir, 'sw.js');
const swSrc = fs
  .readFileSync(swPath, 'utf8')
  .replace('__WEBGRAINY_BUILD_HASH__', buildHash)
  .replace('__WEBGRAINY_ORT_VERSION__', ortPkg.version)
  .replace('__WEBGRAINY_SHELL_ASSETS__', JSON.stringify(SHELL_ASSETS))
  .replace('__WEBGRAINY_ORT_ASSETS__', JSON.stringify(ORT_ASSETS));
if (swSrc.includes('__WEBGRAINY_')) {
  throw new Error('[build] Unreplaced placeholder in dist/sw.js');
}
fs.writeFileSync(swPath, swSrc);
console.log(`[build] Stamped dist/sw.js (build ${buildHash}, ORT ${ortPkg.version}).`);
