/**
 * "Download results": every result file of a site in one .zip, so users keep their results
 * on their own computer (the browser only keeps sites for a limited time). Reuses the
 * single-file exports, so the files are identical to those downloaded one by one.
 */
import { APP_VERSION, BUILD_COMMIT, CITATION_NOTICE, UNOFFICIAL_NOTICE, ACCURACY_NOTICE } from './provenance.js';
import { buildExport, type ExportContext, type ExportKind } from './exports.js';
import type { PhotoRecord, SiteRecord } from './projectStorage.js';
import type { SiteAnalysisReport, SitePhotoInput, SiteAnalysisOptions } from './siteAnalysis.js';
import type { SizeMetric } from '../types/index.js';
import { buildZip, type ZipEntry } from './zip.js';
import { gpkgMapSrs, mapGeoJsonName, photoGeoreference } from './georef.js';

export interface ResultsBundleInput {
  site: SiteRecord;
  photos: readonly PhotoRecord[];
  /** Analysed photos (included or not), with their sessions. */
  siteInputs: SitePhotoInput[];
  siteReport: SiteAnalysisReport | null;
  siteOptions: Partial<SiteAnalysisOptions>;
  sizeMetric: SizeMetric;
  psdXAxis: 'mm' | 'phi';
  renderPsdSvg?: ExportContext['renderPsdSvg'];
  /** Printable report HTML, when the UI can build it. */
  reportHtml?: string | null;
  /** Add the .webgrainy project file (with photos) so the site can be reopened later. */
  includeProject: boolean;
  /** Outlines and masks hold only the grains counted in the statistics (see ExportContext). */
  countedGrainsOnly?: boolean;
  now?: Date;
}

const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';

const SITE_FILES: Array<[ExportKind, string, string]> = [
  ['site-summary-csv', 'site_summary.csv', 'Site statistics: D5–D95 with confidence intervals, Folk & Ward, Wentworth classes, sample adequacy, per-photo breakdown, warnings, provenance.'],
  ['site-summary-json', 'site_summary.json', 'The same, plus convergence and jackknife detail, as JSON.'],
  ['site-grains-csv', 'site_pooled_grains.csv', 'One row per grain of the included photos; included_in_stats marks the grains behind the site statistics.'],
  ['site-psd-svg', 'site_grain_size_curve.svg', 'Cumulative grain-size curve with confidence band.'],
];
const PHOTO_FILES: Array<[ExportKind, string, string]> = [
  ['photo-grains-csv', 'grains.csv', 'One row per grain (original-photo pixels and mm), with in_roi / included_in_stats.'],
  ['photo-summary-csv', 'summary.csv', 'Photo statistics (D5–D95, Folk & Ward, histograms, fabric, warnings).'],
  ['photo-mask-16', 'mask16.png', '16-bit label image at the photo’s size: pixel value = grain_id in grains.csv, 0 = background.'],
  ['photo-geojson', 'outlines.geojson', 'Grain outlines in original-photo pixel coordinates.'],
];

/** The zip's entries (exported for tests). */
export async function resultsBundleEntries(input: ResultsBundleInput): Promise<ZipEntry[]> {
  const { site } = input;
  const base: ExportContext = {
    site,
    photo: null,
    session: null,
    siteReport: input.siteReport,
    siteInputs: input.siteInputs,
    psdXAxis: input.psdXAxis,
    sizeMetric: input.sizeMetric,
    siteOptions: input.siteOptions,
    ...(input.countedGrainsOnly ? { countedGrainsOnly: true } : {}),
    ...(input.renderPsdSvg ? { renderPsdSvg: input.renderPsdSvg } : {}),
  };
  const entries: ZipEntry[] = [];
  const listed: string[] = [];
  for (const [kind, name, what] of SITE_FILES) {
    const f = await buildExport(kind, base);
    if (!f) continue;
    entries.push({ name, data: f.blob });
    listed.push(`${name}\n    ${what}`);
  }
  // The whole site as one GeoPackage, when its photos can be placed on a map (GeoTIFFs).
  const siteGpkg = await buildExport('site-gpkg', base);
  if (siteGpkg && !siteGpkg.filename.endsWith('_pixels.gpkg')) {
    // lastIndexOf: the site name itself may contain "site_outlines_".
    const name = siteGpkg.filename.slice(siteGpkg.filename.lastIndexOf('site_outlines_'));
    entries.push({ name, data: siteGpkg.blob });
    listed.push(
      `${name}\n    Every GeoTIFF photo's grain outlines in one GeoPackage layer (photo_id, included_in_stats and the measurements as fields), ` +
        'and each photo\'s footprint with its D16/D50/D84, for ArcGIS Pro, QGIS or any GIS. In the photos\' shared map CRS, or WGS84 longitude/latitude when they differ.',
    );
  }
  if (input.reportHtml) {
    entries.push({ name: 'site_report.html', data: input.reportHtml });
    listed.push('site_report.html\n    Printable site report (open in a browser, print or save as PDF).');
  }
  const used = new Set<string>();
  let photoCount = 0;
  const coarse: string[] = [];
  let georeferenced = 0;
  for (const photo of input.photos) {
    const session = input.siteInputs.find((i) => i.photoId === photo.photoId)?.session ?? null;
    if (!session) continue;
    const baseDir = `photos/${safe(photo.label.replace(/\.[a-z0-9]+$/i, ''))}`;
    // Same-named photos (a.jpg, a.png) get a suffix; keep adding until the folder is unused, so
    // even a photo literally named like a generated folder cannot collide.
    let dir = baseDir;
    if (used.has(dir)) dir = `${baseDir}_${safe(photo.photoId).slice(-6)}`;
    for (let k = 2; used.has(dir); k++) dir = `${baseDir}_${k}`;
    used.add(dir);
    photoCount++;
    const res = session.getOutlineResolution();
    if (res.coarse) coarse.push(`    ${dir}/: one outline step = ${res.stepPhotoPx.toFixed(1)} photo px${res.stepMm !== null ? ` (${res.stepMm.toFixed(2)} mm)` : ''}`);
    for (const [kind, name] of PHOTO_FILES) {
      const f = await buildExport(kind, { ...base, photo, session });
      if (f) entries.push({ name: `${dir}/${name}`, data: f.blob });
    }
    // GeoTIFF photos: outlines and the mask in map coordinates (with the CRS), and a world file
    // + CRS sidecar that place mask16.png on the map.
    let geo = false;
    const g = photoGeoreference(photo).georef;
    // One GeoPackage (e.g. for ArcGIS Pro): in the map CRS when it can be written, else lon/lat.
    const mapSrs = g ? gpkgMapSrs(g) : null;
    const gpkg: ['photo-gpkg-map' | 'photo-gpkg-lonlat', string] = mapSrs
      ? ['photo-gpkg-map', `outlines_EPSG${mapSrs.id}.gpkg`]
      : ['photo-gpkg-lonlat', 'outlines_lonlat.gpkg'];
    for (const [kind, name] of [
      ['photo-geojson-map', g ? mapGeoJsonName(g) : 'outlines_map.geojson'],
      ['photo-geojson-lonlat', 'outlines_lonlat.geojson'],
      gpkg,
      ['photo-mask-geotiff', 'mask_map.tif'],
      ['photo-mask-webmercator', 'mask_webmercator.tif'],
      ['photo-mask-worldfile', 'mask16.pgw'],
      ['photo-mask-auxxml', 'mask16.png.aux.xml'],
    ] as const) {
      const f = await buildExport(kind, { ...base, photo, session });
      if (f) {
        entries.push({ name: `${dir}/${name}`, data: f.blob });
        geo = true;
      }
    }
    if (geo) georeferenced++;
  }
  if (photoCount > 0) {
    listed.push(
      `photos/<photo name>/  (${photoCount} analysed photo${photoCount === 1 ? '' : 's'})\n` +
        PHOTO_FILES.map(([, name, what]) => `    ${name}: ${what}`).join('\n') +
        (georeferenced > 0
          ? '\n    GeoTIFF photos also (see above): outlines_EPSG<code>.geojson / .gpkg, outlines_lonlat.geojson, mask_map.tif,\n' +
            '    mask_webmercator.tif, mask16.pgw and mask16.png.aux.xml (each only when the CRS allows it).'
          : ''),
    );
  }
  if (input.includeProject) {
    const f = await buildExport('site-archive', base);
    if (f) {
      const name = `${safe(site.name)}.webgrainy`;
      entries.push({ name, data: f.blob, compress: false });
      listed.push(`${name}\n    The whole site (photos, scales, ROIs, results, settings): open it in webGrainy to continue working.`);
    }
  }
  const now = input.now ?? new Date();
  const readme = [
    `webGrainy results: ${site.name}`,
    ...(site.place ? [`Place: ${site.place}`] : []),
    ...(site.surveyDate ? [`Survey date: ${site.surveyDate}`] : []),
    `Downloaded: ${now.toISOString()}`,
    `webGrainy ${APP_VERSION} (commit ${BUILD_COMMIT})`,
    '',
    'Sizes are in mm when the photo was calibrated, otherwise in original-photo pixels (each file states its unit).',
    input.countedGrainsOnly
      ? 'Outlines and masks hold only the grains counted in the statistics (border rule, ROI and size cutoffs applied); grains.csv lists every detected grain, with included_in_stats.'
      : 'Outlines and masks hold every detected grain; grains.csv marks the ones counted in the statistics (included_in_stats).',
    'Every CSV records the app and model versions, model SHA-256 and all settings. The per-grain tables',
    "(grains.csv, site_pooled_grains.csv) start with '#' metadata lines: read them with e.g.",
    "pandas.read_csv(path, comment='#'). CSV files are UTF-8 with a byte-order mark, so Excel shows φ, µ and – correctly.",
    'The summary CSVs (section,metric,value,unit) hold the same metadata as rows whose first cell is "metadata".',
    '',
    georeferenced > 0
      ? 'GeoTIFF photos: outlines_lonlat.geojson has the grain outlines in WGS84 longitude/latitude for web maps and any GeoJSON reader (when the CRS can be converted; no datum shift, within about a metre). outlines_EPSG<code>.geojson has them in the map coordinates and CRS of the source GeoTIFF (exact; for QGIS and other GDAL-based tools only: web maps and ArcGIS Online read every .geojson as longitude/latitude and cannot place it). outlines_EPSG<code>.gpkg is the same as an OGC GeoPackage with its CRS, for ArcGIS Pro and any GIS (outlines_lonlat.gpkg, in longitude/latitude, when the CRS cannot be written). mask_map.tif is the label mask as a GeoTIFF, CRS included, background = nodata; mask_webmercator.tif is the same mask reprojected to the north-up Web Mercator grid (EPSG:3857), for web maps that draw rasters without rotating them. mask16.png is placed by mask16.pgw (world file) with its CRS in mask16.png.aux.xml. outlines.geojson, grains.csv and the other mask files are in photo pixels (x right, y down), not map coordinates.'
      : 'Mask and outline coordinates are photo pixels (x right, y down), not map coordinates.',
    ...(coarse.length > 0
      ? [
          'Outlines are traced on the smaller working copy each photo was analysed at, so their edges are',
          'stepped. For finer outlines, re-analyse with Scale Mode 1.0x Full. Step size per photo:',
          ...coarse,
        ]
      : []),
    '',
    input.includeProject
      ? 'The .webgrainy project file reopens this site in webGrainy (Open, in the Site panel).'
      : 'No project file: this site cannot be reopened in webGrainy from these files. Keep your original photos.',
    '',
    'Files',
    '-----',
    ...listed,
    '',
    UNOFFICIAL_NOTICE,
    ACCURACY_NOTICE,
    CITATION_NOTICE,
    '',
  ].join('\n');
  return [{ name: 'README.txt', data: readme }, ...entries];
}

/** The site's results as one .zip, and its file name. */
export async function buildResultsBundle(input: ResultsBundleInput): Promise<{ blob: Blob; filename: string }> {
  const entries = await resultsBundleEntries(input);
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  return { blob: await buildZip(entries, input.now), filename: `${safe(input.site.name)}_results_${day}.zip` };
}
