// Straighten a photo taken at an angle with 4-point Rectify.
import { addPhotos, analyse, obliquePhoto, OBLIQUE } from './flows.mjs';

export const chapter = 'Scale';
export const title = 'Straighten a photo taken at an angle';
export const summary = 'Rectify removes perspective using the four corners of a quadrat, and sets the scale too.';

let corners;

export async function prepare(d) {
  const o = await obliquePhoto();
  corners = o.corners;
  await addPhotos(d, [], [o.path]);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.fit();
}

export async function run(d) {
  const { page } = d;
  await d.ring('#canvas-stage');
  await d.caption('This example photo was tilted on purpose, and a one-metre square quadrat drawn on it. In a tilted photo, the far grains look smaller than they are.');
  await d.ring(null);

  await d.caption('Choose <b>Rectify</b>, and type the real width and height of the rectangle you will mark: here 1000 by 1000 millimetres.', { hold: 0 });
  await d.click('[data-tool="rectify"]', { after: 800 });
  for (const sel of ['#rect-w', '#rect-h']) {
    await d.type(sel, '1000');
    await page.locator(sel).dispatchEvent('change');
    await d.wait(500);
  }
  await d.wait(1500);

  await d.caption('Click its four corners in order: <b>top left, top right, bottom right, bottom left</b>.', { hold: 0 });
  await d.fit({ after: 500 });
  for (const [i, [x, y]] of corners.entries()) {
    await d.clickPhoto(OBLIQUE, x, y, { ms: 900, after: i === 3 ? 2500 : 700 });
  }
  await d.resetView();
  await d.fit({ after: 1200 });
  await d.ring('#canvas-stage');
  await d.caption('The photo is straightened: the quadrat is square again, and every part of the photo has the same scale.');
  await d.ring('[data-scale-readout]');
  await d.caption('Rectify also sets the scale from the quadrat\'s size, so no separate calibration is needed.');
  await d.ring('[data-action="rectify-undo"]');
  await d.caption('<b>Undo rectify</b> brings back the original photo, with its scale and areas.');
  await d.ring(null);

  await d.caption('Rectify before analysing. Then analyse as usual. This part is sped up.', { hold: 0 });
  d.speed(6);
  await analyse(d);
  d.speed(1);
  await d.click('[data-tool="inspect"]', { after: 600 });
  await d.ring('.stat-grid');
  await d.caption('The grains are measured on the straightened photo, in millimetres.');
  await d.ring(null);
}
