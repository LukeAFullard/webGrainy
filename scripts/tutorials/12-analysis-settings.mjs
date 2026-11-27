// Analysis settings: scale mode, border grains, tidy, fine-tuning, advanced, help, re-analyse, reset.
import { addPhotos, analyse, calibrate, openDetails, PHOTO_A, setNumber } from './flows.mjs';

export const chapter = 'Analysis settings';
export const title = 'Analysis settings explained';
export const summary = 'What each setting does, when to change it, and how to try a change safely.';

export async function prepare(d) {
  await addPhotos(d, [PHOTO_A]);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
  await d.fit();
}

/** Runs "Re-analyse this photo" at playback speed 6. */
async function reanalyse(d) {
  d.speed(6);
  d.answerPrompt('');
  await d.click('[data-action="run-active"]', { after: 800 });
  await d.waitForBatch();
  d.speed(1);
}

export async function run(d) {
  const { page } = d;
  await openDetails(d, 'Analysis settings', '#sidebar-left');
  await d.ring(page.locator('#sidebar-left details.settings-block > summary'));
  await d.caption('<b>Analysis settings</b> control how grains are found. The note says <b>tested defaults</b>: the settings used in the accuracy tests. Change them only for a reason.');
  await d.caption('They apply the next time a photo is analysed; photos already analysed keep their results.');

  await d.ring('[data-param="scaleMode"]');
  await d.caption('<b>Scale mode</b> is the resolution the model works at. Auto shrinks large photos so their longest side is at most 1024 pixels. <b>1.0x Full</b> keeps small grains in big photos; <b>0.5x</b> or <b>0.25x</b> suit close-ups of large cobbles.');
  await d.ring(page.locator('[data-param="excludeBorder"]').locator('xpath=..'));
  await d.caption('<b>Exclude border grains</b> leaves out grains cut off by the photo edge, because they look smaller than they are. Keep it on.');
  await d.ring(page.locator('[data-param="tidyOutlines"]').locator('xpath=..'));
  await d.caption('<b>Tidy outlines after analysis</b> makes every grain one solid piece. Keep it on, unless you want the model\'s raw outlines.');

  await openDetails(d, 'Fine-tuning', '#sidebar-left');
  await d.ring('[data-param="flowThreshold"]');
  await d.caption('<b>Flow threshold</b>: raise it, to about 0.6, if obvious grains are missing; lower it, to about 0.3, if you see ragged outlines.');
  await d.ring('[data-param="cellprobThreshold"]');
  await d.caption('<b>Cellprob threshold</b>: lower it, to about minus 1, if outlines are too small or dark stones are missed; raise it if outlines spill into sand or shadow.');
  await d.ring('[data-param="minSize"]');
  await d.caption('<b>Min size</b> is the smallest object kept, as an area in pixels. Lower it for sharp close-ups; raise it if noise creates tiny false grains.');
  await d.ring('[data-param="maxGrainAreaFraction"]');
  await d.caption('<b>Max area fraction</b> stops sand or water becoming one giant grain: no grain may cover more than 40 percent of the photo. Raise it to 1 if one boulder really fills the frame.');
  await d.ring('[data-param="excludeBorderMargin"]');
  await d.caption('<b>Border margin</b> sets how close to the edge counts as touching it. Increase it if the photo edges are blurred.');

  await openDetails(d, 'Advanced (rarely needed)', '#sidebar-left');
  await d.ring(page.locator('#sidebar-left details.advanced-block', { has: page.locator('> summary', { hasText: 'Advanced' }) }));
  await d.caption('<b>Advanced</b> holds rarely needed options: flow steps and seed density, how many processor threads to use, a notification when a long analysis ends, skipping areas outside the ROI, and a contrast boost best left off.');
  await d.ring(null);

  await d.caption('Unsure about a setting? Every one has a <b>?</b> button.', { hold: 0 });
  await d.click(page.locator('[data-param="cellprobThreshold"]').locator('xpath=..').locator('[data-help]'), { after: 1500 });
  await d.ring('#app-dialog .modal-card');
  await d.caption('It explains what the setting does, its default, and when to change it.');
  await d.ring(null);
  await d.click('#app-dialog [data-action="close-modal"]', { after: 700 });

  await d.caption('To try a change, edit the setting, then press <b>Re-analyse this photo</b>. Here, Cellprob threshold to minus 1.', { hold: 0 });
  await setNumber(d, '[data-param="cellprobThreshold"]', -1);
  await d.ring(page.locator('#sidebar-left details.settings-block > summary'));
  await d.wait(2000);
  await d.ring('[data-action="run-active"]');
  await d.wait(1200);
  await d.ring(null);
  await reanalyse(d);
  await d.ring('.stat-grid');
  await d.caption('Compare the outlines and the numbers. Keep a change only if the outlines are clearly better, and use the same settings for photos you compare.');
  await d.ring('[data-action="reset-analysis-params"]');
  await d.caption('<b>Reset analysis settings to defaults</b> returns to the tested values. Then re-analyse the photo. This part is sped up.', { hold: 0 });
  await d.click('[data-action="reset-analysis-params"]', { after: 1200 });
  await d.ring(null);
  await reanalyse(d);
  await d.caption('Settings are remembered in this browser, and every export records the settings used for each photo.');
}
