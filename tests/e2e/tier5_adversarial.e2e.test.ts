import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as ort from 'onnxruntime-web';
import {
  downloadModel,
  getModel,
  getCachedModels,
  checkStorageQuota,
  applyCLAHE,
  prepareWorkingImage,
  recommendModel,
  normalizeGray,
  normalizeRgbJoint99,
  float32ToFloat16,
  float16ToFloat32,
  makeBlendWindow,
  runUnetInference,
  runCpsamTiledInference,
  multigridJacobiHeat,
  evaluateGrainFlowQcV4,
  trySplitDumbbellV4,
  computeGrainMorphometrics,
  flowsToMasksBrowser,
  splitGrainAtLine,
  addPolygonGrain,
  MaskEditHistory,
  computeFolkWardStats,
  exportInstanceMaskPng,
  exportGeoJsonContours,
  ImageGrainsEngine,
} from '../../src/index.js';
import type {
  ModelId,
  ModelKind,
  PsdPercentiles,
  WorkerRequest,
  WorkerResponse,
} from '../../src/types/index.js';
import {
  setupBrowserMocks,
  teardownBrowserMocks,
  createMockFetch,
  createMockOnnxSession,
} from './helpers/mocks.js';
import {
  createFlatImage,
  createUniformGravelImage,
  createIsolatedEllipsesFlowField,
} from './helpers/syntheticData.js';

function createZeroMask(width: number, height: number): Int32Array {
  return new Int32Array(width * height);
}

function paintRect(
  masks: Int32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  id: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      masks[y * width + x] = id;
    }
  }
}

describe('Tier 5: Adversarial Hardening — ImageGrains 2.0 Web', () => {
  beforeEach(() => {
    setupBrowserMocks();
  });

  afterEach(() => {
    teardownBrowserMocks();
  });

  // =========================================================================
  // 1. ModelCache Adversarial Cases
  // =========================================================================
  describe('ModelCache Adversarial', () => {
    it('rejects truncated stream (loadedBytes < Content-Length) without poisoning IDB', async () => {
      const partial = new Uint8Array(1024).fill(7);
      globalThis.fetch = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(partial);
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Length': '4096' },
        });
      }) as unknown as typeof fetch;

      await expect(downloadModel('ig2_unet_fp32')).rejects.toThrow(/Truncated download/i);
      const cached = await getCachedModels();
      expect(cached).toHaveLength(0);
    });

    it('throws RangeError for invalid modelId in both downloadModel and getModel', async () => {
      const badId = 'nonexistent_model' as unknown as ModelId;
      await expect(downloadModel(badId)).rejects.toThrow(RangeError);
      await expect(getModel(badId)).rejects.toThrow(RangeError);
    });

    it('ignores 0-byte and null corrupted IDB records in getModel and re-downloads', async () => {
      const freshBytes = new Uint8Array(256).fill(42);
      globalThis.fetch = createMockFetch({ payloadBytes: freshBytes, chunkSize: 128 });

      const backing = (globalThis.indexedDB as unknown as {
        backingStore: Map<string, Map<string, unknown>>;
      }).backingStore;
      const store = new Map<string, unknown>();
      store.set('ig2_unet_fp32', {
        modelId: 'ig2_unet_fp32',
        fileName: 'ig2_unet_fp32.onnx',
        sizeBytes: 0,
        cachedAt: Date.now(),
        data: new ArrayBuffer(0),
      });
      backing.set('models', store);

      const res1 = await getModel('ig2_unet_fp32');
      expect(res1.byteLength).toBe(256);
      expect(new Uint8Array(res1)[0]).toBe(42);

      // Now corrupt with null data
      store.set('ig2_unet_fp32', {
        modelId: 'ig2_unet_fp32',
        fileName: 'ig2_unet_fp32.onnx',
        sizeBytes: 10,
        cachedAt: Date.now(),
        data: null,
      });

      const res2 = await getModel('ig2_unet_fp32');
      expect(res2.byteLength).toBe(256);
    });

    it('aborts during !response.body arrayBuffer() fallback', async () => {
      const ac = new AbortController();
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Length': '64' }),
        body: null,
        arrayBuffer: async () => {
          ac.abort();
          return new ArrayBuffer(64);
        },
      })) as unknown as typeof fetch;

      await expect(
        downloadModel('ig2_unet_fp32', { signal: ac.signal }),
      ).rejects.toThrow(/abort/i);
    });

    it('releases ReadableStream reader lock when reader.read() rejects mid-stream', async () => {
      let streamRef: ReadableStream<Uint8Array> | null = null;
      globalThis.fetch = vi.fn(async () => {
        let count = 0;
        streamRef = new ReadableStream<Uint8Array>({
          pull(controller) {
            count++;
            if (count === 1) {
              controller.enqueue(new Uint8Array(64).fill(1));
            } else {
              controller.error(new Error('network reset mid-stream'));
            }
          },
        });
        return new Response(streamRef, {
          status: 200,
          headers: { 'Content-Length': '512' },
        });
      }) as unknown as typeof fetch;

      await expect(downloadModel('ig2_unet_fp32')).rejects.toThrow(/network reset mid-stream/);
      expect(streamRef).not.toBeNull();
      expect(streamRef!.locked).toBe(false);
    });

    it('preserves custom Error abort reason', async () => {
      const ac = new AbortController();
      const customErr = new Error('user-cancelled-custom-reason');
      ac.abort(customErr);

      await expect(
        downloadModel('ig2_unet_fp32', { signal: ac.signal }),
      ).rejects.toBe(customErr);
    });

    it('handles IDB onblocked and tx.onabort with NS_ERROR_DOM_QUOTA_REACHED', async () => {
      const origIdb = globalThis.indexedDB;

      // 1. onblocked
      globalThis.indexedDB = {
        open: () => {
          const req: Record<string, unknown> = {
            onupgradeneeded: null,
            onerror: null,
            onblocked: null,
            onsuccess: null,
          };
          queueMicrotask(() => {
            (req['onblocked'] as (() => void) | null)?.();
          });
          return req;
        },
      } as unknown as IDBFactory;

      await expect(getCachedModels()).rejects.toThrow(/blocked/i);

      // 2. tx.onabort with NS_ERROR_DOM_QUOTA_REACHED
      globalThis.indexedDB = {
        open: () => {
          const req: Record<string, unknown> = {
            result: null,
            onupgradeneeded: null,
            onerror: null,
            onblocked: null,
            onsuccess: null,
          };
          queueMicrotask(() => {
            const db = {
              objectStoreNames: { contains: () => true },
              close: () => {},
              transaction: () => {
                const quotaErr = new Error('NS_ERROR_DOM_QUOTA_REACHED');
                quotaErr.name = 'NS_ERROR_DOM_QUOTA_REACHED';
                const tx: Record<string, unknown> = {
                  error: quotaErr,
                  oncomplete: null,
                  onerror: null,
                  onabort: null,
                  objectStore: () => ({
                    put: () => {
                      const putReq: Record<string, unknown> = {
                        onsuccess: null,
                        onerror: null,
                      };
                      queueMicrotask(() => {
                        (tx['onabort'] as (() => void) | null)?.();
                      });
                      return putReq;
                    },
                  }),
                };
                return tx;
              },
            };
            req['result'] = db;
            (req['onsuccess'] as (() => void) | null)?.();
          });
          return req;
        },
      } as unknown as IDBFactory;

      globalThis.fetch = createMockFetch({
        payloadBytes: new Uint8Array(64).fill(9),
        chunkSize: 64,
      });

      await expect(downloadModel('ig2_unet_fp32', { requireCache: true })).rejects.toThrow(/QuotaExceededError/);
      globalThis.indexedDB = origIdb;
    });

    it('clamps availableBytes to 0 when usage > quota in checkStorageQuota', async () => {
      Object.defineProperty(globalThis.navigator, 'storage', {
        configurable: true,
        value: {
          estimate: async () => ({ usage: 5000, quota: 1000 }),
        },
      });
      const quota = await checkStorageQuota();
      expect(quota).not.toBeNull();
      expect(quota!.availableBytes).toBe(0);
    });
  });

  // =========================================================================
  // 2. ImagePreprocess Adversarial Cases
  // =========================================================================
  describe('ImagePreprocess Adversarial', () => {
    it('handles extreme aspect ratios (5000x1, 1x5000, and 2x2 at 0.25x)', () => {
      const wide = createFlatImage(5000, 1, 100);
      const resWide = prepareWorkingImage(wide.data, wide.width, wide.height, 'auto');
      expect(resWide.width).toBe(1024);
      expect(resWide.height).toBeGreaterThanOrEqual(1);
      expect(resWide.data.length).toBe(resWide.width * resWide.height * 4);

      const tall = createFlatImage(1, 5000, 100);
      const resTall = prepareWorkingImage(tall.data, tall.width, tall.height, 'auto');
      expect(resTall.height).toBe(1024);
      expect(resTall.width).toBeGreaterThanOrEqual(1);
      expect(resTall.data.length).toBe(resTall.width * resTall.height * 4);

      const tiny = createFlatImage(2, 2, 50);
      const resTiny = prepareWorkingImage(tiny.data, tiny.width, tiny.height, '0.25x');
      expect(resTiny.width).toBeGreaterThanOrEqual(1);
      expect(resTiny.height).toBeGreaterThanOrEqual(1);
      expect(resTiny.data.length).toBe(resTiny.width * resTiny.height * 4);
    });

    it('applyCLAHE handles 1x100, 100x1, 1x1, saturated (255,0,0), and 16x16 checkerboard', () => {
      const stripV = createUniformGravelImage(1, 100);
      expect(applyCLAHE(stripV).data.length).toBe(1 * 100 * 4);

      const stripH = createUniformGravelImage(100, 1);
      expect(applyCLAHE(stripH).data.length).toBe(100 * 1 * 4);

      const single = createFlatImage(1, 1, 128);
      expect(applyCLAHE(single).data.length).toBe(4);

      const saturatedData = new Uint8ClampedArray(16 * 16 * 4);
      for (let i = 0; i < 16 * 16; i++) {
        saturatedData[i * 4] = 255;
        saturatedData[i * 4 + 3] = 255;
      }
      const satOut = applyCLAHE({ data: saturatedData, width: 16, height: 16 });
      expect(satOut.data.length).toBe(16 * 16 * 4);

      const checker = new Uint8ClampedArray(16 * 16 * 4);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const v = (x + y) % 2 === 0 ? 0 : 255;
          const idx = (y * 16 + x) * 4;
          checker[idx] = v;
          checker[idx + 1] = v;
          checker[idx + 2] = v;
          checker[idx + 3] = 255;
        }
      }
      const chkOut = applyCLAHE({ data: checker, width: 16, height: 16 });
      expect(chkOut.data.length).toBe(16 * 16 * 4);
      for (let i = 0; i < chkOut.data.length; i++) {
        expect(Number.isFinite(chkOut.data[i]!)).toBe(true);
      }
    });

    it('recommendModel handles 1x1, 2x2, 300x3, flat 0/128/255, and deviceMemoryGB: 0 / NaN', () => {
      for (const [w, h, val] of [
        [1, 1, 0],
        [2, 2, 128],
        [300, 3, 255],
      ] as const) {
        const img = createFlatImage(w, h, val);
        const recZero = recommendModel(img.data, w, h, {
          hasWebGPU: true,
          deviceMemoryGB: 0,
        });
        expect(['unet', 'cpsam']).toContain(recZero.model);
        expect(Number.isFinite(recZero.confidence)).toBe(true);
        expect(recZero.rationale.length).toBeGreaterThan(0);

        const recNaN = recommendModel(img.data, w, h, {
          hasWebGPU: false,
          deviceMemoryGB: Number.NaN,
        });
        expect(['unet', 'cpsam']).toContain(recNaN.model);
        expect(Number.isFinite(recNaN.confidence)).toBe(true);
      }
    });

    it('normalizeGray and normalizeRgbJoint99 handle 1x1 images without NaN', () => {
      const px = createFlatImage(1, 1, 120);
      const gray = normalizeGray(px.data, 1, 1);
      expect(gray.length).toBe(1);
      expect(Number.isFinite(gray[0]!)).toBe(true);

      const rgb = normalizeRgbJoint99(px.data, 1, 1);
      expect(rgb.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        expect(Number.isFinite(rgb[i]!)).toBe(true);
      }
    });
  });

  // =========================================================================
  // 3. OnnxInference Adversarial Cases
  // =========================================================================
  describe('OnnxInference Adversarial', () => {
    it('checks AbortSignal immediately after session.run() on 256x256 fast path and 300x300 tiled path', async () => {
      const ac1 = new AbortController();
      const fastSession = {
        run: vi.fn(async () => {
          ac1.abort(new Error('aborted-in-fast-run'));
          return {
            flows_cellprob: new ort.Tensor(
              'float32',
              new Float32Array(3 * 256 * 256),
              [1, 3, 256, 256],
            ),
          };
        }),
      } as unknown as ort.InferenceSession;

      await expect(
        runCpsamTiledInference(fastSession, new Float32Array(256 * 256 * 3), 256, 256, {
          signal: ac1.signal,
        }),
      ).rejects.toThrow('aborted-in-fast-run');

      const ac2 = new AbortController();
      const tiledSession = {
        run: vi.fn(async () => {
          ac2.abort(new Error('aborted-in-tiled-run'));
          return {
            flows_cellprob: new ort.Tensor(
              'float32',
              new Float32Array(4 * 3 * 256 * 256),
              [4, 3, 256, 256],
            ),
          };
        }),
      } as unknown as ort.InferenceSession;

      await expect(
        runCpsamTiledInference(tiledSession, new Float32Array(300 * 300 * 3), 300, 300, {
          signal: ac2.signal,
        }),
      ).rejects.toThrow('aborted-in-tiled-run');
    });

    it('makeBlendWindow throws RangeError for NaN, 0, -4, and non-integer values', () => {
      expect(() => makeBlendWindow(Number.NaN)).toThrow(RangeError);
      expect(() => makeBlendWindow(0)).toThrow(RangeError);
      expect(() => makeBlendWindow(-4)).toThrow(RangeError);
      expect(() => makeBlendWindow(1.5)).toThrow(RangeError);
    });

    it('handles FP16 subnormal-to-normal carry, tie-to-even, sNaN preservation, and -0', () => {
      // 2^-14 - 2^-25 carries up to smallest normal 2^-14 (0x0400)
      const carry = float32ToFloat16(2 ** -14 - 2 ** -25);
      expect(carry).toBe(0x0400);

      // 2^-25 is halfway between 0x0000 (even) and 0x0001 (odd) -> tie-to-even => 0x0000
      const tieEvenDown = float32ToFloat16(2 ** -25);
      expect(tieEvenDown).toBe(0x0000);

      // 3 * 2^-25 is halfway between 0x0001 (odd) and 0x0002 (even) -> tie-to-even => 0x0002
      const tieEvenUp = float32ToFloat16(3 * 2 ** -25);
      expect(tieEvenUp).toBe(0x0002);

      // -0 preserves sign bit
      const negZeroBits = float32ToFloat16(-0);
      expect(negZeroBits).toBe(0x8000);
      expect(Object.is(float16ToFloat32(0x8000), -0)).toBe(true);

      // sNaN (exponent 0x7c00, non-zero payload) stays NaN
      const sNanFloat = (() => {
        const buf = new ArrayBuffer(4);
        const dv = new DataView(buf);
        dv.setUint32(0, 0x7f800001, false);
        return dv.getFloat32(0, false);
      })();
      const fp16Nan = float32ToFloat16(sNanFloat);
      expect((fp16Nan & 0x7fff) > 0x7c00).toBe(true);
      expect(Number.isNaN(float16ToFloat32(fp16Nan))).toBe(true);
    });

    it('validates invalid lengths, missing flows_cellprob, overlap >= tileSize, 1x300/300x1, and 16 vs 17 tile batch boundary', async () => {
      const mockSession = createMockOnnxSession({ mode: 'unet' });

      await expect(
        runUnetInference(mockSession, new Float32Array(5), 4, 4),
      ).rejects.toThrow(RangeError);

      await expect(
        runCpsamTiledInference(mockSession, new Float32Array(10), 4, 4),
      ).rejects.toThrow(RangeError);

      await expect(
        runCpsamTiledInference(mockSession, new Float32Array(16 * 16 * 3), 16, 16, {
          tileSize: 16,
          overlap: 16,
        }),
      ).rejects.toThrow(RangeError);

      const missingOutSession = {
        run: vi.fn(async () => ({})),
      } as unknown as ort.InferenceSession;

      await expect(
        runUnetInference(missingOutSession, new Float32Array(16), 4, 4),
      ).rejects.toThrow(/flows_cellprob/);

      await expect(
        runCpsamTiledInference(missingOutSession, new Float32Array(16 * 16 * 3), 16, 16, {
          tileSize: 16,
          overlap: 4,
        }),
      ).rejects.toThrow(/flows_cellprob/);

      // 1x300 and 300x1 with custom small tileSize
      const cpsamSession = createMockOnnxSession({ mode: 'cpsam' });
      const res1x300 = await runCpsamTiledInference(
        cpsamSession,
        new Float32Array(1 * 300 * 3),
        1,
        300,
      );
      expect(res1x300.width).toBe(1);
      expect(res1x300.height).toBe(300);

      const res300x1 = await runCpsamTiledInference(
        cpsamSession,
        new Float32Array(300 * 1 * 3),
        300,
        1,
      );
      expect(res300x1.width).toBe(300);
      expect(res300x1.height).toBe(1);

      // 16 vs 17 tile batch boundary (tileSize=32, overlap=8 => stride=24)
      // width = 32 + 15*24 = 392 -> 16 tiles -> 1 batch call
      // width = 393 -> 17 tiles -> 2 batch calls (16 + 1)
      let runCalls16 = 0;
      const batchCountSession = (onCall: () => void) =>
        ({
          run: vi.fn(async (feeds: Record<string, ort.Tensor>) => {
            onCall();
            const b = feeds['image']!.dims[0]!;
            return {
              flows_cellprob: new ort.Tensor(
                'float32',
                new Float32Array(b * 3 * 32 * 32),
                [b, 3, 32, 32],
              ),
            };
          }),
        }) as unknown as ort.InferenceSession;

      await runCpsamTiledInference(
        batchCountSession(() => {
          runCalls16++;
        }),
        new Float32Array(392 * 1 * 3),
        392,
        1,
        { tileSize: 32, overlap: 8 },
      );
      expect(runCalls16).toBe(1);

      let runCalls17 = 0;
      await runCpsamTiledInference(
        batchCountSession(() => {
          runCalls17++;
        }),
        new Float32Array(393 * 1 * 3),
        393,
        1,
        { tileSize: 32, overlap: 8 },
      );
      expect(runCalls17).toBe(2);
    });
  });

  // =========================================================================
  // 4. PipelineController Adversarial Cases
  // =========================================================================
  describe('PipelineController Adversarial', () => {
    it('rejects in-flight worker post-processing immediately when dispose() is called', async () => {
      const hangingWorker = {
        listeners: new Map<string, Set<(ev: unknown) => void>>(),
        addEventListener(type: string, fn: (ev: unknown) => void) {
          let set = this.listeners.get(type);
          if (!set) {
            set = new Set();
            this.listeners.set(type, set);
          }
          set.add(fn);
        },
        removeEventListener(type: string, fn: (ev: unknown) => void) {
          this.listeners.get(type)?.delete(fn);
        },
        postMessage: vi.fn(),
        terminate: vi.fn(),
      };

      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) =>
          createMockOnnxSession({ mode: kind }),
        workerFactory: () => hangingWorker as unknown as Worker,
      });

      const imgData = createUniformGravelImage(32, 32);

      const analysisPromise = engine.analyzeImage(imgData, { inferencePipeline: 'legacy', model: 'unet' });

      // Wait until worker.postMessage has been called
      await vi.waitFor(() => {
        expect(hangingWorker.postMessage).toHaveBeenCalledTimes(1);
      });

      await engine.dispose();
      await expect(analysisPromise).rejects.toThrow(/disposed/i);
    });

    it('recovers from worker error event on subsequent analyzeImage() call', async () => {
      let workerNum = 0;
      const workerFactory = () => {
        workerNum++;
        if (workerNum === 1) {
          const listeners = new Map<string, Set<(ev: unknown) => void>>();
          return {
            addEventListener(type: string, fn: (ev: unknown) => void) {
              let set = listeners.get(type);
              if (!set) {
                set = new Set();
                listeners.set(type, set);
              }
              set.add(fn);
            },
            removeEventListener(type: string, fn: (ev: unknown) => void) {
              listeners.get(type)?.delete(fn);
            },
            postMessage: () => {
              queueMicrotask(() => {
                const errs = listeners.get('error');
                if (errs) {
                  for (const fn of Array.from(errs)) {
                    fn({ message: 'simulated worker crash' });
                  }
                }
              });
            },
            terminate: vi.fn(),
          } as unknown as Worker;
        }
        const listeners = new Map<string, Set<(ev: unknown) => void>>();
        return {
          addEventListener(type: string, fn: (ev: unknown) => void) {
            let set = listeners.get(type);
            if (!set) {
              set = new Set();
              listeners.set(type, set);
            }
            set.add(fn);
          },
          removeEventListener(type: string, fn: (ev: unknown) => void) {
            listeners.get(type)?.delete(fn);
          },
          postMessage: (req: WorkerRequest) => {
            queueMicrotask(() => {
              const result = flowsToMasksBrowser(
                req.flowY,
                req.flowX,
                req.cellprob,
                req.width,
                req.height,
                req.options,
              );
              const msgs = listeners.get('message');
              if (msgs) {
                for (const fn of Array.from(msgs)) {
                  fn({
                    data: {
                      type: 'result',
                      requestId: req.requestId,
                      result,
                    },
                  });
                }
              }
            });
          },
          terminate: vi.fn(),
        } as unknown as Worker;
      };

      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) =>
          createMockOnnxSession({ mode: kind }),
        workerFactory,
      });

      const img = createUniformGravelImage(32, 32);

      await expect(engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet' })).rejects.toThrow(
        /simulated worker crash/,
      );

      // Second call must succeed with a fresh worker
      const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet' });
      expect(session).toBeDefined();
      expect(workerNum).toBe(2);
      await engine.dispose();
    });

    it('deduplicates concurrent acquireSession calls and releases session if disposed mid-flight', async () => {
      const factorySpy = vi.fn(async (kind: ModelKind) => {
        await new Promise((r) => setTimeout(r, 20));
        return createMockOnnxSession({ mode: kind });
      });

      const engine = new ImageGrainsEngine({
        sessionFactory: factorySpy,
      });

      const img = createUniformGravelImage(32, 32);

      const [s1, s2] = await Promise.all([
        engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet' }),
        engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet' }),
      ]);
      expect(s1).toBeDefined();
      expect(s2).toBeDefined();
      expect(factorySpy).toHaveBeenCalledTimes(1);
      await engine.dispose();

      // Now race dispose() with slow sessionFactory
      const releaseSpy = vi.fn(async () => {});
      let resolveSession!: (s: ort.InferenceSession) => void;
      const engine2 = new ImageGrainsEngine({
        sessionFactory: () =>
          new Promise<ort.InferenceSession>((resolve) => {
            resolveSession = resolve;
          }),
      });

      const pending = engine2.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet' });
      await vi.waitFor(() => {
        expect(resolveSession).toBeDefined();
      });

      const disposePromise = engine2.dispose();
      const mockSess = createMockOnnxSession({ mode: 'unet' });
      (mockSess as unknown as { release: () => Promise<void> }).release = releaseSpy;
      resolveSession(mockSess);

      await expect(pending).rejects.toThrow(/disposed/i);
      await disposePromise;
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it('exports 200x200 multi-block PNG (16-bit clamp vs 32-bit preserve for grainId 70000) and GeoJSON MultiPolygon with hole', async () => {
      const w = 200;
      const h = 200;
      const masks = createZeroMask(w, h);
      // Paint a donut (outer rect with inner hole) with grainId = 70000
      paintRect(masks, w, 20, 20, 60, 60, 70000);
      paintRect(masks, w, 30, 30, 50, 50, 0);
      // Paint a second disconnected piece with same ID 70000
      paintRect(masks, w, 100, 100, 120, 120, 70000);

      const png16 = exportInstanceMaskPng(masks, w, h, 16);
      const png32 = exportInstanceMaskPng(masks, w, h, 32);
      expect(png16.type).toBe('image/png');
      expect(png32.type).toBe('image/png');
      expect(png16.size).toBeGreaterThan(100);
      expect(png32.size).toBeGreaterThan(100);

      const grains = computeGrainMorphometrics(masks, w, h, 2);
      const geoBlob = exportGeoJsonContours(masks, grains, w, h);
      const geo = JSON.parse(await geoBlob.text()) as {
        type: string;
        features: Array<{
          geometry: { type: string; coordinates: unknown[] };
          properties: { grainId: number };
        }>;
      };
      expect(geo.features).toHaveLength(1);
      expect(geo.features[0]!.properties.grainId).toBe(70000);
      expect(geo.features[0]!.geometry.type).toBe('MultiPolygon');
    });

    it('initialize() succeeds when getCachedModels() rejects, and analyzeImage supports applyClahe with custom claheClipLimit', async () => {
      const origIdb = globalThis.indexedDB;
      globalThis.indexedDB = {
        open: () => {
          const req: Record<string, unknown> = {
            error: new Error('idb-broken'),
            onerror: null,
            onsuccess: null,
          };
          queueMicrotask(() => {
            (req['onerror'] as (() => void) | null)?.();
          });
          return req;
        },
      } as unknown as IDBFactory;

      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) =>
          createMockOnnxSession({ mode: kind }),
      });

      const caps = await engine.initialize();
      expect(caps.cachedModels).toEqual([]);

      globalThis.indexedDB = origIdb;

      const session = await engine.analyzeImage(
        createUniformGravelImage(64, 64), { inferencePipeline: 'legacy', model: 'unet', applyClahe: true, claheClipLimit: 4.0 },
      );
      expect(session.getResult().width).toBe(64);
      await engine.dispose();
    });
  });

  // =========================================================================
  // 5. PostprocessCore & Worker Adversarial Cases
  // =========================================================================
  describe('PostprocessCore & Worker Adversarial', () => {
    it('sanitizes NaN/Infinity in flowY/flowX without NaN morphometrics or (0,0) collapse', () => {
      const w = 64;
      const h = 64;
      const { flowY, flowX, cellprob } = createIsolatedEllipsesFlowField(w, h, [
        { cx: 32, cy: 32, rx: 10, ry: 8 },
      ]);
      // Inject NaN and Infinity into several foreground pixels
      flowY[32 * w + 32] = Number.NaN;
      flowX[32 * w + 32] = Number.POSITIVE_INFINITY;
      flowY[31 * w + 32] = Number.NEGATIVE_INFINITY;
      flowX[33 * w + 32] = Number.NaN;

      const res = flowsToMasksBrowser(flowY, flowX, cellprob, w, h, { minSize: 10 });
      expect(res.grainCount).toBeGreaterThanOrEqual(1);
      for (const g of res.grains) {
        expect(Number.isFinite(g.aAxisPx)).toBe(true);
        expect(Number.isFinite(g.bAxisPx)).toBe(true);
        expect(Number.isFinite(g.centroidX)).toBe(true);
        expect(Number.isFinite(g.centroidY)).toBe(true);
        expect(Number.isFinite(g.orientationRad)).toBe(true);
      }
    });

    it('returns orientationRad === 0 for 1-px and 5x5 square grains', () => {
      const w = 16;
      const h = 16;
      const masks = createZeroMask(w, h);
      masks[2 * w + 2] = 1; // 1-px grain
      paintRect(masks, w, 6, 6, 10, 10, 2); // 5x5 square

      const grains = computeGrainMorphometrics(masks, w, h, 1);
      expect(grains).toHaveLength(2);
      expect(grains[0]!.orientationRad).toBe(0);
      expect(grains[1]!.orientationRad).toBe(0);
    });

    it('multigridJacobiHeat handles (0,0), 1x60, and odd nFine (63x60)', () => {
      const empty = multigridJacobiHeat(new Uint8Array(0), 0, 0, 0, 0);
      expect(empty.length).toBe(0);

      const strip = new Uint8Array(60).fill(1);
      const stripOut = multigridJacobiHeat(strip, 1, 60, 0, 30);
      expect(stripOut.length).toBe(60);
      for (let i = 0; i < stripOut.length; i++) {
        expect(Number.isFinite(stripOut[i]!)).toBe(true);
      }

      const oddMask = new Uint8Array(63 * 60).fill(1);
      const oddOut = multigridJacobiHeat(oddMask, 63, 60, 31, 30);
      expect(oddOut.length).toBe(63 * 60);
      for (let i = 0; i < oddOut.length; i++) {
        expect(Number.isFinite(oddOut[i]!)).toBe(true);
      }
    });

    it('evaluateGrainFlowQcV4 handles empty [], niter: 0, all-zero flows, and flowsToMasksBrowser throws on mismatched lengths', () => {
      const qcEmpty = evaluateGrainFlowQcV4(
        [],
        new Float32Array(16),
        new Float32Array(16),
        4,
        4,
        0.45,
      );
      expect(qcEmpty.passed).toBe(false);

      const w = 16;
      const h = 16;
      const zeros = new Float32Array(w * h);
      const cp = new Float32Array(w * h).fill(5.0);
      const resNiter0 = flowsToMasksBrowser(zeros, zeros, cp, w, h, { niter: 0 });
      expect(resNiter0.masks.length).toBe(w * h);

      expect(() =>
        flowsToMasksBrowser(new Float32Array(4), zeros, cp, w, h),
      ).toThrow(/mismatch/i);
    });

    it('trySplitDumbbellV4 rejects 7x7 blob where dist2 < 36', () => {
      const w = 20;
      const h = 20;
      const indices: number[] = [];
      for (let y = 5; y < 12; y++) {
        for (let x = 5; x < 12; x++) {
          indices.push(y * w + x);
        }
      }
      const fy = new Float32Array(w * h);
      const fx = new Float32Array(w * h);
      // Even with strong inward divergence, max possible dist2 in 7x7 (dx<=6, dy<=6)
      // has few pairs >= 36, and with uniform flow it must reject
      const split = trySplitDumbbellV4(indices, fy, fx, w, h, 10, 1000, 0.45);
      expect(split).toBeNull();
    });

    it('handleWorkerMessage ignores null/non-postprocess messages, handles non-Error throws, and 0x0 transferable buffer', async () => {
      const posted: Array<{ msg: WorkerResponse; transfer?: Transferable[] }> = [];
      const origSelf = (globalThis as unknown as { self?: unknown }).self;
      (globalThis as unknown as { self: { onmessage: unknown; postMessage: (m: WorkerResponse, t?: Transferable[]) => void } }).self = {
        onmessage: null,
        postMessage: (msg: WorkerResponse, transfer?: Transferable[]) => {
          posted.push({ msg, transfer });
        },
      };

      const { handleWorkerMessage } = await import(
        '../../src/workers/grainPostprocess.worker.js'
      );

      // Null and non-postprocess messages are ignored
      handleWorkerMessage({ data: null } as unknown as MessageEvent<WorkerRequest>);
      handleWorkerMessage({
        data: { type: 'unknown' },
      } as unknown as MessageEvent<WorkerRequest>);
      expect(posted).toHaveLength(0);

      // Non-Error throw (mismatched lengths or non-Error exception)
      handleWorkerMessage({
        data: {
          type: 'postprocess',
          requestId: 'req-err',
          flowY: new Float32Array(2),
          flowX: new Float32Array(4),
          cellprob: new Float32Array(4),
          width: 2,
          height: 2,
        },
      } as unknown as MessageEvent<WorkerRequest>);
      expect(posted.some((p) => p.msg.type === 'error' && p.msg.requestId === 'req-err')).toBe(
        true,
      );

      // 0x0 transferable buffer
      posted.length = 0;
      handleWorkerMessage({
        data: {
          type: 'postprocess',
          requestId: 'req-0x0',
          flowY: new Float32Array(0),
          flowX: new Float32Array(0),
          cellprob: new Float32Array(0),
          width: 0,
          height: 0,
        },
      } as unknown as MessageEvent<WorkerRequest>);
      const resMsg = posted.find((p) => p.msg.type === 'result');
      expect(resMsg).toBeDefined();
      expect(resMsg!.transfer).toHaveLength(1);

      if (origSelf !== undefined) {
        (globalThis as unknown as { self: unknown }).self = origSelf;
      } else {
        delete (globalThis as unknown as { self?: unknown }).self;
      }
    });
  });

  // =========================================================================
  // 6. InteractiveEditor & SedimentStats Adversarial Cases
  // =========================================================================
  describe('InteractiveEditor & SedimentStats Adversarial', () => {
    it('splitGrainAtLine handles NaN/Infinity polyline immediately, empty/1-pt/OOB/non-intersecting, grainId <= 0, and 3-way U-shaped split', () => {
      const w = 30;
      const h = 30;
      const masks = createZeroMask(w, h);
      paintRect(masks, w, 5, 5, 24, 24, 1);

      // NaN / Infinity polyline must return applied: false immediately (no infinite loop)
      const nanRes = splitGrainAtLine(
        masks,
        1,
        [
          { x: Number.NaN, y: 10 },
          { x: Number.POSITIVE_INFINITY, y: 20 },
        ],
        w,
        h,
      );
      expect(nanRes.applied).toBe(false);

      // Empty & 1-pt
      expect(splitGrainAtLine(masks, 1, [], w, h).applied).toBe(false);
      expect(splitGrainAtLine(masks, 1, [{ x: 10, y: 10 }], w, h).applied).toBe(false);

      // Out-of-bounds & non-intersecting
      expect(
        splitGrainAtLine(masks, 1, [{ x: -10, y: -10 }, { x: -5, y: -5 }], w, h).applied,
      ).toBe(false);
      expect(
        splitGrainAtLine(masks, 1, [{ x: 0, y: 0 }, { x: 29, y: 0 }], w, h).applied,
      ).toBe(false);

      // grainId <= 0
      expect(
        splitGrainAtLine(masks, 0, [{ x: 15, y: 0 }, { x: 15, y: 29 }], w, h).applied,
      ).toBe(false);

      // 3-way U-shaped split: horizontal bar with 2 upward arms, cut across both arms
      const uMasks = createZeroMask(40, 40);
      paintRect(uMasks, 40, 5, 25, 34, 34, 1); // bottom bar
      paintRect(uMasks, 40, 5, 5, 12, 25, 1);  // left arm
      paintRect(uMasks, 40, 27, 5, 34, 25, 1); // right arm
      const uRes = splitGrainAtLine(
        uMasks,
        1,
        [
          { x: 0, y: 15 },
          { x: 39, y: 15 },
        ],
        40,
        40,
        5,
      );
      expect(uRes.applied).toBe(true);
      expect(uRes.affectedGrains.length).toBeGreaterThanOrEqual(2);
    });

    it('addPolygonGrain rejects 2-pt, out-of-bounds, collinear, and handles self-intersecting bowtie', () => {
      const w = 32;
      const h = 32;
      const masks = createZeroMask(w, h);

      expect(addPolygonGrain(masks, [{ x: 1, y: 1 }, { x: 10, y: 10 }], w, h).applied).toBe(
        false,
      );
      expect(
        addPolygonGrain(
          masks,
          [{ x: -20, y: -20 }, { x: -10, y: -20 }, { x: -15, y: -10 }],
          w,
          h,
        ).applied,
      ).toBe(false);
      expect(
        addPolygonGrain(
          masks,
          [{ x: 2, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 10 }],
          w,
          h,
        ).applied,
      ).toBe(false);

      // Self-intersecting bowtie
      const bowtie = addPolygonGrain(
        masks,
        [
          { x: 4, y: 4 },
          { x: 24, y: 24 },
          { x: 24, y: 4 },
          { x: 4, y: 24 },
        ],
        w,
        h,
        4,
      );
      expect(bowtie.applied).toBe(true);
    });

    it('MaskEditHistory enforces maxEntries eviction and clamps maxEntries <= 0', () => {
      const w = 10;
      const h = 10;

      const clamped = new MaskEditHistory(0);
      clamped.push({
        bbox: [0, 0, 1, 1],
        imageWidth: w,
        before: new Int32Array([0, 0, 0, 0]),
        after: new Int32Array([1, 1, 1, 1]),
      });
      expect(clamped.canUndo).toBe(true);

      const hist = new MaskEditHistory(2);
      hist.push({
        bbox: [0, 0, 0, 0],
        imageWidth: w,
        before: new Int32Array([0]),
        after: new Int32Array([1]),
      });
      hist.push({
        bbox: [1, 0, 1, 0],
        imageWidth: w,
        before: new Int32Array([0]),
        after: new Int32Array([2]),
      });
      hist.push({
        bbox: [2, 0, 2, 0],
        imageWidth: w,
        before: new Int32Array([0]),
        after: new Int32Array([3]),
      });

      expect(hist.length).toBe(2);
    });

    it('computeFolkWardStats handles partial zero denominators (D16===D84, D25===D75) and D50 = 0 / NaN', () => {
      const sameSpread: PsdPercentiles = {
        D5: 2,
        D10: 4,
        D16: 8,
        D25: 8,
        D50: 8,
        D75: 8,
        D84: 8,
        D90: 12,
        D95: 16,
      };
      const fw = computeFolkWardStats(sameSpread);
      expect(fw).not.toBeNull();
      expect(Number.isFinite(fw!.skewnessPhi)).toBe(true);
      expect(Number.isFinite(fw!.kurtosisPhi)).toBe(true);

      expect(computeFolkWardStats({ ...sameSpread, D50: 0 })).toBeNull();
      expect(computeFolkWardStats({ ...sameSpread, D50: Number.NaN })).toBeNull();
    });

    it('exportInstanceMaskPng clamps 16-bit > 65535 and preserves 32-bit values', () => {
      const w = 4;
      const h = 4;
      const masks = createZeroMask(w, h);
      masks[0] = 70000;
      const png16 = exportInstanceMaskPng(masks, w, h, 16);
      const png32 = exportInstanceMaskPng(masks, w, h, 32);
      expect(png16.size).toBeGreaterThan(0);
      expect(png32.size).toBeGreaterThan(0);
    });

    it('Marching Squares handles 1-px island, 4-border grain, and disconnected MultiPolygon with hole', async () => {
      const w = 12;
      const h = 12;
      const masks = createZeroMask(w, h);
      // 1-px island
      masks[2 * w + 2] = 1;
      // 4-border grain (fills outer border)
      for (let x = 0; x < w; x++) {
        masks[x] = 2;
        masks[(h - 1) * w + x] = 2;
      }
      for (let y = 0; y < h; y++) {
        masks[y * w] = 2;
        masks[y * w + (w - 1)] = 2;
      }

      const grains = computeGrainMorphometrics(masks, w, h, 1);
      const geoBlob = exportGeoJsonContours(masks, grains, w, h);
      const geo = JSON.parse(await geoBlob.text()) as {
        features: Array<{ properties: { grainId: number } }>;
      };
      expect(geo.features.length).toBeGreaterThanOrEqual(2);
    });
  });
});
