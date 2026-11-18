import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/pipelineController.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { ScaleCalibrator } from '../src/modules/interactiveEditor.js';

function session(): AnalysisSession {
  const w = 80, h = 60;
  const masks = new Int32Array(w * h);
  for (let y = 10; y < 25; y++) for (let x = 10; x < 30; x++) masks[y * w + x] = 1;
  for (let y = 30; y < 50; y++) for (let x = 40; x < 70; x++) masks[y * w + x] = 2;
  return new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: 'full' } as never,
    recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
    masks,
    workingGrains: computeGrainMorphometrics(masks, w, h, 2),
  });
}

describe('session caches', () => {
  it('reuses derived values until the results change, then recomputes them', () => {
    const s = session();
    const ext1 = s.getExtendedGrains();
    expect(s.getExtendedGrains()).toBe(ext1); // cached
    expect(s.getExtendedGrain(1)?.perimeterMm).toBeUndefined();
    const fabric1 = s.getFabricRose();
    expect(s.getFabricRose()).toBe(fabric1);
    expect(s.getRoiFilterResult()).toBeNull();

    // Calibrating changes the results: mm values appear.
    s.setCalibration(ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 'mm'));
    expect(s.getExtendedGrains()).not.toBe(ext1);
    expect(s.getExtendedGrain(1)?.perimeterMm).toBeGreaterThan(0);

    // Setting an ROI that leaves out grain 2 changes the ROI result and the fabric grain count.
    s.setRoiConfig({
      roiPolygon: [{ x: 0, y: 0 }, { x: 35, y: 0 }, { x: 35, y: 28 }, { x: 0, y: 28 }],
      exclusionPolygons: [],
      exclusionStrokes: [],
    });
    expect(s.getRoiFilterResult()?.includedGrains.map((g) => g.id)).toEqual([1]);
    expect(s.getFabricRose().grainCount).toBe(1);
    // The aspect-ratio chart uses the same counted grains as n in the statistics.
    expect(s.getExtendedStatsGrains().map((g) => g.id)).toEqual([1]);
    expect(s.getStats().includedGrains).toBe(1);
    expect(s.getExtendedGrains().length).toBe(2);
  });
});

describe('fine-grain hint', () => {
  function sessionWith(side: number, modelId: string, fineGrainUpscale?: number): AnalysisSession {
    const w = 200, h = 200;
    const masks = new Int32Array(w * h);
    let id = 0;
    for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 6; gx++) {
      id++;
      for (let y = 5 + gy * 30; y < 5 + gy * 30 + side; y++) for (let x = 5 + gx * 30; x < 5 + gx * 30 + side; x++) masks[y * w + x] = id;
    }
    return new AnalysisSession({
      workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: 'full' } as never,
      recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
      masks,
      workingGrains: computeGrainMorphometrics(masks, w, h, 2),
      provenance: { appVersion: 't', ortVersion: 't', analyzedAt: '', modelId, modelFile: '', modelRevision: '', modelSha256: '', ...(fineGrainUpscale ? { fineGrainUpscale } : {}) } as never,
    });
  }
  it('suggests enlarging only for fine U-Net results that are not enlarged yet', () => {
    expect(sessionWith(10, 'ig2_unet_fp32').getFineGrainHint().suggest).toBe(true); // b ≈ 11.5 px
    expect(sessionWith(25, 'ig2_unet_fp32').getFineGrainHint().suggest).toBe(false); // coarse
    expect(sessionWith(10, 'ig2_cpsam_int8_wo_fp32scale').getFineGrainHint().suggest).toBe(false); // CP-SAM
    const done = sessionWith(10, 'ig2_unet_fp32', 1.5).getFineGrainHint();
    expect(done.suggest).toBe(false);
    expect(done.enlarged).toBe(1.5);
  });
});
