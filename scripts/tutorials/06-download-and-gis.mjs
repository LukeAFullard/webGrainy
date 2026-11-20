// Tutorial 6: download the results, and export outlines in map coordinates from a GeoTIFF.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
import { makeGeoTiff } from './geotiff.mjs';
import { addPhotos, analyse, PHOTO_A } from './flows.mjs';

export const title = 'Download your results';
const GEO_NAME = 'K1_C3_0449_example_geo.tif';

export async function prepare(d) {
  // An example GeoTIFF of the sample photo, at an invented spot in NZTM2000 (EPSG:2193).
  const tif = await makeGeoTiff(PHOTO_A, {
    out: join(ROOT, '.cache', 'tutorial-photos', GEO_NAME), metresPerPx: 0.001534, x0: 1570123.4, y0: 5180456.7,
  });
  d.answerPrompt('Example beach – March 2025');
  await addPhotos(d, [], [tif]);
  await d.click('[data-action="rename-site"]');
  await analyse(d);
  await d.page.evaluate(() => document.getElementById('sidebar-left').scrollTo(0, 0));
}

export async function run(d) {
  const { page } = d;
  await d.card('webGrainy tutorial 6', title, 'About 90 seconds · no sound');

  await d.ring('[data-scale-readout]');
  await d.caption('This photo is a <b>GeoTIFF</b> (an example, at a made-up location). Its scale was read from the georeferencing, so no ruler was needed.');
  await d.ring(null);

  await d.ring('[data-action="open-download-results"]');
  await d.caption('Photos are only kept in this browser for a while. To keep your work, use <b>Download results…</b>', { hold: 0 });
  await d.wait(2500);
  await d.ring(null);
  await d.click('[data-action="open-download-results"]', { after: 1200 });
  await d.ring('.modal-card');
  await d.caption('One .zip holds the site summary, every grain, the grain-size curve, the outlines and a methods note.');
  await d.ring(page.locator('#download-include-project').locator('xpath=..'));
  await d.caption('Tick this to add the project file (with your photos) so you can reopen the site later. It can be large.');
  await d.ring(null);
  const zip = await d.download('[data-action="download-results"]', { after: 1500 });
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  const shown = names.length > 12 ? [...names.slice(0, 11), `… and ${names.length - 11} more`] : names;
  await d.card('Inside the zip', zip.split('/').pop(), shown.join('\n'), 6000, { mono: true });

  await d.ring(page.getByText(/Results downloaded/).first().locator('xpath=..'));
  await d.caption('The site panel remembers when you last downloaded, and warns before anything is removed.');
  await d.ring(null);

  await d.caption('For GIS, open <b>Export</b>.', { hold: 0 });
  await d.click(page.locator('#topbar button', { hasText: 'Export' }), { after: 1200 });
  await d.ring(page.locator('[data-export="photo-geojson-map"]').locator('xpath=../..'));
  await d.caption('For a GeoTIFF, <b>GeoJSON (map coordinates)</b> gives every grain outline in the photo\'s own coordinate system, ready for QGIS or ArcGIS.');
  const warn = page.getByText('Outlines are coarser than the photo.').locator('xpath=..');
  if (await warn.count()) {
    await d.ring(warn);
    await d.caption('Check this note: outlines are traced on a smaller working copy, so their edges step by a few mm. Re-analyse at full scale for finer outlines.');
  }
  await d.ring(null);
  const geojson = JSON.parse(readFileSync(await d.download('[data-export="photo-geojson-map"]', { after: 800 }), 'utf8'));
  const f = geojson.features[0];
  const ring0 = f.geometry.coordinates[0];
  await d.card('In the GeoJSON', `${geojson.features.length} grain outlines`, [
    `crs: ${geojson.crs?.properties?.name ?? '(none)'}`,
    `first outline starts at`,
    `  E ${ring0[0][0].toFixed(3)}  N ${ring0[0][1].toFixed(3)}`,
    `${Object.keys(f.properties).slice(0, 6).join(', ')}, …`,
  ].join('\n'), 5000, { mono: true });
  await d.click('[data-action="close-modal"]', { after: 600 });

  await d.card('That\'s the tour', 'Measure, check, download', 'Help (top right) explains every setting, and docs/METHODS.md describes the models and statistics.', 4500);
}
