// Set the scale from a ruler, so sizes are in millimetres.
import { addPhotos, analyse, PHOTO_A, PHOTO_B, RULER, setLength } from './flows.mjs';

export const chapter = 'Scale';
export const title = 'Set the scale';
export const summary = 'Calibrate each photo from a ruler or quadrat, so sizes are in millimetres.';

export async function prepare(d) {
  await addPhotos(d);
  await analyse(d);
  await d.openPhoto(PHOTO_A);
}

/** Marks the ruler on one photo, zoomed in on it. */
async function markRuler(d, file) {
  const r = RULER[file];
  await d.fit({ after: 500 });
  const mid = [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2];
  await d.zoomAt(file, ...mid, -5, { ms: 900 });
  await d.wait(500);
  await d.clickPhoto(file, ...r.a, { ms: 900, after: 700 });
  await d.clickPhoto(file, ...r.b, { ms: 1300, after: 900 });
}

export async function run(d) {
  await d.ring('[data-scale-readout]');
  await d.caption('These photos are analysed, but their sizes are still in <b>pixels</b>. Mark something of known length to convert them to millimetres.');
  await d.ring(null);

  await d.caption('Choose <b>Calibrate</b> in the toolbar.', { hold: 0 });
  await d.click('[data-tool="calibrate"]', { after: 900 });
  await d.ring('#cal-preset');
  await d.caption('Pick a preset: a 100 millimetre ruler, a 25 millimetre coin or a 500 millimetre quadrat. Or type any length, in millimetres or centimetres.');
  await d.caption('This photo has a folding ruler. Three of its segments are <b>600 millimetres</b> long.', { hold: 0 });
  await setLength(d, 600);
  await d.wait(1500);
  await d.ring(null);

  await d.caption('Now click the two ends of that length on the photo. Zoom in first: the closer you look, the more precise the scale.', { hold: 0 });
  await markRuler(d, PHOTO_A);
  await d.ring('[data-scale-readout]');
  await d.caption('Done. The scale is shown above the photo, in millimetres per pixel, and every size is now in millimetres.');
  await d.ring('.stat-grid');
  await d.caption('D50 for this photo is now in millimetres.');
  await d.ring(null);

  await d.caption('Every photo needs its own scale. The second photo was taken from a different height, so mark its ruler too.', { hold: 0 });
  await d.openPhoto(PHOTO_B, { after: 900 });
  await d.click('[data-tool="calibrate"]', { after: 500 });
  await markRuler(d, PHOTO_B);
  await d.wait(1200);

  await d.ring('[data-action="copy-scale-start"]');
  await d.caption('Photos taken with the same camera at the same height can share one scale: the next video shows <b>Copy scale to photos</b>.');
  await d.ring(null);

  await d.click('[data-tool="inspect"]', { after: 300 });
  await d.click('[data-scope="site"]', { after: 1200 });
  await d.ring('.stat-grid');
  await d.caption('With every photo scaled, <b>Whole site</b> combines them into one result for the site.');
  await d.ring(null);
}
