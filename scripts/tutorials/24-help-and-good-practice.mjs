// Help, keyboard shortcuts, About and citations, and good practice for reported results.
import { addPhotos, analyse, calibrate, closeModal, openModal, PHOTO_A } from './flows.mjs';

export const chapter = 'Keeping and sharing results';
export const title = 'Help, shortcuts and good practice';
export const summary = 'Where to find answers inside the app, and a checklist for results you will report.';

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
  await d.caption('<b>Help</b>, top right, explains every setting in plain language.', { hold: 0 });
  await d.click('#topbar [data-open-help]', { after: 1200 });
  const topic = page.locator('#app-dialog details.help-topic > summary').first();
  await d.click(topic, { after: 1200 });
  await d.ring(page.locator('#app-dialog details.help-topic').first());
  await d.caption('For each one: what it does, its default, and when it is reasonable to change it. The small <b>?</b> buttons next to settings open the same text.');
  await d.ring(page.locator('#app-dialog button', { hasText: 'Show the getting-started guide' }));
  await d.caption('<b>Show the getting-started guide</b> brings back the step list if you hid it.');
  await d.ring(null);
  await d.caption('<b>Keyboard shortcuts</b> lists every shortcut. You can also press the question mark key.', { hold: 0 });
  await d.click(page.locator('#app-dialog button', { hasText: 'Keyboard shortcuts' }), { after: 1500 });
  await d.ring('#app-dialog .modal-card');
  await d.caption('Square brackets go to the previous or next photo, number keys pick tools, Enter finishes a shape, Escape cancels it, and Control Z undoes.');
  await d.ring(null);
  await closeModal(d);

  await openModal(d, 'about');
  await d.ring('#app-dialog .modal-card');
  await d.caption('<b>About</b> covers privacy, the software and model versions, and the papers to cite: ImageGrains and Cellpose. webGrainy is an independent, unofficial browser version of ImageGrains.');
  await d.ring(null);
  await closeModal(d);

  await d.card('Good practice', 'Before you report results', 'Calibrate every photo, and rectify tilted ones.\nCheck and correct the outlines; leave out rulers, boots and water.\nUse Cellpose-SAM, and five or more photos per site.');
  await d.card('Good practice', 'Compare like with like', 'Use the same model and settings for everything you compare.\nSet the field-count cutoff to match a pebble count.\nCheck against field measurements at some of your own sites.');
  await d.card('Good practice', 'What to report', 'The model and the size metric; the pooling mode and any cutoff.\nThe number of grains and photos, and that outlines were checked.\nEvery export already records the rest.');
  await d.caption('The Settings guide and the Methods document, linked from the project page, explain every setting and calculation in detail.');
}
