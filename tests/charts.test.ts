import { describe, expect, it } from 'vitest';
import { renderAspectRatioHistogramSvg, renderConvergenceChartSvg, renderSizeHistogramSvg, renderTimeSeriesSvg } from '../src/ui/charts.js';
import { svgSize, withSvgMetadata } from '../src/ui/chartExport.js';

describe('charts', () => {
  it('draws the size histogram small to large with an axis label for its unit', () => {
    const svg = renderSizeHistogramSvg({ unit: 'px', step: 1, n: 3, bins: [{ lo: 4, hi: 8, count: 2, weightPct: 20 }, { lo: 8, hi: 16, count: 1, weightPct: 80 }] }, true);
    expect(svg).toMatch(/^<svg viewBox="0 0 400 190"/);
    expect(svg).toContain('n=3');
    expect(svg).toContain('calibrate for mm');
    expect(svg.indexOf('>4<')).toBeLessThan(svg.indexOf('>8<'));
    expect(renderAspectRatioHistogramSvg([0, 1, 2, 0, 0, 0, 0, 0, 0, 0])).toContain('n=3');
  });

  it('adds provenance metadata and reads the size for PNG export', () => {
    const svg = withSvgMetadata('<svg viewBox="0 0 400 190" xmlns="http://www.w3.org/2000/svg"><g/></svg>', { a: '<b>' });
    expect(svg).toContain('<metadata id="webgrainy-provenance">{"a":"&lt;b&gt;"}</metadata><g/>');
    expect(svgSize(svg)).toEqual({ width: 400, height: 190 });
  });
});

describe('charts with undefined percentiles (audit B5)', () => {
  it('convergence chart breaks the line at photo counts without a D50 and never emits NaN', () => {
    const pt = (n: number, d50: number) => ({
      photoCount: n, photoId: `p${n}`, label: `p${n}`, cumulativeGrains: n * 10,
      D16: d50 * 0.5, D50: d50, D84: d50 * 2, ciLoD50: d50 * 0.9, ciHiD50: d50 * 1.1, ciWidthD50: d50 * 0.2, relativeHalfWidthD50Pct: 10,
    });
    expect(renderConvergenceChartSvg([pt(1, NaN), pt(2, 20), pt(3, 21)], true)).not.toContain('NaN');
    const none = renderConvergenceChartSvg([pt(1, NaN)], true);
    expect(none).not.toContain('NaN');
    expect(none).toContain('convergence not available');
  });

  it('time series skips surveys without values and never emits NaN', () => {
    const p = (date: string, d50: number) => ({ date, name: date, color: '#000', D16: d50 / 2, D50: d50, D84: d50 * 2, group: 'A' });
    expect(renderTimeSeriesSvg([p('2024-01-01', NaN), p('2024-06-01', 20), p('2025-01-01', 22)], 'mm')).not.toContain('NaN');
    expect(renderTimeSeriesSvg([p('2024-01-01', NaN)], 'mm')).not.toContain('NaN');
  });
});
