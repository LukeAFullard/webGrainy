/** Dialog events: help, opening and closing dialogs, exports, and model downloads (Models dialog). */
import type { ModelId } from '../../types/index.js';
import { clearModelCache, deleteCachedModel, downloadModel } from '../../modules/modelCache.js';
import { isHelpKey } from '../help.js';
import type { AppState } from '../state.js';
import type { ActionHandler, ElementLike, EventContext } from './context.js';

const modelAbortControllers = new Map<ModelId, AbortController>();

function setDownload(ctx: EventContext, modelId: ModelId, value: AppState['modelDownloads'] extends Map<ModelId, infer V> ? V | null : never): void {
  const m = new Map(ctx.store.getState().modelDownloads);
  if (value === null) m.delete(modelId);
  else m.set(modelId, value);
  ctx.store.setState({ modelDownloads: m });
}

export const dialogActions: Record<string, ActionHandler> = {
  'download-model': (el, ctx) => {
    const modelId = el.dataset['modelId'] as ModelId;
    const ctrl = new AbortController();
    modelAbortControllers.set(modelId, ctrl);
    setDownload(ctx, modelId, { active: true, percent: 0, loadedBytes: 0, totalBytes: 0, speedMBps: 0 });
    void downloadModel(modelId, {
      signal: ctrl.signal,
      requireCache: true,
      onProgress: (prog) => setDownload(ctx, modelId, { active: true, ...prog }),
    })
      .then(async () => {
        setDownload(ctx, modelId, null);
        await ctx.actions.refreshCapabilities();
      })
      .catch((err) => {
        setDownload(ctx, modelId, {
          active: false,
          percent: 0,
          loadedBytes: 0,
          totalBytes: 0,
          speedMBps: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        modelAbortControllers.delete(modelId);
      });
  },
  'cancel-model-dl': (el) => {
    modelAbortControllers.get(el.dataset['modelId'] as ModelId)?.abort();
  },
  'delete-model': (el, ctx) => {
    void deleteCachedModel(el.dataset['modelId'] as ModelId).then(() => ctx.actions.refreshCapabilities());
  },
  'printable-report': (_el, ctx) => ctx.ui.openReport(),
  'clear-model-cache': (_el, ctx) => {
    void clearModelCache().then(() => ctx.actions.refreshCapabilities());
  },
};

/** Help buttons and opening/closing dialogs (checked before any other click handler). */
export function handleDialogClick(target: ElementLike, preventDefault: () => void, ctx: EventContext): boolean {
  const helpBtn = target.closest('[data-help], [data-open-help]');
  if (helpBtn) {
    // Help buttons sit inside <label>s: don't let the click toggle the control.
    preventDefault();
    const key = helpBtn.dataset['help'];
    ctx.store.setState({ activeModal: 'help', helpTopic: key && isHelpKey(key) ? key : null });
    return true;
  }
  const modalBtn = target.closest('[data-open-modal]');
  if (modalBtn) {
    const m = modalBtn.dataset['openModal'] as AppState['activeModal'];
    ctx.store.setState({ activeModal: m });
    if (m === 'export') ctx.prefs.noteExportOpened();
    return true;
  }
  if (target.closest('[data-action="close-modal"]')) {
    ctx.store.setState({ activeModal: null });
    return true;
  }
  return false;
}

/** Export buttons (Export dialog, Back up now); returns true when handled. */
export function handleExportClick(target: ElementLike, ctx: EventContext): boolean {
  const exportBtn = target.closest('[data-export]');
  if (!exportBtn) return false;
  const kind = exportBtn.dataset['export'];
  if (kind) ctx.ui.runExport(kind);
  return true;
}
