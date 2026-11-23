/** Optional "Tidy outlines": fragments and holes (tidyGrains.ts, AnalysisSession.tidyOutlines). */
import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeAllGrainMorphometrics } from '../src/modules/interactiveEditor.js';
import { tidyLabelMask } from '../src/modules/tidyGrains.js';

/** A mask from rows of characters: '.' background, digits grain ids. */
function grid(rows: string[]): { masks: Int32Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const masks = new Int32Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (masks[y * w + x] = c === '.' ? 0 : Number(c))));
  return { masks, w, h };
}
const show = (m: Int32Array, w: number): string[] =>
  Array.from({ length: m.length / w }, (_, y) => [...m.subarray(y * w, y * w + w)].map((v) => (v === 0 ? '.' : String(v))).join(''));

describe('tidyLabelMask', () => {
  it('a speck touching another grain joins it; an isolated speck is removed; a corner-only touch is a fragment', () => {
    const { masks, w, h } = grid([
      '...........',
      '.111...222.',
      '.111..1222.', // the 1 touches grain 2 only: joins grain 2
      '.111...222.',
      '....1......', // touches grain 1 only at a corner: a separate piece, touches nothing: removed
      '.........1.', // isolated: removed
    ]);
    const r = tidyLabelMask(masks, w, h, { minSize: 4 });
    expect(show(masks, w)).toEqual([
      '...........',
      '.111...222.',
      '.111..2222.',
      '.111...222.',
      '...........',
      '...........',
    ]);
    expect([r.fragmentsMerged, r.fragmentsRemoved, r.fragmentsSplitOff, r.holesFilled]).toEqual([1, 2, 0, 0]);
    expect([...r.affectedIds].sort()).toEqual([1, 2]);
  });

  it('a fragment of at least Min size becomes a grain of its own; the largest part stays the grain', () => {
    const { masks, w, h } = grid([
      '1111....11',
      '1111....11',
      '1111......',
    ]);
    const r = tidyLabelMask(masks, w, h, { minSize: 4 });
    expect(show(masks, w)).toEqual(['1111....22', '1111....22', '1111......']);
    expect(r.newIds).toEqual([2]);
    expect(r.fragmentsSplitOff).toBe(1);
  });

  it('fills holes enclosed by one grain, but not gaps between grains or regions touching the edge', () => {
    const { masks, w, h } = grid([
      '..........',
      '.11111.22.',
      '.1...1.2..', // hole in grain 1 (3 px); grain 2's notch is open to the edge-connected background
      '.11111.22.',
      '.333444...',
      '.33.444...', // this gap is bordered by grains 3 and 4: kept
      '.333444...',
    ]);
    const r = tidyLabelMask(masks, w, h, { minSize: 50 });
    expect(show(masks, w)).toEqual([
      '..........',
      '.11111.22.',
      '.11111.2..',
      '.11111.22.',
      '.333444...',
      '.33.444...',
      '.333444...',
    ]);
    expect([r.holesFilled, r.holePixels]).toEqual([1, 3]); // grain 1's hole only
  });

  it('changes nothing in an already tidy mask', () => {
    const { masks, w, h } = grid(['.11.22.', '.11.22.']);
    const before = masks.slice();
    const r = tidyLabelMask(masks, w, h, { minSize: 2 });
    expect(r.bbox).toBeNull();
    expect(r.changedPixels).toBe(0);
    expect(masks).toEqual(before);
  });
});

describe('AnalysisSession.tidyOutlines', () => {
  function session(): AnalysisSession {
    const w = 60, h = 40;
    const masks = new Int32Array(w * h);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) masks[y * w + x] = 1;
    masks[30 * w + 40] = 1; // a detached speck far from grain 1
    masks[10 * w + 10] = 0; // a one-pixel hole in grain 1
    return new AnalysisSession({
      workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: 'full' } as never,
      recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
      masks,
      workingGrains: computeAllGrainMorphometrics(masks, w, h, 2),
    });
  }

  it('is one undoable step that shrinks the inflated b-axis, and is recorded in exports', () => {
    const s = session();
    const before = s.getResult().grains[0]!;
    const masksBefore = s.getWorkingMasks().slice();
    const r = s.tidyOutlines()!;
    expect([r.fragmentsRemoved, r.holesFilled]).toEqual([1, 1]);
    const after = s.getResult().grains[0]!;
    expect(after.areaPx).toBe(before.areaPx); // -1 speck, +1 hole
    expect(after.aAxisPx).toBeLessThan(before.aAxisPx); // the far speck had stretched the ellipse
    expect(after.aAxisPx).toBeCloseTo(20 * 2 / Math.sqrt(3), 0); // back to a 20 x 20 square's ellipse
    expect(s.getTidyCount()).toBe(1);
    expect(s.getManualEditCount()).toBe(0); // not counted as a manual edit
    expect(JSON.stringify(s.getExportMetadata())).toContain('Tidy outlines applied');
    // Survives saving and re-opening.
    const reopened = AnalysisSession.fromSerialized(s.toSerialized());
    expect(reopened.getTidyCount()).toBe(1);
    // Undo restores the mask and grains exactly; redo re-applies.
    expect(s.undo()).toBe(true);
    expect(s.getWorkingMasks()).toEqual(masksBefore);
    expect(s.getResult().grains[0]!.aAxisPx).toBe(before.aAxisPx);
    expect(s.getTidyCount()).toBe(0);
    expect(s.redo()).toBe(true);
    expect(s.getTidyCount()).toBe(1);
    // Tidying again changes nothing.
    expect(s.tidyOutlines()).toBeNull();
  });
});
