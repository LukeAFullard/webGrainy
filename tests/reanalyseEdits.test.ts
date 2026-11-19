/** Regression (re-audit): re-analysing must not silently discard manual outline edits. */
import { describe, expect, it, vi } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { ACTIONS } from '../src/ui/events/router.js';
import type { EventContext } from '../src/ui/events/context.js';
import { AppStore, createInitialState } from '../src/ui/state.js';

function session(): AnalysisSession {
  const w = 60, h = 40;
  const masks = new Int32Array(w * h);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) masks[y * w + x] = 1;
  for (let y = 5; y < 15; y++) for (let x = 30; x < 45; x++) masks[y * w + x] = 2;
  return new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(0), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: '1.0x' },
    recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
    masks,
    workingGrains: computeGrainMorphometrics(masks, w, h, 2),
  });
}

describe('manual edit count', () => {
  it('counts net edits (undo subtracts), survives serialisation and is exported', () => {
    const s = session();
    expect(s.getManualEditCount()).toBe(0);
    expect(s.deleteGrain(1)).toBe(true);
    expect(s.mergeGrains([2])).toBe(false); // no-op: not counted
    expect(s.getManualEditCount()).toBe(1);
    s.undo();
    expect(s.getManualEditCount()).toBe(0);
    s.redo();
    expect(s.getManualEditCount()).toBe(1);
    const restored = AnalysisSession.fromSerialized(s.toSerialized());
    expect(restored.getManualEditCount()).toBe(1);
    expect(restored.getExportMetadata()['manualOutlineEdits']).toBe(1);
  });
});

describe('re-analyse confirmation', () => {
  function ctxWith(editedSession: AnalysisSession, answer: boolean) {
    const store = new AppStore({
      ...createInitialState(),
      activePhotoId: 'P',
      photos: [{ photoId: 'P', siteId: 's', label: 'quadrat.jpg', imageBlob: new Blob([]), width: 60, height: 40, addedAt: 0, included: true }],
      sessions: new Map([['P', editedSession]]),
      selectedPhotoIds: new Set(['P']),
    });
    const runBatch = vi.fn(async () => {});
    const confirm = vi.fn((_msg: string) => answer);
    const ctx = { store, actions: { runBatch }, ui: { confirm } } as unknown as EventContext;
    return { ctx, runBatch, confirm };
  }
  const btn = (bulk?: string) => ({ dataset: bulk ? { bulk } : {}, closest: () => null }) as never;

  it('asks before re-analysing an edited photo, and does nothing if declined', () => {
    const s = session();
    s.deleteGrain(1);
    const { ctx, runBatch, confirm } = ctxWith(s, false);
    ACTIONS['run-active']!(btn(), ctx);
    ACTIONS['photo-bulk']!(btn('reanalyse'), ctx);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]![0]).toMatch(/"quadrat\.jpg" \(1 edit\)/);
    expect(runBatch).not.toHaveBeenCalled();
  });

  it('re-analyses after confirmation, and without asking when there are no edits', () => {
    const edited = session();
    edited.deleteGrain(1);
    const yes = ctxWith(edited, true);
    ACTIONS['run-active']!(btn(), yes.ctx);
    expect(yes.runBatch).toHaveBeenCalledWith(['P']);
    const clean = ctxWith(session(), false);
    ACTIONS['run-active']!(btn(), clean.ctx);
    expect(clean.confirm).not.toHaveBeenCalled();
    expect(clean.runBatch).toHaveBeenCalledWith(['P']);
  });
});
