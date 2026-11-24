/**
 * Keyboard shortcuts: one table used both by the key handler (events/shortcuts.ts) and by the
 * "Keyboard shortcuts" overlay, so the overlay always lists what actually works. Shortcuts
 * marked `viewport` are handled by the photo canvas itself (canvasViewport.ts).
 */
import type { EditorToolMode } from './state.js';
import { esc } from './panels/html.js';

export type ShortcutCommand =
  | { kind: 'overlay' }
  | { kind: 'photo'; step: -1 | 1 }
  | { kind: 'tool'; tool: EditorToolMode }
  | { kind: 'undo' }
  | { kind: 'redo' };

export interface Shortcut {
  /** Key combinations, as shown to the user ("Ctrl+Z", "?", "]"). */
  keys: string[];
  label: string;
  group: 'General' | 'Photos' | 'Tools' | 'Editing' | 'View' | 'Results';
  /** What the app-level handler does; absent for keys handled elsewhere. */
  command?: ShortcutCommand;
  /** Handled by the photo canvas: the `e.key`/`e.code` values it checks (for the consistency test). */
  viewportKeys?: string[];
}

/** Tools in toolbar order; number keys 1–9 select them. Editing tools need analysed results. */
export const TOOL_SHORTCUTS: Array<{ tool: EditorToolMode; label: string; needsResults: boolean }> = [
  { tool: 'inspect', label: 'Inspect', needsResults: false },
  { tool: 'calibrate', label: 'Calibrate scale', needsResults: false },
  { tool: 'rectify', label: 'Rectify perspective', needsResults: false },
  { tool: 'excludePoly', label: 'Exclude area (polygon)', needsResults: false },
  { tool: 'excludeBrush', label: 'Exclude area (brush)', needsResults: false },
  { tool: 'split', label: 'Split a grain', needsResults: true },
  { tool: 'merge', label: 'Merge grains', needsResults: true },
  { tool: 'delete', label: 'Delete a grain', needsResults: true },
  { tool: 'addPolygon', label: 'Add a missed grain', needsResults: true },
];

export const SHORTCUTS: Shortcut[] = [
  { group: 'General', keys: ['?'], label: 'Show or hide this list of shortcuts', command: { kind: 'overlay' } },
  { group: 'Photos', keys: ['['], label: 'Previous photo', command: { kind: 'photo', step: -1 } },
  { group: 'Photos', keys: [']'], label: 'Next photo', command: { kind: 'photo', step: 1 } },
  ...TOOL_SHORTCUTS.map(
    (t, i): Shortcut => ({
      group: 'Tools',
      keys: [String(i + 1)],
      label: `${t.label}${t.needsResults ? ' (after analysis)' : ''}`,
      command: { kind: 'tool', tool: t.tool },
    }),
  ),
  { group: 'Editing', keys: ['Ctrl+Z'], label: 'Undo the last grain edit', command: { kind: 'undo' } },
  { group: 'Editing', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], label: 'Redo', command: { kind: 'redo' } },
  { group: 'Editing', keys: ['Enter'], label: 'Finish the shape being drawn (or double-click)', viewportKeys: ['Enter'] },
  { group: 'Editing', keys: ['Esc'], label: 'Cancel the shape being drawn; close a dialog', viewportKeys: ['Escape'] },
  { group: 'View', keys: ['←', '→', '↑', '↓'], label: 'Pan the photo (Shift: faster) — click the photo first', viewportKeys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] },
  { group: 'View', keys: ['+', '−'], label: 'Zoom in / out — click the photo first', viewportKeys: ['+', '-'] },
  { group: 'View', keys: ['0'], label: 'Fit the photo to the view — click the photo first', viewportKeys: ['0'] },
  { group: 'View', keys: ['Space + drag'], label: 'Pan with the mouse', viewportKeys: ['Space'] },
  { group: 'Results', keys: ['←', '→', 'Home', 'End'], label: 'Move between result tabs (when a tab has focus)' },
];

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}

function matchesKey(spec: string, e: KeyEventLike): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const parts = spec.split('+');
  const key = parts[parts.length - 1]!.toLowerCase();
  const wantMod = parts.includes('Ctrl');
  const wantShift = parts.includes('Shift');
  if (wantMod !== mod || e.altKey) return false;
  if (wantMod) return e.shiftKey === wantShift && e.key.toLowerCase() === key;
  // Single characters: "?" and "]" are typed with Shift on some layouts, so ignore Shift.
  return e.key === parts[0];
}

/** The app-level shortcut for this key press, if any. */
export function matchShortcut(e: KeyEventLike): Shortcut | null {
  return SHORTCUTS.find((s) => s.command && s.keys.some((k) => matchesKey(k, e))) ?? null;
}

export function renderShortcutsModalHtml(): string {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  const rows = (g: Shortcut['group']): string =>
    SHORTCUTS.filter((s) => s.group === g)
      .map(
        (s) =>
          `<tr><td class="shortcut-keys">${s.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(' ')}</td><td>${esc(s.label)}</td></tr>`,
      )
      .join('');
  return `
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="dialog-title" class="modal-title">Keyboard shortcuts</h2>
        <button type="button" class="btn btn-sm" data-action="close-modal" autofocus>Close</button>
      </div>
      <div class="modal-body" tabindex="0">
        <p class="help-intro">Shortcuts work when you are not typing in a field. On a Mac, use ⌘ instead of Ctrl.</p>
        ${groups.map((g) => `<h3 class="help-group">${esc(g)}</h3><table class="shortcut-table">${rows(g)}</table>`).join('')}
      </div>
    </div>`;
}
