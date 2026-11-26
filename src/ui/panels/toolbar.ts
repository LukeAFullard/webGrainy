/** Toolbar above the photo: tool groups, the Display menu and the active tool's prompt. */
import { photoUpscaleFactor } from '../../modules/imageEnhance.js';
import { helpButton } from '../help.js';
import type { AppState, EditorToolMode } from '../state.js';
import { getActivePhoto } from '../workspaceActions.js';
import { countFlagged, flaggedByReason, navGrainsFor, type NavGrain } from '../grainNav.js';
import { esc } from './html.js';

export function renderToolbarHtml(state: AppState): { toolbar: string; subToolbar: string } {
  const activePhoto = getActivePhoto(state);
  const session = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;
  const roiCfg = activePhoto?.roiConfig;
  const hasAreas = roiCfg !== undefined && (roiCfg.roiPolygon !== undefined || roiCfg.exclusionPolygons.length > 0 || roiCfg.exclusionStrokes.length > 0);

  // Tools grouped by task; grain-editing tools only appear once the photo has results.
  const groups: Array<{ label: string; tools: Array<{ id: EditorToolMode; label: string; title: string }> }> = [
    { label: '', tools: [{ id: 'inspect', label: 'Inspect', title: 'Tap or click a grain to see its measurements' }] },
    {
      label: 'Scale',
      tools: [
        { id: 'calibrate', label: 'Calibrate', title: 'Mark two points a known distance apart (ruler, quadrat) to get sizes in mm' },
        { id: 'rectify', label: 'Rectify', title: 'Correct a photo taken at an angle using four corners of a rectangle' },
      ],
    },
    {
      label: 'Areas',
      tools: [
        { id: 'roiPoly', label: 'ROI', title: 'Draw the sampling area (e.g. inside a quadrat): only grains inside it are counted. Drawing again replaces it.' },
        { id: 'excludePoly', label: 'Exclude', title: 'Draw a polygon around things to leave out (rulers, boots, water)' },
        { id: 'excludeBrush', label: 'Brush', title: 'Paint over things to leave out' },
      ],
    },
    ...(session
      ? [
          {
            label: 'Edit grains',
            tools: [
              { id: 'split' as EditorToolMode, label: 'Split', title: 'Draw a line across a grain to split it in two' },
              { id: 'merge' as EditorToolMode, label: 'Merge', title: 'Select grains that are really one stone, then press Merge' },
              { id: 'delete' as EditorToolMode, label: 'Delete', title: 'Tap or click a wrong outline to remove it' },
              { id: 'addPolygon' as EditorToolMode, label: 'Add', title: 'Draw the outline of a missed grain' },
            ],
          },
        ]
      : []),
  ];

  const toolbarHtml = `
    ${groups
      .map(
        (g) => `<span class="tool-group" role="group" ${g.label ? `aria-label="${g.label}"` : ''}>${g.label ? `<span class="tool-group-label">${g.label}</span>` : ''}${g.tools
          .map(
            (t) =>
              `<button type="button" class="btn btn-sm ${state.activeTool === t.id ? 'active' : ''}" aria-pressed="${state.activeTool === t.id ? 'true' : 'false'}" data-tool="${t.id}" title="${esc(t.title)}">${t.label}</button>`,
          )
          .join('')}</span>`,
      )
      .join('')}
    ${session ? `<button type="button" class="btn btn-sm" data-action="tidy-outlines" ${state.batchRunning || state.enhancing ? 'disabled' : ''} title="Every grain becomes one solid piece: detached fragments join the neighbouring grain they touch, become grains of their own (if at least Min size) or are removed; holes inside one grain are filled. Done after every analysis while Analysis settings → Tidy outlines after analysis is ticked (the default); use this for photos analysed without it. Undo restores.">Tidy outlines</button>${helpButton('tidyOutlines')}` : ''}
    ${helpButton('editing')}
    ${
      state.activeTool === 'merge' && state.selectedGrainIds.size >= 2
        ? `<button type="button" class="btn btn-sm btn-primary" data-action="commit-merge">Merge (${state.selectedGrainIds.size})</button>`
        : ''
    }
    ${
      state.activeTool === 'split' || state.activeTool === 'addPolygon' || state.activeTool === 'excludePoly' || state.activeTool === 'roiPoly'
        ? `<button type="button" class="btn btn-sm btn-primary" data-action="finish-shape" title="Same as double-click or Enter">Finish shape</button>
           <button type="button" class="btn btn-sm" data-action="cancel-shape" title="Same as Esc">Cancel shape</button>`
        : ''
    }
    ${
      (state.activeTool === 'roiPoly' || state.activeTool === 'excludePoly' || state.activeTool === 'excludeBrush') && hasAreas
        ? `<button type="button" class="btn btn-sm" data-action="clear-areas" title="Remove this photo's ROI and all exclusion areas">Clear areas</button>`
        : ''
    }
    <span class="tool-group">
      ${session ? `<button type="button" class="btn btn-sm" data-action="undo" ${session.canUndo ? '' : 'disabled'}>Undo</button>
      <button type="button" class="btn btn-sm" data-action="redo" ${session.canRedo ? '' : 'disabled'}>Redo</button>` : ''}
      <button type="button" class="btn btn-sm" data-action="fit-view" ${activePhoto ? '' : 'disabled'} title="Fit the photo to the view">Fit</button>
    </span>
    ${
      activePhoto?.rectifyBackup
        ? `<button type="button" class="btn btn-sm" data-action="rectify-undo" ${state.batchRunning || state.enhancing ? 'disabled' : ''} title="Restore the photo as it was before rectification (image, scale and areas); it then needs analysing again">Undo rectify</button>`
        : ''
    }
    ${
      activePhoto
        ? `<span class="tool-group" role="group" aria-label="Optional image enhancement">
            <span class="tool-group-label">Enhance</span>
            <button type="button" class="btn btn-sm" data-action="enhance-upscale" ${state.batchRunning || state.enhancing ? 'disabled' : ''} title="Experimental, not part of the accuracy benchmark: 2× AI upscale (PULSE, 1.4 MB). With Auto image scale most photos are shrunk back to about the same size, so the app refuses when it would not add working pixels. Recorded in every export.">2× Upscale</button>
            <button type="button" class="btn btn-sm" data-action="enhance-deblur" ${state.batchRunning || state.enhancing ? 'disabled' : ''} title="Experimental, not part of the accuracy benchmark: built-in Richardson–Lucy deblur (instant, 1-click Revert). Check outlines against the original. Recorded in every export.">Deblur</button>
            ${activePhoto.originalBackup ? `<button type="button" class="btn btn-sm" data-action="enhance-revert" ${state.batchRunning || state.enhancing ? 'disabled' : ''} title="Restore the original unenhanced photo">Revert</button>` : ''}
          </span>`
        : ''
    }
  `;

  const ov = state.overlays;
  let toolPrompt = '';
  if (state.activeTool === 'inspect' && session) {
    const nav = navGrainsFor(session);
    const flagged = countFlagged(nav);
    const none = flagged === 0 ? 'disabled' : '';
    const groups = flaggedByReason(nav).filter((g) => g.grains.length > 0);
    const item = (g: NavGrain): string =>
      `<button type="button" class="flag-item${state.inspectedGrainId === g.id ? ' active' : ''}" data-action="grain-nav" data-nav="goto" data-grain-id="${g.id}" title="Show grain #${g.id}">#${g.id}${g.aspectRatio !== undefined ? ` <span class="flag-meta">b/a ${g.aspectRatio.toFixed(2)}</span>` : ''}</button>`;
    toolPrompt = `
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span>Check grains:</span>
      <button type="button" class="btn btn-sm" data-action="grain-nav" data-nav="largest" title="Show the largest grain">Largest</button>
      <button type="button" class="btn btn-sm" data-action="grain-nav" data-nav="prevFlagged" title="Previous flagged grain: touching the edge, outside the ROI, or very elongated" aria-label="Previous flagged grain" ${none}>‹ Prev flagged</button>
      <button type="button" class="btn btn-sm" data-action="grain-nav" data-nav="flagged" title="Next flagged grain: touching the edge, outside the ROI, or very elongated" aria-label="Next flagged grain" ${none}>Next flagged ›</button>
      ${
        flagged > 0
          ? `<details class="flag-list" data-keep-open="flag-list">
              <summary>Flagged (${flagged})</summary>
              <div class="flag-groups">${groups
                .map((g) => `<div class="flag-group"><div class="flag-group-title">${esc(g.label)} <span class="flag-meta">(${g.grains.length})</span></div><div class="flag-items">${g.grains.map(item).join('')}</div></div>`)
                .join('')}</div>
            </details>`
          : '<span class="field-hint">No flagged grains</span>'
      }
    `;
  }
  if (state.activeTool === 'calibrate') {
    const preset = state.calibrationPreset ?? '100|mm';
    const calLen = state.calibrationLength ?? 100;
    const calUnit = state.calibrationUnit ?? 'mm';
    toolPrompt = `
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span>Calibrate (${state.pendingCalibrationPoints.length}/2 pts):</span>
      <select class="select" id="cal-preset" aria-label="Calibration reference preset" style="width:auto;padding:2px 6px;">
        <option value="100|mm" ${preset === '100|mm' ? 'selected' : ''}>100 mm Ruler</option>
        <option value="25|mm" ${preset === '25|mm' ? 'selected' : ''}>25 mm Coin</option>
        <option value="500|mm" ${preset === '500|mm' ? 'selected' : ''}>500 mm Quadrat</option>
        <option value="custom" ${preset === 'custom' ? 'selected' : ''}>Custom…</option>
      </select>
      <input class="input" id="cal-length" type="number" value="${calLen}" step="1" min="0.1" aria-label="Calibration length" style="width:65px;padding:2px 6px;" />
      <select class="select" id="cal-unit" aria-label="Calibration unit" style="width:auto;padding:2px 6px;">
        <option value="mm" ${calUnit === 'mm' ? 'selected' : ''}>mm</option>
        <option value="cm" ${calUnit === 'cm' ? 'selected' : ''}>cm</option>
      </select>
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span title="Type a scale you already know (from the camera set-up, survey report or orthophoto), instead of clicking two points">or known scale:</span>
      <input class="input" id="cal-scale-value" type="number" value="${state.calibrationScaleValue ?? ''}" step="any" min="0" placeholder="e.g. 0.25" aria-label="Known scale value" style="width:80px;padding:2px 6px;" />
      <select class="select" id="cal-scale-unit" aria-label="Known scale unit" style="width:auto;padding:2px 6px;">
        <option value="mmPerPx" ${state.calibrationScaleUnit === 'pxPerMm' ? '' : 'selected'}>mm/px</option>
        <option value="pxPerMm" ${state.calibrationScaleUnit === 'pxPerMm' ? 'selected' : ''}>px/mm</option>
      </select>
      <button type="button" class="btn btn-sm" data-action="cal-scale-apply" ${activePhoto ? '' : 'disabled'} title="Give the active photo this scale. It is per pixel of the photo as taken (before any 2× upscale).">Set scale</button>
      <button type="button" class="btn btn-sm" data-action="copy-scale-start" ${activePhoto?.calibration ? '' : 'disabled'} title="Choose photos taken with the same camera and height, and give them this photo's scale">Copy scale to photos…</button>
    `;
  } else if (state.activeTool === 'rectify') {
    const rectW = state.rectifyWidthMm ?? 500;
    const rectH = state.rectifyHeightMm ?? 500;
    toolPrompt = `
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span>4-Pt Rectify (${state.pendingRectifyPoints.length}/4 TL→TR→BR→BL):</span>
      <input class="input" id="rect-w" type="number" value="${rectW}" step="10" min="10" aria-label="Rectification physical width in mm" style="width:60px;padding:2px 6px;" title="Width (mm)" />×
      <input class="input" id="rect-h" type="number" value="${rectH}" step="10" min="10" aria-label="Rectification physical height in mm" style="width:60px;padding:2px 6px;" title="Height (mm)" />mm
      <span class="field-hint" title="Rectifying replaces the photo; Undo rectify (toolbar) brings back the original, with its scale and areas.">Replaces the photo; Undo rectify restores it</span>
    `;
  }

  const cal = activePhoto?.calibration;
  const upscaleFactor = activePhoto ? photoUpscaleFactor(activePhoto) : 1;
  const upscaleTag = upscaleFactor > 1.05 ? ` · ${Number.isInteger(upscaleFactor) ? upscaleFactor : upscaleFactor.toFixed(1)}×` : '';
  const scaleBadgeHtml = activePhoto
    ? cal && Number.isFinite(cal.mmPerPx) && cal.mmPerPx > 0
      ? `<span class="toolbar-sep" aria-hidden="true"></span>
         <span class="scale-readout" data-scale-readout="" title="Physical pixel scale of the active photo (updates automatically on 2× Upscale or Revert)">Scale: <strong>${cal.mmPerPx.toFixed(3)} mm/px</strong> (${(1 / cal.mmPerPx).toFixed(2)} px/mm)${upscaleTag}</span>`
      : `<span class="toolbar-sep" aria-hidden="true"></span>
         <span class="scale-readout" data-scale-readout="" style="color:var(--text-muted);" title="Use Calibrate to set a physical reference scale in mm/px">Scale: uncalibrated (px)${upscaleTag}</span>`
    : '';

  const onCount = [ov.instanceIds, ov.wentworthColors, ov.ellipses, ov.orientations, ov.borderTruncated, ov.loupe].filter(Boolean).length;
  const subToolbarHtml = `
    <details class="display-menu" data-keep-open="display">
      <summary>Display <span class="summary-note">${onCount} on</span></summary>
      <div class="display-options">
        <label class="checkbox-label"><input type="checkbox" data-ov="instanceIds" ${ov.instanceIds ? 'checked' : ''} /> Grain IDs</label>
        <label class="checkbox-label"><input type="checkbox" data-ov="wentworthColors" ${ov.wentworthColors ? 'checked' : ''} /> Size colours (Wentworth)</label>
        <div class="field-hint" style="margin:-2px 0 4px 20px;line-height:1.4;">
          <span style="color:#f5a623;">■</span> Sand &lt;2mm
          &nbsp;<span style="color:#3b9eff;">■</span> Fine gravel 2–16
          &nbsp;<span style="color:#2ecc71;">■</span> Coarse 16–64
          &nbsp;<span style="color:#9b59b6;">■</span> Cobble 64–256
          &nbsp;<span style="color:#e74c3c;">■</span> Boulder ≥256
        </div>
        <label class="checkbox-label"><input type="checkbox" data-ov="ellipses" ${ov.ellipses ? 'checked' : ''} /> Ellipses (a/b axes)</label>
        <label class="checkbox-label"><input type="checkbox" data-ov="orientations" ${ov.orientations ? 'checked' : ''} /> Orientation lines</label>
        <label class="checkbox-label"><input type="checkbox" data-ov="borderTruncated" ${ov.borderTruncated ? 'checked' : ''} /> Mark edge/too-small grains</label>
        <div class="field-hint" style="margin:-2px 0 4px 20px;line-height:1.4;">
          <span style="color:#ff8577;">●</span> Touches photo edge &nbsp;
          <span style="color:#f5a623;">●</span> Below size cutoff (excluded from PSD)
        </div>
        <label class="checkbox-label"><input type="checkbox" data-ov="loupe" ${ov.loupe ? 'checked' : ''} /> Magnifier (${ov.loupeZoom}×)</label>
        <label class="checkbox-label">Outline opacity <input type="range" min="0" max="1" step="0.05" value="${ov.opacity}" data-ov="opacity" style="width:80px;" /></label>
      </div>
    </details>
    ${
      activePhoto
        ? `<details class="display-menu save-view-menu" data-keep-open="save-view">
            <summary title="Download the photo as shown, with the current Display settings, as a full-resolution PNG">Save image</summary>
            <div class="display-options">
              <button type="button" class="btn btn-sm" data-action="save-view" data-area="photo" ${state.savingView ? 'disabled' : ''}>Whole photo (full resolution)</button>
              <button type="button" class="btn btn-sm" data-action="save-view" data-area="visible" ${state.savingView ? 'disabled' : ''}>Visible area only</button>
              <div class="field-hint" style="line-height:1.4;">PNG at the photo's own pixels, with the outlines, colours, ellipses and markers as currently shown. Very large photos are scaled to what the browser can draw.</div>
            </div>
          </details>`
        : ''
    }
    ${scaleBadgeHtml}
    ${toolPrompt}
  `;
  return { toolbar: toolbarHtml, subToolbar: subToolbarHtml };
}
