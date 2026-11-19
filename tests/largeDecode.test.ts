/** Regression (re-audit): very large photos are decoded within the canvas limit, results stay in photo pixels. */
import { describe, expect, it, vi } from 'vitest';
import { decodeWithinPixelLimit, MAX_DECODE_PIXELS } from '../src/modules/projectStorage.js';
import { ImageGrainsEngine, type InferenceSessionLike } from '../src/index.js';

describe('decodeWithinPixelLimit', () => {
  const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

  it('keeps photos up to the limit at full size', async () => {
    const create = vi.fn(async () => bitmap(4000, 3000));
    const b = await decodeWithinPixelLimit(new Blob([]), create);
    expect(b.width).toBe(4000);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('decodes a 24 MP photo at <= 16.7 MP with the same aspect ratio', async () => {
    const create = vi.fn(async (_b: Blob, o?: ImageBitmapOptions) =>
      o?.resizeWidth ? bitmap(o.resizeWidth, o.resizeHeight!) : bitmap(5712, 4284),
    );
    const b = await decodeWithinPixelLimit(new Blob([]), create);
    expect(b.width * b.height).toBeLessThanOrEqual(MAX_DECODE_PIXELS);
    expect(b.width / b.height).toBeCloseTo(5712 / 4284, 3);
    expect(create.mock.calls[1]![1]).toMatchObject({ resizeQuality: 'high' });
  });
});

describe('engine: originalSize', () => {
  const session = (): InferenceSessionLike => ({
    async run(feeds: Record<string, unknown>) {
      const t = feeds['image'] as { dims: readonly number[] };
      const n = (t.dims[2] ?? 0) * (t.dims[3] ?? 0);
      return { flows_cellprob: { data: new Float32Array(3 * n).fill(-5), dims: [1, 3, t.dims[2] ?? 0, t.dims[3] ?? 0] } };
    },
  });
  const img = (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(120), width: w, height: h });

  it('reports a shrunk decode in the photo\'s own pixels and records the decoded size', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const engine = new ImageGrainsEngine({ sessionFactory: async () => session() });
    const s = await engine.analyzeImage(img(400, 300), { model: 'unet', scaleMode: '1.0x', originalSize: { width: 800, height: 600 } });
    expect(s.workingImage.originalWidth).toBe(800);
    expect(s.workingImage.effectiveScaleFactor).toBeCloseTo(0.5, 12);
    expect(s.getProvenance()?.decodedSize).toEqual({ width: 400, height: 300 });
    await engine.dispose();
  });

  it('ignores an originalSize that is not a proportional enlargement', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const engine = new ImageGrainsEngine({ sessionFactory: async () => session() });
    const same = await engine.analyzeImage(img(400, 300), { model: 'unet', scaleMode: '1.0x', originalSize: { width: 400, height: 300 } });
    expect(same.workingImage.effectiveScaleFactor).toBe(1);
    const rotated = await engine.analyzeImage(img(400, 300), { model: 'unet', scaleMode: '1.0x', originalSize: { width: 600, height: 800 } });
    expect(rotated.workingImage.effectiveScaleFactor).toBe(1);
    expect(rotated.getProvenance()?.decodedSize).toBeUndefined();
    await engine.dispose();
  });
});
