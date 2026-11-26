// Compare sites side by side: table, curves, differences, printable comparison report, CSV.
import { addPhotos, analyse, calibrate, PHOTO_A, PHOTO_B, toggleDetails } from './flows.mjs';

export const chapter = 'Results';
export const title = 'Compare sites';
export const summary = 'Overlay the grain-size curves of several sites, and test whether they really differ.';

export async function prepare(d) {
  d.answerPrompt('Upper bar');
  await addPhotos(d, [PHOTO_A]);
  await d.click('[data-action="rename-site"]');
  await analyse(d);
  await calibrate(d, PHOTO_A);
  d.answerPrompt('Lower bar');
  await d.click('[data-action="new-site"]');
  await addPhotos(d, [PHOTO_B]);
  await analyse(d);
  await calibrate(d, PHOTO_B);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
}

export async function run(d) {
  const { page } = d;
  await d.caption('This project has two sites, an upper and a lower gravel bar, each with one photo. To compare them, choose <b>Compare sites</b>.', { hold: 0 });
  await d.click('[data-scope="compare"]', { after: 2500 });
  await d.ring('.compare-picker');
  await d.caption('Tick the sites to compare. Each gets its own colour throughout.');
  await d.ring(page.locator('#dashboard-right table').first());
  await d.caption('The table lists, for each site, the photos and grains, D16, D50 with its interval, D84, the geometric mean, sorting and more.');
  const banner = page.getByText(/Compared over the same size range/).first();
  if (await banner.count()) {
    await d.ring(banner);
    await d.caption('Every site uses the same statistics settings and the same size range, so the comparison is like for like.');
  }
  await d.ring('[data-chart-id="compare-psd"]');
  await d.caption('The grain-size curves of the sites, overlaid, with their confidence bands…');
  await d.ring('[data-chart-id="compare-size"]');
  await d.caption('…the size distributions, and further down the size-class composition, grain shape and fabric of each site.');
  await d.ring(null);

  await toggleDetails(d, 'Differences between sites', '#dashboard-right');
  await d.ring(page.locator('#dashboard-right details', { has: page.locator('> summary', { hasText: 'Differences between sites' }) }).first());
  await d.caption('<b>Differences between sites</b> gives, for each pair, the ratio of their D16, D50 and D84 with an interval and a p-value.');
  await d.caption('One photo cannot show how much a bed varies, so one-photo sites get no test. <b>Use five or more photos per site.</b>');
  await d.ring(null);

  await d.ring('[data-action="compare-report"]');
  await d.caption('<b>Printable comparison report</b> puts all of this on A4 pages, to print or save as a PDF.', { hold: 0 });
  const tab = await d.popup('[data-action="compare-report"]', { after: 500 });
  await tab.waitForTimeout(2500);
  await tab.setViewportSize({ width: 1000, height: 800 });
  const shot = await tab.screenshot({ fullPage: true, type: 'jpeg', quality: 80 });
  await tab.close();
  await d.ring(null);
  await d.image(shot, {
    hold: 9000,
    label: 'The printable comparison report (opens in a new tab)',
    say: 'It starts with the checks that matter for a fair comparison, then the table, the charts, the tests and the methods used.',
  });
  await d.ring('[data-action="export-comparison"]');
  await d.caption('<b>Download comparison CSV</b> saves the table and the test results for your own analysis.');
  await d.ring(null);
}
