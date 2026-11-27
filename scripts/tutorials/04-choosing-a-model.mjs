// U-Net or Cellpose-SAM, the weights, the engine chip and offline downloads.
import { addPhotos, closeModal, openDetails, openModal, PHOTO_A } from './flows.mjs';

export const chapter = 'Getting started';
export const title = 'Choosing a model';
export const summary = 'Fast U-Net or accurate Cellpose-SAM, and getting the model ready for offline use.';

export async function prepare(d) {
  await addPhotos(d, [PHOTO_A]);
  await d.click('[data-action="hide-guide"]').catch(() => {});
}

export async function run(d) {
  const { page } = d;
  await openDetails(d, 'Analysis settings', '#sidebar-left');
  await d.ring('[data-param="model"]');
  await d.caption('The model is chosen in <b>Analysis settings</b>. <b>Auto</b> picks one for each photo, based on the photo and your hardware.');
  await d.caption('<b>U-Net</b> is small, 26 megabytes, and fast. It works on almost any device, including phones. In testing, its median D50 error was about 6 percent.');
  await d.select('[data-param="model"]', 'cpsam');
  await d.caption('<b>Cellpose-SAM</b>, or CP-SAM, is more accurate: a median D50 error of about 3 percent. It is a larger download and needs a modern graphics card to be quick; on the processor it takes several minutes per photo.');
  await d.ring('[data-param="cpsamWeights"]');
  await d.caption('<b>CP-SAM weights</b>: FP16, INT8 and FP4 are the same network stored in different sizes, with the same accuracy in testing. Auto uses FP16 on a suitable graphics card, and INT8 on the processor, where it needs about half the memory.');
  await d.ring(null);
  await d.caption('Use CP-SAM for results you will report, and U-Net for a quick look or on a phone. On phones and tablets, Auto always picks U-Net. Whatever you choose, <b>use the same model for photos you compare</b>.');
  await d.select('[data-param="model"]', 'auto');

  // Describe the chip as it reads on this computer (e.g. "CPU · 7 threads" or "GPU").
  const chip = (await page.locator('#topbar .status-pill').first().innerText()).trim();
  const threads = chip.match(/(\d+)\s*thread/)?.[1];
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const here = /GPU/.test(chip)
    ? 'here the graphics card. Without a suitable one, it says CPU and the number of processor threads.'
    : `here the processor, with ${threads ? `${words[Number(threads)] ?? threads} thread${threads === '1' ? '' : 's'}` : 'several threads'}. With a suitable graphics card it says GPU.`;
  await d.ring('#topbar .status-pill');
  await d.caption(`This chip shows what will run the model: ${here}`);
  await d.ring(null);

  await openModal(d, 'models');
  await d.ring('#app-dialog .modal-card, #app-dialog');
  await d.caption('<b>Models</b> lists every model with its size, and whether it is already stored in this browser for offline use.');
  await d.ring(page.locator('#app-dialog [data-action="download-model"]').first());
  await d.caption('Before a field trip, press <b>Download &amp; Cache</b> for the models you need, so they work without a connection.');
  await d.ring(null);
  const int8 = page.locator('#app-dialog [data-action="download-model"][data-model-id="ig2_cpsam_int8_wo_fp32scale"]').locator('xpath=../..');
  if (await int8.count()) {
    await d.ring(int8);
    await d.caption('Each entry says when it is the best choice. <b>INT8</b> is best on the processor: about 2 gigabytes of memory instead of almost 4 for FP16.');
  }
  await d.ring(null);
  await closeModal(d);
}
