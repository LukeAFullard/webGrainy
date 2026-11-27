#!/usr/bin/env node
// Records the tutorial videos from the BUILT app into tutorials/out/.
//
//   npm run build && npm run tutorials            # all tutorials
//   npm run tutorials -- 01 07                    # only those whose file name contains "01" or "07"
//
// For each tutorial NN-name.mjs it writes NN-name.mp4 and the on-screen text with its timing
// (NN-name.srt, .vtt, .transcript.md and .transcript.json, for subtitles or a voiceover), and
// updates tutorials/out/transcripts.md with every transcript recorded so far.
//
// Needs ffmpeg on PATH. Downloads the pinned U-Net weights and two ImageGrains demo photos
// into .cache/ on first use (both checked by SHA-256). Set KEEP_FRAMES=1 to keep the raw
// frames next to each video, and TUTORIAL_WPS to the voiceover's words per second (default
// 2.5) to change how long captions stay up.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUT, startTutorial, transcriptMarkdown } from './tutorials/lib.mjs';

const dir = join(import.meta.dirname, 'tutorials');
const filters = process.argv.slice(2);
const all = readdirSync(dir).filter((f) => /^\d\d-.*\.mjs$/.test(f)).sort();
const files = all.filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));
if (files.length === 0) {
  console.error('no tutorial matches', filters);
  process.exit(1);
}
const load = async (f) => import(pathToFileURL(join(dir, f)).href);
mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const f of files) {
  const name = f.replace(/\.mjs$/, '');
  const mod = await load(f);
  const i = all.indexOf(f);
  const next = i + 1 < all.length ? (await load(all[i + 1])).title : undefined;
  const meta = { index: i + 1, total: all.length, title: mod.title, chapter: mod.chapter, summary: mod.summary, next };
  console.log(`recording ${name}: ${mod.title}`);
  const t0 = Date.now();
  let d;
  try {
    d = await startTutorial(name, { prepare: mod.prepare, meta });
    await d.intro();
    await mod.run(d);
    await d.outro();
    const mp4 = await d.finish();
    if (d.problems.length) console.warn(`  page problems:\n  ${d.problems.join('\n  ')}`);
    console.log(`  ${mp4} (${((Date.now() - t0) / 1000).toFixed(0)} s to record)`);
  } catch (e) {
    failed++;
    console.error(`  FAILED ${name}: ${e?.stack ?? e}`);
    await d?.page.screenshot({ path: join(OUT, `${name}.error.png`) }).catch(() => {});
    await d?.page.context().browser()?.close().catch(() => {});
    if (process.env.TUTORIAL_STOP_ON_ERROR) break;
  }
}

// Every transcript recorded so far, in tutorial order, as one voiceover script.
const transcripts = readdirSync(OUT).filter((f) => f.endsWith('.transcript.json')).sort()
  .map((f) => JSON.parse(readFileSync(join(OUT, f), 'utf8')))
  .filter((t) => existsSync(join(OUT, t.video)));
writeFileSync(join(OUT, 'transcripts.md'), [
  '# webGrainy tutorial videos: on-screen text with timings',
  '',
  'Each row is one caption or title card as it appears in the video, with its start and end',
  'time (minutes:seconds) and the time available to say it. Captions are timed for a voiceover',
  `at about ${transcripts[0]?.wordsPerSecond ?? 2.2} words a second.`,
  '',
  ...transcripts.map(transcriptMarkdown),
].join('\n'));
if (failed) console.error(`${failed} tutorial(s) failed`);
// A failed tutorial can leave its browser or file server open: exit explicitly.
process.exit(failed ? 1 : 0);
