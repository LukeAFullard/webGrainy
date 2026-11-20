#!/usr/bin/env node
// Records the tutorial videos from the BUILT app into tutorials/out/*.mp4.
//
//   npm run build && npm run tutorials            # all tutorials
//   npm run tutorials -- 01                       # only those whose file name contains "01"
//
// Needs ffmpeg on PATH. Downloads the pinned U-Net weights and two ImageGrains demo photos
// into .cache/ on first use (both checked by SHA-256). Set KEEP_FRAMES=1 to keep the raw
// frames next to each video.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startTutorial } from './tutorials/lib.mjs';

const dir = join(import.meta.dirname, 'tutorials');
const filters = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => /^\d\d-.*\.mjs$/.test(f))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort();
if (files.length === 0) {
  console.error('no tutorial matches', filters);
  process.exit(1);
}
for (const f of files) {
  const name = f.replace(/\.mjs$/, '');
  const mod = await import(pathToFileURL(join(dir, f)).href);
  console.log(`recording ${name}: ${mod.title}`);
  const t0 = Date.now();
  const d = await startTutorial(name);
  try {
    await mod.run(d);
  } catch (e) {
    await d.page.screenshot({ path: join('tutorials', 'out', `${name}.error.png`) }).catch(() => {});
    throw e;
  }
  const mp4 = await d.finish();
  if (d.problems.length) console.warn(`  page problems:\n  ${d.problems.join('\n  ')}`);
  console.log(`  ${mp4} (${((Date.now() - t0) / 1000).toFixed(0)} s to record)`);
}
