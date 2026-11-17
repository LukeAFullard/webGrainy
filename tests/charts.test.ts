import { describe, expect, it } from 'vitest';
import { renderAspectRatioHistogramSvg, renderSizeHistogramSvg } from '../src/ui/charts.js';
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
