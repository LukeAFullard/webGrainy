// Sampling area (ROI) and exclusions: polygon, brush, clear; then analyse.
import { addPhotos, analyse, PHOTO_A } from './flows.mjs';

export const chapter = 'Areas and outlines';
export const title = 'Mark the sampling area and leave things out';
export const summary = 'Count only the grains inside a quadrat, and leave out rulers, boots, water or plants.';

export async function prepare(d) {
  await addPhotos(d, [PHOTO_A]);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.fit();
}

export async function run(d) {
  const { page } = d;
  const P = PHOTO_A;
  await d.caption('Often only part of a photo should be counted: the inside of a quadrat, say, but not the ruler. Mark these areas <b>before</b> analysing; it is faster.');

  await d.click('[data-tool="roiPoly"]', { after: 700 });
  await d.caption('<b>ROI</b>, the region of interest, is your sampling area. Click around it, then press <b>Finish shape</b>. Only grains inside it are counted.', { hold: 0 });
  await d.fit({ after: 400 });
  for (const [x, y] of [[150, 60], [1215, 45], [1142, 1190], [90, 1152]]) await d.clickPhoto(P, x, y, { ms: 800, after: 300 });
  await d.click('[data-action="finish-shape"]', { after: 1500 });
  await d.caption('Drawing a new ROI replaces the old one.');

  await d.click('[data-tool="excludePoly"]', { after: 700 });
  await d.caption('<b>Exclude</b> leaves an area out: a ruler, a boot, water or a deep shadow. Here, the ruler along the bottom.', { hold: 0 });
  await d.zoomAt(P, 810, 1165, -3, { ms: 900 });
  for (const [x, y] of [[462, 1132], [1148, 1146], [1148, 1198], [462, 1184]]) await d.clickPhoto(P, x, y, { ms: 700, after: 250 });
  await d.click('[data-action="finish-shape"]', { after: 1500 });

  await d.fit({ after: 500 });
  await d.click('[data-tool="excludeBrush"]', { after: 700 });
  await d.caption('<b>Brush</b> paints over small or irregular things, like this ruler on the left. Hold the button down and drag.', { hold: 0 });
  await d.zoomAt(P, 140, 400, -3, { ms: 900 });
  await d.dragPhoto(P, [[158, 90], [150, 200], [143, 300], [137, 400], [131, 500], [126, 600], [121, 700]], { ms: 2600 });
  await d.wait(800);
  await d.fit({ after: 600 });

  await d.ring('[data-action="clear-areas"]');
  await d.caption('<b>Clear areas</b> removes this photo\'s ROI and all its exclusions, if you want to start again.');
  await d.ring(null);

  await d.caption('Now analyse. Parts of the photo far from the ROI are skipped, which saves time on big photos. This part is sped up.', { hold: 0 });
  d.speed(6);
  await analyse(d);
  d.speed(1);
  await d.click('[data-tool="inspect"]', { after: 400 });
  await d.fit({ after: 800 });
  await d.ring('#canvas-stage');
  await d.caption('Grains outside the ROI, or inside an excluded area, are drawn but not counted.');
  await d.ring(page.locator('#dashboard-right .basis-banner, #dashboard-right [class*="banner"]').first());
  await d.caption('The results count only the grains in the sampling area. A grain is dropped if more than 10 percent of it lies in an excluded area; <b>Exclusion overlap</b> in Statistics settings changes that.');
  await d.ring(null);
  await d.caption('Excluding is better than deleting outlines for things like rulers, because the excluded area also stops counting as gravel bed.');
}
