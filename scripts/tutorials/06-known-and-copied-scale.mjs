// Type a scale you already know, and copy one photo's scale to others.
import { addPhotos, analyse, calibrate, PHOTO_A, PHOTO_B } from './flows.mjs';

export const chapter = 'Scale';
export const title = 'Type a known scale, or copy one';
export const summary = 'No ruler in the photo? Enter the scale directly, or share it between photos.';

export async function prepare(d) {
  await addPhotos(d);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await d.click('[data-tool="inspect"]');
  await d.openPhoto(PHOTO_B);
}

export async function run(d) {
  const { page } = d;
  await d.ring('[data-scale-readout]');
  await d.caption('This photo has no scale yet. If you already know it, from the camera set-up, a survey report or an orthophoto, you can simply type it in.');
  await d.ring(null);

  await d.click('[data-tool="calibrate"]', { after: 800 });
  await d.ring('#cal-scale-value');
  await d.caption('In the Calibrate toolbar, type the <b>known scale</b>…', { hold: 0 });
  await d.type('#cal-scale-value', '1.447');
  await d.wait(1200);
  await d.ring('#cal-scale-unit');
  await d.caption('…choose millimetres per pixel, or pixels per millimetre…', { hold: 0 });
  await d.wait(2000);
  await d.ring('[data-action="cal-scale-apply"]');
  await d.caption('…and press <b>Set scale</b>.', { hold: 0 });
  await d.click('[data-action="cal-scale-apply"]', { after: 1200 });
  await d.ring('[data-scale-readout]');
  await d.caption('The scale is per pixel of the photo as taken. Exports record that it was entered by hand rather than measured.');
  await d.ring(null);

  await d.caption('Now the other way to save time. Show a photo that already has a scale…', { hold: 0 });
  await d.openPhoto(PHOTO_A, { after: 900 });
  await d.click('[data-tool="calibrate"]', { after: 600 });
  await d.ring('[data-action="copy-scale-start"]');
  await d.caption('…and press <b>Copy scale to photos</b>.', { hold: 0 });
  await d.click('[data-action="copy-scale-start"]', { after: 1200 });
  await d.ring('#sidebar-left .bulk-bar');
  await d.caption('Tick the photos that should get this scale, then press <b>Copy scale</b>. Photos of the same size without a scale are ticked for you.');
  await d.caption('Only copy a scale between photos taken with the <b>same camera, zoom and height</b>. Ours were taken from different heights, so here we cancel.');
  await d.ring(null);
  await d.click(page.locator('#sidebar-left .bulk-bar [data-action="photo-select-mode"]'), { after: 800 });
  await d.click('[data-tool="inspect"]', { after: 300 });

  await d.caption('GeoTIFF photos, such as drone orthophotos, need no calibration at all: their scale is read from the georeferencing. Tutorial 22 shows them.');
}
