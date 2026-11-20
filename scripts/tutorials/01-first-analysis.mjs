// Tutorial 1: add photos and run a first analysis.
import { photo } from './lib.mjs';

export const title = 'Add photos and run your first analysis';

/** @param {Awaited<ReturnType<import('./lib.mjs').startTutorial>>} d */
export async function run(d) {
  const { page } = d;
  const photos = [await photo('K1_C2_385.jpg'), await photo('K1_C3_0449.jpg')];

  await d.card('webGrainy tutorial 1', title, 'About a minute · no sound');
  await d.caption('webGrainy measures grain sizes from photos of gravel. <b>Everything runs in your browser</b>: your photos are never uploaded.');

  await d.caption('Start by adding one or more photos of the same patch of gravel.', { hold: 0 });
  await d.chooseFiles(page.getByRole('button', { name: 'Add Gravel Photos' }), photos, { after: 300 });
  await page.waitForSelector('.photo-item');
  await d.wait(1200);

  await d.ring(page.locator('.photo-item').first().locator('xpath=..'));
  await d.caption('Each photo appears in the list. Click one to show it in the middle panel. Photos taken at one place and date belong to one <b>site</b>.');
  await d.ring(null);

  const notice = page.locator('[data-action="dismiss-retention-explained"]').locator('xpath=ancestor::div[2]');
  await d.ring(notice);
  await d.caption('Photos are kept in this browser for 30 days (you can change this). To keep your results, <b>download them</b> to your computer.');
  await d.ring(null);
  await d.click('[data-action="dismiss-retention-explained"]');

  await d.ring('section.guide');
  await d.caption('The <b>Getting started</b> list walks you through each step. Setting the scale is optional here: without it, sizes are in pixels.');
  await d.ring(null);

  await d.caption('Click <b>Analyse</b>. The first time, the model downloads (26 MB); after that it works offline.', { hold: 0 });
  await d.click(page.locator('[data-action="run-batch"]').last(), { after: 800 });
  await d.wait(1500);
  await d.caption('Finding grains in both photos… <b>(sped up)</b>', { hold: 0 });
  d.speed(6);
  await page.waitForFunction(() => /Batch complete|Batch error|Batch cancelled/.test(document.body.innerText), null, {
    timeout: 15 * 60 * 1000, polling: 500,
  });
  d.speed(1);
  await d.caption(null);
  await d.wait(1200);

  await d.ring('#canvas-stage');
  await d.caption('Each grain now has a coloured outline.');
  await d.ring(null);
  await d.point('#canvas-stage', { fx: 0.42, fy: 0.45, ms: 900 });
  await d.caption('Zoom in with the mouse wheel to check them: the model traces each stone\'s <b>true edge</b>.', { hold: 0 });
  await d.wheel(-9);
  await d.wait(3500);
  await d.click('[data-action="fit-view"]', { after: 900 });

  await d.ring('.stat-grid');
  await d.caption('D<sub>16</sub>, D<sub>50</sub> and D<sub>84</sub> for this photo appear on the right…');
  await d.ring(page.locator('svg', { hasText: 'Cumulative PSD' }).first());
  await d.caption('…with the grain-size curve below. These are in <b>pixels</b>: set the scale to get millimetres and whole-site results.');
  await d.ring(null);

  await d.card('Next', 'Set the scale', 'Calibrate from the ruler or quadrat so sizes are in millimetres.', 3500);
}
