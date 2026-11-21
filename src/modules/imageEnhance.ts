/**
 * Optional, memory-isolated image enhancement (2x AI upscaling via PULSE,
 * deterministic Total-Variation-regularized Richardson–Lucy deconvolution for deblurring).
 *
 * Scientific & memory guarantees:
 * - PULSE 2x is L1/Charbonnier-trained (no GAN hallucination), MIT-licensed, and fetched
 *   from a pinned Hugging Face commit under `inYourOwnBrowser/PULSE` with
 *   `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, and WebCrypto SHA-256 +
 *   byte-size verification, cached in IndexedDB alongside segmentation models.
 * - Tiled 256x256 inference with 32 px overlap feathering keeps peak RAM/VRAM bounded.
 * - Deblur runs built-in luminance Richardson–Lucy deconvolution with Total-Variation
 *   regularization (Dey et al., 2006): 0 MB download, strictly bounded in [0, 1],
 *   hue-preserving, and numerically stable on high-frequency gravel/sand textures.
 * - Callers release segmentation sessions first (`engine.releaseSessions()`), and
 *   `enhanceImageBuffer()` always calls `session.release()` in `finally` so ONNX
 *   enhancers and ImageGrains are never loaded simultaneously.
 */
import * as ort from 'onnxruntime-web';
import type { CalibrationResult } from '../types/index.js';
import { createAbortError } from './abort.js';
import { DB_NAME, DB_VERSION, STORE_NAME, sha256Hex } from './modelCache.js';
import { createInferenceSession, type SessionCreateOptions } from './onnxInference.js';
import type { RoiExclusionConfig } from './roiAndRectify.js';

export type EnhanceKind = 'upscale-2x' | 'deblur';

export interface EnhanceModelSpec {
  kind: EnhanceKind;
  /** Execution backend: ONNX neural model or built-in deterministic classical filter. */
  engine: 'onnx' | 'classical';
  modelId: string;
  modelName: string;
  shortLabel: string;
  repoId: string;
  revision: string;
  filePath: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  scaleFactor: 1 | 2;
  license: string;
  /** Default square tile size (px, multiple of 16) for ONNX models. */
  defaultTileSize: number;
  /** Minimum spatial input dimension (px) required by the ONNX graph. */
  minTileSide: number;
  /** Optional override to start on WASM instead of WebGPU. */
  preferWasm?: boolean;
}

/** Maximum output side length (px) allowed for 2x upscaling to prevent browser canvas OOM. */
export const MAX_UPSCALE_OUTPUT_SIDE = 4096;

export const ENHANCE_MODELS: Record<EnhanceKind, EnhanceModelSpec> = {
  'upscale-2x': {
    kind: 'upscale-2x',
    engine: 'onnx',
    modelId: 'pulse_2x_fp32',
    modelName: 'PULSE 2× (MIT, Charbonnier L1)',
    shortLabel: '2× upscale',
    repoId: 'inYourOwnBrowser/PULSE',
    revision: '468ba5ead1abcfa8a5e07414e249b8bee6729043',
    filePath: 'onnx/2x_pulse.onnx',
    url: 'https://huggingface.co/inYourOwnBrowser/PULSE/resolve/468ba5ead1abcfa8a5e07414e249b8bee6729043/onnx/2x_pulse.onnx',
    sha256: 'baeeb9f310aa4dfad5f3a5f7961254270ba09256d6fb49fbcb4b2b5e63c34251',
    sizeBytes: 1361094,
    scaleFactor: 2,
    license: 'MIT',
    defaultTileSize: 256,
    minTileSide: 16,
  },
  deblur: {
    kind: 'deblur',
    engine: 'classical',
    modelId: 'richardson_lucy_tv_deblur',
    modelName: 'Richardson–Lucy TV Deblur (built-in)',
    shortLabel: 'deblur',
    repoId: 'local/richardson-lucy-tv',
    revision: 'builtin',
    filePath: 'builtin',
    url: '',
    sha256: '',
    sizeBytes: 0,
    scaleFactor: 1,
    license: 'MIT',
    defaultTileSize: 256,
    minTileSide: 16,
  },
};

export interface EnhanceProgressEvent {
  phase: 'download' | 'session' | 'tile';
  message: string;
  fraction: number;
}

export interface EnhanceSessionLike {
  inputNames?: readonly string[];
  outputNames?: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: unknown; dims?: readonly number[] }>>;
  release?: () => Promise<void>;
}

export interface EnhanceResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  spec: EnhanceModelSpec;
}

interface CachedEnhanceRecord {
  modelId: string;
  data: ArrayBuffer;
  sizeBytes: number;
  cachedAt: number;
  url: string;
  sha256?: string;
}

function openEnhanceCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'modelId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readCachedEnhanceModel(modelId: string): Promise<ArrayBuffer | null> {
  const db = await openEnhanceCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(modelId);
      req.onsuccess = () => {
        const rec = req.result as CachedEnhanceRecord | undefined;
        resolve(rec?.data instanceof ArrayBuffer ? rec.data : null);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function writeCachedEnhanceModel(rec: CachedEnhanceRecord): Promise<void> {
  const db = await openEnhanceCacheDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(rec);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function verifyEnhanceBytes(spec: EnhanceModelSpec, buf: ArrayBuffer): Promise<void> {
  if (buf.byteLength !== spec.sizeBytes) {
    throw new Error(
      `Integrity check failed for ${spec.modelId}: expected ${spec.sizeBytes} bytes, got ${buf.byteLength}.`,
    );
  }
  const actual = await sha256Hex(buf);
  if (actual !== spec.sha256) {
    throw new Error(
      `Integrity check failed for ${spec.modelId}: SHA-256 ${actual} does not match pinned ${spec.sha256}.`,
    );
  }
}

/**
 * Loads an enhancement model from IndexedDB cache or downloads it from the pinned
 * Hugging Face commit with SHA-256 verification.
 */
export async function getEnhanceModelBytes(
  kind: EnhanceKind,
  onProgress?: (ev: EnhanceProgressEvent) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const spec = ENHANCE_MODELS[kind];
  if (signal?.aborted) throw createAbortError();

  const cached = await readCachedEnhanceModel(spec.modelId);
  if (cached) {
    try {
      await verifyEnhanceBytes(spec, cached);
      onProgress?.({ phase: 'download', message: `Loaded ${spec.shortLabel} model from cache`, fraction: 1 });
      return cached;
    } catch {
      // Cache corrupt or outdated — re-download.
    }
  }

  const sizeMb = (spec.sizeBytes / (1024 * 1024)).toFixed(1);
  onProgress?.({ phase: 'download', message: `Downloading ${spec.shortLabel} model (${sizeMb} MB)…`, fraction: 0 });

  const resp = await fetch(spec.url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    ...(signal ? { signal } : {}),
  });
  if (!resp.ok) {
    throw new Error(`Failed to download ${spec.modelName}: HTTP ${resp.status}.`);
  }

  let buf: ArrayBuffer;
  if (resp.body && typeof resp.body.getReader === 'function') {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw createAbortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onProgress?.({
          phase: 'download',
          message: `Downloading ${spec.shortLabel} model (${(received / (1024 * 1024)).toFixed(1)} / ${sizeMb} MB)…`,
          fraction: Math.min(1, received / spec.sizeBytes),
        });
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    buf = merged.buffer;
  } else {
    buf = await resp.arrayBuffer();
  }

  await verifyEnhanceBytes(spec, buf);
  await writeCachedEnhanceModel({
    modelId: spec.modelId,
    data: buf,
    sizeBytes: buf.byteLength,
    cachedAt: Date.now(),
    url: spec.url,
    sha256: spec.sha256,
  });
  return buf;
}

/** 1D trapezoidal feather weight across a tile axis (1 in interior, linear ramp in overlap). */
function featherWeight(pos: number, len: number, overlap: number, atStart: boolean, atEnd: boolean): number {
  let w = 1;
  if (!atStart && overlap > 0 && pos < overlap) {
    w = Math.min(w, (pos + 0.5) / overlap);
  }
  if (!atEnd && overlap > 0 && pos >= len - overlap) {
    w = Math.min(w, (len - pos - 0.5) / overlap);
  }
  return Math.max(1e-4, w);
}

/**
 * Runs tiled RGB [0, 1] NCHW float32 inference with overlap feathering.
 * Tile dimensions are always multiples of 16 for encoder-decoder ONNX models.
 */
export async function runTiledImageEnhancement(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  spec: EnhanceModelSpec,
  session: EnhanceSessionLike,
  options?: {
    tileSize?: number;
    overlap?: number;
    onProgress?: (ev: EnhanceProgressEvent) => void;
    signal?: AbortSignal;
  },
): Promise<EnhanceResult> {
  if (spec.scaleFactor === 2 && (width * 2 > MAX_UPSCALE_OUTPUT_SIDE || height * 2 > MAX_UPSCALE_OUTPUT_SIDE)) {
    throw new Error(
      `Photo is already ${width}×${height} px — 2× upscaling is limited to inputs up to ${MAX_UPSCALE_OUTPUT_SIDE / 2} px per side to avoid browser memory errors.`,
    );
  }

  const requestedTile = options?.tileSize ?? spec.defaultTileSize;
  const minSide = options?.tileSize !== undefined ? Math.min(spec.minTileSide, requestedTile) : spec.minTileSide;
  const tileSize = Math.max(32, minSide, Math.floor(requestedTile / 16) * 16);
  const overlap = Math.min(Math.floor(tileSize / 4), Math.max(0, options?.overlap ?? 32));
  const stride = tileSize - overlap;
  const scale = spec.scaleFactor;

  const outW = width * scale;
  const outH = height * scale;
  const accum = new Float32Array(outW * outH * 3);
  const weightSum = new Float32Array(outW * outH);

  const buildStarts = (total: number): number[] => {
    if (total <= tileSize) return [0];
    const starts: number[] = [];
    for (let p = 0; p + tileSize < total; p += stride) {
      starts.push(p);
    }
    starts.push(total - tileSize);
    return starts;
  };
  const xs = buildStarts(width);
  const ys = buildStarts(height);

  const inputName = session.inputNames?.[0] ?? 'input';
  const totalTiles = xs.length * ys.length;
  let completed = 0;

  for (let yi = 0; yi < ys.length; yi++) {
    const y0 = ys[yi]!;
    const validH = Math.min(tileSize, height - y0);
    // Pad tile height/width up to at least minSide and a multiple of 16.
    const padH = Math.max(16, minSide, Math.ceil(validH / 16) * 16);

    for (let xi = 0; xi < xs.length; xi++) {
      if (options?.signal?.aborted) throw createAbortError();

      const x0 = xs[xi]!;
      const validW = Math.min(tileSize, width - x0);
      const padW = Math.max(16, minSide, Math.ceil(validW / 16) * 16);

      const planeSize = padH * padW;
      const inputData = new Float32Array(3 * planeSize);
      for (let ty = 0; ty < padH; ty++) {
        const sy = Math.min(height - 1, y0 + Math.min(ty, validH - 1));
        const srcRow = sy * width;
        const dstRow = ty * padW;
        for (let tx = 0; tx < padW; tx++) {
          const sx = Math.min(width - 1, x0 + Math.min(tx, validW - 1));
          const o = (srcRow + sx) * 4;
          const idx = dstRow + tx;
          inputData[idx] = rgba[o]! / 255;
          inputData[planeSize + idx] = rgba[o + 1]! / 255;
          inputData[2 * planeSize + idx] = rgba[o + 2]! / 255;
        }
      }

      const inputTensor = new ort.Tensor('float32', inputData, [1, 3, padH, padW]);
      const outputs = await session.run({ [inputName]: inputTensor });
      const outName = session.outputNames?.[0] ?? Object.keys(outputs)[0]!;
      const outTensor = outputs[outName];
      if (!outTensor) {
        throw new Error(`Enhancement model ${spec.modelId} returned no output tensor.`);
      }
      const outData = outTensor.data as Float32Array | number[];
      const outTileW = padW * scale;
      const outTileH = padH * scale;
      const outPlane = outTileW * outTileH;
      if (outTensor.dims && outTensor.dims.length === 4) {
        const [, oc, oh, ow] = outTensor.dims;
        if (oc !== 3 || oh !== outTileH || ow !== outTileW) {
          throw new Error(
            `Enhancement model ${spec.modelId} returned unexpected shape [${outTensor.dims.join(', ')}] (expected [1, 3, ${outTileH}, ${outTileW}]).`,
          );
        }
      }
      if (outData.length < 3 * outPlane) {
        throw new Error(
          `Enhancement model ${spec.modelId} returned truncated output (${outData.length} values, expected ${3 * outPlane}).`,
        );
      }

      const outValidW = validW * scale;
      const outValidH = validH * scale;
      const outOverlap = overlap * scale;
      const atTop = yi === 0;
      const atBottom = yi === ys.length - 1;
      const atLeft = xi === 0;
      const atRight = xi === xs.length - 1;

      for (let oy = 0; oy < outValidH; oy++) {
        const wy = featherWeight(oy, outValidH, outOverlap, atTop, atBottom);
        const gy = y0 * scale + oy;
        const gRow = gy * outW;
        const tRow = oy * outTileW;
        for (let ox = 0; ox < outValidW; ox++) {
          const wx = featherWeight(ox, outValidW, outOverlap, atLeft, atRight);
          const w = wx * wy;
          const gx = x0 * scale + ox;
          const gIdx = gRow + gx;
          const tIdx = tRow + ox;
          const r = Number(outData[tIdx]!);
          const g = Number(outData[outPlane + tIdx]!);
          const b = Number(outData[2 * outPlane + tIdx]!);
          if (
            !Number.isFinite(r) ||
            !Number.isFinite(g) ||
            !Number.isFinite(b) ||
            Math.abs(r) > 10 ||
            Math.abs(g) > 10 ||
            Math.abs(b) > 10
          ) {
            throw new Error(
              `Enhancement model ${spec.modelId} produced numerically invalid output (${r}, ${g}, ${b}).`,
            );
          }
          const g3 = gIdx * 3;
          accum[g3] = accum[g3]! + r * w;
          accum[g3 + 1] = accum[g3 + 1]! + g * w;
          accum[g3 + 2] = accum[g3 + 2]! + b * w;
          weightSum[gIdx] = weightSum[gIdx]! + w;
        }
      }

      completed++;
      options?.onProgress?.({
        phase: 'tile',
        message: `Enhancing (${spec.shortLabel}): tile ${completed}/${totalTiles}`,
        fraction: completed / totalTiles,
      });
    }
  }

  const result = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 0; i < outW * outH; i++) {
    const w = weightSum[i]! || 1;
    const i3 = i * 3;
    const i4 = i * 4;
    result[i4] = Math.max(0, Math.min(255, Math.round((accum[i3]! / w) * 255)));
    result[i4 + 1] = Math.max(0, Math.min(255, Math.round((accum[i3 + 1]! / w) * 255)));
    result[i4 + 2] = Math.max(0, Math.min(255, Math.round((accum[i3 + 2]! / w) * 255)));
    result[i4 + 3] = 255;
  }

  return { data: result, width: outW, height: outH, spec };
}

/** Builds a normalized 1D Gaussian kernel of length `2 * radius + 1`. */
function buildGaussianKernel1D(sigma: number): { kernel: Float32Array; radius: number } {
  const s = Math.max(0.3, sigma);
  const radius = Math.max(1, Math.ceil(3 * s));
  const len = radius * 2 + 1;
  const kernel = new Float32Array(len);
  const inv2s2 = 1 / (2 * s * s);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) * inv2s2);
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < len; i++) {
    kernel[i] = kernel[i]! / sum;
  }
  return { kernel, radius };
}

/**
 * Separable 2-pass 1D convolution with clamp-to-edge boundaries.
 * Safe when `src === dst` because pass 1 writes into `tmp` and pass 2 reads from `tmp`.
 */
function convolveSeparable(
  src: Float32Array,
  tmp: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  kernel: Float32Array,
  radius: number,
): void {
  const maxX = width - 1;
  const maxY = height - 1;

  // Horizontal pass: src -> tmp
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sx = x + k;
        if (sx < 0) sx = 0;
        else if (sx > maxX) sx = maxX;
        acc += src[row + sx]! * kernel[k + radius]!;
      }
      tmp[row + x] = acc;
    }
  }

  // Vertical pass: tmp -> dst
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sy = y + k;
        if (sy < 0) sy = 0;
        else if (sy > maxY) sy = maxY;
        acc += tmp[sy * width + x]! * kernel[k + radius]!;
      }
      dst[row + x] = acc;
    }
  }
}

export interface DeblurOptions {
  /** Number of Richardson–Lucy iterations (default: 10). */
  iterations?: number;
  /** Assumed Gaussian PSF standard deviation in pixels (default: 1.4). */
  sigma?: number;
  /** Total-Variation regularization weight (Dey et al., 2006; default: 0.002). */
  tvLambda?: number;
  onProgress?: (ev: EnhanceProgressEvent) => void;
  signal?: AbortSignal;
}

/**
 * Built-in Total-Variation-regularized Richardson–Lucy deconvolution in Rec. 709
 * luminance space (Dey et al., 2006).
 *
 * Properties:
 * - Zero external model download, deterministic, and strictly bounded in [0, 1].
 * - Preserves exact RGB hue (avoids color fringing / rainbow artifacts on gravel & sand).
 * - Any uniform-intensity image is an exact fixed point.
 */
export async function deblurRichardsonLucy(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options?: DeblurOptions,
): Promise<EnhanceResult> {
  if (options?.signal?.aborted) throw createAbortError();

  const spec = ENHANCE_MODELS.deblur;
  const iterations = Math.max(1, Math.min(40, Math.round(options?.iterations ?? 10)));
  const sigma = options?.sigma ?? 1.4;
  const tvLambda = Math.max(0, options?.tvLambda ?? 0.002);

  const n = width * height;
  if (n === 0) {
    return { data: new Uint8ClampedArray(0), width, height, spec };
  }

  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    lum[i] = (0.2126 * rgba[o]! + 0.7152 * rgba[o + 1]! + 0.0722 * rgba[o + 2]!) / 255;
  }

  const est = new Float32Array(lum);
  const bufA = new Float32Array(n);
  const bufB = new Float32Array(n);
  const prevPy = new Float32Array(width);
  const { kernel, radius } = buildGaussianKernel1D(sigma);
  const eps = 1e-4;
  const tvEps2 = 1e-8;
  const shouldYield = n >= 262144;

  for (let iter = 1; iter <= iterations; iter++) {
    if (options?.signal?.aborted) throw createAbortError();

    // Forward blur: bufA = H * est
    convolveSeparable(est, bufB, bufA, width, height, kernel, radius);

    // Damped ratio: bufA = clamp((lum + eps) / (blurred + eps), 0.1, 10)
    for (let i = 0; i < n; i++) {
      const r = (lum[i]! + eps) / (bufA[i]! + eps);
      bufA[i] = r < 0.1 ? 0.1 : r > 10 ? 10 : r;
    }

    // Adjoint blur (symmetric Gaussian PSF => H^T = H): bufA = H^T * ratio
    convolveSeparable(bufA, bufB, bufA, width, height, kernel, radius);

    // Streaming TV-regularized multiplicative update (uses only 1-row prevPy buffer).
    prevPy.fill(0);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      const hasNextY = y + 1 < height;
      let prevPx = 0;
      for (let x = 0; x < width; x++) {
        const idx = row + x;
        const c = est[idx]!;
        let denom = 1;
        if (tvLambda > 0) {
          const ux = x + 1 < width ? est[idx + 1]! - c : 0;
          const uy = hasNextY ? est[idx + width]! - c : 0;
          const mag = Math.sqrt(ux * ux + uy * uy + tvEps2);
          const px = ux / mag;
          const py = uy / mag;
          const div = px - prevPx + (py - prevPy[x]!);
          prevPx = px;
          prevPy[x] = py;
          denom = Math.max(0.5, 1 - tvLambda * div);
        }
        const next = (c * bufA[idx]!) / denom;
        est[idx] = next < 0 ? 0 : next > 1 ? 1 : next;
      }
    }

    options?.onProgress?.({
      phase: 'tile',
      message: `Deblurring: iteration ${iter}/${iterations}`,
      fraction: iter / iterations,
    });

    if (shouldYield && iter < iterations) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  // Hue-preserving RGB reconstruction from sharpened luminance.
  const result = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const y0 = lum[i]!;
    const y1 = est[i]!;
    if (y0 > eps) {
      const gain = Math.min(4, y1 / y0);
      result[o] = Math.max(0, Math.min(255, Math.round(rgba[o]! * gain)));
      result[o + 1] = Math.max(0, Math.min(255, Math.round(rgba[o + 1]! * gain)));
      result[o + 2] = Math.max(0, Math.min(255, Math.round(rgba[o + 2]! * gain)));
    } else {
      const delta = Math.round((y1 - y0) * 255);
      result[o] = Math.max(0, Math.min(255, rgba[o]! + delta));
      result[o + 1] = Math.max(0, Math.min(255, rgba[o + 1]! + delta));
      result[o + 2] = Math.max(0, Math.min(255, rgba[o + 2]! + delta));
    }
    result[o + 3] = rgba[o + 3]!;
  }

  return { data: result, width, height, spec };
}

/**
 * Full memory-isolated enhancement run:
 * - For built-in classical enhancers (`deblur`), runs deterministic RL-TV deconvolution
 *   with zero network requests or ONNX sessions.
 * - For ONNX enhancers (`upscale-2x`), downloads/loads verified weights, creates a
 *   temporary ONNX session, runs tiled inference, and always releases the session in `finally`.
 */
export async function enhanceImageBuffer(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  kind: EnhanceKind,
  options?: {
    sessionOptions?: SessionCreateOptions;
    tileSize?: number;
    overlap?: number;
    onProgress?: (ev: EnhanceProgressEvent) => void;
    signal?: AbortSignal;
    sessionFactory?: (bytes: ArrayBuffer, spec: EnhanceModelSpec) => Promise<EnhanceSessionLike>;
  },
): Promise<EnhanceResult> {
  const spec = ENHANCE_MODELS[kind];
  if (spec.engine === 'classical') {
    return deblurRichardsonLucy(rgba, width, height, {
      ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  if (spec.scaleFactor === 2 && (width * 2 > MAX_UPSCALE_OUTPUT_SIDE || height * 2 > MAX_UPSCALE_OUTPUT_SIDE)) {
    throw new Error(
      `Photo is already ${width}×${height} px — 2× upscaling is limited to inputs up to ${MAX_UPSCALE_OUTPUT_SIDE / 2} px per side to avoid browser memory errors.`,
    );
  }

  const bytes = await getEnhanceModelBytes(kind, options?.onProgress, options?.signal);
  options?.onProgress?.({ phase: 'session', message: `Starting ${spec.shortLabel} model…`, fraction: 0 });

  const tileOpts = {
    ...(options?.tileSize !== undefined ? { tileSize: options.tileSize } : {}),
    ...(options?.overlap !== undefined ? { overlap: options.overlap } : {}),
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  };

  if (options?.sessionFactory) {
    const session = await options.sessionFactory(bytes, spec);
    try {
      return await runTiledImageEnhancement(rgba, width, height, spec, session, tileOpts);
    } finally {
      if (typeof session.release === 'function') {
        await session.release().catch(() => undefined);
      }
    }
  }

  const initialOpts: SessionCreateOptions = {
    ...(options?.sessionOptions ?? {}),
    ...(spec.preferWasm ? { forceWasm: true } : {}),
  };
  let created = await createInferenceSession(bytes, initialOpts);
  try {
    return await runTiledImageEnhancement(rgba, width, height, spec, created.session, tileOpts);
  } catch (err) {
    if (created.executionProvider === 'webgpu' && !options?.signal?.aborted) {
      await created.session.release().catch(() => undefined);
      options?.onProgress?.({
        phase: 'session',
        message: `WebGPU kernel unsupported for ${spec.shortLabel}; retrying on CPU (WASM)…`,
        fraction: 0,
      });
      created = await createInferenceSession(bytes, { ...initialOpts, forceWasm: true });
      return await runTiledImageEnhancement(rgba, width, height, spec, created.session, tileOpts);
    }
    throw err;
  } finally {
    await created.session.release().catch(() => undefined);
  }
}

/**
 * Scales calibration and ROI geometry when an image is upscaled by `scaleFactor`
 * (e.g. 2x), preserving exact physical units (`mmPerPx / 2`, pixel coordinates × 2).
 */
export function scaleCalibrationAndRoi(
  calibration: CalibrationResult | undefined,
  roiConfig: RoiExclusionConfig | undefined,
  scaleFactor: number,
): { calibration?: CalibrationResult; roiConfig?: RoiExclusionConfig } {
  if (scaleFactor === 1) {
    return {
      ...(calibration ? { calibration } : {}),
      ...(roiConfig ? { roiConfig } : {}),
    };
  }

  const nextCal: CalibrationResult | undefined = calibration
    ? {
        ...calibration,
        pointA: { x: calibration.pointA.x * scaleFactor, y: calibration.pointA.y * scaleFactor },
        pointB: { x: calibration.pointB.x * scaleFactor, y: calibration.pointB.y * scaleFactor },
        pixelDistance: calibration.pixelDistance * scaleFactor,
        mmPerPx: calibration.mmPerPx / scaleFactor,
      }
    : undefined;

  const nextRoi: RoiExclusionConfig | undefined = roiConfig
    ? {
        ...roiConfig,
        ...(roiConfig.roiPolygon
          ? {
              roiPolygon: roiConfig.roiPolygon.map((pt) => ({
                x: pt.x * scaleFactor,
                y: pt.y * scaleFactor,
              })),
            }
          : {}),
        exclusionPolygons: roiConfig.exclusionPolygons.map((poly) =>
          poly.map((pt) => ({ x: pt.x * scaleFactor, y: pt.y * scaleFactor })),
        ),
        exclusionStrokes: roiConfig.exclusionStrokes.map((st) => ({
          ...st,
          radiusPx: st.radiusPx * scaleFactor,
          points: st.points.map((pt) => ({ x: pt.x * scaleFactor, y: pt.y * scaleFactor })),
        })),
      }
    : undefined;

  return {
    ...(nextCal ? { calibration: nextCal } : {}),
    ...(nextRoi ? { roiConfig: nextRoi } : {}),
  };
}

/** Cumulative pixel scale factor relative to the unenhanced original (1 if not upscaled). */
/**
 * Calibration and ROI to restore when an enhancement is reverted. A value set before the
 * enhancement comes back as it was, unless it was changed afterwards on the enhanced image (e.g.
 * the scale re-measured, an ROI redrawn): then the newer value is kept, scaled back to the
 * original pixels, instead of being silently replaced by the old one.
 */
export function revertedCalibrationAndRoi(photo: {
  width: number;
  calibration?: CalibrationResult;
  roiConfig?: RoiExclusionConfig;
  originalBackup: { width: number; calibration?: CalibrationResult; roiConfig?: RoiExclusionConfig };
}): { calibration?: CalibrationResult; roiConfig?: RoiExclusionConfig } {
  const orig = photo.originalBackup;
  const up = orig.width > 0 && photo.width > 0 ? photo.width / orig.width : 1;
  // What the backup's values became when the enhancement was applied.
  const carried = scaleCalibrationAndRoi(orig.calibration, orig.roiConfig, up);
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const calChanged = photo.calibration !== undefined && !same(photo.calibration, carried.calibration);
  const roiChanged = photo.roiConfig !== undefined && !same(photo.roiConfig, carried.roiConfig);
  const back = scaleCalibrationAndRoi(photo.calibration, photo.roiConfig, 1 / up);
  const calibration = calChanged || orig.calibration === undefined ? back.calibration : orig.calibration;
  const roiConfig = roiChanged || orig.roiConfig === undefined ? back.roiConfig : orig.roiConfig;
  return { ...(calibration ? { calibration } : {}), ...(roiConfig ? { roiConfig } : {}) };
}

export function photoUpscaleFactor(photo: {
  width: number;
  originalBackup?: { width: number };
  metadata?: { enhancement?: { scaleFactor?: number } };
}): number {
  if (photo.originalBackup && photo.originalBackup.width > 0 && photo.width > 0) {
    return photo.width / photo.originalBackup.width;
  }
  const sf = photo.metadata?.enhancement?.scaleFactor;
  return typeof sf === 'number' && Number.isFinite(sf) && sf > 0 ? sf : 1;
}
