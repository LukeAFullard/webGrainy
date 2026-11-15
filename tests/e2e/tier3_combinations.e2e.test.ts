import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as ort from 'onnxruntime-web';
import {
  downloadModel,
  applyCLAHE,
  prepareWorkingImage,
  recommendModel,
  normalizeGray,
  normalizeRgbJoint99,
  createInferenceSession,
  runUnetInference,
  runCpsamTiledInference,
  flowsToMasksBrowser,
  splitGrainAtLine,
  mergeGrains,
  deleteGrain,
  addPolygonGrain,
  MaskHistory,
  ScaleCalibrator,
  computeSedimentStats,
  exportGrainsCsv,
  exportGeoJson,
  exportSvg,
  ImageGrainsEngine,
} from '../../src/index.js';
import type {
  CachedModelInfo,
  ExecutionProvider,
  GrainMorphometrics,
  ModelId,
  ModelKind,
} from '../../src/types/index.js';
import {
  setupBrowserMocks,
  teardownBrowserMocks,
  createMockFetch,
  createMockOnnxSession,
} from './helpers/mocks.js';
import {
  createHarshShadowGlareImage,
  createCoarseBoulderImage,
  createUniformGravelImage,
  createIsolatedEllipsesFlowField,
  createBorderTouchingClastFlowField,
  createTouchingDumbbellFlowField,
  createGiantSandSheetOutlierFlowField,
  oracleMidpointWeightedPercentiles,
} from './helpers/syntheticData.js';

describe('Tier 3: Cross-Feature Combinations — ImageGrains 2.0 Web', () => {
  beforeEach(() => {
    setupBrowserMocks();
  });

  afterEach(() => {
    teardownBrowserMocks();
  });

  it('C1: CLAHE + Complexity Router normalizes shadow/glare before routing decision', async () => {
    const harsh = createHarshShadowGlareImage(256, 256);
    const enhanced = applyCLAHE({ data: harsh.data, width: harsh.width, height: harsh.height }, 2.0);
    const rec = await recommendModel(enhanced.data, harsh.width, harsh.height);

    expect(['unet', 'cpsam']).toContain(rec.model);
    expect(Number.isFinite(rec.metrics.sobelEntropy)).toBe(true);
    expect(Number.isFinite(rec.metrics.shadowGlareRange)).toBe(true);
  });

  it('C2: CLAHE + Adaptive Input Scaling ("auto" on > 1024 px) preserves valid RGBA output', () => {
    const largeHarsh = createHarshShadowGlareImage(1400, 1050);
    const scaled = prepareWorkingImage(largeHarsh.data, largeHarsh.width, largeHarsh.height, 'auto');
    const enhanced = applyCLAHE({ data: scaled.data, width: scaled.width, height: scaled.height });

    expect(scaled.width).toBeLessThanOrEqual(1024);
    expect(scaled.effectiveScaleFactor).toBeLessThan(1.0);
    expect(enhanced.data.length).toBe(scaled.width * scaled.height * 4);
  });

  it('C3: Adaptive Scaling (0.5x) via ImageGrainsEngine.analyzeImage + ScaleCalibrator back-scales px and mm metrics', async () => {
    const img = createCoarseBoulderImage(800, 600);
    const radiusWorkingPx = 20; // 40 px diameter in 0.5x working image (400x300) => 80 px in original (800x600)
    const cal = ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 'mm'); // 0.5 mm/px on original

    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind: ModelKind) =>
        createMockOnnxSession({
          mode: kind,
          customFlowGenerator: (w: number, h: number) =>
            createIsolatedEllipsesFlowField(w, h, [
              { cx: Math.floor(w * 0.5), cy: Math.floor(h * 0.5), rx: radiusWorkingPx, ry: radiusWorkingPx },
            ]),
        }),
    });
    await engine.initialize();

    const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy',
      model: 'unet',
      scaleMode: '0.5x',
      calibration: cal,
    });

    expect(session.workingImage.effectiveScaleFactor).toBe(0.5);
    expect(session.workingImage.width).toBe(400);
    expect(session.workingImage.height).toBe(300);

    const grains = session.getResult().grains;
    expect(grains).toHaveLength(1);
    const g = grains[0]!;
    const expectedOriginalDiameter = (2 * radiusWorkingPx) / session.workingImage.effectiveScaleFactor; // 80 px
    const expectedOriginalArea = Math.PI * radiusWorkingPx * radiusWorkingPx / (0.5 * 0.5); // ~5026.5 px^2
    expect(Math.abs(g.bAxisPx - expectedOriginalDiameter)).toBeLessThan(4.0);
    expect(Math.abs(g.aAxisPx - expectedOriginalDiameter)).toBeLessThan(4.0);
    expect(Math.abs(g.areaPx - expectedOriginalArea)).toBeLessThan(350);
    expect(g.bAxisMm).toBeCloseTo(g.bAxisPx * cal.mmPerPx, 5);
    expect(g.aAxisMm).toBeCloseTo(g.aAxisPx * cal.mmPerPx, 5);
    expect(g.bAxisMm!).toBeCloseTo(40, 0);
  });

  it('C4: Complexity Router + ORT Session Manager selects matching provider & model kind (WebGPU and WASM fallback)', async () => {
    const boulder = createCoarseBoulderImage(512, 512);
    const rec = await recommendModel(boulder.data, boulder.width, boulder.height);
    expect(rec.model).toBe('cpsam');

    vi.spyOn(ort.InferenceSession, 'create').mockResolvedValueOnce(
      createMockOnnxSession({ mode: rec.model })
    );
    const { executionProvider } = await createInferenceSession(new Uint8Array(64));
    expect(executionProvider).toBe('webgpu');

    // Verify no-WebGPU fallback path: routes to unet and selects wasm provider
    teardownBrowserMocks();
    setupBrowserMocks({ navigator: { hasWebGPU: false, deviceMemoryGB: 2 } });
    const gravel = createUniformGravelImage(256, 256);
    const recNoGpu = await recommendModel(gravel.data, gravel.width, gravel.height);
    expect(recNoGpu.model).toBe('unet');

    vi.spyOn(ort.InferenceSession, 'create').mockResolvedValueOnce(
      createMockOnnxSession({ mode: recNoGpu.model })
    );
    const fallbackRes = await createInferenceSession(new Uint8Array(64));
    expect(fallbackRes.executionProvider).toBe('wasm');
  });

  it('C5: normalizeGray + runUnetInference + flowsToMasksBrowser extracts valid grains end-to-end', async () => {
    const img = createUniformGravelImage(128, 128);
    const gray = normalizeGray(img.data, img.width, img.height);
    const session = createMockOnnxSession({ mode: 'unet' });
    const flow = await runUnetInference(session, gray, img.width, img.height);
    const post = flowsToMasksBrowser(flow.flowY, flow.flowX, flow.cellprob, flow.width, flow.height);

    expect(post.grainCount).toBe(4);
    expect(post.grains.every((g: GrainMorphometrics) => g.areaPx > 0 && g.bAxisPx > 0)).toBe(true);
  });

  it('C6: normalizeRgbJoint99 + runCpsamTiledInference (Hanning taper) + flowsToMasksBrowser', async () => {
    const img = createCoarseBoulderImage(320, 320);
    const rgb = normalizeRgbJoint99(img.data, img.width, img.height);
    const session = createMockOnnxSession({ mode: 'cpsam' });
    const flow = await runCpsamTiledInference(session, rgb, img.width, img.height);
    const post = flowsToMasksBrowser(flow.flowY, flow.flowX, flow.cellprob, flow.width, flow.height);

    expect(post.width).toBe(320);
    expect(post.height).toBe(320);
    expect(post.grainCount).toBeGreaterThanOrEqual(1);
  });

  it('C7: F3_SplitOnFailure + maxGrainAreaFraction guard (3ca10b7c) + touchesBorder combined', () => {
    const w = 160;
    const h = 160;
    const dumbbell = createTouchingDumbbellFlowField(w, h);
    const giant = createGiantSandSheetOutlierFlowField(w, h, 0.25);

    const resDumbbell = flowsToMasksBrowser(
      dumbbell.flowY,
      dumbbell.flowX,
      dumbbell.cellprob,
      w,
      h,
      { maxGrainAreaFraction: 0.15, excludeBorderMargin: 2 }
    );
    const resGiant = flowsToMasksBrowser(giant.flowY, giant.flowX, giant.cellprob, w, h, {
      maxGrainAreaFraction: 0.15,
      excludeBorderMargin: 2,
    });

    expect(resDumbbell.grainCount).toBe(2);
    expect(resDumbbell.grains.every((g: GrainMorphometrics) => !g.touchesBorder)).toBe(true);
    expect(resGiant.grainCount).toBe(0);
  });

  it('C8: Post-Process touchesBorder toggle + PSD Percentiles (eval_core.py parity)', () => {
    const w = 160;
    const h = 160;
    const field = createBorderTouchingClastFlowField(w, h, 1);
    const post = flowsToMasksBrowser(field.flowY, field.flowX, field.cellprob, w, h, {
      excludeBorderMargin: 2,
    });

    const statsExcluded = computeSedimentStats(post.grains, { excludeBorder: true });
    const statsIncluded = computeSedimentStats(post.grains, { excludeBorder: false });

    expect(statsExcluded.includedGrains).toBe(1);
    expect(statsIncluded.includedGrains).toBe(2);

    const expectedD50 =
      oracleMidpointWeightedPercentiles(
        post.grains.map((g: GrainMorphometrics) => g.bAxisPx),
        post.grains.map((g: GrainMorphometrics) => g.areaPx),
        [50]
      )[0] ?? 0;
    expect(statsIncluded.areaWeightedB.D50).toBeCloseTo(expectedD50, 6);
  });

  it('C9: Post-Process touchesBorder + GeoJSON & SVG contour exports reflect filtered vs all grains', async () => {
    const w = 128;
    const h = 128;
    const field = createBorderTouchingClastFlowField(w, h, 1);
    const post = flowsToMasksBrowser(field.flowY, field.flowX, field.cellprob, w, h, {
      excludeBorderMargin: 2,
    });

    const interiorOnly = post.grains.filter((g: GrainMorphometrics) => !g.touchesBorder);
    const geoAll = JSON.parse(await exportGeoJson(post.masks, post.grains, w, h).text()) as {
      features: unknown[];
    };
    const geoInterior = JSON.parse(await exportGeoJson(post.masks, interiorOnly, w, h).text()) as {
      features: unknown[];
    };
    const svg = await exportSvg(post.masks, post.grains, w, h).text();

    expect(geoAll.features.length).toBe(2);
    expect(geoInterior.features.length).toBe(1);
    expect(svg).toContain('<path');
  });

  it('C10: Interactive splitGrainAtLine + Undo/Redo + Live Folk & Ward recomputation', () => {
    const w = 100;
    const h = 100;
    const masks = new Int32Array(w * h);
    for (let y = 20; y < 50; y++) {
      for (let x = 15; x < 85; x++) masks[y * w + x] = 1;
    }
    const originalGrain: GrainMorphometrics = {
      id: 1,
      areaPx: 30 * 70,
      centroidX: 49.5,
      centroidY: 34.5,
      aAxisPx: 70,
      bAxisPx: 30,
      dEqPx: Math.sqrt((4 * 2100) / Math.PI),
      orientationRad: 0,
      touchesBorder: false,
      bbox: [15, 20, 84, 49],
    };

    const history = new MaskHistory();
    const cal = ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 10, y: 0 }, 10, 'mm');
    const bboxAll: [number, number, number, number] = [0, 0, w - 1, h - 1];
    const before = MaskHistory.extractBboxSlice(masks, w, bboxAll);

    const split = splitGrainAtLine(
      masks,
      1,
      [
        { x: 50, y: 15 },
        { x: 50, y: 55 },
      ],
      w,
      h,
      10,
      { grains: [originalGrain], calibration: cal }
    );
    expect(split.applied).toBe(true);
    expect(split.grains).toHaveLength(2);
    const after = MaskHistory.extractBboxSlice(masks, w, bboxAll);
    history.push({ bbox: bboxAll, imageWidth: w, before, after, label: 'split' });

    const splitGrains = split.grains!;
    const statsAfterSplit = computeSedimentStats(splitGrains);
    expect(statsAfterSplit.includedGrains).toBe(2);
    expect(statsAfterSplit.folkWard).not.toBeNull();

    // Undo and verify masks reverted to 1-grain state + recomputed stats
    expect(history.undo(masks)).not.toBeNull();
    const idsAfterUndo = new Set<number>();
    let areaAfterUndo = 0;
    for (let i = 0; i < masks.length; i++) {
      const v = masks[i] ?? 0;
      if (v > 0) {
        idsAfterUndo.add(v);
        areaAfterUndo += 1;
      }
    }
    expect(Array.from(idsAfterUndo)).toEqual([1]);
    expect(areaAfterUndo).toBe(30 * 70);

    const statsAfterUndo = computeSedimentStats(
      ScaleCalibrator.scaleAllMorphometrics([originalGrain], cal)
    );
    expect(statsAfterUndo.includedGrains).toBe(1);

    // Redo and verify 2-grain state restored
    expect(history.redo(masks)).not.toBeNull();
    const idsAfterRedo = new Set<number>();
    for (let i = 0; i < masks.length; i++) {
      const v = masks[i] ?? 0;
      if (v > 0) idsAfterRedo.add(v);
    }
    expect(idsAfterRedo.size).toBe(2);
    const statsAfterRedo = computeSedimentStats(splitGrains);
    expect(statsAfterRedo.includedGrains).toBe(2);
  });

  it('C11: Interactive mergeGrains + addPolygonGrain + deleteGrain + Per-grain CSV export', async () => {
    const w = 100;
    const h = 100;
    const masks = new Int32Array(w * h);
    for (let y = 10; y < 30; y++) {
      for (let x = 10; x < 25; x++) masks[y * w + x] = 1;
      for (let x = 26; x < 42; x++) masks[y * w + x] = 2;
    }

    const merged = mergeGrains(masks, [1, 2], w, h);
    expect(merged.applied).toBe(true);
    const mergedGrain = merged.affectedGrains[0]!;

    const added = addPolygonGrain(
      masks,
      [
        { x: 60, y: 60 },
        { x: 85, y: 60 },
        { x: 85, y: 85 },
        { x: 60, y: 85 },
      ],
      w,
      h
    );
    expect(added.applied).toBe(true);
    const addedGrain = added.affectedGrains[0]!;
    expect(addedGrain.areaPx).toBeGreaterThan(400);

    const del = deleteGrain(masks, addedGrain.id, w, h);
    expect(del.applied).toBe(true);

    const csv = await exportGrainsCsv([mergedGrain]).text();
    expect(csv).toContain(String(mergedGrain.id));
  });

  it('C12: ModelCache offline hit + ImageGrainsEngine initialization & analysis', async () => {
    globalThis.fetch = createMockFetch({ payloadBytes: new Uint8Array(16 * 1024).fill(0x44) });
    await downloadModel('ig2_unet_fp32');

    // Break network to prove offline IndexedDB cache works with Engine
    globalThis.fetch = createMockFetch({ networkError: true });

    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind: ModelKind) => createMockOnnxSession({ mode: kind }),
    });
    const status = await engine.initialize();
    expect(status.cachedModels.some((m: CachedModelInfo) => m.modelId === 'ig2_unet_fp32')).toBe(true);

    const img = createUniformGravelImage(128, 128);
    const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet' });
    expect(session.getResult().grainCount).toBeGreaterThanOrEqual(1);
  });
});
