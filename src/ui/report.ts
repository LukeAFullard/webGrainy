/**
 * One-page printable site report (Export → Printable report): an HTML page laid out for
 * printing or "Save as PDF". Every number carries its exact value and the matching row of the
 * site summary CSV (`data-csv="section/metric"`, `data-value`), so a test can check that the
 * report and the CSV agree.
 */
import type { SiteRecord } from '../modules/projectStorage.js';
import type { SiteAnalysisReport } from '../modules/siteAnalysis.js';
import { adequacyCapNote } from '../modules/siteAdequacy.js';
import { ACCURACY_NOTICE } from '../modules/provenance.js';
import { esc } from './panels/html.js';

export interface ReportPhoto {
  label: string;
  /** JPEG of the photo (data: URL). */
  imageDataUrl?: string;
  /** Grain outlines over the photo (an SVG document in original photo coordinates). */
  outlineSvg?: string;
  /** Photo size in pixels (for the scale bar). */
  widthPx?: number;
  heightPx?: number;
  /** Grains detected (before size cutoffs and exclusions). */
  rawGrainCount?: number;
  validGrainCount: number;
  D16?: number;
  D50: number;
  D84?: number;
  /** Share of the site statistics from this photo (%). */
  weightPct?: number;
  mmPerPx?: number;
  outlierReasons: string[];
}

/** How grains are drawn over the report's photos. */
export type ReportPhotoOverlay = 'outlines' | 'wentworth' | 'counted' | 'none';

/** Report options (Export → Printable report → Options); remembered in this browser. */
export interface ReportOptions {
  /** Grain overlay on the photos: outlines, Wentworth size colours, counted vs not counted, or none. */
  photoOverlay: ReportPhotoOverlay;
  /** Photos per row (1 = full page width). */
  photosPerRow: 1 | 2;
  /** Include the photos section. */
  includePhotos: boolean;
  /** Include grain shape (b/a) and fabric (orientation rose). */
  includeShapeFabric: boolean;
  /** Include the convergence and leave-one-photo-out charts. */
  includeUncertainty: boolean;
}

export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  photoOverlay: 'outlines',
  photosPerRow: 2,
  includePhotos: true,
  includeShapeFabric: true,
  includeUncertainty: true,
};

const OVERLAYS: readonly ReportPhotoOverlay[] = ['outlines', 'wentworth', 'counted', 'none'];

/** Report options from stored or untrusted values (unknown keys and bad values fall back to the defaults). */
export function sanitizeReportOptions(raw: unknown): ReportOptions {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (k: keyof ReportOptions): boolean => (typeof o[k] === 'boolean' ? (o[k] as boolean) : (DEFAULT_REPORT_OPTIONS[k] as boolean));
  return {
    photoOverlay: OVERLAYS.includes(o['photoOverlay'] as ReportPhotoOverlay) ? (o['photoOverlay'] as ReportPhotoOverlay) : DEFAULT_REPORT_OPTIONS.photoOverlay,
    photosPerRow: o['photosPerRow'] === 1 ? 1 : 2,
    includePhotos: bool('includePhotos'),
    includeShapeFabric: bool('includeShapeFabric'),
    includeUncertainty: bool('includeUncertainty'),
  };
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
  /** Smallest grain counted: the detection limit, or the common / Field-count cutoff when larger. */
  sizeCutoff?: number;
  /** Number of included photos with manual outline edits in this session. */
  manualEditsCount?: number;
  tidiedPhotosCount?: number;
  /** Number of included photos where optional AI pre-processing enhancement was applied. */
  enhancedPhotosCount?: number;
  /** Min/max calibration scale across included photos (mm/px), when calibrated. */
  resolutionRangeMmPerPx?: [number, number];
  psdSvg: string;
  histogramSvg: string | null;
  photos: ReportPhoto[];
  /** Report options (defaults when omitted). */
  options?: ReportOptions;
  /** Legend of the photo overlay (colour swatches), for the Wentworth and counted overlays. */
  overlayLegend?: Array<{ label: string; fill: string; stroke: string }>;
  /** Optional figures (light theme SVG). */
  shapeSvg?: string | null;
  fabricSvg?: string | null;
  convergenceSvg?: string | null;
  jackknifeSvg?: string | null;
}

const fmt = (v: number, digits = 2): string => (Number.isFinite(v) ? v.toFixed(digits) : '–');

/**
 * Makes the Print button work when the report is opened as a file (from the results .zip or a
 * download). In the app's pop-up the app's CSP blocks this inline script and the app binds the
 * button itself; `data-bound` keeps the two from both binding it.
 */
export const PRINT_SCRIPT_SOURCE =
  "(function(){var b=document.querySelector('[data-print]');if(b&&!b.hasAttribute('data-bound')){b.setAttribute('data-bound','');b.addEventListener('click',function(){window.print();});}})();";
export const PRINT_SCRIPT = `<script>${PRINT_SCRIPT_SOURCE}</script>`;
/** CSP hash of PRINT_SCRIPT_SOURCE (checked by a test), the only script the report may run. */
export const PRINT_SCRIPT_SHA256 = 'UQ9mwXc+eDEpUBj4UsroUwQ64OVmwr+EOGFiiXlQLiU=';

/**
 * The report's own Content-Security-Policy, so a report opened as a file (from the results .zip
 * or a download) can load nothing from the network and run nothing but the Print button script,
 * whatever text an imported project put into it.
 */
export const REPORT_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'sha256-${PRINT_SCRIPT_SHA256}'; base-uri 'none'; form-action 'none'`;

/** A number cell tied to its row in the site summary CSV. */
function num(v: number, csv: string, digits = 2): string {
  return `<span data-csv="${esc(csv)}" data-value="${Number.isFinite(v) ? String(v) : ''}">${fmt(v, digits)}</span>`;
}

function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

/** A "nice" scale-bar length (1, 2 or 5 x 10^k mm) of about a fifth of the photo width. */
function scaleBarMm(photoWidthMm: number): number {
  const target = photoWidthMm / 5;
  const p = 10 ** Math.floor(Math.log10(target));
  return [5, 2, 1].map((m) => m * p).find((v) => v <= target) ?? p;
}

const histogramBasisText = (mode: string): string =>
  mode === 'number-weighted' ? '% by grain count' : mode === 'virtual-wolman-grid' ? '% of grid points' : 'area-weighted %';

const fmtLen = (mm: number): string => (mm >= 1000 ? `${mm / 1000} m` : mm >= 10 ? `${mm / 10} cm` : `${mm} mm`);

/**
 * The printable page around a report body: A4 page set-up with a running footer (`footerText`)
 * and page numbers, the shared styles, and the Print button.
 */
export function reportDocument(title: string, footerText: string, body: string): string {
  // Plain text for the CSS page footer (<style> is raw text: no entities, and no "<" so it cannot
  // close the tag). Every control character goes: CSS turns a form feed into a newline, which
  // would end the string and let the rest of the text be read as CSS rules.
  const footerCss = footerText.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\\"'<>]/g, ' ').slice(0, 100);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm;
    @bottom-left { content: "${footerCss}"; font: 7.5pt system-ui, sans-serif; color: #718096; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt system-ui, sans-serif; color: #718096; } }
  :root { color-scheme: light; --ink: #1a202c; --muted: #4a5568; --line: #e2e8f0; --accent: #2b6cb0; --soft: #f7fafc; }
  * { box-sizing: border-box; }
  body { font: 10pt/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; margin: 0 auto; max-width: 182mm; padding: 14px; }
  header.doc { border-bottom: 3px solid var(--accent); padding-bottom: 8px; margin-bottom: 12px; }
  .kicker { text-transform: uppercase; letter-spacing: .08em; font-size: 8pt; font-weight: 700; color: var(--accent); }
  h1 { font-size: 20pt; line-height: 1.15; margin: 2px 0 4px; }
  .sub { color: var(--muted); margin: 0; font-size: 9.5pt; }
  h2 { font-size: 12pt; margin: 18px 0 8px; padding-bottom: 3px; border-bottom: 1px solid #cbd5e0; color: #1a365d; }
  h2 .no { color: var(--accent); margin-right: 6px; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0 4px; }
  .tile { border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 4px; padding: 6px 9px; background: var(--soft); }
  .tile .tl { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
  .tile .tv { font-size: 16pt; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .tile .ts { font-size: 7.5pt; color: var(--muted); }
  .tile.good { border-left-color: #2f855a; } .tile.warnc { border-left-color: #c05621; } .tile.bad { border-left-color: #c53030; }
  .lede { font-size: 9pt; color: #2d3748; margin: 8px 0 0; }
  figure { margin: 0; }
  .chart svg, .chart img { width: 100%; height: auto; display: block; }
  .fig-table { display: grid; grid-template-columns: 11fr 8fr; gap: 14px; align-items: start; }
  .fig-hist { max-width: 115mm; margin: 6px auto 0; }
  .cap { font-size: 8pt; color: var(--muted); margin: 4px 0 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
  table { border-collapse: collapse; width: 100%; font-size: 9pt; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  thead th { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); border-bottom: 1.5px solid #a0aec0; white-space: normal; vertical-align: bottom; }
  th { font-weight: 600; white-space: nowrap; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.key th, tr.key td { background: #ebf4ff; font-weight: 600; }
  td.lbl { overflow-wrap: anywhere; min-width: 30mm; }
  .perphoto { font-size: 8.5pt; }
  .wbar { display: flex; height: 14px; border-radius: 3px; overflow: hidden; border: 1px solid var(--line); margin-top: 10px; }
  .wbar span { display: block; height: 100%; }
  .wlegend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 8.5pt; margin-top: 4px; }
  .wlegend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  .kv { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 2px 12px; font-size: 8.5pt; margin: 0; }
  .kv dt { font-weight: 600; color: #2d3748; } .kv dd { margin: 0; overflow-wrap: anywhere; }
  .methods-box { margin-top: 10px; padding: 8px 10px; background: var(--soft); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 4px; font-size: 8.5pt; color: #2d3748; }
  .cite { font-size: 8pt; color: var(--muted); padding-left: 16px; margin: 0; }
  .cite li { break-inside: avoid; margin-bottom: 3px; }
  .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
  .photos.single { grid-template-columns: 1fr; }
  .photo { break-inside: avoid; }
  .photo figcaption { font-size: 8pt; line-height: 1.35; margin-top: 4px; color: #2d3748; }
  .thumb { position: relative; background: #edf2f7; border: 1px solid #cbd5e0; }
  .thumb img { width: 100%; height: auto; display: block; }
  .thumb img.outlines { position: absolute; inset: 0; height: 100%; }
  .noimg { padding: 30px; text-align: center; color: var(--muted); font-size: 8pt; }
  .scalebar { position: absolute; left: 3%; bottom: 4%; width: 94%; }
  .sbar { height: 5px; background: #fff; border: 1px solid #000; box-shadow: 0 0 0 1px rgba(255,255,255,.7); }
  .slabel { display: inline-block; margin-top: 2px; font-size: 7.5pt; font-weight: 700; color: #000; background: rgba(255,255,255,.85); padding: 0 3px; border-radius: 2px; }
  .legend-note { font-size: 8pt; color: var(--muted); margin: 0 0 8px; }
  .legend-note i { display: inline-block; width: 14px; height: 9px; background: rgba(56,189,248,.25); border: 1.5px solid #0284c7; vertical-align: -1px; margin-right: 4px; }
  .legend-note .lg { white-space: nowrap; margin-right: 10px; }
  table.compact { width: auto; min-width: 60%; margin-top: 8px; }
  table.compact th { padding-right: 10px; } table.compact td.n { padding-right: 18px; }
  figure.rose { max-width: 80mm; justify-self: center; }
  .warn { color: #9c4221; }
  .small { font-size: 8.5pt; color: var(--muted); }
  .actions { margin: 0 0 12px; padding: 8px 10px; background: var(--soft); border: 1px solid var(--line); border-radius: 4px; }
  .actions button { font: inherit; padding: 4px 12px; }
  section { break-inside: avoid; }
  section.flow { break-inside: auto; }
  .page-break { break-before: page; }
  footer.doc { margin-top: 18px; padding-top: 6px; border-top: 1px solid var(--line); font-size: 7.5pt; color: var(--muted); }
  @media print { .actions { display: none; } body { padding: 0; max-width: none; } h2 { break-after: avoid; } }
  @media (max-width: 640px) { .tiles { grid-template-columns: 1fr 1fr; } .grid2, .photos, .fig-table { grid-template-columns: 1fr; } .kv { grid-template-columns: auto 1fr; } }
</style>
</head>
<body>
<div class="actions"><button type="button" data-print="">Print / Save as PDF</button> <span class="small">or press Ctrl+P (⌘P on a Mac). Tip: turn off the browser's own headers and footers; the report numbers its pages.</span></div>
${PRINT_SCRIPT}
${body}
</body>
</html>`;
}

export function buildSiteReportHtml(input: ReportInput): string {
  const { site, report: r } = input;
  const opts = input.options ?? DEFAULT_REPORT_OPTIONS;
  const u = r.unit;
  // Sections are numbered in order, so optional ones leave no gaps.
  let secNo = 0;
  const h2 = (title: string): string => `<h2><span class="no">${++secNo}</span>${title}</h2>`;
  let figNo = 0;
  const fig = (): string => `Figure ${++figNo}.`;
  const ciPct = Math.round(r.bootstrapCi.confidenceLevel * 100);
  const ciNote =
    r.ciStatus === 'few-photos'
      ? 'approximate: fewer than 5 photos'
      : r.ciStatus === 'single-photo'
        ? 'one photo: grain resampling only'
        : r.ciStatus === 'degenerate'
          ? 'not estimable (identical photos?)'
          : r.ciStatus === 'no-grains'
            ? 'not estimable (no grains counted)'
            : 'photo bootstrap';
  const PCTS = ['D5', 'D10', 'D16', 'D25', 'D50', 'D75', 'D84', 'D90', 'D95'] as const;
  const pctRow = (key: (typeof PCTS)[number]): string => `
    <tr${key === 'D16' || key === 'D50' || key === 'D84' ? ' class="key"' : ''}><th>${key}</th><td class="n">${num(r.psd[key], `psd/${key}`)}</td>
      <td class="n">${num(r.bootstrapCi.lower[key], `psd_bootstrap_ci_lo/${key}`)} – ${num(r.bootstrapCi.upper[key], `psd_bootstrap_ci_hi/${key}`)}</td></tr>`;
  const x = r.extra && r.extra.n > 0 ? r.extra : null;
  const fw = r.folkWard;
  const w = r.wentworth;
  const dateOnly = input.generatedAt.slice(0, 10);
  const resText = input.resolutionRangeMmPerPx
    ? Math.abs(input.resolutionRangeMmPerPx[1] - input.resolutionRangeMmPerPx[0]) < 1e-4
      ? `${input.resolutionRangeMmPerPx[0].toFixed(3)} mm/px`
      : `${input.resolutionRangeMmPerPx[0].toFixed(3)}–${input.resolutionRangeMmPerPx[1].toFixed(3)} mm/px`
    : undefined;
  const lenText = (v: number | undefined): string | undefined =>
    v !== undefined && Number.isFinite(v) && v > 0 ? `~${v.toFixed(u === 'mm' ? 1 : 0)} ${u}` : undefined;
  const detText = lenText(input.detectionLimit);
  // The cutoff actually applied (raised above the detection limit by the Field-count cutoff).
  const cutText = lenText(input.sizeCutoff ?? input.detectionLimit);
  const cutRaised = cutText !== undefined && detText !== undefined && cutText !== detText;
  const editText =
    input.manualEditsCount !== undefined
      ? input.manualEditsCount > 0
        ? `Manual outline edits applied (${input.manualEditsCount} photo${input.manualEditsCount === 1 ? '' : 's'})`
        : 'Automated outlines (no manual edits)'
      : undefined;
  const tidyText =
    input.tidiedPhotosCount !== undefined && input.tidiedPhotosCount > 0
      ? `Tidy outlines applied (${input.tidiedPhotosCount} photo${input.tidiedPhotosCount === 1 ? '' : 's'}): detached grain fragments reassigned or removed, enclosed holes filled`
      : undefined;
  const enhText =
    input.enhancedPhotosCount !== undefined && input.enhancedPhotosCount > 0
      ? `Optional AI pre-processing enhancement applied to ${input.enhancedPhotosCount} photo${input.enhancedPhotosCount === 1 ? '' : 's'} prior to segmentation`
      : undefined;
  const modelName = input.metadata['modelId'] ? String(input.metadata['modelId']) : 'ImageGrains 2.0 ONNX';
  const modelHash = input.metadata['modelSha256'] ? String(input.metadata['modelSha256']).slice(0, 12) : undefined;
  const appVersion = input.metadata['appVersion'] ? String(input.metadata['appVersion']) : '';
  const photosWord = `${r.includedPhotoCount} photo${r.includedPhotoCount === 1 ? '' : 's'}`;
  const methodsSentence = [
    `Surface grain sizes for ${site.name} (${photosWord}, n = ${r.validGrainCount} grains) were measured in webGrainy using ${modelName}${modelHash ? ` (SHA-256 ${modelHash}…)` : ''}.`,
    `Sizes report the 2D visible ${r.sizeMetric} (${r.statisticalBasisLabel})${resText ? ` at ${resText}` : ''}${cutRaised ? `; grains smaller than ${cutText} (the lower size cutoff) are not counted` : detText ? `; grains smaller than ${detText} (the detection limit) are not counted, and grains up to a few times that size are partly missed` : ''}.`,
    editText ? `${editText}.` : '',
    tidyText ? `${tidyText}.` : '',
    enhText ? `${enhText}.` : '',
    ACCURACY_NOTICE,
  ]
    .filter(Boolean)
    .join(' ');
  const adequacyClass = r.adequacy.rating === 'Insufficient' ? 'bad' : r.adequacy.rating === 'Minimal' ? 'warnc' : 'good';
  const tile = (label: string, value: string, sub: string, cls = ''): string =>
    `<div class="tile ${cls}"><div class="tl">${label}</div><div class="tv">${value}</div><div class="ts">${sub}</div></div>`;
  const ciText = (k: 'D16' | 'D50' | 'D84'): string =>
    `${ciPct}% CI ${fmt(r.bootstrapCi.lower[k])}–${fmt(r.bootstrapCi.upper[k])} ${u}`;

  // Wentworth classes as one stacked bar.
  const wentworthBar = w
    ? (() => {
        const classes = [
          { name: 'Sand', pct: w.sandPct, col: '#f6c46b', csv: 'sand_pct' },
          { name: 'Gravel', pct: w.gravelPct, col: '#6fb3f2', csv: 'gravel_pct' },
          { name: 'Cobble', pct: w.cobblePct, col: '#69c995', csv: 'cobble_pct' },
          { name: 'Boulder', pct: w.boulderPct, col: '#e88a7d', csv: 'boulder_pct' },
        ];
        return `<div class="wbar">${classes
          .filter((c) => Number.isFinite(c.pct) && c.pct > 0)
          .map((c) => `<span style="width:${c.pct.toFixed(2)}%;background:${c.col}" title="${c.name}"></span>`)
          .join('')}</div>
  <div class="wlegend">${classes
    .map((c) => `<span><i style="background:${c.col}"></i>${c.name} ${num(c.pct, `wentworth/${c.csv}`, 1)}%</span>`)
    .join('')}</div>
  <p class="cap">Wentworth classes: sand &lt;2 mm, gravel 2–64 mm, cobble 64–256 mm, boulder ≥256 mm (${esc(r.statisticalBasisLabel)}).</p>`;
      })()
    : '';

  const photoRows = input.photos
    .map(
      (p, i) => `<tr><td class="n">${i + 1}</td><td class="lbl">${esc(p.label)}</td><td class="n">${p.mmPerPx !== undefined ? p.mmPerPx.toFixed(3) : '–'}</td>
      <td class="n">${p.validGrainCount}${p.rawGrainCount !== undefined ? ` / ${p.rawGrainCount}` : ''}</td>
      <td class="n">${p.D16 !== undefined ? fmt(p.D16) : '–'}</td><td class="n">${fmt(p.D50)}</td><td class="n">${p.D84 !== undefined ? fmt(p.D84) : '–'}</td>
      <td class="n">${p.weightPct !== undefined && Number.isFinite(p.weightPct) ? fmt(p.weightPct, 1) : '–'}</td>
      <td class="warn">${esc(p.outlierReasons.join('; '))}</td></tr>`,
    )
    .join('');

  const photoFigures = input.photos
    .map((p, i) => {
      const bar =
        p.mmPerPx !== undefined && p.widthPx !== undefined && p.widthPx > 0
          ? (() => {
              const widthMm = p.mmPerPx! * p.widthPx!;
              const len = scaleBarMm(widthMm);
              return `<div class="scalebar"><div class="sbar" style="width:${((len / widthMm) * 100).toFixed(2)}%"></div><div class="slabel">${fmtLen(len)}</div></div>`;
            })()
          : '';
      return `<figure class="photo">
  <div class="thumb">${p.imageDataUrl ? `<img src="${p.imageDataUrl}" alt="">` : '<div class="noimg">photo not available</div>'}${p.outlineSvg && opts.photoOverlay !== 'none' ? `<img class="outlines" src="${svgDataUrl(p.outlineSvg.replace(/stroke-width="1"/g, 'stroke-width="1" vector-effect="non-scaling-stroke"'))}" alt="">` : ''}${bar}</div>
  <figcaption><strong>Photo ${i + 1}. ${esc(p.label)}</strong> — ${p.validGrainCount} grains counted · D50 ${fmt(p.D50)} ${u}${p.mmPerPx !== undefined ? ` · ${p.mmPerPx.toFixed(3)} mm/px` : ''}${p.outlierReasons.length > 0 ? ` · <span class="warn">${esc(p.outlierReasons.join('; '))}</span>` : ''}</figcaption>
</figure>`;
    })
    .join('\n');

  // Photo overlay legend.
  const swatch = (fill: string, stroke: string): string => `<i style="background:${fill};border-color:${stroke}"></i>`;
  const overlayLegendHtml =
    opts.photoOverlay === 'none'
      ? ''
      : input.overlayLegend && input.overlayLegend.length > 0
        ? input.overlayLegend.map((l) => `<span class="lg">${swatch(l.fill, l.stroke)}${esc(l.label)}</span>`).join(' ')
        : `${swatch('rgba(56,189,248,.25)', '#0284c7')}Detected grain outlines`;

  // Grain shape (b/a) and fabric (orientation), with their summary numbers.
  const fr = r.fabricRose;
  const fmtP = (p: number | null): string => (p === null ? '–' : p < 0.001 ? '&lt; 0.001' : p.toFixed(3));
  const shapeFabric = (): string =>
    opts.includeShapeFabric && (input.shapeSvg || input.fabricSvg)
      ? `<section>
${h2('Grain shape and fabric')}
<div class="grid2">
  ${input.shapeSvg ? `<figure class="chart">${input.shapeSvg}<figcaption class="cap">${fig()} Grain shape: b/a ratio of the fitted ellipse (1 = round, low = elongated), every counted grain once.</figcaption></figure>` : '<div></div>'}
  ${input.fabricSvg ? `<figure class="chart rose">${input.fabricSvg}<figcaption class="cap">${fig()} Fabric: long-axis orientation of the grains (axial, 0° = up–down in each photo).</figcaption></figure>` : '<div></div>'}
</div>
<table class="compact">
  <tr><th>Median b/a</th><td class="n">${num(r.shape.medianAspectRatio, 'shape/median_aspect_ratio_b_over_a')}</td><th>Grains</th><td class="n">${r.shape.n}</td></tr>
  ${fr.grainCount > 0 ? `<tr><th>Mean orientation</th><td class="n">${num(fr.meanAxialDeg, 'fabric/mean_axial_orientation_deg', 0)}°</td><th>Alignment R</th><td class="n">${num(fr.resultantLength, 'fabric/resultant_length_R')}</td></tr>
  <tr><th>Rayleigh p</th><td class="n">${fr.rayleighP !== null && fr.rayleighP >= 0.001 ? num(fr.rayleighP, 'fabric/rayleigh_p', 3) : fmtP(fr.rayleighP)}</td><th></th><td class="small">${fr.rayleighP !== null && fr.rayleighP < 0.05 ? 'a preferred direction' : 'no clear preferred direction'} (n = ${fr.grainCount})</td></tr>` : ''}
</table>
<p class="cap">R: 0 = orientations random, 1 = all parallel (axial statistics, Curray 1956; Mardia &amp; Jupp 2000). Orientations are relative to each photo's frame, so they combine meaningfully only when the photos were taken the same way round (e.g. top of the photo upstream).</p>
</section>`
      : '';

  // How stable the site result is: D50 as photos are added, and each photo's influence.
  const uncertainty = (): string =>
    opts.includeUncertainty && (input.convergenceSvg || input.jackknifeSvg)
      ? `<div class="grid2" style="margin-top:8px;">
  ${input.convergenceSvg ? `<figure class="chart">${input.convergenceSvg}<figcaption class="cap">${fig()} D50 as photos are added: a curve that has levelled off means more photos would change little.</figcaption></figure>` : '<div></div>'}
  ${input.jackknifeSvg ? `<figure class="chart">${input.jackknifeSvg}<figcaption class="cap">${fig()} Change in the site D50 when each photo is left out: one long bar means one photo drives the result.</figcaption></figure>` : '<div></div>'}
</div>`
      : '';

  return reportDocument(`${site.name} — grain-size report`, `${site.name.slice(0, 80)} · grain-size report`, `
<header class="doc">
<div class="kicker">Surface grain-size report</div>
<h1>${esc(site.name)}</h1>
<p class="sub">${site.place ? `${esc(site.place)} · ` : ''}${site.surveyDate ? `Survey ${esc(site.surveyDate)} · ` : ''}Report ${esc(dateOnly)} · ${photosWord} · ${r.validGrainCount} grains · ${esc(r.statisticalBasisLabel)}</p>
</header>

<section>
<div class="tiles">
  ${tile('D50 (median)', `${fmt(r.psd.D50, 1)} ${esc(u)}`, ciText('D50'))}
  ${tile('D16', `${fmt(r.psd.D16, 1)} ${esc(u)}`, ciText('D16'))}
  ${tile('D84', `${fmt(r.psd.D84, 1)} ${esc(u)}`, ciText('D84'))}
  ${tile('Grains counted', String(r.validGrainCount), `of ${r.totalGrainCount} detected · effective n ${r.adequacy.effectiveGrainCount}`)}
  ${tile('Photos', String(r.includedPhotoCount), resText ? `scale ${esc(resText)}` : 'uncalibrated (px)')}
  ${tile('Sample adequacy', esc(r.adequacy.rating), r.adequacy.limitedByPhotoCount ? esc(adequacyCapNote(true, r.includedPhotoCount)) : `largest grain ${fmt(r.adequacy.largestClastAreaRatio * 100, 1)}% of the grain area`, adequacyClass)}
</div>
<p class="lede">Size metric: <strong>${esc(r.sizeMetric)}</strong> of each grain's visible outline, in ${esc(u)}${cutText ? `; grains below ${esc(cutText)} are not counted` : ''}. Intervals are ${ciPct}% confidence intervals (${esc(ciNote)}).</p>
</section>

<section>
${h2('Grain-size distribution')}
<div class="fig-table">
  <figure class="chart">${input.psdSvg}
    <figcaption class="cap">${fig()} Cumulative grain-size distribution (${esc(r.statisticalBasisLabel)}). Shaded band: ${ciPct}% confidence interval; grey lines: individual photos; coloured points: D16, D50 and D84.</figcaption>
  </figure>
  <div>
  <table>
    <thead><tr><th>Percentile</th><th class="n">Size (${esc(u)})</th><th class="n">${ciPct}% CI (${esc(u)})</th></tr></thead>
    ${PCTS.map(pctRow).join('')}
  </table>
  <p class="cap">${esc(ciNote === 'photo bootstrap' ? `${ciPct}% CI from resampling photos (${r.bootstrapReplicates} replicates).` : `${ciPct}% CI: ${ciNote}.`)}</p>
  </div>
</div>
</section>

<section>
${input.histogramSvg ? `<figure class="chart fig-hist">${input.histogramSvg}<figcaption class="cap">${fig()} Share of the sample in 1 φ size classes (${esc(histogramBasisText(r.poolingMode))}).</figcaption></figure>` : '<p class="small">Size classes in mm need a calibrated scale.</p>'}
</section>

<section>
${h2('Distribution statistics')}
<div class="grid2">
  <table>
    <thead><tr><th colspan="2">Folk &amp; Ward (graphic)</th></tr></thead>
    ${fw ? `<tr><th>Mean</th><td>${num(fw.meanMm, 'folk_ward/mean_mm')} mm (${num(fw.meanPhi, 'folk_ward/mean_phi')} φ)</td></tr>
    <tr><th>Sorting σI</th><td>${num(fw.sortingPhi, 'folk_ward/sorting_phi')} φ — ${esc(fw.sortingLabel)}</td></tr>
    <tr><th>Skewness</th><td>${num(fw.skewnessPhi, 'folk_ward/skewness_phi')} — ${esc(fw.skewnessLabel)}</td></tr>
    <tr><th>Kurtosis</th><td>${num(fw.kurtosisPhi, 'folk_ward/kurtosis_phi')} — ${esc(fw.kurtosisLabel)}</td></tr>` : '<tr><td colspan="2" class="small">Needs a calibrated scale (mm).</td></tr>'}
  </table>
  <table>
    <thead><tr><th colspan="2">Moments and ratios</th></tr></thead>
    ${x ? `<tr><th>Geometric mean Dg</th><td>${num(x.geometricMean, 'distribution/geometric_mean_Dg')} ${u}</td></tr>
    <tr><th>Geometric SD σg</th><td>${num(x.geometricSd, 'distribution/geometric_sd_sigma_g')}</td></tr>
    <tr><th>Sauter mean D[3,2]</th><td>${num(x.sauterMeanD32, 'mean_diameters/sauter_mean_D32')} ${u}</td></tr>
    <tr><th>D65</th><td>${num(x.D65, 'distribution/D65')} ${u}</td></tr>
    <tr><th>Uniformity Cu</th><td>${num(x.uniformityCu, 'ratios/uniformity_Cu')}</td></tr>` : '<tr><td colspan="2" class="small">Not available.</td></tr>'}
  </table>
</div>
${wentworthBar}
</section>

${shapeFabric()}
<section>
${h2('Sample adequacy and checks')}
<p><strong>${esc(r.adequacy.rating)}</strong>${r.adequacy.limitedByPhotoCount ? ` (${esc(adequacyCapNote(true, r.includedPhotoCount))})` : ''} — effective grain count ${r.adequacy.effectiveGrainCount}; largest grain ${fmt(r.adequacy.largestClastAreaRatio * 100, 1)}% of the grain area${r.adequacy.largestClastWarning !== 'none' ? ' <span class="warn">(large: one stone has a big effect)</span>' : ''}.
${r.jackknife ? ` Leaving out one photo at a time changes D50 by a standard error of ${fmt(r.jackknife.seD50)} ${u}.` : ''}</p>
${r.adequacy.outlierPhotos.length > 0 ? `<p class="warn">Photos to check: ${r.adequacy.outlierPhotos.map((o) => `${esc(o.label)} (${esc(o.reasons.join('; '))})`).join(' · ')}</p>` : ''}
${r.warnings.length > 0 ? `<ul class="warn small">${r.warnings.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '<p class="small">No warnings.</p>'}
${uncertainty()}
</section>

<section class="flow">
${h2('Results by photo')}
<table class="perphoto">
  <thead><tr><th class="n">#</th><th>Photo</th><th class="n">mm/px</th><th class="n">Grains${input.photos.some((p) => p.rawGrainCount !== undefined) ? ' (counted / detected)' : ''}</th><th class="n">D16</th><th class="n">D50</th><th class="n">D84</th><th class="n">Weight %</th><th>Notes</th></tr></thead>
  <tbody>${photoRows}</tbody>
</table>
<p class="cap">Sizes in ${esc(u)}. Weight %: each photo's share of the site statistics (${esc(r.statisticalBasisLabel)}).</p>
</section>

${
  opts.includePhotos
    ? `<section class="flow page-break">
${h2('Photos')}
<p class="legend-note">${overlayLegendHtml}${overlayLegendHtml ? '. ' : ''}${input.photos.some((p) => p.mmPerPx !== undefined && p.widthPx !== undefined) ? 'The bar in the lower left is a scale bar. ' : ''}Photo numbers match the table above.</p>
<div class="photos${input.photos.length === 1 || opts.photosPerRow === 1 ? ' single' : ''}">
${photoFigures}
</div>
</section>`
    : ''
}

<section class="page-break">
${h2('Methods, settings and software')}
<div class="methods-box"><strong>Methods summary:</strong> ${esc(methodsSentence)} Sizes are 2D surface measurements from photos (${esc(r.sizeMetric)} of each grain's visible outline), not sieve sizes; subsurface fines are not observed.</div>
<h3 class="small" style="margin:12px 0 4px;font-weight:700;">Settings and provenance</h3>
<dl class="kv">
${[
  ...input.settings,
  ...(resText ? ([['Pixel resolution', resText]] as Array<[string, string]>) : []),
  ...(detText ? ([['Detection limit (smallest grain resolved)', detText]] as Array<[string, string]>) : []),
  ...(cutRaised ? ([['Smallest grain counted (size cutoff)', cutText]] as Array<[string, string]>) : []),
  ...(editText ? ([['Outline review', editText]] as Array<[string, string]>) : []),
  ...(tidyText ? ([['Outline tidy', tidyText]] as Array<[string, string]>) : []),
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
</section>

<section>
${h2('References (please cite)')}
<ol class="cite">${r.citations.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
</section>

<footer class="doc">Made with webGrainy${appVersion ? ` ${esc(appVersion)}` : ''} on ${esc(dateOnly)}. Every number in this report is also in the site summary CSV and JSON exports.</footer>`);
}
