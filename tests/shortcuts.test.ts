import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AppStore, createInitialState } from '../src/ui/state.js';
import type { EventContext } from '../src/ui/events/context.js';
import { handleShortcutKey } from '../src/ui/events/shortcuts.js';
import { matchShortcut, renderShortcutsModalHtml, SHORTCUTS, TOOL_SHORTCUTS } from '../src/ui/shortcuts.js';

function setup(opts: { analysed?: boolean } = {}) {
  const photos = ['p1', 'p2', 'p3'].map((photoId) => ({ photoId, siteId: 's', label: photoId }) as never);
  const sess = { undo: vi.fn(() => true), redo: vi.fn(() => true) };
  const store = new AppStore({
    ...createInitialState(),
    photos,
    activePhotoId: 'p1',
    sessions: opts.analysed ? new Map([['p1', sess as never]]) : new Map(),
  });
  let typing = false;
  const ctx = {
    store,
    actions: { recomputeReports: vi.fn(), persistActiveSession: vi.fn(async () => {}) },
    ui: { syncViewport: vi.fn(async () => {}), viewport: () => null, isTyping: () => typing },
  } as unknown as EventContext;
  return { store, ctx, sess, setTyping: (v: boolean) => (typing = v) };
}

function press(key: string, ctx: EventContext, mods: { ctrl?: boolean; shift?: boolean } = {}) {
  const e = { key, ctrlKey: mods.ctrl ?? false, metaKey: false, shiftKey: mods.shift ?? false, altKey: false, preventDefault: vi.fn() };
  handleShortcutKey(e, ctx);
  return e.preventDefault.mock.calls.length > 0;
}

describe('keyboard shortcuts', () => {
  it('the overlay lists every shortcut in the table', () => {
    const html = renderShortcutsModalHtml();
    for (const s of SHORTCUTS) {
      expect(html).toContain(s.label.replace(/&/g, '&amp;'));
      for (const k of s.keys) expect(html).toContain(`<kbd>${k}</kbd>`);
    }
  });

  it('every app-level shortcut in the table does something', () => {
    for (const s of SHORTCUTS.filter((x) => x.command)) {
      for (const k of s.keys) {
        const { ctx, store } = setup({ analysed: true });
        if (s.command!.kind === 'photo' && s.command!.step === -1) store.setState({ activePhotoId: 'p2' });
        const parts = k.split('+');
        const handled = press(parts[parts.length - 1]!, ctx, { ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift') });
        expect(handled, `${k} (${s.label})`).toBe(true);
      }
    }
  });

  it('every canvas shortcut in the table is handled by the canvas', () => {
    const src = readFileSync('src/ui/canvasViewport.ts', 'utf8');
    for (const s of SHORTCUTS.filter((x) => x.viewportKeys)) {
      for (const k of s.viewportKeys!) expect(src, `${s.label}: ${k}`).toMatch(new RegExp(`e\\.(key|code) === '${k.replace(/[+]/g, '\\+')}'`));
    }
  });

  it('[ and ] move between photos and stop at the ends', () => {
    const { ctx, store } = setup();
    expect(press(']', ctx)).toBe(true);
    expect(store.getState().activePhotoId).toBe('p2');
    press(']', ctx);
    expect(press(']', ctx)).toBe(false); // already at the last photo
    expect(store.getState().activePhotoId).toBe('p3');
    press('[', ctx);
    expect(store.getState().activePhotoId).toBe('p2');
  });

  it('number keys pick tools; editing tools only after analysis', () => {
    const { ctx, store } = setup();
    expect(press('2', ctx)).toBe(true);
    expect(store.getState().activeTool).toBe(TOOL_SHORTCUTS[1]!.tool);
    expect(press('6', ctx)).toBe(false); // split needs results
    expect(store.getState().activeTool).toBe('calibrate');
    const analysed = setup({ analysed: true });
    expect(press('6', analysed.ctx)).toBe(true);
    expect(analysed.store.getState().activeTool).toBe('split');
  });

  it('is ignored while typing or with a dialog open; ? toggles the overlay', () => {
    const { ctx, store, setTyping, sess } = setup({ analysed: true });
    setTyping(true);
    expect(press('?', ctx)).toBe(false);
    expect(press('z', ctx, { ctrl: true })).toBe(false); // the text field keeps its own undo
    expect(sess.undo).not.toHaveBeenCalled();
    setTyping(false);
    press('?', ctx);
    expect(store.getState().activeModal).toBe('shortcuts');
    expect(press(']', ctx)).toBe(false);
    press('?', ctx);
    expect(store.getState().activeModal).toBeNull();
    store.setState({ activeModal: 'export' });
    expect(press('?', ctx)).toBe(false);
  });

  it('matches modifiers exactly', () => {
    expect(matchShortcut({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false })?.command?.kind).toBe('undo');
    expect(matchShortcut({ key: 'Z', ctrlKey: false, metaKey: true, shiftKey: true })?.command?.kind).toBe('redo');
    expect(matchShortcut({ key: 'z', ctrlKey: false, metaKey: false, shiftKey: false })).toBeNull();
    expect(matchShortcut({ key: '1', ctrlKey: true, metaKey: false, shiftKey: false })).toBeNull();
  });
});
