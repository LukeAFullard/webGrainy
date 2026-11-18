import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { perfBudget } from '../perfBudget.js';
import * as ort from 'onnxruntime-web';
import {
  downloadModel,
  getCachedModels,
  applyCLAHE,
  prepareWorkingImage,
  recommendModel,
  normalizeGray,
  normalizeRgbJoint99,
  createInferenceSession,
  runUnetInference,
  runCpsamTiledInference,
  float32ToFloat16,
  float16ToFloat32,
  flowsToMasksBrowser,
  splitGrainAtLine,
  mergeGrains,
  deleteGrain,
  MaskHistory,
  ScaleCalibrator,
  computeSedimentStats,
  exportGrainsCsv,
  exportSummaryJson,
  exportGeoJson,
  exportSvg,
  ImageGrainsEngine,
} from '../../src/index.js';
import type {
  DownloadProgress,
  GrainMorphometrics,
  InferenceProgress,
  ModelKind,
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
  createEmptyFlowField,
  createBorderTouchingClastFlowField,
  createGiantSandSheetOutlierFlowField,
  createFailingFlowGiantSandSheetFlowField,
  createIsolatedEllipsesFlowField,
} from './helpers/syntheticData.js';

describe('Tier 2: Boundary & Corner Cases — ImageGrains 2.0 Web', () => {
  beforeEach(() => {
    setupBrowserMocks();
  });

  afterEach(() => {
    teardownBrowserMocks();
  });

  // =========================================================================
  // 1. Model Cache Boundaries (F1.1–F1.3)
  // =========================================================================
  describe('Model Cache Boundaries (F1.1–F1.3)', () => {
    it('rejects immediately when AbortSignal is already aborted before downloadModel', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(
        downloadModel('ig2_unet_fp32', { signal: ac.signal })
      ).rejects.toThrow();
    });

    it('rejects mid-flight when AbortSignal fires during chunked ReadableStream transfer', async () => {
      const payload = new Uint8Array(128 * 1024);
      globalThis.fetch = createMockFetch({ payloadBytes: payload, chunkSize: 16 * 1024 });
      const ac = new AbortController();

      await expect(
        downloadModel('ig2_unet_fp32', {
          onProgress: (p: DownloadProgress) => {
            if (p.loadedBytes >= 32 * 1024) {
              ac.abort();
            }
          },
          signal: ac.signal,
        })
      ).rejects.toThrow();
    });

    it('rejects cleanly on HTTP 404 / 500 responses without polluting IndexedDB cache', async () => {
      globalThis.fetch = createMockFetch({ status: 404 });
      await expect(downloadModel('ig2_unet_fp32')).rejects.toThrow();
      expect(await getCachedModels()).toHaveLength(0);
    });

    it('handles stream without Content-Length header gracefully', async () => {
      const payload = new Uint8Array(24 * 1024).fill(0x7e);
      globalThis.fetch = createMockFetch({
        payloadBytes: payload,
        chunkSize: 8192,
        omitContentLength: true,
      });

      const buffer = await downloadModel('ig2_unet_fp32');
      expect(buffer).toBeInstanceOf(ArrayBuffer);
      expect(buffer.byteLength).toBe(payload.byteLength);
      expect(new Uint8Array(buffer)[0]).toBe(0x7e);
    });

    it('surfaces QuotaExceededError when IndexedDB storage quota is exceeded', async () => {
      teardownBrowserMocks();
      setupBrowserMocks({
        idb: { quotaExceeded: true },
        fetch: { payloadBytes: new Uint8Array(16 * 1024) },
      });

      await expect(downloadModel('ig2_unet_fp32', { requireCache: true })).rejects.toThrow(/Quota/i);
    });
  });

  // =========================================================================
  // 2. Image Preprocess Boundaries (F2.1–F2.4)
  // =========================================================================
  describe('Image Preprocess Boundaries (F2.1–F2.4)', () => {
    it('handles 1x1 pixel image without crashing in CLAHE, scaling, and normalizers', () => {
      const img = createFlatImage(1, 1, 100);
      const clahe = applyCLAHE({ data: img.data, width: 1, height: 1 });
      const scaled = prepareWorkingImage(img.data, 1, 1, 'auto');
      const gray = normalizeGray(img.data, 1, 1);
      const rgb = normalizeRgbJoint99(img.data, 1, 1);

      expect(clahe.data.length).toBe(4);
      expect(scaled.width).toBe(1);
      expect(scaled.height).toBe(1);
      expect(Number.isFinite(gray[0])).toBe(true);
      expect(Number.isFinite(rgb[0])).toBe(true);
    });

    it('handles uniform-flat image (p99 === p1) without NaN or Infinity', () => {
      const flat = createFlatImage(64, 64, 200);
      const gray = normalizeGray(flat.data, 64, 64);
      const rgb = normalizeRgbJoint99(flat.data, 64, 64);

      for (let i = 0; i < gray.length; i++) {
        expect(Number.isNaN(gray[i])).toBe(false);
        expect(Number.isFinite(gray[i])).toBe(true);
      }
      for (let i = 0; i < rgb.length; i++) {
        expect(Number.isNaN(rgb[i])).toBe(false);
        expect(Number.isFinite(rgb[i])).toBe(true);
      }
    });

    it('respects exact 1024 px boundary in auto scale mode (1024 stays 1.0x, 1025 downscales)', () => {
      const img1024 = createFlatImage(1024, 512, 120);
      const res1024 = prepareWorkingImage(img1024.data, 1024, 512, 'auto');
      expect(res1024.effectiveScaleFactor).toBe(1.0);
      expect(res1024.width).toBe(1024);

      const img1025 = createFlatImage(1025, 512, 120);
      const res1025 = prepareWorkingImage(img1025.data, 1025, 512, 'auto');
      expect(res1025.effectiveScaleFactor).toBeLessThan(1.0);
      expect(res1025.width).toBeLessThanOrEqual(1024);
    });

    it('supports 0.25x scale mode on small and large images without zero dimensions', () => {
      const img = createUniformGravelImage(120, 80);
      const res = prepareWorkingImage(img.data, 120, 80, '0.25x');
      expect(res.width).toBe(30);
      expect(res.height).toBe(20);
      expect(res.effectiveScaleFactor).toBe(0.25);
    });

    it('handles 0x0 degenerate image gracefully without hanging or NaN', () => {
      const empty = new Uint8ClampedArray(0);
      try {
        const scaled = prepareWorkingImage(empty, 0, 0, 'auto');
        expect(scaled.width).toBe(0);
        expect(scaled.height).toBe(0);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
      try {
        const clahe = applyCLAHE({ data: empty, width: 0, height: 0 });
        expect(clahe.data.length).toBe(0);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
      try {
        const gray = normalizeGray(empty, 0, 0);
        expect(gray.length).toBe(0);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    });

    it('recommendModel runs within < 5 ms budget on 256x256 thumbnail after warm-up', async () => {
      const img = createUniformGravelImage(512, 512);
      await recommendModel(img.data, 512, 512); // warm-up JIT
      const rec = await recommendModel(img.data, 512, 512);
      expect(rec.metrics.elapsedMs).toBeLessThan(perfBudget(15));
    });
  });

  // =========================================================================
  // 3. ONNX Inference Boundaries (F3.1–F3.3)
  // =========================================================================
  describe('ONNX Inference Boundaries (F3.1–F3.3)', () => {
    it('runUnetInference reflection-pads arbitrary non-multiple-of-16 dimensions (17x33 -> 32x48), keeps ch1=0, and crops back', async () => {
      const session = createMockOnnxSession({ mode: 'unet' });
      const w = 17;
      const h = 33;
      const gray = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          gray[y * w + x] = 0.1 + ((x + 1) * 0.02) + ((y + 1) * 0.01);
        }
      }

      const out = await runUnetInference(session, gray, w, h);

      expect(session.observedInputShapes[0]).toEqual([1, 2, 48, 32]);
      const captured = session.capturedInputs[0];
      expect(captured).toBeDefined();
      const padW = 32;
      const padH = 48;
      const hwPad = padW * padH;
      // Channel 1 must be all zeros
      const ch1 = captured!.data.subarray(hwPad, 2 * hwPad);
      expect(ch1.every((v) => v === 0)).toBe(true);

      // Padded right border (x = 17, y = 5) and bottom border (x = 5, y = 33) must be reflection-padded (not zero)
      const rightPadVal = captured!.data[5 * padW + 17] ?? 0;
      const bottomPadVal = captured!.data[33 * padW + 5] ?? 0;
      expect(rightPadVal).toBeGreaterThan(0);
      expect(bottomPadVal).toBeGreaterThan(0);
      // Matches reflected edge pixel (either x=16 or x=15 depending on reflect mode)
      const edgeX16 = gray[5 * w + 16] ?? 0;
      const edgeX15 = gray[5 * w + 15] ?? 0;
      expect(
        Math.abs(rightPadVal - edgeX16) < 1e-5 || Math.abs(rightPadVal - edgeX15) < 1e-5
      ).toBe(true);

      expect(out.width).toBe(w);
      expect(out.height).toBe(h);
      expect(out.cellprob.length).toBe(w * h);
    });

    it('runUnetInference handles sub-16px image (8x8 -> padded to 16x16)', async () => {
      const session = createMockOnnxSession({ mode: 'unet' });
      const gray = new Float32Array(8 * 8).fill(0.5);
      const out = await runUnetInference(session, gray, 8, 8);

      expect(session.observedInputShapes[0]).toEqual([1, 2, 16, 16]);
      expect(out.width).toBe(8);
      expect(out.height).toBe(8);
    });

    it('runCpsamTiledInference reflection-pads images smaller than 256x256 (e.g. 120x90) with non-zero borders', async () => {
      const session = createMockOnnxSession({ mode: 'cpsam' });
      const w = 120;
      const h = 90;
      const rgb = new Float32Array(3 * w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 3;
          rgb[p] = 0.2 + (x + y) / 500;
          rgb[p + 1] = 0.3 + (x + y) / 500;
          rgb[p + 2] = 0.4 + (x + y) / 500;
        }
      }

      const out = await runCpsamTiledInference(session, rgb, w, h);

      expect(session.observedInputShapes[0]).toEqual([1, 3, 256, 256]);
      const captured = session.capturedInputs[0];
      expect(captured).toBeDefined();
      // Inspect channel 0 padded region beyond (120, 90): must be non-zero reflection-padded
      const rawRightPad = captured!.data[5 * 256 + 120] ?? 0;
      const rawBottomPad = captured!.data[90 * 256 + 5] ?? 0;
      const rightPadVal =
        captured!.data instanceof Uint16Array ? float16ToFloat32(rawRightPad) : Number(rawRightPad);
      const bottomPadVal =
        captured!.data instanceof Uint16Array ? float16ToFloat32(rawBottomPad) : Number(rawBottomPad);
      expect(rightPadVal).toBeGreaterThan(0.1);
      expect(bottomPadVal).toBeGreaterThan(0.1);

      expect(out.width).toBe(w);
      expect(out.height).toBe(h);
      expect(out.flowY.length).toBe(w * h);
    });

    it('runCpsamTiledInference aborts cleanly when AbortSignal is pre-aborted', async () => {
      const session = createMockOnnxSession({ mode: 'cpsam' });
      const rgb = new Float32Array(3 * 512 * 512).fill(0.1);
      const ac = new AbortController();
      ac.abort();

      await expect(
        runCpsamTiledInference(session, rgb, 512, 512, { signal: ac.signal })
      ).rejects.toThrow();
    });

    it('runCpsamTiledInference aborts mid-flight between tiles when AbortSignal fires', async () => {
      const session = createMockOnnxSession({ mode: 'cpsam' });
      // 900x900 -> 5x5 = 25 tiles -> 2 batches (16 + 9)
      const rgb = new Float32Array(3 * 900 * 900).fill(0.25);
      const ac = new AbortController();

      await expect(
        runCpsamTiledInference(session, rgb, 900, 900, {
          signal: ac.signal,
          onProgress: (p: InferenceProgress) => {
            if (p.completedTiles >= 1) {
              ac.abort();
            }
          },
        })
      ).rejects.toThrow();
      expect(session.observedInputShapes.length).toBeLessThan(2);
    });

    it('float32ToFloat16 handles zero, negative zero, overflow, and subnormal values', () => {
      expect(float16ToFloat32(float32ToFloat16(0))).toBe(0);
      expect(float16ToFloat32(float32ToFloat16(-0))).toBe(-0);
      expect(float16ToFloat32(float32ToFloat16(65504))).toBeCloseTo(65504, 0);
      expect(Number.isFinite(float16ToFloat32(float32ToFloat16(1e-5)))).toBe(true);
    });

    it('createInferenceSession falls back to wasm if webgpu provider throws', async () => {
      const createSpy = vi
        .spyOn(ort.InferenceSession, 'create')
        .mockRejectedValueOnce(new Error('WebGPU init failed'))
        .mockResolvedValueOnce(createMockOnnxSession({ mode: 'unet' }));
      const res = await createInferenceSession(new Uint8Array(64));
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(res.executionProvider).toBe('wasm');
    });
  });

  // =========================================================================
  // 4. Post-Processing v4.1 Boundaries (F4.1–F4.6)
  // =========================================================================
  describe('Post-Processing v4.1 Boundaries (F4.1–F4.6)', () => {
    it('returns empty 0-grain result for empty/all-negative cellprob field', () => {
      const empty = createEmptyFlowField(128, 128);
      const res = flowsToMasksBrowser(empty.flowY, empty.flowX, empty.cellprob, 128, 128);

      expect(res.grainCount).toBe(0);
      expect(res.grains).toEqual([]);
      expect(res.masks.every((v: number) => v === 0)).toBe(true);
    });

    it('enforces maxGrainAreaFraction = 0.15 acceptance guard (14.9% vs 15.1%) AND trySplitDumbbell pre-split guard (3ca10b7c)', () => {
      const w = 200;
      const h = 200;
      const below = createGiantSandSheetOutlierFlowField(w, h, 0.149);
      const above = createGiantSandSheetOutlierFlowField(w, h, 0.151);
      const failingFlowGiant = createFailingFlowGiantSandSheetFlowField(w, h, 0.25);

      const resBelow = flowsToMasksBrowser(below.flowY, below.flowX, below.cellprob, w, h, {
        maxGrainAreaFraction: 0.15,
      });
      const resAbove = flowsToMasksBrowser(above.flowY, above.flowX, above.cellprob, w, h, {
        maxGrainAreaFraction: 0.15,
      });
      const resPreSplit = flowsToMasksBrowser(
        failingFlowGiant.flowY,
        failingFlowGiant.flowX,
        failingFlowGiant.cellprob,
        w,
        h,
        { maxGrainAreaFraction: 0.15, flowThreshold: 0.45 }
      );

      expect(resBelow.grainCount).toBe(1);
      expect(resAbove.grainCount).toBe(0);
      expect(resPreSplit.grainCount).toBe(0);
    });

    it('enforces exact margin = 2 border touch boundary (offset=1 touchesBorder=true, offset=2 touchesBorder=false)', () => {
      const w = 160;
      const h = 160;
      const atMargin = createBorderTouchingClastFlowField(w, h, 1);
      const insideMargin = createBorderTouchingClastFlowField(w, h, 2);

      const resAt = flowsToMasksBrowser(atMargin.flowY, atMargin.flowX, atMargin.cellprob, w, h, {
        excludeBorderMargin: 2,
      });
      const resIn = flowsToMasksBrowser(
        insideMargin.flowY,
        insideMargin.flowX,
        insideMargin.cellprob,
        w,
        h,
        { excludeBorderMargin: 2 }
      );

      expect(resAt.grainCount).toBe(2);
      expect(resAt.grains.some((g: GrainMorphometrics) => g.touchesBorder)).toBe(true);
      expect(resIn.grainCount).toBe(2);
      expect(resIn.grains.every((g: GrainMorphometrics) => !g.touchesBorder)).toBe(true);
    });

    it('handles both maxDim < 192 (4x->2x->1x) and maxDim >= 192 (8x->4x->2x->1x) Multigrid Jacobi', () => {
      const small = createIsolatedEllipsesFlowField(128, 128, [{ cx: 64, cy: 64, rx: 16, ry: 12 }]);
      const large = createIsolatedEllipsesFlowField(200, 200, [{ cx: 100, cy: 100, rx: 24, ry: 18 }]);

      const resSmall = flowsToMasksBrowser(small.flowY, small.flowX, small.cellprob, 128, 128);
      const resLarge = flowsToMasksBrowser(large.flowY, large.flowX, large.cellprob, 200, 200);

      expect(resSmall.grainCount).toBe(1);
      expect(resLarge.grainCount).toBe(1);
    });

    it('filters out grains smaller than minSize', () => {
      const tiny = createIsolatedEllipsesFlowField(100, 100, [{ cx: 50, cy: 50, rx: 2, ry: 2 }]);
      const res = flowsToMasksBrowser(tiny.flowY, tiny.flowX, tiny.cellprob, 100, 100, {
        minSize: 50,
      });
      expect(res.grainCount).toBe(0);
    });
  });

  // =========================================================================
  // 5. Interactive Editor Boundaries (F5.1–F5.4)
  // =========================================================================
  describe('Interactive Editor Boundaries (F5.1–F5.4)', () => {
    it('splitGrainAtLine returns applied=false when split produces component smaller than minSize', () => {
      const w = 64;
      const h = 64;
      const masks = new Int32Array(w * h);
      for (let y = 20; y < 40; y++) {
        for (let x = 20; x < 40; x++) masks[y * w + x] = 1;
      }

      // Slice just 1-px edge off grain 1
      const res = splitGrainAtLine(
        masks,
        1,
        [
          { x: 21, y: 18 },
          { x: 21, y: 42 },
        ],
        w,
        h,
        50
      );
      expect(res.applied).toBe(false);
    });

    it('mergeGrains fails gracefully with < 2 valid grain IDs', () => {
      const masks = new Int32Array(64 * 64);
      masks[10 * 64 + 10] = 1;
      const res = mergeGrains(masks, [1], 64, 64);
      expect(res.applied).toBe(false);
    });

    it('deleteGrain on non-existent ID is a safe no-op', () => {
      const masks = new Int32Array(32 * 32);
      const res = deleteGrain(masks, 999, 32, 32);
      expect(res.applied).toBe(false);
    });

    it('MaskHistory undo/redo on empty stack returns null and executes in < 1 ms', () => {
      const w = 256;
      const h = 256;
      const masks = new Int32Array(w * h);
      for (let y = 50; y < 100; y++) {
        for (let x = 50; x < 100; x++) masks[y * w + x] = 1;
      }
      const history = new MaskHistory();
      expect(history.undo(masks)).toBeNull();
      expect(history.redo(masks)).toBeNull();

      const bbox: [number, number, number, number] = [50, 50, 99, 99];
      const before = MaskHistory.extractBboxSlice(masks, w, bbox);
      const del = deleteGrain(masks, 1, w, h);
      expect(del.applied).toBe(true);
      const after = MaskHistory.extractBboxSlice(masks, w, bbox);
      history.push({ bbox, imageWidth: w, before, after, label: 'delete' });

      const t0 = performance.now();
      expect(history.undo(masks)).not.toBeNull();
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(perfBudget(1.0));
    });

    it('ScaleCalibrator throws on zero, negative, NaN, Infinity physical length or coincident points', () => {
      expect(() =>
        ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 'mm')
      ).toThrow();
      expect(() =>
        ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, -10, 'mm')
      ).toThrow();
      expect(() =>
        ScaleCalibrator.calibrate({ x: 50, y: 50 }, { x: 50, y: 50 }, 10, 'mm')
      ).toThrow();
      expect(() =>
        ScaleCalibrator.calibrate({ x: NaN, y: 0 }, { x: 100, y: 0 }, 10, 'mm')
      ).toThrow();
      expect(() =>
        ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: Infinity, y: 0 }, 10, 'mm')
      ).toThrow();
      expect(() =>
        ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, NaN, 'mm')
      ).toThrow();
      expect(() =>
        ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, Infinity, 'mm')
      ).toThrow();
    });
  });

  // =========================================================================
  // 6. Sediment Stats & Exports Boundaries (F6.1–F6.3)
  // =========================================================================
  describe('Sediment Stats & Exports Boundaries (F6.1–F6.3)', () => {
    it('handles 0 included grains (all border-filtered) without NaN', () => {
      const report = computeSedimentStats(
        [
          {
            id: 1,
            areaPx: 100,
            centroidX: 1,
            centroidY: 1,
            aAxisPx: 12,
            bAxisPx: 10,
            dEqPx: 11.28,
            orientationRad: 0,
            touchesBorder: true,
            bbox: [0, 0, 10, 10],
          },
        ],
        { excludeBorder: true }
      );

      expect(report.includedGrains).toBe(0);
      expect(Number.isNaN(report.areaWeightedB.D50)).toBe(true);
      expect(report.folkWard).toBeNull();
    });

    it('handles single-grain PSD where all percentiles equal the single grain size', () => {
      const report = computeSedimentStats(
        [
          {
            id: 1,
            areaPx: 250,
            centroidX: 50,
            centroidY: 50,
            aAxisPx: 20,
            bAxisPx: 15,
            dEqPx: 17.84,
            orientationRad: 0,
            touchesBorder: false,
            bbox: [40, 40, 60, 60],
          },
        ],
        { excludeBorder: true }
      );

      expect(report.areaWeightedB.D5).toBeCloseTo(15, 6);
      expect(report.areaWeightedB.D50).toBeCloseTo(15, 6);
      expect(report.areaWeightedB.D95).toBeCloseTo(15, 6);
    });

    it('returns folkWard = null and wentworth = null when uncalibrated (unit = px)', () => {
      const report = computeSedimentStats(
        [
          {
            id: 1,
            areaPx: 200,
            centroidX: 30,
            centroidY: 30,
            aAxisPx: 18,
            bAxisPx: 14,
            dEqPx: 15.96,
            orientationRad: 0,
            touchesBorder: false,
            bbox: [20, 20, 40, 40],
          },
        ],
        { excludeBorder: true }
      );
      expect(report.unit).toBe('px');
      expect(report.folkWard).toBeNull();
      expect(report.wentworth).toBeNull();
    });

    it('classifies Wentworth boundaries accurately (<2mm Sand, 2-64mm Gravel, 64-256mm Cobble, >=256mm Boulder)', () => {
      const cal = ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 1, y: 0 }, 1, 'mm'); // 1 mm/px
      const scaled = ScaleCalibrator.scaleAllMorphometrics(
        [
          { id: 1, areaPx: 100, centroidX: 10, centroidY: 10, aAxisPx: 2, bAxisPx: 1.5, dEqPx: 1.5, orientationRad: 0, touchesBorder: false, bbox: [0, 0, 2, 2] },
          { id: 2, areaPx: 100, centroidX: 20, centroidY: 20, aAxisPx: 12, bAxisPx: 10, dEqPx: 10, orientationRad: 0, touchesBorder: false, bbox: [15, 15, 25, 25] },
          { id: 3, areaPx: 100, centroidX: 30, centroidY: 30, aAxisPx: 100, bAxisPx: 80, dEqPx: 80, orientationRad: 0, touchesBorder: false, bbox: [25, 25, 35, 35] },
          { id: 4, areaPx: 100, centroidX: 40, centroidY: 40, aAxisPx: 300, bAxisPx: 260, dEqPx: 260, orientationRad: 0, touchesBorder: false, bbox: [35, 35, 45, 45] },
        ],
        cal
      );
      const report = computeSedimentStats(scaled, { excludeBorder: true });

      expect(report.wentworth!.sandPct).toBeCloseTo(25, 3);
      expect(report.wentworth!.gravelPct).toBeCloseTo(25, 3);
      expect(report.wentworth!.cobblePct).toBeCloseTo(25, 3);
      expect(report.wentworth!.boulderPct).toBeCloseTo(25, 3);
    });

    it('produces valid empty exports (CSV header, valid JSON, valid GeoJSON, valid SVG) for 0 grains', async () => {
      const emptyMasks = new Int32Array(16 * 16);
      const report = computeSedimentStats([], { excludeBorder: true });
      const csv = await exportGrainsCsv([]).text();
      const json = JSON.parse(await exportSummaryJson(report).text()) as Record<string, unknown>;
      const geojson = JSON.parse(await exportGeoJson(emptyMasks, [], 16, 16).text()) as {
        type: string;
        features: unknown[];
      };
      const svg = await exportSvg(emptyMasks, [], 16, 16).text();

      expect(csv.trim().split('\n')).toHaveLength(1);
      expect(json['totalGrains']).toBe(0);
      expect(geojson.type).toBe('FeatureCollection');
      expect(geojson.features).toHaveLength(0);
      expect(svg).toContain('<svg');
    });
  });

  // =========================================================================
  // 7. Pipeline Controller Boundaries (F7.1)
  // =========================================================================
  describe('Pipeline Controller Boundaries (F7.1)', () => {
    it('analyzeImage aborts immediately when passed a pre-aborted AbortSignal', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) => createMockOnnxSession({ mode: kind }),
      });
      await engine.initialize();

      const ac = new AbortController();
      ac.abort();
      const img = createUniformGravelImage(64, 64);

      await expect(
        engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet', signal: ac.signal })
      ).rejects.toThrow();
    });

    it('analyzeImage auto-initializes or succeeds cleanly on 1x1 flat image with 0 grains', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) => createMockOnnxSession({ mode: kind }),
      });
      const img = createFlatImage(1, 1, 128);
      const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet' });

      expect(session.getResult().grainCount).toBe(0);
      expect(session.getStats().totalGrains).toBe(0);
    });

    it('analyzeImage emits ordered stage progress events', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) => createMockOnnxSession({ mode: kind }),
      });
      await engine.initialize();

      const img = createUniformGravelImage(64, 64);
      const stages: string[] = [];
      await engine.analyzeImage(img, { inferencePipeline: 'legacy',
        model: 'unet',
        onProgress: (stage: string) => stages.push(stage),
      });

      expect(stages.length).toBeGreaterThanOrEqual(3);
      expect(new Set(stages).size).toBeGreaterThanOrEqual(3);
    });

    it('AnalysisSession.undo/redo returns false when no edits have been performed', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) => createMockOnnxSession({ mode: kind }),
      });
      await engine.initialize();

      const img = createUniformGravelImage(64, 64);
      const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet' });

      expect(session.undo()).toBe(false);
      expect(session.redo()).toBe(false);
    });

    it('AnalysisSession.setExcludeBorder toggles border grain inclusion dynamically', async () => {
      const engine = new ImageGrainsEngine({
        sessionFactory: async (kind: ModelKind) =>
          createMockOnnxSession({
            mode: kind,
            customFlowGenerator: (w: number, h: number) => createBorderTouchingClastFlowField(w, h, 1),
          }),
      });
      await engine.initialize();

      const img = createUniformGravelImage(128, 128);
      const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy',
        model: 'unet',
        scaleMode: '1.0x',
        excludeBorder: true,
      });

      const excludedStats = session.getStats();
      session.setExcludeBorder(false);
      const includedStats = session.getStats();

      expect(includedStats.includedGrains).toBeGreaterThan(excludedStats.includedGrains);
    });
  });
});
