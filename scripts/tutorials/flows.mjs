// Steps shared by several tutorials. Each runs visibly while recording, or instantly
// inside a tutorial's prepare() (d.instant).
import { photo } from './lib.mjs';

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
