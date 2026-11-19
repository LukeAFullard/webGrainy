import type { ModelId, SizeMetric, StorageQuotaInfo } from '../types/index.js';
import type { AnalysisSession } from '../modules/pipelineController.js';
import type { PhotoRecord, SiteRecord } from '../modules/projectStorage.js';
import type { SiteAnalysisOptions, SiteAnalysisReport, SitePhotoInput } from '../modules/siteAnalysis.js';
import { buildExport, isExportKind } from '../modules/exports.js';
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

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
      <div class="modal-body">
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
        <h2 id="dialog-title" class="modal-title">Client-Side Export Drawer (100% Local Blob Downloads)</h2>
        <button type="button" class="btn btn-sm" data-action="close-modal" autofocus>Close</button>
      </div>
      <div class="modal-body">
        <div class="stat-card" style="padding:10px;">
          <div style="font-weight:700;margin-bottom:6px;">Site-Level Exports (${activeSite ? esc(activeSite.name) : 'No Site'})</div>
          ${siteDisabledReason ? `<div class="warning-banner" style="margin-bottom:8px;">${esc(siteDisabledReason)}</div>` : ''}
          <div class="row" style="flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-primary" data-action="printable-report" ${hasSiteReport ? '' : 'disabled'} title="One-page summary to print or save as PDF">Printable report</button>
            <button type="button" class="btn btn-sm btn-primary" data-export="site-summary-csv" ${hasSiteReport ? '' : 'disabled'}>Site Summary CSV</button>
            <button type="button" class="btn btn-sm" data-export="site-summary-json" ${hasSiteReport ? '' : 'disabled'}>Site Summary JSON</button>
            <button type="button" class="btn btn-sm" data-export="site-grains-csv" ${hasSiteReport ? '' : 'disabled'}>Pooled Grains CSV</button>
            <button type="button" class="btn btn-sm" data-export="site-psd-svg" ${hasSiteReport ? '' : 'disabled'}>Printable SVG PSD Figure</button>
            <button type="button" class="btn btn-sm" data-export="site-archive" ${activeSite ? '' : 'disabled'}>Export .webgrainy Archive</button>
          </div>
        </div>

        <div class="stat-card" style="padding:10px;">
          <div style="font-weight:700;margin-bottom:6px;">Active Photo Exports (${activePhoto ? esc(activePhoto.label) : 'None Selected'})</div>
          <div class="row" style="flex-wrap:wrap;">
            <button type="button" class="btn btn-sm" data-export="photo-grains-csv" ${activeSession ? '' : 'disabled'}>Photo Grains CSV</button>
            <button type="button" class="btn btn-sm" data-export="photo-summary-csv" ${activeSession ? '' : 'disabled'}>Photo Summary CSV</button>
            <button type="button" class="btn btn-sm" data-export="photo-summary-json" ${activeSession ? '' : 'disabled'}>Photo Summary JSON</button>
            <button type="button" class="btn btn-sm" data-export="photo-mask-16" ${activeSession ? '' : 'disabled'}>16-bit PNG Mask</button>
            <button type="button" class="btn btn-sm" data-export="photo-mask-32" ${activeSession ? '' : 'disabled'}>32-bit PNG Mask</button>
            <button type="button" class="btn btn-sm" data-export="photo-geojson" ${activeSession ? '' : 'disabled'}>GeoJSON Contours</button>
            <button type="button" class="btn btn-sm" data-export="photo-svg" ${activeSession ? '' : 'disabled'}>SVG Contours</button>
          </div>
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
      <div class="modal-body">
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
        </div>
        <div>
          <div style="font-weight:700;margin-bottom:6px;">Scientific Citations (16 References)</div>
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
): Promise<boolean> {
  if (!isExportKind(kind)) return false;
  const file = await buildExport(kind, {
    site,
    photo,
    session,
    siteReport,
    siteInputs,
    psdXAxis,
    sizeMetric,
    ...(siteOptions !== undefined ? { siteOptions } : {}),
    renderPsdSvg: renderPrintablePsdSvg,
  });
  if (!file) return false;
  triggerBlobDownload(file.blob, file.filename);
  return true;
}
