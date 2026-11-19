/** Toolbar above the photo: tool groups, the Display menu and the active tool's prompt. */
import { helpButton } from '../help.js';
import type { AppState, EditorToolMode } from '../state.js';
import { getActivePhoto } from '../workspaceActions.js';
import { countFlagged, navGrainsFor } from '../grainNav.js';
import { esc } from './html.js';

export function renderToolbarHtml(state: AppState): { toolbar: string; subToolbar: string } {
  const activePhoto = getActivePhoto(state);
  const session = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;

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
      label: 'Exclude',
      tools: [
        { id: 'excludePoly', label: 'Area', title: 'Draw a polygon around things to leave out (rulers, boots, water)' },
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
    ${helpButton('editing')}
    ${
      state.activeTool === 'merge' && state.selectedGrainIds.size >= 2
        ? `<button type="button" class="btn btn-sm btn-primary" data-action="commit-merge">Merge (${state.selectedGrainIds.size})</button>`
        : ''
    }
    ${
      state.activeTool === 'split' || state.activeTool === 'addPolygon' || state.activeTool === 'excludePoly'
        ? `<button type="button" class="btn btn-sm btn-primary" data-action="finish-shape" title="Same as double-click or Enter">Finish shape</button>
           <button type="button" class="btn btn-sm" data-action="cancel-shape" title="Same as Esc">Cancel shape</button>`
        : ''
    }
    <span class="tool-group">
      ${session ? `<button type="button" class="btn btn-sm" data-action="undo" ${session.canUndo ? '' : 'disabled'}>Undo</button>
      <button type="button" class="btn btn-sm" data-action="redo" ${session.canRedo ? '' : 'disabled'}>Redo</button>` : ''}
      <button type="button" class="btn btn-sm" data-action="fit-view" ${activePhoto ? '' : 'disabled'} title="Fit the photo to the view">Fit</button>
    </span>
    ${
      activePhoto
        ? `<span class="tool-group" role="group" aria-label="Optional image enhancement">
            <span class="tool-group-label">Enhance</span>
            <button type="button" class="btn btn-sm" data-action="enhance-upscale" ${state.batchRunning ? 'disabled' : ''} title="Optional 2× AI upscale (PULSE, 1.4 MB, MIT, L1-trained — unloads segmentation model first)">2× Upscale</button>
            <button type="button" class="btn btn-sm" data-action="enhance-deblur" ${state.batchRunning ? 'disabled' : ''} title="Optional AI motion deblur (NAFNet, 92 MB, MIT, L1-trained — unloads segmentation model first)">Deblur</button>
            ${activePhoto.originalBackup ? `<button type="button" class="btn btn-sm" data-action="enhance-revert" ${state.batchRunning ? 'disabled' : ''} title="Restore the original unenhanced photo">Revert</button>` : ''}
          </span>`
        : ''
    }
  `;

  const ov = state.overlays;
  let toolPrompt = '';
  if (state.activeTool === 'inspect' && session) {
    const flagged = countFlagged(navGrainsFor(session));
    toolPrompt = `
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span>Check grains:</span>
      <button type="button" class="btn btn-sm" data-action="grain-nav" data-nav="largest" title="Show the largest grain">Largest</button>
      <button type="button" class="btn btn-sm" data-action="grain-nav" data-nav="flagged" title="Grains touching the edge, outside the ROI, or very elongated" ${flagged === 0 ? 'disabled' : ''}>Flagged (${flagged})</button>
    `;
  }
  if (state.activeTool === 'calibrate') {
    toolPrompt = `
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span>Calibrate (${state.pendingCalibrationPoints.length}/2 pts):</span>
      <select class="select" id="cal-preset" aria-label="Calibration reference preset" style="width:auto;padding:2px 6px;">
        <option value="100|mm">100 mm Ruler</option>
        <option value="25|mm">25 mm Coin</option>
        <option value="500|mm">500 mm Quadrat</option>
        <option value="custom">Custom…</option>
      </select>
      <input class="input" id="cal-length" type="number" value="100" step="1" min="0.1" aria-label="Calibration length" style="width:65px;padding:2px 6px;" />
      <select class="select" id="cal-unit" aria-label="Calibration unit" style="width:auto;padding:2px 6px;">
        <option value="mm">mm</option>
        <option value="cm">cm</option>
      </select>
      <button type="button" class="btn btn-sm" data-action="copy-scale-all" ${activePhoto?.calibration ? '' : 'disabled'}>Copy Scale to Site</button>
    `;
  } else if (state.activeTool === 'rectify') {
    toolPrompt = `
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span>4-Pt Rectify (${state.pendingRectifyPoints.length}/4 TL→TR→BR→BL):</span>
      <input class="input" id="rect-w" type="number" value="500" step="10" min="10" aria-label="Rectification physical width in mm" style="width:60px;padding:2px 6px;" title="Width (mm)" />×
      <input class="input" id="rect-h" type="number" value="500" step="10" min="10" aria-label="Rectification physical height in mm" style="width:60px;padding:2px 6px;" title="Height (mm)" />mm
    `;
  }

  const cal = activePhoto?.calibration;
  const scaleBadgeHtml = activePhoto
    ? cal && Number.isFinite(cal.mmPerPx) && cal.mmPerPx > 0
      ? `<span class="toolbar-sep" aria-hidden="true"></span>
         <span class="scale-readout" data-scale-readout="" title="Physical pixel scale of the active photo (updates automatically on 2× Upscale or Revert)">Scale: <strong>${cal.mmPerPx.toFixed(3)} mm/px</strong> (${(1 / cal.mmPerPx).toFixed(2)} px/mm)${activePhoto.metadata?.enhancement?.kind === 'upscale-2x' ? ' · 2×' : ''}</span>`
      : `<span class="toolbar-sep" aria-hidden="true"></span>
         <span class="scale-readout" data-scale-readout="" style="color:var(--text-muted);" title="Use Calibrate to set a physical reference scale in mm/px">Scale: uncalibrated (px)</span>`
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
    ${scaleBadgeHtml}
    ${toolPrompt}
  `;
  return { toolbar: toolbarHtml, subToolbar: subToolbarHtml };
}
