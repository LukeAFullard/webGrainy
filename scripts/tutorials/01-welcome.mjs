// What webGrainy is, the overview page, and a tour of the workspace.
export const chapter = 'Getting started';
export const title = 'Welcome to webGrainy';
export const summary = 'What the app does, where your data stays, and a tour of the workspace.';

const smooth = (page, sel, block = 'start') =>
  page.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ behavior: 'smooth', block: b }), [sel, block]);

/** @param {Awaited<ReturnType<import('./lib.mjs').startTutorial>>} d */
export async function run(d) {
  const { page } = d;

  await d.caption('webGrainy measures the sizes of gravel and other coarse sediment from photos, right in your web browser.');
  await d.ring('.landing-hero-figure');
  await d.caption('It finds and outlines every grain with the ImageGrains 2.0 neural networks, measures each one, and turns them into a grain-size distribution: D16, D50, D84 and more.');
  await d.ring(null);

  await smooth(page, '.landing-pillars', 'center');
  await d.wait(900);
  await d.ring('.landing-pillars');
  await d.caption('Everything runs on your own computer or phone. Your photos and results are <b>never uploaded</b>, and after the first model download it works offline, even in the field.');
  await d.ring(null);

  await smooth(page, '#workflow');
  await d.wait(1000);
  await d.caption('<b>How it works</b> sums up the five steps. Click a step to read about it.', { hold: 0 });
  const steps = page.locator('[data-action="workflow-step"]');
  const n = await steps.count();
  for (let i = 1; i < Math.min(n, 5); i++) await d.click(steps.nth(i), { after: 1300 });
  await d.caption('Add and calibrate photos, leave out what isn\'t gravel, find the grains, check the outlines, then read and export the results. This series has a video on each.');

  await smooth(page, '#landing-main');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await d.wait(1000);
  await d.ring('.landing-header-actions');
  await d.caption('The top bar shows whether your graphics card or your processor will run the model, and that the app is ready to work offline.');
  await d.ring('.landing-pref-row');
  await d.caption('Tick <b>Skip this overview next time</b> to go straight to the workspace. The <b>Overview</b> button brings this page back.');
  await d.ring(null);

  await d.caption('Click <b>Launch Workspace</b>.', { hold: 0 });
  await d.click('.landing-header-actions [data-action="enter-workspace"]', { after: 1500 });

  await d.ring('#sidebar-left');
  await d.caption('On the left: the getting-started steps, your <b>site</b> and its photos, and the analysis settings.');
  await d.ring('#toolbar');
  await d.caption('Above the photo: tools to set the scale, mark areas to leave out and, after an analysis, edit grains.');
  await d.ring('#canvas-stage');
  await d.caption('In the middle: the photo, with every grain outlined once it is analysed.');
  await d.ring('#dashboard-right');
  await d.caption('On the right: the results, for this photo, for the whole site, or for several sites compared.');
  await d.ring('#topbar .topbar-right');
  await d.caption('Top right: <b>Overview</b>, <b>Models</b> for offline downloads, <b>Export</b>, <b>Help</b> and <b>About</b>.');
  await d.ring(null);
}
