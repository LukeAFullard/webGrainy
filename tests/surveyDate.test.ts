import { describe, expect, it } from 'vitest';
import { earliestPhotoDate, isIsoDate, orderByDate, photoDate, siteSurveyDate } from '../src/modules/surveyDate.js';
import { comparisonCsv, computeComparedSites } from '../src/modules/siteComparison.js';
import { renderTimeSeriesSvg } from '../src/ui/charts.js';
import { renderCompareHtml } from '../src/ui/panels/compare.js';
import { createInitialState } from '../src/ui/state.js';

describe('survey dates', () => {
  it('reads EXIF and ISO dates, rejects impossible ones', () => {
    expect(photoDate('2025:03:14 10:22:01')).toBe('2025-03-14');
    expect(photoDate('2025-03-14T10:22:01Z')).toBe('2025-03-14');
    expect(photoDate('0000:00:00 00:00:00')).toBeNull();
    expect(photoDate('2025:02:30 00:00:00')).toBeNull();
    expect(photoDate(undefined)).toBeNull();
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(isIsoDate(20240101)).toBe(false);
  });

  it('uses the entered date, else the earliest photo date', () => {
    expect(earliestPhotoDate(['2025:06:02 09:00:00', undefined, '2025:06:01 17:00:00'])).toBe('2025-06-01');
    expect(siteSurveyDate('2024-11-30', ['2025:06:01 00:00:00'])).toEqual({ date: '2024-11-30', source: 'set' });
    expect(siteSurveyDate(undefined, ['2025:06:01 00:00:00'])).toEqual({ date: '2025-06-01', source: 'photos' });
    expect(siteSurveyDate('not a date', [])).toEqual({ date: null, source: null });
  });

  it('orders dated sites oldest first and lists the undated separately', () => {
    const o = orderByDate([
      { name: 'B', date: '2025-01-02' },
      { name: 'X', date: null },
      { name: 'A', date: '2024-05-01' },
      { name: 'C', date: '2025-01-02' },
    ]);
    expect(o.dated.map((s) => s.name)).toEqual(['A', 'B', 'C']);
    expect(o.undated.map((s) => s.name)).toEqual(['X']);
  });

  it('compared sites carry their date into the CSV and the time-series view', () => {
    const sites = computeComparedSites(
      [
        { siteId: 'a', name: 'Spring', inputs: [], surveyDate: '2025-04-01' },
        { siteId: 'b', name: 'Undated', inputs: [] },
      ],
      { poolingMode: 'physical-area' },
    );
    expect(sites[0]).toMatchObject({ date: '2025-04-01', dateSource: 'set' });
    expect(sites[1]).toMatchObject({ date: null, dateSource: null });
    expect(comparisonCsv(sites, {})).toContain('site,Spring,survey_date,2025-04-01,date (entered)');
  });

  it('draws points in date order with CI bars, or a hint when nothing is dated', () => {
    const svg = renderTimeSeriesSvg(
      [
        { date: '2024-05-01', name: 'A', color: '#0072B2', D16: 10, D50: 20, D84: 40, ci: { D16: [9, 11], D50: [18, 22], D84: [35, 45] } },
        { date: '2025-05-01', name: 'B', color: '#E69F00', D16: 8, D50: 16, D84: 30 },
      ],
      'mm',
      true,
    );
    expect(svg).toContain('2024-05-01');
    expect(svg).toContain('A (2024-05-01): D50 20.0 mm');
    // Different places / no place: points are not joined into a line (no false "trend").
    expect((svg.match(/<polyline/g) ?? []).length).toBe(0);
    const samePlace = renderTimeSeriesSvg(
      [
        { date: '2024-05-01', name: 'A', color: '#0072B2', D16: 10, D50: 20, D84: 40, group: 'Reach 3', groupColor: '#0072B2' },
        { date: '2025-05-01', name: 'B', color: '#E69F00', D16: 8, D50: 16, D84: 30, group: 'Reach 3', groupColor: '#0072B2' },
      ],
      'mm',
    );
    expect((samePlace.match(/<polyline/g) ?? []).length).toBe(3); // D16, D50, D84 of the one place
    expect(renderTimeSeriesSvg([], 'mm')).toContain('Give at least one compared site a survey date');
  });

  it('compare view: date toggle, date column and the undated list', () => {
    const report = { unit: 'mm', includedPhotoCount: 1, validGrainCount: 100, psd: { D16: 1, D50: 2, D84: 4 }, bootstrapCi: { lower: { D16: 1, D50: 2, D84: 3 }, upper: { D16: 1, D50: 2, D84: 5 } }, extra: null, folkWard: null, wentworth: null, wentworthHistogram05Phi: [], wentworthHistogram10Phi: [], dCutoffCommonMm: null, adequacy: { rating: 'Adequate', effectiveGrainCount: 250 }, shape: { aspectRatioCounts: [], medianAspectRatio: 0.7, n: 0 }, fabricRose: { grainCount: 0 } } as never;
    const st = {
      ...createInitialState(),
      dashboardScope: 'compare' as const,
      compareByDate: true,
      sites: [{ siteId: 'a', name: 'Spring', photoOrder: [] } as never, { siteId: 'b', name: 'Undated', photoOrder: [] } as never],
      comparison: {
        loading: false,
        error: null,
        sites: [
          { siteId: 'b', name: 'Undated', color: '#111', report, error: null, date: null, dateSource: null, place: null, analysisSettings: {} },
          { siteId: 'a', name: 'Spring', color: '#222', report, error: null, date: '2025-04-01', dateSource: 'photos', place: null, analysisSettings: {} },
        ],
      },
    };
    const html = renderCompareHtml(st as never, true, new Map());
    expect(html).toContain('data-action="toggle-compare-date" checked');
    expect(html).toContain('<th>Survey date</th>');
    expect(html.indexOf('Spring</th>')).toBeLessThan(html.indexOf('Undated</th>')); // dated first
    expect(html).toContain('from photos');
    expect(html).toContain('No survey date (not plotted): Undated');
    expect(html).toContain('data-chart-dl="compare-time"');
  });
});
