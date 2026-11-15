import type {
  ModelKind,
  ModelRecommendation,
  ScaleMode,
  WorkingImageResult,
} from '../types/index.js';

export interface ImageBufferLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface HardwareCapabilities {
  hasWebGPU?: boolean;
  hasShaderF16?: boolean;
  deviceMemoryGB?: number | null;
}

function validateImageDimensions(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`Invalid image dimensions: ${width}x${height}`);
  }
  const requiredBytes = width * height * 4;
  if (data.length < requiredBytes) {
    throw new RangeError(
      `RGBA buffer length (${data.length}) is smaller than required ${requiredBytes} bytes for ${width}x${height}.`,
    );
  }
}

/**
 * Computes exact `np.percentile(..., [1, 99], method='linear')` from a 256-bin uint8 histogram.
 */
function percentile1And99FromHist256(
  hist: Int32Array,
  totalCount: number,
): [number, number] {
  if (totalCount <= 0) {
    return [0, 0];
  }
  if (totalCount === 1) {
    for (let b = 0; b < 256; b++) {
      if (hist[b]! > 0) {
        return [b, b];
      }
    }
    return [0, 0];
  }

  const valueAtRank = (rank: number): number => {
    let cum = 0;
    for (let b = 0; b < 256; b++) {
      cum += hist[b]!;
      if (cum > rank) {
        return b;
      }
    }
    return 255;
  };

  const computePercentile = (q: number): number => {
    const idx = (q / 100) * (totalCount - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const frac = idx - lo;
    const vLo = valueAtRank(lo);
    if (lo === hi) {
      return vLo;
    }
    const vHi = valueAtRank(hi);
    return vLo + frac * (vHi - vLo);
  };

  return [computePercentile(1), computePercentile(99)];
}

/**
 * Pure TypedArray Contrast Limited Adaptive Histogram Equalization (CLAHE)
 * on YCbCr luminance (`Y` channel), preserving `Cb`, `Cr`, and alpha.
 */
export function applyCLAHE(
  imageData: ImageBufferLike,
  clipLimit = 2.0,
  tileGridSize = 8,
): ImageBufferLike {
  const { data, width, height } = imageData;
  validateImageDimensions(data, width, height);
  if (!Number.isFinite(clipLimit) || clipLimit <= 0) {
    throw new RangeError(`clipLimit must be a finite positive number, got ${clipLimit}.`);
  }
  if (!Number.isFinite(tileGridSize) || tileGridSize < 1) {
    throw new RangeError(`tileGridSize must be a finite number >= 1, got ${tileGridSize}.`);
  }

  const numPixels = width * height;
  const gridX = Math.max(1, Math.min(Math.floor(tileGridSize), width));
  const gridY = Math.max(1, Math.min(Math.floor(tileGridSize), height));

  const yPlane = new Uint8Array(numPixels);
  const cbPlane = new Float32Array(numPixels);
  const crPlane = new Float32Array(numPixels);

  for (let i = 0; i < numPixels; i++) {
    const p = i * 4;
    const r = data[p]!;
    const g = data[p + 1]!;
    const b = data[p + 2]!;
    const yVal = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    yPlane[i] = yVal < 0 ? 0 : yVal > 255 ? 255 : yVal;
    cbPlane[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    crPlane[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  }

  const xBounds = new Int32Array(gridX + 1);
  const yBounds = new Int32Array(gridY + 1);
  const cx = new Float32Array(gridX);
  const cy = new Float32Array(gridY);

  for (let tx = 0; tx <= gridX; tx++) {
    xBounds[tx] = Math.floor((tx * width) / gridX);
  }
  for (let tx = 0; tx < gridX; tx++) {
    cx[tx] = (xBounds[tx]! + xBounds[tx + 1]! - 1) * 0.5;
  }
  for (let ty = 0; ty <= gridY; ty++) {
    yBounds[ty] = Math.floor((ty * height) / gridY);
  }
  for (let ty = 0; ty < gridY; ty++) {
    cy[ty] = (yBounds[ty]! + yBounds[ty + 1]! - 1) * 0.5;
  }

  const luts = new Float32Array(gridY * gridX * 256);
  const hist = new Int32Array(256);

  for (let ty = 0; ty < gridY; ty++) {
    const y0 = yBounds[ty]!;
    const y1 = yBounds[ty + 1]!;
    for (let tx = 0; tx < gridX; tx++) {
      const x0 = xBounds[tx]!;
      const x1 = xBounds[tx + 1]!;
      const tilePixels = (x1 - x0) * (y1 - y0);

      hist.fill(0);
      for (let y = y0; y < y1; y++) {
        const rowOff = y * width;
        for (let x = x0; x < x1; x++) {
          hist[yPlane[rowOff + x]!]! += 1;
        }
      }

      let maxBinCount = 0;
      for (let b = 0; b < 256; b++) {
        if (hist[b]! > maxBinCount) {
          maxBinCount = hist[b]!;
        }
      }

      const lutOffset = (ty * gridX + tx) * 256;
      if (maxBinCount === tilePixels) {
        for (let b = 0; b < 256; b++) {
          luts[lutOffset + b] = b;
        }
        continue;
      }

      const limit = Math.max(1, Math.round((clipLimit * tilePixels) / 256));
      let excess = 0;
      for (let b = 0; b < 256; b++) {
        const count = hist[b]!;
        if (count > limit) {
          excess += count - limit;
          hist[b] = limit;
        }
      }

      if (excess > 0) {
        const avgInc = Math.floor(excess / 256);
        let remainder = excess - avgInc * 256;
        if (avgInc > 0) {
          for (let b = 0; b < 256; b++) {
            hist[b]! += avgInc;
          }
        }
        if (remainder > 0) {
          const step = Math.max(1, Math.floor(256 / remainder));
          for (let b = 0; b < 256 && remainder > 0; b += step) {
            hist[b]! += 1;
            remainder--;
          }
          for (let b = 0; b < 256 && remainder > 0; b++) {
            hist[b]! += 1;
            remainder--;
          }
        }
      }

      let cdf = 0;
      let cdfMin = 0;
      let foundMin = false;

      for (let b = 0; b < 256; b++) {
        cdf += hist[b]!;
        if (!foundMin && hist[b]! > 0) {
          cdfMin = cdf;
          foundMin = true;
        }
        if (!foundMin) {
          luts[lutOffset + b] = 0;
        } else if (tilePixels <= cdfMin) {
          luts[lutOffset + b] = b;
        } else {
          const eq = ((cdf - cdfMin) / (tilePixels - cdfMin)) * 255;
          luts[lutOffset + b] = eq < 0 ? 0 : eq > 255 ? 255 : eq;
        }
      }
    }
  }

  // Precompute x-bracketing indices and weights
  const tx0Arr = new Int32Array(width);
  const tx1Arr = new Int32Array(width);
  const fxArr = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    if (gridX === 1 || x <= cx[0]!) {
      tx0Arr[x] = 0;
      tx1Arr[x] = 0;
      fxArr[x] = 0;
    } else if (x >= cx[gridX - 1]!) {
      tx0Arr[x] = gridX - 1;
      tx1Arr[x] = gridX - 1;
      fxArr[x] = 0;
    } else {
      let tx0 = 0;
      while (tx0 < gridX - 2 && cx[tx0 + 1]! < x) {
        tx0++;
      }
      const tx1 = tx0 + 1;
      const denom = cx[tx1]! - cx[tx0]!;
      tx0Arr[x] = tx0;
      tx1Arr[x] = tx1;
      fxArr[x] = denom > 0 ? (x - cx[tx0]!) / denom : 0;
    }
  }

  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    let ty0 = 0;
    let ty1 = 0;
    let fy = 0;
    if (gridY > 1 && y > cy[0]!) {
      if (y >= cy[gridY - 1]!) {
        ty0 = gridY - 1;
        ty1 = gridY - 1;
        fy = 0;
      } else {
        while (ty0 < gridY - 2 && cy[ty0 + 1]! < y) {
          ty0++;
        }
        ty1 = ty0 + 1;
        const denomY = cy[ty1]! - cy[ty0]!;
        fy = denomY > 0 ? (y - cy[ty0]!) / denomY : 0;
      }
    }

    const rowTile0 = ty0 * gridX;
    const rowTile1 = ty1 * gridX;
    const rowPix = y * width;

    for (let x = 0; x < width; x++) {
      const idx = rowPix + x;
      const yVal = yPlane[idx]!;
      const tx0 = tx0Arr[x]!;
      const tx1 = tx1Arr[x]!;
      const fx = fxArr[x]!;

      const v00 = luts[(rowTile0 + tx0) * 256 + yVal]!;
      const v10 = luts[(rowTile0 + tx1) * 256 + yVal]!;
      const v01 = luts[(rowTile1 + tx0) * 256 + yVal]!;
      const v11 = luts[(rowTile1 + tx1) * 256 + yVal]!;

      const top = v00 + fx * (v10 - v00);
      const bot = v01 + fx * (v11 - v01);
      const yEq = top + fy * (bot - top);

      const cbShift = cbPlane[idx]! - 128;
      const crShift = crPlane[idx]! - 128;

      const r = yEq + 1.402 * crShift;
      const g = yEq - 0.344136 * cbShift - 0.714136 * crShift;
      const b = yEq + 1.772 * cbShift;

      const p = idx * 4;
      out[p] = Math.round(r);
      out[p + 1] = Math.round(g);
      out[p + 2] = Math.round(b);
      out[p + 3] = data[p + 3]!;
    }
  }

  return { data: out, width, height };
}

/**
 * Adaptive input scaling with pure TypedArray bilinear RGBA resampling.
 * Tracks `effectiveScaleFactor` (`newWidth / width`) so morphometrics scale back accurately.
 */
export function prepareWorkingImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  scaleMode: ScaleMode = 'auto',
): WorkingImageResult {
  validateImageDimensions(rgba, width, height);

  const maxDim = Math.max(width, height);
  let targetScale = 1.0;
  let scaleModeApplied: Exclude<ScaleMode, 'auto'> = '1.0x';

  if (scaleMode === '1.0x') {
    targetScale = 1.0;
    scaleModeApplied = '1.0x';
  } else if (scaleMode === '0.5x') {
    targetScale = 0.5;
    scaleModeApplied = '0.5x';
  } else if (scaleMode === '0.25x') {
    targetScale = 0.25;
    scaleModeApplied = '0.25x';
  } else {
    // 'auto'
    if (maxDim <= 1024) {
      targetScale = 1.0;
      scaleModeApplied = '1.0x';
    } else if (maxDim <= 2048) {
      targetScale = 0.5;
      scaleModeApplied = '0.5x';
    } else if (maxDim <= 4096) {
      targetScale = 0.25;
      scaleModeApplied = '0.25x';
    } else {
      targetScale = 1024 / maxDim;
      scaleModeApplied = '0.25x';
    }
  }

  if (targetScale === 1.0) {
    return {
      data: new Uint8ClampedArray(rgba.subarray(0, width * height * 4)),
      width,
      height,
      originalWidth: width,
      originalHeight: height,
      effectiveScaleFactor: 1,
      scaleModeApplied: '1.0x',
    };
  }

  const newWidth = Math.max(1, Math.round(width * targetScale));
  const newHeight = Math.max(1, Math.round(height * targetScale));
  const out = new Uint8ClampedArray(newWidth * newHeight * 4);

  const x0Arr = new Int32Array(newWidth);
  const x1Arr = new Int32Array(newWidth);
  const fxArr = new Float32Array(newWidth);

  for (let dx = 0; dx < newWidth; dx++) {
    const sx = Math.min(width - 1, Math.max(0, ((dx + 0.5) * width) / newWidth - 0.5));
    const x0 = Math.floor(sx);
    const x1 = Math.min(width - 1, x0 + 1);
    x0Arr[dx] = x0;
    x1Arr[dx] = x1;
    fxArr[dx] = sx - x0;
  }

  for (let dy = 0; dy < newHeight; dy++) {
    const sy = Math.min(height - 1, Math.max(0, ((dy + 0.5) * height) / newHeight - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;

    const row0 = y0 * width;
    const row1 = y1 * width;
    const dstRow = dy * newWidth;

    for (let dx = 0; dx < newWidth; dx++) {
      const x0 = x0Arr[dx]!;
      const x1 = x1Arr[dx]!;
      const fx = fxArr[dx]!;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const p00 = (row0 + x0) * 4;
      const p10 = (row0 + x1) * 4;
      const p01 = (row1 + x0) * 4;
      const p11 = (row1 + x1) * 4;
      const dst = (dstRow + dx) * 4;

      out[dst] = Math.round(
        rgba[p00]! * w00 + rgba[p10]! * w10 + rgba[p01]! * w01 + rgba[p11]! * w11,
      );
      out[dst + 1] = Math.round(
        rgba[p00 + 1]! * w00 +
          rgba[p10 + 1]! * w10 +
          rgba[p01 + 1]! * w01 +
          rgba[p11 + 1]! * w11,
      );
      out[dst + 2] = Math.round(
        rgba[p00 + 2]! * w00 +
          rgba[p10 + 2]! * w10 +
          rgba[p01 + 2]! * w01 +
          rgba[p11 + 2]! * w11,
      );
      out[dst + 3] = Math.round(
        rgba[p00 + 3]! * w00 +
          rgba[p10 + 3]! * w10 +
          rgba[p01 + 3]! * w01 +
          rgba[p11 + 3]! * w11,
      );
    }
  }

  return {
    data: out,
    width: newWidth,
    height: newHeight,
    originalWidth: width,
    originalHeight: height,
    effectiveScaleFactor: newWidth / width,
    scaleModeApplied,
  };
}

const REC_THUMB_BUF = new Uint8Array(256 * 256);
const REC_LUM_HIST = new Int32Array(256);
const REC_SOBEL_HIST = new Int32Array(32);
const REC_MIN8 = new Uint8Array(32 * 32);
const REC_MAX8 = new Uint8Array(32 * 32);
const REC_C8 = new Float32Array(32 * 32);
const REC_MIN16 = new Uint8Array(16 * 16);
const REC_MAX16 = new Uint8Array(16 * 16);
const REC_C16 = new Float32Array(16 * 16);
const REC_C32 = new Float32Array(8 * 8);

/**
 * Fast (< 5 ms) Complexity Router on a <= 256x256 thumbnail.
 * Computes Sobel gradient entropy, multi-scale local contrast variance,
 * shadow/glare dynamic range, and probes WebGPU + deviceMemory.
 */
export function recommendModel(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  capabilities?: HardwareCapabilities,
): ModelRecommendation {
  validateImageDimensions(rgba, width, height);
  const t0 = performance.now();

  const tw = Math.min(width, 256);
  const th = Math.min(height, 256);
  const nThumb = tw * th;
  const thumb = REC_THUMB_BUF;
  const lumHist = REC_LUM_HIST;
  lumHist.fill(0);

  let clippedCount = 0;
  if (tw === width && th === height) {
    for (let i = 0, p = 0; i < nThumb; i++, p += 4) {
      const yInt = (77 * rgba[p]! + 150 * rgba[p + 1]! + 29 * rgba[p + 2]!) >> 8;
      thumb[i] = yInt;
      lumHist[yInt]! += 1;
      if (yInt <= 5 || yInt >= 250) {
        clippedCount++;
      }
    }
  } else {
    const sxBytes = new Int32Array(tw);
    for (let x = 0; x < tw; x++) {
      sxBytes[x] = Math.floor((x * width) / tw) * 4;
    }
    for (let y = 0; y < th; y++) {
      const srcRowBytes = Math.floor((y * height) / th) * width * 4;
      const dstRow = y * tw;
      for (let x = 0; x < tw; x++) {
        const p = srcRowBytes + sxBytes[x]!;
        const yInt = (77 * rgba[p]! + 150 * rgba[p + 1]! + 29 * rgba[p + 2]!) >> 8;
        thumb[dstRow + x] = yInt;
        lumHist[yInt]! += 1;
        if (yInt <= 5 || yInt >= 250) {
          clippedCount++;
        }
      }
    }
  }

  // (a) Sobel gradient L1 magnitude Shannon entropy (32 bins over [0, 2040], mag >> 6 in 0..31)
  const sobelBins = 32;
  const sobelHist = REC_SOBEL_HIST;
  sobelHist.fill(0);
  let sobelCount = 0;
  if (tw >= 3 && th >= 3) {
    for (let y = 1; y < th - 1; y++) {
      const r0 = (y - 1) * tw;
      const r1 = y * tw;
      const r2 = (y + 1) * tw;
      let tl = thumb[r0]!;
      let tc = thumb[r0 + 1]!;
      let ml = thumb[r1]!;
      let mc = thumb[r1 + 1]!;
      let bl = thumb[r2]!;
      let bc = thumb[r2 + 1]!;
      for (let x = 1; x < tw - 1; x++) {
        const tr = thumb[r0 + x + 1]!;
        const mr = thumb[r1 + x + 1]!;
        const br = thumb[r2 + x + 1]!;

        const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
        const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
        const mag = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
        sobelHist[mag >> 6]! += 1;
        sobelCount++;

        tl = tc;
        tc = tr;
        ml = mc;
        mc = mr;
        bl = bc;
        bc = br;
      }
    }
  }

  let sobelEntropy = 0;
  if (sobelCount > 0) {
    for (let b = 0; b < sobelBins; b++) {
      const c = sobelHist[b]!;
      if (c > 0) {
        const p = c / sobelCount;
        sobelEntropy -= p * Math.log2(p);
      }
    }
  }

  // (b) Multi-scale local contrast variance across block scales 8, 16, 32
  // Compute 8x8 block min/max sequentially in row-major order, then aggregate hierarchically
  let scaleVarSum = 0;
  let activeScales = 0;
  const bx8 = tw >> 3;
  const by8 = th >> 3;
  const n8 = bx8 * by8;
  const inv255 = 1 / 255;

  if (n8 >= 2) {
    const min8 = REC_MIN8;
    const max8 = REC_MAX8;
    const c8 = REC_C8;
    min8.fill(255, 0, n8);
    max8.fill(0, 0, n8);

    const h8 = by8 << 3;
    for (let y = 0; y < h8; y++) {
      const row = y * tw;
      const byOff = (y >> 3) * bx8;
      for (let bx = 0; bx < bx8; bx++) {
        const p = row + (bx << 3);
        const v0 = thumb[p]!;
        const v1 = thumb[p + 1]!;
        const v2 = thumb[p + 2]!;
        const v3 = thumb[p + 3]!;
        const v4 = thumb[p + 4]!;
        const v5 = thumb[p + 5]!;
        const v6 = thumb[p + 6]!;
        const v7 = thumb[p + 7]!;

        const mn01 = v0 < v1 ? v0 : v1;
        const mn23 = v2 < v3 ? v2 : v3;
        const mn45 = v4 < v5 ? v4 : v5;
        const mn67 = v6 < v7 ? v6 : v7;
        const mn03 = mn01 < mn23 ? mn01 : mn23;
        const mn47 = mn45 < mn67 ? mn45 : mn67;
        const rowMin = mn03 < mn47 ? mn03 : mn47;

        const mx01 = v0 > v1 ? v0 : v1;
        const mx23 = v2 > v3 ? v2 : v3;
        const mx45 = v4 > v5 ? v4 : v5;
        const mx67 = v6 > v7 ? v6 : v7;
        const mx03 = mx01 > mx23 ? mx01 : mx23;
        const mx47 = mx45 > mx67 ? mx45 : mx67;
        const rowMax = mx03 > mx47 ? mx03 : mx47;

        const idx = byOff + bx;
        if (rowMin < min8[idx]!) min8[idx] = rowMin;
        if (rowMax > max8[idx]!) max8[idx] = rowMax;
      }
    }

    let meanC8 = 0;
    for (let i = 0; i < n8; i++) {
      const c = (max8[i]! - min8[i]!) * inv255;
      c8[i] = c;
      meanC8 += c;
    }
    meanC8 /= n8;
    let varC8 = 0;
    for (let i = 0; i < n8; i++) {
      const d = c8[i]! - meanC8;
      varC8 += d * d;
    }
    scaleVarSum += varC8 / n8;
    activeScales++;

    // 16x16 blocks from 2x2 of 8x8 blocks
    const bx16 = bx8 >> 1;
    const by16 = by8 >> 1;
    const n16 = bx16 * by16;
    if (n16 >= 2) {
      const min16 = REC_MIN16;
      const max16 = REC_MAX16;
      const c16 = REC_C16;
      let meanC16 = 0;
      for (let by = 0; by < by16; by++) {
        const r0 = (by << 1) * bx8;
        const r1 = ((by << 1) + 1) * bx8;
        for (let bx = 0; bx < bx16; bx++) {
          const c0 = bx << 1;
          const c1 = c0 + 1;
          const a0 = min8[r0 + c0]!;
          const a1 = min8[r0 + c1]!;
          const a2 = min8[r1 + c0]!;
          const a3 = min8[r1 + c1]!;
          const m0 = a0 < a1 ? a0 : a1;
          const m1 = a2 < a3 ? a2 : a3;
          const minV = m0 < m1 ? m0 : m1;

          const b0 = max8[r0 + c0]!;
          const b1 = max8[r0 + c1]!;
          const b2 = max8[r1 + c0]!;
          const b3 = max8[r1 + c1]!;
          const x0 = b0 > b1 ? b0 : b1;
          const x1 = b2 > b3 ? b2 : b3;
          const maxV = x0 > x1 ? x0 : x1;

          const idx = by * bx16 + bx;
          min16[idx] = minV;
          max16[idx] = maxV;
          const c = (maxV - minV) * inv255;
          c16[idx] = c;
          meanC16 += c;
        }
      }
      meanC16 /= n16;
      let varC16 = 0;
      for (let i = 0; i < n16; i++) {
        const d = c16[i]! - meanC16;
        varC16 += d * d;
      }
      scaleVarSum += varC16 / n16;
      activeScales++;

      // 32x32 blocks from 2x2 of 16x16 blocks
      const bx32 = bx16 >> 1;
      const by32 = by16 >> 1;
      const n32 = bx32 * by32;
      if (n32 >= 2) {
        const c32 = REC_C32;
        let meanC32 = 0;
        for (let by = 0; by < by32; by++) {
          const r0 = (by << 1) * bx16;
          const r1 = ((by << 1) + 1) * bx16;
          for (let bx = 0; bx < bx32; bx++) {
            const c0 = bx << 1;
            const c1 = c0 + 1;
            const a0 = min16[r0 + c0]!;
            const a1 = min16[r0 + c1]!;
            const a2 = min16[r1 + c0]!;
            const a3 = min16[r1 + c1]!;
            const m0 = a0 < a1 ? a0 : a1;
            const m1 = a2 < a3 ? a2 : a3;
            const minV = m0 < m1 ? m0 : m1;

            const b0 = max16[r0 + c0]!;
            const b1 = max16[r0 + c1]!;
            const b2 = max16[r1 + c0]!;
            const b3 = max16[r1 + c1]!;
            const x0 = b0 > b1 ? b0 : b1;
            const x1 = b2 > b3 ? b2 : b3;
            const maxV = x0 > x1 ? x0 : x1;

            const c = (maxV - minV) * inv255;
            c32[by * bx32 + bx] = c;
            meanC32 += c;
          }
        }
        meanC32 /= n32;
        let varC32 = 0;
        for (let i = 0; i < n32; i++) {
          const d = c32[i]! - meanC32;
          varC32 += d * d;
        }
        scaleVarSum += varC32 / n32;
        activeScales++;
      }
    }
  }
  const multiScaleContrastVar = activeScales > 0 ? scaleVarSum / activeScales : 0;

  // (c) Shadow/glare dynamic range
  const [p1, p99] = percentile1And99FromHist256(lumHist, nThumb);
  const dynamicRange = (p99 - p1) / 255;
  const clippedFrac = clippedCount / nThumb;
  const shadowGlareRange = Math.min(1, Math.max(0, dynamicRange + 0.25 * clippedFrac));

  // Hardware probe
  const nav = globalThis.navigator as
    | { gpu?: unknown; deviceMemory?: number }
    | undefined;
  const hasWebGPU = capabilities?.hasWebGPU ?? Boolean(nav?.gpu);
  const hasShaderF16 = capabilities?.hasShaderF16;
  const deviceMemoryGB =
    capabilities?.deviceMemoryGB !== undefined
      ? capabilities.deviceMemoryGB
      : (nav?.deviceMemory ?? null);

  // Complexity score in [0, 1]
  const normEntropy = Math.min(1, sobelEntropy / 3.5);
  const normContrastVar = Math.min(1, multiScaleContrastVar / 0.04);
  const complexityScore =
    0.45 * normEntropy + 0.35 * normContrastVar + 0.2 * shadowGlareRange;

  const lowMemory = deviceMemoryGB !== null && deviceMemoryGB < 4;
  const missingF16 = hasWebGPU && hasShaderF16 === false;
  let model: ModelKind;
  let confidence: number;
  let rationale: string;

  if (!hasWebGPU || missingF16 || lowMemory) {
    model = 'unet';
    const hwReason = !hasWebGPU
      ? 'No WebGPU detected'
      : missingF16
        ? 'WebGPU adapter lacks shader-f16 support for FP16 CP-SAM'
        : `Low device memory (${deviceMemoryGB} GB)`;
    confidence = Math.min(1, Math.max(0.65, 0.9 - 0.2 * complexityScore));
    rationale = `${hwReason} -> U-Net 25 MB recommended for fast local execution.`;
  } else if (complexityScore >= 0.45) {
    model = 'cpsam';
    confidence = Math.min(1, Math.max(0.55, 0.5 + 0.5 * complexityScore));
    rationale =
      'High clast heterogeneity / lighting range + WebGPU detected -> Cellpose-SAM FP16 recommended.';
  } else {
    model = 'unet';
    confidence = Math.min(1, Math.max(0.55, 0.95 - 0.5 * complexityScore));
    rationale =
      'Uniform fine gravel texture detected -> Lightweight U-Net 25 MB recommended.';
  }

  const elapsedMs = performance.now() - t0;

  return {
    model,
    confidence,
    rationale,
    metrics: {
      sobelEntropy,
      multiScaleContrastVar,
      shadowGlareRange,
      hasWebGPU,
      ...(hasShaderF16 !== undefined ? { hasShaderF16 } : {}),
      deviceMemoryGB,
      elapsedMs,
    },
  };
}

/**
 * Exact parity with `infer_unet.py`:
 * `gray = round(0.299*R + 0.587*G + 0.114*B)` (`uint8`),
 * `(gray - p1) / (p99 - p1 + 1e-8)` with `np.percentile(..., [1, 99], method='linear')`.
 */
export function normalizeGray(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  validateImageDimensions(rgba, width, height);
  const n = width * height;
  const gray = new Uint8Array(n);
  const hist = new Int32Array(256);

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const gVal = Math.round(
      0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!,
    );
    const clamped = gVal < 0 ? 0 : gVal > 255 ? 255 : gVal;
    gray[i] = clamped;
    hist[clamped]! += 1;
  }

  const [p1, p99] = percentile1And99FromHist256(hist, n);
  const denom = p99 - p1 + 1e-8;
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    out[i] = (gray[i]! - p1) / denom;
  }

  return out;
}

/**
 * Exact parity with `infer_cpsam.py`:
 * Joint 1st–99th percentile across all `H * W * 3` RGB values (ignoring alpha),
 * returning HWC `Float32Array` of `(val - p1) / (p99 - p1 + 1e-8)`.
 */
export function normalizeRgbJoint99(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  validateImageDimensions(rgba, width, height);
  const n = width * height;
  const hist = new Int32Array(256);

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    hist[rgba[p]!]! += 1;
    hist[rgba[p + 1]!]! += 1;
    hist[rgba[p + 2]!]! += 1;
  }

  const [p1, p99] = percentile1And99FromHist256(hist, n * 3);
  const denom = p99 - p1 + 1e-8;
  const out = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    const src = i * 4;
    const dst = i * 3;
    out[dst] = (rgba[src]! - p1) / denom;
    out[dst + 1] = (rgba[src + 1]! - p1) / denom;
    out[dst + 2] = (rgba[src + 2]! - p1) / denom;
  }

  return out;
}
