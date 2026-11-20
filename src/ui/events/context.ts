/**
 * What the event handlers need: the store, the app actions, and a few screen hooks that only
 * main.ts can provide. Handlers see elements through small interfaces (`closest`, `dataset`,
 * `value`, …) so they can be tested with plain objects instead of a browser DOM.
 */
import type { SiteRecord } from '../../modules/projectStorage.js';
import type { AppStore, EditorToolMode, WorkflowStepId } from '../state.js';
import type { WorkspaceActions } from '../workspaceActions.js';

export interface ElementLike {
  id?: string;
  tagName?: string;
  dataset: Record<string, string | undefined>;
  closest(selector: string): ElementLike | null;
}

/** A form control that fired a `change` event. */
export interface ControlLike extends ElementLike {
  tagName: string;
  type?: string;
  value: string;
  checked?: boolean;
}

export function isInput(el: ElementLike): el is ControlLike {
  return el.tagName === 'INPUT';
}

export function isSelect(el: ElementLike): el is ControlLike {
  return el.tagName === 'SELECT';
}

export interface ViewportControls {
  fitToScreen(): void;
  finishShape(): void;
  cancelShape(): void;
  markMasksDirty(): void;
}

export interface EventContext {
  store: AppStore;
  actions: WorkspaceActions;
  storage: {
    saveSite(site: SiteRecord): Promise<void>;
    listSites(): Promise<SiteRecord[]>;
  };
  ui: {
    renderSidebar(): void;
    syncViewport(fitToView: boolean): Promise<void>;
    viewport(): ViewportControls | null;
    openPhotoPicker(): void;
    openArchivePicker(): void;
    /** Asks the user to confirm (e.g. before deleting). */
    confirm(message: string): boolean;
    /** Asks for a site name; null if cancelled. */
    askSiteName(message: string, current: string): string | null;
    scrollSidebarToTop(): void;
    /** Activate the waiting app version and reload; false if none waits or work is running. */
    applyUpdate?(): boolean;
    /** Reloads the page (after a newer version took over in another tab). */
    reloadPage?(): void;
    /** Builds and saves the open site's results .zip (optionally with the project file). */
    downloadResults?(includeProject: boolean): Promise<void>;
    downloadChart(id: string, format: 'svg' | 'png'): Promise<void>;
    download(blob: Blob, filename: string): void;
    /** Opens the printable site report in a new tab (or downloads it if pop-ups are blocked). */
    openReport(): void;
    /** Runs an export from the Export dialog or a "Back up now" button. */
    runExport(kind: string): void;
    /** Sets the value of a form field by id (calibration presets). */
    setFieldValue(id: string, value: string): void;
    focusTab(tab: string): void;
    /** Focuses and scrolls a workflow step tab into view on the landing page. */
    focusWorkflowTab?(step: WorkflowStepId): void;
    /** Transitions from the landing page into the main analysis workspace. */
    enterWorkspace?(tool?: EditorToolMode): void;
    /** Transitions from the workspace back to the landing page overview. */
    showLanding?(): void;
    /** Pans (and if needed zooms) the photo so the grain is in view. */
    focusGrain(grainId: number): void;
    /** True while the user is typing in a text field, select or textarea. */
    isTyping(): boolean;
  };
  prefs: {
    setGuideHidden(hidden: boolean): void;
    /** Remembers whether to skip the landing page overview on future visits. */
    setSkipLanding?(skip: boolean): void;
    /** Called when the Export dialog is opened (the guide marks the export step done). */
    noteExportOpened(): void;
    setNotifyWhenDone(on: boolean): void;
    requestNotifyPermission(): Promise<boolean>;
    saveCpuThreads(value: string): void;
  };
  makeId(prefix: string): string;
}

/** A handler for one `data-action` value; `el` is the element carrying the attribute. */
export type ActionHandler = (el: ElementLike, ctx: EventContext) => void;

/**
 * Before re-analysing photos: if any have manual outline edits (split, merge, delete, add),
 * ask first, because a new analysis replaces the outlines. Returns true to go ahead.
 */
export function confirmDiscardEdits(ctx: EventContext, photoIds: readonly string[]): boolean {
  const st = ctx.store.getState();
  const edited = photoIds
    .map((id) => ({ id, n: st.sessions.get(id)?.getManualEditCount() ?? 0 }))
    .filter((x) => x.n > 0);
  if (edited.length === 0) return true;
  const labels = edited
    .slice(0, 5)
    .map((x) => `"${st.photos.find((p) => p.photoId === x.id)?.label ?? x.id}" (${x.n} edit${x.n === 1 ? '' : 's'})`)
    .join(', ');
  const more = edited.length > 5 ? ` and ${edited.length - 5} more` : '';
  return ctx.ui.confirm(
    `Re-analysing replaces the grain outlines, so your manual edits will be lost: ${labels}${more}.\n\nExport or back up first if you want to keep them. Re-analyse anyway?`,
  );
}
