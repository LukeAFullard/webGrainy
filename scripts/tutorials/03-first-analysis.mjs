// Add photos and run a first analysis.
import { photo } from './lib.mjs';

export const chapter = 'Getting started';
export const title = 'Add photos and run your first analysis';
export const summary = 'From a folder of gravel photos to outlined grains in a few clicks.';

/** @param {Awaited<ReturnType<import('./lib.mjs').startTutorial>>} d */
export async function run(d) {
  const { page } = d;
  const photos = [await photo('K1_C2_385.jpg'), await photo('K1_C3_0449.jpg')];

  await d.caption('This is the overview page. Start with <b>Add Gravel Photos</b>, or drop photos anywhere on the page.', { hold: 0 });
  await d.ring('[data-action="add-photos"]');
  await d.wait(1500);
  await d.ring(null);
  await d.chooseFiles(page.getByRole('button', { name: 'Add Gravel Photos' }), photos, { after: 300 });
  await page.waitForSelector('.photo-item');
  await d.wait(1200);

  await d.ring(page.locator('.photo-item').first().locator('xpath=..'));
  await d.caption('Both photos appear in the photo list. Click one to show it in the middle. Photos taken at one place on one day belong together in one <b>site</b>.');
  await d.ring(null);

  const notice = page.locator('[data-action="dismiss-retention-explained"]').locator('xpath=ancestor::div[2]');
  await d.ring(notice);
  await d.caption('A reminder: photos are kept in this browser for 30 days, and are never uploaded. To keep your results, <b>download them</b>.');
  await d.ring(null);
  await d.click('[data-action="dismiss-retention-explained"]');

  await d.ring('section.guide');
  await d.caption('The <b>Getting started</b> list walks you through each step and ticks them off. Setting the scale is optional for a first look: without it, sizes are in pixels.');
  await d.ring(null);

  await d.caption('Click <b>Analyse</b>. The first time, the model downloads, about 26 megabytes. After that it works offline.', { hold: 0 });
  await d.click(page.locator('[data-action="run-batch"]').last(), { after: 800 });
  await d.wait(1500);
  await d.ring('#activity-bar');
  await d.caption('The bar at the bottom shows the current step, the tiles done and the time left, with a Cancel button.', { hold: 0 });
  await d.wait(2500);
  await d.ring(null);
  await d.caption('Finding grains in both photos. This part is sped up.', { hold: 0 });
  d.speed(6);
  await page.waitForFunction(() => /Batch complete|Batch error|Batch cancelled/.test(document.body.innerText), null, {
    timeout: 15 * 60 * 1000, polling: 500,
  });
  d.speed(1);
  await d.caption(null);
  await d.wait(1200);

  await d.ring('#canvas-stage');
  await d.caption('Every grain now has a coloured outline.');
  await d.ring(null);
  await d.point('#canvas-stage', { fx: 0.42, fy: 0.45, ms: 900 });
  await d.caption('Zoom in with the mouse wheel to check them, and drag to move around. The model traces each stone\'s edge.', { hold: 0 });
  await d.wheel(-9);
  await d.wait(1500);
  const p = await page.locator('#canvas-stage').boundingBox();
  await d.moveTo(p.x + p.width * 0.42, p.y + p.height * 0.45, 300);
  await page.mouse.down();
  await d.moveTo(p.x + p.width * 0.62, p.y + p.height * 0.35, 1200);
  await page.mouse.up();
  await d.wait(1200);
  await d.caption('Press <b>Fit</b> to see the whole photo again.', { hold: 0 });
  await d.click('[data-action="fit-view"]', { after: 1500 });

  await d.ring('.photo-item .badge');
  await d.caption('In the photo list, each analysed photo is marked <b>done</b>.');
  await d.ring('.stat-grid');
  await d.caption('On the right, D16, D50 and D84 for this photo: the sizes that 16, 50 and 84 percent of the bed is finer than.');
  await d.ring(page.locator('svg', { hasText: 'Cumulative PSD' }).first());
  await d.caption('Below them is the grain-size curve. These are still in <b>pixels</b>. The next step is to set the scale, so sizes are in millimetres.');
  await d.ring(null);
}
