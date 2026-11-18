import { describe, expect, it } from 'vitest';
import { countFlagged, grainFlags, navigateGrains, type NavGrain } from '../src/ui/grainNav.js';

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

  it('explains why a grain is flagged', () => {
    expect(grainFlags(grains[2]!)).toEqual(['very elongated (b/a 0.20)']);
    expect(grainFlags(grains[1]!)).toEqual(['touches the photo edge']);
    expect(grainFlags(grains[3]!)).toEqual(['outside the ROI or in an excluded area']);
    expect(grainFlags(grains[0]!)).toEqual([]);
  });
});
