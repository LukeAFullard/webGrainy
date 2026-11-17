import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/pipelineController.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { buildSiteInputs, computeWorkspaceReports, effectiveRoi } from '../src/modules/siteWorkspace.js';
import type { PhotoRecord } from '../src/modules/projectStorage.js';

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

describe('site workspace', () => {
  const roi = { exclusionPolygons: [], exclusionStrokes: [], maxExcludedFraction: 0.5 };
  const photos = [
    { photoId: 'a', label: 'A', included: true, roiConfig: roi, faciesWeight: 2 },
    { photoId: 'b', label: 'B', included: false },
    { photoId: 'c', label: 'C (not analysed)', included: true },
  ] as unknown as PhotoRecord[];
  const sessions = new Map([['a', session()], ['b', session()]]);

  it('applies the site-wide exclusion tolerance to each photo ROI', () => {
    expect(effectiveRoi(photos[0], { maxExcludedFraction: 0.2 })?.maxExcludedFraction).toBe(0.2);
    expect(effectiveRoi(photos[1], { maxExcludedFraction: 0.2 })).toBeUndefined();
  });

  it('builds one input per analysed photo, keeping inclusion and facies weight', () => {
    const inputs = buildSiteInputs({ photos, sessions, siteOptions: { maxExcludedFraction: 0.1 } });
    expect(inputs.map((i) => [i.photoId, i.included, i.faciesWeight])).toEqual([['a', true, 2], ['b', false, undefined]]);
    expect(inputs[0]!.roiConfig?.maxExcludedFraction).toBe(0.1);
  });

  it('computes the active photo stats and the site report, or the reason it failed', () => {
    const ok = computeWorkspaceReports({ photos, sessions, activePhotoId: 'a', siteOptions: { poolingMode: 'physical-area', unit: 'px', bootstrapReplicates: 20 } });
    expect(ok.singlePhotoStats?.includedGrains).toBeGreaterThan(0);
    expect(ok.siteReport?.includedPhotoCount).toBe(1);
    expect(ok.siteReportError).toBeNull();
    const mm = computeWorkspaceReports({ photos, sessions, activePhotoId: null, siteOptions: { poolingMode: 'physical-area', bootstrapReplicates: 20 } });
    expect(mm.siteReport).toBeNull();
    expect(mm.siteReportError).toMatch(/calibrat/i);
  });
});
