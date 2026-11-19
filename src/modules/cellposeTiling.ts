/**
 * Exact re-implementation of upstream Cellpose's image tiling (core.run_net,
 * transforms.get_pad_yx / make_tiles / _taper_mask / average_tiles / resize_image).
 *
 * Why: running our (bit-exact) ONNX exports through Cellpose's own pipeline reproduces
 * PyTorch exactly, but webGrainy's earlier tiling (whole-image U-Net, reflect padding,
 * Hanning blending, no 8 px zero border) did not. Outlines then differed from PyTorch
 * (PQ vs PyTorch 0.58 for U-Net, 0.80 for Cellpose-SAM). See validation/parity/.
 *
 * Variants:
 *  - 'v3' (Cellpose 3.x, IG2 U-Net):         224 px tiles, 10 % overlap, pad to /16 + 8 px border
 *  - 'v4' (Cellpose 4.x, IG2 Cellpose-SAM):  256 px tiles, overlap as configured, and images
 *                                           smaller than a tile are zero-padded up to the tile size
 */

export type CellposeVersion = 'v3' | 'v4';

/** Pads [top, bottom, left, right]: replica of `transforms.get_pad_yx(div=16, extra=1)`. */
export function cpGetPadYX(
  Ly: number,
  Lx: number,
  version: CellposeVersion,
  minSize: number | null,
): [number, number, number, number] {
  const div = 16;
  const extra = 1;
  const one = (L: number): [number, number] => {
    let Lpad: number;
    if (minSize === null || L >= minSize) {
      Lpad = Math.trunc(div * Math.ceil(L / div) - L);
    } else if (version === 'v4') {
      Lpad = Math.max(0, minSize - L - extra * div);
    } else {
      Lpad = minSize - L;
    }
    const half = Math.floor((extra * div) / 2);
    return [half + Math.floor(Lpad / 2), half + Lpad - Math.floor(Lpad / 2)];
  };
  const [y1, y2] = one(Ly);
  const [x1, x2] = one(Lx);
  return [y1, y2, x1, x2];
}

/** Tile start offsets along one axis: replica of `make_tiles` (non-augmented). */
export function cpTileStarts(L: number, bsize: number, tileOverlap: number): number[] {
  const ov = Math.min(0.5, Math.max(0.05, tileOverlap));
  const b = Math.min(bsize, L);
  const n = L <= bsize ? 1 : Math.ceil(((1 + 2 * ov) * L) / bsize);
  if (n === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // np.linspace(0, L - b, n).astype(int): truncation toward zero
    out.push(Math.trunc(((L - b) * i) / (n - 1)));
  }
  return out;
}

/** Sigmoid taper mask (ly x lx, row-major): replica of `transforms._taper_mask(sig=7.5)`. */
export function cpTaperMask(ly: number, lx: number, sig = 7.5): Float32Array {
  const bsize = Math.max(224, ly, lx);
  const centre = (bsize - 1) / 2;
  const v = new Float64Array(bsize);
  for (let i = 0; i < bsize; i++) {
    const xm = Math.abs(i - centre);
    v[i] = 1 / (1 + Math.exp((xm - (bsize / 2 - 20)) / sig));
  }
  const y0 = Math.floor(bsize / 2) - Math.floor(ly / 2);
  const x0 = Math.floor(bsize / 2) - Math.floor(lx / 2);
  const out = new Float32Array(ly * lx);
  for (let y = 0; y < ly; y++) {
    const vy = v[y0 + y]!;
    for (let x = 0; x < lx; x++) out[y * lx + x] = vy * v[x0 + x]!;
  }
  return out;
}

/**
 * Bilinear resize of a CHW float image: replica of `transforms.resize_image`
 * (cv2.resize, INTER_LINEAR, half-pixel centres, edge clamping, no antialiasing).
 */
export function cpResizeBilinear(
  src: Float32Array,
  C: number,
  H: number,
  W: number,
  H2: number,
  W2: number,
): Float32Array {
  const out = new Float32Array(C * H2 * W2);
  const sy = H / H2;
  const sx = W / W2;
  const xi0 = new Int32Array(W2);
  const xi1 = new Int32Array(W2);
  const xw = new Float32Array(W2);
  for (let x = 0; x < W2; x++) {
    let fx = (x + 0.5) * sx - 0.5;
    if (fx < 0) fx = 0;
    let i0 = Math.floor(fx);
    if (i0 > W - 1) i0 = W - 1;
    xi0[x] = i0;
    xi1[x] = Math.min(i0 + 1, W - 1);
    xw[x] = Math.min(1, fx - i0);
  }
  for (let y = 0; y < H2; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    let j0 = Math.floor(fy);
    if (j0 > H - 1) j0 = H - 1;
    const j1 = Math.min(j0 + 1, H - 1);
    const wy = Math.min(1, fy - j0);
    for (let c = 0; c < C; c++) {
      const base = c * H * W;
      const r0 = base + j0 * W;
      const r1 = base + j1 * W;
      const o = c * H2 * W2 + y * W2;
      for (let x = 0; x < W2; x++) {
        const a = src[r0 + xi0[x]!]! + (src[r0 + xi1[x]!]! - src[r0 + xi0[x]!]!) * xw[x]!;
        const b = src[r1 + xi0[x]!]! + (src[r1 + xi1[x]!]! - src[r1 + xi0[x]!]!) * xw[x]!;
        out[o + x] = a + (b - a) * wy;
      }
    }
  }
  return out;
}

export interface CellposeTilingOptions {
  version: CellposeVersion;
  bsize: number;
  tileOverlap: number;
  /** Number of network output channels (3: dY, dX, cellprob). */
  nout?: number;
  signal?: AbortSignal;
  onTile?: (done: number, total: number) => void;
  /**
   * Optional tile filter. Receives the tile's extent in (unpadded) image coordinates,
   * end-exclusive, and returns false to skip it. Pixels covered only by skipped tiles get
   * flows 0 and cellprob `SKIPPED_CELLPROB` (background). Pixels covered by at least one
   * run tile are averaged over the run tiles only.
   */
  needTile?: (y0: number, x0: number, y1: number, x1: number) => boolean;
  /** Called once before inference with the tiles that will run (image coords) and the total. */
  onPlan?: (plan: { run: Array<[number, number, number, number]>; total: number }) => void;
}

/** Cellprob given to pixels no tile was run on (confident background). */
export const SKIPPED_CELLPROB = -20;

/**
 * Runs `runTile` over Cellpose-style tiles of a normalised CHW image and blends the
 * outputs with the sigmoid taper, exactly as Cellpose's core.run_net does. `runTile`
 * receives one tile (C x th x tw) and must return (nout x th x tw).
 */
export async function runCellposeTiled(
  image: Float32Array,
  C: number,
  H: number,
  W: number,
  runTile: (tile: Float32Array, th: number, tw: number) => Promise<Float32Array>,
  opts: CellposeTilingOptions,
): Promise<Float32Array> {
  const nout = opts.nout ?? 3;
  const minSize = opts.version === 'v4' ? opts.bsize : null;
  const [y1, y2, x1, x2] = cpGetPadYX(H, W, opts.version, minSize);
  const Ly = H + y1 + y2;
  const Lx = W + x1 + x2;
  // zero (constant) padding, as np.pad(mode="constant")
  const padded = new Float32Array(C * Ly * Lx);
  for (let c = 0; c < C; c++) {
    for (let y = 0; y < H; y++) {
      padded.set(
        image.subarray(c * H * W + y * W, c * H * W + (y + 1) * W),
        c * Ly * Lx + (y + y1) * Lx + x1,
      );
    }
  }
  const th = Math.min(opts.bsize, Ly);
  const tw = Math.min(opts.bsize, Lx);
  const ys = cpTileStarts(Ly, opts.bsize, opts.tileOverlap);
  const xs = cpTileStarts(Lx, opts.bsize, opts.tileOverlap);
  const mask = cpTaperMask(th, tw);
  const acc = new Float32Array(nout * Ly * Lx);
  const navg = new Float64Array(Ly * Lx);
  const tile = new Float32Array(C * th * tw);
  // Decide which tiles to run (extent in unpadded image coordinates, end-exclusive).
  const plan: Array<[number, number]> = [];
  const runRects: Array<[number, number, number, number]> = [];
  for (const ty of ys) {
    for (const tx of xs) {
      const r: [number, number, number, number] = [
        Math.max(0, ty - y1),
        Math.max(0, tx - x1),
        Math.min(H, ty - y1 + th),
        Math.min(W, tx - x1 + tw),
      ];
      if (opts.needTile && !opts.needTile(r[0], r[1], r[2], r[3])) continue;
      plan.push([ty, tx]);
      runRects.push(r);
    }
  }
  opts.onPlan?.({ run: runRects, total: ys.length * xs.length });
  const total = plan.length;
  let done = 0;
  opts.onTile?.(0, total); // lets progress UIs time the first tile
  for (const [ty, tx] of plan) {
    {
      if (opts.signal?.aborted) {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        throw err;
      }
      for (let c = 0; c < C; c++) {
        for (let y = 0; y < th; y++) {
          const s = c * Ly * Lx + (ty + y) * Lx + tx;
          tile.set(padded.subarray(s, s + tw), c * th * tw + y * tw);
        }
      }
      const out = await runTile(tile, th, tw);
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const m = mask[y * tw + x]!;
          const p = (ty + y) * Lx + tx + x;
          navg[p]! += m;
          for (let k = 0; k < nout; k++) {
            acc[k * Ly * Lx + p]! += out[k * th * tw + y * tw + x]! * m;
          }
        }
      }
      done++;
      opts.onTile?.(done, total);
    }
  }
  // crop padding and divide by summed weights
  const result = new Float32Array(nout * H * W);
  for (let k = 0; k < nout; k++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = (y + y1) * Lx + x + x1;
        const w = navg[p]!;
        result[k * H * W + y * W + x] =
          w > 0 ? acc[k * Ly * Lx + p]! / w : k === nout - 1 ? SKIPPED_CELLPROB : 0;
      }
    }
  }
  return result;
}

/**
 * Exact 1st/99th percentile of a float array with numpy's default 'linear'
 * interpolation (np.percentile). Sorts a copy: O(n log n).
 */
export function cpPercentile1And99(values: Float32Array): [number, number] {
  const n = values.length;
  if (n === 0) return [0, 0];
  const s = Float64Array.from(values).sort();
  const at = (q: number): number => {
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.min(n - 1, lo + 1);
    return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  };
  return [at(0.01), at(0.99)];
}

/** Per-channel 1-99 % normalisation of an HWC uint8 RGBA image into CHW (Cellpose 4). */
export function cpNormalizeRgbPerChannel(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const n = width * height;
  const out = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    // integer data: exact numpy 'linear' percentiles from a 256-bin histogram
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[rgba[i * 4 + c]!]! += 1;
    // value at sorted rank r (0-based), read from the cumulative histogram
    const rankValue = (r: number): number => {
      let cum = 0;
      for (let v = 0; v < 256; v++) {
        cum += hist[v]!;
        if (cum > r) return v;
      }
      return 255;
    };
    const pct = (q: number): number => {
      const pos = (n - 1) * q;
      const lo = Math.floor(pos);
      const hi = Math.min(n - 1, lo + 1);
      const a = rankValue(lo);
      return a + (rankValue(hi) - a) * (pos - lo);
    };
    const p1 = pct(0.01);
    const p99 = pct(0.99);
    const denom = p99 - p1;
    for (let i = 0; i < n; i++) {
      out[c * n + i] = denom > 1e-3 ? (rgba[i * 4 + c]! - p1) / denom : 0;
    }
  }
  return out;
}
