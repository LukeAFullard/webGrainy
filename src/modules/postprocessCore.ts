import { orientationFromMoments } from './orientationGeometry.js';
import type {
  GrainMorphometrics,
  PostProcessOptions,
  PostProcessResult,
} from '../types/index.js';

export const DEFAULT_POSTPROCESS_OPTIONS: Required<PostProcessOptions> = {
  niter: 250,
  cellprobThreshold: 0.0,
  flowThreshold: 0.45,
  minSize: 30,
  minSeedDensity: 2,
  excludeBorderMargin: 2,
  // Matches upstream Cellpose max_size_fraction=0.4; held-out IG2 ablation showed 0.15
  // deleted real cobbles on 10/40 CP-SAM test images (+12.4% mean D50 error).
  maxGrainAreaFraction: 0.4,
};

export interface FlowQcResult {
  passed: boolean;
  flowErr: number;
  normalizedErr: number;
  centerX: number;
  centerY: number;
}

/**
 * Solve the 9-point Jacobi heat-diffusion PDE on a local bounding-box mask
 * using a coarse-to-fine multigrid schedule (`8x -> 4x -> 2x -> 1x`) matching
 * `eval_core.py` (Cell 11) and Browser Engine v4.1.
 */
export function multigridJacobiHeat(
  localMask: Uint8Array,
  bw: number,
  bh: number,
  srcX: number,
  srcY: number,
): Float32Array {
  const nLocal = bw * bh;
  if (nLocal === 0) {
    return new Float32Array(0);
  }

  const clampedSrcY = Math.max(0, Math.min(bh - 1, srcY));
  const clampedSrcX = Math.max(0, Math.min(bw - 1, srcX));
  const maxDim = Math.max(bh, bw);

  let coarseFactor = 1;
  let nFine: number;
  if (maxDim >= 192) {
    coarseFactor = 8;
    nFine = Math.min(120, Math.max(60, Math.floor((bh + bw) / 2)));
  } else if (maxDim >= 96) {
    coarseFactor = 4;
    nFine = Math.min(120, Math.max(60, Math.floor((bh + bw) / 2)));
  } else if (maxDim >= 48) {
    coarseFactor = 2;
    nFine = Math.min(120, Math.max(60, Math.floor((bh + bw) / 2)));
  } else {
    coarseFactor = 1;
    nFine = Math.max(50, 2 * (bh + bw));
  }

  let uCurr = new Float32Array(nLocal);
  let uNext = new Float32Array(nLocal);

  if (coarseFactor > 1) {
    const hc = Math.ceil(bh / coarseFactor);
    const wc = Math.ceil(bw / coarseFactor);
    const nCoarsePix = hc * wc;
    const coarseMask = new Uint8Array(nCoarsePix);

    for (let y = 0; y < bh; y++) {
      const cy = Math.floor(y / coarseFactor);
      const rowOffset = y * bw;
      const cRowOffset = cy * wc;
      for (let x = 0; x < bw; x++) {
        if (localMask[rowOffset + x] !== 0) {
          coarseMask[cRowOffset + Math.floor(x / coarseFactor)] = 1;
        }
      }
    }

    const srcCy = Math.min(hc - 1, Math.floor(clampedSrcY / coarseFactor));
    const srcCx = Math.min(wc - 1, Math.floor(clampedSrcX / coarseFactor));
    const srcCIdx = srcCy * wc + srcCx;
    coarseMask[srcCIdx] = 1;

    let cCurr = new Float32Array(nCoarsePix);
    let cNext = new Float32Array(nCoarsePix);

    const nCoarse = Math.max(60, 2 * (hc + wc));
    runJacobi9Point(cCurr, cNext, coarseMask, wc, hc, srcCIdx, nCoarse);
    // Note: if nCoarse is odd, cNext holds final state
    const cFinal = nCoarse % 2 === 1 ? cNext : cCurr;

    // Nearest-neighbor coarseFactor-x repeat upsample
    for (let y = 0; y < bh; y++) {
      const cy = Math.min(hc - 1, Math.floor(y / coarseFactor));
      const rowOff = y * bw;
      const cRowOff = cy * wc;
      for (let x = 0; x < bw; x++) {
        const idx = rowOff + x;
        if (localMask[idx] !== 0) {
          const cx = Math.min(wc - 1, Math.floor(x / coarseFactor));
          uCurr[idx] = cFinal[cRowOff + cx]!;
        }
      }
    }
  }

  const srcIdx = clampedSrcY * bw + clampedSrcX;

  runJacobi9Point(uCurr, uNext, localMask, bw, bh, srcIdx, nFine);
  return nFine % 2 === 1 ? uNext : uCurr;
}

function runJacobi9Point(
  bufA: Float32Array,
  bufB: Float32Array,
  mask: Uint8Array,
  w: number,
  h: number,
  srcIdx: number,
  iters: number,
): void {
  const inv9 = 1.0 / 9.0;
  let curr = bufA;
  let next = bufB;

  for (let iter = 0; iter < iters; iter++) {
    // Inject += 1.0 at center sink before each 9-point stencil sweep (eval_core.py parity)
    curr[srcIdx] = curr[srcIdx]! + 1.0;

    // Fast branch-free interior: y in [1..h-2], x in [1..w-2]
    for (let y = 1; y < h - 1; y++) {
      const rowOff = y * w;
      const prevOff = rowOff - w;
      const nextOff = rowOff + w;
      for (let x = 1; x < w - 1; x++) {
        const idx = rowOff + x;
        if (mask[idx] === 0) {
          next[idx] = 0;
          continue;
        }
        next[idx] =
          (curr[prevOff + x - 1]! +
            curr[prevOff + x]! +
            curr[prevOff + x + 1]! +
            curr[rowOff + x - 1]! +
            curr[idx]! +
            curr[rowOff + x + 1]! +
            curr[nextOff + x - 1]! +
            curr[nextOff + x]! +
            curr[nextOff + x + 1]!) *
          inv9;
      }
    }

    // Boundary rows (y = 0, y = h - 1) and boundary columns (x = 0, x = w - 1)
    for (let y = 0; y < h; y++) {
      const isBorderY = y === 0 || y === h - 1;
      const rowOff = y * w;
      const yPrev = y > 0 ? y - 1 : -1;
      const yNext = y + 1 < h ? y + 1 : -1;

      if (isBorderY) {
        for (let x = 0; x < w; x++) {
          const idx = rowOff + x;
          if (mask[idx] === 0) {
            next[idx] = 0;
            continue;
          }
          const xPrev = x > 0 ? x - 1 : -1;
          const xNext = x + 1 < w ? x + 1 : -1;
          let sum = curr[idx]!;
          if (xPrev >= 0) sum += curr[rowOff + xPrev]!;
          if (xNext >= 0) sum += curr[rowOff + xNext]!;
          if (yPrev >= 0) {
            const pOff = yPrev * w;
            sum += curr[pOff + x]!;
            if (xPrev >= 0) sum += curr[pOff + xPrev]!;
            if (xNext >= 0) sum += curr[pOff + xNext]!;
          }
          if (yNext >= 0) {
            const nOff = yNext * w;
            sum += curr[nOff + x]!;
            if (xPrev >= 0) sum += curr[nOff + xPrev]!;
            if (xNext >= 0) sum += curr[nOff + xNext]!;
          }
          next[idx] = sum * inv9;
        }
      } else {
        // Left column x = 0
        if (mask[rowOff] !== 0) {
          let sum =
            curr[rowOff]! +
            curr[rowOff - w]! +
            curr[rowOff + w]!;
          if (w > 1) {
            sum +=
              curr[rowOff + 1]! +
              curr[rowOff - w + 1]! +
              curr[rowOff + w + 1]!;
          }
          next[rowOff] = sum * inv9;
        } else {
          next[rowOff] = 0;
        }
        // Right column x = w - 1
        if (w > 1) {
          const rIdx = rowOff + w - 1;
          if (mask[rIdx] !== 0) {
            next[rIdx] =
              (curr[rIdx]! +
                curr[rIdx - 1]! +
                curr[rIdx - w]! +
                curr[rIdx - w - 1]! +
                curr[rIdx + w]! +
                curr[rIdx + w - 1]!) *
              inv9;
          } else {
            next[rIdx] = 0;
          }
        }
      }
    }

    const tmp = curr;
    curr = next;
    next = tmp;
  }
}

/**
 * Evaluate `F5_MagWeightedQC` on a candidate grain mask:
 * - Selects center sink closest to `(meanY, meanX)`
 * - Solves multigrid Jacobi heat-diffusion PDE
 * - Excludes `dist2 <= 2` around the center sink
 * - Weights squared error on `5.0`-scaled unit flows by `wMag = min(1.0, rawMag / 1.5)`
 * - Passes if `(flowErr / 10.0) <= flowThreshold`
 */
export function evaluateGrainFlowQcV4(
  pixelIndices: Int32Array | number[],
  flowY: Float32Array,
  flowX: Float32Array,
  width: number,
  height: number,
  flowThreshold: number,
  destIndices?: Int32Array,
): FlowQcResult {
  const n = pixelIndices.length;
  if (n === 0) {
    return {
      passed: false,
      flowErr: 10.0,
      normalizedErr: 1.0,
      centerX: 0,
      centerY: 0,
    };
  }

  let minY = height;
  let maxY = -1;
  let minX = width;
  let maxX = -1;
  let sumY = 0;
  let sumX = 0;

  for (let i = 0; i < n; i++) {
    const p = pixelIndices[i]!;
    const y = Math.floor(p / width);
    const x = p - y * width;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    sumY += y;
    sumX += x;
  }

  const meanY = sumY / n;
  const meanX = sumX / n;
  const bh = maxY - minY + 1;
  const bw = maxX - minX + 1;
  const localMask = new Uint8Array(bw * bh);

  for (let i = 0; i < n; i++) {
    const p = pixelIndices[i]!;
    const y = Math.floor(p / width);
    const x = p - y * width;
    localMask[(y - minY) * bw + (x - minX)] = 1;
  }

  // Pick center sink closest to (meanY, meanX) that lies within the grain
  let srcY = -1;
  let srcX = -1;
  let bestDist2 = Infinity;

  if (destIndices !== undefined) {
    for (let i = 0; i < n; i++) {
      const p = pixelIndices[i]!;
      const dest = destIndices[p]!;
      if (dest >= 0 && dest < width * height) {
        const dyDest = Math.floor(dest / width);
        const dxDest = dest - dyDest * width;
        if (
          dyDest >= minY &&
          dyDest <= maxY &&
          dxDest >= minX &&
          dxDest <= maxX &&
          localMask[(dyDest - minY) * bw + (dxDest - minX)] !== 0
        ) {
          const d2 = (dyDest - meanY) ** 2 + (dxDest - meanX) ** 2;
          if (d2 < bestDist2) {
            bestDist2 = d2;
            srcY = dyDest;
            srcX = dxDest;
          }
        }
      }
    }
  }

  if (srcY < 0) {
    for (let i = 0; i < n; i++) {
      const p = pixelIndices[i]!;
      const y = Math.floor(p / width);
      const x = p - y * width;
      const d2 = (y - meanY) ** 2 + (x - meanX) ** 2;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        srcY = y;
        srcX = x;
      }
    }
  }

  const u = multigridJacobiHeat(localMask, bw, bh, srcX - minX, srcY - minY);

  let weightedErrSum = 0;
  let weightSum = 0;

  for (let i = 0; i < n; i++) {
    const p = pixelIndices[i]!;
    const y = Math.floor(p / width);
    const x = p - y * width;

    const dySink = y - srcY;
    const dxSink = x - srcX;
    if (dySink * dySink + dxSink * dxSink <= 2) {
      continue;
    }

    const ly = y - minY;
    const lx = x - minX;
    const uUp = ly > 0 ? u[(ly - 1) * bw + lx]! : 0;
    const uDown = ly + 1 < bh ? u[(ly + 1) * bw + lx]! : 0;
    const uLeft = lx > 0 ? u[ly * bw + (lx - 1)]! : 0;
    const uRight = lx + 1 < bw ? u[ly * bw + (lx + 1)]! : 0;

    const duY = uDown - uUp;
    const duX = uRight - uLeft;
    const gradNorm = Math.hypot(duY, duX);

    const idealUy = gradNorm > 1e-12 ? duY / gradNorm : 0;
    const idealUx = gradNorm > 1e-12 ? duX / gradNorm : 0;

    const rawFy = flowY[p]!;
    const rawFx = flowX[p]!;
    const fy = Number.isFinite(rawFy) ? rawFy : 0;
    const fx = Number.isFinite(rawFx) ? rawFx : 0;
    const rawMag = Math.hypot(fy, fx);
    const uy = fy / (rawMag + 1e-6);
    const ux = fx / (rawMag + 1e-6);

    const errY = 5.0 * (uy - idealUy);
    const errX = 5.0 * (ux - idealUx);
    const errSq = errY * errY + errX * errX;
    const wMag = Math.min(1.0, rawMag / 1.5);

    weightedErrSum += wMag * errSq;
    weightSum += wMag;
  }

  const flowErr = weightedErrSum / Math.max(weightSum, 1e-6);
  const normalizedErr = flowErr / 10.0;

  return {
    passed: normalizedErr <= flowThreshold,
    flowErr,
    normalizedErr,
    centerX: srcX,
    centerY: srcY,
  };
}

/**
 * `F3_SplitOnFailure`: Attempt to split a QC-failed dumbbell mask into two
 * valid grains using two-peak sink convergence + inward-divergence (`-(duY + duX)`)
 * with `dist2 >= 36` and `score > 0`, competitive 8-BFS + nearest-seed fallback,
 * and `minSize`, `maxArea`, and `evaluateGrainFlowQcV4` validation on both children.
 */
export function trySplitDumbbellV4(
  pixelIndices: Int32Array | number[],
  flowY: Float32Array,
  flowX: Float32Array,
  width: number,
  height: number,
  minSize: number,
  maxArea: number,
  flowThreshold: number,
  sinkHist?: Int32Array,
  destIndices?: Int32Array,
  unitFlowY?: Float32Array,
  unitFlowX?: Float32Array,
): [Int32Array, Int32Array] | null {
  const n = pixelIndices.length;
  if (n < 2 * minSize || n > maxArea) {
    return null;
  }

  let minY = height;
  let maxY = -1;
  let minX = width;
  let maxX = -1;

  for (let i = 0; i < n; i++) {
    const p = pixelIndices[i]!;
    const y = Math.floor(p / width);
    const x = p - y * width;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }

  const bh = maxY - minY + 1;
  const bw = maxX - minX + 1;
  const nLocal = bw * bh;
  const localMask = new Uint8Array(nLocal);

  for (let i = 0; i < n; i++) {
    const p = pixelIndices[i]!;
    const y = Math.floor(p / width);
    const x = p - y * width;
    localMask[(y - minY) * bw + (x - minX)] = 1;
  }

  // Compute inward divergence max(0, -(duY + duX)) on unit flows + additive sinkHist score
  const getUy = (idx: number): number => {
    if (unitFlowY !== undefined) {
      const v = unitFlowY[idx]!;
      return Number.isFinite(v) ? v : 0;
    }
    const rawFy = flowY[idx]!;
    const rawFx = flowX[idx]!;
    const fy = Number.isFinite(rawFy) ? rawFy : 0;
    const fx = Number.isFinite(rawFx) ? rawFx : 0;
    return fy / (Math.hypot(fy, fx) + 1e-6);
  };
  const getUx = (idx: number): number => {
    if (unitFlowX !== undefined) {
      const v = unitFlowX[idx]!;
      return Number.isFinite(v) ? v : 0;
    }
    const rawFy = flowY[idx]!;
    const rawFx = flowX[idx]!;
    const fy = Number.isFinite(rawFy) ? rawFy : 0;
    const fx = Number.isFinite(rawFx) ? rawFx : 0;
    return fx / (Math.hypot(fy, fx) + 1e-6);
  };

  const scores = new Float64Array(n);
  let bestIdx1 = -1;
  let bestScore1 = 0;

  for (let i = 0; i < n; i++) {
    const p = pixelIndices[i]!;
    const y = Math.floor(p / width);
    const x = p - y * width;

    const yUp = y > 0 ? y - 1 : y;
    const yDown = y + 1 < height ? y + 1 : y;
    const xLeft = x > 0 ? x - 1 : x;
    const xRight = x + 1 < width ? x + 1 : x;

    const denomY = yDown - yUp;
    const denomX = xRight - xLeft;
    const duY =
      denomY > 0
        ? (getUy(yDown * width + x) - getUy(yUp * width + x)) / denomY
        : 0;
    const duX =
      denomX > 0
        ? (getUx(y * width + xRight) - getUx(y * width + xLeft)) / denomX
        : 0;
    const inwardDiv = Math.max(0.0, -(duY + duX));

    const conv = sinkHist !== undefined ? sinkHist[p]! : 0;
    const score = conv + 2.0 * inwardDiv;
    scores[i] = score;

    if (score > bestScore1) {
      bestScore1 = score;
      bestIdx1 = i;
    }
  }

  if (bestIdx1 < 0 || bestScore1 <= 0) {
    return null;
  }

  const p1 = pixelIndices[bestIdx1]!;
  const y1 = Math.floor(p1 / width);
  const x1 = p1 - y1 * width;

  let bestIdx2 = -1;
  let bestScore2 = 0;

  for (let i = 0; i < n; i++) {
    const score = scores[i]!;
    if (score <= bestScore2) continue;
    const p = pixelIndices[i]!;
    const y = Math.floor(p / width);
    const x = p - y * width;
    const dist2 = (y - y1) * (y - y1) + (x - x1) * (x - x1);
    if (dist2 >= 36) {
      bestScore2 = score;
      bestIdx2 = i;
    }
  }

  if (bestIdx2 < 0 || bestScore2 <= 0) {
    return null;
  }

  const p2 = pixelIndices[bestIdx2]!;
  const y2 = Math.floor(p2 / width);
  const x2 = p2 - y2 * width;

  // Competitive 8-connected BFS in local bounding box
  const assign = new Uint8Array(nLocal);
  const queue = new Int32Array(nLocal);
  let head = 0;
  let tail = 0;

  const l1 = (y1 - minY) * bw + (x1 - minX);
  const l2 = (y2 - minY) * bw + (x2 - minX);
  assign[l1] = 1;
  assign[l2] = 2;
  queue[tail++] = l1;
  queue[tail++] = l2;

  while (head < tail) {
    const curr = queue[head++]!;
    const lbl = assign[curr]!;
    const ly = Math.floor(curr / bw);
    const lx = curr - ly * bw;

    for (let dy = -1; dy <= 1; dy++) {
      const ny = ly + dy;
      if (ny < 0 || ny >= bh) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dy === 0 && dx === 0) continue;
        const nx = lx + dx;
        if (nx < 0 || nx >= bw) continue;
        const nIdx = ny * bw + nx;
        if (localMask[nIdx] !== 0 && assign[nIdx] === 0) {
          assign[nIdx] = lbl;
          queue[tail++] = nIdx;
        }
      }
    }
  }

  // Partition pixels with nearest-seed fallback for any unreached pixels
  const child1List: number[] = [];
  const child2List: number[] = [];

  for (let i = 0; i < n; i++) {
    const p = pixelIndices[i]!;
    const y = Math.floor(p / width);
    const x = p - y * width;
    const lIdx = (y - minY) * bw + (x - minX);
    let lbl = assign[lIdx]!;
    if (lbl === 0) {
      const d1 = (y - y1) * (y - y1) + (x - x1) * (x - x1);
      const d2 = (y - y2) * (y - y2) + (x - x2) * (x - x2);
      lbl = d1 <= d2 ? 1 : 2;
    }
    if (lbl === 1) {
      child1List.push(p);
    } else {
      child2List.push(p);
    }
  }

  if (
    child1List.length < minSize ||
    child2List.length < minSize ||
    child1List.length > maxArea ||
    child2List.length > maxArea
  ) {
    return null;
  }

  const child1 = Int32Array.from(child1List);
  const child2 = Int32Array.from(child2List);

  const qc1 = evaluateGrainFlowQcV4(
    child1,
    flowY,
    flowX,
    width,
    height,
    flowThreshold,
    destIndices,
  );
  if (!qc1.passed) return null;

  const qc2 = evaluateGrainFlowQcV4(
    child2,
    flowY,
    flowX,
    width,
    height,
    flowThreshold,
    destIndices,
  );
  if (!qc2.passed) return null;

  return [child1, child2];
}

/**
 * Compute second-order central moments and `skimage.measure.regionprops`-parity
 * morphometrics for all labeled grains (`id > 0`) in `masks`.
 */
export function computeGrainMorphometrics(
  masks: Int32Array,
  width: number,
  height: number,
  excludeBorderMargin: number = DEFAULT_POSTPROCESS_OPTIONS.excludeBorderMargin,
): GrainMorphometrics[] {
  const nPix = width * height;
  if (nPix === 0 || masks.length === 0) {
    return [];
  }

  interface GrainAcc {
    id: number;
    area: number;
    sumY: number;
    sumX: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    touchesBorder: boolean;
    cy: number;
    cx: number;
    muY: number;
    muX: number;
    muYX: number;
  }

  const map = new Map<number, GrainAcc>();

  // Pass 1: area, centroid sums, bbox, border flag
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    const yBorder = y < excludeBorderMargin || y >= height - excludeBorderMargin;
    for (let x = 0; x < width; x++) {
      const id = masks[rowOff + x]!;
      if (id <= 0) continue;

      const isBorder =
        yBorder || x < excludeBorderMargin || x >= width - excludeBorderMargin;
      let acc = map.get(id);
      if (acc === undefined) {
        acc = {
          id,
          area: 1,
          sumY: y,
          sumX: x,
          minX: x,
          minY: y,
          maxX: x,
          maxY: y,
          touchesBorder: isBorder,
          cy: 0,
          cx: 0,
          muY: 0,
          muX: 0,
          muYX: 0,
        };
        map.set(id, acc);
      } else {
        acc.area++;
        acc.sumY += y;
        acc.sumX += x;
        if (x < acc.minX) acc.minX = x;
        if (x > acc.maxX) acc.maxX = x;
        if (y < acc.minY) acc.minY = y;
        if (y > acc.maxY) acc.maxY = y;
        if (isBorder) acc.touchesBorder = true;
      }
    }
  }

  if (map.size === 0) {
    return [];
  }

  for (const acc of map.values()) {
    acc.cy = acc.sumY / acc.area;
    acc.cx = acc.sumX / acc.area;
  }

  // Pass 2: centered second-order moments (avoids catastrophic cancellation)
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const id = masks[rowOff + x]!;
      if (id <= 0) continue;
      const acc = map.get(id)!;
      const dy = y - acc.cy;
      const dx = x - acc.cx;
      acc.muY += dy * dy;
      acc.muX += dx * dx;
      acc.muYX += dy * dx;
    }
  }

  const grains: GrainMorphometrics[] = [];
  for (const acc of map.values()) {
    const invA = 1.0 / acc.area;
    const muY = acc.muY * invA;
    const muX = acc.muX * invA;
    const muYX = acc.muYX * invA;

    const common = Math.sqrt(4.0 * muYX * muYX + (muY - muX) * (muY - muX));
    const l1 = Math.max(0, 0.5 * (muY + muX + common));
    const l2 = Math.max(0, 0.5 * (muY + muX - common));

    const aAxisPx = 4.0 * Math.sqrt(l1);
    const bAxisPx = 4.0 * Math.sqrt(l2);
    const dEqPx = Math.sqrt((4.0 * acc.area) / Math.PI);

    // Matches skimage.measure.regionprops.orientation (inertia_tensor [[muX, -muYX], [-muYX, muY]])
    const orientationRad = orientationFromMoments(muX, muY, muYX);

    grains.push({
      id: acc.id,
      areaPx: acc.area,
      centroidX: acc.cx,
      centroidY: acc.cy,
      aAxisPx,
      bAxisPx,
      dEqPx,
      orientationRad,
      touchesBorder: acc.touchesBorder,
      bbox: [acc.minX, acc.minY, acc.maxX, acc.maxY],
    });
  }

  grains.sort((a, b) => a.id - b.id);
  return grains;
}

/**
 * Browser Engine v4.1 post-processing: converts Cellpose/U-Net predicted flows
 * `(flowY, flowX)` and `cellprob` into labeled instance `masks` and per-grain
 * morphometrics with exact parity to `eval_core.py` (Cell 11).
 */
export function flowsToMasksBrowser(
  flowY: Float32Array,
  flowX: Float32Array,
  cellprob: Float32Array,
  width: number,
  height: number,
  options?: PostProcessOptions,
  onProgress?: (stage: string, percent: number) => void,
): PostProcessResult {
  if (width <= 0 || height <= 0) {
    return {
      masks: new Int32Array(0),
      width,
      height,
      grains: [],
      grainCount: 0,
    };
  }

  const nPix = width * height;
  if (
    flowY.length !== nPix ||
    flowX.length !== nPix ||
    cellprob.length !== nPix
  ) {
    throw new Error(
      `Input array length mismatch: expected ${nPix} (${width}x${height}), got flowY=${flowY.length}, flowX=${flowX.length}, cellprob=${cellprob.length}`,
    );
  }

  const niter = options?.niter ?? DEFAULT_POSTPROCESS_OPTIONS.niter;
  const cellprobThreshold =
    options?.cellprobThreshold ?? DEFAULT_POSTPROCESS_OPTIONS.cellprobThreshold;
  const flowThreshold =
    options?.flowThreshold ?? DEFAULT_POSTPROCESS_OPTIONS.flowThreshold;
  const minSize = options?.minSize ?? DEFAULT_POSTPROCESS_OPTIONS.minSize;
  const minSeedDensity =
    options?.minSeedDensity ?? DEFAULT_POSTPROCESS_OPTIONS.minSeedDensity;
  const excludeBorderMargin =
    options?.excludeBorderMargin ??
    DEFAULT_POSTPROCESS_OPTIONS.excludeBorderMargin;
  const maxGrainAreaFraction =
    options?.maxGrainAreaFraction ??
    DEFAULT_POSTPROCESS_OPTIONS.maxGrainAreaFraction;

  onProgress?.('foreground', 5);

  // 1. Collect foreground pixels & compute foreground-masked unit flows (uy, ux)
  const fgList: number[] = [];
  const uy = new Float32Array(nPix);
  const ux = new Float32Array(nPix);

  for (let i = 0; i < nPix; i++) {
    if (cellprob[i]! > cellprobThreshold) {
      fgList.push(i);
      const rawFy = flowY[i]!;
      const rawFx = flowX[i]!;
      const fy = Number.isFinite(rawFy) ? rawFy : 0;
      const fx = Number.isFinite(rawFx) ? rawFx : 0;
      const rawMag = Math.hypot(fy, fx);
      uy[i] = fy / (rawMag + 1e-6);
      ux[i] = fx / (rawMag + 1e-6);
    }
  }

  const fgCount = fgList.length;
  if (fgCount === 0) {
    onProgress?.('done', 100);
    return {
      masks: new Int32Array(nPix),
      width,
      height,
      grains: [],
      grainCount: 0,
    };
  }

  // 2. Two-phase sub-pixel bilinear Euler flow integration
  onProgress?.('flow-integration', 15);
  const coarseSteps = Math.min(100, Math.floor(niter / 2));
  const fineSteps = Math.max(0, niter - coarseSteps);
  const coarseStride = Math.max(1.0, Math.max(width, height) / 256.0);

  const destIndices = new Int32Array(nPix);
  destIndices.fill(-1);
  const sinkHist = new Int32Array(nPix);

  const maxY = height - 1;
  const maxX = width - 1;

  for (let f = 0; f < fgCount; f++) {
    const startIdx = fgList[f]!;
    let py = Math.floor(startIdx / width);
    let px = startIdx - py * width;

    // Phase 1: coarse-stride Euler steps
    for (let s = 0; s < coarseSteps; s++) {
      const y0 = py < 0 ? 0 : py >= height ? maxY : Math.floor(py);
      const x0 = px < 0 ? 0 : px >= width ? maxX : Math.floor(px);
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const wy = py - y0;
      const wx = px - x0;
      const w00 = (1 - wy) * (1 - wx);
      const w01 = (1 - wy) * wx;
      const w10 = wy * (1 - wx);
      const w11 = wy * wx;

      const i00 = y0 * width + x0;
      const i01 = y0 * width + x1;
      const i10 = y1 * width + x0;
      const i11 = y1 * width + x1;

      const dy =
        w00 * uy[i00]! +
        w01 * uy[i01]! +
        w10 * uy[i10]! +
        w11 * uy[i11]!;
      const dx =
        w00 * ux[i00]! +
        w01 * ux[i01]! +
        w10 * ux[i10]! +
        w11 * ux[i11]!;

      py += coarseStride * dy;
      px += coarseStride * dx;
      if (py < 0) py = 0;
      else if (py > maxY) py = maxY;
      if (px < 0) px = 0;
      else if (px > maxX) px = maxX;
    }

    // Phase 2: 1.0 px precision Euler steps
    for (let s = 0; s < fineSteps; s++) {
      const y0 = py < 0 ? 0 : py >= height ? maxY : Math.floor(py);
      const x0 = px < 0 ? 0 : px >= width ? maxX : Math.floor(px);
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const wy = py - y0;
      const wx = px - x0;
      const w00 = (1 - wy) * (1 - wx);
      const w01 = (1 - wy) * wx;
      const w10 = wy * (1 - wx);
      const w11 = wy * wx;

      const i00 = y0 * width + x0;
      const i01 = y0 * width + x1;
      const i10 = y1 * width + x0;
      const i11 = y1 * width + x1;

      const dy =
        w00 * uy[i00]! +
        w01 * uy[i01]! +
        w10 * uy[i10]! +
        w11 * uy[i11]!;
      const dx =
        w00 * ux[i00]! +
        w01 * ux[i01]! +
        w10 * ux[i10]! +
        w11 * ux[i11]!;

      py += dy;
      px += dx;
      if (py < 0) py = 0;
      else if (py > maxY) py = maxY;
      if (px < 0) px = 0;
      else if (px > maxX) px = maxX;
    }

    const sy = Math.max(0, Math.min(maxY, Math.round(py)));
    const sx = Math.max(0, Math.min(maxX, Math.round(px)));
    const dest = sy * width + sx;
    destIndices[startIdx] = dest;
    sinkHist[dest]!++;
  }

  // 3. Sink convergence density check (with fallback to > 0) + 2-pass 3x3 morphological seed dilation
  onProgress?.('seed-clustering', 45);
  let hasDenseSeed = false;
  for (let i = 0; i < nPix; i++) {
    if (sinkHist[i]! >= minSeedDensity) {
      hasDenseSeed = true;
      break;
    }
  }

  const seedThreshold = hasDenseSeed ? minSeedDensity : 1;
  const seed0 = new Uint8Array(nPix);
  let hasAnySeed = false;
  for (let i = 0; i < nPix; i++) {
    if (sinkHist[i]! >= seedThreshold) {
      seed0[i] = 1;
      hasAnySeed = true;
    }
  }

  if (!hasAnySeed) {
    onProgress?.('done', 100);
    return {
      masks: new Int32Array(nPix),
      width,
      height,
      grains: [],
      grainCount: 0,
    };
  }

  const dilate3x3 = (src: Uint8Array): Uint8Array => {
    const dst = new Uint8Array(nPix);
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        if (src[rowOff + x] === 0) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          const nOff = ny * width;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx >= 0 && nx < width) {
              dst[nOff + nx] = 1;
            }
          }
        }
      }
    }
    return dst;
  };

  const seed1 = dilate3x3(seed0);
  const seed2 = dilate3x3(seed1);

  // 4. 8-connected BFS component labeling on dilated seeds
  const seedLabels = new Int32Array(nPix);
  const bfsQueue = new Int32Array(nPix);
  let numSeeds = 0;

  for (let i = 0; i < nPix; i++) {
    if (seed2[i] === 0 || seedLabels[i] !== 0) continue;
    numSeeds++;
    seedLabels[i] = numSeeds;
    let head = 0;
    let tail = 0;
    bfsQueue[tail++] = i;

    while (head < tail) {
      const curr = bfsQueue[head++]!;
      const cy = Math.floor(curr / width);
      const cx = curr - cy * width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= height) continue;
        const nOff = ny * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = nOff + nx;
          if (seed2[nIdx] !== 0 && seedLabels[nIdx] === 0) {
            seedLabels[nIdx] = numSeeds;
            bfsQueue[tail++] = nIdx;
          }
        }
      }
    }
  }

  // 5. Assign foreground pixels to seed labels & 2-px (5x5) sink-window snapping in row-major order
  const candidates = new Map<number, number[]>();

  for (let f = 0; f < fgCount; f++) {
    const p = fgList[f]!;
    const dest = destIndices[p]!;
    let lbl = seedLabels[dest]!;

    if (lbl === 0) {
      const sy = Math.floor(dest / width);
      const sx = dest - sy * width;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = sy + dy;
        if (ny < 0 || ny >= height) continue;
        const nOff = ny * width;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = sx + dx;
          if (nx < 0 || nx >= width) continue;
          const sLbl = seedLabels[nOff + nx]!;
          if (sLbl > 0) {
            lbl = sLbl;
            break;
          }
        }
        if (lbl > 0) break;
      }
    }

    if (lbl <= 0) continue;
    let list = candidates.get(lbl);
    if (list === undefined) {
      list = [p];
      candidates.set(lbl, list);
    } else {
      list.push(p);
    }
  }

  // 6. Flow QC (F5_MagWeightedQC), Mandatory v4.1 Upper-Area Guard, & F3_SplitOnFailure
  onProgress?.('flow-qc', 65);
  const maxArea = maxGrainAreaFraction * width * height;
  const finalMasks = new Int32Array(nPix);
  let nextGrainId = 0;

  const candidateList = Array.from(candidates.values());
  const totalCandidates = candidateList.length;

  for (let c = 0; c < totalCandidates; c++) {
    const pixList = candidateList[c]!;
    const area = pixList.length;

    if (area < minSize) {
      continue;
    }

    // Mandatory v4.1 Upper-Area Guard (3ca10b7c outlier fix):
    // Check BEFORE evaluateGrainFlowQcV4 / trySplitDumbbellV4
    if (area > maxArea) {
      continue;
    }

    const qc = evaluateGrainFlowQcV4(
      pixList,
      flowY,
      flowX,
      width,
      height,
      flowThreshold,
      destIndices,
    );

    if (qc.passed) {
      nextGrainId++;
      for (let i = 0; i < area; i++) {
        finalMasks[pixList[i]!] = nextGrainId;
      }
    } else {
      const split = trySplitDumbbellV4(
        pixList,
        flowY,
        flowX,
        width,
        height,
        minSize,
        maxArea,
        flowThreshold,
        sinkHist,
        destIndices,
        uy,
        ux,
      );
      if (split !== null) {
        const [c1, c2] = split;
        if (c1.length <= maxArea && c2.length <= maxArea) {
          nextGrainId++;
          for (let i = 0; i < c1.length; i++) {
            finalMasks[c1[i]!] = nextGrainId;
          }
          nextGrainId++;
          for (let i = 0; i < c2.length; i++) {
            finalMasks[c2[i]!] = nextGrainId;
          }
        }
      }
    }
  }

  onProgress?.('morphometrics', 90);
  const grains = computeGrainMorphometrics(
    finalMasks,
    width,
    height,
    excludeBorderMargin,
  );
  onProgress?.('done', 100);

  return {
    masks: finalMasks,
    width,
    height,
    grains,
    grainCount: grains.length,
  };
}
