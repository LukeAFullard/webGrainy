import * as ort from 'onnxruntime-web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInferenceSession,
  probeWebGpuCapabilities,
  assertPlausibleOutput,
  defaultWasmThreads,
  wasmThreadsFor,
  NumericInstabilityError,
  hasWebGpuAdapter,
  WebGpuDeviceLostError,
  isWebGpuDeviceLostError,
  resolveWasmPaths,
  float16BitsToFloat32Array,
  float16ToFloat32,
  float32ArrayToFloat16Bits,
  float32ToFloat16,
  runCpsamCellposeInference,
  runUnetCellposeInference,
} from '../src/modules/onnxInference.js';

describe('onnxInference', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('IEEE-754 Float32 <-> Float16', () => {
    it('handles +0, -0, +Infinity, -Infinity, and NaN', () => {
      expect(float32ToFloat16(0)).toBe(0x0000);
      expect(Object.is(float16ToFloat32(0x0000), 0)).toBe(true);

      expect(float32ToFloat16(-0)).toBe(0x8000);
      expect(Object.is(float16ToFloat32(0x8000), -0)).toBe(true);

      expect(float32ToFloat16(Infinity)).toBe(0x7c00);
      expect(float16ToFloat32(0x7c00)).toBe(Infinity);

      expect(float32ToFloat16(-Infinity)).toBe(0xfc00);
      expect(float16ToFloat32(0xfc00)).toBe(-Infinity);

      const nanBits = float32ToFloat16(Number.NaN);
      expect(nanBits & 0x7c00).toBe(0x7c00);
      expect(nanBits & 0x03ff).not.toBe(0);
      expect(Number.isNaN(float16ToFloat32(nanBits))).toBe(true);
    });

    it('handles boundary values (65504, 65519 rounding, 65520 overflow, 2^-14, 2^-24, 2^-25)', () => {
      // Max finite float16 = 65504 (0x7bff)
      expect(float32ToFloat16(65504)).toBe(0x7bff);
      expect(float16ToFloat32(0x7bff)).toBe(65504);
      expect(float32ToFloat16(-65504)).toBe(0xfbff);
      expect(float16ToFloat32(0xfbff)).toBe(-65504);

      // 65519 < 65520 rounds down to 65504; 65520 rounds to even (overflow to Infinity)
      expect(float32ToFloat16(65519)).toBe(0x7bff);
      expect(float32ToFloat16(65520)).toBe(0x7c00);
      expect(float32ToFloat16(1e6)).toBe(0x7c00);
      expect(float32ToFloat16(-1e6)).toBe(0xfc00);

      // Smallest normal: 2^-14 (0x0400)
      const minNormal = Math.pow(2, -14);
      expect(float32ToFloat16(minNormal)).toBe(0x0400);
      expect(float16ToFloat32(0x0400)).toBe(minNormal);

      // Smallest subnormal: 2^-24 (0x0001)
      const minSubnormal = Math.pow(2, -24);
      expect(float32ToFloat16(minSubnormal)).toBe(0x0001);
      expect(float16ToFloat32(0x0001)).toBe(minSubnormal);
      expect(float32ToFloat16(-minSubnormal)).toBe(0x8001);
      expect(float16ToFloat32(0x8001)).toBe(-minSubnormal);

      // 2^-25 is halfway between 0 and 2^-24; ties-to-even -> 0
      expect(float32ToFloat16(Math.pow(2, -25))).toBe(0x0000);
      // Slightly above 2^-25 rounds to 2^-24
      expect(float32ToFloat16(Math.pow(2, -25) * 1.1)).toBe(0x0001);
    });

    it('round-trips Float32Array <-> Uint16Array accurately', () => {
      const src = new Float32Array([0, 1, -1, 0.5, -3.25, 123.5, 0.0001, -42.125]);
      const bits = float32ArrayToFloat16Bits(src);
      expect(bits).toBeInstanceOf(Uint16Array);
      expect(bits.length).toBe(src.length);

      const dst = float16BitsToFloat32Array(bits);
      expect(dst).toBeInstanceOf(Float32Array);
      for (let i = 0; i < src.length; i++) {
        expect(dst[i]).toBeCloseTo(src[i]!, 3);
      }
    });
  });

  describe('createInferenceSession', () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const setNavigator = (value: unknown): void => {
      Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
    };
    afterEach(() => {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      vi.restoreAllMocks();
    });

    it('configures local ./ort/ wasmPaths and falls back from webgpu to wasm when the GPU EP fails', async () => {
      setNavigator({ gpu: { requestAdapter: async () => ({}) } });
      const mockSession = { run: vi.fn() } as unknown as ort.InferenceSession;
      const createSpy = vi
        .spyOn(ort.InferenceSession, 'create')
        .mockRejectedValueOnce(new Error('WebGPU not supported'))
        .mockResolvedValueOnce(mockSession);

      const modelBytes = new Uint8Array([1, 2, 3, 4]);
      const result = await createInferenceSession(modelBytes, {
        simd: true,
        numThreads: 2,
      });

      expect(ort.env.wasm.wasmPaths).toBe('./ort/');
      expect(ort.env.wasm.simd).toBe(true);
      expect(ort.env.wasm.numThreads).toBe(2);
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(createSpy.mock.calls[0]?.[1]).toEqual({ executionProviders: ['webgpu'] });
      expect(createSpy.mock.calls[1]?.[1]).toEqual({ executionProviders: ['wasm'] });
      expect(result.session).toBe(mockSession);
      expect(result.executionProvider).toBe('wasm');
    });

    it('reports webgpu only when an adapter exists and session creation succeeds', async () => {
      setNavigator({ gpu: { requestAdapter: async () => ({}) } });
      const mockSession = { run: vi.fn() } as unknown as ort.InferenceSession;
      vi.spyOn(ort.InferenceSession, 'create').mockResolvedValueOnce(mockSession);
      const result = await createInferenceSession(new Uint8Array([1]));
      expect(result.executionProvider).toBe('webgpu');
    });

    it('forceWasm skips WebGPU even when a shader-f16 adapter exists (after device loss)', async () => {
      const requestAdapter = vi.fn(async () => ({ features: { has: () => true } }));
      setNavigator({ gpu: { requestAdapter } });
      const mockSession = { run: vi.fn() } as unknown as ort.InferenceSession;
      const createSpy = vi.spyOn(ort.InferenceSession, 'create').mockResolvedValueOnce(mockSession);
      const result = await createInferenceSession(new Uint8Array([1]), { forceWasm: true });
      expect(requestAdapter).not.toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0]?.[1]).toEqual({ executionProviders: ['wasm'] });
      expect(result.executionProvider).toBe('wasm');
    });

    it('skips WebGPU entirely when navigator.gpu has no adapter (headless / blocklisted GPU)', async () => {
      setNavigator({ gpu: { requestAdapter: async () => null } });
      expect(await hasWebGpuAdapter()).toBe(false);
      const mockSession = { run: vi.fn() } as unknown as ort.InferenceSession;
      const createSpy = vi.spyOn(ort.InferenceSession, 'create').mockResolvedValueOnce(mockSession);
      const result = await createInferenceSession(new Uint8Array([1]));
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0]?.[1]).toEqual({ executionProviders: ['wasm'] });
      expect(result.executionProvider).toBe('wasm');
    });
  });

  describe('defaultWasmThreads', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    afterEach(() => {
      delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
      if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    });
    const setEnv = (coi: boolean | undefined, hc: number | undefined) => {
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = coi;
      Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: hc }, configurable: true, writable: true });
    };
    it('leaves ORT single-threaded default alone when not cross-origin isolated', () => {
      setEnv(false, 8);
      expect(defaultWasmThreads()).toBeUndefined();
    });
    it('uses one fewer than the logical cores (at least 1, at most 8) when cross-origin isolated', () => {
      setEnv(true, 4);
      expect(defaultWasmThreads()).toBe(3);
      setEnv(true, 2);
      expect(defaultWasmThreads()).toBe(1);
      setEnv(true, 1);
      expect(defaultWasmThreads()).toBe(1);
      setEnv(true, 32);
      expect(defaultWasmThreads()).toBe(8);
      setEnv(true, undefined);
      expect(defaultWasmThreads()).toBeUndefined();
    });
    it('honours a user thread count, clamped to the available cores', () => {
      setEnv(true, 6);
      expect(wasmThreadsFor(6)).toBe(6);
      expect(wasmThreadsFor(12)).toBe(6);
      expect(wasmThreadsFor(0)).toBe(1);
      expect(wasmThreadsFor('auto')).toBe(5);
      setEnv(false, 6);
      expect(wasmThreadsFor(4)).toBeUndefined();
    });
  });

  describe('assertPlausibleOutput (float16 GPU guard)', () => {
    it('accepts normal Cellpose-range outputs', () => {
      expect(() => assertPlausibleOutput(Float32Array.from([-9.5, 0, 4.2, -30, 25]), 't')).not.toThrow();
    });
    it('rejects NaN, Infinity and implausibly large values', () => {
      for (const bad of [NaN, Infinity, -Infinity, 65504]) {
        expect(() => assertPlausibleOutput(Float32Array.from([0, 1, bad]), 't')).toThrow(NumericInstabilityError);
      }
      expect(() => assertPlausibleOutput(Float32Array.from([0, NaN, NaN]), 'Cellpose-SAM tile')).toThrow(/2 non-finite/);
    });
  });

  describe('WebGPU validation-error watch', () => {
    it('turns an uncaptured WebGPU error during a run into NumericInstabilityError', async () => {
      const listeners: Array<(ev: { error?: { message?: string } }) => void> = [];
      const fakeDevice = { addEventListener: (_t: string, cb: (ev: { error?: { message?: string } }) => void) => listeners.push(cb) };
      const desc = Object.getOwnPropertyDescriptor(ort.env.webgpu, 'device');
      Object.defineProperty(ort.env.webgpu, 'device', { value: fakeDevice, configurable: true });
      try {
        const run = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
          // a shader fails to compile mid-run: WebGPU reports it only as an event
          listeners.forEach((cb) => cb({ error: { message: 'Error while parsing WGSL: f16 not enabled' } }));
          const d = feeds['image']!.dims;
          const n = d[2]! * d[3]!;
          return { flows_cellprob: new ort.Tensor('float32', new Float32Array(3 * n).fill(0.5), [1, 3, d[2]!, d[3]!]) };
        });
        const rgba = new Uint8ClampedArray(4 * 100 * 80).fill(128);
        await expect(
          runCpsamCellposeInference({ run } as unknown as ort.InferenceSession, rgba, 100, 80),
        ).rejects.toThrow(/WebGPU reported 1 error/);
        // healthy run afterwards: no new errors, no throw
        const quiet = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
          const d = feeds['image']!.dims;
          return { flows_cellprob: new ort.Tensor('float32', new Float32Array(3 * d[2]! * d[3]!), [1, 3, d[2]!, d[3]!]) };
        });
        await expect(runCpsamCellposeInference({ run: quiet } as unknown as ort.InferenceSession, rgba, 100, 80)).resolves.toBeDefined();
      } finally {
        if (desc) Object.defineProperty(ort.env.webgpu, 'device', desc);
        else delete (ort.env.webgpu as { device?: unknown }).device;
      }
    });
  });

  describe('resolveWasmPaths', () => {
    afterEach(() => {
      delete (globalThis as { document?: unknown }).document;
    });

    it('resolves relative to the document (page), not the importing module', () => {
      (globalThis as { document?: unknown }).document = { baseURI: 'https://example.org/app/index.html' };
      // Regression: dist/ui/main.js previously resolved './ort/' to /app/ui/ort/ (404).
      expect(resolveWasmPaths('./ort/')).toBe('https://example.org/app/ort/');
    });

    it('leaves absolute URLs and non-browser environments unchanged', () => {
      expect(resolveWasmPaths('https://cdn.example/ort/')).toBe('https://cdn.example/ort/');
      expect(resolveWasmPaths('/ort/')).toBe('/ort/');
      expect(resolveWasmPaths('./ort/')).toBe('./ort/');
    });
  });

  describe('output tensor decoding', () => {
    it('decodes Float32Array and Float16Array output tensor data', async () => {
      const width = 256;
      const height = 256;
      const rgba = new Uint8ClampedArray(width * height * 4).fill(50);

      // Float32Array output
      const outF32 = new Float32Array(3 * 256 * 256);
      outF32.fill(0.75, 0, 256 * 256);
      outF32.fill(-1.25, 256 * 256, 2 * 256 * 256);
      outF32.fill(4.5, 2 * 256 * 256, 3 * 256 * 256);

      const mockF32Session = {
        run: vi.fn(async () => ({
          flows_cellprob: new ort.Tensor('float32', outF32, [1, 3, 256, 256]),
        })),
      } as unknown as ort.InferenceSession;

      const resF32 = await runCpsamCellposeInference(mockF32Session, rgba, width, height);
      expect(resF32.flowY[0]).toBeCloseTo(0.75, 5);
      expect(resF32.flowX[0]).toBeCloseTo(-1.25, 5);
      expect(resF32.cellprob[0]).toBeCloseTo(4.5, 5);

      // Float16Array output (if available in JS runtime)
      if (typeof Float16Array !== 'undefined') {
        const f16Arr = new Float16Array(outF32);
        const mockF16Session = {
          run: vi.fn(async () => ({
            flows_cellprob: { data: f16Arr },
          })),
        } as unknown as ort.InferenceSession;
        const resF16 = await runCpsamCellposeInference(mockF16Session, rgba, width, height);
        expect(resF16.flowY[0]).toBeCloseTo(0.75, 2);
        expect(resF16.flowX[0]).toBeCloseTo(-1.25, 2);
        expect(resF16.cellprob[0]).toBeCloseTo(4.5, 2);
      }
    });

  });

  describe('WebGPU shader-f16 & device.lost hardening', () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const setNavigator = (value: unknown): void => {
      Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
    };

    afterEach(() => {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      const envAny = ort.env as { webgpu?: unknown };
      delete envAny.webgpu;
      vi.restoreAllMocks();
    });

    it('probes shader-f16 capability and skips WebGPU when requireShaderF16 is true and unsupported', async () => {
      setNavigator({
        gpu: {
          requestAdapter: async () => ({
            features: { has: (f: string) => f === 'shader-f16' },
          }),
        },
      });
      expect(await probeWebGpuCapabilities()).toEqual({ hasAdapter: true, hasShaderF16: true });

      const mockGpuSession = { run: vi.fn() } as unknown as ort.InferenceSession;
      const createSpy1 = vi
        .spyOn(ort.InferenceSession, 'create')
        .mockResolvedValueOnce(mockGpuSession);
      const resOk = await createInferenceSession(new Uint8Array([1]), {
        requireShaderF16: true,
      });
      expect(resOk.executionProvider).toBe('webgpu');
      expect(createSpy1.mock.calls[0]?.[1]).toEqual({ executionProviders: ['webgpu'] });

      vi.restoreAllMocks();
      setNavigator({
        gpu: {
          requestAdapter: async () => ({
            features: { has: () => false },
          }),
        },
      });
      expect(await probeWebGpuCapabilities()).toEqual({ hasAdapter: true, hasShaderF16: false });

      const mockWasmSession = { run: vi.fn() } as unknown as ort.InferenceSession;
      const createSpy2 = vi
        .spyOn(ort.InferenceSession, 'create')
        .mockResolvedValueOnce(mockWasmSession);
      const resFallback = await createInferenceSession(new Uint8Array([1]), {
        requireShaderF16: true,
      });
      expect(resFallback.executionProvider).toBe('wasm');
      expect(createSpy2).toHaveBeenCalledTimes(1);
      expect(createSpy2.mock.calls[0]?.[1]).toEqual({ executionProviders: ['wasm'] });
    });

    it('converts WebGPU device-lost errors and ort.env.webgpu.device.lost rejections into WebGpuDeviceLostError', async () => {
      const rgba = new Uint8ClampedArray(16 * 16 * 4).fill(128);
      const mockErrSession = {
        run: vi.fn().mockRejectedValueOnce(new Error('GPUDevice was lost during compute pass')),
      } as unknown as ort.InferenceSession;

      const caught = await runUnetCellposeInference(mockErrSession, rgba, 16, 16).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(WebGpuDeviceLostError);
      expect(isWebGpuDeviceLostError(caught)).toBe(true);

      // Also verify Promise.race against ort.env.webgpu.device.lost
      const envAny = ort.env as { webgpu?: { device?: { lost?: Promise<unknown> } } };
      envAny.webgpu = {
        device: {
          lost: Promise.resolve({ reason: 'destroyed', message: 'Adapter reset' }),
        },
      };
      const hangingSession = {
        run: vi.fn(() => new Promise(() => undefined)),
      } as unknown as ort.InferenceSession;
      await expect(runUnetCellposeInference(hangingSession, rgba, 16, 16)).rejects.toThrow(
        WebGpuDeviceLostError,
      );
    });

    it('does not race a WASM fallback session against an already-lost WebGPU device', async () => {
      const rgba = new Uint8ClampedArray(16 * 16 * 4).fill(128);
      // The page's GPUDevice was lost earlier: its `lost` promise stays resolved forever.
      const envAny = ort.env as { webgpu?: { device?: { lost?: Promise<unknown> } } };
      envAny.webgpu = { device: { lost: Promise.resolve({ reason: 'destroyed', message: 'Adapter reset' }) } };
      const output = new ort.Tensor('float32', new Float32Array(3 * 16 * 16), [1, 3, 16, 16]);
      const wasmSession = {
        run: vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { output };
        }),
        inputNames: ['image'],
        outputNames: ['output'],
      } as unknown as ort.InferenceSession;
      vi.spyOn(ort.InferenceSession, 'create').mockResolvedValueOnce(wasmSession);
      const created = await createInferenceSession(new Uint8Array([1]), { forceWasm: true });
      expect(created.executionProvider).toBe('wasm');
      const caught = await runUnetCellposeInference(created.session, rgba, 16, 16).catch((e: unknown) => e);
      expect(caught).not.toBeInstanceOf(WebGpuDeviceLostError);
      expect(wasmSession.run).toHaveBeenCalledTimes(1);
    });
  });
});
