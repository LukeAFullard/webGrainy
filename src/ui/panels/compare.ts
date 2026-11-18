/** Compare sites view: site picker, overlaid PSD and size histograms, D50 table. */
import { compareD50 } from '../../modules/siteComparison.js';
import { sizeHistogramFromWentworth } from '../../modules/histograms.js';
import { renderComparePsdSvg, renderCompareSizeHistogramSvg, renderTimeSeriesSvg, type TimeSeriesPoint } from '../charts.js';
import { orderByDate } from '../../modules/surveyDate.js';
import type { ComparedSite } from '../../modules/siteComparison.js';
import { helpButton } from '../help.js';
import type { AppState } from '../state.js';
import { chartBoxFor, esc, type ChartRegistry } from './html.js';

export function scopeButtonsHtml(scope: AppState['dashboardScope']): string {
  const b = (id: AppState['dashboardScope'], label: string, title: string): string =>
    `<button type="button" class="btn btn-sm ${scope === id ? 'active' : ''}" aria-pressed="${scope === id ? 'true' : 'false'}" data-scope="${id}" title="${title}">${label}</button>`;
  return (
    b('photo', 'This photo', 'Results for the photo shown') +
    b('site', 'Whole site', 'Pooled results for all included photos of this site') +
    b('compare', 'Compare sites', 'Overlay and compare the results of several sites')
  );
}

// ---- Compare sites: other sites' saved results are loaded once and cached until the site changes ----
export function renderCompareHtml(state: AppState, lightTheme: boolean, charts: ChartRegistry): string {
  const chartBox = chartBoxFor(charts);
  const cmp = state.comparison;
  const chosen = new Set(state.compareSiteIds ?? state.sites.map((s) => s.siteId));
  const colorOf = new Map((cmp?.sites ?? []).map((s) => [s.siteId, s.color]));
  const picker = state.sites
    .map(
      (s) => `<label class="checkbox-label compare-site">
        <input type="checkbox" data-compare-site="${esc(s.siteId)}" ${chosen.has(s.siteId) ? 'checked' : ''} />
        <span class="swatch" style="background:${colorOf.get(s.siteId) ?? 'transparent'}"></span>${esc(s.name)} <span class="summary-note">(${s.photoOrder.length} photos)</span>
      </label>`,
    )
    .join('');
  const byDate = state.compareByDate;
  const ordered = byDate ? (() => { const o = orderByDate(cmp?.sites ?? []); return [...o.dated, ...o.undated]; })() : cmp?.sites ?? [];
  const withReport = ordered.filter((s) => s.report !== null);
  const dateCell = (s: ComparedSite): string =>
    s.date ? `${esc(s.date)}${s.dateSource === 'photos' ? '<span class="stats-note">from photos</span>' : ''}` : '<span class="stats-note">no date</span>';
  const units = new Set(withReport.map((s) => s.report!.unit));
  const mixedUnits = units.size > 1;
  const plotted = mixedUnits ? withReport.filter((s) => s.report!.unit === 'mm') : withReport;
  const unit = (plotted[0]?.report?.unit ?? 'mm') as 'mm' | 'px';
  const step: 0.5 | 1 = state.histogramStepPhi === 0.5 ? 0.5 : 1;
  const v = (n: number | undefined | null, d = 1): string => (n === undefined || n === null || !Number.isFinite(n) ? '—' : n.toFixed(d));
  const table = withReport.length
    ? `<div class="table-scroll"><table class="stats-table compare-table">
        <thead><tr><th>Site</th><th>Survey date</th><th>Photos / grains</th><th>D16</th><th>D50 (95% CI)</th><th>D84</th><th>Dg / σg</th><th>Sauter</th><th>Sorting φ</th><th>Gravel / cobble %</th></tr></thead>
        <tbody>${withReport
          .map((s) => {
            const r = s.report!;
            return `<tr><th scope="row"><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</th>
              <td>${dateCell(s)}</td><td>${r.includedPhotoCount} / ${r.validGrainCount}</td><td>${v(r.psd.D16)}</td>
              <td>${v(r.psd.D50)} (${v(r.bootstrapCi.lower.D50)}–${v(r.bootstrapCi.upper.D50)})</td><td>${v(r.psd.D84)}</td>
              <td>${v(r.extra?.geometricMean)} / ${v(r.extra?.geometricSd, 2)}</td><td>${v(r.extra?.sauterMeanD32)}</td>
              <td>${v(r.folkWard?.sortingPhi, 2)}</td><td>${r.wentworth ? `${v(r.wentworth.gravelPct, 0)} / ${v(r.wentworth.cobblePct, 0)}` : '—'}</td></tr>`;
          })
          .join('')}</tbody></table></div>
        <p class="field-hint">Sizes in ${unit}. All sites use the same statistics settings (${esc(state.siteOptions.poolingMode)}, ${esc(state.siteOptions.sizeMetric ?? 'bAxis')}).</p>`
    : '';
  const pairs = compareD50(plotted);
  const pairHtml = pairs.length
    ? `<details class="advanced-block" data-keep-open="compare-pairs" open>
        <summary>D50 differences between sites <span class="summary-note">approximate</span></summary>
        <table class="stats-table"><tbody>${pairs
          .map(
            (c) => `<tr><th scope="row">${esc(c.a)} ÷ ${esc(c.b)}<span class="stats-note">${c.p < 0.05 ? 'likely different (p &lt; 0.05)' : 'no clear difference'}</span></th>
              <td>${c.ratio.toFixed(2)}× (${c.ratioLo.toFixed(2)}–${c.ratioHi.toFixed(2)})<br/>p ${c.p < 0.001 ? '&lt; 0.001' : `= ${c.p.toFixed(3)}`}</td></tr>`,
          )
          .join('')}</tbody></table>
        <p class="field-hint">Ratio of D50s with a 95% interval, from each site's bootstrap interval on a log scale (z-test). A screening check, not a formal two-sample test. ${helpButton('compareSites')}</p>
      </details>`
    : '';
  const problems = (cmp?.sites ?? []).filter((s) => s.report === null || (mixedUnits && s.report.unit !== 'mm'));
  const problemHtml = problems.length
    ? `<div class="warning-banner compare-problems">${problems
        .map(
          (s) => `<div class="row-between" style="gap:8px;align-items:flex-start;">
            <span><strong>${esc(s.name)}:</strong> ${esc(s.report === null ? s.error ?? 'no results' : 'not calibrated (sizes in px), so it cannot be plotted with calibrated sites')}</span>
            ${s.siteId !== state.activeSiteId ? `<button type="button" class="btn btn-sm" data-action="open-site" data-site-id="${esc(s.siteId)}" title="Open this site to calibrate or analyse its photos">Open</button>` : ''}
          </div>`,
        )
        .join('')}</div>`
    : '';
  const anyUncalibrated = (cmp?.sites ?? []).some((s) => (s.error ?? '').includes('No scale yet') || s.report?.unit === 'px');
  const pixelsToggle =
    anyUncalibrated || state.compareInPixels
      ? `<label class="checkbox-label" style="margin-top:6px;">
          <input type="checkbox" data-action="toggle-compare-px" ${state.compareInPixels ? 'checked' : ''} />
          Compare in pixels instead of mm <span class="summary-note">only meaningful if all photos were taken with the same camera at the same height</span>
        </label>`
      : '';
  const timeOrder = orderByDate(plotted);
  const timePoints: TimeSeriesPoint[] = timeOrder.dated.map((s) => {
    const r = s.report!;
    const ci = (k: 'D16' | 'D50' | 'D84'): [number, number] => [r.bootstrapCi.lower[k], r.bootstrapCi.upper[k]];
    return { date: s.date!, name: s.name, color: s.color, D16: r.psd.D16, D50: r.psd.D50, D84: r.psd.D84, ci: { D16: ci('D16'), D50: ci('D50'), D84: ci('D84') } };
  });
  const dateToggle =
    plotted.length > 0
      ? `<label class="checkbox-label" style="margin-top:6px;">
          <input type="checkbox" data-action="toggle-compare-date" ${byDate ? 'checked' : ''} />
          Order by survey date and plot sizes over time ${helpButton('surveyDate')}
        </label>`
      : '';
  const timeHtml = byDate
    ? `${chartBox('compare-time', 'Grain size over time', (light) => renderTimeSeriesSvg(timePoints, unit, light), lightTheme)}
       ${timeOrder.undated.length > 0 ? `<p class="field-hint">No survey date (not plotted): ${timeOrder.undated.map((s) => esc(s.name)).join(', ')}. Set one in the Site panel, or add photos with a camera date.</p>` : ''}`
    : '';
  const psdSeries = plotted.map((s) => ({ name: s.name, color: s.color, psd: s.report!.psd, ciLower: s.report!.bootstrapCi.lower, ciUpper: s.report!.bootstrapCi.upper }));
  const histSeries = plotted.map((s) => ({
    name: s.name,
    color: s.color,
    hist: sizeHistogramFromWentworth((step === 0.5 ? s.report!.wentworthHistogram05Phi : s.report!.wentworthHistogram10Phi) ?? [], step),
  }));
  return `
    <div class="panel-section">
      <div class="row-between" style="margin-bottom:6px;">
        <span class="panel-title">Results</span>
        <div class="row">${scopeButtonsHtml('compare')}</div>
      </div>
      <div class="compare-picker">${picker || '<span class="field-hint">Create more sites (Site → + New) to compare them.</span>'}</div>
      ${cmp?.loading ? '<div class="basis-banner">Loading the chosen sites…</div>' : ''}
      ${cmp?.error ? `<div class="warning-banner">${esc(cmp.error)}</div>` : ''}
      ${problemHtml}
      ${pixelsToggle}
      ${dateToggle}
      ${table}
      ${timeHtml}
      ${
        plotted.length
          ? `<div class="row" style="margin-top:8px;">
              <button type="button" class="btn btn-sm ${state.psdXAxis === 'mm' ? 'active' : ''}" data-psd-x="mm">${unit} (log)</button>
              ${unit === 'mm' ? `<button type="button" class="btn btn-sm ${state.psdXAxis === 'phi' ? 'active' : ''}" data-psd-x="phi">phi (φ)</button>` : ''}
              <button type="button" class="btn btn-sm" data-action="export-comparison" style="margin-left:auto;">Download comparison CSV</button>
            </div>
            ${chartBox('compare-psd', 'Cumulative grain-size distributions by site', (light) => renderComparePsdSvg(psdSeries, unit, state.psdXAxis, light), lightTheme)}
            ${unit === 'mm' ? `<div class="row" style="margin-top:8px;">
              <button type="button" class="btn btn-sm ${step === 0.5 ? 'active' : ''}" data-phi-step="0.5">Narrow classes (0.5 φ)</button>
              <button type="button" class="btn btn-sm ${step === 1 ? 'active' : ''}" data-phi-step="1.0">Wide classes (1 φ)</button>
            </div>
            ${chartBox('compare-size', 'Size distributions by site', (light) => renderCompareSizeHistogramSvg(histSeries, light), lightTheme)}` : ''}
            ${pairHtml}`
          : ''
      }
    </div>`;
}
