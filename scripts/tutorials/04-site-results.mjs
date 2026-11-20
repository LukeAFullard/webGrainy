// Tutorial 4: name the site, then read its pooled results.
import { addPhotos, analyse, calibrate, PHOTO_A, PHOTO_B, setDate, setPlace } from './flows.mjs';

export const title = 'Read the site results';

export async function prepare(d) {
  await addPhotos(d);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await calibrate(d, PHOTO_B);
  await d.click('[data-tool="inspect"]');
  await d.page.evaluate(() => document.getElementById('sidebar-left').scrollTo(0, 0));
}

export async function run(d) {
  const { page } = d;
  await d.card('webGrainy tutorial 4', title, 'About 90 seconds · no sound');

  await d.caption('A <b>site</b> is one survey: photos from one place on one day. Give it a name you will recognise.', { hold: 0 });
  d.answerPrompt('Example beach, upper bar');
  await d.click('[data-action="rename-site"]', { after: 1500 });
  await d.caption('Set the <b>Place</b> and <b>Survey date</b> too. Repeat surveys use the same place name, so they can be compared later.', { hold: 0 });
  await setPlace(d, 'Example beach');
  await setDate(d, '2025-03-04');
  await d.wait(1500);

  await d.click('[data-scope="site"]', { after: 1200 });
  await d.ring('.stat-grid');
  await d.caption('<b>Whole site</b> pools the grains of every photo, weighted by the area each photo covers.');
  await d.ring(page.getByText(/95% CI/).first());
  await d.caption('The 95% confidence interval for D<sub>50</sub> comes from re-sampling whole photos. With only two photos it is not reliable: <b>aim for five or more</b>.');
  await d.ring(page.locator('svg', { hasText: 'Pooled Site Cumulative PSD' }).first());
  await d.caption('The grain-size curve: the percentage of the bed finer than each size, with D<sub>16</sub>, D<sub>50</sub> and D<sub>84</sub> marked.');
  await d.ring(null);

  await d.click('[data-tab="adequacy"]', { after: 1200 });
  await d.ring(page.locator('#dashboard-tabpanel .stat-grid').first());
  await d.caption('<b>Adequacy</b> checks whether you counted enough grains, and warns if one big stone dominates the result.');
  await d.ring(page.locator('#dashboard-tabpanel svg').first());
  await d.caption('This chart shows how D<sub>50</sub> settles as photos are added. If it is still moving, take more photos.');
  await d.ring(null);

  await d.click('[data-tab="psd"]', { after: 600 });
  await d.click('details.stats-settings > summary', { after: 900 });
  await d.ring('details.stats-settings');
  await d.caption('<b>Statistics settings</b> control how photos are pooled and which size is used. The defaults suit most surveys; the Methods document explains each option.');
  await d.ring(null);
  await d.click('details.stats-settings > summary', { after: 600 });

  await d.card('Next', 'Compare surveys over time', 'Track how a place changes between surveys.', 3500);
}
