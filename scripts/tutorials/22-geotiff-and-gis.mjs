// GeoTIFF photos: the scale from georeferencing, and outlines and masks in map coordinates for GIS.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
import { makeGeoTiff } from './geotiff.mjs';
import { addPhotos, analyse, closeModal, openModal, PHOTO_A } from './flows.mjs';

export const chapter = 'Keeping and sharing results';
export const title = 'GeoTIFFs and GIS';
export const summary = 'Drone orthophotos need no ruler, and their grain outlines open in place in ArcGIS, QGIS or a web map.';
const GEO_NAME = 'K1_C3_0449_example_geo.tif';

export async function prepare(d) {
  // An example GeoTIFF of the sample photo, at an invented spot in NZTM2000 (EPSG:2193).
  const tif = await makeGeoTiff(PHOTO_A, {
    out: join(ROOT, '.cache', 'tutorial-photos', GEO_NAME), metresPerPx: 0.001534, x0: 1570123.4, y0: 5180456.7,
  });
  d.answerPrompt('Example beach, March 2025');
  await addPhotos(d, [], [tif]);
  await d.click('[data-action="rename-site"]');
  await analyse(d);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.page.evaluate(() => document.getElementById('sidebar-left').scrollTo(0, 0));
}

export async function run(d) {
  const { page } = d;
  await d.ring('[data-scale-readout]');
  await d.caption('This photo is a <b>GeoTIFF</b>, an example placed at a made-up location in New Zealand. Its scale was read from the georeferencing, so no ruler was needed.');
  await d.ring(null);
  await d.caption('GeoTIFFs in projected coordinates in metres, such as UTM or national grids, are calibrated automatically. Rectifying such a photo would lose its map position.');

  await d.caption('For GIS, open <b>Export</b>.', { hold: 0 });
  await openModal(d, 'export');
  await d.ring(page.locator('[data-export-opt="what"]').locator('xpath=../..'));
  await d.caption('Choose what to export: the grain outlines, the label mask, or the photo itself. Then the format and the coordinates.');
  await d.select('[data-export-opt="coords"]', 'lonlat', { after: 900 });
  await d.ring(page.locator('[data-export-opt="coords"]'));
  await d.caption('<b>Longitude and latitude</b> opens in web maps, ArcGIS Online and any GIS. <b>Map coordinates</b> keep the photo\'s own coordinate system, exactly, for QGIS and ArcGIS Pro.');
  await d.ring('[data-export-hint]');
  await d.caption('The line below always says what the chosen file holds and where it will open.');
  const warn = page.getByText('Outlines are coarser than the photo.').locator('xpath=..');
  if (await warn.count()) {
    await d.ring(warn);
    await d.caption('Note: the outlines were traced on a smaller working copy, so their edges step by a few millimetres. Re-analyse at full scale for finer outlines.');
  }
  await d.ring(null);
  const geojson = JSON.parse(readFileSync(await d.download('[data-export="photo-geojson-lonlat"]', { after: 800 }), 'utf8'));
  const f = geojson.features[0];
  const ring0 = f.geometry.coordinates[0];
  await d.card('In the GeoJSON', `${geojson.features.length} grain outlines`, [
    'WGS84 longitude / latitude (opens in web maps)',
    'first outline starts at',
    `  lon ${ring0[0][0].toFixed(7)}, lat ${ring0[0][1].toFixed(7)}`,
    `${Object.keys(f.properties).slice(0, 6).join(', ')}, …`,
  ].join('\n'), 5500, {
    mono: true,
    say: 'Each grain is a polygon on the map, with its measurements as attributes.',
  });

  await d.select('[data-export-opt="format"]', 'gpkg', { after: 900 });
  await d.ring(page.locator('[data-export-opt="format"]'));
  await d.caption('A <b>GeoPackage</b> holds the same outlines as one layer, with the coordinate system built in: drag it into ArcGIS Pro or QGIS.');
  await d.select('[data-export-opt="what"]', 'mask', { after: 900 });
  await d.ring(page.locator('[data-export-opt="what"]').locator('xpath=../..'));
  await d.caption('The <b>label mask</b> can be a GeoTIFF too, in the photo\'s position, or reprojected north-up to Web Mercator for web maps.');
  await d.ring('[data-export="site-gpkg"]');
  await d.caption('<b>Site GeoPackage</b> puts every photo of the site in one file: all grain outlines, and each photo\'s footprint with its D16, D50 and D84.');
  await d.ring(null);
  await d.select('[data-export-opt="what"]', 'outlines', { after: 300 });
  await closeModal(d);
  await d.caption('The <b>Download results</b> zip includes all of these map files for GeoTIFF photos.');
}
