import type { ModelId, StorageQuotaInfo } from '../types/index.js';
import type { AnalysisSession } from '../modules/pipelineController.js';
import type { PhotoRecord, SiteRecord } from '../modules/projectStorage.js';
import type { SiteAnalysisReport, SitePhotoInput } from '../modules/siteAnalysis.js';
import {
  exportSiteGrainsCsv,
  exportSiteSummaryCsv,
  exportSiteSummaryJson,
} from '../modules/siteAnalysis.js';
import {
  exportGeoJsonContours,
  exportSvgContours,
} from '../modules/sedimentStats.js';
import { exportSiteArchive } from '../modules/projectStorage.js';
import { renderPrintablePsdSvg } from './charts.js';
import type { AppState } from './state.js';

export const FULL_SCIENTIFIC_CITATIONS: ReadonlyArray<{ title: string; citation: string }> = [
  {
    title: '1. ImageGrains 2.0',
    citation:
      'Mair, D., Witz, G., Do Prado, A., Garefalakis, P., Wild, A., Ville, F., Schuster, B., Horn, M., Österle, J., Fabbri, S. C., Litty, C., Achleitner, S., Leistner, S., Hiller, C., & Schlunegger, F. (2026). ImageGrains 2.0: Improved precision and generalization for grain segmentation. Earth Surface Dynamics, 14, 527–551. https://doi.org/10.5194/esurf-14-527-2026',
  },
  {
    title: '2. ImageGrains 1.0',
    citation:
      'Mair, D., Witz, G., Do Prado, A. H., Garefalakis, P., & Schlunegger, F. (2023/2024). Automated detecting, segmenting and measuring of grains in images of fluvial sediments: The potential for large and precise data from specialist deep learning models and transfer learning. Earth Surface Processes and Landforms, 49(3), 1099–1116. https://doi.org/10.1002/esp.5755',
  },
  {
    title: '3. Cellpose-SAM',
    citation:
      'Pachitariu, M., Rariden, M., & Stringer, C. (2025). Cellpose-SAM: superhuman generalization for cellular segmentation. bioRxiv 2025.04.28.651001. https://doi.org/10.1101/2025.04.28.651001',
  },
  {
    title: '4. Cellpose 1.0',
    citation:
      'Stringer, C., Wang, T., Michaelos, M., & Pachitariu, M. (2021). Cellpose: a generalist algorithm for cellular segmentation. Nature Methods, 18, 100–106. https://doi.org/10.1038/s41592-020-01018-x',
  },
  {
    title: '5. Photo-Sieving Uncertainty & Cluster Bootstrapping',
    citation:
      'Mair, D., Do Prado, A. H., Garefalakis, P., Lechmann, A., Whittaker, A., & Schlunegger, F. (2022). Grain size of fluvial gravel bars from close-range UAV imagery—uncertainty in segmentation-based data. Earth Surface Dynamics, 10, 953–973. https://doi.org/10.5194/esurf-10-953-2022',
  },
  {
    title: '6. GSDtools (Binomial Percentile CIs)',
    citation:
      'Eaton, B. C., Moore, R. D., & MacKenzie, L. G. (2019). Percentile-based grain size distribution analysis tools (GSDtools) – estimating confidence limits and hypothesis tests for comparing two samples. Earth Surface Dynamics, 7, 789–806. https://doi.org/10.5194/esurf-7-789-2019',
  },
  {
    title: '7. BASEGRAIN',
    citation:
      'Detert, M., & Weitbrecht, V. (2012). Automatic object detection to analyze the geometry of gravel grains – a free stand-alone tool. In R. M. Muños (Ed.), River Flow 2012 (pp. 595–600). Taylor & Francis Group, London. (Also Detert & Weitbrecht 2013, Advances in Science and Research, 1789–1795.)',
  },
  {
    title: '8. PebbleCounts',
    citation:
      'Purinton, B., & Bookhagen, B. (2019). Introducing PebbleCounts: a grain-sizing tool for photo surveys of dynamic gravel-bed rivers. Earth Surface Dynamics, 7, 859–877. https://doi.org/10.5194/esurf-7-859-2019',
  },
  {
    title: '9. Segmenteverygrain',
    citation:
      'Sylvester, Z., Stockli, D. F., Howes, N., Roberts, K., Malkowski, M., & Covault, J. (2025). Segmenteverygrain: A Python module for segmentation of grains in images. Journal of Open Source Software, 10(112), 7953. https://doi.org/10.21105/joss.07953',
  },
  {
    title: '10. Wolman Pebble Count',
    citation:
      'Wolman, M. G. (1954). A method of sampling coarse river-bed material. Eos, Transactions American Geophysical Union, 35(6), 951–956. https://doi.org/10.1029/TR035i006p00951',
  },
  {
    title: '11. Surface Sampling Equivalency',
    citation:
      'Kellerhals, R., & Bray, D. I. (1971). Sampling procedures for coarse fluvial sediments. Journal of the Hydraulics Division, ASCE, 97(HY8), 1165–1180. https://doi.org/10.1061/JYCEAJ.0003044',
  },
  {
    title: '12. Gravel-Bed Sampling Guidelines',
    citation:
      'Bunte, K., & Abt, S. R. (2001). Sampling surface and subsurface particle-size distributions in wadable gravel- and cobble-bed streams for analyses in sediment transport, hydraulics, and streambed monitoring. Gen. Tech. Rep. RMRS-GTR-74, USDA Forest Service. https://doi.org/10.2737/RMRS-GTR-74',
  },
  {
    title: '13. Photo-Sieving Methodology & Accuracy',
    citation:
      'Graham, D. J., Reid, I., & Rice, S. P. (2005a), Mathematical Geology 37(1), 1–28; Graham, D. J., Rice, S. P., & Reid, I. (2005b), Water Resources Research 41, W07020; Graham, D. J., Rollet, A.-J., Piégay, H., & Rice, S. P. (2010), Water Resources Research 46, W02508.',
  },
  {
    title: '14. Folk & Ward Graphic Statistics',
    citation:
      'Folk, R. L., & Ward, W. C. (1957). Brazos River bar: a study in the significance of grain size parameters. Journal of Sedimentary Petrology, 27(1), 3–26.',
  },
  {
    title: '15. Wentworth & Coarse Clast Scale',
    citation:
      'Wentworth, C. K. (1922). A scale of grade and class terms for clastic sediments. The Journal of Geology, 30(5), 377–392; Blair, T. C., & McPherson, J. G. (1999). Journal of Sedimentary Research, 69(1), 6–19.',
  },
  {
    title: '16. Directional / Axial Fabric Statistics',
    citation:
      'Curray, J. R. (1956). The analysis of two-dimensional orientation data. The Journal of Geology, 64(2), 117–131; Mardia, K. V., & Jupp, P. E. (2000). Directional Statistics. Wiley.',
  },
];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
      sizeLabel: '25.3 MB (FP32)',
      desc: 'Recommended for mobile, CPU WASM, or quick field previews. 16-px reflection padding.',
    },
    {
      id: 'ig2_cpsam_fp16',
      title: 'Cellpose-SAM (High Accuracy) — ig2_cpsam_fp16.onnx',
      sizeLabel: '~588 MB (Native FP16)',
      desc: 'Recommended for desktop WebGPU & complex cobble/shadowed scenes. 256×256 Hanning-tapered tiles.',
    },
  ];

  const quotaPct =
    quota && quota.quotaBytes > 0
      ? Math.min(100, (quota.usageBytes / quota.quotaBytes) * 100)
      : 0;

  return `
    <div class="modal-backdrop" data-modal-backdrop="true">
      <div class="modal-card" role="dialog" aria-label="Model Manager">
        <div class="modal-header">
          <span>Offline ONNX Model Cache (IndexedDB: imagegrains-onnx-cache-v1)</span>
          <button class="btn btn-sm" data-action="close-modal">Close</button>
        </div>
        <div class="modal-body">
          <div class="basis-banner">
            Models are streamed client-side from <code>inYourOwnBrowser/imagegrains-2.0-onnx</code> on Hugging Face and cached locally in IndexedDB for offline use. User photos never leave your device.
          </div>
          ${
            quota
              ? `<div>
                  <div class="row-between" style="font-size:11px;margin-bottom:4px;">
                    <span>Browser Storage Quota</span>
                    <span>${formatBytes(quota.usageBytes)} used / ${formatBytes(quota.quotaBytes)} (${formatBytes(quota.availableBytes)} free)</span>
                  </div>
                  <div class="progress-bar"><div class="progress-fill" style="width:${quotaPct.toFixed(1)}%"></div></div>
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
                      <div style="font-weight:700;">${m.title}</div>
                      <div style="font-size:11px;color:var(--text-secondary);">${m.sizeLabel} — ${m.desc}</div>
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
                          <div class="row-between" style="font-size:11px;margin-bottom:4px;">
                            <span>Downloading… ${dl.percent.toFixed(1)}%</span>
                            <span>${formatBytes(dl.loadedBytes)} / ${formatBytes(dl.totalBytes)} (${dl.speedMBps.toFixed(2)} MB/s)</span>
                          </div>
                          <div class="progress-bar"><div class="progress-fill" style="width:${dl.percent.toFixed(1)}%"></div></div>
                        </div>`
                      : ''
                  }
                  ${
                    dl?.error
                      ? `<div class="warning-banner">${dl.error}</div>`
                      : ''
                  }
                  <div class="row" style="margin-top:8px;">
                    ${
                      dl?.active
                        ? `<button class="btn btn-sm btn-danger" data-action="cancel-model-dl" data-model-id="${m.id}">Cancel Download</button>`
                        : `<button class="btn btn-sm btn-primary" data-action="download-model" data-model-id="${m.id}">${cached ? 'Re-download' : 'Download & Cache'}</button>`
                    }
                    ${
                      cached && !dl?.active
                        ? `<button class="btn btn-sm btn-danger" data-action="delete-model" data-model-id="${m.id}">Delete</button>`
                        : ''
                    }
                  </div>
                </div>
              `;
            })
            .join('')}
          <div class="row-between">
            <span style="font-size:11px;color:var(--text-secondary);">Clearing model cache preserves all Sites &amp; Photos in <code>imagegrains-projects-v1</code>.</span>
            <button class="btn btn-sm btn-danger" data-action="clear-model-cache">Clear All Cached Models</button>
          </div>
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

  return `
    <div class="modal-backdrop" data-modal-backdrop="true">
      <div class="modal-card" role="dialog" aria-label="Export Data">
        <div class="modal-header">
          <span>Client-Side Export Drawer (100% Local Blob Downloads)</span>
          <button class="btn btn-sm" data-action="close-modal">Close</button>
        </div>
        <div class="modal-body">
          <div class="stat-card" style="padding:10px;">
            <div style="font-weight:700;margin-bottom:6px;">Site-Level Exports (${activeSite ? activeSite.name : 'No Site'})</div>
            <div class="row" style="flex-wrap:wrap;">
              <button class="btn btn-sm btn-primary" data-export="site-summary-csv" ${hasSiteReport ? '' : 'disabled'}>Site Summary CSV</button>
              <button class="btn btn-sm" data-export="site-summary-json" ${hasSiteReport ? '' : 'disabled'}>Site Summary JSON</button>
              <button class="btn btn-sm" data-export="site-grains-csv" ${hasSiteReport ? '' : 'disabled'}>Pooled Grains CSV</button>
              <button class="btn btn-sm" data-export="site-psd-svg" ${hasSiteReport ? '' : 'disabled'}>Printable SVG PSD Figure</button>
              <button class="btn btn-sm" data-export="site-archive" ${activeSite ? '' : 'disabled'}>Export .webgrainy.json Archive</button>
            </div>
          </div>

          <div class="stat-card" style="padding:10px;">
            <div style="font-weight:700;margin-bottom:6px;">Active Photo Exports (${activePhoto ? activePhoto.label : 'None Selected'})</div>
            <div class="row" style="flex-wrap:wrap;">
              <button class="btn btn-sm" data-export="photo-grains-csv" ${activeSession ? '' : 'disabled'}>Photo Grains CSV</button>
              <button class="btn btn-sm" data-export="photo-summary-csv" ${activeSession ? '' : 'disabled'}>Photo Summary CSV</button>
              <button class="btn btn-sm" data-export="photo-summary-json" ${activeSession ? '' : 'disabled'}>Photo Summary JSON</button>
              <button class="btn btn-sm" data-export="photo-mask-16" ${activeSession ? '' : 'disabled'}>16-bit PNG Mask</button>
              <button class="btn btn-sm" data-export="photo-mask-32" ${activeSession ? '' : 'disabled'}>32-bit PNG Mask</button>
              <button class="btn btn-sm" data-export="photo-geojson" ${activeSession ? '' : 'disabled'}>GeoJSON Contours</button>
              <button class="btn btn-sm" data-export="photo-svg" ${activeSession ? '' : 'disabled'}>SVG Contours</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderAboutModalHtml(): string {
  return `
    <div class="modal-backdrop" data-modal-backdrop="true">
      <div class="modal-card" role="dialog" aria-label="About and Citations">
        <div class="modal-header">
          <span>About webGrainy &amp; Scientific Citations</span>
          <button class="btn btn-sm" data-action="close-modal">Close</button>
        </div>
        <div class="modal-body">
          <div class="warning-banner" style="line-height:1.5;">
            <strong>Disclaimer &amp; Attribution:</strong> This is an <strong>independent, unofficial</strong> browser implementation and is <strong>not affiliated with, endorsed by, or maintained by</strong> the original ImageGrains or Cellpose authors. It is an independent effort to convert and package the pretrained weights into ONNX (<code>inYourOwnBrowser/imagegrains-2.0-onnx</code>) and build a browser-native processing pipeline around them. The architecture, post-processing, and workflows differ from the official Python library at <strong>dmair1989/imagegrains</strong>. Please cite the original authors' work below if you use these models or methods.
          </div>
          <div class="basis-banner">
            <strong>Privacy &amp; Architecture:</strong> All image preprocessing, ONNX Runtime WebGPU/WASM inference, gradient flow integration, multigrid PDE post-processing, interactive editing, and multi-image statistical pooling execute 100% locally in your browser. Zero imagery or measurements leave your device.
          </div>
          <div>
            <div style="font-weight:700;margin-bottom:6px;">Scientific Citations (16 References)</div>
            <ol class="citations-list">
              ${FULL_SCIENTIFIC_CITATIONS.map(
                (c) => `<li><strong>${c.title}:</strong> ${c.citation}</li>`,
              ).join('')}
            </ol>
          </div>
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
): Promise<void> {
  const safeSite = (site?.name ?? 'site').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const safePhoto = (photo?.label ?? 'photo').replace(/[^a-zA-Z0-9_-]+/g, '_');

  switch (kind) {
    case 'site-summary-csv':
      if (siteReport) triggerBlobDownload(exportSiteSummaryCsv(siteReport), `${safeSite}_summary.csv`);
      break;
    case 'site-summary-json':
      if (siteReport) triggerBlobDownload(exportSiteSummaryJson(siteReport), `${safeSite}_summary.json`);
      break;
    case 'site-grains-csv':
      if (siteReport) triggerBlobDownload(exportSiteGrainsCsv(siteInputs, siteReport), `${safeSite}_pooled_grains.csv`);
      break;
    case 'site-psd-svg':
      if (siteReport) {
        const svg = renderPrintablePsdSvg(siteReport, site?.name ?? 'Site', psdXAxis);
        triggerBlobDownload(new Blob([svg], { type: 'image/svg+xml' }), `${safeSite}_psd.svg`);
      }
      break;
    case 'site-archive':
      if (site) {
        const blob = await exportSiteArchive(site.siteId);
        triggerBlobDownload(blob, `${safeSite}.webgrainy.json`);
      }
      break;
    case 'photo-grains-csv':
      if (session) {
        triggerBlobDownload(new Blob([session.exportCsv()], { type: 'text/csv' }), `${safePhoto}_grains.csv`);
      }
      break;
    case 'photo-summary-csv':
      if (session) {
        triggerBlobDownload(new Blob([session.exportSummaryCsv()], { type: 'text/csv' }), `${safePhoto}_summary.csv`);
      }
      break;
    case 'photo-summary-json':
      if (session) {
        triggerBlobDownload(new Blob([session.exportSummaryJson()], { type: 'application/json' }), `${safePhoto}_summary.json`);
      }
      break;
    case 'photo-mask-16':
      if (session) {
        const bytes = session.exportMaskPng(16);
        triggerBlobDownload(new Blob([bytes.slice().buffer], { type: 'image/png' }), `${safePhoto}_mask16.png`);
      }
      break;
    case 'photo-mask-32':
      if (session) {
        const bytes = session.exportMaskPng(32);
        triggerBlobDownload(new Blob([bytes.slice().buffer], { type: 'image/png' }), `${safePhoto}_mask32.png`);
      }
      break;
    case 'photo-geojson':
      if (session) {
        const wi = session.workingImage;
        const blob = exportGeoJsonContours(
          session.getWorkingMasks(),
          session.getWorkingGrains(),
          wi.width,
          wi.height,
        );
        triggerBlobDownload(blob, `${safePhoto}_contours.geojson`);
      }
      break;
    case 'photo-svg':
      if (session) {
        const wi = session.workingImage;
        const blob = exportSvgContours(
          session.getWorkingMasks(),
          session.getWorkingGrains(),
          wi.width,
          wi.height,
        );
        triggerBlobDownload(blob, `${safePhoto}_contours.svg`);
      }
      break;
  }
}
