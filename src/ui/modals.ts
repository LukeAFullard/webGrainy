import type { ModelId, SizeMetric, StorageQuotaInfo } from '../types/index.js';
import type { AnalysisSession } from '../modules/pipelineController.js';
import type { PhotoRecord, SiteRecord } from '../modules/projectStorage.js';
import type { SiteAnalysisOptions, SiteAnalysisReport, SitePhotoInput } from '../modules/siteAnalysis.js';
import { buildExport, isExportKind } from '../modules/exports.js';
import { renderPrintablePsdSvg } from './charts.js';
import { canExportLonLat, gpkgMapSrs, photoGeoreference } from '../modules/georef.js';
import { buildSiteInputs } from '../modules/siteWorkspace.js';
import { siteGeoPackagePlan } from '../modules/siteGeoPackage.js';
import { canWarpToWebMercator } from '../modules/webMercatorWarp.js';
import { decodePhotoRgba } from './imageCanvas.js';
import type { AppState } from './state.js';

export const FULL_SCIENTIFIC_CITATIONS: ReadonlyArray<{ title: string; citation: string }> = [
  {
    title: 'ImageGrains 2.0',
    citation:
      'Mair, D., Witz, G., Do Prado, A., Garefalakis, P., Wild, A., Ville, F., Schuster, B., Horn, M., Österle, J., Fabbri, S. C., Litty, C., Achleitner, S., Leistner, S., Hiller, C., & Schlunegger, F. (2026). ImageGrains 2.0: Improved precision and generalization for grain segmentation. Earth Surface Dynamics, 14, 527–551. https://doi.org/10.5194/esurf-14-527-2026',
  },
  {
    title: 'ImageGrains 1.0',
    citation:
      'Mair, D., Witz, G., Do Prado, A. H., Garefalakis, P., & Schlunegger, F. (2023/2024). Automated detecting, segmenting and measuring of grains in images of fluvial sediments: The potential for large and precise data from specialist deep learning models and transfer learning. Earth Surface Processes and Landforms, 49(3), 1099–1116. https://doi.org/10.1002/esp.5755',
  },
  {
    title: 'Cellpose-SAM',
    citation:
      'Pachitariu, M., Rariden, M., & Stringer, C. (2025). Cellpose-SAM: superhuman generalization for cellular segmentation. bioRxiv 2025.04.28.651001. https://doi.org/10.1101/2025.04.28.651001',
  },
  {
    title: 'Cellpose 1.0',
    citation:
      'Stringer, C., Wang, T., Michaelos, M., & Pachitariu, M. (2021). Cellpose: a generalist algorithm for cellular segmentation. Nature Methods, 18, 100–106. https://doi.org/10.1038/s41592-020-01018-x',
  },
  {
    title: 'Photo-Sieving Uncertainty & Cluster Bootstrapping',
    citation:
      'Mair, D., Do Prado, A. H., Garefalakis, P., Lechmann, A., Whittaker, A., & Schlunegger, F. (2022). Grain size of fluvial gravel bars from close-range UAV imagery—uncertainty in segmentation-based data. Earth Surface Dynamics, 10, 953–973. https://doi.org/10.5194/esurf-10-953-2022',
  },
  {
    title: 'GSDtools (Binomial Percentile CIs)',
    citation:
      'Eaton, B. C., Moore, R. D., & MacKenzie, L. G. (2019). Percentile-based grain size distribution analysis tools (GSDtools) – estimating confidence limits and hypothesis tests for comparing two samples. Earth Surface Dynamics, 7, 789–806. https://doi.org/10.5194/esurf-7-789-2019',
  },
  {
    title: 'BASEGRAIN',
    citation:
      'Detert, M., & Weitbrecht, V. (2012). Automatic object detection to analyze the geometry of gravel grains – a free stand-alone tool. In R. M. Muños (Ed.), River Flow 2012 (pp. 595–600). Taylor & Francis Group, London. (Also Detert & Weitbrecht 2013, Advances in Science and Research, 1789–1795.)',
  },
  {
    title: 'PebbleCounts',
    citation:
      'Purinton, B., & Bookhagen, B. (2019). Introducing PebbleCounts: a grain-sizing tool for photo surveys of dynamic gravel-bed rivers. Earth Surface Dynamics, 7, 859–877. https://doi.org/10.5194/esurf-7-859-2019',
  },
  {
    title: 'Segmenteverygrain',
    citation:
      'Sylvester, Z., Stockli, D. F., Howes, N., Roberts, K., Malkowski, M., & Covault, J. (2025). Segmenteverygrain: A Python module for segmentation of grains in images. Journal of Open Source Software, 10(112), 7953. https://doi.org/10.21105/joss.07953',
  },
  {
    title: 'Wolman Pebble Count',
    citation:
      'Wolman, M. G. (1954). A method of sampling coarse river-bed material. Eos, Transactions American Geophysical Union, 35(6), 951–956. https://doi.org/10.1029/TR035i006p00951',
  },
  {
    title: 'Surface Sampling Equivalency',
    citation:
      'Kellerhals, R., & Bray, D. I. (1971). Sampling procedures for coarse fluvial sediments. Journal of the Hydraulics Division, ASCE, 97(HY8), 1165–1180. https://doi.org/10.1061/JYCEAJ.0003044',
  },
  {
    title: 'Gravel-Bed Sampling Guidelines',
    citation:
      'Bunte, K., & Abt, S. R. (2001). Sampling surface and subsurface particle-size distributions in wadable gravel- and cobble-bed streams for analyses in sediment transport, hydraulics, and streambed monitoring. Gen. Tech. Rep. RMRS-GTR-74, USDA Forest Service. https://doi.org/10.2737/RMRS-GTR-74',
  },
  {
    title: 'Photo-Sieving Methodology & Accuracy',
    citation:
      'Graham, D. J., Reid, I., & Rice, S. P. (2005a), Mathematical Geology 37(1), 1–28; Graham, D. J., Rice, S. P., & Reid, I. (2005b), Water Resources Research 41, W07020; Graham, D. J., Rollet, A.-J., Piégay, H., & Rice, S. P. (2010), Water Resources Research 46, W02508.',
  },
  {
    title: 'Folk & Ward Graphic Statistics',
    citation:
      'Folk, R. L., & Ward, W. C. (1957). Brazos River bar: a study in the significance of grain size parameters. Journal of Sedimentary Petrology, 27(1), 3–26.',
  },
  {
    title: 'Wentworth & Coarse Clast Scale',
    citation:
      'Wentworth, C. K. (1922). A scale of grade and class terms for clastic sediments. The Journal of Geology, 30(5), 377–392; Blair, T. C., & McPherson, J. G. (1999). Journal of Sedimentary Research, 69(1), 6–19.',
  },
  {
    title: 'Directional / Axial Fabric Statistics',
    citation:
      'Curray, J. R. (1956). The analysis of two-dimensional orientation data. The Journal of Geology, 64(2), 117–131; Mardia, K. V., & Jupp, P. E. (2000). Directional Statistics. Wiley.',
  },
];

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Decimal units (1 MB = 1,000,000 bytes), like the storage line in the Site panel. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1e3) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderModelsModalHtml(
  state: AppState,
  quota: StorageQuotaInfo | null,
): string {
  const cachedMap = new Map(
    (state.capabilities?.cachedModels ?? []).map((m) => [m.modelId, m]),
  );

  const models: Array<{
    id: ModelId;
    title: string;
    sizeLabel: string;
    desc: string;
  }> = [
    {
      id: 'ig2_unet_fp32',
      title: 'U-Net (Fast) — ig2_unet_fp32.onnx',
      sizeLabel: '26.5 MB (FP32)',
      desc: 'Recommended for mobile, CPU WASM, or quick field previews.',
    },
    {
      id: 'ig2_cpsam_fp16',
      title: 'Cellpose-SAM FP16 — ig2_cpsam_fp16.onnx',
      sizeLabel: '617 MB',
      desc: 'Original weights. Used automatically on a graphics card with WebGPU float16 (shader-f16).',
    },
    {
      id: 'ig2_cpsam_int8_wo_fp32scale',
      title: 'Cellpose-SAM INT8 — ig2_cpsam_int8_wo_fp32scale.onnx',
      sizeLabel: '316 MB',
      desc: 'Same accuracy as FP16 in testing. Used automatically on the CPU: half the memory (about 2 GB) and faster loading.',
    },
    {
      id: 'ig2_cpsam_fp4_e2m1_lut',
      title: 'Cellpose-SAM FP4 — ig2_cpsam_fp4_e2m1_lut.onnx',
      sizeLabel: '183 MB',
      desc: 'Same accuracy as FP16 in testing. Smallest download; needs about 3.7 GB of memory while running.',
    },
  ];

  const quotaPct =
    quota && quota.quotaBytes > 0
      ? Math.min(100, (quota.usageBytes / quota.quotaBytes) * 100)
      : 0;

  return `
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="dialog-title" class="modal-title">Offline ONNX Model Cache (IndexedDB: imagegrains-onnx-cache-v1)</h2>
        <button type="button" class="btn btn-sm" data-action="close-modal" autofocus>Close</button>
      </div>
      <div class="modal-body" tabindex="0">
        <div class="basis-banner">
          Models are streamed client-side from <code>inYourOwnBrowser/imagegrains-2.0-onnx</code> on Hugging Face and cached locally in IndexedDB for offline use. User photos never leave your device.
        </div>
        ${
          quota
            ? `<div>
                <div class="row-between" style="font-size:0.85rem;margin-bottom:4px;">
                  <span>Browser Storage Quota</span>
                  <span>${formatBytes(quota.usageBytes)} used / ${formatBytes(quota.quotaBytes)} (${formatBytes(quota.availableBytes)} free)</span>
                </div>
                <progress class="native-progress" value="${quotaPct.toFixed(1)}" max="100" aria-label="Browser storage quota used"></progress>
              </div>`
            : ''
        }
        ${models
          .map((m) => {
            const cached = cachedMap.get(m.id);
            const dl = state.modelDownloads.get(m.id);
            return `
              <div class="stat-card" style="padding:10px;">
                <div class="row-between">
                  <div>
                    <div style="font-weight:700;">${esc(m.title)}</div>
                    <div style="font-size:0.85rem;color:var(--text-secondary);">${esc(m.sizeLabel)} — ${esc(m.desc)}</div>
                  </div>
                  <div>
                    ${
                      cached
                        ? `<span class="badge done">Cached (${formatBytes(cached.sizeBytes)})</span>`
                        : `<span class="badge">Not Cached</span>`
                    }
                  </div>
                </div>
                ${
                  dl?.active
                    ? `<div style="margin-top:8px;">
                        <div class="row-between" style="font-size:0.85rem;margin-bottom:4px;">
                          <span>Downloading… ${dl.percent.toFixed(1)}%</span>
                          <span>${formatBytes(dl.loadedBytes)} / ${formatBytes(dl.totalBytes)} (${dl.speedMBps.toFixed(2)} MB/s)</span>
                        </div>
                        <progress class="native-progress" value="${dl.percent.toFixed(1)}" max="100" aria-label="Downloading ${esc(m.id)}"></progress>
                      </div>`
                    : ''
                }
                ${
                  dl?.error
                    ? `<div class="warning-banner" role="alert">${esc(dl.error)}</div>`
                    : ''
                }
                <div class="row" style="margin-top:8px;">
                  ${
                    dl?.active
                      ? `<button type="button" class="btn btn-sm btn-danger" data-action="cancel-model-dl" data-model-id="${esc(m.id)}">Cancel Download</button>`
                      : `<button type="button" class="btn btn-sm btn-primary" data-action="download-model" data-model-id="${esc(m.id)}">${cached ? 'Re-download' : 'Download &amp; Cache'}</button>`
                  }
                  ${
                    cached && !dl?.active
                      ? `<button type="button" class="btn btn-sm btn-danger" data-action="delete-model" data-model-id="${esc(m.id)}">Delete</button>`
                      : ''
                  }
                </div>
              </div>
            `;
          })
          .join('')}
        <div class="row-between">
          <span style="font-size:0.85rem;color:var(--text-secondary);">Clearing model cache preserves all Sites &amp; Photos in <code>imagegrains-projects-v1</code>.</span>
          <button type="button" class="btn btn-sm btn-danger" data-action="clear-model-cache">Clear All Cached Models</button>
        </div>
      </div>
    </div>
  `;
}

const fmtNum = (n: number, d = 1): string => n.toLocaleString(undefined, { maximumFractionDigits: d });

/**
 * Warning shown with outline exports when outlines are coarser than the photo: they are traced
 * on the working image, so each step is several photo pixels. Empty when they are not coarse.
 */
export function outlineResolutionWarningHtml(session: AnalysisSession | null): string {
  if (!session) return '';
  const r = session.getOutlineResolution();
  if (!r.coarse) return '';
  const wi = session.workingImage;
  return `<div class="warning-banner" role="note" style="margin-top:8px;"><strong>Outlines are coarser than the photo.</strong>
    They were traced on a ${fmtNum(r.workingWidth, 0)} × ${fmtNum(r.workingHeight, 0)} px working copy of this ${fmtNum(wi.originalWidth, 0)} × ${fmtNum(wi.originalHeight, 0)} px photo, so each outline step is ${fmtNum(r.stepPhotoPx)} photo pixels${r.stepMm !== null ? ` (${fmtNum(r.stepMm, 2)} mm)` : ''}. Mask, GeoJSON and SVG edges are stepped at that size.
    For finer outlines, re-analyse with <em>Scale Mode: 1.0x Full</em> (slower; photos over 16.7 megapixels are still read at 16.7 MP).</div>`;
}

export type ExportWhat = 'outlines' | 'mask' | 'photo';
export type ExportCoords = 'pixels' | 'lonlat' | 'map' | 'webmercator';

/** What the photo exports offer for this photo, and the selection normalised to a valid one. */
export interface PhotoExportChoice {
  what: ExportWhat;
  format: string;
  coords: ExportCoords;
  whats: Array<[ExportWhat, string]>;
  formats: Array<[string, string]>;
  coordsList: Array<[ExportCoords, string]>;
  /** Export kind the Download button runs. */
  kind: string;
  /** One sentence on the file this choice gives. */
  hint: string;
}

/**
 * The photo-export choices (what / format / coordinates) for a photo, from the user's last
 * selection: options a photo cannot give are left out (e.g. map coordinates without a GeoTIFF),
 * and an unavailable selection falls back to the first valid one. Coordinate labels name the
 * photo's own CRS (any EPSG code, or "custom CRS").
 */
export function photoExportChoice(
  photo: PhotoRecord,
  sel: { what?: string; format?: string; coords?: string },
): PhotoExportChoice {
  const { georef } = photoGeoreference(photo);
  const crs = georef ? (georef.epsg !== null ? `EPSG:${georef.epsg}` : 'custom CRS') : '';
  const lonLat = georef ? canExportLonLat(georef) : false;
  const warp = georef ? canWarpToWebMercator(georef) : false;
  const whats: Array<[ExportWhat, string]> = [['outlines', 'Grain outlines (vector)'], ['mask', 'Label mask (raster)']];
  if (warp) whats.push(['photo', 'Photo (raster)']);
  const what = (whats.find(([w]) => w === sel.what)?.[0] ?? 'outlines') as ExportWhat;
  const formats: Array<[string, string]> =
    what === 'outlines'
      ? [['geojson', 'GeoJSON'], ['gpkg', 'GeoPackage (.gpkg)'], ['svg', 'SVG']]
      : what === 'mask'
        ? [['png16', 'PNG, 16-bit'], ['png32', 'PNG, 32-bit'], ...(georef ? ([['geotiff', 'GeoTIFF']] as Array<[string, string]>) : [])]
        : [['geotiff', 'GeoTIFF']];
  const format = formats.find(([f]) => f === sel.format)?.[0] ?? formats[0]![0];
  const gpkgMap = georef ? gpkgMapSrs(georef) !== null : false;
  const coordsList: Array<[ExportCoords, string]> =
    what === 'outlines' && format === 'gpkg'
      ? [
          ...(gpkgMap ? ([['map', `Map coordinates, ${crs}: ArcGIS Pro, QGIS, any GIS`]] as Array<[ExportCoords, string]>) : []),
          ...(lonLat ? ([['lonlat', 'Longitude / latitude (WGS84)']] as Array<[ExportCoords, string]>) : []),
          ['pixels', 'Photo pixels'],
        ]
      : what === 'outlines' && format === 'geojson'
      ? [
          ['pixels', 'Photo pixels'],
          ...(lonLat ? ([['lonlat', 'Longitude / latitude (WGS84): web maps, any GeoJSON reader']] as Array<[ExportCoords, string]>) : []),
          ...(georef ? ([['map', `Map coordinates, ${crs}: QGIS / GDAL`]] as Array<[ExportCoords, string]>) : []),
        ]
      : what === 'mask' && format === 'geotiff'
        ? [['map', `Map coordinates, ${crs}`], ...(warp ? ([['webmercator', 'Web Mercator, north-up: web maps']] as Array<[ExportCoords, string]>) : [])]
        : what === 'photo'
          ? [['webmercator', 'Web Mercator, north-up: web maps']]
          : [['pixels', 'Photo pixels']];
  const coords = (coordsList.find(([c]) => c === sel.coords)?.[0] ?? coordsList[0]![0]) as ExportCoords;
  let kind: string;
  let hint: string;
  if (what === 'outlines') {
    if (format === 'gpkg') {
      kind = coords === 'map' ? 'photo-gpkg-map' : coords === 'lonlat' ? 'photo-gpkg-lonlat' : 'photo-gpkg';
      hint =
        coords === 'map'
          ? `OGC GeoPackage with the GeoTIFF's exact ${crs} coordinates and the CRS written in the file: ArcGIS Pro (add it to a map or drag it in), QGIS and any GDAL-based GIS. One polygon layer, grain_outlines, with the measurements as fields named like grains.csv.`
          : coords === 'lonlat'
            ? `OGC GeoPackage in WGS84 longitude/latitude, converted from ${crs} without a datum shift (within about a metre). One polygon layer with the measurements as fields.`
            : `OGC GeoPackage in photo pixels (x right, y down), with no map coordinate system${georef ? ': choose map coordinates to place it on a map' : ''}. One polygon layer with the measurements as fields.`;
    } else if (format === 'svg') {
      kind = 'photo-svg';
      hint = 'One path per grain in photo pixels (x right, y down), for drawings and figures.';
    } else if (coords === 'lonlat') {
      kind = 'photo-geojson-lonlat';
      hint = `Standard GeoJSON (RFC 7946) in WGS84 longitude/latitude, converted from ${crs} without a datum shift (within about a metre): opens in web maps, ArcGIS Online and any GIS.`;
    } else if (coords === 'map') {
      kind = 'photo-geojson-map';
      hint = `The GeoTIFF's exact ${crs} coordinates with the CRS written in the file: QGIS and other GDAL-based tools read it; web maps and ArcGIS Online read every GeoJSON as longitude/latitude and cannot place it.`;
    } else {
      kind = 'photo-geojson';
      hint = `Outlines in photo pixels (x right, y down), not map coordinates${georef ? ': a GIS would read them as longitude/latitude, so choose another coordinate option for a map' : ''}.`;
    }
  } else if (what === 'mask') {
    if (format === 'png16' || format === 'png32') {
      kind = format === 'png16' ? 'photo-mask-16' : 'photo-mask-32';
      hint = `Image at the photo's size: pixel value = grain_id in the grain table, 0 = background${format === 'png16' ? ' (ids above 65535 are clamped)' : ' (id in the RGBA bytes)'}.${georef ? ' The results .zip also places the 16-bit PNG on the map with a world file and a CRS file.' : ''}`;
    } else if (coords === 'webmercator') {
      kind = 'photo-mask-webmercator';
      hint = 'The mask reprojected to a north-up Web Mercator grid (EPSG:3857): lines up with the longitude/latitude outlines in web maps that draw rasters without rotating them.';
    } else {
      kind = 'photo-mask-geotiff';
      hint = `The mask as a GeoTIFF in the source GeoTIFF's position and ${crs} (background = nodata): opens in the right place in any GIS.`;
    }
  } else {
    kind = 'photo-image-webmercator';
    hint = 'The photo reprojected to a north-up Web Mercator grid (EPSG:3857, transparent outside): lines up with the longitude/latitude outlines and the Web Mercator mask in web maps.';
  }
  return { what, format, coords, whats, formats, coordsList, kind, hint };
}

/** "Site GeoPackage": every analysed photo's outlines and footprints in one file; the title says how. */
function siteGpkgButtonHtml(state: AppState): string {
  const inputs = buildSiteInputs(state);
  if (inputs.length === 0) return '<button type="button" class="btn btn-sm" data-export="site-gpkg" disabled title="Analyse a photo first">Site GeoPackage (all photos)</button>';
  const plan = siteGeoPackagePlan(inputs);
  const where =
    plan.coords === 'map'
      ? `in the photos' map coordinates, EPSG:${plan.srs.id}`
      : plan.coords === 'lonlat'
        ? 'in WGS84 longitude/latitude (the photos have different coordinate systems)'
        : 'in photo pixels (no photo is a GeoTIFF, so they overlap: filter by photo_id)';
  const left = plan.skipped.length > 0 ? ` Left out (cannot be placed on the map): ${plan.skipped.map((s) => s.label).join(', ')}.` : '';
  const title = `One GeoPackage for ArcGIS Pro, QGIS or any GIS: every analysed photo's grain outlines (with photo_id and included_in_stats)${plan.coords !== 'pixels' ? ' and each photo\'s footprint with its D16/D50/D84' : ''}, ${where}.${left}`;
  return `<button type="button" class="btn btn-sm" data-export="site-gpkg" title="${esc(title)}">Site GeoPackage (${plan.placed.length} photo${plan.placed.length === 1 ? '' : 's'})</button>`;
}

/** The outlines / mask / photo export: what, format and coordinates as choices, one Download button. */
function photoGeometryExportHtml(state: AppState, photo: PhotoRecord): string {
  const c = photoExportChoice(photo, { what: state.exportWhat, format: state.exportFormat, coords: state.exportCoords });
  const select = (name: string, label: string, options: Array<[string, string]>, value: string): string => `
      <label class="field-label" style="min-width:160px;">
        <span class="label-row">${label}</span>
        <select class="select" data-export-opt="${name}" ${options.length < 2 ? 'disabled' : ''}>
          ${options.map(([v, t]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </label>`;
  const { reason } = photoGeoreference(photo);
  return `
      <div style="font-weight:600;margin-top:10px;">Outlines, mask, photo</div>
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end;">
        ${select('what', 'Export', c.whats, c.what)}
        ${select('format', 'Format', c.formats, c.format)}
        ${select('coords', 'Coordinates', c.coordsList, c.coords)}
        <button type="button" class="btn btn-sm btn-primary" data-export="${c.kind}">Download</button>
      </div>
      <p class="field-hint" style="margin-top:4px;" data-export-hint>${esc(c.hint)}${reason ? ` ${esc(reason)}` : ''}</p>`;
}

/** Option shared by the Export and Download dialogs: outlines / masks of counted grains only. */
/** Printable report options: photo overlay and layout, optional sections. */
export function reportOptionsHtml(state: AppState, hasSiteReport: boolean): string {
  const o = state.reportOptions;
  const calibrated = state.siteReport?.unit === 'mm';
  const opt = (v: string, label: string, sel: boolean, disabled = false): string =>
    `<option value="${v}" ${sel ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${label}</option>`;
  const box = (key: string, label: string, on: boolean): string =>
    `<label class="checkbox-label"><input type="checkbox" data-report-opt="${key}" ${on ? 'checked' : ''} /> ${label}</label>`;
  return `<details class="advanced-block report-options" data-keep-open="report-options" style="margin-top:8px;">
      <summary>Printable report options <span class="summary-note">photo overlay, layout, sections</span></summary>
      <div class="report-options-grid" ${hasSiteReport ? '' : 'aria-disabled="true"'}>
        <label class="field-label">Grains on the photos
          <select class="select" data-report-opt="photoOverlay">
            ${opt('outlines', 'Outlines', o.photoOverlay === 'outlines')}
            ${opt('wentworth', `Size colours (Wentworth)${calibrated ? '' : ': needs a scale'}`, o.photoOverlay === 'wentworth', !calibrated && o.photoOverlay !== 'wentworth')}
            ${opt('counted', 'Counted vs not counted', o.photoOverlay === 'counted')}
            ${opt('none', 'None (photos only)', o.photoOverlay === 'none')}
          </select>
        </label>
        <label class="field-label">Photo size
          <select class="select" data-report-opt="photosPerRow">
            ${opt('2', 'Two per row', o.photosPerRow === 2)}
            ${opt('1', 'One per row (large)', o.photosPerRow === 1)}
          </select>
        </label>
        ${box('includePhotos', 'Photos', o.includePhotos)}
        ${box('includeShapeFabric', 'Grain shape and fabric charts', o.includeShapeFabric)}
        ${box('includeUncertainty', 'Convergence and photo-influence charts', o.includeUncertainty)}
      </div>
      <p class="field-hint">Remembered in this browser. Also used for the report in <em>Download results</em>.${o.photoOverlay === 'wentworth' && !calibrated ? ' Size colours need a scale: this site shows outlines instead.' : ''}</p>
    </details>`;
}

function countedOnlyCheckbox(id: string, checked: boolean): string {
  return `<label class="checkbox-label" style="margin-top:8px;">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
      <span>Outlines and masks: only the grains used in the statistics (recommended). The statistics leave out grains below the size cutoff, outside the ROI or touching the photo edge; ticked, these files leave them out too. Untick to export every detected grain. Grain tables always list every grain, with an <code>included_in_stats</code> column.</span>
    </label>`;
}

/** Download dialog: how many photos have outlines coarser than the photo, and the worst step. */
function coarseOutlineNote(state: AppState): string {
  let coarse = 0;
  let worst = 0;
  for (const p of state.photos) {
    const r = state.sessions.get(p.photoId)?.getOutlineResolution();
    if (r?.coarse) {
      coarse++;
      worst = Math.max(worst, r.stepPhotoPx);
    }
  }
  if (coarse === 0) return '';
  return `<div class="warning-banner" role="note" style="margin:8px 0;"><strong>Outlines are coarser than the photos.</strong> In ${coarse} photo${coarse === 1 ? '' : 's'} the outlines were traced on a smaller working copy, so masks and GeoJSON outlines are stepped at up to ${fmtNum(worst)} photo pixels. Re-analyse with <em>Scale Mode: 1.0x Full</em> for finer outlines.</div>`;
}

/** "Download results" dialog: what the .zip holds, and the optional project file (off by default). */
export function renderDownloadResultsModalHtml(state: AppState): string {
  const site = state.sites.find((x) => x.siteId === state.activeSiteId) ?? null;
  const analysed = state.photos.filter((p) => state.sessions.has(p.photoId)).length;
  let photoBytes = 0;
  for (const p of state.photos) {
    photoBytes += p.imageBlob.size + (p.originalBackup?.imageBlob.size ?? 0);
    photoBytes += (p.rectifyBackup?.imageBlob.size ?? 0) + (p.rectifyBackup?.originalBackup?.imageBlob.size ?? 0);
    // The project file also holds each analysed photo's label mask (4 bytes per working pixel).
    const wi = state.sessions.get(p.photoId)?.workingImage;
    if (wi) photoBytes += wi.width * wi.height * 4;
  }
  const mb = Math.max(1, Math.round(photoBytes / 1e6));
  const include = state.downloadIncludeProject;
  return `
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="dialog-title" class="modal-title">Download results${site ? `: ${esc(site.name)}` : ''}</h2>
        <button type="button" class="btn btn-sm" data-action="close-modal">Close</button>
      </div>
      <div class="modal-body" tabindex="0">
        <p>One .zip with every result file of this site (${analysed} analysed photo${analysed === 1 ? '' : 's'}): site summary (CSV and JSON), pooled grains, grain-size curve and printable report; for each photo its grains, summary, label mask and outlines; and a README describing the files.${
          state.photos.some((p) => state.sessions.has(p.photoId) && photoGeoreference(p).georef)
            ? ' GeoTIFF photos also get their outlines in map coordinates and a world file that places the mask on the map; the other files use photo pixels.'
            : ' Outline and mask coordinates are photo pixels, not map coordinates.'
        }</p>
        ${coarseOutlineNote(state)}
        ${countedOnlyCheckbox('download-counted-only', state.exportCountedOnly)}
        <label class="checkbox-label">
          <input type="checkbox" id="download-include-project" ${include ? 'checked' : ''} />
          Include the project file with the photos (about ${mb} MB more), to reopen this site in webGrainy later
        </label>
        <div class="warning-banner" role="note" style="margin-top:8px;">${
          include
            ? `The download will be about ${mb} MB larger: it contains the photos. Photos can include GPS locations, so take care when sharing the file.`
            : 'Without the project file, this site cannot be reopened in webGrainy once it is removed from this browser: only the result files are kept. Keep your original photos in your own folders.'
        }</div>
        <div class="row" style="margin-top:10px;justify-content:flex-end;gap:6px;">
          <button type="button" class="btn btn-sm btn-primary" data-action="download-results" ${analysed === 0 || state.downloadingResults ? 'disabled' : 'autofocus'}>${state.downloadingResults ? 'Preparing…' : 'Download .zip'}</button>
        </div>
      </div>
    </div>
  `;
}

export function renderExportModalHtml(state: AppState): string {
  const activeSite = state.sites.find((s) => s.siteId === state.activeSiteId) ?? null;
  const activePhoto = state.photos.find((p) => p.photoId === state.activePhotoId) ?? null;
  const activeSession = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;
  const hasSiteReport = state.siteReport !== null;

  const analysedIncludedCount = state.photos.filter(
    (p) => p.included && state.sessions.has(p.photoId),
  ).length;
  const siteDisabledReason = hasSiteReport
    ? null
    : state.siteReportError
      ? `Site exports unavailable: ${state.siteReportError}`
      : state.sessions.size === 0
        ? 'Analyse at least one photo to enable site-level exports.'
        : analysedIncludedCount === 0
          ? 'Tick the checkbox beside at least one analysed photo in the sidebar to include it in site exports.'
          : 'Site statistics are not available yet.';

  return `
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="dialog-title" class="modal-title">Export (files are made in your browser)</h2>
        <button type="button" class="btn btn-sm" data-action="close-modal" autofocus>Close</button>
      </div>
      <div class="modal-body" tabindex="0">
        <div class="stat-card" style="padding:10px;">
          <div style="font-weight:700;margin-bottom:6px;">Site-Level Exports (${activeSite ? esc(activeSite.name) : 'No Site'})</div>
          ${siteDisabledReason ? `<div class="warning-banner" style="margin-bottom:8px;">${esc(siteDisabledReason)}</div>` : ''}
          <div class="row" style="flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-primary" data-action="printable-report" ${hasSiteReport ? '' : 'disabled'} title="Printable site report (several pages) to print or save as PDF">Printable report</button>
            <button type="button" class="btn btn-sm btn-primary" data-export="site-summary-csv" ${hasSiteReport ? '' : 'disabled'}>Site Summary CSV</button>
            <button type="button" class="btn btn-sm" data-export="site-summary-json" ${hasSiteReport ? '' : 'disabled'}>Site Summary JSON</button>
            <button type="button" class="btn btn-sm" data-export="site-grains-csv" ${hasSiteReport ? '' : 'disabled'}>Pooled Grains CSV</button>
            <button type="button" class="btn btn-sm" data-export="site-psd-svg" ${hasSiteReport ? '' : 'disabled'}>Printable SVG PSD Figure</button>
            <button type="button" class="btn btn-sm" data-export="site-archive" ${activeSite ? '' : 'disabled'} title="The project file contains the photos, which can include GPS locations and camera details: take care when sharing it.">Export .webgrainy Archive</button>
            ${siteGpkgButtonHtml(state)}
          </div>
          ${reportOptionsHtml(state, hasSiteReport)}
        </div>

        <div class="stat-card" style="padding:10px;">
          <div style="font-weight:700;margin-bottom:6px;">Active Photo Exports (${activePhoto ? esc(activePhoto.label) : 'None Selected'})</div>
          <div class="row" style="flex-wrap:wrap;">
            <button type="button" class="btn btn-sm" data-export="photo-grains-csv" ${activeSession ? '' : 'disabled'}>Photo Grains CSV</button>
            <button type="button" class="btn btn-sm" data-export="photo-summary-csv" ${activeSession ? '' : 'disabled'}>Photo Summary CSV</button>
            <button type="button" class="btn btn-sm" data-export="photo-summary-json" ${activeSession ? '' : 'disabled'}>Photo Summary JSON</button>
          </div>
          ${activeSession && activePhoto ? photoGeometryExportHtml(state, activePhoto) : ''}
          ${activeSession || hasSiteReport ? countedOnlyCheckbox('export-counted-only', state.exportCountedOnly) : ''}
          ${outlineResolutionWarningHtml(activeSession)}
        </div>
      </div>
    </div>
  `;
}

export function renderAboutModalHtml(): string {
  return `
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="dialog-title" class="modal-title">About, Privacy &amp; Scientific Citations</h2>
        <button type="button" class="btn btn-sm" data-action="close-modal" autofocus>Close</button>
      </div>
      <div class="modal-body" tabindex="0">
        <div class="warning-banner" style="line-height:1.5;">
          <strong>Disclaimer &amp; Attribution:</strong> This is an <strong>independent, unofficial</strong> browser implementation and is <strong>not affiliated with, endorsed by, or maintained by</strong> the original ImageGrains or Cellpose authors. It is an independent effort to convert and quantize the pretrained weights into ONNX (<code>inYourOwnBrowser/imagegrains-2.0-onnx</code>) and build a browser-native processing pipeline around them. The architecture, post-processing, and workflows differ from the official Python library at <strong>dmair1989/imagegrains</strong>. Please cite the original authors' work below if you use these models or methods.
        </div>
        <div class="basis-banner" style="line-height:1.55;">
          <strong>Privacy, Hosting &amp; Network Connections:</strong>
          <ul style="margin:6px 0 0;padding-left:18px;">
            <li><strong>Local processing only:</strong> All photo loading, EXIF reading, grain segmentation, editing, and exports run 100% locally in your browser. Your photos and measurements are never uploaded to any server.</li>
            <li><strong>No cookies, analytics, or external fonts:</strong> webGrainy sets no cookies, uses no analytics or trackers, and loads no third-party fonts or scripts. Browser storage (<code>localStorage</code> and <code>IndexedDB</code>) is used only for your settings, cached models, and local projects.</li>
            <li><strong>GitHub Pages (hosting):</strong> This static web app is hosted on <strong>GitHub Pages</strong> (GitHub, Inc.), which processes standard web-server request information (such as your IP address) to deliver the app files to your browser.</li>
            <li><strong>Hugging Face (model downloads):</strong> Your browser connects to <strong>Hugging Face</strong> (<code>huggingface.co</code> / <code>*.hf.co</code>) <em>only</em> when you choose to download a model, run analysis, or run optional 2× upscaling (<code>inYourOwnBrowser/imagegrains-2.0-onnx</code>, <code>inYourOwnBrowser/PULSE</code> — MIT/CC-BY-4.0, pinned by SHA-256, with no cookies or referrer sent). Once downloaded, models are cached in your browser for offline use.</li>
          </ul>
        </div>
        <div class="stat-card" style="padding:10px;line-height:1.5;font-size:0.85rem;color:var(--text-secondary);">
          <strong style="color:var(--text-primary);">License &amp; No Warranty (BSD 3-Clause):</strong> webGrainy is free, open-source software provided <strong>"as is"</strong>, without warranty of any kind. Always inspect grain outlines and verify measurements before relying on them for engineering, regulatory, or published work.
          <a href="./LICENSE.txt" target="_blank" rel="noopener">Licence</a> · <a href="./THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener">Third-party notices</a> · <a href="./ort/ThirdPartyNotices.txt" target="_blank" rel="noopener">ONNX Runtime third-party notices</a>
        </div>
        <div>
          <div style="font-weight:700;margin-bottom:6px;">Scientific Citations (${FULL_SCIENTIFIC_CITATIONS.length} References)</div>
          <ol class="citations-list">
            ${FULL_SCIENTIFIC_CITATIONS.map(
              (c) => `<li><strong>${esc(c.title)}:</strong> ${esc(c.citation)}</li>`,
            ).join('')}
          </ol>
        </div>
      </div>
    </div>
  `;
}

export async function handleExportAction(
  kind: string,
  site: SiteRecord | null,
  photo: PhotoRecord | null,
  session: AnalysisSession | null,
  siteReport: SiteAnalysisReport | null,
  siteInputs: SitePhotoInput[],
  psdXAxis: 'mm' | 'phi',
  sizeMetric: SizeMetric = 'bAxis',
  siteOptions?: Partial<SiteAnalysisOptions>,
  countedGrainsOnly = false,
): Promise<boolean> {
  if (!isExportKind(kind)) return false;
  const file = await buildExport(kind, {
    ...(countedGrainsOnly ? { countedGrainsOnly: true } : {}),
    site,
    photo,
    session,
    siteReport,
    siteInputs,
    psdXAxis,
    sizeMetric,
    ...(siteOptions !== undefined ? { siteOptions } : {}),
    renderPsdSvg: renderPrintablePsdSvg,
    decodePhoto: (p) => decodePhotoRgba(p.imageBlob),
  });
  if (!file) return false;
  triggerBlobDownload(file.blob, file.filename);
  return true;
}
