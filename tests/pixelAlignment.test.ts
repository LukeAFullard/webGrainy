/** Outlines, centroids and the full-size mask agree on where a grain is in the photo. */
import { describe, expect, it } from 'vitest';
import { squareGrainSession } from './helpers/squareSession.js';

describe('working image -> photo pixel alignment', () => {
  // squareGrainSession puts the first grain on working pixels x, y = 10..19. At scale 0.5 each
  // working pixel covers 2 x 2 photo pixels, so the grain covers photo pixels 20..39.
  const session = squareGrainSession([10], { w: 60, h: 60, scale: 0.5 });

  it('the full-size label mask covers exactly photo pixels 20..39', async () => {
    const masks = (session as unknown as { maskForExport: (b: 16, o: object) => { masks: Int32Array; width: number } }).maskForExport(16, {});
    const row = 30 * masks.width;
    const xs = [...Array(masks.width).keys()].filter((x) => masks.masks[row + x] === 1);
    expect([xs[0], xs.at(-1)]).toEqual([20, 39]);
  });

  it('the centroid is the centre of photo pixels 20..39 (29.5)', () => {
    const g = session.getResult().grains[0]!;
    expect(g.centroidX).toBeCloseTo(29.5, 9);
    expect(g.centroidY).toBeCloseTo(29.5, 9);
  });

  it('GeoJSON outline runs along the pixel edges 20 and 40 (pixel corners at integers)', () => {
    const fc = JSON.parse(session.exportGeoJson()) as { features: Array<{ geometry: { coordinates: number[][][] } }> };
    const ring = fc.features[0]!.geometry.coordinates[0]!;
    const xs = ring.map((p) => p[0]!);
    expect(Math.min(...xs)).toBeCloseTo(20, 9);
    expect(Math.max(...xs)).toBeCloseTo(40, 9);
  });

  it('outline and centroid agree: centroid (index coordinates) + 0.5 = middle of the outline', () => {
    const fc = JSON.parse(session.exportGeoJson()) as { features: Array<{ geometry: { coordinates: number[][][] } }> };
    const xs = fc.features[0]!.geometry.coordinates[0]!.map((p) => p[0]!);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(session.getResult().grains[0]!.centroidX + 0.5, 9);
  });
});
