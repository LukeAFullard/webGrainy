import * as ort from 'onnxruntime-web';
import {
  cpNormalizeRgbPerChannel,
  cpPercentile1And99,
  cpResizeBilinear,
  runCellposeTiled,
  type CellposeTilingOptions,
} from './cellposeTiling.js';
import type { OrtWorkerHost } from './ortWorkerSession.js';
import type {
  ExecutionProvider,
  InferenceOutput,
  RegionNeedTest,
  TileSkipRecord,
} from '../types/index.js';

export interface SessionCreateOptions {
  wasmPaths?: string;
  simd?: boolean;
  numThreads?: number;
  /** When true, require WebGPU `shader-f16` support before selecting WebGPU EP. */
  requireShaderF16?: boolean;
  /**
   * Skip WebGPU entirely and use the WASM (CPU) EP. Set by the engine after a WebGPU
   * device loss: ORT keeps one GPUDevice per page, and once it is lost every later
   * WebGPU session would fail, so only a page reload can restore GPU inference.
   */
  forceWasm?: boolean;
  /**
   * Runs WASM (CPU) sessions in this worker instead of on the page's main thread, so long
   * CPU inference never freezes the page (see ortWorkerSession.ts). Browser only.
   */
  wasmWorker?: OrtWorkerHost;
}

export interface WebGpuCapabilities {
  hasAdapter: boolean;
  hasShaderF16: boolean | undefined;
}

export interface InferenceSessionResult {
  session: ort.InferenceSession;
  executionProvider: ExecutionProvider;
}

export class WebGpuDeviceLostError extends Error {
  constructor(message = 'WebGPU device was lost during inference. Try U-Net (WASM) or reload the page.') {
    super(message);
    this.name = 'WebGpuDeviceLostError';
  }
}

/**
 * Thrown when a network tile output contains NaN/Infinity or implausibly large values.
 * Cellpose flows are bounded (about +/-10) and cell probabilities are logits (about
 * +/-30). Float16 GPU arithmetic can overflow on unusual inputs, such as the zero
 * borders the Cellpose pipeline adds. Seen with ONNX Runtime's CUDA FP16 backend in
 * the Colab benchmark (validation/heldout/); unverified for WebGPU.
 */
export class NumericInstabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NumericInstabilityError';
  }
}

/** Largest absolute value accepted in a network output tile. */
export const MAX_PLAUSIBLE_OUTPUT = 1000;

/** Throws NumericInstabilityError if `out` has non-finite or implausible values. */
export function assertPlausibleOutput(out: Float32Array, context: string): void {
  let bad = 0;
  let maxAbs = 0;
  for (let i = 0; i < out.length; i++) {
    const v = out[i]!;
    if (!Number.isFinite(v)) {
      bad++;
    } else {
      const a = v < 0 ? -v : v;
      if (a > maxAbs) maxAbs = a;
    }
  }
  if (bad > 0 || maxAbs > MAX_PLAUSIBLE_OUTPUT) {
    throw new NumericInstabilityError(
      `${context}: network output is numerically invalid (${bad} non-finite values, max |value| ${maxAbs.toPrecision(3)}).`,
    );
  }
}

export function isWebGpuDeviceLostError(err: unknown): boolean {
  if (err instanceof WebGpuDeviceLostError) {
    return true;
  }
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /device\s*(was\s*|is\s*)?lost|context\s*lost|gpubuffer.*invalid|webgpu.*lost/i.test(msg);
}

// ---- WebGPU validation-error watch ---------------------------------------------------
// A shader that fails to compile (e.g. float16 WGSL on an adapter without `shader-f16`)
// does NOT make session.run() reject: ORT returns plausible-looking but wrong numbers,
// and WebGPU only reports an "uncapturederror" event on the device. Count those events
// and treat any that occur during a run as a failed (numerically invalid) inference.
interface GpuDeviceLike {
  lost?: Promise<{ reason?: string; message?: string }>;
  addEventListener?: (type: string, cb: (ev: { error?: { message?: string } }) => void) => void;
}
const watchedDevices = new WeakSet<object>();
let gpuErrorCount = 0;
let lastGpuError = '';

function watchDevice(dev: GpuDeviceLike | undefined): void {
  if (!dev || typeof dev !== 'object' || watchedDevices.has(dev)) return;
  if (typeof dev.addEventListener !== 'function') return;
  watchedDevices.add(dev);
  dev.addEventListener('uncapturederror', (ev) => {
    gpuErrorCount++;
    lastGpuError = ev?.error?.message ?? 'unknown WebGPU error';
  });
}

/**
 * Sessions created on the WASM (CPU) backend by `createInferenceSession`. These never touch the
 * page's GPUDevice, so they must not be raced against `ort.env.webgpu.device.lost`: after a device
 * loss that promise stays resolved for the life of the page, and racing a CPU fallback session
 * against it would fail every later CPU run with a spurious WebGpuDeviceLostError.
 */
const wasmSessions = new WeakSet<object>();

async function runSessionWithDeviceGuard(
  session: ort.InferenceSession,
  feeds: Record<string, ort.Tensor>,
): Promise<ort.InferenceSession.OnnxValueMapType> {
  if (wasmSessions.has(session)) return session.run(feeds);
  const webgpuEnv = (ort.env as { webgpu?: { device?: GpuDeviceLike } }).webgpu;
  watchDevice(webgpuEnv?.device);
  const errorsBefore = gpuErrorCount;
  const checkGpuErrors = async (): Promise<void> => {
    // the device may only exist after the first run; error events dispatch as tasks
    watchDevice(webgpuEnv?.device);
    await new Promise((r) => setTimeout(r, 0));
    if (gpuErrorCount > errorsBefore) {
      throw new NumericInstabilityError(
        `WebGPU reported ${gpuErrorCount - errorsBefore} error(s) during inference; results are unreliable (${lastGpuError.slice(0, 200)}).`,
      );
    }
  };
  const lostPromise = webgpuEnv?.device?.lost;
  try {
    if (lostPromise && typeof lostPromise.then === 'function') {
      const result = await Promise.race([
        session.run(feeds),
        lostPromise.then((info) => {
          const detail = info?.message || info?.reason || 'GPU device reset';
          throw new WebGpuDeviceLostError(
            `WebGPU device lost during inference (${detail}). Switch to U-Net or reload to recover.`,
          );
        }),
      ]);
      await checkGpuErrors();
      return result;
    }
    const result = await session.run(feeds);
    await checkGpuErrors();
    return result;
  } catch (err) {
    if (err instanceof WebGpuDeviceLostError || err instanceof NumericInstabilityError) {
      throw err;
    }
    if (isWebGpuDeviceLostError(err)) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new WebGpuDeviceLostError(
        `WebGPU device lost during inference (${detail}). Switch to U-Net or reload to recover.`,
      );
    }
    throw err;
  }
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
/**
 * WASM thread count to use when the caller does not specify one.
 *
 * WASM threads need `SharedArrayBuffer`, i.e. a cross-origin-isolated page (COOP/COEP
 * headers, see DEPLOYMENT.md). Without isolation ORT runs single-threaded whatever is
 * set. When isolated, ORT's own default uses only about half the logical cores; measured
 * on a 4-core machine (validation/perf/), using all cores made U-Net inference ~1.8x faster
 * than the default and ~3x faster than single-threaded.
 *
 * Default: one fewer than the logical cores (at least 1), so one core stays free for the
 * page, the post-processing worker and the rest of the device (phones, quad-cores).
 * Capped at 8: more threads than physical cores was slower in the same benchmark, and
 * `hardwareConcurrency` counts hyper-threads. Users can override (`wasmThreadsFor`).
 */
export function defaultWasmThreads(): number | undefined {
  return wasmThreadsFor('auto');
}

/** Logical cores reported by the browser, or undefined. */
export function logicalCores(): number | undefined {
  const hc = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
  return typeof hc === 'number' && Number.isFinite(hc) && hc >= 1 ? Math.floor(hc) : undefined;
}

/**
 * WASM threads for a user preference: 'auto' (cores − 1, max 8) or an explicit count
 * (clamped to 1..cores). Undefined when the page is not cross-origin isolated (ORT is
 * single-threaded then, whatever is set) or the core count is unknown.
 */
export function wasmThreadsFor(pref: 'auto' | number): number | undefined {
  if ((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== true) return undefined;
  const hc = logicalCores();
  if (hc === undefined) return undefined;
  if (pref === 'auto') return Math.max(1, Math.min(8, hc - 1));
  if (!Number.isFinite(pref)) return undefined;
  return Math.max(1, Math.min(hc, Math.floor(pref)));
}

/**
 * Resolves a relative `wasmPaths` prefix against the *document* base URL.
 * ORT loads its `.mjs`/`.wasm` via dynamic `import()`, which resolves relative
 * specifiers against the importing module (e.g. `dist/ui/main.js` -> `/ui/ort/`),
 * not the page. Absolute URLs and non-browser environments are returned unchanged.
 */
export function resolveWasmPaths(prefix: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(prefix) || prefix.startsWith('/')) {
    return prefix;
  }
  const base =
    (globalThis as { document?: { baseURI?: string } }).document?.baseURI ??
    (globalThis as { location?: { href?: string } }).location?.href;
  if (typeof base !== 'string' || base.length === 0) {
    return prefix;
  }
  try {
    return new URL(prefix, base).href;
  } catch {
    return prefix;
  }
}

export async function createInferenceSession(
  modelBytes: ArrayBuffer | Uint8Array,
  options?: SessionCreateOptions,
): Promise<InferenceSessionResult> {
  ort.env.wasm.wasmPaths = resolveWasmPaths(options?.wasmPaths ?? './ort/');
  ort.env.wasm.simd = options?.simd ?? true;
  const threads = options?.numThreads ?? defaultWasmThreads();
  if (threads !== undefined) {
    ort.env.wasm.numThreads = threads;
  }

  const bytes =
    modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes);

  // Only request WebGPU when a real adapter exists (and supports shader-f16 when required):
  // `navigator.gpu` can be present with no usable adapter or without FP16 shader support.
  const gpuCaps =
    options?.forceWasm === true
      ? { hasAdapter: false, hasShaderF16: false }
      : await probeWebGpuCapabilities();
  const canUseWebGpu =
    options?.forceWasm !== true &&
    gpuCaps.hasAdapter &&
    (!options?.requireShaderF16 || gpuCaps.hasShaderF16 !== false);
  if (canUseWebGpu) {
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
      });
      return { session, executionProvider: 'webgpu' };
    } catch {
      // fall through to WASM
    }
  }
  if (options?.wasmWorker !== undefined) {
    const session = await options.wasmWorker.createSession(bytes, {
      wasmPaths: ort.env.wasm.wasmPaths as string,
      simd: ort.env.wasm.simd ?? true,
      ...(threads !== undefined ? { numThreads: threads } : {}),
    });
    wasmSessions.add(session);
    // Same `run` / `release` shape the inference code uses.
    return { session: session as unknown as ort.InferenceSession, executionProvider: 'wasm' };
  }
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
  });
  wasmSessions.add(session);
  return { session, executionProvider: 'wasm' };
}

/** Probes whether a WebGPU adapter exists and whether it supports `shader-f16`. */
export async function probeWebGpuCapabilities(): Promise<WebGpuCapabilities> {
  const gpu = (
    globalThis.navigator as
      | {
          gpu?: {
            requestAdapter?: () => Promise<{
              features?: { has?: (feature: string) => boolean };
            } | null>;
          };
        }
      | undefined
  )?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    return { hasAdapter: false, hasShaderF16: false };
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return { hasAdapter: false, hasShaderF16: false };
    }
    const hasShaderF16 =
      typeof adapter.features?.has === 'function'
        ? Boolean(adapter.features.has('shader-f16'))
        : undefined;
    return { hasAdapter: true, hasShaderF16 };
  } catch {
    return { hasAdapter: false, hasShaderF16: false };
  }
}

/** Resolves `true` only if `navigator.gpu.requestAdapter()` yields an adapter. */
export async function hasWebGpuAdapter(): Promise<boolean> {
  return (await probeWebGpuCapabilities()).hasAdapter;
}

// ---------------------------------------------------------------------------
// Upstream-exact (Cellpose) inference pipelines. Running our ONNX exports through
// these reproduces PyTorch Cellpose: PQ vs PyTorch 0.97 (U-Net) / 0.995 (Cellpose-SAM)
// (validation/parity/).
// ---------------------------------------------------------------------------

/** Settings for the upstream-exact U-Net pipeline (Cellpose 3.1, IG2 U-Net). */
/**
 * Tiler options that skip tiles outside `needRegion` (working-image px). `sx`/`sy` map
 * the tiler's image coordinates to working-image px (U-Net runs on a resized image).
 * Reports the analysed area through `onRecord` only when at least one tile was skipped.
 */
function tileSkipOptions(
  options: { needRegion?: RegionNeedTest; needRegionMarginPx?: number } | undefined,
  sx: number,
  sy: number,
  width: number,
  height: number,
  onRecord: (t: TileSkipRecord) => void,
): Pick<CellposeTilingOptions, 'needTile' | 'onPlan'> {
  const need = options?.needRegion;
  if (!need) return {};
  const toWorking = (y0: number, x0: number, y1: number, x1: number): [number, number, number, number] => [
    Math.max(0, Math.floor(x0 * sx)),
    Math.max(0, Math.floor(y0 * sy)),
    Math.min(width, Math.ceil(x1 * sx)),
    Math.min(height, Math.ceil(y1 * sy)),
  ];
  return {
    needTile: (y0, x0, y1, x1) => {
      const [a, b, c, d] = toWorking(y0, x0, y1, x1);
      return need(a, b, c, d);
    },
    onPlan: ({ run, total }) => {
      if (run.length === total) return;
      onRecord({
        tilesRun: run.length,
        tilesTotal: total,
        marginPx: options?.needRegionMarginPx ?? 0,
        analysedRects: run.map(([y0, x0, y1, x1]) => toWorking(y0, x0, y1, x1)),
      });
    },
  };
}

export interface UnetCellposeOptions {
  /** Model's training diameter (stored in the IG2 U-Net weights). */
  diamMean?: number;
  /**
   * Diameter passed to Cellpose eval; the image is resized by diamMean/diameter.
   * 30 matches the benchmark's PyTorch reference (ImageGrains' own default, None,
   * uses the training label diameter 29.26 instead).
   */
  diameter?: number;
  /** Skip tiles where this returns false (working-image px); see roiTileSkip.ts. */
  needRegion?: RegionNeedTest;
  /** Margin recorded with the analysed area. */
  needRegionMarginPx?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { completedTiles: number; totalTiles: number; percent: number }) => void;
}

/**
 * U-Net inference exactly as Cellpose 3 runs it for `channels=[0,0]`: grayscale =
 * mean(R,G,B); 1-99 % normalisation; resize by diamMean/diameter; 224 px tiles with
 * 10 % overlap, 8 px zero border and sigmoid-taper blending; outputs resized back.
 */
export async function runUnetCellposeInference(
  session: ort.InferenceSession,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options?: UnetCellposeOptions,
): Promise<InferenceOutput> {
  const n = width * height;
  if (rgba.length !== n * 4) {
    throw new RangeError(`rgba length (${rgba.length}) does not match ${width}x${height}x4.`);
  }
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = (rgba[i * 4]! + rgba[i * 4 + 1]! + rgba[i * 4 + 2]!) / 3;
  }
  const [p1, p99] = cpPercentile1And99(gray);
  const denom = p99 - p1;
  for (let i = 0; i < n; i++) gray[i] = denom > 1e-3 ? (gray[i]! - p1) / denom : 0;

  const rescale = (options?.diamMean ?? 17) / (options?.diameter ?? 30);
  const H2 = Math.max(1, Math.trunc(height * rescale));
  const W2 = Math.max(1, Math.trunc(width * rescale));
  const small = rescale === 1 ? gray : cpResizeBilinear(gray, 1, height, width, H2, W2);
  const input2 = new Float32Array(2 * H2 * W2); // channel 1 stays zero
  input2.set(small, 0);
  let tiling: TileSkipRecord | undefined;

  const yf = await runCellposeTiled(
    input2,
    2,
    H2,
    W2,
    async (tile, th, tw) => {
      const t = new ort.Tensor('float32', tile.slice(), [1, 2, th, tw]);
      const out = await runSessionWithDeviceGuard(session, { image: t });
      const o = out['flows_cellprob'];
      if (!o) throw new Error('U-Net model output "flows_cellprob" is missing.');
      const y = decodeOutputTensorData(o.data);
      assertPlausibleOutput(y, 'U-Net tile');
      return y;
    },
    {
      version: 'v3',
      bsize: 224,
      tileOverlap: 0.1,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...tileSkipOptions(options, width / W2, height / H2, width, height, (t) => (tiling = t)),
      onTile: (done, total) =>
        options?.onProgress?.({ completedTiles: done, totalTiles: total, percent: Math.round((done / total) * 100) }),
    },
  );
  const full = rescale === 1 ? yf : cpResizeBilinear(yf, 3, H2, W2, height, width);
  return {
    flowY: full.slice(0, n),
    flowX: full.slice(n, 2 * n),
    cellprob: full.slice(2 * n, 3 * n),
    width,
    height,
    ...(tiling !== undefined ? { tiling } : {}),
  };
}

/** Settings for the upstream-exact Cellpose-SAM pipeline (Cellpose 4.1). */
export interface CpsamCellposeOptions {
  /** Tile overlap fraction (the benchmark's PyTorch reference used 0.25). */
  tileOverlap?: number;
  /** Skip tiles where this returns false (working-image px); see roiTileSkip.ts. */
  needRegion?: RegionNeedTest;
  /** Margin recorded with the analysed area. */
  needRegionMarginPx?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { completedTiles: number; totalTiles: number; percent: number }) => void;
}

/**
 * Cellpose-SAM inference exactly as Cellpose 4 runs it (diameter=None): per-channel
 * 1-99 % normalisation; 256 px tiles; 8 px zero border (images under 256 px zero-padded
 * up to 256); sigmoid-taper blending. One tile per run (safe on WASM and WebGPU).
 */
export async function runCpsamCellposeInference(
  session: ort.InferenceSession,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options?: CpsamCellposeOptions,
): Promise<InferenceOutput> {
  const n = width * height;
  if (rgba.length !== n * 4) {
    throw new RangeError(`rgba length (${rgba.length}) does not match ${width}x${height}x4.`);
  }
  const chw = cpNormalizeRgbPerChannel(rgba, width, height);
  let tiling: TileSkipRecord | undefined;
  const yf = await runCellposeTiled(
    chw,
    3,
    height,
    width,
    async (tile, th, tw) => {
      const t = new ort.Tensor('float16', float32ArrayToFloat16Bits(tile), [1, 3, th, tw]);
      const out = await runSessionWithDeviceGuard(session, { image: t });
      const o = out['flows_cellprob'];
      if (!o) throw new Error('Cellpose-SAM model output "flows_cellprob" is missing.');
      const y = decodeOutputTensorData(o.data);
      assertPlausibleOutput(y, 'Cellpose-SAM tile');
      return y;
    },
    {
      version: 'v4',
      bsize: 256,
      tileOverlap: options?.tileOverlap ?? 0.25,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...tileSkipOptions(options, 1, 1, width, height, (t) => (tiling = t)),
      onTile: (done, total) =>
        options?.onProgress?.({ completedTiles: done, totalTiles: total, percent: Math.round((done / total) * 100) }),
    },
  );
  return {
    flowY: yf.slice(0, n),
    flowX: yf.slice(n, 2 * n),
    cellprob: yf.slice(2 * n, 3 * n),
    width,
    height,
    ...(tiling !== undefined ? { tiling } : {}),
  };
}
