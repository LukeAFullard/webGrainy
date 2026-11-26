// Save a project as a .webgrainy file and open it again.
import { addPhotos, analyse, calibrate, closeModal, openModal, PHOTO_A, PHOTO_B } from './flows.mjs';

export const chapter = 'Keeping and sharing results';
export const title = 'Save and reopen a project';
export const summary = 'A .webgrainy file holds a whole site, photos included, to continue later or on another computer.';

export async function prepare(d) {
  d.answerPrompt('Example beach, upper bar');
  await addPhotos(d);
  await d.click('[data-action="rename-site"]');
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await calibrate(d, PHOTO_B);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
  await d.page.evaluate(() => document.getElementById('sidebar-left').scrollTo(0, 0));
}

export async function run(d) {
  const { page } = d;
  await d.caption('Result files cannot be reopened in webGrainy. To continue working on a site later, or on another computer, save it as a <b>project file</b>.');
  await openModal(d, 'export');
  await d.ring('[data-export="site-archive"]');
  await d.caption('In Export, <b>Export .webgrainy Archive</b> saves the whole site: photos, scales, areas, edited outlines and settings.', { hold: 0 });
  await d.wait(2500);
  const file = await d.download('[data-export="site-archive"]', { after: 1500 });
  await d.ring(null);
  await closeModal(d);
  await d.card('Saved', file.split('/').pop(), 'The photos are inside, so the file can be large.\nPhotos can carry GPS locations: take care when sharing it.', 5000);
  await d.caption('<b>Download results</b> can include the same project file, if you tick <b>Include the project file</b>.');

  await d.ring('#sidebar-left [data-action="import-archive"]');
  await d.caption('To reopen it, press <b>Open</b> in the Site panel and choose the file. Here we open the file we just saved.', { hold: 0 });
  await d.wait(2500);
  await d.chooseFiles('#sidebar-left [data-action="import-archive"]', [file], { after: 2500 });
  await page.waitForFunction(() => /Imported project archive/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  await d.wait(1500);
  await d.ring('#site-select');
  await d.caption('The site is back, with its photos and results, as a site of its own. Nothing was uploaded: the file went straight into this browser.');
  await d.ring('#sidebar-left .photo-item');
  await d.caption('Analysed photos keep their outlines, edits and scale, so there is no need to analyse again.');
  await d.ring(null);
  await d.caption('You can also drop a .webgrainy file anywhere on the overview page, or use <b>Open .webgrainy Project</b> there.');
}
