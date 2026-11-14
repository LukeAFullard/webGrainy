import * as ort from 'onnxruntime-web';
import type {
  CpsamInferenceOptions,
  ExecutionProvider,
  InferenceOutput,
} from '../types/index.js';

export interface SessionCreateOptions {
  wasmPaths?: string;
  simd?: boolean;
  numThreads?: number;
}

export interface InferenceSessionResult {
  session: ort.InferenceSession;
  executionProvider: ExecutionProvider;
}

const f32Buf = new ArrayBuffer(4);
const f32View = new Float32Array(f32Buf);
const u32View = new Uint32Array(f32Buf);

/**
 * Converts an IEEE-754 float32 number to IEEE-754 binary16 (uint16 bits)
 * using round-to-nearest-even. Handles +-0, +-Infinity, NaN, subnormals,
 * overflow, and underflow.
 */
export function float32ToFloat16(value: number): number {
  f32View[0] = value;
  const bits = u32View[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exp = (bits >>> 23) & 0xff;
  const mant = bits & 0x7fffff;

  // Infinity or NaN
  if (exp === 0xff) {
    if (mant === 0) {
      return sign | 0x7c00;
    }
    const payload = mant >>> 13;
    return sign | 0x7e00 | payload;
  }

  // Zero or float32 subnormal -> underflows to signed zero in float16
  if (exp === 0) {
    return sign;
  }

  const e = exp - 127;

  // Overflow to +-Infinity
  if (e > 15) {
    return sign | 0x7c00;
  }

  // Normal float16 range: e in [-14, 15]
  if (e >= -14) {
    let hExp = e + 15;
    let hMant = mant >>> 13;
    const rem = mant & 0x1fff;
    // Round-to-nearest-even
    if (rem > 0x1000 || (rem === 0x1000 && (hMant & 1) === 1)) {
      hMant++;
      if (hMant === 0x400) {
        hMant = 0;
        hExp++;
        if (hExp >= 31) {
          return sign | 0x7c00;
        }
      }
    }
    return sign | (hExp << 10) | hMant;
  }

  // Subnormal float16 range: e in [-25, -15]
  if (e >= -25) {
    const fullMant = 0x800000 | mant;
    const shift = -1 - e; // 14..24
    let hMant = fullMant >>> shift;
    const half = 1 << (shift - 1);
    const mask = (1 << shift) - 1;
    const rem = fullMant & mask;
    if (rem > half || (rem === half && (hMant & 1) === 1)) {
      hMant++;
    }
    return sign | hMant;
  }

  // Underflow to +-0
  return sign;
}

/**
 * Converts an IEEE-754 binary16 (uint16 bits) value to a JavaScript number (float32 precision).
 */
export function float16ToFloat32(bits: number): number {
  const u16 = bits & 0xffff;
  const sign = (u16 & 0x8000) << 16;
  const exp = (u16 >>> 10) & 0x1f;
  const mant = u16 & 0x3ff;

  let f32Bits: number;
  if (exp === 0) {
    if (mant === 0) {
      f32Bits = sign;
    } else {
      let m = mant;
      let e = 127 - 14;
      while ((m & 0x400) === 0) {
        m <<= 1;
        e--;
      }
      m &= 0x3ff;
      f32Bits = sign | (e << 23) | (m << 13);
    }
  } else if (exp === 0x1f) {
    f32Bits = sign | 0x7f800000 | (mant << 13);
  } else {
    f32Bits = sign | ((exp + 112) << 23) | (mant << 13);
  }

  u32View[0] = f32Bits >>> 0;
  return f32View[0]!;
}

/**
 * Converts a Float32Array to packed IEEE-754 binary16 bits (Uint16Array).
 */
export function float32ArrayToFloat16Bits(src: Float32Array): Uint16Array {
  const dst = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    dst[i] = float32ToFloat16(src[i]!);
  }
  return dst;
}

/**
 * Converts packed IEEE-754 binary16 bits (Uint16Array) to a Float32Array.
 */
export function float16BitsToFloat32Array(src: Uint16Array): Float32Array {
  const dst = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    dst[i] = float16ToFloat32(src[i]!);
  }
  return dst;
}

/**
 * Exact `np.pad(..., mode='reflect')` periodic triangle-wave index mapping.
 */
export function reflectIndex(index: number, length: number): number {
  if (length <= 1) {
    return 0;
  }
  const period = 2 * (length - 1);
  const mod = ((index % period) + period) % period;
  return mod < length ? mod : period - mod;
}

/**
 * Computes 1D tile start positions covering `[0, length)` with `tileSize` and `stride`.
 */
export function tileStarts(length: number, tileSize: number, stride: number): number[] {
  if (length <= tileSize) {
    return [0];
  }
  const starts: number[] = [];
  for (let pos = 0; pos + tileSize < length; pos += stride) {
    starts.push(pos);
  }
  const last = length - tileSize;
  if (starts.length === 0 || starts[starts.length - 1] !== last) {
    starts.push(last);
  }
  return starts;
}

/**
 * Computes a 2D raised-cosine Hanning taper window:
 * `np.clip(np.hanning(tileSize), 1e-3, 1.0)` outer product.
 */
export function makeBlendWindow(tileSize = 256): Float32Array {
  if (!Number.isInteger(tileSize) || tileSize <= 0) {
    throw new RangeError(`tileSize must be a positive integer, got ${tileSize}`);
  }
  const w1d = new Float32Array(tileSize);
  if (tileSize === 1) {
    w1d[0] = 1.0;
  } else {
    const denom = tileSize - 1;
    for (let i = 0; i < tileSize; i++) {
      const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
      w1d[i] = h < 1e-3 ? 1e-3 : h > 1.0 ? 1.0 : h;
    }
  }

  const out = new Float32Array(tileSize * tileSize);
  for (let y = 0; y < tileSize; y++) {
    const wy = w1d[y]!;
    const rowOff = y * tileSize;
    for (let x = 0; x < tileSize; x++) {
      out[rowOff + x] = wy * w1d[x]!;
    }
  }
  return out;
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error(
    typeof reason === 'string' && reason.length > 0
      ? reason
      : 'The operation was aborted.',
  );
  err.name = 'AbortError';
  return err;
}

function decodeOutputTensorData(data: unknown): Float32Array {
  if (data instanceof Float32Array) {
    return data;
  }
  if (data instanceof Uint16Array) {
    return float16BitsToFloat32Array(data);
  }
  if (data && typeof (data as ArrayLike<number>).length === 'number') {
    const arr = data as ArrayLike<number>;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      out[i] = arr[i]!;
    }
    return out;
  }
  throw new TypeError('Unsupported ONNX output tensor data buffer type.');
}

/**
 * Creates an `onnxruntime-web` InferenceSession using local `./ort/` WASM assets
 * (zero external CDNs). Tries `['webgpu', 'wasm']` and gracefully falls back to `['wasm']`.
 */
export async function createInferenceSession(
  modelBytes: ArrayBuffer | Uint8Array,
  options?: SessionCreateOptions,
): Promise<InferenceSessionResult> {
  ort.env.wasm.wasmPaths = options?.wasmPaths ?? './ort/';
  ort.env.wasm.simd = options?.simd ?? true;
  if (options?.numThreads !== undefined) {
    ort.env.wasm.numThreads = options.numThreads;
  }

  const bytes =
    modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes);

  try {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['webgpu', 'wasm'],
    });
    const hasGpu = Boolean(
      (globalThis.navigator as { gpu?: unknown } | undefined)?.gpu,
    );
    return {
      session,
      executionProvider: hasGpu ? 'webgpu' : 'wasm',
    };
  } catch {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
    });
    return {
      session,
      executionProvider: 'wasm',
    };
  }
}

/**
 * Runs U-Net FP32 inference (`ig2_unet_fp32.onnx`):
 * Pads `normalizedGray` to multiples of 16 via reflection padding,
 * builds `[1, 2, H_pad, W_pad]` float32 tensor (ch0 = gray, ch1 = zeros),
 * runs `"image"` -> `"flows_cellprob"`, and crops to `[3, height, width]`.
 */
export async function runUnetInference(
  session: ort.InferenceSession,
  normalizedGray: Float32Array,
  width: number,
  height: number,
): Promise<InferenceOutput> {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError(`Invalid image dimensions: ${width}x${height}`);
  }
  if (normalizedGray.length !== width * height) {
    throw new RangeError(
      `normalizedGray length (${normalizedGray.length}) does not match ${width}x${height}.`,
    );
  }

  const padH = (16 - (height % 16)) % 16;
  const padW = (16 - (width % 16)) % 16;
  const hPad = height + padH;
  const wPad = width + padW;

  const inputData = new Float32Array(2 * hPad * wPad);
  // Channel 0: reflection-padded normalizedGray; Channel 1 remains zeros.
  for (let y = 0; y < hPad; y++) {
    const sy = reflectIndex(y, height);
    const dstRow = y * wPad;
    const srcRow = sy * width;
    for (let x = 0; x < wPad; x++) {
      const sx = reflectIndex(x, width);
      inputData[dstRow + x] = normalizedGray[srcRow + sx]!;
    }
  }

  const inputTensor = new ort.Tensor('float32', inputData, [1, 2, hPad, wPad]);
  const outputs = await session.run({ image: inputTensor });
  const outTensor = outputs['flows_cellprob'];
  if (!outTensor) {
    throw new Error('U-Net model output "flows_cellprob" is missing.');
  }

  const outData = decodeOutputTensorData(outTensor.data);
  const planePadSize = hPad * wPad;
  const planeOutSize = width * height;

  const flowY = new Float32Array(planeOutSize);
  const flowX = new Float32Array(planeOutSize);
  const cellprob = new Float32Array(planeOutSize);

  for (let y = 0; y < height; y++) {
    const srcRow = y * wPad;
    const dstRow = y * width;
    flowY.set(outData.subarray(srcRow, srcRow + width), dstRow);
    flowX.set(
      outData.subarray(planePadSize + srcRow, planePadSize + srcRow + width),
      dstRow,
    );
    cellprob.set(
      outData.subarray(
        2 * planePadSize + srcRow,
        2 * planePadSize + srcRow + width,
      ),
      dstRow,
    );
  }

  return { flowY, flowX, cellprob, width, height };
}

/**
 * Runs Cellpose-SAM FP16 tiled inference (`ig2_cpsam_fp16.onnx`):
 * - `256x256` exact fast path (no Hanning taper / tiling).
 * - Reflection-pads only if `height < tileSize || width < tileSize`.
 * - Tiles with `tileSize = 256`, `overlap = 64` (`stride = 192`), `batchSize = 16`.
 * - Accumulates with `makeBlendWindow(tileSize)`, supports `AbortSignal` & `onProgress`.
 */
export async function runCpsamTiledInference(
  session: ort.InferenceSession,
  normalizedRgb: Float32Array,
  width: number,
  height: number,
  options?: CpsamInferenceOptions,
): Promise<InferenceOutput> {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError(`Invalid image dimensions: ${width}x${height}`);
  }
  if (normalizedRgb.length !== width * height * 3) {
    throw new RangeError(
      `normalizedRgb length (${normalizedRgb.length}) does not match ${width}x${height}x3.`,
    );
  }

  const signal = options?.signal;
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }

  const tileSize = options?.tileSize ?? 256;
  const overlap = options?.overlap ?? 64;
  const stride = tileSize - overlap;
  if (stride <= 0) {
    throw new RangeError(
      `Invalid tileSize (${tileSize}) and overlap (${overlap}): stride must be positive.`,
    );
  }
  const batchSize = 16;
  const tilePixels = tileSize * tileSize;

  // Fast path: exact tileSize x tileSize image
  if (width === tileSize && height === tileSize) {
    const nchw = new Float32Array(3 * tilePixels);
    for (let i = 0; i < tilePixels; i++) {
      const src = i * 3;
      nchw[i] = normalizedRgb[src]!;
      nchw[tilePixels + i] = normalizedRgb[src + 1]!;
      nchw[2 * tilePixels + i] = normalizedRgb[src + 2]!;
    }
    const u16 = float32ArrayToFloat16Bits(nchw);
    const inputTensor = new ort.Tensor('float16', u16, [1, 3, tileSize, tileSize]);
    const outputs = await session.run({ image: inputTensor });
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }
    const outTensor = outputs['flows_cellprob'];
    if (!outTensor) {
      throw new Error('CP-SAM model output "flows_cellprob" is missing.');
    }
    const outData = decodeOutputTensorData(outTensor.data);
    const flowY = new Float32Array(outData.subarray(0, tilePixels));
    const flowX = new Float32Array(outData.subarray(tilePixels, 2 * tilePixels));
    const cellprob = new Float32Array(
      outData.subarray(2 * tilePixels, 3 * tilePixels),
    );

    options?.onProgress?.({ completedTiles: 1, totalTiles: 1, percent: 100 });
    return { flowY, flowX, cellprob, width, height };
  }

  // Tiled path: reflection-pad only if height < tileSize || width < tileSize
  const workH = Math.max(height, tileSize);
  const workW = Math.max(width, tileSize);
  const ys = tileStarts(workH, tileSize, stride);
  const xs = tileStarts(workW, tileSize, stride);

  const tiles: Array<{ y0: number; x0: number }> = [];
  for (const y0 of ys) {
    for (const x0 of xs) {
      tiles.push({ y0, x0 });
    }
  }
  const totalTiles = tiles.length;

  const workPixels = workW * workH;
  const accY = new Float32Array(workPixels);
  const accX = new Float32Array(workPixels);
  const accP = new Float32Array(workPixels);
  const weights = new Float32Array(workPixels);
  const blendWin = makeBlendWindow(tileSize);

  let completedTiles = 0;

  for (let start = 0; start < totalTiles; start += batchSize) {
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }

    const end = Math.min(totalTiles, start + batchSize);
    const b = end - start;
    const batchNchw = new Float32Array(b * 3 * tilePixels);

    for (let t = 0; t < b; t++) {
      const tile = tiles[start + t]!;
      const tileBase = t * 3 * tilePixels;
      const ch0 = tileBase;
      const ch1 = tileBase + tilePixels;
      const ch2 = tileBase + 2 * tilePixels;

      for (let ty = 0; ty < tileSize; ty++) {
        const sy = reflectIndex(tile.y0 + ty, height);
        const dstRow = ty * tileSize;
        const srcRow = sy * width;
        for (let tx = 0; tx < tileSize; tx++) {
          const sx = reflectIndex(tile.x0 + tx, width);
          const srcIdx = (srcRow + sx) * 3;
          const dstIdx = dstRow + tx;
          batchNchw[ch0 + dstIdx] = normalizedRgb[srcIdx]!;
          batchNchw[ch1 + dstIdx] = normalizedRgb[srcIdx + 1]!;
          batchNchw[ch2 + dstIdx] = normalizedRgb[srcIdx + 2]!;
        }
      }
    }

    const batchU16 = float32ArrayToFloat16Bits(batchNchw);
    const inputTensor = new ort.Tensor('float16', batchU16, [
      b,
      3,
      tileSize,
      tileSize,
    ]);
    const outputs = await session.run({ image: inputTensor });
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }
    const outTensor = outputs['flows_cellprob'];
    if (!outTensor) {
      throw new Error('CP-SAM model output "flows_cellprob" is missing.');
    }
    const outData = decodeOutputTensorData(outTensor.data);

    for (let t = 0; t < b; t++) {
      const tile = tiles[start + t]!;
      const tileBase = t * 3 * tilePixels;
      const ch0 = tileBase;
      const ch1 = tileBase + tilePixels;
      const ch2 = tileBase + 2 * tilePixels;

      for (let ty = 0; ty < tileSize; ty++) {
        const wy = tile.y0 + ty;
        const winRow = ty * tileSize;
        const accRow = wy * workW + tile.x0;
        for (let tx = 0; tx < tileSize; tx++) {
          const w = blendWin[winRow + tx]!;
          const localIdx = winRow + tx;
          const accIdx = accRow + tx;
          accY[accIdx]! += outData[ch0 + localIdx]! * w;
          accX[accIdx]! += outData[ch1 + localIdx]! * w;
          accP[accIdx]! += outData[ch2 + localIdx]! * w;
          weights[accIdx]! += w;
        }
      }
    }

    completedTiles += b;
    options?.onProgress?.({
      completedTiles,
      totalTiles,
      percent: Math.round((completedTiles / totalTiles) * 100),
    });
  }

  const outPixels = width * height;
  const flowY = new Float32Array(outPixels);
  const flowX = new Float32Array(outPixels);
  const cellprob = new Float32Array(outPixels);

  for (let y = 0; y < height; y++) {
    const srcRow = y * workW;
    const dstRow = y * width;
    for (let x = 0; x < width; x++) {
      const srcIdx = srcRow + x;
      const dstIdx = dstRow + x;
      const w = Math.max(weights[srcIdx]!, 1e-6);
      flowY[dstIdx] = accY[srcIdx]! / w;
      flowX[dstIdx] = accX[srcIdx]! / w;
      cellprob[dstIdx] = accP[srcIdx]! / w;
    }
  }

  return { flowY, flowX, cellprob, width, height };
}
