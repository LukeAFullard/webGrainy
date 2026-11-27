// A second survey of the same place, then compare the two over time.
// The two sample photos stand in for two surveys (each survey should really have 5+ photos).
import { photo } from './lib.mjs';
import { addPhotos, analyse, calibrate, PHOTO_A, PHOTO_B, setDate, setPlace } from './flows.mjs';

export const chapter = 'Results';
export const title = 'Compare surveys over time';
export const summary = 'Follow one place through repeat surveys, and see whether the bed coarsens or fines.';

export async function prepare(d) {
  d.answerPrompt('Example beach – March 2025');
  await addPhotos(d, [PHOTO_A]);
  await d.click('[data-action="rename-site"]');
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await d.click('[data-tool="inspect"]');
  await setPlace(d, 'Example beach');
  await setDate(d, '2025-03-04');
  await d.page.evaluate(() => document.getElementById('sidebar-left').scrollTo(0, 0));
}

export async function run(d) {
  const { page } = d;
  await d.ring(page.locator('.site-place').first());
  await d.caption('This survey of <b>Example beach</b> was done in March. Now add the September survey of the same place.');
  await d.ring(null);

  await d.caption('<b>+ New survey of this place</b> starts an empty site with the same place and statistics settings.', { hold: 0 });
  d.answerPrompt('Example beach – September 2025');
  await d.click('[data-action="new-survey"]', { after: 1800 });

  await d.caption('Add the new photos, set the survey date, then analyse and set the scale as before.', { hold: 0 });
  await d.chooseFiles('#photo-dropzone', [await photo(PHOTO_B)], { after: 1200 });
  await page.waitForSelector('.photo-item');
  await setDate(d, '2025-09-10');
  await d.caption('Analysing and setting the scale. This part is sped up.', { hold: 0 });
  d.speed(4);
  await analyse(d);
  await calibrate(d, PHOTO_B);
  await d.click('[data-tool="inspect"]');
  d.speed(1);
  await d.caption(null);
  await d.wait(800);

  await d.caption('With two surveys of one place, compare them over time.', { hold: 0 });
  await d.click('[data-action="compare-place"]', { after: 2000 });
  await d.ring(page.locator('table', { hasText: 'Survey date' }).first());
  await d.caption('Each survey gets a row, in date order: D16, D50 with its 95 percent interval, D84, sorting and more.');
  await d.ring(page.getByText(/Compared over the same size range/).first());
  await d.caption('Surveys are compared over the same size range, so a blurrier photo cannot shift the result.');
  await d.ring(page.locator('svg', { hasText: 'Grain size over time' }).first());
  await d.caption('<b>Grain size over time</b> plots D16, D50 and D84 for each survey, so coarsening or fining shows at a glance.');
  await d.ring(page.getByText('How far the tests can be trusted').locator('xpath=..'));
  await d.caption('webGrainy tests whether the differences are real. Each survey here has only one photo, so it says no test is possible: <b>use five or more photos per survey</b>.');
  await d.ring(null);

  await d.ring('button:has-text("Download comparison CSV")');
  await d.caption('<b>Download comparison CSV</b> saves the table and test results for your report.');
  await d.ring(null);
  await d.caption('The <b>Printable comparison report</b> then adds the change between consecutive surveys, with its interval and p-value.');
}
