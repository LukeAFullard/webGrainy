/** Regressions for the moderate audit findings (exports, shared rules, revert, rectification, defaults). */
import { describe, expect, it } from 'vitest';
import { analyzeSite, exportPooledGrainsCsv, exportSiteSummaryCsv, type PoolingMode, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { computeSedimentStats, grainPassesSizeCutoffs } from '../src/modules/sedimentStats.js';
import { weightedPsdPercentiles } from '../src/modules/percentiles.js';
import { revertedCalibrationAndRoi, scaleCalibrationAndRoi } from '../src/modules/imageEnhance.js';
import { rectificationCalibration } from '../src/modules/roiAndRectify.js';
import { DEFAULT_SITE_OPTIONS } from '../src/modules/siteOptions.js';
import type { CalibrationResult, GrainMorphometrics } from '../src/types/index.js';
import { squareGrainSession } from './helpers/squareSession.js';

const photos = (): SitePhotoInput[] =>
  [0, 1, 2].map((k) => ({
    photoId: `p${k}`,
    label: `p${k}.jpg`,
    included: true,
    faciesWeight: k + 1,
    session: squareGrainSession(Array.from({ length: 30 }, (_, i) => 16 + ((i * 5 + k * 3) % 23)), { w: 700, h: 700, mmPerPx: 0.3 + 0.1 * k }),
  }));

describe('pooled grains CSV stats_weight', () => {
  const modes: PoolingMode[] = ['physical-area', 'equal-photo', 'virtual-wolman-grid', 'number-weighted', 'facies-weighted'];
  for (const mode of modes) {
    it(`reproduces the site percentiles from the CSV alone (${mode})`, async () => {
      const inputs = photos();
      const r = analyzeSite(inputs, { poolingMode: mode, bootstrapReplicates: 50, minBaxisPx: 15, wolmanPointsPerPhoto: 400 });
      const lines = (await exportPooledGrainsCsv(inputs, r).text()).split('\n');
      const h = lines[0]!.split(',');
      const rows = lines.slice(1).map((l) => l.split(','));
      const size = rows.map((c) => Number(c[h.indexOf('b_axis_mm')]));
      const w = rows.map((c) => (c[h.indexOf('stats_weight')] === '' ? 0 : Number(c[h.indexOf('stats_weight')])));
      const counted = rows.filter((c) => c[h.indexOf('included_in_stats')] === 'true').length;
      expect(w.filter((x) => x > 0).length).toBeLessThanOrEqual(counted);
      const psd = weightedPsdPercentiles(size, w);
      for (const k of ['D16', 'D50', 'D84'] as const) expect(psd[k]).toBeCloseTo(r.psd[k], 9);
    });
  }
});

describe('export hygiene', () => {
  it('no "NaN" text in the site summary; unit stays mm for a calibrated photo with no counted grain', async () => {
    const inputs = photos();
    inputs.push({ photoId: 'tiny', label: 'tiny.jpg', included: true, session: squareGrainSession([8, 9, 10], { w: 200, h: 200, mmPerPx: 0.3 }) });
    const r = analyzeSite(inputs, { poolingMode: 'physical-area', bootstrapReplicates: 50, minBaxisPx: 15 });
    const csv = await exportSiteSummaryCsv(r).text();
    expect(csv).not.toMatch(/,NaN(,|$)/m);
    expect(csv).toContain('per_photo,tiny_D50,,mm');
    const s = inputs[3]!.session.getStats('bAxis', { minBaxisPx: 15 });
    expect(s.includedGrains).toBe(0);
    expect(s.unit).toBe('mm');
  });
});

describe('one size rule', () => {
  it('the mm cutoff uses a derived min-Feret size when the grain has no min-Feret mm value', () => {
    const g = { id: 1, areaPx: 100, centroidX: 0, centroidY: 0, aAxisPx: 20, bAxisPx: 10, dEqPx: 11, bAxisMm: 5, dEqMm: 5.5, minFeretPx: 8, orientationRad: 0, touchesBorder: false, bbox: [0, 0, 1, 1] } as GrainMorphometrics;
    // min Feret = 8 px x (5 mm / 10 px) = 4 mm
    expect(grainPassesSizeCutoffs(g, { minSizeMm: 4.5, sizeMetric: 'minFeret' })).toBe(false);
    expect(grainPassesSizeCutoffs(g, { minSizeMm: 3.5, sizeMetric: 'minFeret' })).toBe(true);
    expect(computeSedimentStats([g], { sizeMetric: 'minFeret', minSizeMm: 4.5 }).includedGrains).toBe(0);
  });

  it('library and app share the default site settings', () => {
    const r = analyzeSite(photos(), { poolingMode: 'physical-area' });
    expect(r.bootstrapReplicates).toBe(DEFAULT_SITE_OPTIONS.bootstrapReplicates);
    expect(r.minBaxisPx).toBe(DEFAULT_SITE_OPTIONS.minBaxisPx);
  });
});

describe('revert after a 2x upscale', () => {
  const cal = (mmPerPx: number): CalibrationResult => ({ mmPerPx, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 100 * mmPerPx, pixelDistance: 100 });
  const roi = { roiPolygon: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], exclusionPolygons: [], exclusionStrokes: [] };

  it('restores the pre-upscale values when nothing changed', () => {
    const carried = scaleCalibrationAndRoi(cal(0.5), roi, 2);
    const out = revertedCalibrationAndRoi({ width: 2000, ...carried, originalBackup: { width: 1000, calibration: cal(0.5), roiConfig: roi } });
    expect(out.calibration).toEqual(cal(0.5));
    expect(out.roiConfig).toEqual(roi);
  });

  it('keeps a scale re-measured after the upscale (scaled back), not the old one', () => {
    const remeasured = cal(0.2); // on the 2x image
    const out = revertedCalibrationAndRoi({ width: 2000, calibration: remeasured, originalBackup: { width: 1000, calibration: cal(0.5) } });
    expect(out.calibration!.mmPerPx).toBeCloseTo(0.4, 12);
  });

  it('scales back a scale set only after the upscale', () => {
    const out = revertedCalibrationAndRoi({ width: 2000, calibration: cal(0.25), originalBackup: { width: 1000 } });
    expect(out.calibration!.mmPerPx).toBeCloseTo(0.5, 12);
  });
});

describe('rectification calibration', () => {
  it('mm per output pixel from the reference width', () => {
    const c = rectificationCalibration({ roiRectInOutput: [40, 40, 1000, 800] }, 500);
    expect(c.mmPerPx).toBeCloseTo(0.5, 12);
    expect(c.source).toBe('rectification');
    expect(() => rectificationCalibration({ roiRectInOutput: [0, 0, 0, 1] }, 500)).toThrow();
  });
});
