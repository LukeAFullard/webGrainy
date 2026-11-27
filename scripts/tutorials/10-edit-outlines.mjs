// Fix outlines: Split, Merge, Delete, Add, Undo/Redo, Tidy outlines and shortcuts.
// Grain positions (photo pixels) were read from this photo's outlines (GeoJSON export).
import { addPhotos, analyse, calibrate, PHOTO_A } from './flows.mjs';

export const chapter = 'Areas and outlines';
export const title = 'Fix outlines: split, merge, delete and add';
export const summary = 'Correct the model\'s mistakes by hand. Every edit can be undone, and results update at once.';

/** Outline of the stone near (769, 489), for the Add demonstration. */
const STONE = [[762, 426], [800, 429], [833, 443], [844, 480], [828, 510], [803, 534], [779, 557], [742, 556], [718, 532], [694, 508], [705, 472], [726, 445]];

export async function prepare(d) {
  await addPhotos(d, [PHOTO_A]);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
  await d.fit();
}

export async function run(d) {
  const P = PHOTO_A;
  await d.ring('#toolbar');
  await d.caption('Once a photo is analysed, the <b>Edit grains</b> tools appear: Split, Merge, Delete and Add. The statistics update after every edit.');
  await d.ring(null);
  await d.zoomAt(P, 690, 500, -4, { ms: 900 });

  // Split, then undo
  await d.click('[data-tool="split"]', { after: 600 });
  await d.caption('If one outline covers two stones, use <b>Split</b>: click on the stone, draw a line right across it, and press <b>Finish shape</b>.', { hold: 0 });
  // The first click picks the grain, so start on it; the line must then cross it fully.
  await d.clickPhoto(P, 596, 425, { ms: 900, after: 300 });
  await d.clickPhoto(P, 596, 360, { ms: 600, after: 300 });
  await d.clickPhoto(P, 596, 545, { ms: 900, after: 500 });
  await d.click('[data-action="finish-shape"]', { after: 1500 });
  await d.caption('This one really was a single stone, so press <b>Undo</b>.', { hold: 0 });
  await d.click('[data-action="undo"]', { after: 1800 });

  // Merge, undo, redo, undo
  await d.click('[data-tool="merge"]', { after: 600 });
  await d.caption('If one stone was cut into pieces, use <b>Merge</b>: click each piece, then press <b>Merge</b>.', { hold: 0 });
  await d.clickPhoto(P, 748, 409, { ms: 900, after: 500 });
  await d.clickPhoto(P, 711, 421, { ms: 700, after: 700 });
  await d.click('[data-action="commit-merge"]', { after: 1500 });
  await d.caption('These were two stones after all. <b>Undo</b> takes the merge back, and <b>Redo</b> would repeat it.', { hold: 0 });
  await d.click('[data-action="undo"]', { after: 1200 });
  await d.ring('[data-action="redo"]');
  await d.wait(2000);
  await d.ring(null);

  // Delete a stone cut by the ruler
  await d.fit({ after: 600 });
  await d.zoomAt(P, 900, 1150, -5, { ms: 900 });
  await d.click('[data-tool="delete"]', { after: 600 });
  await d.caption('This outline is only half a stone: the ruler hides the rest. With <b>Delete</b>, click it to remove it. Leaving out the whole ruler with Exclude is even better.', { hold: 0 });
  await d.wait(1500);
  await d.clickPhoto(P, 951, 1150, { ms: 900, after: 2000 });

  // Add: remove one outline, then draw it again
  await d.fit({ after: 600 });
  await d.zoomAt(P, 769, 489, -5, { ms: 900 });
  await d.caption('Now pretend the model missed this stone: delete its outline first…', { hold: 0 });
  await d.clickPhoto(P, 769, 489, { ms: 900, after: 1500 });
  await d.click('[data-tool="addPolygon"]', { after: 600 });
  await d.caption('…then, with <b>Add</b>, click around its edge and press <b>Finish shape</b>. Double-click or Enter also finishes; Esc cancels.', { hold: 0 });
  for (const [x, y] of STONE) await d.clickPhoto(P, x, y, { ms: 380, after: 120 });
  await d.click('[data-action="finish-shape"]', { after: 1800 });

  await d.click('[data-tool="inspect"]', { after: 400 });
  await d.ring('[data-action="tidy-outlines"]');
  await d.caption('<b>Tidy outlines</b> makes every grain one solid piece, removing stray specks. It already runs after every analysis; use it again after heavy editing.');
  await d.ring(null);
  await d.caption('Shortcuts save time: <b>Ctrl+Z</b> undoes, <b>Ctrl+Y</b> redoes, and the number keys pick tools. On a Mac, use Command.');
  await d.fit({ after: 500 });
}
