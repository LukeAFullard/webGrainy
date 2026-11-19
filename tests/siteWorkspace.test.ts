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

  it('applies minBaxisPx and minSizeMm cutoffs consistently to single-photo stats', () => {
    const s = session();
    // Grain 1 is ~15x20 (bAxis ~17px), Grain 2 is ~20x30 (bAxis ~23px).
    const loose = computeWorkspaceReports({
      photos,
      sessions: new Map([['a', s]]),
      activePhotoId: 'a',
      siteOptions: { poolingMode: 'physical-area', unit: 'px', minBaxisPx: 5, bootstrapReplicates: 10 },
    });
    expect(loose.singlePhotoStats?.includedGrains).toBe(2);
    expect(loose.singlePhotoStats?.excludedCutoffGrains).toBe(0);
    expect(loose.siteReport?.validGrainCount).toBe(2);

    const strict = computeWorkspaceReports({
      photos,
      sessions: new Map([['a', s]]),
      activePhotoId: 'a',
      siteOptions: { poolingMode: 'physical-area', unit: 'px', minBaxisPx: 20, bootstrapReplicates: 10 },
    });
    expect(strict.singlePhotoStats?.includedGrains).toBe(1);
    expect(strict.singlePhotoStats?.excludedCutoffGrains).toBe(1);
    expect(strict.siteReport?.validGrainCount).toBe(1);
  });
});
