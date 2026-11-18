/** Toolbar and photo events: tools, shape buttons, undo/redo, merge, scale copy, Display menu. */
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
  'copy-scale-all': (_el, ctx) => {
    const state = ctx.store.getState();
    const active = getActivePhoto(state);
    if (!active?.calibration) return;
    const cal = active.calibration;
    void Promise.all(
      state.photos.map(async (ph) => {
        if (ph.photoId === active.photoId) return ph;
        const updated: PhotoRecord = { ...ph, calibration: cal };
        await ctx.actions.savePhoto(updated);
        const sess = state.sessions.get(ph.photoId);
        if (sess) {
          sess.setCalibration(cal);
          await ctx.actions.persistActiveSession(ph.photoId, sess);
        }
        return updated;
      }),
    ).then((photos) => {
      ctx.store.setState({
        photos,
        statusMessage: `Copied scale (${cal.mmPerPx.toFixed(4)} mm/px) to all photos in site`,
      });
      ctx.actions.recomputeReports();
    });
  },
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

/** Calibration presets and the Display menu; returns true when handled. */
export function handleToolbarChange(target: ControlLike, ctx: EventContext): boolean {
  if (target.id === 'cal-preset') {
    if (target.value !== 'custom') {
      const [len, unit] = target.value.split('|');
      if (len) ctx.ui.setFieldValue('cal-length', len);
      if (unit) ctx.ui.setFieldValue('cal-unit', unit);
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
