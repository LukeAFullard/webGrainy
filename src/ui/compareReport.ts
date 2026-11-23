/**
 * Printable comparison report (Results → Compare sites → Printable comparison report): the
 * compared sites side by side, their distributions, pairwise D16 / D50 / D84 tests, change over
 * time when the sites are ordered by survey date, like-for-like checks, methods and references.
 * Shows exactly what the Compare sites view shows (comparisonView.ts), as one printable page.
 */
import type { ComparedSite, D50Comparison } from '../modules/siteComparison.js';
import { adequacyCapNote } from '../modules/siteAdequacy.js';
import { ACCURACY_NOTICE } from '../modules/provenance.js';
import {
  renderCompareAspectRatioSvg,
  renderComparePsdSvg,
  renderCompareSizeHistogramSvg,
  renderCompositionBarsSvg,
  renderFabricRoseSvg,
  renderTimeSeriesSvg,
} from './charts.js';
import { COMPARED_KEYS, fmtPValue, type ComparisonView, type SiteWithReport } from './comparisonView.js';
import { esc } from './panels/html.js';
import { reportDocument } from './report.js';

export interface CompareReportInput {
  view: ComparisonView;
  /** Sites ordered by survey date, with change over time. */
  byDate: boolean;
  psdXAxis: 'mm' | 'phi';
  /** Size classes of the histogram (φ). */
  histogramStepPhi: 0.5 | 1;
  /** ISO date-time the report was made. */
  generatedAt: string;
  /** Site statistics settings shared by every site, as label/value pairs. */
  statistics: Array<[string, string]>;
  /** App provenance (appVersion, appCommit, ortVersion). */
  metadata: Record<string, unknown>;
  /** Include grain shape and fabric (default true). */
  includeShapeFabric?: boolean;
}

/** The shared statistics settings of a comparison, as label/value pairs for the report. */
export function comparisonStatistics(
  o: { sizeMetric?: string; minBaxisPx?: number; minSizeMm?: number; harmonizePhysicalCutoff?: boolean; confidenceLevel?: number; bootstrapReplicates?: number; bootstrapSeed?: number; bootstrapTwoStage?: boolean },
  view: ComparisonView,
  inPixels: boolean,
): Array<[string, string]> {
  const first = view.plotted[0]?.report;
  const out: Array<[string, string]> = [
    ['Pooling', first?.statisticalBasisLabel ?? 'unknown'],
    ['Size metric', o.sizeMetric ?? 'bAxis'],
    ['Smallest grain counted', `${o.minBaxisPx ?? 15} px${(o.minSizeMm ?? 0) > 0 ? ` and ${o.minSizeMm} mm` : ''}${view.commonCutoffMm !== null ? `; ${view.commonCutoffMm.toFixed(2)} mm common cutoff for every site` : ''}`],
    ['Same size range for every site', o.harmonizePhysicalCutoff === false ? 'off' : 'on (largest detection limit of the compared photos)'],
    ['Confidence level', `${Math.round((o.confidenceLevel ?? 0.95) * 100)}%`],
    ['Bootstrap', `${o.bootstrapReplicates ?? 500} replicates, seed ${o.bootstrapSeed ?? 42}${o.bootstrapTwoStage ? ', two-stage' : ''}`],
    ['Compared in', inPixels ? 'pixels (same camera and height assumed)' : view.unit],
  ];
  return out;
}

const COMPARISON_CITATIONS = [
  'Eaton, B. C., Moore, R. D., & MacKenzie, L. G. (2019). Percentile-based grain size distribution analysis tools (GSDtools) - estimating confidence limits and hypothesis tests for comparing two samples. Earth Surface Dynamics, 7, 789-806. https://doi.org/10.5194/esurf-7-789-2019',
  'Holm, S. (1979). A simple sequentially rejective multiple test procedure. Scandinavian Journal of Statistics, 6(2), 65-70.',
  'Welch, B. L. (1947). The generalization of "Student\'s" problem when several different population variances are involved. Biometrika, 34(1-2), 28-35. https://doi.org/10.1093/biomet/34.1-2.28',
];

const v = (n: number | undefined | null, d = 1): string => (n === undefined || n === null || !Number.isFinite(n) ? '–' : n.toFixed(d));

/** Ratio with its interval and p-values, as report HTML. */
function ratioCell(c: D50Comparison | undefined): string {
  if (!c) return '–';
  if (c.basis === 'single-photo') return `${c.ratio.toFixed(2)}× <span class="small">no test (1 photo)</span>`;
  const star = c.pAdjusted < 0.05 ? ' <strong>*</strong>' : '';
  const ci = Number.isFinite(c.ratioLo) ? `<br><span class="small">95% CI ${c.ratioLo.toFixed(2)}–${c.ratioHi.toFixed(2)}</span>` : '';
  const p = `<br><span class="small">p ${esc(fmtPValue(c.p))}${Number.isFinite(c.pAdjusted) && c.pAdjusted !== c.p ? `, Holm ${esc(fmtPValue(c.pAdjusted))}` : ''}${c.basis === 'few-photos' ? ' (few photos)' : ''}</span>`;
  return `<strong>${c.ratio.toFixed(2)}×</strong>${star}${ci}${p}`;
}

const swatch = (color: string): string => `<i class="sw" style="background:${esc(color)}"></i>`;

/** The title of the report: one place over time, or a comparison of sites. */
export function compareReportTitle(view: ComparisonView, byDate: boolean): { kicker: string; title: string } {
  const places = new Set(view.plotted.map((s) => s.place));
  const onePlace = places.size === 1 ? [...places][0] : null;
  if (byDate && onePlace) return { kicker: 'Grain size over time', title: `${onePlace}: ${view.plotted.length} surveys` };
  if (byDate) return { kicker: 'Grain size over time', title: `${view.plotted.length} surveys compared over time` };
  return { kicker: 'Grain-size comparison', title: `Comparison of ${view.plotted.length} site${view.plotted.length === 1 ? '' : 's'}` };
}

export function buildCompareReportHtml(input: CompareReportInput): string {
  const { view, byDate } = input;
  const u = view.unit;
  const showShape = input.includeShapeFabric !== false;
  let secNo = 0;
  const h2 = (title: string): string => `<h2><span class="no">${++secNo}</span>${esc(title)}</h2>`;
  let figNo = 0;
  const fig = (): string => `Figure ${++figNo}.`;
  const { kicker, title } = compareReportTitle(view, byDate);
  const dateOnly = input.generatedAt.slice(0, 10);
  const basis = view.plotted[0]?.report.statisticalBasisLabel ?? '';
  const metric = view.plotted[0]?.report.sizeMetric ?? 'bAxis';
  const nameCell = (s: ComparedSite): string =>
    `<th class="site">${swatch(s.color)}${esc(s.name)}${s.place ? `<br><span class="small">${esc(s.place)}</span>` : ''}</th>`;
  const dateCell = (s: ComparedSite): string => (s.date ? `${esc(s.date)}${s.dateSource === 'photos' ? '<br><span class="small">from photos</span>' : ''}` : '<span class="small">no date</span>');

  // Checks that decide how far the comparison can be trusted.
  const notes: string[] = [];
  for (const m of view.mismatches) notes.push(`<li class="warn"><strong>Not analysed the same way.</strong> ${esc(m)}</li>`);
  for (const w of view.testWarnings) notes.push(`<li>${esc(w)}</li>`);
  for (const s of view.problems) notes.push(`<li><strong>${esc(s.name)}</strong>: ${esc(s.report === null ? s.error ?? 'no results' : 'not calibrated (sizes in px), so it is left out of the charts and tests')}.</li>`);
  if (view.commonCutoffMm !== null) notes.push(`<li>Compared over the same size range: grains of ${view.commonCutoffMm.toFixed(1)} mm and larger in every site (the largest detection limit of the compared photos).</li>`);
  if (view.mixedUnits) notes.push('<li>Some sites are calibrated (mm) and some are not (px): only the calibrated sites are plotted and tested.</li>');

  const summaryTable = `<table class="cmp">
  <thead><tr><th>Site</th><th>Survey date</th><th class="n">Photos / grains</th><th class="n">D16</th><th class="n">D50 (${esc(view.ciHeader)} CI)</th><th class="n">D84</th><th class="n">Dg / σg</th><th class="n">Sauter D[3,2]</th><th class="n">Sorting σI (φ)</th><th class="n">Gravel / cobble %</th></tr></thead>
  <tbody>${view.withReport
    .map((s) => {
      const r = s.report;
      const unitNote = view.mixedUnits ? ` <span class="small">${r.unit}</span>` : '';
      return `<tr>${nameCell(s)}<td class="date">${dateCell(s)}</td><td class="n">${r.includedPhotoCount} / ${r.validGrainCount}</td>
        <td class="n">${v(r.psd.D16)}${unitNote}</td><td class="n"><strong>${v(r.psd.D50)}</strong><br><span class="small nw">${v(r.bootstrapCi.lower.D50)}–${v(r.bootstrapCi.upper.D50)}</span></td><td class="n">${v(r.psd.D84)}</td>
        <td class="n">${v(r.extra?.geometricMean)} / ${v(r.extra?.geometricSd, 2)}</td><td class="n">${v(r.extra?.sauterMeanD32)}</td>
        <td class="n">${v(r.folkWard?.sortingPhi, 2)}</td><td class="n">${r.wentworth ? `${v(r.wentworth.gravelPct, 0)} / ${v(r.wentworth.cobblePct, 0)}` : '–'}</td></tr>`;
    })
    .join('')}</tbody>
</table>
<p class="cap">Sizes in ${esc(u)}${view.mixedUnits ? ' (px where marked)' : ''}; ${esc(metric)} of each grain's visible outline, ${esc(basis)}. Every site uses the same statistics settings (see Methods).</p>`;

  const moreTable = `<table class="cmp">
  <thead><tr><th>Site</th><th class="n">F&amp;W mean / sorting / skew / kurt (φ)</th><th class="n">D50 CI ±%</th><th>Adequacy (n<sub>eff</sub>)</th><th class="n">Size cutoff</th><th class="n">Median b/a</th><th class="n">Fabric: mean° / R / Rayleigh p</th></tr></thead>
  <tbody>${view.withReport
    .map((s) => {
      const r = s.report;
      const fw = r.folkWard;
      const halfPct = r.psd.D50 > 0 ? ((r.bootstrapCi.upper.D50 - r.bootstrapCi.lower.D50) / (2 * r.psd.D50)) * 100 : Number.NaN;
      const f = r.fabricRose;
      return `<tr>${nameCell(s)}
        <td class="n">${fw ? `${v(fw.meanPhi, 2)} / ${v(fw.sortingPhi, 2)} / ${v(fw.skewnessPhi, 2)} / ${v(fw.kurtosisPhi, 2)}` : '–'}</td>
        <td class="n">${v(halfPct, 0)}%</td>
        <td>${esc(r.adequacy.rating)} (${Math.round(r.adequacy.effectiveGrainCount)})${r.adequacy.limitedByPhotoCount ? `<br><span class="small">${esc(adequacyCapNote(true, r.includedPhotoCount))}</span>` : ''}</td>
        <td class="n">${r.dCutoffCommonMm !== null ? `${v(r.dCutoffCommonMm, 1)} mm` : '–'}</td>
        <td class="n">${v(r.shape.medianAspectRatio, 2)}</td>
        <td class="n">${f.grainCount > 0 ? `${v(f.meanAxialDeg, 0)}° / ${v(f.resultantLength, 2)} / ${esc(f.rayleighP === null ? '–' : f.rayleighP < 0.001 ? '< 0.001' : v(f.rayleighP, 3))}` : '–'}</td></tr>`;
    })
    .join('')}</tbody>
</table>
<p class="cap">Folk &amp; Ward graphic statistics in φ; D50 CI ±%: half-width of the interval as a share of D50; adequacy from the effective number of grains. Fabric orientations are relative to each photo's frame (0° = up–down in the photo): compare them only between surveys photographed the same way round.</p>`;

  const psdFig = view.plotted.length
    ? `<figure class="chart">${renderComparePsdSvg(view.psdSeries, u, input.psdXAxis, true)}<figcaption class="cap">${fig()} Cumulative grain-size distributions; shaded bands: each site's ${esc(view.ciHeader)} confidence interval.</figcaption></figure>`
    : '';
  const histFig =
    u === 'mm' && view.histSeries.length
      ? `<figure class="chart">${renderCompareSizeHistogramSvg(view.histSeries, true)}<figcaption class="cap">${fig()} Share of each site in ${input.histogramStepPhi} φ size classes.</figcaption></figure>`
      : '';
  const compFig = view.compSeries.length
    ? `<figure class="chart">${renderCompositionBarsSvg(view.compSeries, true)}<figcaption class="cap">${fig()} Wentworth composition: sand &lt;2 mm, gravel 2–64 mm, cobble 64–256 mm, boulder ≥256 mm.</figcaption></figure>`
    : '';

  // Change over time.
  const timeSection = (): string => {
    if (!byDate) return '';
    const changes = view.changes;
    const changeTable = changes.length
      ? `<table class="cmp">
  <thead><tr><th>Place</th><th>From → to</th>${COMPARED_KEYS.map((k) => `<th class="n">${k}</th>`).join('')}</tr></thead>
  <tbody>${changes
    .map((c) => `<tr><th>${esc(c.place)}</th><td class="date">${esc(c.fromDate)} → ${esc(c.toDate)}<br><span class="small">${esc(c.from)} → ${esc(c.to)}</span></td>${COMPARED_KEYS.map((k) => `<td class="n">${ratioCell(c.changes[k])}</td>`).join('')}</tr>`)
    .join('')}</tbody>
</table>
<p class="cap">Change between consecutive surveys of each place: later ÷ earlier (above 1 = coarser), with a 95% interval and an approximate p-value (Welch t-test on the log ratio; Holm-adjusted over all changes in the table). * marks Holm-adjusted p &lt; 0.05.</p>`
      : '<p class="small">No place has two or more dated surveys measured alike, so no change is listed. Give repeat surveys of one place the same place name to follow it over time.</p>';
    return `<section>
${h2('Change over time')}
${view.timePoints.length ? `<figure class="chart time">${renderTimeSeriesSvg(view.timePoints, u, true)}<figcaption class="cap">${fig()} D16, D50 and D84 of each survey by date, with ${esc(view.ciHeader)} interval bars; surveys of the same place are joined.</figcaption></figure>` : ''}
${changeTable}
${view.ungroupedDated > 1 ? `<p class="small">${view.ungroupedDated} dated surveys have no place, so they are shown as separate points.</p>` : ''}
${view.undated.length ? `<p class="small">No survey date (not plotted): ${view.undated.map((s) => esc(s.name)).join(', ')}.</p>` : ''}
</section>`;
  };

  // Pairwise tests.
  const pairSection = (): string =>
    view.pairs.length
      ? `<section class="flow">
${h2('Differences between sites')}
<table class="cmp">
  <thead><tr><th>Pair (a ÷ b)</th>${COMPARED_KEYS.map((k) => `<th class="n">${k}</th>`).join('')}</tr></thead>
  <tbody>${view.pairs.map((row) => `<tr><th>${esc(row.a)} ÷ ${esc(row.b)}</th>${COMPARED_KEYS.map((k) => `<td class="n">${ratioCell(row.byKey[k])}</td>`).join('')}</tr>`).join('')}</tbody>
</table>
<p class="cap">Ratio of the two sites' percentiles with a 95% interval from each site's uncertainty on a log scale (Welch t-test, allowing for the number of photos). ${view.pairs.length > 1 ? 'With several pairs the p-value is also given adjusted for the number of pairs (Holm), separately for D16, D50 and D84; ' : ''}* marks ${view.pairs.length > 1 ? 'adjusted ' : ''}p &lt; 0.05. A screening check, not a formal two-sample test; not given for one-photo sites, and with fewer than 5 photos per site only large differences show.</p>
</section>`
      : '';

  const shapeSection = (): string => {
    if (!showShape || (view.shapeSeries.length === 0 && view.roses.length === 0)) return '';
    return `<section class="flow">
${h2('Grain shape and fabric')}
${view.shapeSeries.length ? `<figure class="chart half">${renderCompareAspectRatioSvg(view.shapeSeries, true)}<figcaption class="cap">${fig()} Grain shape: b/a ratio of the fitted ellipse (1 = round), by site.</figcaption></figure>` : ''}
${view.roses.length ? `<div class="roses">${view.roses.map((s: SiteWithReport) => `<figure class="chart">${renderFabricRoseSvg(s.report.fabricRose, true)}<figcaption class="cap">${swatch(s.color)}${esc(s.name)}</figcaption></figure>`).join('')}</div>
<p class="cap">${fig()} Fabric (long-axis orientation) roses, relative to each photo's frame.</p>` : ''}
</section>`;
  };

  const citations = [...new Set([...view.plotted.flatMap((s) => s.report.citations), ...COMPARISON_CITATIONS])];
  // Per-site analysis settings (model, image scale, post-processing…) that change results.
  const settingKeys = [...new Set(view.withReport.flatMap((s) => Object.keys(s.analysisSettings)))];
  const analysisTable = settingKeys.length
    ? `<table class="cmp settings">
  <thead><tr><th>Setting</th>${view.withReport.map((s) => `<th>${swatch(s.color)}${esc(s.name)}</th>`).join('')}</tr></thead>
  <tbody>${settingKeys
    .map((k) => {
      const vals = view.withReport.map((s) => s.analysisSettings[k] ?? 'unknown');
      const differ = new Set(vals).size > 1 || vals.some((x) => x.includes(' | '));
      return `<tr${differ ? ' class="differ"' : ''}><th>${esc(k)}</th>${vals.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`;
    })
    .join('')}</tbody>
</table>
<p class="cap">Analysis settings of each site's photos (highlighted: settings that differ, which can change sizes on their own).</p>`
    : '';

  const body = `<header class="doc">
<div class="kicker">${esc(kicker)}</div>
<h1>${esc(title)}</h1>
<p class="sub">${view.withReport.map((s) => `${swatch(s.color)}${esc(s.name)}`).join(' · ')}</p>
<p class="sub">Report ${esc(dateOnly)} · sizes in ${esc(u)} · ${esc(metric)} · ${esc(basis)}</p>
</header>
${notes.length ? `<section><div class="notes"><strong>Read this first</strong><ul>${notes.join('')}</ul></div></section>` : ''}
<section class="flow">
${h2('Summary by site')}
${summaryTable}
</section>
<section class="flow">
${h2('Grain-size distributions')}
<div class="figs">${psdFig}${histFig}</div>
${compFig ? `<div class="comp">${compFig}</div>` : ''}
</section>
${timeSection()}
${pairSection()}
<section class="flow">
${h2('Distribution statistics')}
${moreTable}
</section>
${shapeSection()}
<section class="flow page-break">
${h2('Methods, settings and software')}
<div class="methods-box"><strong>Methods summary:</strong> ${esc(`Surface grain sizes of ${view.plotted.length} site${view.plotted.length === 1 ? '' : 's'} were measured from photos in webGrainy and computed with the same statistics settings (${basis}; size metric ${metric}). Each site's uncertainty comes from resampling its photos (bootstrap, with a leave-one-photo-out check). Sites were compared by the ratio of their D16, D50 and D84 on a log scale, with a Welch t-test allowing for the number of photos, and Holm-adjusted p-values over all pairs (Eaton et al. 2019 describe a full two-sample method).`)} ${esc(ACCURACY_NOTICE)}</div>
<h3 class="small" style="margin:12px 0 4px;font-weight:700;">Statistics settings (every site)</h3>
<dl class="kv">${[
    ...input.statistics,
    ...(['appVersion', 'appCommit', 'ortVersion'] as const).filter((k) => input.metadata[k] !== undefined).map((k): [string, string] => [k, String(input.metadata[k])]),
    ['Generated', input.generatedAt] as [string, string],
  ]
    .map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`)
    .join('\n')}</dl>
<h3 class="small" style="margin:12px 0 4px;font-weight:700;">Analysis settings by site</h3>
${analysisTable}
</section>
<section>
${h2('References (please cite)')}
<ol class="cite">${citations.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
</section>
<footer class="doc">Made with webGrainy${input.metadata['appVersion'] ? ` ${esc(String(input.metadata['appVersion']))}` : ''} on ${esc(dateOnly)}. The numbers are also in the comparison CSV (Compare sites → Download comparison CSV).</footer>
<style>
  .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
  table.cmp { font-size: 8pt; }
  table.cmp th, table.cmp td, table.cmp td.n { white-space: normal; padding: 3px 4px; }
  table.cmp th.site { min-width: 24mm; }
  table.cmp td.date, table.cmp .nw { white-space: nowrap; }
  table.settings td { font-size: 8pt; overflow-wrap: anywhere; }
  tr.differ th, tr.differ td { background: #fffaf0; color: #9c4221; }
  .notes { padding: 8px 10px; border: 1px solid #f6ad55; border-left: 4px solid #dd6b20; background: #fffaf0; border-radius: 4px; font-size: 8.5pt; }
  .notes ul { margin: 4px 0 0; padding-left: 18px; }
  .figs { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
  .comp { max-width: 120mm; margin: 10px auto 0; }
  figure.time { max-width: 150mm; margin: 0 auto 8px; }
  figure.half { max-width: 110mm; margin: 0 auto; }
  .roses { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
  .roses figcaption { text-align: center; }
  @media (max-width: 640px) { .figs { grid-template-columns: 1fr; } .roses { grid-template-columns: 1fr 1fr; } }
</style>`;
  return reportDocument(`${title} — grain-size comparison`, `${title.slice(0, 80)} · grain-size comparison`, body);
}
