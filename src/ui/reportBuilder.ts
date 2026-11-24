/**
 * The printable site report: photo thumbnails and outlines, charts, and provenance taken from
 * each included photo's own analysis record (siteReportProvenance), assembled into the HTML of
 * report.ts.
 */
import { baseExportMetadata } from '../modules/provenance.js';
import { sizeHistogramFromWentworth } from '../modules/histograms.js';
import { siteReportProvenance } from '../modules/siteProvenance.js';
import { buildSiteInputs } from '../modules/siteWorkspace.js';
import type { SiteRecord } from '../modules/projectStorage.js';
import type { SiteAnalysisReport } from '../modules/siteAnalysis.js';
import { photoCutoffs } from '../modules/siteWorkspace.js';
import { WENTWORTH_DISPLAY_CLASSES, grainSizeMm, wentworthClassIndex } from '../modules/wentworthColors.js';
import type { GrainSvgStyle } from '../modules/exportFormats.js';
import type { AnalysisSession } from '../modules/analysisSession.js';
import type { GrainMorphometrics, SizeMetric } from '../types/index.js';
import {
  renderAspectRatioHistogramSvg,
  renderConvergenceChartSvg,
  renderFabricRoseSvg,
  renderJackknifeChartSvg,
  renderPsdChartSvg,
  renderSizeHistogramSvg,
} from './charts.js';
import { histogramBasis } from './panels/dashboard.js';
import { photoThumbDataUrl } from './imageCanvas.js';
import { buildSiteReportHtml, DEFAULT_REPORT_OPTIONS, type ReportOptions, type ReportPhoto } from './report.js';
import type { AppState } from './state.js';

const rgba = (rgb: readonly number[], a: number): string => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
const COUNTED_STYLE: GrainSvgStyle = { fill: 'rgba(56, 189, 248, 0.28)', stroke: '#0369a1' };
const NOT_COUNTED_STYLE: GrainSvgStyle = { fill: 'rgba(148, 163, 184, 0.15)', stroke: '#e53e3e' };

/** Legend entries of a report photo overlay (Wentworth classes present, or counted / not counted). */
export function overlayLegend(
  mode: ReportOptions['photoOverlay'],
  classesPresent: ReadonlySet<number>,
): Array<{ label: string; fill: string; stroke: string }> {
  if (mode === 'wentworth') {
    return WENTWORTH_DISPLAY_CLASSES.map((c, i) => ({ c, i }))
      .filter(({ i }) => classesPresent.has(i))
      .map(({ c }) => ({ label: c.label, fill: rgba(c.rgb, 0.5), stroke: rgba(c.rgb, 1) }));
  }
  if (mode === 'counted') {
    return [
      { label: 'Counted in the statistics', ...COUNTED_STYLE },
      { label: 'Not counted (edge, outside the ROI or below the size cutoff)', ...NOT_COUNTED_STYLE },
    ];
  }
  return [];
}

/**
 * Overlay of one photo for the report: outlines, Wentworth size colours (the same colours as
 * Display → Size colours) or counted vs not counted grains. Records the Wentworth classes drawn.
 */
export function reportOverlaySvg(
  sess: AnalysisSession,
  mode: ReportOptions['photoOverlay'],
  sizeMetric: SizeMetric,
  counted: ReadonlySet<number>,
  classesSeen: Set<number>,
): string {
  if (mode === 'wentworth') {
    // The SVG is traced from the analysis-resolution grains; their sizes in mm are on the
    // calibrated grains of the same id.
    if (sizeMetric === 'minFeret') sess.ensureFeret();
    const sized = new Map(sess.getResult().grains.map((g) => [g.id, g]));
    return sess.exportSvg(undefined, undefined, (traced: GrainMorphometrics) => {
      const g = sized.get(traced.id) ?? traced;
      const mm = grainSizeMm(g, sizeMetric);
      if (mm === undefined) return { fill: 'rgba(160, 174, 192, 0.2)', stroke: '#718096' };
      const i = wentworthClassIndex(mm);
      classesSeen.add(i);
      const c = WENTWORTH_DISPLAY_CLASSES[i]!.rgb;
      // Grains not in the statistics are drawn faintly, so the colours show what was counted.
      return counted.has(g.id) ? { fill: rgba(c, 0.5), stroke: rgba(c, 1) } : { fill: rgba(c, 0.12), stroke: rgba(c, 0.55) };
    });
  }
  if (mode === 'counted') return sess.exportSvg(undefined, undefined, (g) => (counted.has(g.id) ? COUNTED_STYLE : NOT_COUNTED_STYLE));
  return sess.exportSvg();
}

/** HTML of the printable report for `site` and its current report. */
export async function buildPrintableReport(
  st: AppState,
  site: SiteRecord,
  report: SiteAnalysisReport,
  options: ReportOptions = st.reportOptions ?? DEFAULT_REPORT_OPTIONS,
): Promise<string> {
  const photos: ReportPhoto[] = [];
  const metric = st.siteOptions.sizeMetric ?? 'bAxis';
  // Size colours need mm; an uncalibrated site falls back to outlines.
  const mode = options.photoOverlay === 'wentworth' && report.unit !== 'mm' ? 'outlines' : options.photoOverlay;
  const classesSeen = new Set<number>();
  for (const p of report.perPhoto) {
    const rec = st.photos.find((x) => x.photoId === p.photoId);
    // Large enough for a two-column A4 page at print resolution (about 88 mm wide at 300+ dpi);
    // one photo per row gets twice the pixels.
    const thumb = rec && options.includePhotos ? await photoThumbDataUrl(rec.imageBlob, options.photosPerRow === 1 ? 2400 : 1400) : undefined;
    const sess = st.sessions.get(p.photoId);
    const counted = sess && (mode === 'wentworth' || mode === 'counted') ? sess.countedGrainIds(metric, photoCutoffs(st.siteOptions, report, p.photoId)) : new Set<number>();
    const overlay = sess && options.includePhotos && mode !== 'none' ? reportOverlaySvg(sess, mode, metric, counted, classesSeen) : undefined;
    photos.push({
      label: p.label,
      ...(thumb ? { imageDataUrl: thumb } : {}),
      ...(sess ? { widthPx: sess.workingImage.originalWidth, heightPx: sess.workingImage.originalHeight } : {}),
      ...(overlay ? { outlineSvg: overlay } : {}),
      rawGrainCount: p.rawGrainCount,
      validGrainCount: p.validGrainCount,
      D16: p.D16,
      D50: p.D50,
      D84: p.D84,
      weightPct: p.weightContributionPct,
      ...(p.mmPerPx !== undefined ? { mmPerPx: p.mmPerPx } : {}),
      outlierReasons: p.outlierReasons,
    });
  }
  // Provenance from each included photo's own analysis record (models, settings, edits), not
  // from the current settings or the first session in memory.
  const so = st.siteOptions;
  const hist = report.unit === 'mm' ? sizeHistogramFromWentworth(report.wentworthHistogram10Phi, 1) : null;
  const prov = siteReportProvenance(buildSiteInputs(st), report, so);
  const { detectionLimit, sizeCutoff, resolutionRangeMmPerPx } = prov;
  const singleModel = prov.models.length === 1 ? prov.models[0]! : null;

  const html = buildSiteReportHtml({
    site,
    report,
    generatedAt: new Date().toISOString(),
    metadata: {
      ...baseExportMetadata(),
      modelId: prov.models.map((m) => m.modelId).join(' + '),
      ...(singleModel?.modelSha256 ? { modelSha256: singleModel.modelSha256 } : {}),
    },
    settings: prov.settings,
    ...(detectionLimit !== undefined ? { detectionLimit } : {}),
    ...(sizeCutoff !== undefined ? { sizeCutoff } : {}),
    manualEditsCount: prov.manualEditsCount,
    tidiedPhotosCount: prov.tidiedPhotosCount,
    ...(prov.enhancedPhotosCount > 0 ? { enhancedPhotosCount: prov.enhancedPhotosCount } : {}),
    ...(resolutionRangeMmPerPx ? { resolutionRangeMmPerPx } : {}),
    psdSvg: renderPsdChartSvg({
      psd: report.psd,
      unit: report.unit,
      xAxis: st.psdXAxis,
      title: 'Cumulative grain-size distribution',
      subtitle: `${report.includedPhotoCount} photos, n=${report.validGrainCount}`,
      ciLevel: report.bootstrapCi.confidenceLevel,
      ciLower: report.bootstrapCi.lower,
      ciUpper: report.bootstrapCi.upper,
      perPhotoCurves: report.perPhoto,
      // The line marks the smallest grain counted (the Field-count cutoff when it is larger).
      ...(sizeCutoff !== undefined ? { detectionLimit: sizeCutoff } : {}),
      lightTheme: true,
    }),
    histogramSvg: hist && hist.bins.length > 0 ? renderSizeHistogramSvg(hist, true, `Size distribution (${histogramBasis(report.poolingMode)}, 1 φ classes)`) : null,
    photos,
    options: { ...options, photoOverlay: mode },
    overlayLegend: overlayLegend(mode, classesSeen),
    shapeSvg: options.includeShapeFabric && report.shape.n > 0 ? renderAspectRatioHistogramSvg(report.shape.aspectRatioCounts, true) : null,
    fabricSvg: options.includeShapeFabric && report.fabricRose.grainCount > 0 ? renderFabricRoseSvg(report.fabricRose, true) : null,
    convergenceSvg: options.includeUncertainty && report.convergence.length > 1 ? renderConvergenceChartSvg(report.convergence, true, report.bootstrapCi.confidenceLevel) : null,
    jackknifeSvg: options.includeUncertainty && report.jackknife ? renderJackknifeChartSvg(report.jackknife, true) : null,
  });
  return html;
}
