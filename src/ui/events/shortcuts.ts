/** App-level keyboard shortcuts (see ui/shortcuts.ts for the table). */
import { matchShortcut, TOOL_SHORTCUTS, type KeyEventLike, type ShortcutCommand } from '../shortcuts.js';
import { getActivePhoto } from '../workspaceActions.js';
import type { EventContext } from './context.js';
import { undoRedo } from './toolbar.js';

/** Runs a shortcut command; returns whether it did anything. */
export function runShortcut(cmd: ShortcutCommand, ctx: EventContext): boolean {
  const st = ctx.store.getState();
  switch (cmd.kind) {
    case 'overlay':
      ctx.store.setState({ activeModal: st.activeModal === 'shortcuts' ? null : 'shortcuts' });
      return true;
    case 'photo': {
      if (st.photos.length === 0) return false;
      const idx = st.photos.findIndex((p) => p.photoId === st.activePhotoId);
      const next = st.photos[Math.min(st.photos.length - 1, Math.max(0, (idx === -1 ? 0 : idx) + cmd.step))];
      if (!next || next.photoId === st.activePhotoId) return false;
      ctx.store.setState({
        activePhotoId: next.photoId,
        selectedGrainIds: new Set(),
        inspectedGrainId: null,
        pendingCalibrationPoints: [],
        pendingRectifyPoints: [],
      });
      ctx.actions.recomputeReports();
      void ctx.ui.syncViewport(true);
      return true;
    }
    case 'tool': {
      const info = TOOL_SHORTCUTS.find((t) => t.tool === cmd.tool);
      const photo = getActivePhoto(st);
      if (!photo) return false;
      if (info?.needsResults && !st.sessions.has(photo.photoId)) return false;
      ctx.store.setState({ activeTool: cmd.tool, selectedGrainIds: new Set(), pendingCalibrationPoints: [], pendingRectifyPoints: [] });
      void ctx.ui.syncViewport(false);
      return true;
    }
    case 'undo':
      return undoRedo(ctx, 'undo');
    case 'redo':
      return undoRedo(ctx, 'redo');
  }
}

/** Window keydown: ignored while typing in a field, and (except "?") while a dialog is open. */
export function handleShortcutKey(e: KeyEventLike & { defaultPrevented?: boolean; preventDefault(): void }, ctx: EventContext): void {
  if (e.defaultPrevented || ctx.ui.isTyping()) return;
  const shortcut = matchShortcut(e);
  if (!shortcut?.command) return;
  const modal = ctx.store.getState().activeModal;
  if (modal !== null && !(shortcut.command.kind === 'overlay' && modal === 'shortcuts')) return;
  if (runShortcut(shortcut.command, ctx)) e.preventDefault();
}
