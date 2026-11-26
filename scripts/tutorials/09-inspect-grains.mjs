// Inspect grains: the inspector card, stepping through grains, Largest and flagged grains.
import { addPhotos, analyse, calibrate, PHOTO_A } from './flows.mjs';

export const chapter = 'Areas and outlines';
export const title = 'Inspect grains and find suspect outlines';
export const summary = 'See each grain\'s measurements, and jump straight to the outlines most worth checking.';

export async function prepare(d) {
  await addPhotos(d, [PHOTO_A]);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
  await d.fit();
}

export async function run(d) {
  const { page } = d;
  const P = PHOTO_A;
  await d.caption('The model is good, not perfect. Look over the outlines before you trust the numbers. <b>Inspect</b> is the tool for that.');

  await d.zoomAt(P, 769, 489, -4, { ms: 900 });
  await d.caption('Click a grain to see its measurements.', { hold: 0 });
  await d.clickPhoto(P, 769, 489, { ms: 900, after: 1000 });
  await d.ring('#inspector-card');
  await d.caption('The <b>b-axis</b> is the size used: the short axis of the ellipse that matches the outline. The <b>a-axis</b> is the long one.');
  await d.caption('Then the diameter of a circle of the same area, the narrowest and widest caliper widths, called Feret widths, the area, and shape measures.');
  await d.caption('<b>Border</b> says whether the grain touches the photo edge. Such grains are cut off, so they are left out of the statistics.');
  await d.ring(page.locator('#inspector-card [data-nav="next"]'));
  await d.caption('<b>Prev</b> and <b>Next</b> step through the grains one by one, and the view follows.', { hold: 0 });
  await d.click('#inspector-card [data-nav="next"]', { after: 1600 });
  await d.click('#inspector-card [data-nav="next"]', { after: 1600 });
  await d.ring(null);
  await d.click('[data-action="close-inspector"]', { after: 600 });

  await d.ring('#sub-toolbar [data-nav="largest"]');
  await d.caption('<b>Largest</b> jumps to the biggest grain. One big stone can move the results a lot, so make sure it is really one stone.', { hold: 0 });
  await d.click('#sub-toolbar [data-nav="largest"]', { after: 2500 });
  await d.ring(null);
  await d.click('[data-action="close-inspector"]', { after: 400 }).catch(() => {});

  await d.ring('#sub-toolbar [data-nav="flagged"]');
  await d.caption('<b>Next flagged</b> steps through grains worth a second look: touching the photo edge, outside the sampling area, or very elongated, which is often two stones merged.', { hold: 0 });
  await d.click('#sub-toolbar [data-nav="flagged"]', { after: 2200 });
  await d.click('#sub-toolbar [data-nav="flagged"]', { after: 2200 });
  await d.ring(null);
  await d.click('[data-action="close-inspector"]', { after: 400 }).catch(() => {});

  await d.click('details.flag-list > summary', { after: 900 });
  await d.ring('details.flag-list');
  await d.caption('The <b>Flagged</b> list groups them by reason. Click a number to jump to that grain.', { hold: 0 });
  await d.wait(2500);
  const groups = page.locator('details.flag-list .flag-group');
  await d.click(groups.last().locator('.flag-item').first(), { after: 2500 });
  await d.ring(null);
  await d.click('details.flag-list > summary', { after: 600 }).catch(() => {});
  await d.caption('Found a wrong outline? Fix it with the <b>Edit grains</b> tools, in the next video.');
}
