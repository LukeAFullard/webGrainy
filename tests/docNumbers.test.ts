/**
 * Figures quoted in the README, METHODS, settings guide and in-app help must match the results
 * files the validation scripts write (pre-publication audit B3: several quoted figures were stale
 * or had no script behind them). When a validation is re-run and its numbers change, this test
 * names the text to update.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const rowsOf = (md: string): string[][] =>
  md.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

describe('quoted validation figures match the results files', () => {
  it('held-out accuracy (README table and error-tail sentence)', () => {
    const rows = rowsOf(read('validation/heldout/heldout_app_results.md'));
    const readme = read('README.md');
    const unet = rows.find((r) => r[0] === 'U-Net')!;
    const cpsam = rows.find((r) => r[0]!.startsWith('Cellpose-SAM'))!;
    for (const r of [unet, cpsam]) {
      expect(readme).toContain(r[2]); // mean [CI]
      expect(readme).toContain(r[3]); // median [CI]
      expect(readme).toContain(r[4]); // D16 / D84
    }
    const tail = (r: string[]): string => `${Math.round(Number(r[5]!.replace('%', '')))}%`;
    expect(readme).toContain(`${tail(cpsam)} of Cellpose-SAM images and ${tail(unet)} of U-Net images have D50 errors above 50%`);
    // The accuracy line in every export and in the printable report.
    const prov = read('src/modules/provenance.ts');
    const median = (r: string[]): string => r[3]!.split(' ')[0]!;
    expect(prov).toContain(`median D50 error was ${median(cpsam)} with Cellpose-SAM and ${median(unet)} with U-Net, but ${tail(cpsam)} and ${tail(unet)} of photos had D50 errors above 50%`);
  });

  it('min-Feret vs b-axis D50 (help and settings guide)', () => {
    const rows = rowsOf(read('validation/heldout/feret_ratio_results.md')).filter((r) => r[0] === 'U-Net' || r[0]!.startsWith('Cellpose-SAM'));
    const median = rows.map((r) => Number(r[2]!.replace('%', '')));
    const rounded = Math.round(median.reduce((a, b) => a + b, 0) / median.length);
    const lo = Math.round(Math.min(...rows.map((r) => Number(r[3]!.split(' to ')[0]!.replace('%', '')))));
    const hi = Math.round(Math.max(...rows.map((r) => Number(r[3]!.split(' to ')[1]!.replace('%', '')))));
    const quote = `about ${rounded}% larger than the`;
    const iqr = `middle half of photos ${lo}–${hi}%`;
    for (const f of ['src/ui/help.ts', 'docs/SETTINGS_GUIDE.md']) {
      expect(read(f)).toContain(quote);
      expect(read(f)).toContain(iqr);
    }
  });

  it('K1: photo D50 without a field-count cutoff (settings guide and help)', () => {
    const rows = rowsOf(read('validation/k1/k1_app_results.md'));
    const cpsamNone = rows.find((r) => r[0]!.startsWith('Cellpose-SAM') && r[1]!.startsWith('none'))!;
    const finer = Math.abs(Number(cpsamNone[6]!.replace('%', '')));
    const rounded = Math.round(finer / 10) * 10;
    expect(read('docs/SETTINGS_GUIDE.md')).toContain(`about ${rounded}% finer`);
    expect(read('src/ui/help.ts')).toContain(`about ${rounded}% with Cellpose-SAM at the K1 test site`);
    expect(read('README.md')).toContain(`Cellpose-SAM's D50 is ${finer}% finer`);
  });

  it('survey-change power (METHODS and the comparison README)', () => {
    const rows = rowsOf(read('validation/comparison/power_results.md'));
    const d50 = (bed: string, patch: string, photos: string): string => {
      const r = rows.find((x) => x[0] === bed && x[1] === patch && x[2] === photos)!;
      return `${Math.round(Number(r[4]!.replace('%', '')))}%`;
    };
    const methods = read('docs/METHODS.md');
    const cmp = read('validation/comparison/README.md');
    for (const text of [methods, cmp]) {
      expect(text).toContain(`about ${d50('uniform sorting', '0.15', '5')} of the time with 5 photos per survey`);
      expect(text).toContain(`about ${d50('uniform sorting', '0.15', '10')} with 10`);
      expect(text).toContain(`${d50('variable sorting', '0.30', '5')} with 5 photos and ${d50('variable sorting', '0.30', '10')} with 10`);
    }
  });
});
