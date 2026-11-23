import { describe, expect, it } from 'vitest';
import { perfBudget } from './perfBudget.js';
import {
  applyCLAHE,
  prepareWorkingImage,
  recommendModel,
  resizeRgbaArea,
  resizeRgbaBilinear,
} from '../src/modules/imagePreprocess.js';

function makeSolidRgba(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = a;
  }
  return data;
}

describe('imagePreprocess', () => {
  describe('applyCLAHE', () => {
    it('boosts local contrast in shadowed regions while preserving alpha', () => {
      const width = 64;
      const height = 64;
      const data = new Uint8ClampedArray(width * height * 4);
      const alphas = [0, 64, 128, 255];

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const p = idx * 4;
          // Left half is dark shadow (values 10..30), right half is bright (180..220)
          const val =
            x < 32
              ? 10 + ((x + y) % 20)
              : 180 + ((x + y) % 40);
          data[p] = val;
          data[p + 1] = val;
          data[p + 2] = val;
          data[p + 3] = alphas[idx % alphas.length]!;
        }
      }

      const result = applyCLAHE({ data, width, height }, 2.0, 8);
      expect(result.width).toBe(width);
      expect(result.height).toBe(height);
      expect(result.data.length).toBe(data.length);

      // Verify alpha is preserved identically
      for (let i = 0; i < width * height; i++) {
        expect(result.data[i * 4 + 3]).toBe(data[i * 4 + 3]);
      }

      // Compute range in left shadow region before vs after CLAHE
      let minBefore = 255;
      let maxBefore = 0;
      let minAfter = 255;
      let maxAfter = 0;
      for (let y = 8; y < 56; y++) {
        for (let x = 4; x < 24; x++) {
          const p = (y * width + x) * 4;
          minBefore = Math.min(minBefore, data[p]!);
          maxBefore = Math.max(maxBefore, data[p]!);
          minAfter = Math.min(minAfter, result.data[p]!);
          maxAfter = Math.max(maxAfter, result.data[p]!);
        }
      }

      expect(maxAfter - minAfter).toBeGreaterThan(maxBefore - minBefore);
    });

    it('keeps a uniform image uniform without NaN or blow-out', () => {
      const width = 32;
      const height = 32;
      const data = makeSolidRgba(width, height, 120, 140, 160, 200);
      const result = applyCLAHE({ data, width, height }, 2.0, 8);

      for (let i = 0; i < width * height; i++) {
        const p = i * 4;
        expect(Math.abs(result.data[p]! - 120)).toBeLessThanOrEqual(2);
        expect(Math.abs(result.data[p + 1]! - 140)).toBeLessThanOrEqual(2);
        expect(Math.abs(result.data[p + 2]! - 160)).toBeLessThanOrEqual(2);
        expect(result.data[p + 3]).toBe(200);
      }
    });

    it('handles images smaller than tileGridSize', () => {
      const width = 4;
      const height = 3;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const v = i * 20;
        data[i * 4] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
      }

      const result = applyCLAHE({ data, width, height }, 2.0, 8);
      expect(result.width).toBe(4);
      expect(result.height).toBe(3);
      expect(result.data.length).toBe(4 * 3 * 4);
    });

    it('throws RangeError on invalid clipLimit, tileGridSize, or image dimensions', () => {
      const valid = makeSolidRgba(16, 16, 100, 100, 100, 255);
      expect(() => applyCLAHE({ data: valid, width: 16, height: 16 }, 0, 8)).toThrow(RangeError);
      expect(() => applyCLAHE({ data: valid, width: 16, height: 16 }, -1, 8)).toThrow(RangeError);
      expect(() => applyCLAHE({ data: valid, width: 16, height: 16 }, Number.NaN, 8)).toThrow(RangeError);
      expect(() => applyCLAHE({ data: valid, width: 16, height: 16 }, 2.0, 0)).toThrow(RangeError);
      expect(() => applyCLAHE({ data: valid, width: 16, height: 16 }, 2.0, Number.NaN)).toThrow(RangeError);

      expect(() => applyCLAHE({ data: valid, width: 0, height: 16 })).toThrow(RangeError);
      expect(() => applyCLAHE({ data: valid, width: 16, height: -4 })).toThrow(RangeError);
      expect(() => applyCLAHE({ data: new Uint8ClampedArray(10), width: 16, height: 16 })).toThrow(RangeError);
    });
  });

  describe('prepareWorkingImage', () => {
    it('keeps 1.0x in auto mode when maxDim <= 1024', () => {
      const data = makeSolidRgba(800, 600, 50, 100, 150, 255);
      const res = prepareWorkingImage(data, 800, 600, 'auto');
      expect(res.width).toBe(800);
      expect(res.height).toBe(600);
      expect(res.originalWidth).toBe(800);
      expect(res.originalHeight).toBe(600);
      expect(res.effectiveScaleFactor).toBe(1);
      expect(res.scaleModeApplied).toBe('1.0x');
      expect(res.data[0]).toBe(50);
    });

    it('downscales in auto mode when maxDim > 1024', () => {
      const data2048 = makeSolidRgba(2048, 1024, 90, 80, 70, 255);
      const resHalf = prepareWorkingImage(data2048, 2048, 1024, 'auto');
      expect(resHalf.width).toBe(1024);
      expect(resHalf.height).toBe(512);
      expect(resHalf.effectiveScaleFactor).toBeCloseTo(0.5, 6);
      expect(resHalf.scaleModeApplied).toBe('0.5x');

      // Longest side 1024 px (not the old quarter-size band, which gave 800 px).
      const data3200 = makeSolidRgba(3200, 2400, 90, 80, 70, 255);
      const resQuarter = prepareWorkingImage(data3200, 3200, 2400, 'auto');
      expect(resQuarter.width).toBe(1024);
      expect(resQuarter.height).toBe(768);
      expect(resQuarter.effectiveScaleFactor).toBeCloseTo(0.32, 6);
      expect(resQuarter.scaleModeApplied).toBe('0.25x');

      const data5000 = makeSolidRgba(5000, 4000, 90, 80, 70, 255);
      const resMax = prepareWorkingImage(data5000, 5000, 4000, 'auto');
      expect(Math.max(resMax.width, resMax.height)).toBeLessThanOrEqual(1024);
      expect(resMax.effectiveScaleFactor).toBeCloseTo(resMax.width / 5000, 6);
      expect(resMax.scaleModeApplied).toBe('0.25x');
    });

    it('respects explicit 1.0x, 0.5x, and 0.25x scale modes', () => {
      const data = makeSolidRgba(400, 200, 12, 34, 56, 255);

      const r1 = prepareWorkingImage(data, 400, 200, '1.0x');
      expect(r1.width).toBe(400);
      expect(r1.height).toBe(200);
      expect(r1.effectiveScaleFactor).toBe(1);
      expect(r1.scaleModeApplied).toBe('1.0x');

      const r05 = prepareWorkingImage(data, 400, 200, '0.5x');
      expect(r05.width).toBe(200);
      expect(r05.height).toBe(100);
      expect(r05.effectiveScaleFactor).toBeCloseTo(0.5, 6);
      expect(r05.scaleModeApplied).toBe('0.5x');

      const r025 = prepareWorkingImage(data, 400, 200, '0.25x');
      expect(r025.width).toBe(100);
      expect(r025.height).toBe(50);
      expect(r025.effectiveScaleFactor).toBeCloseTo(0.25, 6);
      expect(r025.scaleModeApplied).toBe('0.25x');
      expect(r025.data[0]).toBe(12);
      expect(r025.data[1]).toBe(34);
      expect(r025.data[2]).toBe(56);
    });
  });

  describe('regression: anti-aliased downscaling', () => {
    // 1-px white vertical lines every 8 px on black (e.g. thin grain gaps / edges).
    const W = 400;
    const H = 200;
    const lines = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const v = x % 8 === 0 ? 255 : 0;
        lines[o] = v;
        lines[o + 1] = v;
        lines[o + 2] = v;
        lines[o + 3] = 255;
      }
    }
    const meanRed = (d: Uint8ClampedArray): number => {
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i]!;
      return s / (d.length / 4);
    };

    it('prepareWorkingImage preserves the mean intensity of fine detail at 0.25x', () => {
      const r = prepareWorkingImage(lines, W, H, '0.25x');
      expect(meanRed(r.data)).toBeCloseTo(255 / 8, 0);
      // Each output column covers 4 source columns: every other one contains a line (255/4).
      expect(r.data[0]).toBe(64);
      expect(r.data[4]).toBe(0);
    });

    it('bilinear point sampling would drop the lines entirely (why area averaging is used)', () => {
      expect(meanRed(resizeRgbaBilinear(lines, W, H, W / 4, H / 4))).toBe(0);
    });

    it('area resampling handles non-integer factors and keeps a flat image flat', () => {
      const flat = makeSolidRgba(1000, 750, 90, 120, 200, 255);
      const out = resizeRgbaArea(flat, 1000, 750, 333, 250);
      for (let i = 0; i < out.length; i += 4) {
        expect(out[i]).toBe(90);
        expect(out[i + 1]).toBe(120);
        expect(out[i + 2]).toBe(200);
        expect(out[i + 3]).toBe(255);
      }
      const r = resizeRgbaArea(lines, W, H, 123, 61);
      expect(Math.abs(meanRed(r) - 255 / 8)).toBeLessThan(1.5);
    });
  });

  describe('recommendModel', () => {
    it('executes in < 5 ms on a 256x256 image', () => {
      const width = 256;
      const height = 256;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const v = (i * 17) & 255;
        data[i * 4] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
      }

      // Warm up V8 JIT with 5 calls, then measure
      for (let w = 0; w < 5; w++) {
        recommendModel(data, width, height, { hasWebGPU: true, deviceMemoryGB: 8 });
      }
      const rec = recommendModel(data, width, height, {
        hasWebGPU: true,
        deviceMemoryGB: 8,
      });

      expect(rec.metrics.elapsedMs).toBeLessThan(perfBudget(5));
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
      expect(rec.rationale.length).toBeGreaterThan(10);
    });

    it('falls back to globalThis.navigator when capabilities argument is omitted', () => {
      const data = makeSolidRgba(32, 32, 128, 128, 128, 255);
      const rec = recommendModel(data, 32, 32);
      expect(typeof rec.metrics.hasWebGPU).toBe('boolean');
      expect(rec.metrics.deviceMemoryGB === null || typeof rec.metrics.deviceMemoryGB === 'number').toBe(true);
      expect(rec.model === 'unet' || rec.model === 'cpsam').toBe(true);
    });

    it('recommends unet when WebGPU is unavailable or memory is low', () => {
      const width = 256;
      const height = 256;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = (y * width + x) * 4;
          const v = ((x ^ y) * 13) & 255;
          data[p] = v;
          data[p + 1] = v;
          data[p + 2] = v;
          data[p + 3] = 255;
        }
      }

      const noGpu = recommendModel(data, width, height, {
        hasWebGPU: false,
        deviceMemoryGB: 16,
      });
      expect(noGpu.model).toBe('unet');
      expect(noGpu.metrics.hasWebGPU).toBe(false);

      const lowMem = recommendModel(data, width, height, {
        hasWebGPU: true,
        deviceMemoryGB: 2,
      });
      expect(lowMem.model).toBe('unet');
      expect(lowMem.metrics.deviceMemoryGB).toBe(2);
    });

    it('distinguishes uniform images (unet) from heterogeneous images (cpsam) when WebGPU is present', () => {
      const width = 256;
      const height = 256;
      const uniform = makeSolidRgba(width, height, 128, 128, 128, 255);
      const recUniform = recommendModel(uniform, width, height, {
        hasWebGPU: true,
        deviceMemoryGB: 8,
      });
      expect(recUniform.model).toBe('unet');
      expect(recUniform.metrics.sobelEntropy).toBe(0);
      expect(recUniform.metrics.multiScaleContrastVar).toBe(0);

      // Heterogeneous boulder/shadow/glare image with varying block contrasts
      const hetero = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = (y * width + x) * 4;
          const blockX = Math.floor(x / 32);
          const blockY = Math.floor(y / 32);
          let v: number;
          if ((blockX + blockY) % 2 === 0) {
            // Smooth shadow block
            v = 15 + ((x + y) % 8);
          } else {
            // High-contrast textured clast block with specular glare
            v = Math.round(127.5 + 127.5 * Math.sin(x * 0.45) * Math.cos(y * 0.37));
          }
          hetero[p] = v;
          hetero[p + 1] = v;
          hetero[p + 2] = v;
          hetero[p + 3] = 255;
        }
      }

      const recHetero = recommendModel(hetero, width, height, {
        hasWebGPU: true,
        deviceMemoryGB: 16,
      });
      expect(recHetero.model).toBe('cpsam');
      expect(recHetero.metrics.sobelEntropy).toBeGreaterThan(1.5);
      expect(recHetero.metrics.multiScaleContrastVar).toBeGreaterThan(0.01);
      expect(recHetero.metrics.shadowGlareRange).toBeGreaterThan(0.5);
    });
  });

  describe('input validation and model recommendation', () => {
    it('throws RangeError on 0, negative, or undersized buffers across preprocessing functions', () => {
      const smallBuf = new Uint8ClampedArray(12);
      expect(() => prepareWorkingImage(smallBuf, 0, 10)).toThrow(RangeError);
      expect(() => prepareWorkingImage(smallBuf, 10, -2)).toThrow(RangeError);
      expect(() => prepareWorkingImage(smallBuf, 4, 4)).toThrow(RangeError);

      expect(() => recommendModel(smallBuf, 0, 4)).toThrow(RangeError);
      expect(() => recommendModel(smallBuf, -1, 4)).toThrow(RangeError);
      expect(() => recommendModel(smallBuf, 4, 4)).toThrow(RangeError);
    });

    it('recommends unet when WebGPU adapter lacks shader-f16 even on heterogeneous imagery', () => {
      const width = 96;
      const height = 96;
      const hetero = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v =
            ((x * 37 + y * 53) % 256) * ((x >> 3) % 2 === 0 ? 1 : 0.25);
          const iv = Math.max(0, Math.min(255, Math.round(v)));
          const o = (y * width + x) * 4;
          hetero[o] = iv;
          hetero[o + 1] = iv;
          hetero[o + 2] = iv;
          hetero[o + 3] = 255;
        }
      }

      const withF16 = recommendModel(hetero, width, height, {
        hasWebGPU: true,
        hasShaderF16: true,
        deviceMemoryGB: 16,
      });
      const withoutF16 = recommendModel(hetero, width, height, {
        hasWebGPU: true,
        hasShaderF16: false,
        deviceMemoryGB: 16,
      });

      expect(withF16.model).toBe('cpsam');
      expect(withF16.metrics.hasShaderF16).toBe(true);
      expect(withoutF16.model).toBe('unet');
      expect(withoutF16.metrics.hasShaderF16).toBe(false);
      expect(withoutF16.rationale).toContain('shader-f16');
    });
  });
});

describe('regression: one working-scale rule; when 2x upscaling helps', () => {
  it('workingScaleFor matches what prepareWorkingImage does', async () => {
    const { workingScaleFor } = await import('../src/modules/imagePreprocess.js');
    for (const [w, h] of [[800, 600], [1500, 1000], [3000, 2000], [6000, 4000]] as const) {
      const r = prepareWorkingImage(new Uint8ClampedArray(w * h * 4), w, h, 'auto');
      expect(r.width).toBe(Math.max(1, Math.round(w * workingScaleFor(w, h, 'auto'))));
    }
    expect(workingScaleFor(1500, 1000, 'auto')).toBeCloseTo(1024 / 1500, 12);
  });

  it('one scale label rule for analysis and imported projects', async () => {
    const { scaleModeLabel } = await import('../src/modules/imagePreprocess.js');
    expect([1, 0.68, 0.5, 0.36, 0.32, 0.25, 0.128].map(scaleModeLabel)).toEqual(['1.0x', '0.5x', '0.5x', '0.5x', '0.25x', '0.25x', '0.25x']);
  });

  it('the auto working size never falls as the photo grows (audit: 2,048 px gave 1,024, 2,100 px only 525)', async () => {
    const { workingScaleFor } = await import('../src/modules/imagePreprocess.js');
    let prev = 0;
    for (let side = 200; side <= 12000; side += 7) {
      const working = Math.round(side * workingScaleFor(side, side / 2, 'auto'));
      expect(working).toBeGreaterThanOrEqual(prev);
      expect(working).toBeLessThanOrEqual(1024);
      prev = working;
    }
  });

  it('2x upscaling only adds working pixels for small photos in auto mode, or at 1.0x', async () => {
    const { upscaleIncreasesWorkingResolution } = await import('../src/modules/imagePreprocess.js');
    expect(upscaleIncreasesWorkingResolution(500, 400, 'auto')).toBe(true);
    // Working width before -> after: 800 -> 1024 (+28%); 900 -> 1024 (+14%); 1500, 3000, 5000: 1024 -> 1024.
    expect(upscaleIncreasesWorkingResolution(800, 600, 'auto')).toBe(true);
    for (const w of [900, 1500, 3000, 5000]) expect(upscaleIncreasesWorkingResolution(w, (w * 3) / 4, 'auto')).toBe(false);
    expect(upscaleIncreasesWorkingResolution(3000, 2000, '1.0x')).toBe(true);
  });
});
