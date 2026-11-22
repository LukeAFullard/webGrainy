/**
 * Every downloadable export in one place: which file, which contents and metadata, which
 * file name. The UI only asks for an export by kind and saves the result.
 */
import type { SizeMetric } from '../types/index.js';
import type { AnalysisSession } from './pipelineController.js';
import { exportSiteArchive, type PhotoRecord, type SiteRecord } from './projectStorage.js';
import { photoProcessingHistory } from './siteTypes.js';
import { geoJsonToMap, pamAuxXml, photoGeoreference, worldFile } from './georef.js';
import { encodeLabelGeoTiff } from './geotiffWriter.js';
import {
  buildSiteExportMetadata,
  exportSiteGrainsCsv,
  exportSiteSummaryCsv,
  exportSiteSummaryJson,
  type SiteAnalysisOptions,
  type SiteAnalysisReport,
  type SitePhotoInput,
} from './siteAnalysis.js';
import { photoCutoffs } from './siteWorkspace.js';

export const EXPORT_KINDS = [
  'site-summary-csv',
  'site-summary-json',
  'site-grains-csv',
  'site-psd-svg',
  'site-archive',
  'photo-grains-csv',
  'photo-summary-csv',
  'photo-summary-json',
  'photo-mask-16',
  'photo-mask-32',
  'photo-geojson',
  'photo-geojson-map',
  'photo-mask-worldfile',
  'photo-mask-geotiff',
  'photo-mask-auxxml',
  'photo-svg',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(kind: string): kind is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(kind);
}

export interface ExportContext {
  site: SiteRecord | null;
  photo: PhotoRecord | null;
  session: AnalysisSession | null;
  siteReport: SiteAnalysisReport | null;
  siteInputs: SitePhotoInput[];
  psdXAxis: 'mm' | 'phi';
  sizeMetric?: SizeMetric;
  siteOptions?: Partial<SiteAnalysisOptions>;
  /** Printable PSD figure renderer (an SVG string); supplied by the UI's chart code. */
  renderPsdSvg?: (report: SiteAnalysisReport, title: string, xAxis: 'mm' | 'phi') => string;
}

export interface ExportFile {
  blob: Blob;
  filename: string;
}

const safeName = (name: string | undefined, fallback: string): string =>
  (name ?? fallback).replace(/[^a-zA-Z0-9_-]+/g, '_');

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Builds the requested export, or null when its inputs are not available yet. */
export async function buildExport(kind: ExportKind, ctx: ExportContext): Promise<ExportFile | null> {
  const { site, photo, session, siteReport, siteInputs } = ctx;
  const sizeMetric = ctx.sizeMetric ?? 'bAxis';
  const siteFile = safeName(site?.name, 'site');
  const photoFile = safeName(photo?.label, 'photo');
  // Photo-level provenance the analysis session does not hold (image steps before analysis).
  // Photo files use the same cutoffs as the site report (common mm cutoff included), so a photo's
  // own summary and grain table agree with the site's per-photo breakdown.
  const cutoffs = ctx.siteOptions ? photoCutoffs(ctx.siteOptions, siteReport, photo?.photoId ?? null) : undefined;
  const photoMeta: Record<string, unknown> | undefined = photo
    ? {
        photoId: photo.photoId,
        label: photo.label,
        imageWidth: photo.width,
        imageHeight: photo.height,
        imageProcessing: photoProcessingHistory(photo.metadata),
        ...(cutoffs
          ? {
              sizeCutoffsApplied: {
                minPx: cutoffs.minBaxisPx,
                minMm: cutoffs.minSizeMm,
                ...(siteReport?.dCutoffCommonMm != null ? { siteCommonCutoffMm: siteReport.dCutoffCommonMm } : {}),
              },
            }
          : {}),
      }
    : undefined;
  // Site name first, then the usual provenance metadata.
  const siteMeta = (report: SiteAnalysisReport): Record<string, unknown> => ({
    ...(site?.name ? { siteName: site.name } : {}),
    ...(site?.place ? { place: site.place } : {}),
    ...(site?.surveyDate ? { surveyDate: site.surveyDate } : {}),
    ...buildSiteExportMetadata(siteInputs, report, ctx.siteOptions),
  });

  switch (kind) {
    case 'site-summary-csv':
      return siteReport
        ? { blob: exportSiteSummaryCsv(siteReport, siteMeta(siteReport)), filename: `${siteFile}_summary.csv` }
        : null;
    case 'site-summary-json':
      return siteReport
        ? { blob: exportSiteSummaryJson(siteReport, siteMeta(siteReport)), filename: `${siteFile}_summary.json` }
        : null;
    case 'site-grains-csv':
      return siteReport
        ? {
            blob: exportSiteGrainsCsv(siteInputs, siteReport, { metadata: siteMeta(siteReport) }),
            filename: `${siteFile}_pooled_grains.csv`,
          }
        : null;
    case 'site-psd-svg': {
      if (!siteReport || !ctx.renderPsdSvg) return null;
      const rawSvg = ctx.renderPsdSvg(siteReport, site?.name ?? 'Site', ctx.psdXAxis);
      const openEnd = rawSvg.indexOf('>') + 1;
      const meta = escapeXml(JSON.stringify(siteMeta(siteReport)));
      const svg = `${rawSvg.slice(0, openEnd)}<metadata id="webgrainy-provenance">${meta}</metadata>${rawSvg.slice(openEnd)}`;
      return { blob: new Blob([svg], { type: 'image/svg+xml' }), filename: `${siteFile}_psd.svg` };
    }
    case 'site-archive':
      return site ? { blob: await exportSiteArchive(site.siteId), filename: `${siteFile}.webgrainy` } : null;
    case 'photo-grains-csv':
      return session
        ? {
            blob: new Blob(
              [
                session.exportCsv({
                  includeMetadata: true,
                  sizeMetric,
                  ...(photoMeta ? { photoMetadata: photoMeta } : {}),
                  ...(cutoffs ? { cutoffs } : {}),
                }),
              ],
              { type: 'text/csv' },
            ),
            filename: `${photoFile}_grains.csv`,
          }
        : null;
    case 'photo-summary-csv': {
      return session
        ? { blob: new Blob([session.exportSummaryCsv(sizeMetric, cutoffs, photoMeta)], { type: 'text/csv' }), filename: `${photoFile}_summary.csv` }
        : null;
    }
    case 'photo-summary-json': {
      return session
        ? {
            blob: new Blob([session.exportSummaryJson(sizeMetric, cutoffs, photoMeta)], { type: 'application/json' }),
            filename: `${photoFile}_summary.json`,
          }
        : null;
    }
    case 'photo-mask-16':
    case 'photo-mask-32': {
      if (!session) return null;
      const depth = kind === 'photo-mask-16' ? 16 : 32;
      // Photo resolution (overlays the photo, matches the CSV coordinates), provenance in iTXt.
      const bytes = await session.exportMaskPngCompressed(depth, {
        resolution: 'original',
        ...(photoMeta ? { photoMetadata: photoMeta } : {}),
      });
      return { blob: new Blob([bytes.slice().buffer], { type: 'image/png' }), filename: `${photoFile}_mask${depth}.png` };
    }
    case 'photo-geojson':
      // Original-image coordinates + provenance metadata.
      return session
        ? {
            blob: new Blob([session.exportGeoJson(photoMeta)], { type: 'application/geo+json' }),
            filename: `${photoFile}_contours.geojson`,
          }
        : null;
    case 'photo-geojson-map': {
      // Map coordinates from the photo's GeoTIFF (null when the photo is not georeferenced).
      const g = photo ? photoGeoreference(photo).georef : null;
      return session && g
        ? {
            blob: new Blob([geoJsonToMap(session.exportGeoJson(photoMeta), g)], { type: 'application/geo+json' }),
            filename: `${photoFile}_outlines_map.geojson`,
          }
        : null;
    }
    case 'photo-mask-worldfile': {
      // World file placing the 16-bit mask PNG (same base name) on the map. It holds no CRS:
      // photo-mask-auxxml supplies that for GDAL-based GIS (QGIS).
      const g = photo ? photoGeoreference(photo).georef : null;
      return session && g ? { blob: new Blob([worldFile(g)], { type: 'text/plain' }), filename: `${photoFile}_mask16.pgw` } : null;
    }
    case 'photo-mask-auxxml': {
      // GDAL sidecar naming the CRS of the 16-bit mask PNG + world file (EPSG photos only).
      const g = photo ? photoGeoreference(photo).georef : null;
      const xml = g ? pamAuxXml(g) : null;
      return session && xml ? { blob: new Blob([xml], { type: 'application/xml' }), filename: `${photoFile}_mask16.png.aux.xml` } : null;
    }
    case 'photo-mask-geotiff': {
      // The label mask as a GeoTIFF in the source GeoTIFF's position and CRS (any GIS).
      const g = photo ? photoGeoreference(photo).georef : null;
      if (!session || !g) return null;
      const m = session.labelMaskAtPhotoSize();
      if (m.width !== g.width || m.height !== g.height) return null;
      const bytes = await encodeLabelGeoTiff(m.masks, m.width, m.height, g);
      return { blob: new Blob([bytes.slice().buffer], { type: 'image/tiff' }), filename: `${photoFile}_mask_map.tif` };
    }
    case 'photo-svg':
      return session
        ? { blob: new Blob([session.exportSvg(photoMeta)], { type: 'image/svg+xml' }), filename: `${photoFile}_contours.svg` }
        : null;
  }
}
