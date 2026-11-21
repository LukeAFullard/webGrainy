/**
 * One-page printable site report (Export → Printable report): an HTML page laid out for
 * printing or "Save as PDF". Every number carries its exact value and the matching row of the
 * site summary CSV (`data-csv="section/metric"`, `data-value`), so a test can check that the
 * report and the CSV agree.
 */
import type { SiteRecord } from '../modules/projectStorage.js';
import type { SiteAnalysisReport } from '../modules/siteAnalysis.js';
import { adequacyCapNote } from '../modules/siteAdequacy.js';
import { esc } from './panels/html.js';

export interface ReportPhoto {
  label: string;
  /** Small JPEG of the photo (data: URL). */
  imageDataUrl?: string;
  /** Grain outlines over the photo (an SVG document in original photo coordinates). */
  outlineSvg?: string;
  validGrainCount: number;
  D50: number;
  mmPerPx?: number;
  outlierReasons: string[];
}

export interface ReportInput {
  site: SiteRecord;
  report: SiteAnalysisReport;
  /** ISO date-time the report was made. */
  generatedAt: string;
  /** Provenance: app and model versions, etc. (shown in the settings table). */
  metadata: Record<string, unknown>;
  /** Analysis and statistics settings, as label/value pairs. */
  settings: Array<[string, string]>;
  /** Effective minimum resolvable grain diameter (same unit as `report.unit`). */
  detectionLimit?: number;
  /** Number of included photos with manual outline edits in this session. */
  manualEditsCount?: number;
  /** Number of included photos where optional AI pre-processing enhancement was applied. */
  enhancedPhotosCount?: number;
  /** Min/max calibration scale across included photos (mm/px), when calibrated. */
  resolutionRangeMmPerPx?: [number, number];
  psdSvg: string;
  histogramSvg: string | null;
  photos: ReportPhoto[];
}

const fmt = (v: number, digits = 2): string => (Number.isFinite(v) ? v.toFixed(digits) : '–');

/** A number cell tied to its row in the site summary CSV. */
function num(v: number, csv: string, digits = 2): string {
  return `<span data-csv="${esc(csv)}" data-value="${String(v)}">${fmt(v, digits)}</span>`;
}

function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

export function buildSiteReportHtml(input: ReportInput): string {
  const { site, report: r } = input;
  const u = r.unit;
  const ciPct = Math.round(r.bootstrapCi.confidenceLevel * 100);
  const pctRow = (key: 'D16' | 'D50' | 'D84'): string => `
    <tr><th>${key}</th><td>${num(r.psd[key], `psd/${key}`)} ${u}</td>
      <td>${num(r.bootstrapCi.lower[key], `psd_bootstrap_ci_lo/${key}`)} – ${num(r.bootstrapCi.upper[key], `psd_bootstrap_ci_hi/${key}`)} ${u}</td></tr>`;
  const x = r.extra && r.extra.n > 0 ? r.extra : null;
  const fw = r.folkWard;
  const w = r.wentworth;
  const dateOnly = input.generatedAt.slice(0, 10);
  const resText = input.resolutionRangeMmPerPx
    ? Math.abs(input.resolutionRangeMmPerPx[1] - input.resolutionRangeMmPerPx[0]) < 1e-4
      ? `${input.resolutionRangeMmPerPx[0].toFixed(3)} mm/px`
      : `${input.resolutionRangeMmPerPx[0].toFixed(3)}–${input.resolutionRangeMmPerPx[1].toFixed(3)} mm/px`
    : undefined;
  const detText =
    input.detectionLimit !== undefined && Number.isFinite(input.detectionLimit) && input.detectionLimit > 0
      ? `~${input.detectionLimit.toFixed(u === 'mm' ? 1 : 0)} ${u}`
      : undefined;
  const editText =
    input.manualEditsCount !== undefined
      ? input.manualEditsCount > 0
        ? `Manual outline edits applied (${input.manualEditsCount} photo${input.manualEditsCount === 1 ? '' : 's'})`
        : 'Automated outlines (no manual edits)'
      : undefined;
  const enhText =
    input.enhancedPhotosCount !== undefined && input.enhancedPhotosCount > 0
      ? `Optional AI pre-processing enhancement applied to ${input.enhancedPhotosCount} photo${input.enhancedPhotosCount === 1 ? '' : 's'} prior to segmentation`
      : undefined;
  const modelName = input.metadata['modelId'] ? String(input.metadata['modelId']) : 'ImageGrains 2.0 ONNX';
  const modelHash = input.metadata['modelSha256'] ? String(input.metadata['modelSha256']).slice(0, 12) : undefined;
  const methodsSentence = [
    `Surface grain sizes for ${site.name} (${r.includedPhotoCount} photo${r.includedPhotoCount === 1 ? '' : 's'}, n = ${r.validGrainCount} grains) were measured in webGrainy using ${modelName}${modelHash ? ` (SHA-256 ${modelHash}…)` : ''}.`,
    `Sizes report the 2D visible ${r.sizeMetric} (${r.statisticalBasisLabel})${resText ? ` at ${resText}` : ''}${detText ? `; grains smaller than ${detText} (the detection limit) are not counted, and grains up to a few times that size are partly missed` : ''}.`,
    editText ? `${editText}.` : '',
    enhText ? `${enhText}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(site.name)} — grain-size report</title>
<style>
  @page { size: A4; margin: 14mm; }
  :root { color-scheme: light; }
  body { font: 10.5pt/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a202c; background: #fff; margin: 0 auto; max-width: 182mm; padding: 12px; }
  h1 { font-size: 17pt; margin: 0 0 2px; }
  h2 { font-size: 11.5pt; margin: 14px 0 6px; border-bottom: 1px solid #cbd5e0; padding-bottom: 2px; }
  .sub { color: #4a5568; margin: 0 0 8px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
  .chart svg, .chart img { width: 100%; height: auto; display: block; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; }
  th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { font-weight: 600; white-space: nowrap; }
  .photos { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .kv { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 1px 10px; font-size: 8.5pt; }
  .kv dt { font-weight: 600; } .kv dd { margin: 0; overflow-wrap: anywhere; }
  .methods-box { margin-top: 8px; padding: 6px 8px; background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 8.5pt; color: #2d3748; }
  .cite { columns: 2; column-gap: 16px; font-size: 7.5pt; color: #4a5568; padding-left: 14px; margin: 0; }
  .cite li { break-inside: avoid; margin-bottom: 2px; }
  .photo { break-inside: avoid; font-size: 7.5pt; line-height: 1.3; }
  .thumb { position: relative; background: #edf2f7; }
  .thumb img { width: 100%; height: auto; display: block; }
  .thumb img.outlines { position: absolute; inset: 0; height: 100%; }
  .warn { color: #9c4221; }
  .small { font-size: 8.5pt; color: #4a5568; }
  .actions { margin: 0 0 10px; }
  .actions button { font: inherit; padding: 4px 10px; }
  section { break-inside: avoid; }
  @media print { .actions { display: none; } body { padding: 0; } }
</style>
</head>
<body>
<div class="actions"><button type="button" data-print="">Print / Save as PDF</button> <span class="small">or press Ctrl+P (⌘P on a Mac)</span></div>
<h1>${esc(site.name)}</h1>
<p class="sub">${site.place ? `${esc(site.place)} · ` : ''}${site.surveyDate ? `Survey ${esc(site.surveyDate)} · ` : ''}Grain-size report · ${esc(dateOnly)} · ${r.includedPhotoCount} photo${r.includedPhotoCount === 1 ? '' : 's'} · ${r.validGrainCount} grains · ${esc(r.statisticalBasisLabel)}</p>

<div class="grid2">
  <div class="chart">${input.psdSvg}</div>
  <div class="chart">${input.histogramSvg ?? '<p class="small">Size classes in mm need a calibrated scale.</p>'}</div>
</div>

<section>
<h2>Key statistics (${esc(u)}, size metric: ${esc(r.sizeMetric)})</h2>
<div class="grid2">
  <table>
    <tr><th></th><th>Value</th><th>${ciPct}% CI (photo bootstrap)${r.ciStatus === 'few-photos' ? ' · approximate: fewer than 5 photos' : r.ciStatus === 'single-photo' ? ' · one photo: grain resampling only' : r.ciStatus === 'degenerate' ? ' · not estimable (identical photos?)' : ''}</th></tr>
    ${pctRow('D16')}${pctRow('D50')}${pctRow('D84')}
  </table>
  <table>
    ${x ? `<tr><th>Geometric mean Dg</th><td>${num(x.geometricMean, 'distribution/geometric_mean_Dg')} ${u}</td></tr>
    <tr><th>Geometric SD σg</th><td>${num(x.geometricSd, 'distribution/geometric_sd_sigma_g')}</td></tr>
    <tr><th>Sauter mean D[3,2]</th><td>${num(x.sauterMeanD32, 'mean_diameters/sauter_mean_D32')} ${u}</td></tr>
    <tr><th>D65</th><td>${num(x.D65, 'distribution/D65')} ${u}</td></tr>
    <tr><th>Uniformity Cu</th><td>${num(x.uniformityCu, 'ratios/uniformity_Cu')}</td></tr>` : ''}
    ${fw ? `<tr><th>Folk &amp; Ward mean</th><td>${num(fw.meanMm, 'folk_ward/mean_mm')} mm (${num(fw.meanPhi, 'folk_ward/mean_phi')} φ)</td></tr>
    <tr><th>Sorting σI</th><td>${num(fw.sortingPhi, 'folk_ward/sorting_phi')} φ — ${esc(fw.sortingLabel)}</td></tr>
    <tr><th>Skewness / kurtosis</th><td>${num(fw.skewnessPhi, 'folk_ward/skewness_phi')} / ${num(fw.kurtosisPhi, 'folk_ward/kurtosis_phi')}</td></tr>` : ''}
  </table>
</div>
${w ? `<p class="small" style="margin-top:6px;">Wentworth classes: sand ${num(w.sandPct, 'wentworth/sand_pct', 1)}% · gravel ${num(w.gravelPct, 'wentworth/gravel_pct', 1)}% · cobble ${num(w.cobblePct, 'wentworth/cobble_pct', 1)}% · boulder ${num(w.boulderPct, 'wentworth/boulder_pct', 1)}%</p>` : ''}
</section>

<section>
<h2>Sample adequacy</h2>
<p><strong>${esc(r.adequacy.rating)}</strong>${r.adequacy.limitedByPhotoCount ? ` (${esc(adequacyCapNote(true, r.includedPhotoCount))})` : ''} — effective grain count ${r.adequacy.effectiveGrainCount}; largest grain ${fmt(r.adequacy.largestClastAreaRatio * 100, 1)}% of the grain area${r.adequacy.largestClastWarning !== 'none' ? ' <span class="warn">(large: one stone has a big effect)</span>' : ''}.
${r.jackknife ? ` Leaving out one photo at a time changes D50 by a standard error of ${fmt(r.jackknife.seD50)} ${u}.` : ''}</p>
${r.adequacy.outlierPhotos.length > 0 ? `<p class="warn">Photos to check: ${r.adequacy.outlierPhotos.map((o) => `${esc(o.label)} (${esc(o.reasons.join('; '))})`).join(' · ')}</p>` : ''}
${r.warnings.length > 0 ? `<ul class="warn small">${r.warnings.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
</section>

<section>
<h2>Photos</h2>
<div class="photos">
${input.photos
  .map(
    (p) => `<div class="photo">
  <div class="thumb">${p.imageDataUrl ? `<img src="${p.imageDataUrl}" alt="">` : ''}${p.outlineSvg ? `<img class="outlines" src="${svgDataUrl(p.outlineSvg.replace(/stroke-width="1"/g, 'stroke-width="1" vector-effect="non-scaling-stroke"'))}" alt="">` : ''}</div>
  <div><strong>${esc(p.label)}</strong></div>
  <div>${p.validGrainCount} grains · D50 ${fmt(p.D50)} ${u}${p.mmPerPx !== undefined ? ` · ${p.mmPerPx.toFixed(3)} mm/px` : ''}</div>
  ${p.outlierReasons.length > 0 ? `<div class="warn">${esc(p.outlierReasons.join('; '))}</div>` : ''}
</div>`,
  )
  .join('\n')}
</div>
</section>

<section>
<h2>Settings and software</h2>
<dl class="kv">
${[
  ...input.settings,
  ...(resText ? ([['Pixel resolution', resText]] as Array<[string, string]>) : []),
  ...(detText ? ([['Detection limit (smallest grain kept)', detText]] as Array<[string, string]>) : []),
  ...(editText ? ([['Outline review', editText]] as Array<[string, string]>) : []),
  ...(enhText ? ([['Pre-processing enhancement', enhText]] as Array<[string, string]>) : []),
  ...(['appVersion', 'appCommit', 'ortVersion', 'modelId', 'modelRevision', 'modelSha256'] as const)
    .filter((k) => input.metadata[k] !== undefined)
    .map((k): [string, string] => [k, String(input.metadata[k])]),
  ['Bootstrap', `${r.bootstrapMode}, ${r.bootstrapReplicates} replicates, seed ${r.bootstrapSeed}`] as [string, string],
  ['Generated', input.generatedAt] as [string, string],
]
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
  .join('\n')}
</dl>
<div class="methods-box"><strong>Methods summary:</strong> ${esc(methodsSentence)} Sizes are 2D surface measurements from photos (${esc(r.sizeMetric)} of each grain's visible outline), not sieve sizes; subsurface fines are not observed.</div>
</section>

<section>
<h2>Please cite</h2>
<ul class="cite">${r.citations.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
</section>
</body>
</html>`;
}
