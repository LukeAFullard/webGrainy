import { describe, expect, it } from 'vitest';
import {
  BLUR_WARNING_THRESHOLD,
  computeBlurScoreFromRgba,
  computeEffectiveDetectionLimit,
  getPhotoQualityWarnings,
} from '../src/modules/photoQuality.js';
import { renderPsdChartSvg } from '../src/ui/charts.js';
import { buildSiteReportHtml } from '../src/ui/report.js';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { analyzeSite, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import type { SiteRecord } from '../src/modules/projectStorage.js';
import type { PsdPercentiles } from '../src/types/index.js';

describe('photoQuality', () => {
  it('scores uniform or smooth images low and sharp high-contrast patterns high', () => {
    const w = 32;
    const h = 32;
    const flat = new Uint8ClampedArray(w * h * 4).fill(128);
    expect(computeBlurScoreFromRgba(flat, w, h)).toBe(0);

    const sharp = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = (x + y) % 2 === 0 ? 240 : 15;
        const o = (y * w + x) * 4;
        sharp[o] = v;
        sharp[o + 1] = v;
        sharp[o + 2] = v;
        sharp[o + 3] = 255;
      }
    }
    expect(computeBlurScoreFromRgba(sharp, w, h)).toBeGreaterThan(BLUR_WARNING_THRESHOLD * 10);
  });

  it('flags action cameras, ultra-wide lenses, and low sharpness scores', () => {
    const gopro = getPhotoQualityWarnings({ cameraMake: 'GoPro', cameraModel: 'HERO11 Black', blurScore: 300 });
    expect(gopro.map((w) => w.kind)).toEqual(['wide-angle']);

    const ultrawide = getPhotoQualityWarnings({ cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro', focalLength35mm: 13, blurScore: 250 });
    expect(ultrawide.map((w) => w.kind)).toEqual(['wide-angle']);

    const blurry = getPhotoQualityWarnings({ cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro', focalLength35mm: 24, blurScore: 22 });
    expect(blurry.map((w) => w.kind)).toEqual(['blur']);

    const clean = getPhotoQualityWarnings({ cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro', focalLength35mm: 24, blurScore: 420 });
    expect(clean).toEqual([]);
  });

  it('computes effective detection limits in mm and px and flags D5/D16 near the floor', () => {
    const psd: PsdPercentiles = {
      D5: 4.0,
      D10: 5.0,
      D16: 5.2,
      D25: 8.0,
      D50: 18.0,
      D75: 32.0,
      D84: 45.0,
      D90: 55.0,
      D95: 70.0,
    };

    const limMm = computeEffectiveDetectionLimit(
      { minSizeWorkingPx: 30, effectiveScaleFactor: 0.5, minBaxisPx: 15, mmPerPx: 0.25 },
      psd,
    );
    expect(limMm).not.toBeNull();
    expect(limMm!.unit).toBe('mm');
    expect(limMm!.value).toBeCloseTo(3.75, 4);
    expect(limMm!.nearD5).toBe(true);
    expect(limMm!.nearD16).toBe(true);

    const limPx = computeEffectiveDetectionLimit({ minSizeWorkingPx: 30, effectiveScaleFactor: 1 });
    expect(limPx).not.toBeNull();
    expect(limPx!.unit).toBe('px');
    expect(limPx!.value).toBeCloseTo(2 * Math.sqrt(30 / Math.PI), 4);
    expect(limPx!.nearD5).toBe(false);
    expect(limPx!.nearD16).toBe(false);
  });

  it('plots the effective detection limit marker on the PSD chart SVG when inside range', () => {
    const psd: PsdPercentiles = {
      D5: 4,
      D10: 6,
      D16: 8,
      D25: 12,
      D50: 24,
      D75: 40,
      D84: 55,
      D90: 70,
      D95: 90,
    };
    const withMarker = renderPsdChartSvg({
      psd,
      unit: 'mm',
      xAxis: 'mm',
      title: 'PSD',
      detectionLimit: 5.5,
      lightTheme: true,
    });
    expect(withMarker).toContain('Min ~5.5 mm');

    const withoutMarker = renderPsdChartSvg({
      psd,
      unit: 'mm',
      xAxis: 'mm',
      title: 'PSD',
      lightTheme: true,
    });
    expect(withoutMarker).not.toContain('Min ~');
  });

  it('includes Methods summary, detection limit, resolution range, and model SHA-256 in the printable report', () => {
    const w = 120;
    const h = 100;
    const masks = new Int32Array(w * h);
    for (let i = 0; i < 6; i++) {
      const cx = 18 + (i % 3) * 38;
      const cy = 25 + Math.floor(i / 3) * 45;
      for (let y = cy - 10; y <= cy + 10; y++) {
        for (let x = cx - 10; x <= cx + 10; x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= 100) masks[y * w + x] = i + 1;
        }
      }
    }
    const cal = {
      pointA: { x: 0, y: 0 },
      pointB: { x: 100, y: 0 },
      knownLength: 50,
      unit: 'mm',
      mmPerPx: 0.5,
      pixelDistance: 100,
    } as never;
    const sess = new AnalysisSession({
      workingImage: {
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
        originalWidth: w,
        originalHeight: h,
        effectiveScaleFactor: 1,
        scaleModeApplied: 'full',
      } as never,
      recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
      masks,
      workingGrains: computeGrainMorphometrics(masks, w, h, 2),
      provenance: {
        appVersion: '1.2.3',
        ortVersion: '1.24.0',
        analyzedAt: '2026-11-18T00:00:00Z',
        modelId: 'ig2_unet_fp32',
        modelFile: 'ig2_unet_fp32.onnx',
        modelRevision: 'main',
        modelSha256: 'abcdef1234567890abcdef',
      },
    });
    sess.setCalibration(cal);

    const inputs: SitePhotoInput[] = [
      { photoId: 'p1', label: 'P1.jpg', included: true, session: sess, calibration: cal } as SitePhotoInput,
    ];
    const report = analyzeSite(inputs, { poolingMode: 'physical-area', bootstrapReplicates: 20, minBaxisPx: 5 });
    const site = { siteId: 's1', name: 'Test Bar', createdAt: 0, updatedAt: 0, options: {}, photoOrder: ['p1'] } as unknown as SiteRecord;

    const html = buildSiteReportHtml({
      site,
      report,
      generatedAt: '2026-11-18T12:00:00.000Z',
      metadata: { appVersion: '1.2.3', modelId: 'ig2_unet_fp32', modelSha256: 'abcdef1234567890abcdef' },
      settings: [['Model', 'U-Net']],
      detectionLimit: 2.5,
      manualEditsCount: 1,
      resolutionRangeMmPerPx: [0.48, 0.52],
      psdSvg: '<svg id="psd"></svg>',
      histogramSvg: null,
      photos: [{ label: 'P1.jpg', validGrainCount: 6, D50: 10, mmPerPx: 0.5, outlierReasons: [] }],
    });

    expect(html).toContain('Methods summary');
    expect(html).toContain('Detection limit (smallest grain resolved)');
    expect(html).toContain('~2.5 mm');
    expect(html).toContain('0.480–0.520 mm/px');
    expect(html).toContain('Manual outline edits applied (1 photo)');
    expect(html).toContain('abcdef1234567890');
    expect(html).toContain('ImageGrains 2.0');
  });
});
