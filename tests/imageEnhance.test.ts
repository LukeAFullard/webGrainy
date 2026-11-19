import { describe, expect, it, vi } from 'vitest';
import {
  ENHANCE_MODELS,
  MAX_UPSCALE_OUTPUT_SIDE,
  runTiledImageEnhancement,
  scaleCalibrationAndRoi,
  type EnhanceSessionLike,
} from '../src/modules/imageEnhance.js';
import { ImageGrainsEngine } from '../src/modules/engine.js';
import { buildSiteReportHtml } from '../src/ui/report.js';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { analyzeSite, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import type { SiteRecord } from '../src/modules/projectStorage.js';
import type { CalibrationResult } from '../src/types/index.js';
import type { RoiExclusionConfig } from '../src/modules/roiAndRectify.js';

describe('imageEnhance', () => {
  it('pins both inYourOwnBrowser Hugging Face repos with immutable revisions and SHA-256 hashes', () => {
    expect(ENHANCE_MODELS['upscale-2x'].repoId).toBe('inYourOwnBrowser/PULSE');
    expect(ENHANCE_MODELS['upscale-2x'].scaleFactor).toBe(2);
    expect(ENHANCE_MODELS['upscale-2x'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ENHANCE_MODELS['upscale-2x'].url).toContain(ENHANCE_MODELS['upscale-2x'].revision);

    expect(ENHANCE_MODELS.deblur.repoId).toBe('inYourOwnBrowser/deblurring_nafnet');
    expect(ENHANCE_MODELS.deblur.scaleFactor).toBe(1);
    expect(ENHANCE_MODELS.deblur.minTileSide).toBe(384);
    expect(ENHANCE_MODELS.deblur.defaultTileSize).toBe(384);
    expect(ENHANCE_MODELS.deblur.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ENHANCE_MODELS.deblur.url).toContain(ENHANCE_MODELS.deblur.revision);
  });

  it('pads small images up to 384x384 by default for NAFNet TLC compatibility', async () => {
    const w = 100;
    const h = 80;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(180);
    const seenDims: Array<readonly number[]> = [];
    const session: EnhanceSessionLike = {
      inputNames: ['lq'],
      outputNames: ['output'],
      run: async (feeds) => {
        const tensor = feeds['lq'] as { data: Float32Array; dims: readonly number[] };
        seenDims.push(tensor.dims);
        return { output: { data: new Float32Array(tensor.data), dims: tensor.dims } };
      },
    };
    const res = await runTiledImageEnhancement(rgba, w, h, ENHANCE_MODELS.deblur, session);
    expect(seenDims).toEqual([[1, 3, 384, 384]]);
    expect(res.width).toBe(w);
    expect(res.height).toBe(h);
    expect(res.data[0]).toBe(180);
  });

  it('runs seamless 1x tiled deblur across non-multiple-of-16 dimensions', async () => {
    const w = 70;
    const h = 50;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        rgba[o] = (x * 3) % 256;
        rgba[o + 1] = (y * 5) % 256;
        rgba[o + 2] = ((x + y) * 2) % 256;
        rgba[o + 3] = 255;
      }
    }

    const identitySession: EnhanceSessionLike = {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async (feeds) => {
        const tensor = feeds['input'] as { data: Float32Array; dims: readonly number[] };
        const [, , th, tw] = tensor.dims;
        expect(th! % 16).toBe(0);
        expect(tw! % 16).toBe(0);
        return { output: { data: new Float32Array(tensor.data), dims: tensor.dims } };
      },
    };

    const res = await runTiledImageEnhancement(rgba, w, h, ENHANCE_MODELS.deblur, identitySession, {
      tileSize: 32,
      overlap: 8,
    });
    expect(res.width).toBe(w);
    expect(res.height).toBe(h);
    for (let i = 0; i < rgba.length; i += 4) {
      expect(Math.abs(res.data[i]! - rgba[i]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(res.data[i + 1]! - rgba[i + 1]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(res.data[i + 2]! - rgba[i + 2]!)).toBeLessThanOrEqual(1);
      expect(res.data[i + 3]).toBe(255);
    }
  });

  it('runs 2x tiled upscaling and doubles output dimensions accurately', async () => {
    const w = 44;
    const h = 36;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 120;
      rgba[i * 4 + 1] = 180;
      rgba[i * 4 + 2] = 60;
      rgba[i * 4 + 3] = 255;
    }

    const upscale2xSession: EnhanceSessionLike = {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async (feeds) => {
        const tensor = feeds['input'] as { data: Float32Array; dims: readonly number[] };
        const [, , th, tw] = tensor.dims;
        const outH = th! * 2;
        const outW = tw! * 2;
        const out = new Float32Array(3 * outH * outW);
        const inPlane = th! * tw!;
        const outPlane = outH * outW;
        for (let c = 0; c < 3; c++) {
          for (let y = 0; y < outH; y++) {
            for (let x = 0; x < outW; x++) {
              const sy = y >> 1;
              const sx = x >> 1;
              out[c * outPlane + y * outW + x] = tensor.data[c * inPlane + sy * tw! + sx]!;
            }
          }
        }
        return { output: { data: out, dims: [1, 3, outH, outW] } };
      },
    };

    const res = await runTiledImageEnhancement(rgba, w, h, ENHANCE_MODELS['upscale-2x'], upscale2xSession, {
      tileSize: 32,
      overlap: 8,
    });
    expect(res.width).toBe(w * 2);
    expect(res.height).toBe(h * 2);
    expect(res.data[0]).toBe(120);
    expect(res.data[1]).toBe(180);
    expect(res.data[2]).toBe(60);
    expect(res.data[3]).toBe(255);
  });

  it('rejects 2x upscaling when output would exceed MAX_UPSCALE_OUTPUT_SIDE', async () => {
    const dummySession: EnhanceSessionLike = { run: async () => ({}) };
    await expect(
      runTiledImageEnhancement(
        new Uint8ClampedArray(4),
        MAX_UPSCALE_OUTPUT_SIDE / 2 + 1,
        100,
        ENHANCE_MODELS['upscale-2x'],
        dummySession,
      ),
    ).rejects.toThrow(/limited to inputs up to/i);
  });

  it('scales calibration and ROI geometry for 2x upscaling and leaves 1x unchanged', () => {
    const cal: CalibrationResult = {
      pointA: { x: 10, y: 20 },
      pointB: { x: 110, y: 20 },
      physicalLengthMm: 50,
      pixelDistance: 100,
      mmPerPx: 0.5,
    };
    const roi: RoiExclusionConfig = {
      roiPolygon: [{ x: 5, y: 5 }, { x: 100, y: 5 }, { x: 100, y: 100 }],
      exclusionPolygons: [[{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }]],
      exclusionStrokes: [{ radiusPx: 8, points: [{ x: 40, y: 40 }] }],
    };

    const s2 = scaleCalibrationAndRoi(cal, roi, 2);
    expect(s2.calibration?.pixelDistance).toBe(200);
    expect(s2.calibration?.mmPerPx).toBe(0.25);
    expect(s2.calibration?.pointA).toEqual({ x: 20, y: 40 });
    expect(s2.calibration?.pointB).toEqual({ x: 220, y: 40 });
    expect(s2.roiConfig?.roiPolygon?.[1]).toEqual({ x: 200, y: 10 });
    expect(s2.roiConfig?.exclusionStrokes?.[0]?.radiusPx).toBe(16);

    const s1 = scaleCalibrationAndRoi(cal, roi, 1);
    expect(s1.calibration).toBe(cal);
    expect(s1.roiConfig).toBe(roi);
  });

  it('ImageGrainsEngine.releaseSessions releases cached sessions without disposing the engine', async () => {
    const releaseSpy = vi.fn(async () => undefined);
    const engine = new ImageGrainsEngine({
      useWorker: false,
      sessionFactory: async () => ({
        run: async () => ({
          prob: { data: new Float32Array(16 * 16), dims: [1, 1, 16, 16] },
        }),
        release: releaseSpy,
      }),
    });
    await engine.initialize();
    await engine.releaseSessions();
    // Engine remains usable after releaseSessions() (not permanently disposed).
    await expect(engine.initialize()).resolves.toBeDefined();
    await engine.dispose();
  });

  it('discloses AI pre-processing enhancement in the printable report Methods summary', () => {
    const w = 80;
    const h = 80;
    const masks = new Int32Array(w * h);
    for (let y = 20; y < 50; y++) {
      for (let x = 20; x < 50; x++) {
        masks[y * w + x] = 1;
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
        modelSha256: 'abcdef123456',
      },
    });
    sess.setCalibration(cal);

    const inputs: SitePhotoInput[] = [
      { photoId: 'p1', label: 'P1.jpg', included: true, session: sess, calibration: cal } as SitePhotoInput,
    ];
    const report = analyzeSite(inputs, { poolingMode: 'physical-area', bootstrapReplicates: 10, minBaxisPx: 5 });
    const site = { siteId: 's1', name: 'Enhanced Bar', createdAt: 0, updatedAt: 0, options: {}, photoOrder: ['p1'] } as unknown as SiteRecord;

    const html = buildSiteReportHtml({
      site,
      report,
      generatedAt: '2026-11-18T12:00:00.000Z',
      metadata: { appVersion: '1.2.3', modelId: 'ig2_unet_fp32' },
      settings: [['Model', 'U-Net']],
      enhancedPhotosCount: 2,
      psdSvg: '<svg id="psd"></svg>',
      histogramSvg: null,
      photos: [{ label: 'P1.jpg', validGrainCount: 1, D50: 15, mmPerPx: 0.5, outlierReasons: [] }],
    });

    expect(html).toContain('Pre-processing enhancement');
    expect(html).toContain('Optional AI pre-processing enhancement applied to 2 photos prior to segmentation');
  });
});
