/**
 * Optional, memory-isolated AI image enhancement (2x upscaling via PULSE,
 * motion deblurring via NAFNet).
 *
 * Scientific & memory guarantees:
 * - Both models are L1/Charbonnier/PSNR-trained (no GAN hallucination) and MIT-licensed.
 * - Weights are fetched from pinned Hugging Face commits under `inYourOwnBrowser/*`
 *   with `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, and WebCrypto SHA-256
 *   + byte-size verification, cached in IndexedDB alongside segmentation models.
 * - Tiled 256x256 inference (divisible by 16 for NAFNet) with 32 px overlap feathering
 *   keeps peak RAM/VRAM bounded.
 * - Callers release segmentation sessions first (`engine.releaseSessions()`), and
 *   `enhanceImageBuffer()` always calls `session.release()` in `finally` so the
 *   enhancer and ImageGrains are never loaded simultaneously.
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
  /**
   * Run on WASM (CPU) by default when the ONNX graph contains ops that ORT's WebGPU
   * JSEP backend does not yet support (e.g. NAFNet's `sca/Pad_1` zero-sized tensor).
   */
  preferWasm?: boolean;
}

/** Maximum output side length (px) allowed for 2x upscaling to prevent browser canvas OOM. */
export const MAX_UPSCALE_OUTPUT_SIDE = 4096;

export const ENHANCE_MODELS: Record<EnhanceKind, EnhanceModelSpec> = {
  'upscale-2x': {
    kind: 'upscale-2x',
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
  },
  deblur: {
    kind: 'deblur',
    modelId: 'nafnet_deblur_fp32',
    modelName: 'NAFNet Deblur (MIT, PSNR/L1)',
    shortLabel: 'deblur',
    repoId: 'inYourOwnBrowser/deblurring_nafnet',
    revision: 'e82b9f2df1f4211296215344f1946a10f876abf0',
    filePath: 'deblurring_nafnet_2025may.onnx',
    url: 'https://huggingface.co/inYourOwnBrowser/deblurring_nafnet/resolve/e82b9f2df1f4211296215344f1946a10f876abf0/deblurring_nafnet_2025may.onnx',
    sha256: '07263f416febecce10193dd648e950b22e397cf521eedab1a114ef77b2bc9587',
    sizeBytes: 91736251,
    scaleFactor: 1,
    license: 'MIT',
    preferWasm: true,
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
 * Tile dimensions are always multiples of 16 (required by NAFNet's encoder-decoder).
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

  const tileSize = Math.max(32, Math.floor((options?.tileSize ?? 256) / 16) * 16);
  const overlap = Math.min(Math.floor(tileSize / 4), Math.max(0, options?.overlap ?? 32));
  const stride = tileSize - overlap;
  const scale = spec.scaleFactor;

  const outW = width * scale;
  const outH = height * scale;
  const accum = new Float32Array(outW * outH * 3);
  const weightSum = new Float32Array(outW * outH);

  const xs: number[] = [];
  for (let x = 0; x < width; x += stride) {
    xs.push(x);
    if (x + tileSize >= width) break;
  }
  const ys: number[] = [];
  for (let y = 0; y < height; y += stride) {
    ys.push(y);
    if (y + tileSize >= height) break;
  }

  const inputName = session.inputNames?.[0] ?? 'input';
  const totalTiles = xs.length * ys.length;
  let completed = 0;

  for (let yi = 0; yi < ys.length; yi++) {
    const y0 = ys[yi]!;
    const validH = Math.min(tileSize, height - y0);
    // Pad tile height/width up to next multiple of 16 (min 16) using edge replication.
    const padH = Math.max(16, Math.ceil(validH / 16) * 16);

    for (let xi = 0; xi < xs.length; xi++) {
      if (options?.signal?.aborted) throw createAbortError();

      const x0 = xs[xi]!;
      const validW = Math.min(tileSize, width - x0);
      const padW = Math.max(16, Math.ceil(validW / 16) * 16);

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
          const g3 = gIdx * 3;
          accum[g3] = accum[g3]! + Number(outData[tIdx]!) * w;
          accum[g3 + 1] = accum[g3 + 1]! + Number(outData[outPlane + tIdx]!) * w;
          accum[g3 + 2] = accum[g3 + 2]! + Number(outData[2 * outPlane + tIdx]!) * w;
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

/**
 * Full memory-isolated enhancement run:
 * 1. Downloads/loads verified ONNX weights.
 * 2. Creates a temporary ONNX session (WebGPU or WASM).
 * 3. Runs tiled inference.
 * 4. Always releases the session in `finally` before returning.
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
