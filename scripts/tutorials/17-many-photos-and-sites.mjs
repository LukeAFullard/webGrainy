// Working with many photos and sites: filters, include, select mode, delete, new site, switching, analyse all.
import { photo } from './lib.mjs';
import { addPhotos, analyse, calibrate, PHOTO_A, PHOTO_B } from './flows.mjs';

export const chapter = 'Results';
export const title = 'Working with many photos and sites';
export const summary = 'Filter, include, re-analyse or delete photos in bulk, and keep each survey in its own site.';

export async function prepare(d) {
  await addPhotos(d);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
}

export async function run(d) {
  const { page } = d;
  await d.ring('.photo-summary');
  await d.caption('With many photos, this line counts them by state: analysed, not calibrated, failed. Click a part to show only those photos.', { hold: 0 });
  await d.wait(3500);
  await d.click(page.locator('.photo-summary [data-action="photo-filter"]', { hasText: 'not calibrated' }).first(), { after: 1500 });
  await d.ring('#sidebar-left .photo-item');
  await d.caption('Here, only the photo that still needs a scale. Calibrate it, and it leaves the list.');
  await calibrate(d, PHOTO_B);
  await d.click('[data-tool="inspect"]', { after: 300 });
  await d.ring(null);
  const all = page.locator('[data-action="photo-filter"][data-filter="all"]');
  if (await all.count()) await d.click(all.first(), { after: 1000 });

  await d.click('[data-scope="site"]', { after: 1000 });
  await d.ring(page.locator('[data-toggle-include]').first());
  await d.caption('The tick box next to each photo includes it in the site results. Untick it to leave a photo out without deleting it…', { hold: 0 });
  await d.wait(2500);
  await d.click(page.locator('[data-toggle-include]').first(), { after: 1500 });
  await d.ring(page.locator('#dashboard-right .basis-banner').first());
  await d.caption('…and the site results now come from the other photo only.');
  await d.click(page.locator('[data-toggle-include]').first(), { after: 1200 });
  await d.ring(null);

  await d.caption('<b>Select</b> turns on check boxes for bulk actions.', { hold: 0 });
  await d.click('[data-action="photo-select-mode"]', { after: 1000 });
  await d.click('[data-action="photo-select-all"]', { after: 1000 });
  await d.ring('#sidebar-left .bulk-bar');
  await d.caption('Include or leave out, re-analyse, tidy outlines, or delete all the selected photos at once. Deleting asks first.');
  await d.ring(null);
  await d.click('[data-action="photo-select-mode"]', { after: 1000 });
  await d.ring(page.locator('.photo-remove-btn').first());
  await d.caption('The cross removes a single photo from the site.');
  await d.ring(null);

  await d.scrollPanel('sidebar-left', 0);
  await d.ring('#site-select');
  await d.caption('Each survey is one <b>site</b>, with its own photos and results. Make a new one with <b>+ New</b>.', { hold: 0 });
  await d.wait(2000);
  d.answerPrompt('Example beach, lower bar');
  await d.click('[data-action="new-site"]', { after: 1800 });
  await d.caption('The new site is empty, ready for its photos. Switch between sites with this list.', { hold: 0 });
  await d.chooseFiles('#photo-dropzone', [await photo(PHOTO_A)], { after: 1500 });
  await d.wait(1500);
  const other = await page.locator('#site-select option:not(:checked)').first().getAttribute('value');
  await d.select('#site-select', other, { after: 1500 });
  await d.ring('[data-action="analyse-all-sites"]');
  await d.caption('With several sites, <b>Analyse all sites</b> analyses every photo that is not yet analysed, in all of them.');
  await d.ring('[data-action="rename-site"]');
  await d.caption('<b>Rename</b> changes the open site\'s name. Next: comparing sites.');
  await d.ring(null);
}
