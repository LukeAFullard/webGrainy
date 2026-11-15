// Cellpose tiling replica vs reference values produced by Cellpose's own code
// (audit/parity/make_tiling_fixture.py, cellpose 3.1.1.1 and 4.1.1).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cpGetPadYX,
  cpNormalizeRgbPerChannel,
  cpPercentile1And99,
  cpResizeBilinear,
  cpTaperMask,
  cpTileStarts,
  runCellposeTiled,
} from '../src/modules/cellposeTiling.js';

type Fixture = {
  taper: Record<string, { sum: number; center: number; corner: number; edgeMid: number; row5: number[] }>;
  pad: Record<string, { none: number[]; min256: number[] }>;
  starts: Record<string, number[]>;
  resize: Array<{ H: number; W: number; H2: number; W2: number; src: number[]; dst: number[] }>;
};
const fx = {
  v3: JSON.parse(readFileSync('tests/fixtures/cellpose_tiling_v3.json', 'utf8')) as Fixture,
  v4: JSON.parse(readFileSync('tests/fixtures/cellpose_tiling_v4.json', 'utf8')) as Fixture,
};

describe('Cellpose tiling replica matches upstream Cellpose', () => {
  it('taper mask', () => {
    for (const [key, ref] of Object.entries(fx.v4.taper)) {
      const [ly, lx] = key.split('x').map(Number) as [number, number];
      const m = cpTaperMask(ly, lx);
      let sum = 0;
      for (const v of m) sum += v;
      expect(sum).toBeCloseTo(ref.sum, 2);
      expect(m[Math.floor(ly / 2) * lx + Math.floor(lx / 2)]).toBeCloseTo(ref.center, 6);
      expect(m[0]).toBeCloseTo(ref.corner, 8);
      expect(m[Math.floor(lx / 2)]).toBeCloseTo(ref.edgeMid, 6);
      ref.row5.forEach((v, x) => expect(m[5 * lx + x]).toBeCloseTo(v, 6));
    }
  });

  it('padding (v3 without minimum, v4 with 256 px minimum)', () => {
    for (const [key, ref] of Object.entries(fx.v3.pad)) {
      const [Ly, Lx] = key.split('x').map(Number) as [number, number];
      expect(cpGetPadYX(Ly, Lx, 'v3', null)).toEqual(ref.none);
      expect(cpGetPadYX(Ly, Lx, 'v3', 256)).toEqual(ref.min256);
    }
    for (const [key, ref] of Object.entries(fx.v4.pad)) {
      const [Ly, Lx] = key.split('x').map(Number) as [number, number];
      expect(cpGetPadYX(Ly, Lx, 'v4', 256)).toEqual(ref.min256);
    }
  });

  it('tile starts', () => {
    for (const [key, ref] of Object.entries(fx.v4.starts)) {
      const [b, ov, L] = key.split('_').map(Number) as [number, number, number];
      expect(cpTileStarts(L, b, ov), key).toEqual(ref);
    }
  });

  it('bilinear resize equals cv2.INTER_LINEAR', () => {
    for (const r of fx.v4.resize) {
      const out = cpResizeBilinear(Float32Array.from(r.src), 1, r.H, r.W, r.H2, r.W2);
      let maxErr = 0;
      out.forEach((v, i) => (maxErr = Math.max(maxErr, Math.abs(v - r.dst[i]!))));
      expect(maxErr, `${r.H}x${r.W}->${r.H2}x${r.W2}`).toBeLessThan(2e-3);
    }
  });

  it('percentiles match numpy linear interpolation', () => {
    const v = Float32Array.from({ length: 1001 }, (_, i) => (i * 7919) % 1001);
    expect(cpPercentile1And99(v)).toEqual([10, 990]);
    const rgba = new Uint8ClampedArray(4 * 300);
    for (let i = 0; i < 300; i++) { rgba[i * 4] = i % 256; rgba[i * 4 + 1] = 100; rgba[i * 4 + 2] = (i * 3) % 256; rgba[i * 4 + 3] = 255; }
    const out = cpNormalizeRgbPerChannel(rgba, 300, 1);
    // constant channel -> zeros (Cellpose sets degenerate channels to 0)
    expect(Array.from(out.subarray(300, 600)).every((x) => x === 0)).toBe(true);
    const r = Float32Array.from({ length: 300 }, (_, i) => i % 256);
    const [p1, p99] = cpPercentile1And99(r);
    expect(out[5]).toBeCloseTo((5 - p1) / (p99 - p1), 6);
  });

  it('tiling an identity "network" reconstructs the input exactly (weights sum correctly)', async () => {
    const C = 3, H = 300, W = 451;
    const img = Float32Array.from({ length: C * H * W }, (_, i) => Math.sin(i * 0.013));
    for (const [version, bsize, ov] of [['v3', 224, 0.1], ['v4', 256, 0.25]] as const) {
      const out = await runCellposeTiled(img, C, H, W, async (t) => t.slice(), { version, bsize, tileOverlap: ov, nout: 3 });
      let maxErr = 0;
      out.forEach((v, i) => (maxErr = Math.max(maxErr, Math.abs(v - img[i]!))));
      expect(maxErr, version).toBeLessThan(1e-5);
    }
  });
});
