// Open a GeoTIFF site's results in a GIS: download the Site GeoPackage and the photo as a
// Web Mercator GeoTIFF, then add both to RustGIS (https://web.rustgis.app), a GIS that runs
// in the browser.
//
// RustGIS draws its whole interface on a canvas, so this script clicks screen positions
// (1280×720 window) measured on its interface in November 2026. If RustGIS changes its layout,
// update the positions in RG below. Needs internet access to web.rustgis.app.
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
import { makeGeoTiff } from './geotiff.mjs';
import { addPhotos, analyse, closeModal, openModal, PHOTO_A } from './flows.mjs';

export const chapter = 'Keeping and sharing results';
export const title = 'Open your results in a GIS';
export const summary = 'A GeoTIFF photo needs no ruler, and its grain outlines open in place in any GIS, here RustGIS in the browser.';

const GEO_NAME = 'K1_C3_0449_example_geo.tif';
const RUSTGIS = 'https://web.rustgis.app/';

/** Screen positions in RustGIS (1280×720). */
const RG = {
  addData: [710, 110],
  layers: { x: 0, y: 312, width: 268, height: 92 }, // the three new layers, top of the list
  footprintsBox: [33, 326], // visibility tick box of photo_footprints
  grainOutlines: [110, 357], // grain_outlines in the layer list
  outlinesBox: [33, 357], // its visibility tick box
  zoomToLayer: [160, 113], // context menu of grain_outlines
  attributeTable: [160, 140],
  map: [775, 450],
};

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
  await d.click('[data-tool="inspect"]');
  await d.fit();
}

/** Waits until RustGIS has started (its loading spinner is gone) and settled. */
async function rustgisReady(tab) {
  await tab.waitForFunction(() => {
    const el = document.getElementById('rustgis_loading');
    return !el || el.hidden || getComputedStyle(el).display === 'none' || !el.isConnected;
  }, null, { timeout: 120000 }).catch(() => {});
  await tab.waitForTimeout(4000);
}

export async function run(d) {
  const { page } = d;
  await d.ring('[data-scale-readout]');
  await d.caption('This photo is a <b>GeoTIFF</b>, an example placed at a made-up location. Its scale came from the georeferencing, so no ruler was needed, and every grain has map coordinates.');
  await d.ring(null);

  await d.caption('To see the grains on a map, first download them. Open <b>Export</b>.', { hold: 0 });
  await openModal(d, 'export');
  await d.ring('[data-export="site-gpkg"]');
  await d.caption('<b>Site GeoPackage</b> holds every grain outline, and each photo\'s footprint with its D16, D50 and D84, in the photo\'s own map coordinates.', { hold: 0 });
  await d.wait(3000);
  const gpkg = await d.download('[data-export="site-gpkg"]', { after: 1500 });
  await d.select('[data-export-opt="what"]', 'photo', { after: 900 });
  await d.ring(page.locator('[data-export-opt="what"]').locator('xpath=../..'));
  await d.caption('To see the photo under the outlines, download the photo too: <b>Photo (raster)</b>, as a GeoTIFF in Web Mercator.', { hold: 0 });
  await d.wait(2500);
  const photoTif = await d.download('#app-dialog [data-export^="photo-image"]', { after: 1500 });
  await d.ring(null);
  await closeModal(d);

  // Load RustGIS in a background tab while the card is up.
  const loading = d.openTab(RUSTGIS);
  await d.card('Next', 'Open them in a GIS', 'Any GIS opens these files: QGIS, ArcGIS Pro, or RustGIS,\nwhich runs in the browser like webGrainy (web.rustgis.app).', 5000, {
    say: 'Any GIS opens these files: QGIS, ArcGIS Pro, or RustGIS, which runs in the browser like webGrainy.',
  });
  const tab = await loading;
  d.speed(4);
  await d.showTab(tab);
  await rustgisReady(tab);
  d.speed(1);

  await d.caption('This is RustGIS, at web.rustgis.app. It opens with a world map. Press <b>Add Data</b>, and choose both files.', { hold: 0 });
  await d.wait(2500);
  await d.chooseFilesAt(...RG.addData, [photoTif, gpkg], { ms: 900, after: 500 });
  d.speed(3);
  await d.wait(9000);
  d.speed(1);
  await d.ringRect(RG.layers, 4);
  await d.caption('Three new layers: the grain outlines and photo footprints from the GeoPackage, and the photo.');
  await d.ring(null);

  await d.caption('Right-click <b>grain_outlines</b> and choose <b>Zoom To Layer</b>.', { hold: 0 });
  await d.clickAt(...RG.grainOutlines, { button: 'right', ms: 900, after: 1200 });
  await d.clickAt(...RG.zoomToLayer, { ms: 700, after: 4000 });
  await d.caption('The footprint layer covers the photo, so untick it.', { hold: 0 });
  await d.clickAt(...RG.footprintsBox, { ms: 900, after: 4000 });
  await d.caption('Every grain outline sits on its stone in the photo, in the right place on the map.');

  await d.moveTo(...RG.map, 900);
  await d.caption('Zoom in to check them, as you would in webGrainy.', { hold: 0 });
  await d.wheel(-5, 600);
  await d.wait(3000);
  await d.caption('Untick <b>grain_outlines</b> to see the stones underneath, and tick it again to compare.', { hold: 0 });
  await d.clickAt(...RG.outlinesBox, { ms: 900, after: 3500 });
  await d.clickAt(...RG.outlinesBox, { ms: 300, after: 3000 });

  await d.caption('Right-click the layer again for its <b>Attribute Table</b>…', { hold: 0 });
  await d.clickAt(...RG.grainOutlines, { button: 'right', ms: 900, after: 1200 });
  await d.clickAt(...RG.attributeTable, { ms: 700, after: 3500 });
  await d.ringRect({ x: 272, y: 465, width: 1006, height: 228 }, 2);
  await d.caption('…one row per grain, with the same measurements as webGrainy\'s grain table: size in pixels and millimetres, axes, shape, and whether it counts in the statistics.');
  await d.ring(null);
  await d.caption('Here the location is invented. With a drone orthophoto, each outline lands where the stone really is, ready to map grain size across a whole river reach.');
}
