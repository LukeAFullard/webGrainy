/** The grain-size curve names its coloured points and lines in a legend (user request). */
import { describe, expect, it } from 'vitest';
import { renderPsdChartSvg } from '../src/ui/charts.js';
import type { PsdPercentiles } from '../src/types/index.js';

const psd = { D5: 4, D10: 6, D16: 8, D25: 12, D50: 22, D75: 40, D84: 52, D90: 70, D95: 90 } as PsdPercentiles;
const scale = (k: number): PsdPercentiles => Object.fromEntries(Object.entries(psd).map(([key, v]) => [key, v * k])) as unknown as PsdPercentiles;

describe('PSD chart legend', () => {
  it('names D16 / D50 / D84 with their values, and only the lines that are drawn', () => {
    const site = renderPsdChartSvg({
      psd, unit: 'mm', xAxis: 'mm', title: 'Site', ciLower: scale(0.9), ciUpper: scale(1.1),
      perPhotoCurves: [{ label: 'a', D16: 7, D50: 20, D84: 50 }, { label: 'b', D16: 9, D50: 24, D84: 55 }], detectionLimit: 3, lightTheme: true,
    });
    for (const t of ['D16 = 8.0 mm', 'D50 = 22.0 mm', 'D84 = 52.0 mm', 'Cumulative PSD', '95% CI (bootstrap)', 'Each photo (D16–D50–D84)', 'Smallest measurable grain', '% finer (cumulative)']) {
      expect(site, t).toContain(t);
    }
    const photo = renderPsdChartSvg({ psd, unit: 'mm', xAxis: 'phi', title: 'Photo' });
    expect(photo).toContain('D50 = 22.0 mm (-4.46 φ)');
    expect(photo).not.toContain('95% CI');
    expect(photo).not.toContain('Each photo');
    // The legend makes the chart taller than the plot area alone.
    const h = Number(/viewBox="0 0 400 (\d+(?:\.\d+)?)"/.exec(site)![1]);
    expect(h).toBeGreaterThan(240);
    expect(site.match(/<svg /g)).toHaveLength(1);
  });

  it('labels pixel sizes when the photos are not calibrated', () => {
    expect(renderPsdChartSvg({ psd, unit: 'px', xAxis: 'mm', title: 'px' })).toContain('D50 = 22 px');
  });
});
