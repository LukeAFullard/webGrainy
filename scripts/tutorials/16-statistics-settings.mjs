// Statistics settings: pooling, size metric, cutoffs, harmonize, uncertainty and sampling.
import { addPhotos, analyse, calibrate, openDetails, PHOTO_A, PHOTO_B, setNumber } from './flows.mjs';

export const chapter = 'Results';
export const title = 'Statistics settings';
export const summary = 'Pooling, size metric and cutoffs: how grains become a grain-size distribution, and when to change them.';

export async function prepare(d) {
  await addPhotos(d);
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await calibrate(d, PHOTO_B);
  await d.click('[data-tool="inspect"]');
  await d.click('[data-scope="site"]');
}

export async function run(d) {
  const { page } = d;
  await openDetails(d, 'Statistics settings', '#dashboard-right');
  await d.ring('details.stats-settings');
  await d.caption('<b>Statistics settings</b> decide how the measured grains become a grain-size distribution. They apply instantly, without analysing again.');

  await d.ring('[data-site-opt="poolingMode"]');
  await d.caption('<b>Pooling mode</b> combines the photos of a site. The default, <b>physical area-weighted</b>, counts each grain by its visible area: the photo equivalent of a grid pebble count.');
  await d.caption('<b>Equal-photo</b> gives every photo the same weight. <b>Virtual Wolman grid</b> imitates a pebble count with a grid of points. <b>Number-weighted</b> counts every grain once: much finer, and not comparable with pebble counts.');
  await d.caption('<b>Facies-weighted</b> is for stratified sampling…', { hold: 0 });
  await d.select('[data-site-opt="poolingMode"]', 'facies-weighted', { after: 1200 });
  await d.ring(page.locator('[data-photo-facies]').first().locator('xpath=..'));
  await d.caption('…each photo gets a weight, such as its surface type\'s share of the reach, and shows its resulting share of the site.');
  await d.select('[data-site-opt="poolingMode"]', 'physical-area', { after: 1000 });

  await d.ring('[data-site-opt="sizeMetric"]');
  await d.caption('<b>Size metric</b>: the b-axis by default, as in most photo-sieving work. <b>Min-Feret</b> is the narrowest caliper width, closest to a hand-measured b-axis. <b>d_eq</b> is the equal-area diameter.', { hold: 0 });
  await d.wait(4000);
  await d.select('[data-site-opt="sizeMetric"]', 'minFeret', { after: 800 });
  await d.ring('.stat-grid');
  await d.caption('The numbers change with the metric, so always report which one you used.');
  await d.select('[data-site-opt="sizeMetric"]', 'bAxis', { after: 800 });

  await d.ring('[data-site-opt="minSizeMm"]');
  await d.caption('<b>Field-count cutoff</b> leaves out grains smaller than this size. When comparing with a pebble count, set it to the smallest stone the count records, for example 16 millimetres.', { hold: 0 });
  await setNumber(d, '[data-site-opt="minSizeMm"]', 16);
  await d.ring('.stat-grid');
  await d.caption('Without small grains, D50 is coarser. At one test site, a matching cutoff brought the photo D50 within 3 percent of the field count.');
  await setNumber(d, '[data-site-opt="minSizeMm"]', 0);

  await d.ring('[data-site-opt="minBaxisPx"]');
  await d.caption('<b>Min b-axis</b>, in pixels: smaller grains are too small to measure reliably and are left out. The default is 15.');
  await d.ring('[data-site-opt="maxExcludedFraction"]');
  await d.caption('<b>Exclusion overlap</b>: how much of a grain may lie inside an excluded area before the grain is dropped. The default is one tenth.');
  await d.ring(page.locator('[data-site-opt="harmonizePhysicalCutoff"]').locator('xpath=..'));
  await d.caption('<b>Harmonize cutoff</b> applies the largest detection limit of all the photos to every photo, so they all describe the same size range. Keep it on.');

  await openDetails(d, 'Uncertainty', '#dashboard-right');
  await d.ring(page.locator('#dashboard-right details', { has: page.locator('> summary', { hasText: 'Uncertainty' }) }).first());
  await d.caption('<b>Uncertainty and sampling</b>: the confidence level, the number of bootstrap repeats and their seed, a two-stage bootstrap for few photos, and the points per photo for the virtual Wolman grid.');
  await d.caption('For final results, use 1000 to 2000 bootstrap repeats. The defaults suit most surveys, and every export records these settings.');
  await d.ring(null);
}
