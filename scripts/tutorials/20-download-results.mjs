// Download results as one .zip, and how long the browser keeps your sites.
import { execFileSync } from 'node:child_process';
import { addPhotos, analyse, calibrate, PHOTO_A, PHOTO_B } from './flows.mjs';

export const chapter = 'Keeping and sharing results';
export const title = 'Download your results';
export const summary = 'The browser is a working space, not an archive: keep every result file in one download.';

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
  const box = page.locator('#sidebar-left .backup-line');
  await d.ring(box);
  await d.caption('Photos and results are stored in this browser while you work. This box says when the results were last downloaded: so far, never.');
  await d.ring(page.getByText(/Stored in this browser until/).first().locator('xpath=..'));
  await d.caption('A site is removed after some days without use. Opening or changing it, or pressing <b>Keep longer</b>, restarts the count.');
  await d.ring('#retention-days');
  await d.caption('Choose 7, 14, 30 or 90 days, or until you delete them. Sites whose latest results were never downloaded are not removed automatically: you are asked first.');
  await d.ring(null);

  await d.caption('To keep your work, press <b>Download results</b>.', { hold: 0 });
  await d.click(box.locator('[data-action="open-download-results"]'), { after: 1200 });
  await d.ring('#app-dialog .modal-card');
  await d.caption('One zip holds everything: the site summary, every grain, the grain-size curve, the printable report, and for each photo its grains, summary, mask and outlines, with a README.');
  await d.ring(page.locator('#download-include-project').locator('xpath=..'));
  await d.caption('Tick this to add the project file, with the photos, so you can reopen the site later. It is off by default: it is large, and photos can carry GPS locations.');
  await d.ring(null);
  const zip = await d.download('[data-action="download-results"]', { after: 1500 });
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  const shown = names.length > 12 ? [...names.slice(0, 11), `… and ${names.length - 11} more`] : names;
  await d.card('Inside the zip', zip.split('/').pop(), shown.join('\n'), 6500, {
    mono: true,
    say: 'Inside the zip: a README, the site summary and pooled grains, the report, and a folder for each photo.',
  });
  await d.ring(page.locator('#sidebar-left .backup-line').first());
  await d.caption('The box now says the results were downloaded just now. If you change the site afterwards, it warns you again.');
  await d.ring(page.getByText(/Browser storage:/).first());
  await d.caption('This line shows how much browser storage is used. If it ever fills up, webGrainy asks you to download results and free space.');
  await d.ring(null);
  await d.caption('Keep your original photos in your own folders too. Downloads are the only copy that lasts.');
}
