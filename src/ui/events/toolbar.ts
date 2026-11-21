/** Toolbar and photo events: tools, shape buttons, undo/redo, merge, scale copy, Display menu. */
import { upscaleIncreasesWorkingResolution } from '../../modules/imagePreprocess.js';
import { planScaleCopy, suggestScaleTargets } from '../../modules/scaleCopy.js';
import type { PhotoRecord } from '../../modules/projectStorage.js';
import type { EditorToolMode } from '../state.js';
import { navGrainsFor, navigateGrains, type GrainNavMode } from '../grainNav.js';
import { getActivePhoto } from '../workspaceActions.js';
import { isInput, type ActionHandler, type ControlLike, type ElementLike, type EventContext } from './context.js';

/** Undo or redo the last grain edit on the open photo; returns whether anything changed. */
export function undoRedo(ctx: EventContext, which: 'undo' | 'redo'): boolean {
  const st = ctx.store.getState();
  const photo = getActivePhoto(st);
  const sess = photo ? st.sessions.get(photo.photoId) : null;
  if (!photo || !sess) return false;
  const ok = which === 'undo' ? sess.undo() : sess.redo();
  if (ok) {
    void ctx.actions.persistActiveSession(photo.photoId, sess);
    ctx.actions.recomputeReports();
    ctx.ui.viewport()?.markMasksDirty();
  }
  return ok;
}

export const toolbarActions: Record<string, ActionHandler> = {
  'grain-nav': (el, ctx) => {
    const st = ctx.store.getState();
    const photo = getActivePhoto(st);
    const sess = photo ? st.sessions.get(photo.photoId) : null;
    if (!sess) return;
    const target = navigateGrains(navGrainsFor(sess), st.inspectedGrainId, (el.dataset['nav'] ?? 'next') as GrainNavMode);
    if (!target) {
      ctx.store.setState({ statusMessage: 'No flagged grains on this photo.' });
      return;
    }
    ctx.store.setState({ inspectedGrainId: target.id, ...(st.activeTool !== 'inspect' ? { activeTool: 'inspect' as const } : {}) });
    ctx.ui.focusGrain(target.id);
    void ctx.ui.syncViewport(false);
  },
  'fit-view': (_el, ctx) => ctx.ui.viewport()?.fitToScreen(),
  'finish-shape': (_el, ctx) => ctx.ui.viewport()?.finishShape(),
  'cancel-shape': (_el, ctx) => ctx.ui.viewport()?.cancelShape(),
  'close-inspector': (_el, ctx) => {
    ctx.store.setState({ inspectedGrainId: null });
    void ctx.ui.syncViewport(false);
  },
  undo: (_el, ctx) => void undoRedo(ctx, 'undo'),
  redo: (_el, ctx) => void undoRedo(ctx, 'redo'),
  'commit-merge': (_el, ctx) => {
    const state = ctx.store.getState();
    const photo = getActivePhoto(state);
    const sess = photo ? state.sessions.get(photo.photoId) : null;
    if (photo && sess && state.selectedGrainIds.size >= 2 && sess.mergeGrains(Array.from(state.selectedGrainIds))) {
      ctx.store.setState({ selectedGrainIds: new Set() });
      void ctx.actions.persistActiveSession(photo.photoId, sess);
      ctx.actions.recomputeReports();
      ctx.ui.viewport()?.markMasksDirty();
    }
  },
  // "Copy scale to photos…": pick the target photos in the photo list (select mode), with
  // compatible photos (same pixel size, no scale yet) pre-selected; nothing changes until
  // "Copy scale" is pressed, and overwriting a photo's own scale asks first.
  'copy-scale-start': (_el, ctx) => {
    const state = ctx.store.getState();
    const active = getActivePhoto(state);
    if (!active?.calibration) return;
    const suggested = suggestScaleTargets(active, state.photos);
    ctx.store.setState({
      photoSelectMode: true,
      scaleCopySourceId: active.photoId,
      selectedPhotoIds: suggested,
      statusMessage:
        suggested.size > 0
          ? `${suggested.size} photo(s) with the same pixel size and no scale are selected. Adjust the selection in the photo list, then press "Copy scale".`
          : 'No other photo has the same pixel size and no scale yet. Tick the photos to give this scale, then press "Copy scale".',
    });
    ctx.ui.scrollSidebarToTop?.();
  },
  'copy-scale-apply': (_el, ctx) => {
    const state = ctx.store.getState();
    const source = state.photos.find((p) => p.photoId === state.scaleCopySourceId);
    if (!source?.calibration || state.batchRunning) return;
    const plan = planScaleCopy(source, state.photos, state.selectedPhotoIds);
    if (plan.updates.length === 0) return;
    if (plan.confirmMessage !== null && !ctx.ui.confirm(plan.confirmMessage)) return;
    const byId = new Map(plan.updates.map((p) => [p.photoId, p]));
    const toPersist: Array<{ photo: PhotoRecord; session?: ReturnType<typeof state.sessions.get> }> = [];
    for (const updated of plan.updates) {
      const sess = state.sessions.get(updated.photoId);
      if (sess && updated.calibration) sess.setCalibration(updated.calibration);
      toPersist.push({ photo: updated, ...(sess ? { session: sess } : {}) });
    }
    const n = plan.updates.length;
    const msg = `Copied the scale of ${source.label} (${source.calibration.mmPerPx.toFixed(4)} mm/px) to ${n} photo${n === 1 ? '' : 's'}.`;
    ctx.store.setState({
      photos: state.photos.map((p) => byId.get(p.photoId) ?? p),
      photoSelectMode: false,
      selectedPhotoIds: new Set(),
      scaleCopySourceId: null,
      statusMessage: msg,
    });
    ctx.actions.recomputeReports();
    void ctx.ui.syncViewport(false);
    void Promise.all(
      toPersist.map(async ({ photo, session }) => {
        await ctx.actions.savePhoto(photo);
        if (session) await ctx.actions.persistActiveSession(photo.photoId, session);
      }),
    ).catch((err: unknown) => {
      ctx.store.setState({
        statusMessage: `${msg} But not all photos could be saved to browser storage: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  },
  'enhance-upscale': (_el, ctx) => {
    const st = ctx.store.getState();
    const photo = getActivePhoto(st);
    if (!photo) return;
    const mode = st.analysisParams.scaleMode;
    if (!upscaleIncreasesWorkingResolution(photo.width, photo.height, mode)) {
      ctx.store.setState({
        statusMessage:
          `2× upscaling would not help this photo: with Image scale "${mode}" a ${photo.width}×${photo.height} px photo is ` +
          'analysed at the same size after upscaling (it is shrunk back), so it would only add interpolated detail. ' +
          'Set Image scale to 1.0x first if you need more pixels per grain.',
      });
      return;
    }
    void ctx.actions.enhanceActivePhoto('upscale-2x');
  },
  'enhance-deblur': (_el, ctx) => void ctx.actions.enhanceActivePhoto('deblur'),
  'enhance-revert': (_el, ctx) => void ctx.actions.revertActivePhotoEnhancement(),
};

/** Tool buttons; returns true when handled. */
export function handleToolbarClick(target: ElementLike, ctx: EventContext): boolean {
  const toolBtn = target.closest('[data-tool]');
  if (!toolBtn) return false;
  ctx.store.setState({
    activeTool: toolBtn.dataset['tool'] as EditorToolMode,
    selectedGrainIds: new Set(),
    pendingCalibrationPoints: [],
    pendingRectifyPoints: [],
  });
  void ctx.ui.syncViewport(false);
  return true;
}

const KNOWN_CAL_PRESETS = new Set(['100|mm', '25|mm', '500|mm']);

/** If the active photo already has two calibration points marked and no new calibration is mid-click,
 *  re-apply the calibration immediately with the updated physical length/unit. */
function reapplyCalibrationIfPresent(ctx: EventContext, lengthVal: number, unit: 'mm' | 'cm'): void {
  const st = ctx.store.getState();
  if (st.pendingCalibrationPoints.length > 0) return;
  const active = getActivePhoto(st);
  const existing = active?.calibration;
  if (!existing) return;
  void ctx.actions.applyCalibrationToActive(existing.pointA, existing.pointB, lengthVal, unit);
}

/** Calibration presets/inputs, rectify dimensions, and the Display menu; returns true when handled. */
export function handleToolbarChange(target: ControlLike, ctx: EventContext): boolean {
  if (target.id === 'cal-preset') {
    if (target.value !== 'custom') {
      const [len, unit] = target.value.split('|');
      const numLen = Number(len);
      const nextUnit = unit === 'cm' ? 'cm' : 'mm';
      if (Number.isFinite(numLen) && numLen >= 0.1) {
        ctx.store.setState({
          calibrationPreset: target.value,
          calibrationLength: numLen,
          calibrationUnit: nextUnit,
        });
        if (len) ctx.ui.setFieldValue('cal-length', len);
        if (unit) ctx.ui.setFieldValue('cal-unit', unit);
        reapplyCalibrationIfPresent(ctx, numLen, nextUnit);
      }
    } else {
      ctx.store.setState({ calibrationPreset: 'custom' });
    }
    return true;
  }
  if (target.id === 'cal-length') {
    const v = Number(target.value);
    if (Number.isFinite(v) && v >= 0.1) {
      const unit = ctx.store.getState().calibrationUnit;
      const key = `${v}|${unit}`;
      const nextPreset = KNOWN_CAL_PRESETS.has(key) ? key : 'custom';
      ctx.store.setState({
        calibrationLength: v,
        calibrationPreset: nextPreset,
      });
      ctx.ui.setFieldValue('cal-preset', nextPreset);
      reapplyCalibrationIfPresent(ctx, v, unit);
    }
    return true;
  }
  if (target.id === 'cal-unit') {
    const unit: 'mm' | 'cm' = target.value === 'cm' ? 'cm' : 'mm';
    const len = ctx.store.getState().calibrationLength;
    const key = `${len}|${unit}`;
    const nextPreset = KNOWN_CAL_PRESETS.has(key) ? key : 'custom';
    ctx.store.setState({
      calibrationUnit: unit,
      calibrationPreset: nextPreset,
    });
    ctx.ui.setFieldValue('cal-preset', nextPreset);
    reapplyCalibrationIfPresent(ctx, len, unit);
    return true;
  }
  if (target.id === 'rect-w') {
    const v = Number(target.value);
    if (Number.isFinite(v) && v >= 10) {
      ctx.store.setState({ rectifyWidthMm: v });
    }
    return true;
  }
  if (target.id === 'rect-h') {
    const v = Number(target.value);
    if (Number.isFinite(v) && v >= 10) {
      ctx.store.setState({ rectifyHeightMm: v });
    }
    return true;
  }
  const ovKey = target.dataset['ov'];
  if (ovKey) {
    const nextOv = { ...ctx.store.getState().overlays };
    if (ovKey === 'opacity' && isInput(target)) nextOv.opacity = Number(target.value);
    else if (isInput(target)) (nextOv as Record<string, unknown>)[ovKey] = target.checked;
    ctx.store.setState({ overlays: nextOv });
    void ctx.ui.syncViewport(false);
    return true;
  }
  return false;
}
