// The Export dialog: site and photo tables, outlines and masks, and the printable report.
import { readFileSync } from 'node:fs';
import { addPhotos, analyse, calibrate, closeModal, openModal, PHOTO_A, PHOTO_B, toggleDetails } from './flows.mjs';

export const chapter = 'Keeping and sharing results';
export const title = 'Exports and the printable report';
export const summary = 'Tables for your own analysis, outlines and masks, and a report ready to print.';

export async function prepare(d) {
  d.answerPrompt('Example beach, upper bar');
  await addPhotos(d);
  await d.click('[data-action="rename-site"]');
  await analyse(d);
  await calibrate(d, PHOTO_A);
  await calibrate(d, PHOTO_B);
  await d.click('[data-action="hide-guide"]').catch(() => {});
  await d.click('[data-tool="inspect"]');
}

export async function run(d) {
  const { page } = d;
  await d.caption('<b>Export</b>, top right, makes single files. Everything is made in your browser.', { hold: 0 });
  await openModal(d, 'export');
  const siteBox = page.locator('#app-dialog [data-export="site-summary-csv"]').locator('xpath=..').locator('xpath=..');
  await d.ring(siteBox);
  await d.caption('Site exports: the printable report, the site summary as CSV or JSON, every grain of the site, the grain-size curve as an SVG figure, the project file and a GeoPackage.');
  const csv = await d.download('[data-export="site-summary-csv"]', { after: 1200 });
  const lines = readFileSync(csv, 'utf8').replace(/^﻿/, '').split('\n');
  // A few provenance rows, then the D-values with their interval (numbers rounded for the card).
  const round = (l) => l.replace(/(\d+\.\d{2})\d+/g, '$1');
  const meta = lines.filter((l) => /^metadata,(siteName|appVersion|model)/i.test(l)).slice(0, 4);
  const psd = lines.filter((l) => /^psd(_bootstrap_ci_(lo|hi))?,D(16|50|84),/.test(l)).map(round);
  await d.card('Site Summary CSV', csv.split('/').pop(), ['section,metric,value,unit', ...meta, '…', ...psd, '…'].map((l) => (l.length > 88 ? `${l.slice(0, 86)}…` : l)).join('\n'), 7000, {
    mono: true,
    say: 'Every file starts with how it was made: the app and model versions, the model\'s checksum and every setting. Then the results: D5 to D95 with their intervals, and much more.',
  });

  const photoBox = page.locator('#app-dialog [data-export="photo-grains-csv"]').locator('xpath=..').locator('xpath=..');
  await d.ring(photoBox);
  await d.caption('Photo exports, for the photo on screen: one row per grain with all its measurements, and the photo\'s summary.');
  await d.ring(page.locator('#app-dialog [data-export-opt="what"]').locator('xpath=../..'));
  await d.caption('<b>Outlines, mask, photo</b>: grain outlines as GeoJSON, GeoPackage or SVG, or a label mask image in which each grain has its own value.');
  await d.ring(page.locator('#app-dialog input[type="checkbox"]').last().locator('xpath=..'));
  await d.caption('By default, outline and mask files hold only the grains counted in the statistics. Untick this to export every detected grain.');
  await d.ring(null);

  await toggleDetails(d, 'Printable report options', '#app-dialog');
  await d.ring(page.locator('#app-dialog details', { has: page.locator('> summary', { hasText: 'Printable report options' }) }));
  await d.caption('<b>Printable report options</b>: how grains are drawn on the photos, the photo size, and which sections to include.');
  await d.ring('[data-action="printable-report"]');
  await d.caption('<b>Printable report</b> opens the whole site as numbered A4 pages.', { hold: 0 });
  const tab = await d.popup('[data-action="printable-report"]', { after: 500 });
  await tab.waitForTimeout(3000);
  await tab.setViewportSize({ width: 1000, height: 800 });
  const shot = await tab.screenshot({ fullPage: true, type: 'jpeg', quality: 80 });
  await tab.close();
  await d.ring(null);
  await d.image(shot, {
    hold: 14000,
    label: 'The printable site report (opens in a new tab)',
    say: 'The report has the summary with intervals, the grain-size curve, every percentile, sorting and size classes, shape and fabric, sample adequacy, a table by photo, each photo with its grains, and the methods and references. Print it, or save it as a PDF.',
  });
  await closeModal(d);
  await d.caption('Every export records the app version, the model and its checksum, and all settings, so results can be reproduced.');
}
