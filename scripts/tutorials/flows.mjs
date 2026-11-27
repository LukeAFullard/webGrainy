// Steps shared by several tutorials. Each runs visibly while recording, or instantly
// inside a tutorial's prepare() (d.instant).
import { join } from 'node:path';
import { makeObliquePhoto } from './oblique.mjs';
import { photo, ROOT } from './lib.mjs';

export const PHOTO_A = 'K1_C3_0449.jpg';
export const PHOTO_B = 'K1_C2_385.jpg';

/**
 * Ends of three folding-ruler segments (3 × 200 mm) on each photo, in photo pixels,
 * read from the joints between segments.
 */
export const RULER = {
  [PHOTO_A]: { a: [612, 1161], b: [1003, 1173], mm: 600 },
  [PHOTO_B]: { a: [275, 95], b: [688, 131], mm: 600 },
};

/** Opens the workspace with sample photos (and any other files) added, not analysed. */
export async function addPhotos(d, files = [PHOTO_B, PHOTO_A], extraPaths = []) {
  const paths = [...(await Promise.all(files.map((f) => photo(f)))), ...extraPaths];
  await d.page.setInputFiles('#photo-file-input', paths);
  await d.page.waitForSelector('.photo-item');
  const gotIt = d.page.locator('[data-action="dismiss-retention-explained"]');
  if (await gotIt.count()) await gotIt.click();
}

export async function analyse(d) {
  await d.click(d.page.locator('[data-action="run-batch"]').last());
  await d.waitForBatch();
}

/** Calibrates `file` from its ruler (the Calibrate tool must be usable). */
export async function calibrate(d, file, { lengthFirst = true } = {}) {
  const { page } = d;
  const r = RULER[file];
  await d.openPhoto(file);
  await d.click('[data-tool="calibrate"]');
  if (lengthFirst) await setLength(d, r.mm);
  await d.fit({ after: 300 });
  await d.clickPhoto(file, ...r.a, { ms: 800 });
  await d.clickPhoto(file, ...r.b, { ms: 1000 });
  await page.waitForFunction(() => /Scale: [\d.]+ mm\/px/.test(document.body.innerText));
}

export async function setLength(d, mm) {
  await d.type('#cal-length', String(mm));
  await d.page.locator('#cal-length').dispatchEvent('change');
}

/** Types a site's place (repeat surveys of one place share the name). */
export async function setPlace(d, place) {
  await d.type('[data-site-place]', place);
  await d.page.locator('[data-site-place]').dispatchEvent('change');
  await d.wait(500);
}

/** Sets the open site's survey date (yyyy-mm-dd). */
export async function setDate(d, iso) {
  const loc = d.page.locator('[data-site-date]');
  await d.point(loc);
  await loc.fill(iso);
  await loc.dispatchEvent('change');
  await d.wait(600);
}

/** An example photo taken at an angle, with a 1 m quadrat drawn on it (see oblique.mjs). */
export const OBLIQUE = 'K1_C3_0449_tilted_example.jpg';
export async function obliquePhoto() {
  return makeObliquePhoto(PHOTO_A, {
    out: join(ROOT, '.cache', 'tutorial-photos', OBLIQUE), corner: [157, 71], dir: [641, -9], sidePx: 652,
  });
}

/** Names the open site (answers the Rename prompt). */
export async function nameSite(d, name) {
  d.answerPrompt(name);
  await d.click('[data-action="rename-site"]');
  await d.wait(600);
}

/** Opens (or closes) a folded <details> section by its summary text. */
export async function toggleDetails(d, text, root = '') {
  const sum = d.page.locator(`${root} details > summary`, { hasText: text }).first();
  await d.click(sum, { after: 700 });
}

/** Opens the folded section if it is closed. */
export async function openDetails(d, text, root = '') {
  const det = d.page.locator(`${root} details`, { has: d.page.locator('> summary', { hasText: text }) }).first();
  if (!(await det.evaluate((e) => e.open))) await toggleDetails(d, text, root);
}

/** Sets a number field (by selector) and commits it. */
export async function setNumber(d, sel, value) {
  await d.type(sel, String(value));
  await d.page.locator(sel).first().dispatchEvent('change');
  await d.wait(800);
}

/** Opens a top-bar dialog: models, export or about. */
export async function openModal(d, which) {
  await d.click(`#topbar [data-open-modal="${which}"]`, { after: 1000 });
}

export async function closeModal(d) {
  await d.click('#app-dialog [data-action="close-modal"]', { after: 700 });
}
