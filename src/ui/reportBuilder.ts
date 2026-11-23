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
import { renderPsdChartSvg, renderSizeHistogramSvg } from './charts.js';
import { histogramBasis } from './panels/dashboard.js';
import { photoThumbDataUrl } from './imageCanvas.js';
import { buildSiteReportHtml, type ReportPhoto } from './report.js';
import type { AppState } from './state.js';

/** HTML of the printable report for `site` and its current report. */
export async function buildPrintableReport(st: AppState, site: SiteRecord, report: SiteAnalysisReport): Promise<string> {
  const photos: ReportPhoto[] = [];
  for (const p of report.perPhoto) {
    const rec = st.photos.find((x) => x.photoId === p.photoId);
    const thumb = rec ? await photoThumbDataUrl(rec.imageBlob, 480) : undefined;
    const sess = st.sessions.get(p.photoId);
    photos.push({
      label: p.label,
      ...(thumb ? { imageDataUrl: thumb } : {}),
      ...(sess ? { outlineSvg: sess.exportSvg() } : {}),
      validGrainCount: p.validGrainCount,
      D50: p.D50,
      ...(p.mmPerPx !== undefined ? { mmPerPx: p.mmPerPx } : {}),
      outlierReasons: p.outlierReasons,
    });
  }
  // Provenance from each included photo's own analysis record (models, settings, edits), not
  // from the current settings or the first session in memory.
  const so = st.siteOptions;
  const hist = report.unit === 'mm' ? sizeHistogramFromWentworth(report.wentworthHistogram10Phi, 1) : null;
  const prov = siteReportProvenance(buildSiteInputs(st), report, so);
  const { detectionLimit, resolutionRangeMmPerPx } = prov;
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
      ciLower: report.bootstrapCi.lower,
      ciUpper: report.bootstrapCi.upper,
      perPhotoCurves: report.perPhoto,
      ...(detectionLimit !== undefined ? { detectionLimit } : {}),
      lightTheme: true,
    }),
    histogramSvg: hist && hist.bins.length > 0 ? renderSizeHistogramSvg(hist, true, `Size distribution (${histogramBasis(report.poolingMode)}, 1 φ classes)`) : null,
    photos,
  });
  return html;
}
