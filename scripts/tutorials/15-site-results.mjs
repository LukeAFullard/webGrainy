// Name the site, then read its pooled results: confidence interval and sample adequacy.
import { addPhotos, analyse, calibrate, nameSite, PHOTO_A, PHOTO_B, setDate, setPlace } from './flows.mjs';

export const chapter = 'Results';
export const title = 'Whole-site results';
export const summary = 'Pool several photos into one result for a site, with its uncertainty and a check that you counted enough.';

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
  await d.caption('A <b>site</b> is one survey: the photos from one place on one day. Give it a name you will recognise.', { hold: 0 });
  await nameSite(d, 'Example beach, upper bar');
  await d.wait(1000);
  await d.caption('Set the <b>Place</b> and the <b>Survey date</b> too. Repeat surveys of a place use the same place name, so they can be compared later.', { hold: 0 });
  await setPlace(d, 'Example beach');
  await setDate(d, '2025-03-04');
  await d.wait(1500);

  await d.click('[data-scope="site"]', { after: 1200 });
  await d.ring('.stat-grid');
  await d.caption('<b>Whole site</b> pools the grains of every included photo, weighted by the area each photo covers.');
  await d.ring(page.getByText(/95% CI/).first());
  await d.caption('The 95 percent confidence interval for D50 comes from re-sampling whole photos, because grains in one photo are not independent.');
  await d.ring(page.locator('#dashboard-right .warning-banner').first());
  await d.caption('With only two photos the interval is approximate and wide, and the app says so. <b>Aim for five or more photos per site.</b>');
  await d.ring(page.locator('svg', { hasText: 'Pooled Site Cumulative PSD' }).first());
  await d.caption('The site\'s grain-size curve, with its confidence band and a thin line for each photo.');
  await d.ring(null);

  await d.click('[data-tab="adequacy"]', { after: 1200 });
  await d.ring(page.locator('#dashboard-tabpanel .stat-grid').first());
  await d.caption('<b>Adequacy</b> checks whether you counted enough grains, and warns if one big stone dominates the result.');
  await d.ring(page.locator('#dashboard-tabpanel svg').first());
  await d.caption('This chart shows how D50 settles as photos are added. If it is still moving at the end, take more photos.');
  const svgs = page.locator('#dashboard-tabpanel svg');
  if ((await svgs.count()) > 1) {
    await d.ring(svgs.nth(1));
    await d.caption('And each photo\'s influence: how much D50 changes when that photo is left out. A photo with a large influence is worth a second look.');
  }
  await d.ring(null);
  await d.click('[data-tab="psd"]', { after: 600 });
  await d.caption('How photos are pooled, and which size is used, is set in <b>Statistics settings</b>: the next video.');
}
