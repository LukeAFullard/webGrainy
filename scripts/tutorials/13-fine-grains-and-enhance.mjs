// Re-analyse enlarged for fine grains; the experimental Deblur and 2× Upscale.
import { addPhotos, analyse, calibrate, PHOTO_B } from './flows.mjs';

export const chapter = 'Analysis settings';
export const title = 'Fine grains and image enhancement';
export const summary = 'Get more out of photos of fine gravel, and when to use the experimental enhancement tools.';

export async function prepare(d) {
  await addPhotos(d, [PHOTO_B]);
  await analyse(d);
  await calibrate(d, PHOTO_B);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
  await d.fit();
}

export async function run(d) {
  const { page } = d;
  const box = page.locator('#dashboard-right [data-action="fine-grain-rerun"]').locator('xpath=..').locator('xpath=..');
  await d.ring(box);
  await d.caption('In this photo, U-Net found mostly small grains: the median is about 19 pixels across. So webGrainy offers <b>Re-analyse enlarged ×1.5</b>.');
  await d.caption('The photo is enlarged only while the model looks at it, so small grains become big enough to find. Your photo itself is not changed.');
  await d.caption('Press it. This part is sped up.', { hold: 0 });
  d.speed(6);
  await d.click('[data-action="fine-grain-rerun"]', { after: 800 });
  await d.waitForBatch();
  d.speed(1);
  await d.wait(800);
  await d.ring('.stat-grid');
  await d.caption('Sizes are still in the original photo\'s pixels and millimetres. In testing on 40 photos, this improved outlines of fine gravel without making any site worse.');
  const undo = page.locator('[data-action="fine-grain-undo"]');
  if (await undo.count()) {
    await d.ring(undo);
    await d.caption('<b>Undo</b> returns to the normal analysis. The choice is saved with the photo and recorded in exports.');
  }
  await d.ring(null);
  await d.caption('Cellpose-SAM does not need this: it already handles fine grains. For big photos with many small grains, <b>Scale mode 1.0x Full</b> also helps, at the cost of time and memory.');

  await d.ring(page.locator('#toolbar [role="group"][aria-label="Optional image enhancement"]'));
  await d.caption('The <b>Enhance</b> tools are experimental: they were not part of the accuracy tests, so check the outlines against the original photo.');
  await d.ring(null);
  await d.caption('<b>Deblur</b> sharpens a slightly blurred photo, instantly. It replaces the photo, which then needs analysing again.', { hold: 0 });
  d.answerPrompt('');
  await d.click('[data-action="enhance-deblur"]', { after: 2500 });
  const revert = page.locator('#toolbar [data-action="enhance-revert"]');
  if (await revert.count()) {
    await d.ring(revert);
    await d.caption('<b>Revert</b> restores the original photo with one click. Either way, analyse the photo again afterwards.', { hold: 0 });
    await d.wait(1500);
    d.answerPrompt('');
    await d.click(revert, { after: 2000 });
    await d.ring(null);
  }
  await d.ring('[data-action="enhance-upscale"]');
  await d.caption('<b>2× Upscale</b> uses a small AI model to double the resolution. With Auto scale most photos are shrunk again before analysis, so the app refuses when it would not help.');
  await d.ring(null);
  await d.caption('Both are recorded in every export. For reported results, a sharper photo taken closer is always better than enhancing.');
}
