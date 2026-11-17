import { describe, expect, it } from 'vitest';
import { runCellposeTiled, SKIPPED_CELLPROB } from '../src/modules/cellposeTiling.js';
import { buildRegionNeedTest, unanalysedValidFraction } from '../src/modules/roiTileSkip.js';
import type { RoiExclusionConfig } from '../src/modules/roiAndRectify.js';

const noRoi: RoiExclusionConfig = { exclusionPolygons: [], exclusionStrokes: [] };
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

/** A fake network whose output depends on the tile's content (like a real CNN). */
async function fakeNet(tile: Float32Array, th: number, tw: number): Promise<Float32Array> {
  const out = new Float32Array(3 * th * tw);
  let mean = 0;
  for (let i = 0; i < th * tw; i++) mean += tile[i]!;
  mean /= th * tw;
  for (let i = 0; i < th * tw; i++) {
    out[i] = tile[i]! - mean;
    out[th * tw + i] = 0.5 * tile[i]!;
    out[2 * th * tw + i] = tile[i]! * 4 - 1 + mean;
  }
  return out;
}

describe('skipping inference tiles outside the ROI', () => {
  const W = 900, H = 700;
  const img = new Float32Array(3 * H * W);
  for (let i = 0; i < img.length; i++) img[i] = ((i * 2654435761) % 1000) / 1000;

  it('needs the whole image without ROI or exclusions', () => {
    expect(buildRegionNeedTest(W, H, 1, noRoi)).toBeNull();
  });

  it('gives identical predictions within the margin of the ROI and background far outside', async () => {
    // ROI in original coords; working image at 0.5 scale.
    const scale = 0.5;
    const roi: RoiExclusionConfig = { roiPolygon: rect(100, 100, 500, 400), exclusionPolygons: [], exclusionStrokes: [] };
    const need = buildRegionNeedTest(W, H, scale, roi, 64)!;
    expect(need).not.toBeNull();
    let total = 0;
    let run: Array<[number, number, number, number]> = [];
    const full = await runCellposeTiled(img, 3, H, W, fakeNet, { version: 'v4', bsize: 256, tileOverlap: 0.25 });
    const part = await runCellposeTiled(img, 3, H, W, fakeNet, {
      version: 'v4', bsize: 256, tileOverlap: 0.25,
      needTile: (y0, x0, y1, x1) => need(x0, y0, x1, y1),
      onPlan: (p) => { total = p.total; run = p.run; },
    });
    expect(run.length).toBeLessThan(total);
    expect(run.length).toBeGreaterThan(0);
    // Working-px ROI is [50,250) x [50,200); with a 64 px margin, [0,314) x [0,264).
    const n = H * W;
    for (let y = 0; y < 264; y++) {
      for (let x = 0; x < 314; x++) {
        const i = y * W + x;
        for (let k = 0; k < 3; k++) expect(part[k * n + i]).toBe(full[k * n + i]);
      }
    }
    // Bottom-right corner is far from the ROI: skipped, so background.
    const far = (H - 1) * W + (W - 1);
    expect(part[2 * n + far]).toBe(SKIPPED_CELLPROB);
    expect(part[far]).toBe(0);
  });

  it('respects exclusions, and runs a tile that touches the grown valid area', () => {
    const roi: RoiExclusionConfig = { exclusionPolygons: [rect(0, 0, 600, 700)], exclusionStrokes: [] };
    const need = buildRegionNeedTest(W, H, 1, roi, 10)!;
    expect(need(0, 0, 200, 200)).toBe(false); // fully excluded, far from the valid area
    expect(need(400, 0, 595, 100)).toBe(true); // within 10 px of x = 600
    expect(need(700, 300, 800, 400)).toBe(true); // valid area
  });

  it('reports the share of a later, larger ROI that was not analysed', () => {
    const rects: Array<[number, number, number, number]> = [[0, 0, 450, 350]];
    const small: RoiExclusionConfig = { roiPolygon: rect(0, 0, 400, 300), exclusionPolygons: [], exclusionStrokes: [] };
    expect(unanalysedValidFraction(W, H, 1, small, rects)).toBe(0);
    const f = unanalysedValidFraction(W, H, 1, undefined, rects);
    expect(f).toBeCloseTo(1 - (450 * 350) / (W * H), 6);
  });
});

import { isMobileDevice, recommendModel } from '../src/modules/imagePreprocess.js';

describe('phones and tablets', () => {
  it('detects mobile browsers (incl. iPadOS with a Mac user agent)', () => {
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36' })).toBe(true);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(true);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(false);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156', userAgentData: { mobile: false } })).toBe(false);
    expect(isMobileDevice({ userAgent: 'x', userAgentData: { mobile: true } })).toBe(true);
  });
  it('Auto picks U-Net on mobile even with a float16 GPU', () => {
    const w = 64, h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7919) % 256;
    const desktop = recommendModel(rgba, w, h, { hasWebGPU: true, hasShaderF16: true, deviceMemoryGB: 16 });
    const phone = recommendModel(rgba, w, h, { hasWebGPU: true, hasShaderF16: true, deviceMemoryGB: 8, isMobile: true });
    expect(phone.model).toBe('unet');
    expect(phone.rationale).toMatch(/Phone/);
    expect(['unet', 'cpsam']).toContain(desktop.model);
  });
});
