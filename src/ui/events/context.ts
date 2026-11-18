/**
 * What the event handlers need: the store, the app actions, and a few screen hooks that only
 * main.ts can provide. Handlers see elements through small interfaces (`closest`, `dataset`,
 * `value`, …) so they can be tested with plain objects instead of a browser DOM.
 */
import type { SiteRecord } from '../../modules/projectStorage.js';
import type { AppStore } from '../state.js';
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
    downloadChart(id: string, format: 'svg' | 'png'): Promise<void>;
    download(blob: Blob, filename: string): void;
    /** Opens the printable site report in a new tab (or downloads it if pop-ups are blocked). */
    openReport(): void;
    /** Runs an export from the Export dialog or a "Back up now" button. */
    runExport(kind: string): void;
    /** Sets the value of a form field by id (calibration presets). */
    setFieldValue(id: string, value: string): void;
    focusTab(tab: string): void;
    /** Pans (and if needed zooms) the photo so the grain is in view. */
    focusGrain(grainId: number): void;
    /** True while the user is typing in a text field, select or textarea. */
    isTyping(): boolean;
  };
  prefs: {
    setGuideHidden(hidden: boolean): void;
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
