import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as ort from 'onnxruntime-web';

// Serve model bytes without IndexedDB/network for tests that use real session creation.
vi.mock('../src/modules/modelCache.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/modules/modelCache.js')>();
  return { ...mod, getModel: async () => new ArrayBuffer(8) };
});
import {
  ImageGrainsEngine,
  AnalysisSession,
  ScaleCalibrator,
  flowsToMasksBrowser,
  float32ArrayToFloat16Bits,
  type InferenceSessionLike,
  type ModelKind,
  type WorkerRequest,
  type WorkerResponse,
} from '../src/index.js';

function makeRgbaImage(
  width: number,
  height: number,
  pattern: 'uniform' | 'coarse' = 'uniform',
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      let val: number;
      if (pattern === 'coarse') {
        // Multi-scale high-entropy boulders + shadows/glare for CP-SAM routing
        const r1 = Math.sin(x * 0.09) * Math.cos(y * 0.07) * 90;
        const r2 = Math.sin((x + y) * 0.23) * 50;
        const r3 = ((x * 37 + y * 91) ^ (x * y)) % 45;
        const raw = 128 + r1 + r2 + r3 - 22;
        val = Math.max(0, Math.min(255, Math.round(raw)));
      } else {
        val = 120 + ((x * 7 + y * 13) % 20);
      }
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }
  return { data, width, height };
}

interface EllipseSpec {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

function makeEllipsesFlowField(
  width: number,
  height: number,
  ellipses: readonly EllipseSpec[],
): { flowY: Float32Array; flowX: Float32Array; cellprob: Float32Array } {
  const n = width * height;
  const flowY = new Float32Array(n);
  const flowX = new Float32Array(n);
  const cellprob = new Float32Array(n).fill(-4.0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      for (const e of ellipses) {
        const dx = (x - e.cx) / e.rx;
        const dy = (y - e.cy) / e.ry;
        if (dx * dx + dy * dy <= 1.0) {
          cellprob[idx] = 4.0;
          const vy = e.cy - y;
          const vx = e.cx - x;
          const norm = Math.hypot(vy, vx);
          if (norm > 1e-6) {
            flowY[idx] = vy / norm;
            flowX[idx] = vx / norm;
          }
          break;
        }
      }
    }
  }

  return { flowY, flowX, cellprob };
}

function createMockSession(
  mode: ModelKind,
  ellipses: readonly EllipseSpec[],
): InferenceSessionLike {
  return {
    async run(feeds: Record<string, unknown>) {
      const tensor = feeds['image'] as {
        dims: readonly number[];
        data: Float32Array | Uint16Array;
      };
      const dims = tensor.dims;
      const batch = dims[0] ?? 1;
      const h = dims[2] ?? 64;
      const w = dims[3] ?? 64;

      if (mode === 'unet') {
        const { flowY, flowX, cellprob } = makeEllipsesFlowField(w, h, ellipses);
        const out = new Float32Array(3 * h * w);
        out.set(flowY, 0);
        out.set(flowX, h * w);
        out.set(cellprob, 2 * h * w);
        return {
          flows_cellprob: {
            data: out,
            dims: [1, 3, h, w],
          },
        };
      }

      // CP-SAM: [batch, 3, 256, 256] float16 (uint16)
      const plane = h * w;
      const outF32 = new Float32Array(batch * 3 * plane);
      const { flowY, flowX, cellprob } = makeEllipsesFlowField(w, h, ellipses);
      for (let b = 0; b < batch; b++) {
        const base = b * 3 * plane;
        outF32.set(flowY, base);
        outF32.set(flowX, base + plane);
        outF32.set(cellprob, base + 2 * plane);
      }
      return {
        flows_cellprob: {
          data: float32ArrayToFloat16Bits(outF32),
          dims: [batch, 3, h, w],
        },
      };
    },
    release: vi.fn(async () => undefined),
  };
}

describe('pipelineController (ImageGrainsEngine & AnalysisSession)', () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
  });

  it('initialize() probes WebGPU, WASM SIMD, deviceMemory, and cached models', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        gpu: { requestAdapter: async () => ({}) },
        deviceMemory: 8,
      },
      configurable: true,
    });

    const engine = new ImageGrainsEngine();
    const caps = await engine.initialize();

    expect(caps.hasWebGPU).toBe(true);
    expect(typeof caps.hasWasmSimd).toBe('boolean');
    expect(caps.deviceMemoryGB).toBe(8);
    expect(Array.isArray(caps.cachedModels)).toBe(true);

    await engine.dispose();

    // navigator.gpu without an adapter must NOT be reported as WebGPU-capable.
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: { requestAdapter: async () => null }, deviceMemory: 8 },
      configurable: true,
    });
    const engine2 = new ImageGrainsEngine();
    expect((await engine2.initialize()).hasWebGPU).toBe(false);
    await engine2.dispose();
  });

  it('analyzeImage() runs U-Net pipeline, emits ordered progress, and returns AnalysisSession', async () => {
    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind) =>
        createMockSession(kind, [
          { cx: 40, cy: 40, rx: 14, ry: 10 },
          { cx: 90, cy: 80, rx: 12, ry: 12 },
        ]),
    });

    const engineStages: string[] = [];
    const unsub = engine.onProgress((stage) => engineStages.push(stage));

    const configStages: string[] = [];
    const img = makeRgbaImage(128, 128, 'uniform');
    const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy',
      model: 'unet',
      scaleMode: '1.0x',
      applyClahe: true,
      claheClipLimit: 2.0,
      onProgress: (stage) => configStages.push(stage),
    });

    expect(session).toBeInstanceOf(AnalysisSession);
    expect(session.getResult().grainCount).toBe(2);
    expect(session.getStats().totalGrains).toBe(2);
    expect(engineStages).toEqual(configStages);
    expect(configStages[0]).toBe('preprocess');
    expect(configStages).toContain('inference');
    expect(configStages).toContain('postprocess');
    expect(configStages).toContain('stats');
    expect(configStages[configStages.length - 1]).toBe('done');

    unsub();
    await engine.dispose();
  });

  it('analyzeImage() supports CP-SAM tiled inference and auto model routing', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        gpu: { requestAdapter: async () => ({}) },
        deviceMemory: 16,
      },
      configurable: true,
    });

    const requestedModels: ModelKind[] = [];
    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind) => {
        requestedModels.push(kind);
        return createMockSession(kind, [{ cx: 128, cy: 128, rx: 24, ry: 16 }]);
      },
    });
    await engine.initialize();

    const coarse = makeRgbaImage(256, 256, 'coarse');
    const session = await engine.analyzeImage(coarse, { inferencePipeline: 'legacy',
      model: 'auto',
      scaleMode: '1.0x',
    });

    expect(session.recommendation.model).toBe('cpsam');
    expect(requestedModels).toEqual(['cpsam']);
    expect(session.getResult().grainCount).toBe(1);

    await engine.dispose();
  });

  it('rescales morphometrics back to original pixels when effectiveScaleFactor < 1', async () => {
    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind) =>
        createMockSession(kind, [{ cx: 100, cy: 80, rx: 20, ry: 15 }]),
    });

    const img = makeRgbaImage(400, 320, 'uniform');
    const cal = ScaleCalibrator.calibrate(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      50,
      'mm',
    ); // 0.5 mm/px
    const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy',
      model: 'unet',
      scaleMode: '0.5x',
      calibration: cal,
    });

    expect(session.workingImage.effectiveScaleFactor).toBe(0.5);
    expect(session.workingImage.width).toBe(200);
    expect(session.workingImage.height).toBe(160);

    const grains = session.getResult().grains;
    expect(grains).toHaveLength(1);
    const g = grains[0]!;
    // Working rx=20, ry=15 -> aAxis=40, bAxis=30 in working space -> 80, 60 in original space
    expect(Math.abs(g.aAxisPx - 80)).toBeLessThan(4);
    expect(Math.abs(g.bAxisPx - 60)).toBeLessThan(4);
    expect(Math.abs(g.centroidX - 200)).toBeLessThan(2);
    expect(Math.abs(g.centroidY - 160)).toBeLessThan(2);
    expect(g.bAxisMm).toBeCloseTo(g.bAxisPx * cal.mmPerPx, 6);
    expect(session.getStats().unit).toBe('mm');

    await engine.dispose();
  });

  it('AnalysisSession supports interactive split, add, delete, merge, undo/redo, subscribe, calibration, border toggle, and all exports', async () => {
    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind) =>
        createMockSession(kind, [
          { cx: 50, cy: 50, rx: 25, ry: 12 },
          { cx: 120, cy: 50, rx: 14, ry: 12 },
          { cx: 120, cy: 110, rx: 14, ry: 12 },
          { cx: 3, cy: 80, rx: 8, ry: 8 }, // border-touching grain
        ]),
    });

    const img = makeRgbaImage(160, 160, 'uniform');
    const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy',
      model: 'unet',
      scaleMode: '1.0x',
      excludeBorder: true,
    });

    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
    expect(session.undo()).toBe(false);
    expect(session.redo()).toBe(false);
    expect(session.getResult().grainCount).toBe(4);
    expect(session.getStats().excludedBorderGrains).toBe(1);
    expect(session.getStats().includedGrains).toBe(3);

    const notifications: number[] = [];
    const unsub = session.subscribe((s) => {
      notifications.push(s.getResult().grainCount);
    });

    // Split elongated grain #1
    const firstId = session.getResult().grains.find((g) => !g.touchesBorder)!.id;
    expect(
      session.splitGrainAtLine(firstId, [
        { x: 50, y: 30 },
        { x: 50, y: 70 },
      ]),
    ).toBe(true);
    expect(session.getResult().grainCount).toBe(5);
    expect(session.canUndo).toBe(true);
    expect(session.canRedo).toBe(false);

    // Add polygon grain
    const addedId = session.addPolygonGrain([
      { x: 20, y: 115 },
      { x: 45, y: 115 },
      { x: 45, y: 140 },
      { x: 20, y: 140 },
    ]);
    expect(addedId).toBeGreaterThan(0);
    expect(session.getResult().grainCount).toBe(6);

    // Delete & Undo & Redo
    expect(session.deleteGrain(addedId)).toBe(true);
    expect(session.getResult().grainCount).toBe(5);
    expect(session.undo()).toBe(true);
    expect(session.getResult().grainCount).toBe(6);
    expect(session.canRedo).toBe(true);
    expect(session.redo()).toBe(true);
    expect(session.getResult().grainCount).toBe(5);

    // Merge two interior grains
    const interiorIds = session
      .getResult()
      .grains.filter((g) => !g.touchesBorder)
      .slice(0, 2)
      .map((g) => g.id);
    expect(session.mergeGrains(interiorIds)).toBe(true);
    expect(session.getResult().grainCount).toBe(4);

    // Border toggle
    session.setExcludeBorder(false);
    expect(session.getStats().excludedBorderGrains).toBe(0);
    expect(session.getStats().includedGrains).toBe(4);

    // Calibrate scale
    const cal = session.calibrateScale({ x: 0, y: 0 }, { x: 10, y: 0 }, 2, 'cm'); // 20 mm / 10 px = 2 mm/px
    expect(cal.mmPerPx).toBeCloseTo(2, 6);
    expect(session.getStats().unit).toBe('mm');
    expect(session.getStats().folkWard).not.toBeNull();
    expect(session.getStats().wentworth).not.toBeNull();

    // Exports
    const csv = session.exportCsv();
    expect(csv.split('\n')).toHaveLength(5); // header + 4 grains
    expect(csv).toContain('b_axis_mm');

    const summaryJson = JSON.parse(session.exportSummaryJson()) as {
      unit: string;
      totalGrains: number;
    };
    expect(summaryJson.unit).toBe('mm');
    expect(summaryJson.totalGrains).toBe(4);

    const summaryCsv = session.exportSummaryCsv();
    expect(summaryCsv).toContain('area_weighted_b,D50');
    expect(summaryCsv).toContain('folk_ward,mean_phi');
    expect(summaryCsv).toContain('wentworth,');

    const png16 = session.exportMaskPng(16);
    expect(Array.from(png16.subarray(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    const png32 = session.exportMaskPng(32);
    expect(Array.from(png32.subarray(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);

    const geojson = JSON.parse(session.exportGeoJson()) as {
      type: string;
      features: Array<{ properties: Record<string, unknown> }>;
    };
    expect(geojson.type).toBe('FeatureCollection');
    expect(geojson.features).toHaveLength(4);
    expect(geojson.features[0]?.properties['bAxisMm']).toBeTypeOf('number');

    const svg = session.exportSvg();
    expect(svg).toContain('<svg');
    expect(svg).toContain('data-grain-id=');

    expect(notifications.length).toBeGreaterThanOrEqual(7);
    unsub();
    await engine.dispose();
  });

  it('aborts immediately on pre-aborted AbortSignal and mid-flight abort', async () => {
    const preAc = new AbortController();
    preAc.abort();

    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind) =>
        createMockSession(kind, [{ cx: 32, cy: 32, rx: 10, ry: 10 }]),
    });

    const img = makeRgbaImage(64, 64, 'uniform');
    await expect(
      engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet', signal: preAc.signal }),
    ).rejects.toThrow(/abort/i);

    // Mid-flight abort during sessionFactory
    const midAc = new AbortController();
    const midEngine = new ImageGrainsEngine({
      sessionFactory: async (kind) => {
        midAc.abort();
        return createMockSession(kind, [{ cx: 32, cy: 32, rx: 10, ry: 10 }]);
      },
    });

    await expect(
      midEngine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet', signal: midAc.signal }),
    ).rejects.toThrow(/abort/i);

    await engine.dispose();
    await midEngine.dispose();
  });

  it('executes post-processing via workerFactory when provided and terminates worker on dispose()', async () => {
    const terminateMock = vi.fn();
    const listeners = new Map<string, Set<(ev: unknown) => void>>();

    const mockWorker = {
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
      postMessage(msg: WorkerRequest, _transfer?: Transferable[]) {
        queueMicrotask(() => {
          const result = flowsToMasksBrowser(
            msg.flowY,
            msg.flowX,
            msg.cellprob,
            msg.width,
            msg.height,
            msg.options,
          );
          const progressResp: WorkerResponse = {
            type: 'progress',
            requestId: msg.requestId,
            stage: 'euler',
            percent: 50,
          };
          const resultResp: WorkerResponse = {
            type: 'result',
            requestId: msg.requestId,
            result,
          };
          for (const fn of listeners.get('message') ?? []) {
            fn({ data: progressResp });
            fn({ data: resultResp });
          }
        });
      },
      terminate: terminateMock,
    } as unknown as Worker;

    const workerFactory = vi.fn(() => mockWorker);

    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind) =>
        createMockSession(kind, [{ cx: 32, cy: 32, rx: 12, ry: 10 }]),
      workerFactory,
    });

    const img = makeRgbaImage(64, 64, 'uniform');
    const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy',
      model: 'unet',
      scaleMode: '1.0x',
    });

    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(session.getResult().grainCount).toBe(1);

    await engine.dispose();
    expect(terminateMock).toHaveBeenCalledTimes(1);
  });

  it('chooses the Cellpose-SAM weight file (auto: FP16 on a float16 GPU, INT8 on CPU) and records it', async () => {
    const fakeSession = (): InferenceSessionLike => ({
      async run(feeds: Record<string, unknown>) {
        const t = feeds['image'] as { dims: readonly number[] };
        const n = (t.dims[2] ?? 0) * (t.dims[3] ?? 0);
        return { flows_cellprob: { data: new Float32Array(3 * n).fill(-5), dims: [1, 3, t.dims[2] ?? 0, t.dims[3] ?? 0] } };
      },
    });
    const requested: string[] = [];
    const factory = async (_kind: string, modelId: string) => {
      requested.push(modelId);
      return fakeSession();
    };
    const img = makeRgbaImage(64, 64, 'uniform');

    // No WebGPU: auto -> INT8.
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const cpu = new ImageGrainsEngine({ sessionFactory: factory });
    await cpu.initialize();
    const a = await cpu.analyzeImage(img, { model: 'cpsam', scaleMode: '1.0x' });
    expect(a.getProvenance()?.modelId).toBe('ig2_cpsam_int8_wo_fp32scale');
    const b = await cpu.analyzeImage(img, { model: 'cpsam', scaleMode: '1.0x', cpsamWeights: 'fp4' });
    expect(b.getProvenance()?.modelId).toBe('ig2_cpsam_fp4_e2m1_lut');
    const c = await cpu.analyzeImage(img, { model: 'unet', scaleMode: '1.0x', cpsamWeights: 'fp4' });
    expect(c.getProvenance()?.modelId).toBe('ig2_unet_fp32');
    await cpu.dispose();

    // WebGPU adapter with shader-f16: auto -> FP16; explicit INT8 still honoured.
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: { requestAdapter: async () => ({ features: { has: (f: string) => f === 'shader-f16' } }) } },
      configurable: true,
    });
    const gpu = new ImageGrainsEngine({ sessionFactory: factory });
    await gpu.initialize();
    const d = await gpu.analyzeImage(img, { model: 'cpsam', scaleMode: '1.0x' });
    expect(d.getProvenance()?.modelId).toBe('ig2_cpsam_fp16');
    const e = await gpu.analyzeImage(img, { model: 'cpsam', scaleMode: '1.0x', cpsamWeights: 'int8' });
    expect(e.getProvenance()?.modelId).toBe('ig2_cpsam_int8_wo_fp32scale');
    await gpu.dispose();

    // Phone with a float16 GPU: Auto weights -> INT8, and a warning is emitted.
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile',
        gpu: { requestAdapter: async () => ({ features: { has: (f: string) => f === 'shader-f16' } }) },
      },
      configurable: true,
    });
    const phone = new ImageGrainsEngine({ sessionFactory: factory });
    await phone.initialize();
    const warnings: string[] = [];
    const f = await phone.analyzeImage(img, {
      model: 'cpsam',
      scaleMode: '1.0x',
      onProgress: (stage, d) => {
        if (stage === 'warning') warnings.push(String((d as { code?: string }).code));
      },
    });
    expect(f.getProvenance()?.modelId).toBe('ig2_cpsam_int8_wo_fp32scale');
    expect(warnings).toContain('cpsam-mobile');
    await phone.dispose();
    requested.pop();

    // One session per weight file.
    expect(requested).toEqual([
      'ig2_cpsam_int8_wo_fp32scale',
      'ig2_cpsam_fp4_e2m1_lut',
      'ig2_unet_fp32',
      'ig2_cpsam_fp16',
      'ig2_cpsam_int8_wo_fp32scale',
    ]);
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  });

  it('skips tiles outside the ROI, records the analysed area, and flags a later larger ROI', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    let calls = 0;
    const session = (): InferenceSessionLike => ({
      async run(feeds: Record<string, unknown>) {
        calls++;
        const t = feeds['image'] as { dims: readonly number[] };
        const n = (t.dims[2] ?? 0) * (t.dims[3] ?? 0);
        return { flows_cellprob: { data: new Float32Array(3 * n).fill(-5), dims: [1, 3, t.dims[2] ?? 0, t.dims[3] ?? 0] } };
      },
    });
    const engine = new ImageGrainsEngine({ sessionFactory: async () => session() });
    await engine.initialize();
    const img = makeRgbaImage(1000, 800, 'uniform');
    const cfg = { model: 'cpsam' as const, scaleMode: '1.0x' as const };
    const full = await engine.analyzeImage(img, cfg);
    const fullCalls = calls;
    expect(full.getProvenance()?.tileSkipping).toBeUndefined();
    calls = 0;
    const roi = {
      roiPolygon: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }],
      exclusionPolygons: [],
      exclusionStrokes: [],
    };
    const part = await engine.analyzeImage(img, { ...cfg, inferenceRoi: roi });
    expect(calls).toBeLessThan(fullCalls);
    const skip = part.getProvenance()?.tileSkipping;
    expect(skip?.tilesRun).toBe(calls);
    expect(skip?.tilesTotal).toBe(fullCalls);
    part.setRoiConfig(roi);
    expect(part.getUnanalysedRoiFraction()).toBe(0);
    part.setRoiConfig(undefined); // whole photo now counted, but only the top-left was analysed
    expect(part.getUnanalysedRoiFraction()).toBeGreaterThan(0.3);
    // Survives serialisation (saved projects).
    const AnalysisSessionCtor = part.constructor as unknown as { fromSerialized: (d: unknown) => typeof part };
    expect(AnalysisSessionCtor.fromSerialized(part.toSerialized()).getProvenance()?.tileSkipping?.tilesRun).toBe(calls);
    await engine.dispose();
  });

  it('defaults to the upstream-exact Cellpose pipeline (tiles, channels, provenance)', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const calls: Array<{ dims: number[]; type: string }> = [];
    const recorder = (): InferenceSessionLike => ({
      async run(feeds: Record<string, unknown>) {
        const t = feeds['image'] as { dims: readonly number[]; type?: string; data: Float32Array | Uint16Array };
        calls.push({ dims: [...t.dims], type: t.data instanceof Uint16Array ? 'float16' : 'float32' });
        const n = (t.dims[2] ?? 0) * (t.dims[3] ?? 0);
        return { flows_cellprob: { data: new Float32Array(3 * n).fill(-5), dims: [1, 3, t.dims[2] ?? 0, t.dims[3] ?? 0] } };
      },
    });
    const engine = new ImageGrainsEngine({ sessionFactory: async () => recorder() });
    await engine.initialize();

    // U-Net: 500x500 -> resized by 17/30 to 283x283 -> Cellpose-3 tiles of 224 px, 2 channels
    const unet = await engine.analyzeImage(makeRgbaImage(500, 500, 'uniform'), { model: 'unet', scaleMode: '1.0x' });
    expect(unet.getProvenance()?.inferencePipeline).toBe('cellpose');
    expect(calls.length).toBe(4);
    for (const c of calls) expect(c).toEqual({ dims: [1, 2, 224, 224], type: 'float32' });

    // Cellpose-SAM: 300x300 -> 256 px tiles, 3 channels, float16, one tile per run
    calls.length = 0;
    const sam = await engine.analyzeImage(makeRgbaImage(300, 300, 'uniform'), { model: 'cpsam', scaleMode: '1.0x' });
    expect(sam.getProvenance()?.inferencePipeline).toBe('cellpose');
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c).toEqual({ dims: [1, 3, 256, 256], type: 'float16' });

    // Legacy remains selectable and is recorded.
    calls.length = 0;
    const legacy = await engine.analyzeImage(makeRgbaImage(64, 64, 'uniform'), { model: 'unet', scaleMode: '1.0x', inferencePipeline: 'legacy' });
    expect(legacy.getProvenance()?.inferencePipeline).toBe('legacy');
    expect(calls).toEqual([{ dims: [1, 2, 64, 64], type: 'float32' }]);
    await engine.dispose();
  });

  it('falls back to WASM for a model whose WebGPU output is numerically invalid', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } },
      configurable: true,
    });
    const created: string[] = [];
    const createSpy = vi.spyOn(ort.InferenceSession, 'create').mockImplementation((async (_b: unknown, opts?: ort.InferenceSession.SessionOptions) => {
      const ep = String(opts?.executionProviders?.[0] ?? 'wasm');
      created.push(ep);
      return {
        async run(feeds: Record<string, { dims: readonly number[] }>) {
          const d = feeds['image']!.dims; const n = d[2]! * d[3]!;
          const data = new Float32Array(3 * n).fill(-5);
          if (ep === 'webgpu') data[0] = Number.NaN; // simulated float16 overflow
          return { flows_cellprob: { data, dims: [1, 3, d[2], d[3]] } };
        },
        release: async () => undefined,
      } as unknown as ort.InferenceSession;
    }) as unknown as typeof ort.InferenceSession.create);
    const engine = new ImageGrainsEngine({ modelDownloadOptions: {} });
    const warnings: Array<{ code?: string }> = [];
    engine.onProgress((stage, detail) => { if (stage === 'warning') warnings.push(detail as { code?: string }); });
    await engine.initialize();
    const session = await engine.analyzeImage(makeRgbaImage(64, 64, 'uniform'), { model: 'unet', scaleMode: '1.0x' });
    expect(session).toBeDefined();
    expect(created).toEqual(['webgpu', 'wasm']);
    expect(warnings.some((w) => w.code === 'webgpu-numeric-instability')).toBe(true);
    // the model stays on WASM afterwards
    await engine.analyzeImage(makeRgbaImage(64, 64, 'uniform'), { model: 'unet', scaleMode: '1.0x' });
    expect(created).toEqual(['webgpu', 'wasm']);
    createSpy.mockRestore();
    await engine.dispose();
  });

  it('retries a device-lost analysis only once', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } },
      configurable: true,
    });
    let created = 0;
    const engine = new ImageGrainsEngine({
      sessionFactory: async () => {
        created += 1;
        return {
          async run() {
            throw new Error('WebGPU device was lost');
          },
        };
      },
    });
    await engine.initialize();
    await expect(
      engine.analyzeImage(makeRgbaImage(64, 64, 'uniform'), { inferencePipeline: 'legacy', model: 'unet', scaleMode: '1.0x' }),
    ).rejects.toThrow(/device lost/i);
    expect(created).toBe(2);
    await engine.dispose();
  });

  it('records hasShaderF16, supports AnalysisSession.getStats(sizeMetric), and evicts session on WebGPU device loss', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        gpu: {
          requestAdapter: async () => ({
            features: { has: (f: string) => f === 'shader-f16' },
          }),
        },
        deviceMemory: 8,
      },
      configurable: true,
    });

    let callCount = 0;
    const mockRelease = vi.fn(async () => undefined);
    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            async run() {
              throw new Error('WebGPU device was lost');
            },
            release: mockRelease,
          };
        }
        return createMockSession(kind, [{ cx: 32, cy: 32, rx: 14, ry: 8 }]);
      },
    });

    const caps = await engine.initialize();
    expect(caps.hasShaderF16).toBe(true);

    const warnings: Array<{ code?: string }> = [];
    engine.onProgress((stage, detail) => {
      if (stage === 'warning' && detail && typeof detail === 'object') {
        warnings.push(detail as { code?: string });
      }
    });

    const img = makeRgbaImage(64, 64, 'uniform');
    // Device loss: the lost session is evicted, WebGPU is disabled for the page, and the
    // same image is retried once on a fresh (WASM) session instead of failing.
    const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet', scaleMode: '1.0x' });
    expect(callCount).toBe(2);
    expect(warnings.some((w) => w.code === 'webgpu-device-lost')).toBe(true);
    expect(engine.getWebGpuDisabledReason()).toMatch(/device was lost/i);
    // WebGPU stays off for the page even though the adapter still reports shader-f16.
    const capsAfter = await engine.initialize();
    expect(capsAfter.hasWebGPU).toBe(false);
    expect(capsAfter.hasShaderF16).toBe(false);
    // Later analyses reuse the WASM session (no further session creation).
    await engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet', scaleMode: '1.0x' });
    expect(callCount).toBe(2);

    const statsFeret = session.getStats('minFeret');
    expect(statsFeret.areaWeightedMinFeret).toBeDefined();
    expect(session.exportSummaryCsv('minFeret')).toContain('area_weighted_min_feret,D50');

    await engine.dispose();
  });
});
