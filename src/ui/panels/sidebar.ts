/** Left panel: getting-started guide, site, photo list and analysis settings. */
import { workingScaleFor } from '../../modules/imagePreprocess.js';
import { logicalCores, wasmThreadsFor } from '../../modules/onnxInference.js';
import { backupStatus, readBackupRecords } from '../backup.js';
import type { readCpuThreadPref } from '../cpuThreads.js';
import { helpButton } from '../help.js';
import { defaultAnalysisParams, type AppState } from '../state.js';
import type { ScaleMode } from '../../types/index.js';
import { getActivePhoto, getActiveSite } from '../workspaceActions.js';
import { earliestPhotoDate } from '../../modules/surveyDate.js';
import { getPhotoQualityWarnings } from '../../modules/photoQuality.js';
import { photoSummary, visiblePhotos } from '../photoList.js';
import { esc } from './html.js';

/** Effective working-resolution scale factor for a photo under the selected Scale Mode. */
export function workingScaleFactorFor(width: number, height: number, scaleMode: ScaleMode): number {
  // The analysis's own rule (it used to differ here for 1025-4096 px photos).
  return workingScaleFor(width, height, scaleMode);
}

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

export interface SidebarView {
  /** Getting-started guide HTML ('' when hidden). */
  guideHtml: string;
  /** Whether the Analysis settings block was open before this render. */
  settingsOpen: boolean;
  cpuThreadPref: ReturnType<typeof readCpuThreadPref>;
  cpuThreads: number | undefined;
  crossOriginIsolated: boolean;
  /** Notifications are available in this browser. */
  canNotify: boolean;
  /** The "notify me when done" option is on and permitted. */
  notifyWhenDone: boolean;
  storageInfo: StorageInfo | null;
}

export function renderSidebarHtml(state: AppState, view: SidebarView): string {
  const activeSite = getActiveSite(state);
  const p = state.analysisParams;
  const pendingCount = state.photos.filter((ph) => {
    const st = state.photoStatuses.get(ph.photoId);
    return !st || st === 'pending' || st === 'error';
  }).length;
  // Settings start collapsed (progressive disclosure); the summary says what is in use.
  const prevDetailsOpen = view.settingsOpen;
  const defaults = defaultAnalysisParams();
  const changedCount = (Object.keys(defaults) as Array<keyof typeof defaults>).filter((k) => p[k] !== defaults[k]).length;
  const modelSummary =
    p.model === 'auto' ? 'Auto model' : p.model === 'unet' ? 'U-Net' : `CP-SAM${p.cpsamWeights === 'auto' ? '' : ` ${p.cpsamWeights.toUpperCase()}`}`;
  const settingsSummary = `${modelSummary} · ${changedCount === 0 ? 'tested defaults' : `${changedCount} setting${changedCount === 1 ? '' : 's'} changed`}`;
  const analysedCount = state.photos.filter((ph) => state.photoStatuses.get(ph.photoId) === 'done').length;

  const guide = view.guideHtml;
  return `
    ${guide ? `<div class="panel-section">${guide}</div>` : ''}
    <div class="panel-section">
      <div class="panel-header">
        <span class="panel-title">Site</span>
        <div class="row">
          <button type="button" class="btn btn-sm" data-action="rename-site" title="Rename this site" ${activeSite ? '' : 'disabled'}>Rename</button>
          <button type="button" class="btn btn-sm" data-action="new-site" title="Create a new site">+ New</button>

          <button type="button" class="btn btn-sm" data-action="import-archive" title="Open a saved .webgrainy project">Open</button>
        </div>
      </div>
      <select class="select" id="site-select" aria-label="Select active field site">
        ${state.sites
          .map(
            (s) =>
              `<option value="${esc(s.siteId)}" ${s.siteId === activeSite?.siteId ? 'selected' : ''}>${esc(s.name)} (${s.photoOrder.length})</option>`,
          )
          .join('')}
      </select>
      ${surveyDateHtml(state)}
      ${backupLineHtml(state, analysedCount, view.storageInfo)}
      ${state.sites.length > 1 ? `<button type="button" class="btn btn-sm" style="margin-top:6px;width:100%;" data-action="analyse-all-sites" title="Analyse every photo that is not analysed yet, in all ${state.sites.length} sites" ${state.batchRunning || state.enhancing ? 'disabled' : ''}>Analyse all sites (${state.sites.length})</button>` : ''}
    </div>

    <div class="panel-section">
      <div class="panel-header">
        <span class="panel-title">Photos (${state.photos.length}${analysedCount > 0 ? ` · ${analysedCount} analysed` : ''})</span>
        <div class="row">
          ${
            state.photos.length > 1 && !state.batchRunning && !state.enhancing
              ? `<button type="button" class="btn btn-sm ${state.photoSelectMode ? 'active' : ''}" data-action="photo-select-mode" aria-pressed="${state.photoSelectMode ? 'true' : 'false'}" title="Select several photos to include, leave out, re-analyse or delete">${state.photoSelectMode ? 'Done' : 'Select'}</button>`
              : ''
          }
          ${
            state.batchRunning
              ? `<button type="button" class="btn btn-sm btn-danger" data-action="cancel-batch">Cancel</button>`
              : pendingCount > 0
                ? `<button type="button" class="btn btn-sm btn-primary" data-action="run-batch" ${state.enhancing ? 'disabled' : ''}>Analyse ${pendingCount === state.photos.length ? (pendingCount === 1 ? 'photo' : `all ${pendingCount}`) : `${pendingCount} new`}</button>`
                : ''
          }
        </div>
      </div>

      <button type="button" class="dropzone" id="photo-dropzone">
        <span class="dropzone-text">${state.photos.length === 0 ? '<strong>Add photos</strong> — tap to choose, or drop them here' : 'Add more photos — tap or drop here'}</span>
        <span style="display:block;font-size:0.65rem;color:var(--text-muted);margin-top:2px;">Photos stay on your device</span>
      </button>


      ${photoSummaryHtml(state)}
      ${state.photoSelectMode ? bulkBarHtml(state) : ''}
      <div class="photo-list" style="margin-top:8px;">
        ${
          state.photos.length === 0
            ? ''
            : visiblePhotos(state)
                .map((ph) => {
                  const status = state.photoStatuses.get(ph.photoId) ?? 'pending';
                  const sess = state.sessions.get(ph.photoId);
                  const recModel = sess?.recommendation.model;
                  const thumb = state.thumbUrls.get(ph.photoId) ?? '';
                  const isActive = ph.photoId === state.activePhotoId;
                  const errMsg = status === 'error' ? state.photoErrors.get(ph.photoId) ?? 'Analysis failed (no details reported).' : '';
                  const qualityWarnings = getPhotoQualityWarnings(ph.metadata);
                  return `
                    <div class="photo-item ${isActive ? 'active' : ''} ${state.photoSelectMode && state.selectedPhotoIds.has(ph.photoId) ? 'selected' : ''}">
                      ${
                        state.photoSelectMode
                          ? `<input type="checkbox" class="photo-select-box" data-select-photo="${esc(ph.photoId)}" ${state.selectedPhotoIds.has(ph.photoId) ? 'checked' : ''} aria-label="Select ${esc(ph.label)}" title="Select for a bulk action" />`
                          : `<input type="checkbox" data-toggle-include="${esc(ph.photoId)}" ${ph.included ? 'checked' : ''} aria-label="Include ${esc(ph.label)} in site aggregate" title="Include in site aggregate" />`
                      }
                      <button type="button" class="photo-select-btn" data-photo-id="${esc(ph.photoId)}" aria-current="${isActive ? 'true' : 'false'}">
                        <img class="photo-thumb" src="${thumb}" alt="" />
                        <span class="photo-meta">
                          <span class="photo-name" title="${esc(ph.label)}">${esc(ph.label)}</span>
                          <span class="photo-sub">
                            ${ph.width}×${ph.height}${ph.calibration ? ` · ${ph.calibration.mmPerPx.toFixed(3)}mm/px` : ' · uncal'}
                            ${recModel ? ` · ${recModel}` : ''}
                            ${ph.metadata?.enhancement ? ` · <span title="${esc(ph.metadata.enhancement.modelName)}">${ph.metadata.enhancement.kind === 'upscale-2x' ? '2×' : 'deblur'}</span>` : ''}
                            ${qualityWarnings.length > 0 ? ` · <span style="color:var(--warning);font-weight:500;" title="${esc(qualityWarnings.map((w) => w.message).join(' '))}">⚠ ${esc(qualityWarnings.map((w) => w.shortLabel).join(', '))}</span>` : ''}
                          </span>
                        </span>
                        <span class="badge ${status}"${errMsg ? ` title="${esc(errMsg)}"` : ''}>${status}</span>
                      </button>
                      ${
                        !state.photoSelectMode && !state.batchRunning
                          ? `<button type="button" class="photo-remove-btn" data-action="delete-photo" data-photo-id="${esc(ph.photoId)}" aria-label="Remove ${esc(ph.label)}" title="Remove photo from this site">×</button>`
                          : ''
                      }
                      ${errMsg ? `<div class="photo-error" role="alert">${esc(errMsg)}</div>` : ''}
                      ${
                        state.siteOptions.poolingMode === 'facies-weighted'
                          ? `<label class="photo-facies">Facies weight ${helpButton('faciesWeight')}
                              <input class="input" type="number" step="0.05" min="0" max="100" value="${ph.faciesWeight ?? 1}" data-photo-facies="${esc(ph.photoId)}" aria-label="Facies weight for ${esc(ph.label)}" />
                            </label>`
                          : ''
                      }
                    </div>
                  `;
                })
                .join('')
        }
      </div>
    </div>

    <div class="panel-section">
      <details class="settings-block" ${prevDetailsOpen ? 'open' : ''}>
        <summary>Analysis settings <span class="summary-note">${esc(settingsSummary)}</span></summary>
        <div class="row-between" style="margin-top:6px;">
          <span class="field-hint">The defaults are the tested settings. Changes apply to the next analysis.</span>
          <button type="button" class="btn btn-sm" data-open-help="">Settings help</button>
        </div>
        <div class="grid-2" style="margin-top:8px;">
          <label class="field-label">
            <span class="label-row">Model ${helpButton('model')}</span>
            <select class="select" data-param="model">
              <option value="auto" ${p.model === 'auto' ? 'selected' : ''}>Auto</option>
              <option value="unet" ${p.model === 'unet' ? 'selected' : ''}>U-Net (fast)</option>
              <option value="cpsam" ${p.model === 'cpsam' ? 'selected' : ''}>CP-SAM (accurate)${state.capabilities?.isMobile ? ' – not for phones' : ''}</option>
            </select>
          </label>
          ${
            p.model === 'unet'
              ? ''
              : `<label class="field-label">
            <span class="label-row">CP-SAM weights ${helpButton('cpsamWeights')}</span>
            <select class="select" data-param="cpsamWeights">
              <option value="auto" ${p.cpsamWeights === 'auto' ? 'selected' : ''}>Auto</option>
              <option value="fp16" ${p.cpsamWeights === 'fp16' ? 'selected' : ''}>FP16 (617 MB)</option>
              <option value="int8" ${p.cpsamWeights === 'int8' ? 'selected' : ''}>INT8 (316 MB)</option>
              <option value="fp4" ${p.cpsamWeights === 'fp4' ? 'selected' : ''}>FP4 (183 MB)</option>
            </select>
          </label>`
          }
          <label class="field-label">
            <span class="label-row">Scale Mode ${helpButton('scaleMode')}</span>
            <select class="select" data-param="scaleMode">
              <option value="auto" ${p.scaleMode === 'auto' ? 'selected' : ''}>Auto (≤1024px)</option>
              <option value="1.0x" ${p.scaleMode === '1.0x' ? 'selected' : ''}>1.0x Full</option>
              <option value="0.5x" ${p.scaleMode === '0.5x' ? 'selected' : ''}>0.5x</option>
              <option value="0.25x" ${p.scaleMode === '0.25x' ? 'selected' : ''}>0.25x</option>
            </select>
          </label>
        </div>
        <label class="checkbox-label" style="margin-top:8px;">
          <input type="checkbox" data-param="excludeBorder" ${p.excludeBorder ? 'checked' : ''} /> Exclude border grains ${helpButton('excludeBorder')}
        </label>
        <details class="advanced-block" style="margin-top:8px;" data-keep-open="fine-tuning">
          <summary>Fine-tuning</summary>
          <div class="grid-2" style="margin-top:6px;">
          <label class="field-label">
            <span class="label-row">Flow Threshold ${helpButton('flowThreshold')}</span>
            <input class="input" type="number" step="0.05" min="0.05" max="1" value="${p.flowThreshold}" data-param="flowThreshold" />
          </label>
          <label class="field-label">
            <span class="label-row">Cellprob Thresh ${helpButton('cellprobThreshold')}</span>
            <input class="input" type="number" step="0.1" min="-4" max="4" value="${p.cellprobThreshold}" data-param="cellprobThreshold" />
          </label>
          <label class="field-label">
            <span class="label-row">Min Size (px²) ${helpButton('minSize')}</span>
            <input class="input" type="number" step="1" min="4" max="500" value="${p.minSize}" data-param="minSize" />
          </label>
          ${(() => {
            const activePhoto = getActivePhoto(state);
            const cal = activePhoto?.calibration;
            if (!activePhoto || !cal || !Number.isFinite(cal.mmPerPx) || cal.mmPerPx <= 0) return '';
            const wScale = workingScaleFactorFor(activePhoto.width, activePhoto.height, p.scaleMode);
            const mmPerWorkPx = cal.mmPerPx / wScale;
            const minSizeMm2 = p.minSize * mmPerWorkPx * mmPerWorkPx;
            const eqDiamMm = 2 * Math.sqrt(minSizeMm2 / Math.PI);
            const stepMm2 = minSizeMm2 < 1 ? 0.05 : minSizeMm2 < 10 ? 0.5 : minSizeMm2 < 100 ? 1 : 5;
            const fmtMm2 = minSizeMm2 < 1 ? minSizeMm2.toFixed(2) : minSizeMm2 < 10 ? minSizeMm2.toFixed(1) : String(Math.round(minSizeMm2));
            return `<label class="field-label">
              <span class="label-row">Min Size (mm²)</span>
              <input class="input" type="number" step="${stepMm2}" min="0.01" value="${fmtMm2}" data-min-size-mm2="" title="Converted to working-resolution px² using the active photo's scale (${cal.mmPerPx.toFixed(3)} mm/px)" />
              <span class="field-hint">≈ Ø ${eqDiamMm.toFixed(1)} mm</span>
            </label>`;
          })()}
          <label class="field-label">
            <span class="label-row">Max Area Frac ${helpButton('maxGrainAreaFraction')}</span>
            <input class="input" type="number" step="0.01" min="0.01" max="1" value="${p.maxGrainAreaFraction}" data-param="maxGrainAreaFraction" />
          </label>
          <label class="field-label">
            <span class="label-row">Border margin (px) ${helpButton('excludeBorderMargin')}</span>
            <input class="input" type="number" step="1" min="0" max="100" value="${p.excludeBorderMargin}" data-param="excludeBorderMargin" />
          </label>
          </div>
          <p class="field-hint" style="margin-top:6px;">Min Size removes tiny noise blobs during segmentation (re-analyse to apply). To filter small grains from the PSD live, use Results → Statistics settings.</p>
        </details>
        <details class="advanced-block" style="margin-top:8px;" data-keep-open="advanced-analysis">
          <summary>Advanced (rarely needed)</summary>
          <div class="grid-2" style="margin-top:6px;">
            <label class="field-label">
              <span class="label-row">Flow steps ${helpButton('niter')}</span>
              <input class="input" type="number" step="10" min="50" max="1000" value="${p.niter}" data-param="niter" />
            </label>
            <label class="field-label" style="grid-column: 1 / -1;">
              <span class="label-row">Inference pipeline ${helpButton('inferencePipeline')}</span>
              <select class="select" data-param="inferencePipeline">
                <option value="cellpose" ${p.inferencePipeline === 'cellpose' ? 'selected' : ''}>Cellpose (matches ImageGrains)</option>
                <option value="legacy" ${p.inferencePipeline === 'legacy' ? 'selected' : ''}>Legacy (webGrainy ≤ v1.1)</option>
              </select>
            </label>
            <label class="field-label">
              <span class="label-row">Seed density ${helpButton('minSeedDensity')}</span>
              <input class="input" type="number" step="1" min="1" max="20" value="${p.minSeedDensity}" data-param="minSeedDensity" />
            </label>
          </div>
          ${(() => {
            const cores = logicalCores();
            const auto = wasmThreadsFor('auto');
            const opts = cores === undefined ? [] : Array.from({ length: cores }, (_, i) => i + 1);
            return `<label class="field-label" style="margin-top:6px;">
              <span class="label-row">CPU threads ${helpButton('cpuThreads')}</span>
              <select class="select" data-cpu-threads="">
                <option value="auto" ${view.cpuThreadPref === 'auto' ? 'selected' : ''}>Auto${auto !== undefined ? ` (${auto} of ${cores})` : ''}</option>
                ${opts.map((n) => `<option value="${n}" ${view.cpuThreadPref === n ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
              ${view.crossOriginIsolated ? '' : '<span class="field-hint">Multi-threading is unavailable on this page (not cross-origin isolated): the CPU uses 1 thread.</span>'}
            </label>`;
          })()}
          ${
            view.canNotify
              ? `<label class="checkbox-label" style="margin-top:6px;">
                  <input type="checkbox" data-notify-done="" ${view.notifyWhenDone ? 'checked' : ''} /> Notify me when a long analysis finishes ${helpButton('notifyWhenDone')}
                </label>`
              : ''
          }
          <label class="checkbox-label" style="margin-top:6px;">
            <input type="checkbox" data-param="skipTilesOutsideRoi" ${p.skipTilesOutsideRoi ? 'checked' : ''} /> Skip areas outside the ROI (faster) ${helpButton('skipTilesOutsideRoi')}
          </label>
          <div class="clahe-block" style="margin-top:8px;">
            <label class="checkbox-label">
              <input type="checkbox" data-param="applyClahe" ${p.applyClahe ? 'checked' : ''} /> Apply CLAHE (contrast boost) ${helpButton('applyClahe')}
            </label>
            <span class="field-hint">Not recommended: it lowered accuracy with both models in testing.</span>
            ${
              p.applyClahe
                ? `<label class="field-label" style="margin-top:4px;">
                    <span class="label-row">CLAHE clip ${helpButton('claheClipLimit')}</span>
                    <input class="input" type="number" step="0.5" min="1" max="8" value="${p.claheClipLimit}" data-param="claheClipLimit" />
                  </label>`
                : ''
            }
          </div>
          <span class="field-hint" style="margin-top:6px;">Settings are remembered in this browser for your next visit.</span>
          <button type="button" class="btn btn-sm" data-action="reset-analysis-params" style="margin-top:6px;">Reset analysis settings to defaults</button>
        </details>
        <button type="button" class="btn btn-sm" data-action="run-active" style="margin-top:8px;" ${!state.activePhotoId || state.batchRunning || state.enhancing ? 'disabled' : ''} title="Re-analyse the photo shown in the middle with these settings">Re-analyse this photo</button>
      </details>
    </div>
  `;
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

/** "Last backed up" line with a Back up now button, and the browser storage status. */
export function backupLineHtml(state: AppState, analysedCount: number, storageInfo: StorageInfo | null): string {
  const site = getActiveSite(state);
  if (!site) return '';
  const status = backupStatus(readBackupRecords()[site.siteId], analysedCount > 0);
  const storage = storageInfo
    ? `<span class="field-hint">Browser storage: ${formatBytes(storageInfo.usage)} used${storageInfo.quota > 0 ? ` of ${formatBytes(storageInfo.quota)}` : ''} · ${
        storageInfo.persisted ? 'protected from automatic clearing' : 'the browser may clear it if space runs low'
      } ${helpButton('backup')}</span>`
    : '';
  if (analysedCount === 0 && status.backedUpAt === null) return storage ? `<div class="backup-line">${storage}</div>` : '';
  return `<div class="backup-line ${status.needsBackup ? 'needs-backup' : ''}">
    <div class="row" style="justify-content:space-between;gap:6px;">
      <span>${status.needsBackup ? '⚠ ' : ''}Last backed up: ${esc(status.ago)}${status.needsBackup && status.backedUpAt !== null ? ' (changed since)' : ''}</span>
      <button type="button" class="btn btn-sm ${status.needsBackup ? 'btn-primary' : ''}" data-export="site-archive" title="Save this site (photos and results) as a .webgrainy project file">Back up now</button>
    </div>
    ${status.needsBackup ? '<span class="field-hint">Your work is stored only in this browser. Save a project file to keep it safe or move it to another computer.</span>' : ''}
    ${storage}
  </div>`;
}

/** "8 photos · 6 analysed · 2 not calibrated · 1 failed": each part filters the list. */
export function photoSummaryHtml(state: AppState): string {
  if (state.photos.length < 2) return '';
  const parts = photoSummary(state);
  const shown = visiblePhotos(state).length;
  return `<div class="photo-summary" role="group" aria-label="Filter photos">
    ${parts
      .map(
        (p) =>
          `<button type="button" class="link-btn ${state.photoFilter === p.filter ? 'active' : ''} ${p.filter === 'failed' ? 'danger' : ''}" data-action="photo-filter" data-filter="${p.filter}" aria-pressed="${state.photoFilter === p.filter ? 'true' : 'false'}" title="${p.filter === 'all' ? 'Show all photos' : `Show only these photos`}">${esc(p.label)}</button>`,
      )
      .join('<span aria-hidden="true"> · </span>')}
    ${state.photoFilter !== 'all' ? `<span class="summary-note">Showing ${shown} — <button type="button" class="link-btn" data-action="photo-filter" data-filter="all">show all</button></span>` : ''}
  </div>`;
}

/** Bulk actions for the photos selected in select mode. */
export function bulkBarHtml(state: AppState): string {
  const n = state.selectedPhotoIds.size;
  const dis = n === 0 || state.batchRunning || state.enhancing ? 'disabled' : '';
  const scaleSource = state.scaleCopySourceId ? state.photos.find((p) => p.photoId === state.scaleCopySourceId) : undefined;
  if (scaleSource?.calibration) {
    return `<div class="bulk-bar" role="group" aria-label="Copy scale to selected photos">
    <span>Copy the scale of <strong>${esc(scaleSource.label)}</strong> (${scaleSource.calibration.mmPerPx.toPrecision(4)} mm/px) to ${n} selected photo${n === 1 ? '' : 's'}. Pre-selected: same pixel size, no scale yet. Only use it for photos taken with the same camera, zoom and height.</span>
    <button type="button" class="btn btn-xs btn-primary" data-action="copy-scale-apply" ${dis}>Copy scale</button>
    <button type="button" class="btn btn-xs" data-action="photo-select-mode">Cancel</button>
  </div>`;
  }
  return `<div class="bulk-bar" role="group" aria-label="Actions for selected photos">
    <span>${n} selected</span>
    <button type="button" class="btn btn-xs" data-action="photo-select-all">${n > 0 && n === visiblePhotos(state).length ? 'Select none' : 'Select all shown'}</button>
    <button type="button" class="btn btn-xs" data-action="photo-bulk" data-bulk="include" ${dis}>Include</button>
    <button type="button" class="btn btn-xs" data-action="photo-bulk" data-bulk="exclude" ${dis}>Leave out</button>
    <button type="button" class="btn btn-xs" data-action="photo-bulk" data-bulk="reanalyse" ${dis}>Re-analyse</button>
    <button type="button" class="btn btn-xs btn-danger" data-action="photo-bulk" data-bulk="delete" ${dis}>Delete…</button>
  </div>`;
}

/** Survey date of the open site: entered, or the earliest photo date as a placeholder. */
export function surveyDateHtml(state: AppState): string {
  const site = getActiveSite(state);
  if (!site) return '';
  const fromPhotos = earliestPhotoDate(state.photos.map((p) => p.metadata?.timestamp));
  return `<label class="field-label survey-date" style="margin-top:6px;">
    <span class="label-row">Survey date ${helpButton('surveyDate')}</span>
    <input class="input" type="date" data-site-date="" value="${esc(site.surveyDate ?? '')}" aria-label="Survey date of this site" />
    <span class="field-hint">${site.surveyDate ? 'Entered by you.' : fromPhotos ? `Not set: the photos' date (${esc(fromPhotos)}) is used.` : 'Not set (the photos have no camera date).'}</span>
  </label>`;
}
