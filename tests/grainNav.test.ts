import { describe, expect, it } from 'vitest';
import { countFlagged, flaggedByReason, grainFlags, navigateGrains, type NavGrain } from '../src/ui/grainNav.js';

const grains: NavGrain[] = [
  { id: 3, areaPx: 400, touchesBorder: false, aspectRatio: 0.7 },
  { id: 1, areaPx: 900, touchesBorder: true, aspectRatio: 0.8 },
  { id: 7, areaPx: 300, touchesBorder: false, aspectRatio: 0.2 },
  { id: 5, areaPx: 2500, touchesBorder: false, aspectRatio: 0.6, excluded: true },
  { id: 9, areaPx: 100, touchesBorder: false, aspectRatio: 0.9 },
];

describe('grain inspector navigation', () => {
  it('steps through grains in id order and wraps around', () => {
    expect(navigateGrains(grains, null, 'next')!.id).toBe(1);
    expect(navigateGrains(grains, null, 'prev')!.id).toBe(9);
    expect(navigateGrains(grains, 3, 'next')!.id).toBe(5);
    expect(navigateGrains(grains, 9, 'next')!.id).toBe(1);
    expect(navigateGrains(grains, 1, 'prev')!.id).toBe(9);
  });

  it('finds the largest grain', () => {
    expect(navigateGrains(grains, 9, 'largest')!.id).toBe(5);
  });

  it('visits flagged grains (edge, excluded, elongated) after the current one', () => {
    expect(navigateGrains(grains, null, 'flagged')!.id).toBe(1);
    expect(navigateGrains(grains, 1, 'flagged')!.id).toBe(5);
    expect(navigateGrains(grains, 5, 'flagged')!.id).toBe(7);
    expect(navigateGrains(grains, 7, 'flagged')!.id).toBe(1);
    expect(countFlagged(grains)).toBe(3);
    expect(navigateGrains(grains.filter((g) => grainFlags(g).length === 0), null, 'flagged')).toBeNull();
    expect(navigateGrains([], null, 'next')).toBeNull();
  });

  it('goes back through flagged grains too, wrapping around', () => {
    expect(navigateGrains(grains, null, 'prevFlagged')!.id).toBe(7);
    expect(navigateGrains(grains, 7, 'prevFlagged')!.id).toBe(5);
    expect(navigateGrains(grains, 5, 'prevFlagged')!.id).toBe(1);
    expect(navigateGrains(grains, 1, 'prevFlagged')!.id).toBe(7);
    expect(navigateGrains(grains, 9, 'prevFlagged')!.id).toBe(7); // from an unflagged grain
  });

  it('groups flagged grains by reason for the list', () => {
    const both: NavGrain = { id: 11, areaPx: 50, touchesBorder: true, aspectRatio: 0.1 };
    const groups = flaggedByReason([...grains, both]);
    expect(groups.map((g) => [g.key, g.grains.map((x) => x.id)])).toEqual([
      ['edge', [1, 11]],
      ['excluded', [5]],
      ['elongated', [7, 11]],
    ]);
  });

  it('explains why a grain is flagged', () => {
    expect(grainFlags(grains[2]!)).toEqual(['very elongated (b/a 0.20)']);
    expect(grainFlags(grains[1]!)).toEqual(['touches the photo edge']);
    expect(grainFlags(grains[3]!)).toEqual(['outside the ROI or in an excluded area']);
    expect(grainFlags(grains[0]!)).toEqual([]);
  });

  it('focusOnGrain centers on original-image coordinates without double-dividing by effectiveScaleFactor', async () => {
    const { CanvasViewport } = await import('../src/ui/canvasViewport.js');
    // Fake a minimal CanvasViewport instance to exercise focusOnGrain directly in Node.
    const fakeViewport = {
      photo: { width: 4000, height: 3000 },
      session: {
        workingImage: { width: 1000, height: 750, originalWidth: 4000, originalHeight: 3000, effectiveScaleFactor: 0.25 },
        getResult: () => ({
          // Already rescaled to original-image coordinates by AnalysisSession
          grains: [{ id: 1, bbox: [1600, 1200, 2000, 1600] as [number, number, number, number] }],
        }),
      },
      stage: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      zoom: 0.2,
      fitZoom: 0.19,
      panX: 0,
      panY: 0,
      render: () => {},
    };

    CanvasViewport.prototype.focusOnGrain.call(fakeViewport, 1);

    // Center of grain in original-image coords is (1800, 1400).
    // Screen center (400, 300) should map to (1800, 1400): panX + 1800 * zoom === 400, panY + 1400 * zoom === 300.
    expect(fakeViewport.panX + 1800 * fakeViewport.zoom).toBeCloseTo(400, 5);
    expect(fakeViewport.panY + 1400 * fakeViewport.zoom).toBeCloseTo(300, 5);
    // Must not pan miles off-image (old bug divided by 0.25 again -> centered at 7200, 5600).
    expect(Math.abs(fakeViewport.panX)).toBeLessThan(1000);
    expect(Math.abs(fakeViewport.panY)).toBeLessThan(1000);
  });
});
