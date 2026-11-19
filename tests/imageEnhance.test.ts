import { describe, expect, it, vi } from 'vitest';
import {
  deblurRichardsonLucy,
  ENHANCE_MODELS,
  enhanceImageBuffer,
  MAX_UPSCALE_OUTPUT_SIDE,
  photoUpscaleFactor,
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

function laplacianVariance(rgba: Uint8ClampedArray, w: number, h: number): number {
  const vals: number[] = [];
  const lum = (x: number, y: number): number => {
    const o = (y * w + x) * 4;
    return 0.2126 * rgba[o]! + 0.7152 * rgba[o + 1]! + 0.0722 * rgba[o + 2]!;
  };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const lap = lum(x - 1, y) + lum(x + 1, y) + lum(x, y - 1) + lum(x, y + 1) - 4 * lum(x, y);
      vals.push(lap);
    }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length;
}

describe('imageEnhance', () => {
  it('pins PULSE 2x on Hugging Face with SHA-256 and configures built-in classical deblur', () => {
    expect(ENHANCE_MODELS['upscale-2x'].engine).toBe('onnx');
    expect(ENHANCE_MODELS['upscale-2x'].repoId).toBe('inYourOwnBrowser/PULSE');
    expect(ENHANCE_MODELS['upscale-2x'].scaleFactor).toBe(2);
    expect(ENHANCE_MODELS['upscale-2x'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ENHANCE_MODELS['upscale-2x'].url).toContain(ENHANCE_MODELS['upscale-2x'].revision);

    expect(ENHANCE_MODELS.deblur.engine).toBe('classical');
    expect(ENHANCE_MODELS.deblur.sizeBytes).toBe(0);
    expect(ENHANCE_MODELS.deblur.scaleFactor).toBe(1);
    expect(ENHANCE_MODELS.deblur.modelId).toBe('richardson_lucy_tv_deblur');
  });

  it('deblurRichardsonLucy leaves a uniform image unchanged and preserves alpha', async () => {
    const w = 32;
    const h = 24;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 160;
      rgba[i * 4 + 1] = 120;
      rgba[i * 4 + 2] = 80;
      rgba[i * 4 + 3] = 200;
    }

    const res = await deblurRichardsonLucy(rgba, w, h);
    expect(res.width).toBe(w);
    expect(res.height).toBe(h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      expect(Math.abs(res.data[o]! - 160)).toBeLessThanOrEqual(1);
      expect(Math.abs(res.data[o + 1]! - 120)).toBeLessThanOrEqual(1);
      expect(Math.abs(res.data[o + 2]! - 80)).toBeLessThanOrEqual(1);
      expect(res.data[o + 3]).toBe(200);
    }
  });

  it('deblurRichardsonLucy sharpens a blurred pebble scene and reduces error vs ground truth', async () => {
    const w = 64;
    const h = 64;
    // Sharp synthetic gravel: bright circular pebble on darker background.
    const sharp = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - 32;
        const dy = y - 32;
        const inside = dx * dx + dy * dy <= 14 * 14;
        const o = (y * w + x) * 4;
        sharp[o] = inside ? 210 : 70;
        sharp[o + 1] = inside ? 190 : 65;
        sharp[o + 2] = inside ? 160 : 60;
        sharp[o + 3] = 255;
      }
    }

    // Apply a 2D Gaussian blur (sigma = 1.4) to synthesize an out-of-focus photo.
    const sigma = 1.4;
    const r = 4;
    const k: number[] = [];
    let kSum = 0;
    for (let i = -r; i <= r; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k.push(v);
      kSum += v;
    }
    const kern = k.map((v) => v / kSum);
    const tmp = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let i = -r; i <= r; i++) {
            const sx = Math.max(0, Math.min(w - 1, x + i));
            acc += sharp[(y * w + sx) * 4 + c]! * kern[i + r]!;
          }
          tmp[(y * w + x) * 3 + c] = acc;
        }
      }
    }
    const blurred = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let i = -r; i <= r; i++) {
            const sy = Math.max(0, Math.min(h - 1, y + i));
            acc += tmp[(sy * w + x) * 3 + c]! * kern[i + r]!;
          }
          blurred[(y * w + x) * 4 + c] = Math.round(acc);
        }
        blurred[(y * w + x) * 4 + 3] = 255;
      }
    }

    const res = await deblurRichardsonLucy(blurred, w, h, { iterations: 10, sigma: 1.4 });
    const blurSharpness = laplacianVariance(blurred, w, h);
    const deblurSharpness = laplacianVariance(res.data, w, h);
    expect(deblurSharpness).toBeGreaterThan(blurSharpness * 1.5);

    let errBlur = 0;
    let errDeblur = 0;
    for (let i = 0; i < w * h * 4; i += 4) {
      errBlur += Math.abs(blurred[i]! - sharp[i]!);
      errDeblur += Math.abs(res.data[i]! - sharp[i]!);
    }
    expect(errDeblur).toBeLessThan(errBlur);
  });

  it('deblurRichardsonLucy stays bounded and stable on high-frequency RGB noise and honors abort', async () => {
    const w = 48;
    const h = 48;
    const noisy = new Uint8ClampedArray(w * h * 4);
    let seed = 1337;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < w * h; i++) {
      noisy[i * 4] = Math.round(115 + (rand() - 0.5) * 40);
      noisy[i * 4 + 1] = Math.round(125 + (rand() - 0.5) * 40);
      noisy[i * 4 + 2] = Math.round(135 + (rand() - 0.5) * 40);
      noisy[i * 4 + 3] = 255;
    }

    const res = await deblurRichardsonLucy(noisy, w, h);
    let sumLumIn = 0;
    let sumLumOut = 0;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      expect(res.data[o]!).toBeGreaterThanOrEqual(0);
      expect(res.data[o]!).toBeLessThanOrEqual(255);
      sumLumIn += 0.2126 * noisy[o]! + 0.7152 * noisy[o + 1]! + 0.0722 * noisy[o + 2]!;
      sumLumOut += 0.2126 * res.data[o]! + 0.7152 * res.data[o + 1]! + 0.0722 * res.data[o + 2]!;
    }
    // Mean brightness stays preserved (no explosion or washout).
    expect(Math.abs(sumLumOut / (w * h) - sumLumIn / (w * h))).toBeLessThan(5);

    const ac = new AbortController();
    ac.abort();
    await expect(deblurRichardsonLucy(noisy, w, h, { signal: ac.signal })).rejects.toThrow(/aborted/i);
  });

  it('enhanceImageBuffer runs classical deblur with zero network or ONNX calls', async () => {
    const w = 24;
    const h = 24;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(140);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sessionFactory = vi.fn();
    const fractions: number[] = [];

    const res = await enhanceImageBuffer(rgba, w, h, 'deblur', {
      sessionFactory,
      onProgress: (ev) => fractions.push(ev.fraction),
    });

    expect(res.width).toBe(w);
    expect(res.height).toBe(h);
    expect(res.spec.modelId).toBe('richardson_lucy_tv_deblur');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    fetchSpy.mockRestore();
  });

  it('runs seamless 1x tiled ONNX enhancement across non-multiple-of-16 dimensions', async () => {
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

  it('rejects numerically invalid or wrong-shape output tensors so GPU fallback can trigger', async () => {
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(128);

    const nanSession: EnhanceSessionLike = {
      inputNames: ['lq'],
      outputNames: ['output'],
      run: async (feeds) => {
        const tensor = feeds['lq'] as { data: Float32Array; dims: readonly number[] };
        const bad = new Float32Array(tensor.data.length);
        bad[10] = Number.NaN;
        return { output: { data: bad, dims: tensor.dims } };
      },
    };
    await expect(
      runTiledImageEnhancement(rgba, w, h, ENHANCE_MODELS.deblur, nanSession, { tileSize: 32, overlap: 0 }),
    ).rejects.toThrow(/numerically invalid output/i);

    const explodingSession: EnhanceSessionLike = {
      inputNames: ['lq'],
      outputNames: ['output'],
      run: async (feeds) => {
        const tensor = feeds['lq'] as { data: Float32Array; dims: readonly number[] };
        const bad = new Float32Array(tensor.data.length).fill(50);
        return { output: { data: bad, dims: tensor.dims } };
      },
    };
    await expect(
      runTiledImageEnhancement(rgba, w, h, ENHANCE_MODELS.deblur, explodingSession, { tileSize: 32, overlap: 0 }),
    ).rejects.toThrow(/numerically invalid output/i);

    const wrongShapeSession: EnhanceSessionLike = {
      inputNames: ['lq'],
      outputNames: ['output'],
      run: async () => ({
        output: { data: new Float32Array(3 * 16 * 16), dims: [1, 3, 16, 16] },
      }),
    };
    await expect(
      runTiledImageEnhancement(rgba, w, h, ENHANCE_MODELS.deblur, wrongShapeSession, { tileSize: 32, overlap: 0 }),
    ).rejects.toThrow(/unexpected shape/i);
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

    // Cumulative upscale factor stays 2 even if a 1x Deblur runs after 2x Upscale.
    expect(photoUpscaleFactor({ width: 1000 })).toBe(1);
    expect(
      photoUpscaleFactor({
        width: 2000,
        originalBackup: { width: 1000 },
        metadata: { enhancement: { scaleFactor: 1 } },
      }),
    ).toBe(2);
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
