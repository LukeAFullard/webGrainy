// How to take photos that measure well.
import { addPhotos, PHOTO_A } from './flows.mjs';

export const chapter = 'Getting started';
export const title = 'Taking photos that measure well';
export const summary = 'A few minutes of care in the field saves hours of fixing outlines.';

export async function prepare(d) {
  await addPhotos(d, [PHOTO_A]);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.fit();
}

export async function run(d) {
  const P = PHOTO_A;
  await d.caption('No setting can rescue a poor photo. Here is what makes a photo measure well, shown on one of the sample photos.');

  await d.ring('#canvas-stage');
  await d.caption('<b>Shoot straight down</b>, from a height that frames the patch you want to sample. If you cannot, include a quadrat so the photo can be straightened with Rectify.');
  await d.ringPhoto(P, 470, 1120, 1160, 1210, 8);
  await d.caption('<b>Include a scale</b>: a ruler, quadrat or coin lying flat on the gravel, near the middle of the photo. The longer the reference, the more precise the scale.');
  await d.ring(null);

  await d.zoomAt(P, 700, 660, -7, { ms: 900 });
  await d.caption('<b>Make the smallest grains you care about at least 10 pixels across.</b> If they are smaller, move the camera closer.');
  await d.fit({ after: 600 });

  await d.card('Tip', 'Light and surface', 'Prefer even, diffuse light: an overcast day or shade.\nAvoid hard shadows, and wet or shiny stones.');
  await d.card('Tip', 'Count enough grains', 'At least 100 grains fully inside the frame per site, ideally several hundred.\nTake five or more photos per site for a reliable confidence interval.');
  await d.card('Tip', 'Mind the lens', 'Wide-angle and fisheye lenses, such as action cameras, distort sizes by 10 to 30% towards the edges.\nNormal phone cameras and most drone cameras are fine.');
  await d.card('Tip', 'Know the hard cases', 'Vegetation, a sand matrix, water, and single boulders that fill much of the frame are harder.\nLeave such areas out, and expect to correct more outlines.');

  await d.caption('Keep your original photos in your own folders: webGrainy works on copies stored inside the browser.');
}
