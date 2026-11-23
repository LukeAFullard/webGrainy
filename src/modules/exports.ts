/**
 * Every downloadable export in one place: which file, which contents and metadata, which
 * file name. The UI only asks for an export by kind and saves the result.
 */
import type { SizeMetric } from '../types/index.js';
import type { AnalysisSession } from './pipelineController.js';
import { exportSiteArchive, type PhotoRecord, type SiteRecord } from './projectStorage.js';
import { photoProcessingHistory } from './siteTypes.js';
import { geoJsonToLonLat, geoJsonToMap, gpkgMapSrs, mapGeoJsonName, pamAuxXml, photoGeoreference, worldFile } from './georef.js';
import { geoJsonToGeoPackage, PIXEL_SRS, WGS84_SRS } from './geopackage.js';
import { encodeGeoTiff, encodeLabelGeoTiff } from './geotiffWriter.js';
import { baseExportMetadata } from './provenance.js';
import { warpLabelsToWebMercator, warpRgbaToWebMercator, webMercatorGeoref, webMercatorGrid } from './webMercatorWarp.js';
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
  'photo-geojson-lonlat',
  'photo-gpkg',
  'photo-gpkg-map',
  'photo-gpkg-lonlat',
  'photo-mask-worldfile',
  'photo-mask-geotiff',
  'photo-mask-auxxml',
  'photo-mask-webmercator',
  'photo-image-webmercator',
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
  /**
   * Outline and mask exports hold only the grains counted in the statistics (border rule, ROI and
   * size cutoffs, as `included_in_stats` in the grain table) instead of every detected grain.
   */
  countedGrainsOnly?: boolean;
  /** RGBA pixels of a photo at its own size (the UI decodes the stored image); for reprojected photo exports. */
  decodePhoto?: (photo: PhotoRecord) => Promise<{ data: Uint8Array | Uint8ClampedArray; width: number; height: number } | null>;
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
  const onlyIds = ctx.countedGrainsOnly && session ? session.countedGrainIds(sizeMetric, cutoffs) : undefined;
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
        ...(onlyIds ? { onlyIds } : {}),
        resolution: 'original',
        ...(photoMeta ? { photoMetadata: photoMeta } : {}),
      });
      return { blob: new Blob([bytes.slice().buffer], { type: 'image/png' }), filename: `${photoFile}_mask${depth}.png` };
    }
    case 'photo-geojson':
      // Original-image coordinates + provenance metadata.
      return session
        ? {
            blob: new Blob([session.exportGeoJson(photoMeta, onlyIds)], { type: 'application/geo+json' }),
            filename: `${photoFile}_contours.geojson`,
          }
        : null;
    case 'photo-geojson-map': {
      // Map coordinates from the photo's GeoTIFF (null when the photo is not georeferenced).
      const g = photo ? photoGeoreference(photo).georef : null;
      return session && g
        ? {
            blob: new Blob([geoJsonToMap(session.exportGeoJson(photoMeta, onlyIds), g)], { type: 'application/geo+json' }),
            filename: `${photoFile}_${mapGeoJsonName(g)}`,
          }
        : null;
    }
    case 'photo-geojson-lonlat': {
      // Longitude / latitude (RFC 7946) for web maps; null when the CRS is not convertible.
      const g = photo ? photoGeoreference(photo).georef : null;
      const json = session && g ? geoJsonToLonLat(session.exportGeoJson(photoMeta, onlyIds), g) : null;
      return json ? { blob: new Blob([json], { type: 'application/geo+json' }), filename: `${photoFile}_outlines_lonlat.geojson` } : null;
    }
    case 'photo-gpkg':
    case 'photo-gpkg-map':
    case 'photo-gpkg-lonlat': {
      // GeoPackage (e.g. for ArcGIS Pro): the same outlines and properties as the GeoJSON.
      if (!session) return null;
      const pixels = session.exportGeoJson(photoMeta, onlyIds);
      const layer = `${photo?.label ?? 'photo'} grain outlines`;
      if (kind === 'photo-gpkg') {
        return { blob: new Blob([geoJsonToGeoPackage(pixels, PIXEL_SRS, layer).slice().buffer], { type: 'application/geopackage+sqlite3' }), filename: `${photoFile}_outlines.gpkg` };
      }
      const g = photo ? photoGeoreference(photo).georef : null;
      if (!g) return null;
      if (kind === 'photo-gpkg-map') {
        const srs = gpkgMapSrs(g);
        if (!srs) return null;
        const bytes = geoJsonToGeoPackage(geoJsonToMap(pixels, g), srs, layer);
        return { blob: new Blob([bytes.slice().buffer], { type: 'application/geopackage+sqlite3' }), filename: `${photoFile}_outlines_EPSG${srs.id}.gpkg` };
      }
      const ll = geoJsonToLonLat(pixels, g);
      if (!ll) return null;
      return { blob: new Blob([geoJsonToGeoPackage(ll, WGS84_SRS, layer).slice().buffer], { type: 'application/geopackage+sqlite3' }), filename: `${photoFile}_outlines_lonlat.gpkg` };
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
      const m = session.labelMaskAtPhotoSize(onlyIds, photoMeta);
      if (m.width !== g.width || m.height !== g.height) return null;
      const bytes = await encodeLabelGeoTiff(m.masks, m.width, m.height, g, { description: m.metadataJson });
      return { blob: new Blob([bytes.slice().buffer], { type: 'image/tiff' }), filename: `${photoFile}_mask_map.tif` };
    }
    case 'photo-mask-webmercator': {
      // The label mask on a north-up Web Mercator grid: lines up with the longitude/latitude
      // GeoJSON in web maps that draw rasters without rotating them.
      const g = photo ? photoGeoreference(photo).georef : null;
      const grid = g ? webMercatorGrid(g) : null;
      if (!session || !g || !grid) return null;
      const m = session.labelMaskAtPhotoSize(onlyIds, photoMeta);
      if (m.width !== g.width || m.height !== g.height) return null;
      const description = JSON.stringify({ ...JSON.parse(m.metadataJson || '{}'), reprojection: 'Web Mercator (EPSG:3857), nearest-neighbour' });
      const bytes = await encodeLabelGeoTiff(warpLabelsToWebMercator(m.masks, g, grid), grid.width, grid.height, webMercatorGeoref(grid), { description });
      return { blob: new Blob([bytes.slice().buffer], { type: 'image/tiff' }), filename: `${photoFile}_mask_webmercator.tif` };
    }
    case 'photo-image-webmercator': {
      // The photo itself on the same Web Mercator grid (RGBA, transparent outside).
      const g = photo ? photoGeoreference(photo).georef : null;
      const grid = g ? webMercatorGrid(g) : null;
      if (!photo || !g || !grid || !ctx.decodePhoto) return null;
      const img = await ctx.decodePhoto(photo);
      if (!img || img.width !== g.width || img.height !== g.height) return null;
      const raw = warpRgbaToWebMercator(img.data, g, grid);
      const description = JSON.stringify({
        ...(session ? session.getExportMetadata(photoMeta) : { ...baseExportMetadata(), ...(photoMeta ? { photo: photoMeta } : {}) }),
        raster: 'the photo, reprojected to Web Mercator (EPSG:3857), transparent outside the photo',
      });
      const bytes = await encodeGeoTiff({ raw, width: grid.width, height: grid.height, bitsPerSample: 8, samples: 4 }, webMercatorGeoref(grid), { description });
      return { blob: new Blob([bytes.slice().buffer], { type: 'image/tiff' }), filename: `${photoFile}_photo_webmercator.tif` };
    }
    case 'photo-svg':
      return session
        ? { blob: new Blob([session.exportSvg(photoMeta, onlyIds)], { type: 'image/svg+xml' }), filename: `${photoFile}_contours.svg` }
        : null;
  }
}
