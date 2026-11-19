/**
 * Compare sites view: picker grouped by place; statistics side by side; PSD, size, composition,
 * shape and fabric charts; D16/D50/D84 tests between sites; change over time per place; and
 * like-for-like checks (analysis settings, common size range).
 */
import { comparePercentile, settingsMismatches, surveyChanges, type ComparedPercentile, type D50Comparison } from '../../modules/siteComparison.js';
import { groupSitesByPlace } from '../../modules/sitePlaces.js';
import { sizeHistogramFromWentworth } from '../../modules/histograms.js';
import {
  renderCompareAspectRatioSvg,
  renderComparePsdSvg,
  renderCompareSizeHistogramSvg,
  renderCompositionBarsSvg,
  renderFabricRoseSvg,
  renderTimeSeriesSvg,
  type TimeSeriesPoint,
} from '../charts.js';
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
  const byIdSite = new Map(state.sites.map((s) => [s.siteId, s]));
  // Picker: surveys grouped by place (oldest first), each place with a one-click "only these".
  const picker = groupSitesByPlace(state.sites)
    .map((g) => {
      const boxes = g.surveys
        .map((sv) => {
          const s = byIdSite.get(sv.siteId)!;
          return `<label class="checkbox-label compare-site">
            <input type="checkbox" data-compare-site="${esc(s.siteId)}" ${chosen.has(s.siteId) ? 'checked' : ''} />
            <span class="swatch" style="background:${colorOf.get(s.siteId) ?? 'transparent'}"></span>${esc(s.name)} <span class="summary-note">(${sv.date ? `${esc(sv.date)}, ` : ''}${s.photoOrder.length} photos)</span>
          </label>`;
        })
        .join('');
      if (g.place === null) return boxes;
      return `<div class="compare-place"><div class="row-between"><strong>${esc(g.place)}</strong>${
        g.surveys.length > 1
          ? `<button type="button" class="btn btn-xs" data-action="compare-select-place" data-place="${esc(g.place)}" title="Compare only the surveys of ${esc(g.place)}, over time">Only this place, over time</button>`
          : ''
      }</div>${boxes}</div>`;
    })
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
  const nameCell = (s: ComparedSite): string =>
    `<th scope="row"><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}${s.place ? `<span class="stats-note">${esc(s.place)}</span>` : ''}</th>`;
  const table = withReport.length
    ? `<div class="table-scroll"><table class="stats-table compare-table">
        <thead><tr><th>Site</th><th>Survey date</th><th>Photos / grains</th><th>D16</th><th>D50 (95% CI)</th><th>D84</th><th>Dg / σg</th><th>Sauter</th><th>Sorting φ</th><th>Gravel / cobble %</th></tr></thead>
        <tbody>${withReport
          .map((s) => {
            const r = s.report!;
            return `<tr>${nameCell(s)}
              <td>${dateCell(s)}</td><td>${r.includedPhotoCount} / ${r.validGrainCount}</td><td>${v(r.psd.D16)}${mixedUnits ? ` <span class="stats-note">${r.unit}</span>` : ''}</td>
              <td>${v(r.psd.D50)} (${v(r.bootstrapCi.lower.D50)}–${v(r.bootstrapCi.upper.D50)})</td><td>${v(r.psd.D84)}</td>
              <td>${v(r.extra?.geometricMean)} / ${v(r.extra?.geometricSd, 2)}</td><td>${v(r.extra?.sauterMeanD32)}</td>
              <td>${v(r.folkWard?.sortingPhi, 2)}</td><td>${r.wentworth ? `${v(r.wentworth.gravelPct, 0)} / ${v(r.wentworth.cobblePct, 0)}` : '—'}</td></tr>`;
          })
          .join('')}</tbody></table></div>
        <p class="field-hint">${mixedUnits ? 'Sizes in mm, or in px where marked (px sites are left out of the charts and tests).' : `Sizes in ${unit}.`} All sites use the same statistics settings (${esc(state.siteOptions.poolingMode)}, ${esc(state.siteOptions.sizeMetric ?? 'bAxis')}).</p>`
    : '';
  // Everything else the single-site view reports, side by side.
  const moreTable = withReport.length
    ? `<details class="advanced-block" data-keep-open="compare-more" style="margin-top:6px;">
        <summary>More statistics <span class="summary-note">Folk &amp; Ward, adequacy, shape, fabric</span></summary>
        <div class="table-scroll"><table class="stats-table compare-table">
          <thead><tr><th>Site</th><th>F&amp;W mean / sorting / skew / kurt (φ)</th><th>D50 CI ±%</th><th>Adequacy (n<sub>eff</sub>)</th><th>Size cutoff</th><th>Median b/a</th><th>Fabric: mean ° / R / Rayleigh p</th></tr></thead>
          <tbody>${withReport
            .map((s) => {
              const r = s.report!;
              const fw = r.folkWard;
              const halfPct = r.psd.D50 > 0 ? ((r.bootstrapCi.upper.D50 - r.bootstrapCi.lower.D50) / (2 * r.psd.D50)) * 100 : Number.NaN;
              const f = r.fabricRose;
              return `<tr>${nameCell(s)}
                <td>${fw ? `${v(fw.meanPhi, 2)} / ${v(fw.sortingPhi, 2)} / ${v(fw.skewnessPhi, 2)} / ${v(fw.kurtosisPhi, 2)}` : '—'}</td>
                <td>${v(halfPct, 0)}%</td>
                <td>${esc(r.adequacy.rating)} (${Math.round(r.adequacy.effectiveGrainCount)})</td>
                <td>${r.dCutoffCommonMm !== null ? `${v(r.dCutoffCommonMm, 1)} mm` : '—'}</td>
                <td>${v(r.shape.medianAspectRatio, 2)}</td>
                <td>${f.grainCount > 0 ? `${v(f.meanAxialDeg, 0)}° / ${v(f.resultantLength, 2)} / ${f.rayleighP === null ? '—' : f.rayleighP < 0.001 ? '&lt;0.001' : v(f.rayleighP, 3)}` : '—'}</td></tr>`;
            })
            .join('')}</tbody></table></div>
        <p class="field-hint">Fabric orientations are relative to each photo's frame (0° = up–down in the photo): compare them only between surveys photographed the same way round.</p>
      </details>`
    : '';
  // Pairwise tests for D16, D50 and D84.
  const keys: ComparedPercentile[] = ['D16', 'D50', 'D84'];
  const pairsByKey = keys.map((k) => ({ k, pairs: comparePercentile(plotted, k) }));
  const nPairs = pairsByKey[1]!.pairs.length;
  const fmtRatio = (c: D50Comparison): string =>
    `${c.ratio.toFixed(2)}× <span class="stats-note">${c.ratioLo.toFixed(2)}–${c.ratioHi.toFixed(2)}, p ${!Number.isFinite(c.p) ? '—' : c.p < 0.001 ? '&lt; 0.001' : `= ${c.p.toFixed(3)}`}${c.p < 0.05 ? ' *' : ''}</span>`;
  const pairHtml = nPairs
    ? `<details class="advanced-block" data-keep-open="compare-pairs" open>
        <summary>Differences between sites <span class="summary-note">D16, D50, D84 ratios · approximate</span></summary>
        <div class="table-scroll"><table class="stats-table"><thead><tr><th>Pair</th>${keys.map((k) => `<th>${k}</th>`).join('')}</tr></thead><tbody>${pairsByKey[1]!.pairs
          .map((c, i) => `<tr><th scope="row">${esc(c.a)} ÷ ${esc(c.b)}</th>${pairsByKey.map(({ pairs }) => `<td>${pairs[i] ? fmtRatio(pairs[i]!) : '—'}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>
        <p class="field-hint">Ratio with a 95% interval from each site's bootstrap interval on a log scale (z-test); * p &lt; 0.05. A screening check, not a formal two-sample test, and with many pairs some will be "significant" by chance. ${helpButton('compareSites')}</p>
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
  // Like-for-like checks: analysis settings and the common size range.
  const mismatches = settingsMismatches(plotted);
  const mismatchHtml = mismatches.length
    ? `<div class="warning-banner" role="alert"><strong>Not analysed the same way.</strong><br/>${mismatches.map(esc).join('<br/>')}</div>`
    : '';
  const cutoffs = new Set(plotted.map((s) => s.report!.dCutoffCommonMm).filter((c): c is number => c !== null && c > 0).map((c) => c.toFixed(3)));
  const cutoffHtml =
    unit === 'mm' && plotted.length > 1 && cutoffs.size === 1
      ? `<div class="basis-banner">Compared over the same size range: grains of ${Number([...cutoffs][0]).toFixed(1)} mm and larger in every site (the largest detection limit of the compared photos). ${helpButton('harmonizePhysicalCutoff')}</div>`
      : '';
  const anyUncalibrated = (cmp?.sites ?? []).some((s) => (s.error ?? '').includes('No scale yet') || s.report?.unit === 'px');
  const pixelsToggle =
    anyUncalibrated || state.compareInPixels
      ? `<label class="checkbox-label" style="margin-top:6px;">
          <input type="checkbox" data-action="toggle-compare-px" ${state.compareInPixels ? 'checked' : ''} />
          Compare in pixels instead of mm <span class="summary-note">only meaningful if all photos were taken with the same camera at the same height</span>
        </label>`
      : '';
  // Over time: one line per place; surveys without a place stand alone.
  const timeOrder = orderByDate(plotted);
  const placeColor = new Map<string, string>();
  for (const s of timeOrder.dated) if (s.place && !placeColor.has(s.place)) placeColor.set(s.place, s.color);
  const timePoints: TimeSeriesPoint[] = timeOrder.dated.map((s) => {
    const r = s.report!;
    const ci = (k: 'D16' | 'D50' | 'D84'): [number, number] => [r.bootstrapCi.lower[k], r.bootstrapCi.upper[k]];
    return {
      date: s.date!, name: s.name, color: s.color, D16: r.psd.D16, D50: r.psd.D50, D84: r.psd.D84,
      ci: { D16: ci('D16'), D50: ci('D50'), D84: ci('D84') },
      ...(s.place ? { group: s.place, groupColor: placeColor.get(s.place)! } : {}),
    };
  });
  const changes = surveyChanges(plotted);
  const changeHtml = changes.length
    ? `<div class="table-scroll"><table class="stats-table compare-table" style="margin-top:6px;"><caption class="field-hint" style="caption-side:top;text-align:left;">Change between consecutive surveys of each place (later ÷ earlier; above 1 = coarser)</caption>
        <thead><tr><th>Place</th><th>From → to</th>${keys.map((k) => `<th>${k}</th>`).join('')}</tr></thead>
        <tbody>${changes
          .map((c) => `<tr><th scope="row">${esc(c.place)}</th><td>${esc(c.fromDate)} → ${esc(c.toDate)}<span class="stats-note">${esc(c.from)} → ${esc(c.to)}</span></td>${keys.map((k) => `<td>${fmtRatio(c.changes[k])}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
    : '';
  const dateToggle =
    plotted.length > 0
      ? `<label class="checkbox-label" style="margin-top:6px;">
          <input type="checkbox" data-action="toggle-compare-date" ${byDate ? 'checked' : ''} />
          Order by survey date and show change over time ${helpButton('surveyDate')}
        </label>`
      : '';
  const ungroupedDated = timeOrder.dated.filter((s) => !s.place).length;
  const timeHtml = byDate
    ? `${chartBox('compare-time', 'Grain size over time', (light) => renderTimeSeriesSvg(timePoints, unit, light), lightTheme)}
       ${changeHtml}
       ${ungroupedDated > 1 ? `<p class="field-hint">${ungroupedDated} dated surveys have no place, so they are shown as separate points. Give repeat surveys of one place the same place name (Site panel) to join them into a line and list their changes.</p>` : ''}
       ${timeOrder.undated.length > 0 ? `<p class="field-hint">No survey date (not plotted): ${timeOrder.undated.map((s) => esc(s.name)).join(', ')}. Set one in the Site panel, or add photos with a camera date.</p>` : ''}`
    : '';
  const psdSeries = plotted.map((s) => ({ name: s.name, color: s.color, psd: s.report!.psd, ciLower: s.report!.bootstrapCi.lower, ciUpper: s.report!.bootstrapCi.upper }));
  const histSeries = plotted.map((s) => ({
    name: s.name,
    color: s.color,
    hist: sizeHistogramFromWentworth((step === 0.5 ? s.report!.wentworthHistogram05Phi : s.report!.wentworthHistogram10Phi) ?? [], step),
  }));
  const compSeries = plotted.filter((s) => s.report!.wentworth !== null).map((s) => ({ name: s.name, color: s.color, w: s.report!.wentworth! }));
  const shapeSeries = plotted.filter((s) => s.report!.shape.n > 0).map((s) => ({ name: s.name, color: s.color, counts: s.report!.shape.aspectRatioCounts }));
  const roses = plotted.filter((s) => s.report!.fabricRose.grainCount > 0);
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
      ${mismatchHtml}
      ${pixelsToggle}
      ${dateToggle}
      ${cutoffHtml}
      ${table}
      ${moreTable}
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
            ${chartBox('compare-size', 'Size distributions by site', (light) => renderCompareSizeHistogramSvg(histSeries, light), lightTheme)}
            ${compSeries.length ? chartBox('compare-composition', 'Size-class composition by site', (light) => renderCompositionBarsSvg(compSeries, light), lightTheme) : ''}` : ''}
            ${shapeSeries.length ? chartBox('compare-shape', 'Grain shape (aspect ratio) by site', (light) => renderCompareAspectRatioSvg(shapeSeries, light), lightTheme) : ''}
            ${roses.length ? `<details class="advanced-block" data-keep-open="compare-fabric" style="margin-top:8px;">
              <summary>Fabric (grain orientation) by site <span class="summary-note">${roses.length} rose diagram${roses.length === 1 ? '' : 's'}</span></summary>
              <div class="compare-roses">${roses.map((s, i) => chartBox(`compare-rose-${i}`, `Fabric rose: ${s.name}`, (light) => renderFabricRoseSvg(s.report!.fabricRose, light), lightTheme)).join('')}</div>
            </details>` : ''}
            ${pairHtml}`
          : ''
      }
    </div>`;
}
