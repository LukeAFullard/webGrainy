import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  downloadModel,
  ScaleCalibrator,
  ImageGrainsEngine,
} from '../../src/index.js';
import type { GrainMorphometrics, ModelKind } from '../../src/types/index.js';
import {
  setupBrowserMocks,
  teardownBrowserMocks,
  createMockFetch,
  createMockOnnxSession,
} from './helpers/mocks.js';
import {
  createUniformGravelImage,
  createCoarseBoulderImage,
  createHarshShadowGlareImage,
  createTouchingDumbbellFlowField,
  createGiantSandSheetOutlierFlowField,
  createBorderTouchingClastFlowField,
  createIsolatedEllipsesFlowField,
} from './helpers/syntheticData.js';

describe('Tier 4: Real-World Application Scenarios — ImageGrains 2.0 Web', () => {
  beforeEach(() => {
    setupBrowserMocks();
  });

  afterEach(() => {
    teardownBrowserMocks();
  });

  it('Scenario 1: Uniform fine river gravel (512x512, no WebGPU -> U-Net, calibrated gravel-dominated Wentworth)', async () => {
    teardownBrowserMocks();
    setupBrowserMocks({ navigator: { hasWebGPU: false, deviceMemoryGB: 4 } });

    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind: ModelKind) =>
        createMockOnnxSession({
          mode: kind,
          customFlowGenerator: (w: number, h: number) =>
            createIsolatedEllipsesFlowField(w, h, [
              { cx: 120, cy: 120, rx: 14, ry: 10 },
              { cx: 260, cy: 150, rx: 16, ry: 12 },
              { cx: 380, cy: 320, rx: 12, ry: 9 },
              { cx: 180, cy: 390, rx: 15, ry: 11 },
            ]),
        }),
    });
    await engine.initialize();

    const gravel = createUniformGravelImage(512, 512);
    // 1 px = 0.5 mm => bAxis ~ 18-24 px => 9-12 mm (fine/medium gravel: 2-64 mm)
    const calibration = ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 200, y: 0 }, 100, 'mm');

    const session = await engine.analyzeImage(gravel, { inferencePipeline: 'legacy',
      model: 'auto',
      scaleMode: '1.0x',
      calibration,
      excludeBorder: true,
    });

    expect(session.recommendation.model).toBe('unet');
    const stats = session.getStats();
    expect(stats.unit).toBe('mm');
    expect(stats.includedGrains).toBe(4);
    expect(stats.wentworth!.gravelPct).toBeCloseTo(100, 3);
    expect(stats.folkWard).not.toBeNull();
  });

  it('Scenario 2: Coarse cobble & boulder field photo (1600x1200 > 1024px, harsh shadows -> CLAHE + auto scaling + WebGPU CP-SAM)', async () => {
    const boulder = createCoarseBoulderImage(1600, 1200);
    // Inject harsh shadow/glare into upper-left quadrant
    const harsh = createHarshShadowGlareImage(1600, 1200);
    for (let i = 0; i < boulder.data.length; i += 4) {
      boulder.data[i] = Math.round(((boulder.data[i] ?? 0) + (harsh.data[i] ?? 0)) / 2);
    }

    const workingRx = 40;
    const workingRy = 25; // bAxis in working space = 50 px
    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind: ModelKind) =>
        createMockOnnxSession({
          mode: kind,
          customFlowGenerator: (w: number, h: number) =>
            createIsolatedEllipsesFlowField(w, h, [
              { cx: Math.floor(w * 0.5), cy: Math.floor(h * 0.5), rx: workingRx, ry: workingRy },
            ]),
        }),
    });
    await engine.initialize();

    const calibration = ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 200, 'mm'); // 2 mm/px on original
    const session = await engine.analyzeImage(boulder, { inferencePipeline: 'legacy',
      model: 'auto',
      scaleMode: 'auto',
      applyClahe: true,
      claheClipLimit: 2.5,
      calibration,
    });

    expect(session.recommendation.model).toBe('cpsam');
    expect(session.workingImage.effectiveScaleFactor).toBeLessThan(1.0);
    expect(Math.max(session.workingImage.width, session.workingImage.height)).toBeLessThanOrEqual(
      1024
    );

    const grains = session.getResult().grains;
    expect(grains.length).toBeGreaterThanOrEqual(1);
    const g = grains[0]!;
    const expectedOriginalBPx = (2 * workingRy) / session.workingImage.effectiveScaleFactor;
    const expectedOriginalBMm = expectedOriginalBPx * calibration.mmPerPx;
    expect(Math.abs(g.bAxisPx - expectedOriginalBPx)).toBeLessThan(4.0);
    expect(Math.abs((g.bAxisMm ?? 0) - expectedOriginalBMm)).toBeLessThan(8.0);
    expect(session.getStats().unit).toBe('mm');
  });

  it('Scenario 3: 3ca10b7c giant sand-sheet outlier rejected while touching pebble dumbbell is split', async () => {
    // 1) Giant 25% area sand-sheet outlier
    const giantEngine = new ImageGrainsEngine({
      sessionFactory: async (kind: ModelKind) =>
        createMockOnnxSession({
          mode: kind,
          customFlowGenerator: (w: number, h: number) => createGiantSandSheetOutlierFlowField(w, h, 0.25),
        }),
    });
    await giantEngine.initialize();
    const img = createUniformGravelImage(160, 160);
    const giantSession = await giantEngine.analyzeImage(img, { inferencePipeline: 'legacy',
      model: 'unet',
      scaleMode: '1.0x',
      postProcess: { maxGrainAreaFraction: 0.15 },
    });
    expect(giantSession.getResult().grainCount).toBe(0);

    // 2) Touching pebble dumbbell splits into 2 grains via F3_SplitOnFailure
    const dumbbellEngine = new ImageGrainsEngine({
      sessionFactory: async (kind: ModelKind) =>
        createMockOnnxSession({
          mode: kind,
          customFlowGenerator: (w: number, h: number) => createTouchingDumbbellFlowField(w, h),
        }),
    });
    await dumbbellEngine.initialize();
    const dumbbellSession = await dumbbellEngine.analyzeImage(img, { inferencePipeline: 'legacy',
      model: 'unet',
      scaleMode: '1.0x',
      postProcess: { flowThreshold: 0.45, maxGrainAreaFraction: 0.15, minSize: 15 },
    });
    expect(dumbbellSession.getResult().grainCount).toBe(2);
  });

  it('Scenario 4: Human-in-the-loop interactive refinement session with full export suite', async () => {
    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind: ModelKind) =>
        createMockOnnxSession({
          mode: kind,
          customFlowGenerator: (w: number, h: number) =>
            createIsolatedEllipsesFlowField(w, h, [
              { cx: 50, cy: 50, rx: 25, ry: 12 },
              { cx: 120, cy: 50, rx: 14, ry: 12 },
              { cx: 120, cy: 110, rx: 14, ry: 12 },
            ]),
        }),
    });
    await engine.initialize();

    const img = createUniformGravelImage(160, 160);
    const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet', scaleMode: '1.0x' });
    const initialCount = session.getResult().grainCount;
    expect(initialCount).toBe(3);

    // Split first elongated grain
    const firstId = session.getResult().grains[0]!.id;
    const splitOk = session.splitGrainAtLine(firstId, [
      { x: 50, y: 30 },
      { x: 50, y: 70 },
    ]);
    expect(splitOk).toBe(true);
    expect(session.getResult().grainCount).toBe(4);

    // Add a missed grain via polygon
    const addedId = session.addPolygonGrain([
      { x: 20, y: 110 },
      { x: 45, y: 110 },
      { x: 45, y: 135 },
      { x: 20, y: 135 },
    ]);
    expect(addedId).toBeGreaterThan(0);
    expect(session.getResult().grainCount).toBe(5);

    // Delete & Undo & Redo
    expect(session.deleteGrain(addedId)).toBe(true);
    expect(session.getResult().grainCount).toBe(4);
    expect(session.undo()).toBe(true);
    expect(session.getResult().grainCount).toBe(5);
    expect(session.redo()).toBe(true);
    expect(session.getResult().grainCount).toBe(4);

    // Merge two remaining grains -> back to 3 grains
    const ids = session.getResult().grains.slice(0, 2).map((g: GrainMorphometrics) => g.id);
    expect(session.mergeGrains(ids)).toBe(true);
    expect(session.getResult().grainCount).toBe(3);

    // Calibrate & Export all 5 formats reflecting final 3-grain post-edit state
    session.setCalibration(ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 10, y: 0 }, 20, 'mm'));
    const csv = session.exportCsv();
    const json = session.exportSummaryJson();
    const png = session.exportMaskPng();
    const geojson = session.exportGeoJson();
    const svg = session.exportSvg();

    expect(csv).toContain('b_axis_mm');
    expect(csv.trim().split('\n')).toHaveLength(4); // 1 header + 3 grain rows
    expect((JSON.parse(json) as Record<string, unknown>)['unit']).toBe('mm');
    expect(Array.from(png.subarray(0, 4))).toEqual([137, 80, 78, 71]);
    const parsedGeo = JSON.parse(geojson) as { type: string; features: unknown[] };
    expect(parsedGeo.type).toBe('FeatureCollection');
    expect(parsedGeo.features).toHaveLength(3);
    expect(svg).toContain('<svg');
  });

  it('Scenario 5: Offline-first cached reload + AbortSignal cancellation + border-grain filter comparison', async () => {
    // Cache model first
    globalThis.fetch = createMockFetch({ payloadBytes: new Uint8Array(16 * 1024).fill(0x55) });
    await downloadModel('ig2_unet_fp32');

    // Simulate offline environment
    globalThis.fetch = createMockFetch({ networkError: true });

    const engine = new ImageGrainsEngine({
      sessionFactory: async (kind: ModelKind) =>
        createMockOnnxSession({
          mode: kind,
          customFlowGenerator: (w: number, h: number) => createBorderTouchingClastFlowField(w, h, 1),
        }),
    });
    const initStatus = await engine.initialize();
    expect(initStatus.cachedModels.length).toBeGreaterThanOrEqual(1);

    // Verify AbortSignal cancellation
    const ac = new AbortController();
    ac.abort();
    const img = createUniformGravelImage(128, 128);
    await expect(
      engine.analyzeImage(img, { inferencePipeline: 'legacy', model: 'unet', signal: ac.signal })
    ).rejects.toThrow();

    // Run offline analysis & compare border filter toggle
    const session = await engine.analyzeImage(img, { inferencePipeline: 'legacy',
      model: 'unet',
      scaleMode: '1.0x',
      excludeBorder: true,
    });
    const statsExcluded = session.getStats();
    session.setExcludeBorder(false);
    const statsIncluded = session.getStats();

    expect(statsExcluded.excludedBorderGrains).toBe(1);
    expect(statsExcluded.includedGrains).toBe(1);
    expect(statsIncluded.includedGrains).toBe(2);
  });
});
