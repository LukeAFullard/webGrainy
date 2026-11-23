/**
 * Mock-model helper: maps a flow field drawn in working-image pixels onto the tiles the engine's
 * Cellpose pipelines run (U-Net: image resized by 17/30, 224 px tiles, 10 % overlap; Cellpose-SAM:
 * 256 px tiles, 25 % overlap), so mocks can place grains in image coordinates. The engine runs the
 * tiles in row-major order, one per `session.run`; call `tile(k)` with the run's index.
 */
import { cpGetPadYX, cpTileStarts } from '../../src/modules/cellposeTiling.js';

export interface FlowField {
  flowY: Float32Array;
  flowX: Float32Array;
  cellprob: Float32Array;
}

export function cellposeTileMock(
  kind: 'unet' | 'cpsam',
  width: number,
  height: number,
  field: FlowField,
): { tiles: number; tile(k: number): FlowField & { th: number; tw: number } } {
  const unet = kind === 'unet';
  const r = unet ? 17 / 30 : 1;
  const W2 = unet ? Math.max(1, Math.trunc(width * r)) : width;
  const H2 = unet ? Math.max(1, Math.trunc(height * r)) : height;
  const bsize = unet ? 224 : 256;
  const [y1, y2, x1, x2] = cpGetPadYX(H2, W2, unet ? 'v3' : 'v4', unet ? null : bsize);
  const Ly = H2 + y1 + y2;
  const Lx = W2 + x1 + x2;
  const th = Math.min(bsize, Ly);
  const tw = Math.min(bsize, Lx);
  const ys = cpTileStarts(Ly, bsize, unet ? 0.1 : 0.25);
  const xs = cpTileStarts(Lx, bsize, unet ? 0.1 : 0.25);
  // The field in the padded (and, for U-Net, resized) frame: nearest-neighbour resampling keeps
  // unit flows pointing at the same grain centre.
  const g: FlowField = { flowY: new Float32Array(Ly * Lx), flowX: new Float32Array(Ly * Lx), cellprob: new Float32Array(Ly * Lx).fill(-4) };
  for (let y = 0; y < H2; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / H2));
    for (let x = 0; x < W2; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / W2));
      const s = sy * width + sx;
      const d = (y + y1) * Lx + x + x1;
      g.flowY[d] = field.flowY[s]!;
      g.flowX[d] = field.flowX[s]!;
      g.cellprob[d] = field.cellprob[s]!;
    }
  }
  return {
    tiles: ys.length * xs.length,
    tile(k: number) {
      const i = k % (ys.length * xs.length);
      const ty = ys[Math.floor(i / xs.length)]!;
      const tx = xs[i % xs.length]!;
      const out = { flowY: new Float32Array(th * tw), flowX: new Float32Array(th * tw), cellprob: new Float32Array(th * tw), th, tw };
      for (let y = 0; y < th; y++) {
        const s = (ty + y) * Lx + tx;
        out.flowY.set(g.flowY.subarray(s, s + tw), y * tw);
        out.flowX.set(g.flowX.subarray(s, s + tw), y * tw);
        out.cellprob.set(g.cellprob.subarray(s, s + tw), y * tw);
      }
      return out;
    },
  };
}
