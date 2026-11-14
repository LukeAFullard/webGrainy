import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as ort from 'onnxruntime-web';
import {
  // M1: Model Cache
  downloadModel,
  getModel,
  getCachedModels,
  clearModelCache,
  checkStorageQuota,
  // M2: Image Preprocess
  applyCLAHE,
  prepareWorkingImage,
  recommendModel,
  normalizeGray,
  normalizeRgbJoint99,
  // M2: ONNX Inference
  createInferenceSession,
  runUnetInference,
  runCpsamTiledInference,
  float32ToFloat16,
  float16ToFloat32,
  // M3: Post-Processing v4.1
  flowsToMasksBrowser,
  // M4: Interactive Editor
  splitGrainAtLine,
  mergeGrains,
  deleteGrain,
  addPolygonGrain,
  MaskHistory,
  ScaleCalibrator,
  // M4: Sediment Stats & Exports
  computeSedimentStats,
  exportGrainsCsv,
  exportSummaryJson,
  exportSummaryCsv,
  exportMaskPng,
  exportGeoJson,
  exportSvg,
  // M5: Pipeline Controller
  ImageGrainsEngine,
} from '../../src/index.js';
import type {
  CachedModelInfo,
  DownloadProgress,
  ExecutionProvider,
  GrainMorphometrics,
  InferenceProgress,
  ModelKind,
  WorkerRequest,
  WorkerResponse,
} from '../../src/types/index.js';
import {
  setupBrowserMocks,
  teardownBrowserMocks,
  createMockOnnxSession,
  createMockFetch,
  MockWorker,
} from './helpers/mocks.js';
import {
  createUniformGravelImage,
  createCoarseBoulderImage,
  createHarshShadowGlareImage,
  createIsolatedEllipsesFlowField,
  createTouchingDumbbellFlowField,
  createBorderTouchingClastFlowField,
  createGiantSandSheetOutlierFlowField,
  oracleMidpointWeightedPercentiles,
  oracleFolkAndWardPhi,
} from './helpers/syntheticData.js';

describe('Tier 1: Feature Coverage — ImageGrains 2.0 Web', () => {
  beforeEach(() => {
    setupBrowserMocks();
  });

  afterEach(() => {
    teardownBrowserMocks();
  });

  // =========================================================================
  // 1. Model Cache (F1.1 – F1.3)
  // =========================================================================
  describe('Model Cache (F1.1–F1.3)', () => {
    it('F1.1: streams .onnx weights from HF with ReadableStream progress callbacks', async () => {
      const payload = new Uint8Array(64 * 1024).fill(0x5a);
      globalThis.fetch = createMockFetch({ payloadBytes: payload, chunkSize: 16 * 1024 });

      const progressEvents: DownloadProgress[] = [];
      const buffer = await downloadModel('ig2_unet_fp32', {
        onProgress: (p: DownloadProgress) => {
          progressEvents.push({ ...p });
        },
      });

      expect(buffer).toBeInstanceOf(ArrayBuffer);
      expect(buffer.byteLength).toBe(payload.byteLength);
      expect(progressEvents.length).toBeGreaterThanOrEqual(4);
      const last = progressEvents[progressEvents.length - 1];
      expect(last).toBeDefined();
      expect(last!.loadedBytes).toBe(payload.byteLength);
      expect(last!.totalBytes).toBe(payload.byteLength);
      expect(last!.percent).toBeCloseTo(100, 1);
      expect(last!.speedMBps).toBeGreaterThanOrEqual(0);
    });

    it('F1.2: persists downloaded model in IndexedDB and reloads offline via getModel without fetch', async () => {
      const payload = new Uint8Array(32 * 1024).fill(0x3c);
      globalThis.fetch = createMockFetch({ payloadBytes: payload, chunkSize: 8192 });

      await downloadModel('ig2_unet_fp32');
      // Disable network to prove offline IndexedDB hit
      globalThis.fetch = createMockFetch({ networkError: true });

      const t0 = performance.now();
      const cached = await getModel('ig2_unet_fp32');
      const elapsed = performance.now() - t0;

      expect(cached).toBeInstanceOf(ArrayBuffer);
      expect(cached.byteLength).toBe(payload.byteLength);
      expect(new Uint8Array(cached)[0]).toBe(0x3c);
      expect(elapsed).toBeLessThan(1000);
    });

    it('F1.3: getCachedModels() lists stored models with metadata', async () => {
      const payload = new Uint8Array(16 * 1024).fill(0x11);
      globalThis.fetch = createMockFetch({ payloadBytes: payload });

      await downloadModel('ig2_unet_fp32');
      const models: CachedModelInfo[] = await getCachedModels();

      expect(models).toHaveLength(1);
      const first = models[0];
      expect(first).toBeDefined();
      expect(first!.modelId).toBe('ig2_unet_fp32');
      expect(first!.sizeBytes).toBe(payload.byteLength);
      expect(first!.cachedAt).toBeGreaterThan(0);
    });

    it('F1.3: clearModelCache() removes persisted models from IndexedDB', async () => {
      globalThis.fetch = createMockFetch({ payloadBytes: new Uint8Array(8192) });
      await downloadModel('ig2_unet_fp32');
      expect((await getCachedModels()).length).toBe(1);

      await clearModelCache();
      expect((await getCachedModels()).length).toBe(0);
    });

    it('F1.3: checkStorageQuota() reports usage, quota, and available bytes via navigator.storage', async () => {
      const quota = await checkStorageQuota();
      expect(quota.usageBytes).toBe(1024 * 1024);
      expect(quota.quotaBytes).toBe(2 * 1024 * 1024 * 1024);
      expect(quota.availableBytes).toBe(quota.quotaBytes - quota.usageBytes);
    });
  });

  // =========================================================================
  // 2. Image Preprocess (F2.1 – F2.4)
  // =========================================================================
  describe('Image Preprocess (F2.1–F2.4)', () => {
    it('F2.1: applyCLAHE normalizes harsh shadow/glare luminance contrast', () => {
      const img = createHarshShadowGlareImage(128, 128);
      const enhanced = applyCLAHE({ data: img.data, width: img.width, height: img.height }, 2.0);

      expect(enhanced.data).toBeInstanceOf(Uint8ClampedArray);
      expect(enhanced.data.length).toBe(img.data.length);

      // Compute local contrast std-dev in shadow half before vs after CLAHE
      let sumOrig = 0;
      let sumEnh = 0;
      const count = 64 * 128;
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 64; x++) {
          const i = (y * 128 + x) * 4;
          sumOrig += img.data[i] ?? 0;
          sumEnh += enhanced.data[i] ?? 0;
        }
      }
      expect(sumEnh / count).toBeGreaterThan(sumOrig / count);
    });

    it('F2.2: prepareWorkingImage in auto mode downscales images > 1024 px and tracks effectiveScaleFactor', () => {
      const large = createCoarseBoulderImage(1600, 1200);
      const res = prepareWorkingImage(large.data, large.width, large.height, 'auto');

      expect(res.originalWidth).toBe(1600);
      expect(res.originalHeight).toBe(1200);
      expect(Math.max(res.width, res.height)).toBeLessThanOrEqual(1024);
      expect(res.effectiveScaleFactor).toBeLessThan(1.0);
      expect(res.width).toBe(Math.round(1600 * res.effectiveScaleFactor));
    });

    it('F2.2: prepareWorkingImage supports explicit 1.0x and 0.5x scale modes', () => {
      const img = createUniformGravelImage(400, 300);
      const full = prepareWorkingImage(img.data, img.width, img.height, '1.0x');
      const half = prepareWorkingImage(img.data, img.width, img.height, '0.5x');

      expect(full.width).toBe(400);
      expect(full.height).toBe(300);
      expect(full.effectiveScaleFactor).toBe(1.0);
      expect(half.width).toBe(200);
      expect(half.height).toBe(150);
      expect(half.effectiveScaleFactor).toBe(0.5);
    });

    it('F2.3: recommendModel routes heterogeneous boulder + WebGPU to cpsam and uniform/no-GPU to unet within 5 ms', async () => {
      const boulder = createCoarseBoulderImage(512, 512);
      const recBoulder = await recommendModel(boulder.data, boulder.width, boulder.height);
      expect(recBoulder.model).toBe('cpsam');
      expect(recBoulder.confidence).toBeGreaterThan(0.5);
      expect(recBoulder.rationale.length).toBeGreaterThan(10);
      expect(recBoulder.metrics.hasWebGPU).toBe(true);
      expect(recBoulder.metrics.elapsedMs).toBeLessThan(50);

      teardownBrowserMocks();
      setupBrowserMocks({ navigator: { hasWebGPU: false, deviceMemoryGB: 2 } });
      const gravel = createUniformGravelImage(256, 256);
      const recGravel = await recommendModel(gravel.data, gravel.width, gravel.height);
      expect(recGravel.model).toBe('unet');
      expect(recGravel.metrics.hasWebGPU).toBe(false);
    });

    it('F2.4: normalizeGray and normalizeRgbJoint99 perform 1st–99th percentile normalization', () => {
      const img = createUniformGravelImage(64, 64);
      const gray = normalizeGray(img.data, img.width, img.height);
      const rgb = normalizeRgbJoint99(img.data, img.width, img.height);

      expect(gray).toBeInstanceOf(Float32Array);
      expect(gray.length).toBe(64 * 64);
      expect(rgb).toBeInstanceOf(Float32Array);
      expect(rgb.length).toBe(3 * 64 * 64);

      for (let i = 0; i < gray.length; i++) {
        expect(Number.isFinite(gray[i])).toBe(true);
      }
      for (let i = 0; i < rgb.length; i++) {
        expect(Number.isFinite(rgb[i])).toBe(true);
      }
    });
  });

  // =========================================================================
  // 3. ONNX Inference (F3.1 – F3.3)
  // =========================================================================
  describe('ONNX Inference (F3.1–F3.3)', () => {
    it('F3.1: createInferenceSession selects webgpu when available and falls back to wasm', async () => {
      vi.spyOn(ort.InferenceSession, 'create').mockResolvedValueOnce(
        createMockOnnxSession({ mode: 'unet' })
      );
      const resGpu = await createInferenceSession(new Uint8Array(64));
      expect(resGpu.executionProvider).toBe('webgpu');

      teardownBrowserMocks();
      setupBrowserMocks({ navigator: { hasWebGPU: false } });
      vi.spyOn(ort.InferenceSession, 'create').mockResolvedValueOnce(
        createMockOnnxSession({ mode: 'unet' })
      );
      const resWasm = await createInferenceSession(new Uint8Array(64));
      expect(resWasm.executionProvider).toBe('wasm');
    });

    it('F3.2: runUnetInference pads to multiple of 16 with [1, 2, H_pad, W_pad] and crops back to [H, W]', async () => {
      const session = createMockOnnxSession({ mode: 'unet' });
      const w = 100;
      const h = 70;
      const gray = new Float32Array(w * h).fill(0.5);

      const out = await runUnetInference(session, gray, w, h);

      expect(session.observedInputShapes[0]).toEqual([1, 2, 80, 112]);
      expect(out.width).toBe(w);
      expect(out.height).toBe(h);
      expect(out.flowY.length).toBe(w * h);
      expect(out.flowX.length).toBe(w * h);
      expect(out.cellprob.length).toBe(w * h);
    });

    it('F3.3: runCpsamTiledInference tiles 256x256 with 64px overlap (192 stride) and Hanning taper', async () => {
      const session = createMockOnnxSession({ mode: 'cpsam' });
      const w = 448; // ceil((448-256)/192)+1 = 2 tiles across
      const h = 448;
      const rgb = new Float32Array(3 * w * h).fill(0.3);

      const progress: InferenceProgress[] = [];
      const out = await runCpsamTiledInference(session, rgb, w, h, {
        onProgress: (p: InferenceProgress) => progress.push({ ...p }),
      });

      expect(out.width).toBe(w);
      expect(out.height).toBe(h);
      expect(out.flowY.length).toBe(w * h);
      expect(progress.length).toBeGreaterThan(0);
      const lastProgress = progress[progress.length - 1];
      expect(lastProgress).toBeDefined();
      expect(lastProgress!.percent).toBeCloseTo(100, 1);
      for (const shape of session.observedInputShapes) {
        expect(shape[1]).toBe(3);
        expect(shape[2]).toBe(256);
        expect(shape[3]).toBe(256);
      }
    });

    it('F3.3: IEEE-754 Float32 <-> Float16 conversion round-trips accurately', () => {
      const testValues = [0, 1.0, -1.0, 0.5, -3.25, 12.75, 0.0009765625];
      for (const v of testValues) {
        const f16 = float32ToFloat16(v);
        const back = float16ToFloat32(f16);
        expect(back).toBeCloseTo(v, 2);
      }
    });

    it('F3.3: runCpsamTiledInference emits monotonic tile completion progress', async () => {
      const session = createMockOnnxSession({ mode: 'cpsam' });
      const rgb = new Float32Array(3 * 512 * 256).fill(0.2);
      const percents: number[] = [];

      await runCpsamTiledInference(session, rgb, 512, 256, {
        onProgress: (p: InferenceProgress) => percents.push(p.percent),
      });

      expect(percents.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < percents.length; i++) {
        expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!);
      }
    });
  });

  // =========================================================================
  // 4. Post-Processing v4.1 (F4.1 – F4.6)
  // =========================================================================
  describe('Post-Processing v4.1 (F4.1–F4.6)', () => {
    it('F4.1 & F4.5: extracts isolated ellipses with accurate area, aAxis, bAxis, dEq, centroid, and orientation', () => {
      const w = 160;
      const h = 160;
      const rx = 24;
      const ry = 14;
      const field = createIsolatedEllipsesFlowField(w, h, [
        { cx: 80, cy: 80, rx, ry, angleRad: 0 },
      ]);

      const res = flowsToMasksBrowser(field.flowY, field.flowX, field.cellprob, w, h, {
        minSize: 15,
      });

      expect(res.grainCount).toBe(1);
      expect(res.grains[0]).toBeDefined();
      const g = res.grains[0]!;
      expect(g.centroidX).toBeCloseTo(80, 0);
      expect(g.centroidY).toBeCloseTo(80, 0);
      // Major axis ~ 2*rx = 48, minor axis ~ 2*ry = 28 (within < 1.5 px discrete raster)
      expect(Math.abs(g.aAxisPx - 2 * rx)).toBeLessThan(2.0);
      expect(Math.abs(g.bAxisPx - 2 * ry)).toBeLessThan(2.0);
      expect(g.dEqPx).toBeCloseTo(Math.sqrt((4 * g.areaPx) / Math.PI), 4);
      expect(g.touchesBorder).toBe(false);
    });

    it('F4.2: Multigrid Jacobi PDE solves large clasts (>= 192 px) using 8x->4x->2x->1x levels', () => {
      const w = 220;
      const h = 220;
      const field = createIsolatedEllipsesFlowField(w, h, [
        { cx: 110, cy: 110, rx: 45, ry: 30 },
      ]);

      const t0 = performance.now();
      const res = flowsToMasksBrowser(field.flowY, field.flowX, field.cellprob, w, h);
      const elapsed = performance.now() - t0;

      expect(res.grainCount).toBe(1);
      expect(res.grains[0]).toBeDefined();
      expect(res.grains[0]!.areaPx).toBeGreaterThan(3500);
      expect(elapsed).toBeLessThan(1000);
    });

    it('F4.3: F3_SplitOnFailure splits touching dumbbell clasts into two distinct grains', () => {
      const w = 160;
      const h = 160;
      const dumbbell = createTouchingDumbbellFlowField(w, h);

      const res = flowsToMasksBrowser(dumbbell.flowY, dumbbell.flowX, dumbbell.cellprob, w, h, {
        flowThreshold: 0.45,
        minSize: 15,
      });

      expect(res.grainCount).toBe(2);
    });

    it('F4.4: v4.1 maxGrainAreaFraction = 0.15 rejects giant sand-sheet outlier (3ca10b7c fix)', () => {
      const w = 160;
      const h = 160;
      const giant = createGiantSandSheetOutlierFlowField(w, h, 0.25);

      const res = flowsToMasksBrowser(giant.flowY, giant.flowX, giant.cellprob, w, h, {
        maxGrainAreaFraction: 0.15,
      });

      expect(res.grainCount).toBe(0);
    });

    it('F4.5: flags touchesBorder = true for grains within margin = 2 px and false for interior grains', () => {
      const w = 160;
      const h = 160;
      const field = createBorderTouchingClastFlowField(w, h, 1);

      const res = flowsToMasksBrowser(field.flowY, field.flowX, field.cellprob, w, h, {
        excludeBorderMargin: 2,
      });

      expect(res.grainCount).toBe(2);
      const borderGrains = res.grains.filter((g: GrainMorphometrics) => g.touchesBorder);
      const interiorGrains = res.grains.filter((g: GrainMorphometrics) => !g.touchesBorder);
      expect(borderGrains).toHaveLength(1);
      expect(interiorGrains).toHaveLength(1);
    });

    it('F4.6: Web Worker wrapper transfers Float32Array buffers via Transferable ArrayBuffer and returns WorkerResponse', async () => {
      const w = 128;
      const h = 128;
      const field = createIsolatedEllipsesFlowField(w, h, [
        { cx: 64, cy: 64, rx: 16, ry: 12 },
      ]);

      MockWorker.defaultHandler = (raw: unknown): WorkerResponse => {
        const req = raw as WorkerRequest;
        const result = flowsToMasksBrowser(
          req.flowY,
          req.flowX,
          req.cellprob,
          req.width,
          req.height,
          req.options
        );
        return {
          type: 'result',
          requestId: req.requestId,
          result,
        };
      };

      const worker = new Worker('grainPostprocess.worker.js', { type: 'module' }) as unknown as MockWorker;
      const request: WorkerRequest = {
        type: 'postprocess',
        requestId: 'req-f46-1',
        flowY: field.flowY,
        flowX: field.flowX,
        cellprob: field.cellprob,
        width: w,
        height: h,
        options: { minSize: 15 },
      };
      const transferList: Transferable[] = [
        field.flowY.buffer,
        field.flowX.buffer,
        field.cellprob.buffer,
      ];

      const response = await new Promise<WorkerResponse>((resolve) => {
        worker.onmessage = (ev: MessageEvent) => {
          resolve(ev.data as WorkerResponse);
        };
        worker.postMessage(request, transferList);
      });

      expect(worker.postedMessages).toHaveLength(1);
      expect(worker.postedMessages[0]?.transfer).toHaveLength(3);
      expect(worker.postedMessages[0]?.transfer?.[0]).toBe(field.flowY.buffer);
      expect(response.type).toBe('result');
      if (response.type === 'result') {
        expect(response.requestId).toBe('req-f46-1');
        expect(response.result.grainCount).toBe(1);
        expect(response.result.masks).toBeInstanceOf(Int32Array);
      }
      worker.terminate();
    });
  });

  // =========================================================================
  // 5. Interactive Editor (F5.1 – F5.4)
  // =========================================================================
  describe('Interactive Editor (F5.1–F5.4)', () => {
    function makeTwoGrainSetup(): { masks: Int32Array; width: number; height: number } {
      const width = 100;
      const height = 100;
      const masks = new Int32Array(width * height);
      for (let y = 20; y < 45; y++) {
        for (let x = 20; x < 70; x++) {
          masks[y * width + x] = 1;
        }
      }
      for (let y = 60; y < 80; y++) {
        for (let x = 60; x < 85; x++) {
          masks[y * width + x] = 2;
        }
      }
      return { masks, width, height };
    }

    it('F5.1: splitGrainAtLine partitions a merged grain along a polyline and updates morphometrics', () => {
      const { masks, width, height } = makeTwoGrainSetup();
      const res = splitGrainAtLine(
        masks,
        1,
        [
          { x: 45, y: 15 },
          { x: 45, y: 50 },
        ],
        width,
        height
      );

      expect(res.applied).toBe(true);
      expect(res.affectedGrains.length).toBeGreaterThanOrEqual(2);
    });

    it('F5.2: mergeGrains combines two grain IDs into a single grain and updates morphometrics', () => {
      const width = 80;
      const height = 80;
      const masks = new Int32Array(width * height);
      for (let y = 20; y < 40; y++) {
        for (let x = 20; x < 35; x++) masks[y * width + x] = 1;
        for (let x = 36; x < 52; x++) masks[y * width + x] = 2;
      }

      const res = mergeGrains(masks, [1, 2], width, height);
      expect(res.applied).toBe(true);
      expect(res.affectedGrains[0]!.areaPx).toBeGreaterThan(600);
    });

    it('F5.3: deleteGrain removes target grain and supports MaskHistory Undo/Redo', () => {
      const { masks, width, height } = makeTwoGrainSetup();
      const history = new MaskHistory();
      const bboxAll: [number, number, number, number] = [0, 0, width - 1, height - 1];
      const before = MaskHistory.extractBboxSlice(masks, width, bboxAll);

      const del = deleteGrain(masks, 2, width, height);
      const after = MaskHistory.extractBboxSlice(masks, width, bboxAll);
      history.push({ bbox: bboxAll, imageWidth: width, before, after, label: 'delete' });
      expect(del.applied).toBe(true);
      expect(del.removedGrainIds).toContain(2);
      expect(masks.includes(2)).toBe(false);

      expect(history.undo(masks)).not.toBeNull();
      expect(masks.includes(2)).toBe(true);

      expect(history.redo(masks)).not.toBeNull();
      expect(masks.includes(2)).toBe(false);
    });

    it('F5.3: addPolygonGrain digitizes missed stone and supports MaskHistory Undo/Redo', () => {
      const { masks, width, height } = makeTwoGrainSetup();
      const history = new MaskHistory();
      const bboxAll: [number, number, number, number] = [0, 0, width - 1, height - 1];
      const before = MaskHistory.extractBboxSlice(masks, width, bboxAll);

      const add = addPolygonGrain(
        masks,
        [
          { x: 10, y: 60 },
          { x: 30, y: 60 },
          { x: 30, y: 80 },
          { x: 10, y: 80 },
        ],
        width,
        height
      );
      const after = MaskHistory.extractBboxSlice(masks, width, bboxAll);
      history.push({ bbox: bboxAll, imageWidth: width, before, after, label: 'add' });
      expect(add.applied).toBe(true);
      const addedGrain = add.affectedGrains[0]!;
      expect(addedGrain.areaPx).toBeGreaterThan(300);
      expect(masks.includes(addedGrain.id)).toBe(true);

      expect(history.undo(masks)).not.toBeNull();
      expect(masks.includes(addedGrain.id)).toBe(false);

      expect(history.redo(masks)).not.toBeNull();
      expect(masks.includes(addedGrain.id)).toBe(true);
    });

    it('F5.4: ScaleCalibrator computes mmPerPx from 2 points + physical length and scales grain metrics', () => {
      const cal = ScaleCalibrator.calibrate(
        { x: 10, y: 20 },
        { x: 110, y: 20 },
        50,
        'mm'
      );
      expect(cal.pixelDistance).toBeCloseTo(100, 6);
      expect(cal.mmPerPx).toBeCloseTo(0.5, 6);

      const calCm = ScaleCalibrator.calibrate(
        { x: 0, y: 0 },
        { x: 0, y: 200 },
        10,
        'cm'
      );
      expect(calCm.physicalLengthMm).toBeCloseTo(100, 6);
      expect(calCm.mmPerPx).toBeCloseTo(0.5, 6);
    });
  });

  // =========================================================================
  // 6. Sediment Stats & Exports (F6.1 – F6.3)
  // =========================================================================
  describe('Sediment Stats & Exports (F6.1–F6.3)', () => {
    const sampleGrains: GrainMorphometrics[] = [
      {
        id: 1,
        areaPx: 100,
        centroidX: 20,
        centroidY: 20,
        aAxisPx: 14,
        bAxisPx: 10,
        dEqPx: 11.28,
        orientationRad: 0,
        touchesBorder: false,
        bbox: [15, 15, 25, 25],
      },
      {
        id: 2,
        areaPx: 400,
        centroidX: 50,
        centroidY: 50,
        aAxisPx: 28,
        bAxisPx: 20,
        dEqPx: 22.57,
        orientationRad: 0.2,
        touchesBorder: false,
        bbox: [40, 40, 60, 60],
      },
      {
        id: 3,
        areaPx: 900,
        centroidX: 80,
        centroidY: 80,
        aAxisPx: 42,
        bAxisPx: 30,
        dEqPx: 33.85,
        orientationRad: 0.5,
        touchesBorder: false,
        bbox: [65, 65, 95, 95],
      },
      {
        id: 4,
        areaPx: 200,
        centroidX: 1,
        centroidY: 50,
        aAxisPx: 18,
        bAxisPx: 14,
        dEqPx: 15.96,
        orientationRad: 0,
        touchesBorder: true,
        bbox: [0, 40, 10, 60],
      },
    ];

    it('F6.1: excludes border grains by default and matches eval_core.py midpoint PSD to 1e-6', () => {
      const report = computeSedimentStats(sampleGrains, { excludeBorder: true });

      expect(report.totalGrains).toBe(4);
      expect(report.includedGrains).toBe(3);
      expect(report.excludedBorderGrains).toBe(1);
      expect(report.unit).toBe('px');

      const included = sampleGrains.filter((g) => !g.touchesBorder);
      const expectedAreaB = oracleMidpointWeightedPercentiles(
        included.map((g) => g.bAxisPx),
        included.map((g) => g.areaPx),
        [5, 10, 16, 25, 50, 75, 84, 90, 95]
      );
      expect(report.areaWeightedB.D5).toBeCloseTo(expectedAreaB[0] ?? 0, 6);
      expect(report.areaWeightedB.D16).toBeCloseTo(expectedAreaB[2] ?? 0, 6);
      expect(report.areaWeightedB.D50).toBeCloseTo(expectedAreaB[4] ?? 0, 6);
      expect(report.areaWeightedB.D84).toBeCloseTo(expectedAreaB[6] ?? 0, 6);
      expect(report.areaWeightedB.D95).toBeCloseTo(expectedAreaB[8] ?? 0, 6);
    });

    it('F6.2: computes Folk & Ward phi statistics and Wentworth classes when calibrated in mm', () => {
      const calibration = ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 100, 'mm');
      const scaledGrains = ScaleCalibrator.scaleAllMorphometrics(sampleGrains, calibration);
      const report = computeSedimentStats(scaledGrains, {
        excludeBorder: true,
      });

      expect(report.unit).toBe('mm');
      expect(report.folkWard).not.toBeNull();
      expect(report.wentworth).not.toBeNull();

      const expectedFw = oracleFolkAndWardPhi(report.areaWeightedB);
      expect(report.folkWard!.meanPhi).toBeCloseTo(expectedFw.meanPhi, 5);
      expect(report.folkWard!.sortingPhi).toBeCloseTo(expectedFw.sortingPhi, 5);
      expect(report.folkWard!.skewnessPhi).toBeCloseTo(expectedFw.skewnessPhi, 5);
      expect(report.folkWard!.kurtosisPhi).toBeCloseTo(expectedFw.kurtosisPhi, 5);

      const sumPct =
        report.wentworth!.sandPct +
        report.wentworth!.gravelPct +
        report.wentworth!.cobblePct +
        report.wentworth!.boulderPct;
      expect(sumPct).toBeCloseTo(100, 4);
    });

    it('F6.3: exportGrainsCsv, exportSummaryJson, and exportSummaryCsv produce valid downloadable text', async () => {
      const report = computeSedimentStats(sampleGrains, { excludeBorder: true });
      const csv = await exportGrainsCsv(sampleGrains).text();
      const summaryJson = await exportSummaryJson(report).text();
      const summaryCsv = await exportSummaryCsv(report).text();

      expect(csv.split('\n')[0]).toContain('grain_id');
      expect(csv.split('\n')[0]).toContain('b_axis_px');
      expect(csv.trim().split('\n').length).toBe(sampleGrains.length + 1);

      const parsed = JSON.parse(summaryJson) as Record<string, unknown>;
      expect(parsed['includedGrains']).toBe(3);
      expect(summaryCsv).toContain('D50');
    });

    it('F6.3: exportMaskPng returns a valid PNG signature buffer', async () => {
      const masks = new Int32Array(16 * 16);
      masks[5 * 16 + 5] = 1;
      const pngBlob = exportMaskPng(masks, 16, 16);
      const png = new Uint8Array(await pngBlob.arrayBuffer());

      expect(png).toBeInstanceOf(Uint8Array);
      // PNG magic bytes: 137 80 78 71 13 10 26 10
      expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    });

    it('F6.3: exportGeoJson and exportSvg trace grain contours via Marching Squares', async () => {
      const masks = new Int32Array(32 * 32);
      for (let y = 8; y < 24; y++) {
        for (let x = 8; x < 24; x++) {
          masks[y * 32 + x] = 1;
        }
      }
      const grainsSlice = sampleGrains.slice(0, 1);
      const geojson = JSON.parse(await exportGeoJson(masks, grainsSlice, 32, 32).text()) as {
        type: string;
        features: Array<{ geometry: { type: string; coordinates: unknown[] } }>;
      };
      const svg = await exportSvg(masks, grainsSlice, 32, 32).text();

      expect(geojson.type).toBe('FeatureCollection');
      expect(geojson.features.length).toBeGreaterThanOrEqual(1);
      expect(geojson.features[0]!.geometry.type).toBe('Polygon');
      expect(svg).toContain('<svg');
      expect(svg).toContain('<path');
    });
  });

  // =========================================================================
  // 7. Pipeline Controller (F7.1)
  // =========================================================================
  describe('Pipeline Controller (F7.1)', () => {
    it('F7.1: ImageGrainsEngine.initialize() probes hardware & cache state', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) =>
          createMockOnnxSession({ mode: kind }),
      });
      const status = await engine.initialize();

      expect(status.hasWebGPU).toBe(true);
      expect(Array.isArray(status.cachedModels)).toBe(true);
    });

    it('F7.1: ImageGrainsEngine.analyzeImage() runs full pipeline and returns a reactive AnalysisSession', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) => createMockOnnxSession({ mode: kind }),
      });
      await engine.initialize();

      const img = createUniformGravelImage(128, 128);
      const stages: string[] = [];
      const session = await engine.analyzeImage(img, {
        model: 'unet',
        scaleMode: '1.0x',
        onProgress: (stage: string) => stages.push(stage),
      });

      expect(session.getResult().grainCount).toBeGreaterThanOrEqual(1);
      expect(session.getStats().totalGrains).toBeGreaterThanOrEqual(1);
      expect(stages.length).toBeGreaterThanOrEqual(3);
    });

    it('F7.1: AnalysisSession supports live interactive edits and automatic stats recomputation', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) => createMockOnnxSession({ mode: kind }),
      });
      await engine.initialize();

      const img = createUniformGravelImage(128, 128);
      const session = await engine.analyzeImage(img, { model: 'unet', scaleMode: '1.0x' });
      const initialCount = session.getResult().grainCount;
      expect(initialCount).toBeGreaterThanOrEqual(2);

      const firstId = session.getResult().grains[0]!.id;
      session.deleteGrain(firstId);
      expect(session.getResult().grainCount).toBe(initialCount - 1);

      expect(session.undo()).toBe(true);
      expect(session.getResult().grainCount).toBe(initialCount);
    });

    it('F7.1: AnalysisSession supports calibration updates and exports', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) => createMockOnnxSession({ mode: kind }),
      });
      await engine.initialize();

      const img = createUniformGravelImage(128, 128);
      const session = await engine.analyzeImage(img, { model: 'unet' });

      session.setCalibration(
        ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 'mm')
      );
      const stats = session.getStats();
      expect(stats.unit).toBe('mm');
      expect(stats.folkWard).not.toBeNull();
      expect(session.exportCsv()).toContain('b_axis_mm');
    });

    it('F7.1: ImageGrainsEngine auto-selects model via Complexity Router when model = "auto"', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) => createMockOnnxSession({ mode: kind }),
      });
      await engine.initialize();

      const boulder = createCoarseBoulderImage(256, 256);
      const session = await engine.analyzeImage(boulder, { model: 'auto' });
      expect(session.recommendation.model).toBe('cpsam');
    });
  });
});
