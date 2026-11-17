import { describe, expect, it } from 'vitest';
import { applyEvent, describeActivity, formatDuration, markTilesStarting, newActivity, startPhoto } from '../src/ui/progress.js';

describe('analysis progress', () => {
  it('reports download, model load, tiles with time left, and outlines', () => {
    let s = startPhoto(newActivity(3), 2, 'K1.jpg');
    s = applyEvent(s, 'download', { loadedBytes: 100e6, totalBytes: 316e6, modelId: 'x' }, 0);
    let v = describeActivity(s);
    expect(v.title).toBe('Photo 2 of 3 · K1.jpg');
    expect(v.detail).toMatch(/Downloading the model.*100 MB of 316 MB/);
    expect(v.fraction).toBeCloseTo(100 / 316, 5);

    s = applyEvent(s, 'model-load', { phase: 'create-session' }, 0);
    expect(describeActivity(s).detail).toMatch(/Loading the model/);

    s = markTilesStarting(applyEvent(s, 'inference', { model: 'cpsam' }, 1000), 1000);
    s = applyEvent(s, 'inference', { completedTiles: 1, totalTiles: 16 }, 13_000); // 12 s
    s = applyEvent(s, 'inference', { completedTiles: 2, totalTiles: 16 }, 23_000); // 10 s
    v = describeActivity(s);
    expect(v.detail).toBe('Finding grains: tile 2 of 16 · about 2 min 34 s left'); // 14 x 11 s
    expect(v.fraction).toBeCloseTo(2 / 16);
    expect(v.batchFraction).toBeGreaterThan(1 / 3);
    expect(v.batchFraction).toBeLessThan(2 / 3);

    s = applyEvent(s, 'postprocess', { stage: 'flows', percent: 50 }, 30_000);
    expect(describeActivity(s).detail).toMatch(/Tracing grain outlines/);

    // The tile rate carries over to the next photo.
    const next = startPhoto(s, 3, 'K2.jpg');
    expect(next.msPerTile).toBe(11_000);
  });

  it('formats durations', () => {
    expect(formatDuration(4_400)).toBe('4 s');
    expect(formatDuration(60_000)).toBe('1 min');
    expect(formatDuration(95_000)).toBe('1 min 35 s');
    expect(formatDuration(3_900_000)).toBe('1 h 5 min');
  });
});
