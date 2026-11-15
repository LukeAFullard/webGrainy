// Visual check of the settings/help UI on dist/ (no model needed).
// Usage: node audit/review/ui_help_screens.cjs <url> <outdir>
const { chromium } = require('playwright');
(async () => {
  const [url, out] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  // open the sidebar controls + advanced + dashboard uncertainty block
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
  await page.screenshot({ path: `${out}/settings_panels.png` });
  // a "?" inside a checkbox label must not toggle the checkbox
  const before = await page.isChecked('input[data-param="excludeBorder"]');
  await page.click('label:has(input[data-param="excludeBorder"]) .help-btn');
  await page.waitForTimeout(300);
  const after = await page.isChecked('input[data-param="excludeBorder"]');
  const title = await page.textContent('#dialog-title');
  await page.screenshot({ path: `${out}/help_topic.png` });
  // advanced block stays open across a re-render (change a setting)
  await page.click('[data-action="close-modal"]');
  await page.evaluate(() => { const d = document.querySelector('details[data-keep-open="advanced-analysis"]'); if (d) d.open = true; });
  await page.fill('input[data-param="niter"]', '300');
  await page.dispatchEvent('input[data-param="niter"]', 'change');
  await page.waitForTimeout(300);
  const advOpen = await page.evaluate(() => document.querySelector('details[data-keep-open="advanced-analysis"]')?.open);
  const niterVal = await page.inputValue('input[data-param="niter"]');
  await page.click('[data-action="reset-analysis-params"]');
  await page.waitForTimeout(300);
  const niterReset = await page.inputValue('input[data-param="niter"]');
  // confidence level select is stored as a number
  await page.selectOption('select[data-site-opt="confidenceLevel"]', '0.9');
  await page.waitForTimeout(300);
  await page.click('button[data-open-help=""] >> nth=0');
  await page.waitForTimeout(300);
  const topics = await page.locator('.help-topic').count();
  await page.screenshot({ path: `${out}/help_all.png` });
  console.log(JSON.stringify({ checkboxUnchangedByHelpClick: before === after, dialogTitle: title, advancedStaysOpen: advOpen, niterVal, niterReset, helpTopics: topics, errors: errs }, null, 2));
  await browser.close();
})();
