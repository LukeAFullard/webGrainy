// Tutorial 2: set the scale from a ruler, so sizes are in millimetres.
import { addPhotos, analyse, PHOTO_A, PHOTO_B, RULER, setLength } from './flows.mjs';

export const title = 'Set the scale';

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
  const { page } = d;
  await d.card('webGrainy tutorial 2', title, 'About a minute · no sound');

  await d.ring('[data-scale-readout]');
  await d.caption('These photos are analysed, but sizes are still in <b>pixels</b>. Mark something of known length to convert them to millimetres.');
  await d.ring(null);

  await d.click('[data-tool="calibrate"]', { after: 700 });
  await d.ring('#cal-preset');
  await d.caption('Choose a preset, or type the real length. This photo has a folding ruler: three segments are <b>600 mm</b>.', { hold: 0 });
  await setLength(d, 600);
  await d.wait(1800);
  await d.ring(null);

  await d.caption('Now click the two ends of that length on the photo. Zoom in first for accuracy.', { hold: 0 });
  await markRuler(d, PHOTO_A);
  await d.ring('[data-scale-readout]');
  await d.caption('Done: the scale is shown above the photo, and every size is now in mm.');
  await d.ring('.stat-grid');
  await d.caption('D<sub>50</sub> for this photo is now in millimetres.', { hold: 2600 });
  await d.ring(null);

  await d.caption('Each photo needs a scale. The second photo was taken from a different height, so mark its ruler too.', { hold: 0 });
  await d.openPhoto(PHOTO_B, { after: 900 });
  await d.click('[data-tool="calibrate"]', { after: 500 });
  await markRuler(d, PHOTO_B);
  await d.wait(1200);

  await d.ring('[data-action="copy-scale-start"]');
  await d.caption('Photos taken with the same camera at the same height can share one scale: use <b>Copy scale to photos…</b>');
  await d.ring('[data-tool="rectify"]');
  await d.caption('Photo taken at an angle? <b>Rectify</b> straightens it using the four corners of a quadrat of known size.');
  await d.ring(null);

  await d.click('[data-tool="inspect"]', { after: 300 });
  await d.click('[data-scope="site"]', { after: 1200 });
  await d.ring('.stat-grid');
  await d.caption('With every photo scaled, <b>Whole site</b> combines them into one result for the site.');
  await d.ring(null);

  await d.card('Next', 'Check and edit the outlines', 'Inspect grains, fix wrong outlines and leave out the ruler.', 3500);
}
