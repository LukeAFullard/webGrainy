// Results for one photo: D-values, the PSD chart, phi axis, histogram, Folk & Ward, more statistics, shape, fabric.
import { addPhotos, analyse, calibrate, PHOTO_A, toggleDetails } from './flows.mjs';

export const chapter = 'Results';
export const title = 'Read the results for one photo';
export const summary = 'The grain-size curve, percentiles, sorting, shape and fabric of a single photo.';

export async function prepare(d) {
  await addPhotos(d, [PHOTO_A]);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
  await d.fit();
}

export async function run(d) {
  const { page } = d;
  const R = '#dashboard-right';
  await d.ring(`${R} [data-scope="photo"]`);
  await d.caption('<b>This photo</b> shows the results of the photo on screen.');
  await d.ring(page.locator(`${R} .basis-banner`).first());
  await d.caption('The top line says how grains are weighted, and how many were counted: n. It also says how many were left out as too small, or cut off by the photo edge.');
  await d.ring(`${R} .stat-grid`);
  await d.caption('D16, D50 and D84: 16, 50 and 84 percent of the bed, by area, is finer than these sizes. D50 is the median grain size.');
  await d.ring(`${R} .metric-note`);
  await d.caption('The size is the b-axis of each grain\'s outline as seen from above. It is close to, but not the same as, a sieve or caliper size.');

  await d.ring(page.locator(`${R} svg`, { hasText: 'Cumulative PSD' }).first());
  await d.caption('The <b>grain-size curve</b> shows the percentage of the bed finer than each size, with D16, D50 and D84 marked.');
  await d.ring(`${R} [data-psd-x="phi"]`);
  await d.caption('Switch the axis to <b>phi</b> units, as used in sedimentology…', { hold: 0 });
  await d.click(`${R} [data-psd-x="phi"]`, { after: 2200 });
  await d.caption('…or back to millimetres.', { hold: 0 });
  await d.click(`${R} [data-psd-x="mm"]`, { after: 1500 });
  await d.ring(page.locator(`${R} button`, { hasText: /^SVG$/ }).first());
  await d.caption('Every chart has <b>SVG</b> and <b>PNG</b> buttons, to save it for a report.');

  await d.ring(page.getByText('Smallest grain kept').first().locator('xpath=..'));
  await d.caption('Below the curve: the smallest grain kept, the detection limit. Grains up to a few times this size are partly missed, so treat D16 and finer with care.');
  const wide = page.locator(`${R} button`, { hasText: 'Wide classes' }).first();
  await d.ring(page.locator(`${R} svg`, { hasText: 'Size Distribution' }).first());
  await d.caption('The size distribution histogram shows the share of the bed in each size class. Choose narrow or wide classes.', { hold: 0 });
  await d.click(wide, { after: 2000 });
  await d.click(page.locator(`${R} button`, { hasText: 'Narrow classes' }).first(), { after: 1200 });

  await d.ring(page.locator(`${R} .stat-card`, { hasText: 'Folk' }).first().locator('xpath=..'));
  await d.caption('<b>Folk and Ward</b> statistics: the mean, sorting, skewness and kurtosis, with plain-language labels such as moderately sorted.');
  await toggleDetails(d, 'More statistics', R);
  await d.ring(page.locator(`${R} details`, { has: page.locator('> summary', { hasText: 'More statistics' }) }).first());
  await d.caption('<b>More statistics</b> adds the Sauter and geometric means, D30, D60 and D65, uniformity, Trask sorting, the Fredle index and more.');
  await d.ring(null);

  await d.click('[data-tab="shape"]', { after: 1200 });
  await d.ring('#dashboard-tabpanel');
  await d.caption('<b>Shape</b>: the distribution of aspect ratios, b divided by a. Round grains are near 1, flat or elongated ones lower.');
  await d.click('[data-tab="fabric"]', { after: 1200 });
  await d.ring('#dashboard-tabpanel');
  await d.caption('<b>Fabric</b>: the directions of the grains\' long axes as a rose diagram, with the mean direction and how strongly they are aligned, for example by the river\'s flow.');
  await d.ring(null);
  await d.click('[data-tab="psd"]', { after: 800 });
  await d.caption('The <b>Adequacy</b> tab, and the results for a whole site, are in the next video.');
}
