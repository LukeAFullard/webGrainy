// Tutorial 3: check and edit outlines, and leave out the ruler.
// Grain positions (photo pixels) were read from this photo's Photo Grains CSV.
import { addPhotos, analyse, calibrate, PHOTO_A } from './flows.mjs';

export const title = 'Check and edit the outlines';

export async function prepare(d) {
  await addPhotos(d, [PHOTO_A]);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await d.click('[data-tool="inspect"]');
  await d.fit();
}

export async function run(d) {
  const { page } = d;
  const P = PHOTO_A;
  await d.card('webGrainy tutorial 3', title, 'About 90 seconds · no sound');

  await d.caption('The model is good, not perfect. Look over the outlines before you trust the numbers.');
  await d.zoomAt(P, 690, 500, -4, { ms: 900 });
  await d.wait(600);

  // Inspect
  await d.caption('With <b>Inspect</b>, click a grain to see its measurements.', { hold: 0 });
  await d.clickPhoto(P, 769, 488, { ms: 900, after: 900 });
  await d.ring('.inspector-card');
  await d.caption('Its axes, size in mm and shape. The size used is the b-axis: the short axis of the ellipse that matches the outline.');
  await d.ring(null);
  await d.click('[data-action="close-inspector"]');

  // Split, then undo
  await d.click('[data-tool="split"]', { after: 600 });
  await d.caption('If one outline covers two stones, use <b>Split</b>: click on the stone, then draw a line right across it and press <b>Finish shape</b>.', { hold: 0 });
  // The first click picks the grain, so start on it; the line must then cross it fully.
  await d.clickPhoto(P, 596, 425, { ms: 900, after: 300 });
  await d.clickPhoto(P, 596, 360, { ms: 600, after: 300 });
  await d.clickPhoto(P, 596, 545, { ms: 900, after: 500 });
  await d.click('[data-action="finish-shape"]', { after: 1500 });
  await d.caption('This one really was a single stone, so press <b>Undo</b>.', { hold: 0 });
  await d.click('[data-action="undo"]', { after: 1800 });

  // Merge, then undo
  await d.click('[data-tool="merge"]', { after: 600 });
  await d.caption('If one stone was cut into pieces, use <b>Merge</b>: click each piece, then <b>Merge</b>.', { hold: 0 });
  await d.clickPhoto(P, 748, 409, { ms: 900, after: 500 });
  await d.clickPhoto(P, 711, 421, { ms: 700, after: 700 });
  await d.click('[data-action="commit-merge"]', { after: 1500 });
  await d.caption('These were two stones after all: <b>Undo</b> again. Every edit can be undone.', { hold: 0 });
  await d.click('[data-action="undo"]', { after: 1800 });

  // Delete a stone cut by the ruler
  await d.fit({ after: 600 });
  await d.zoomAt(P, 900, 1150, -5, { ms: 900 });
  await d.click('[data-tool="delete"]', { after: 600 });
  await d.caption('This outline is only half a stone: the ruler hides the rest. With <b>Delete</b>, click it to remove it.', { hold: 0 });
  await d.wait(1500);
  await d.clickPhoto(P, 951, 1150, { ms: 900, after: 2000 });

  // Exclude the ruler
  await d.fit({ after: 600 });
  await d.click('[data-tool="excludePoly"]', { after: 600 });
  await d.caption('Better still, leave out the whole ruler. With <b>Exclude → Area</b>, click around it, then <b>Finish shape</b>.', { hold: 0 });
  for (const [x, y] of [[470, 1128], [1150, 1140], [1150, 1200], [470, 1190]]) await d.clickPhoto(P, x, y, { ms: 700, after: 250 });
  await d.click('[data-action="finish-shape"]', { after: 2000 });
  await d.caption('Grains inside the area are left out of the results. Use the same tool for boots, water or shadows.');

  await d.click('[data-tool="inspect"]', { after: 400 });
  await d.ring('[data-nav="flagged"]');
  await d.caption('<b>Flagged</b> steps through grains worth a second look: cut off by the photo edge, or very elongated.');
  await d.ring(null);

  await d.card('Next', 'Read the site results', 'D50 with confidence intervals, the grain-size curve and whether you counted enough.', 3500);
}
