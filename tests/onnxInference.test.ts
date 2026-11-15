import * as ort from 'onnxruntime-web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInferenceSession,
  probeWebGpuCapabilities,
  hasWebGpuAdapter,
  WebGpuDeviceLostError,
  isWebGpuDeviceLostError,
  resolveWasmPaths,
  float16BitsToFloat32Array,
  float16ToFloat32,
  float32ArrayToFloat16Bits,
  float32ToFloat16,
  makeBlendWindow,
  reflectIndex,
  runCpsamTiledInference,
  runUnetInference,
  tileStarts,
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

  describe('geometry and Hanning window helpers', () => {
    it('reflectIndex matches numpy.pad(..., mode="reflect")', () => {
      // length = 4 -> [0, 1, 2, 3]
      expect(reflectIndex(-2, 4)).toBe(2);
      expect(reflectIndex(-1, 4)).toBe(1);
      expect(reflectIndex(0, 4)).toBe(0);
      expect(reflectIndex(3, 4)).toBe(3);
      expect(reflectIndex(4, 4)).toBe(2);
      expect(reflectIndex(5, 4)).toBe(1);
      expect(reflectIndex(6, 4)).toBe(0);
      expect(reflectIndex(10, 1)).toBe(0);
    });

    it('tileStarts computes exact tile start positions', () => {
      expect(tileStarts(200, 256, 192)).toEqual([0]);
      expect(tileStarts(256, 256, 192)).toEqual([0]);
      expect(tileStarts(448, 256, 192)).toEqual([0, 192]);
      expect(tileStarts(500, 256, 192)).toEqual([0, 192, 244]);
    });

    it('makeBlendWindow produces symmetric 2D clipped Hanning taper', () => {
      const win256 = makeBlendWindow(256);
      expect(win256.length).toBe(256 * 256);
      // Corners: 1e-3 * 1e-3 = 1e-6
      expect(win256[0]).toBeCloseTo(1e-6, 9);
      expect(win256[255]).toBeCloseTo(1e-6, 9);
      expect(win256[255 * 256]).toBeCloseTo(1e-6, 9);
      expect(win256[255 * 256 + 255]).toBeCloseTo(1e-6, 9);
      // Edge center: 1e-3 * ~1.0
      expect(win256[127]).toBeCloseTo(1e-3, 5);
      // Symmetry
      expect(win256[40 * 256 + 70]).toBeCloseTo(win256[70 * 256 + 40]!, 6);
      expect(win256[40 * 256 + 70]).toBeCloseTo(win256[215 * 256 + 185]!, 6);

      // Odd tileSize has exact peak 1.0 at center
      const win255 = makeBlendWindow(255);
      expect(win255[127 * 255 + 127]).toBeCloseTo(1.0, 6);
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

  describe('runUnetInference', () => {
    it('reflection-pads to multiples of 16, sets ch1=0, and crops output to original dimensions', async () => {
      const width = 20;
      const height = 18;
      // Expected padded dims: wPad = 32, hPad = 32
      const normalizedGray = new Float32Array(width * height);
      for (let i = 0; i < normalizedGray.length; i++) {
        normalizedGray[i] = i / 100;
      }

      const runMock = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
        const imgTensor = feeds['image']!;
        expect(imgTensor.type).toBe('float32');
        expect(imgTensor.dims).toEqual([1, 2, 32, 32]);
        const inData = imgTensor.data as Float32Array;

        // Verify channel 0 reflection padding at (y=18, x=0) -> reflects to y=16
        expect(inData[18 * 32 + 0]).toBeCloseTo(normalizedGray[16 * width + 0]!, 6);
        // Verify channel 1 is all zeros
        const ch1Offset = 32 * 32;
        for (let i = 0; i < ch1Offset; i++) {
          expect(inData[ch1Offset + i]).toBe(0);
        }

        const outData = new Float32Array(3 * 32 * 32);
        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 32; x++) {
            outData[0 * 1024 + y * 32 + x] = y + 0.1;
            outData[1 * 1024 + y * 32 + x] = x + 0.2;
            outData[2 * 1024 + y * 32 + x] = (y * 32 + x) * 0.01;
          }
        }
        return {
          flows_cellprob: new ort.Tensor('float32', outData, [1, 3, 32, 32]),
        };
      });

      const mockSession = { run: runMock } as unknown as ort.InferenceSession;
      const out = await runUnetInference(mockSession, normalizedGray, width, height);

      expect(runMock).toHaveBeenCalledTimes(1);
      expect(out.width).toBe(width);
      expect(out.height).toBe(height);
      expect(out.flowY.length).toBe(width * height);
      expect(out.flowX.length).toBe(width * height);
      expect(out.cellprob.length).toBe(width * height);
      expect(out.flowY[17 * width + 19]).toBeCloseTo(17.1, 5);
      expect(out.flowX[17 * width + 19]).toBeCloseTo(19.2, 5);
    });

    it('reflection-pads images smaller than 16x16 (5x7 -> 16x16) and crops back', async () => {
      const width = 5;
      const height = 7;
      const normalizedGray = new Float32Array(width * height);
      for (let i = 0; i < normalizedGray.length; i++) {
        normalizedGray[i] = i * 0.1;
      }

      const runMock = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
        const imgTensor = feeds['image']!;
        expect(imgTensor.dims).toEqual([1, 2, 16, 16]);
        const inData = imgTensor.data as Float32Array;
        // Reflect check: x=5 -> reflectIndex(5, 5) = 3; y=7 -> reflectIndex(7, 7) = 5
        expect(inData[0 * 16 + 5]).toBeCloseTo(normalizedGray[0 * width + 3]!, 6);
        expect(inData[7 * 16 + 0]).toBeCloseTo(normalizedGray[5 * width + 0]!, 6);

        const outData = new Float32Array(3 * 16 * 16);
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            outData[0 * 256 + y * 16 + x] = y;
            outData[1 * 256 + y * 16 + x] = x;
            outData[2 * 256 + y * 16 + x] = y * 10 + x;
          }
        }
        return {
          flows_cellprob: new ort.Tensor('float32', outData, [1, 3, 16, 16]),
        };
      });

      const mockSession = { run: runMock } as unknown as ort.InferenceSession;
      const out = await runUnetInference(mockSession, normalizedGray, width, height);
      expect(out.width).toBe(5);
      expect(out.height).toBe(7);
      expect(out.flowY.length).toBe(35);
      expect(out.flowY[6 * 5 + 4]).toBeCloseTo(6, 5);
      expect(out.flowX[6 * 5 + 4]).toBeCloseTo(4, 5);
      expect(out.cellprob[6 * 5 + 4]).toBeCloseTo(64, 5);
    });

    it('throws RangeError on invalid dimensions', async () => {
      const mockSession = { run: vi.fn() } as unknown as ort.InferenceSession;
      await expect(
        runUnetInference(mockSession, new Float32Array(0), 0, 16),
      ).rejects.toThrow(RangeError);
      await expect(
        runUnetInference(mockSession, new Float32Array(16), -4, 4),
      ).rejects.toThrow(RangeError);
      await expect(
        runUnetInference(mockSession, new Float32Array(16), 4.5, 4),
      ).rejects.toThrow(RangeError);
    });
  });

  describe('runCpsamTiledInference', () => {
    it('uses fast path for exact 256x256 inputs without tiling', async () => {
      const width = 256;
      const height = 256;
      const rgb = new Float32Array(width * height * 3);
      for (let i = 0; i < rgb.length; i++) {
        rgb[i] = (i % 256) / 255;
      }

      const runMock = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
        const imgTensor = feeds['image']!;
        expect(imgTensor.type).toBe('float16');
        expect(imgTensor.dims).toEqual([1, 3, 256, 256]);

        const outF32 = new Float32Array(3 * 256 * 256);
        outF32.fill(1.5, 0, 256 * 256);
        outF32.fill(-0.5, 256 * 256, 2 * 256 * 256);
        outF32.fill(2.0, 2 * 256 * 256, 3 * 256 * 256);
        const outU16 = float32ArrayToFloat16Bits(outF32);
        return {
          flows_cellprob: new ort.Tensor('float16', outU16, [1, 3, 256, 256]),
        };
      });

      const progressEvents: number[] = [];
      const mockSession = { run: runMock } as unknown as ort.InferenceSession;
      const out = await runCpsamTiledInference(mockSession, rgb, width, height, {
        onProgress: (p) => progressEvents.push(p.percent),
      });

      expect(runMock).toHaveBeenCalledTimes(1);
      expect(progressEvents).toEqual([100]);
      expect(out.flowY[0]).toBeCloseTo(1.5, 3);
      expect(out.flowX[0]).toBeCloseTo(-0.5, 3);
      expect(out.cellprob[0]).toBeCloseTo(2.0, 3);
    });

    it('stitches overlapping tiles with Hanning blend and reports progress', async () => {
      const width = 300;
      const height = 280;
      // With tileSize=256, stride=192: xs=[0, 44], ys=[0, 24] -> 4 tiles
      const rgb = new Float32Array(width * height * 3).fill(0.5);

      const runMock = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
        const imgTensor = feeds['image']!;
        const b = imgTensor.dims[0]!;
        expect(b).toBe(4);
        expect(imgTensor.dims).toEqual([4, 3, 256, 256]);

        const outF32 = new Float32Array(b * 3 * 256 * 256);
        for (let t = 0; t < b; t++) {
          const base = t * 3 * 256 * 256;
          outF32.fill(0.25, base, base + 256 * 256);
          outF32.fill(-0.75, base + 256 * 256, base + 2 * 256 * 256);
          outF32.fill(3.0, base + 2 * 256 * 256, base + 3 * 256 * 256);
        }
        return {
          flows_cellprob: new ort.Tensor(
            'float16',
            float32ArrayToFloat16Bits(outF32),
            [b, 3, 256, 256],
          ),
        };
      });

      const progressList: Array<{ completedTiles: number; totalTiles: number; percent: number }> = [];
      const mockSession = { run: runMock } as unknown as ort.InferenceSession;
      const out = await runCpsamTiledInference(mockSession, rgb, width, height, {
        onProgress: (p) => progressList.push(p),
      });

      expect(runMock).toHaveBeenCalledTimes(1);
      expect(progressList).toEqual([{ completedTiles: 4, totalTiles: 4, percent: 100 }]);
      expect(out.width).toBe(width);
      expect(out.height).toBe(height);
      expect(out.flowY[100 * width + 150]).toBeCloseTo(0.25, 3);
      expect(out.flowX[100 * width + 150]).toBeCloseTo(-0.75, 3);
      expect(out.cellprob[100 * width + 150]).toBeCloseTo(3.0, 3);
    });

    it('throws AbortError on pre-aborted and mid-aborted AbortSignal', async () => {
      const rgbSmall = new Float32Array(256 * 256 * 3);
      const mockSession = { run: vi.fn() } as unknown as ort.InferenceSession;

      const preController = new AbortController();
      preController.abort();
      await expect(
        runCpsamTiledInference(mockSession, rgbSmall, 256, 256, {
          signal: preController.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });

      // Mid-abort: 900x900 -> 5x5 = 25 tiles -> 2 batches (16 + 9)
      const width = 900;
      const height = 900;
      const rgbLarge = new Float32Array(width * height * 3);
      const midController = new AbortController();

      const runMock = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
        const b = feeds['image']!.dims[0]!;
        midController.abort();
        const outF32 = new Float32Array(b * 3 * 256 * 256);
        return {
          flows_cellprob: new ort.Tensor(
            'float16',
            float32ArrayToFloat16Bits(outF32),
            [b, 3, 256, 256],
          ),
        };
      });

      await expect(
        runCpsamTiledInference(
          { run: runMock } as unknown as ort.InferenceSession,
          rgbLarge,
          width,
          height,
          { signal: midController.signal },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(runMock).toHaveBeenCalledTimes(1);
    });

    it('reflection-pads sub-256x256 images (100x120 -> 256x256) and crops back', async () => {
      const width = 100;
      const height = 120;
      const rgb = new Float32Array(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = (y * width + x) * 3;
          rgb[p] = x / 100;
          rgb[p + 1] = y / 120;
          rgb[p + 2] = 0.5;
        }
      }

      const runMock = vi.fn(async (feeds: Record<string, ort.Tensor>) => {
        const imgTensor = feeds['image']!;
        expect(imgTensor.dims).toEqual([1, 3, 256, 256]);
        // Verify reflection at x=100 -> reflectIndex(100, 100) = 98
        const reflectedVal =
          imgTensor.data instanceof Uint16Array
            ? float16ToFloat32(imgTensor.data[0 * 256 + 100]!)
            : Number((imgTensor.data as ArrayLike<number>)[0 * 256 + 100]!);
        expect(reflectedVal).toBeCloseTo(rgb[98 * 3]!, 2);

        const outF32 = new Float32Array(3 * 256 * 256);
        outF32.fill(0.5, 0, 256 * 256);
        outF32.fill(-0.25, 256 * 256, 2 * 256 * 256);
        outF32.fill(1.25, 2 * 256 * 256, 3 * 256 * 256);
        return {
          flows_cellprob: new ort.Tensor(
            'float16',
            float32ArrayToFloat16Bits(outF32),
            [1, 3, 256, 256],
          ),
        };
      });

      const mockSession = { run: runMock } as unknown as ort.InferenceSession;
      const out = await runCpsamTiledInference(mockSession, rgb, width, height);
      expect(runMock).toHaveBeenCalledTimes(1);
      expect(out.width).toBe(100);
      expect(out.height).toBe(120);
      expect(out.flowY.length).toBe(12000);
      expect(out.flowY[119 * 100 + 99]).toBeCloseTo(0.5, 3);
      expect(out.flowX[119 * 100 + 99]).toBeCloseTo(-0.25, 3);
      expect(out.cellprob[119 * 100 + 99]).toBeCloseTo(1.25, 3);
    });

    it('decodes Float32Array and Float16Array output tensor data', async () => {
      const width = 256;
      const height = 256;
      const rgb = new Float32Array(width * height * 3).fill(0.2);

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

      const resF32 = await runCpsamTiledInference(mockF32Session, rgb, width, height);
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
        const resF16 = await runCpsamTiledInference(mockF16Session, rgb, width, height);
        expect(resF16.flowY[0]).toBeCloseTo(0.75, 2);
        expect(resF16.flowX[0]).toBeCloseTo(-1.25, 2);
        expect(resF16.cellprob[0]).toBeCloseTo(4.5, 2);
      }
    });

    it('throws RangeError on invalid dimensions', async () => {
      const mockSession = { run: vi.fn() } as unknown as ort.InferenceSession;
      await expect(
        runCpsamTiledInference(mockSession, new Float32Array(0), 0, 256),
      ).rejects.toThrow(RangeError);
      await expect(
        runCpsamTiledInference(mockSession, new Float32Array(12), -2, 2),
      ).rejects.toThrow(RangeError);
      await expect(
        runCpsamTiledInference(mockSession, new Float32Array(12), 2, 2.5),
      ).rejects.toThrow(RangeError);
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
      const gray = new Float32Array(16 * 16).fill(0.5);
      const mockErrSession = {
        run: vi.fn().mockRejectedValueOnce(new Error('GPUDevice was lost during compute pass')),
      } as unknown as ort.InferenceSession;

      const caught = await runUnetInference(mockErrSession, gray, 16, 16).catch((e) => e);
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
      await expect(runUnetInference(hangingSession, gray, 16, 16)).rejects.toThrow(
        WebGpuDeviceLostError,
      );
    });
  });
});
