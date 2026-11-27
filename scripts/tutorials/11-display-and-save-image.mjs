// Display options (IDs, size colours, ellipses, orientation, markers, opacity, magnifier) and Save image.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { addPhotos, analyse, calibrate, PHOTO_A } from './flows.mjs';

export const chapter = 'Areas and outlines';
export const title = 'Display options and saving an image';
export const summary = 'Choose what is drawn over the photo, and save it as a full-resolution picture.';

export async function prepare(d) {
  await addPhotos(d, [PHOTO_A]);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
}


export async function run(d) {
  const { page } = d;
  const P = PHOTO_A;
  await d.caption('The <b>Display</b> menu, above the photo, changes only what you see. It never changes the results.', { hold: 0 });
  await d.click('details.display-menu > summary', { after: 1000 });
  d.resetView();
  await d.fit({ after: 600 });
  await d.ring('details.display-menu');
  await d.wait(2500);
  await d.ring(null);

  await d.zoomAt(P, 690, 520, -5, { ms: 900 });
  await d.ring('[data-ov="instanceIds"]', 3);
  await d.caption('<b>Grain IDs</b> fills each grain with its own colour, so neighbouring grains are easy to tell apart. Untick it to see the bare photo…', { hold: 0 });
  await d.wait(2500);
  await d.click('[data-ov="instanceIds"]', { after: 2500 });
  await d.caption('…and tick it again.', { hold: 0 });
  await d.click('[data-ov="instanceIds"]', { after: 1200 });

  await d.ring('[data-ov="wentworthColors"]', 3);
  await d.caption('<b>Size colours</b> fill each grain with the colour of its size class: fine gravel, coarse gravel, cobble or boulder. It needs a scale.', { hold: 0 });
  await d.click('[data-ov="wentworthColors"]', { after: 3500 });

  await d.ring('[data-ov="ellipses"]', 3);
  await d.caption('<b>Ellipses</b> draws the ellipse fitted to each grain, with its long a-axis and short b-axis. The b-axis is the size used.', { hold: 0 });
  await d.click('[data-ov="ellipses"]', { after: 4000 });
  await d.click('[data-ov="wentworthColors"]', { after: 300 });

  await d.ring('[data-ov="orientations"]', 3);
  await d.caption('<b>Orientation lines</b> show each grain\'s long-axis direction, which the Fabric results summarise.', { hold: 0 });
  await d.click('[data-ov="ellipses"]', { after: 300 });
  await d.click('[data-ov="orientations"]', { after: 3500 });
  await d.click('[data-ov="orientations"]', { after: 300 });

  await d.ring('[data-ov="borderTruncated"]', 3);
  await d.caption('<b>Mark edge and too-small grains</b>: red dots for grains touching the photo edge, orange for grains below the size cutoff. Both are left out of the statistics.');

  await d.ring('[data-ov="opacity"]', 3);
  await d.caption('<b>Outline opacity</b> fades the outlines, to see the stones underneath.', { hold: 0 });
  const slider = page.locator('[data-ov="opacity"]');
  for (const v of [0.4, 0.15, 0.6, 0.9]) {
    await slider.evaluate((el, x) => {
      el.value = String(x);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
    await d.wait(900);
  }

  await d.ring('[data-ov="loupe"]', 3);
  await d.caption('The <b>Magnifier</b> follows the cursor, for precise clicks when editing or calibrating.', { hold: 0 });
  await d.click('[data-ov="loupe"]', { after: 600 });
  await d.ring(null);
  const r = await page.locator('#canvas-stage').boundingBox();
  await d.moveTo(r.x + r.width * 0.35, r.y + r.height * 0.5, 900);
  await d.moveTo(r.x + r.width * 0.6, r.y + r.height * 0.6, 2000);
  await d.click('[data-ov="loupe"]', { after: 300 });
  await d.click('details.display-menu > summary', { after: 800 });
  d.resetView();
  await d.fit({ after: 600 });

  await d.ring('details.save-view-menu > summary');
  await d.caption('<b>Save image</b> downloads the photo with everything shown on it, as a PNG: the whole photo at full resolution, or only the part in view.', { hold: 0 });
  await d.click('details.save-view-menu > summary', { after: 900 });
  const png = await d.download('[data-action="save-view"][data-area="photo"]', { after: 1200 });
  await d.ring(null);
  await d.click('details.save-view-menu > summary', { after: 500 }).catch(() => {});
  const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', png], { encoding: 'utf8' }).trim();
  await d.image(readFileSync(png), {
    type: 'png', scroll: false, hold: 4500,
    label: `The saved image: <b>${size} pixels</b>, one pixel per photo pixel, with the outlines as shown.`,
    say: 'The saved image has one pixel for every pixel of the photo, with the outlines as shown. It is ready for a report or a slide.',
  });
}
