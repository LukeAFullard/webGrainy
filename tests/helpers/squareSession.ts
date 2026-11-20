// Analysis sessions made of square grains laid out on a grid (for export/statistics tests).
import { AnalysisSession } from '../../src/modules/analysisSession.js';
import { computeAllGrainMorphometrics } from '../../src/modules/interactiveEditor.js';
import type { WorkingImageResult } from '../../src/types/index.js';

export function squareGrainSession(
  sides: readonly number[],
  opts: { w?: number; h?: number; mmPerPx?: number } = {},
): AnalysisSession {
  const w = opts.w ?? 600;
  const h = opts.h ?? 600;
  const masks = new Int32Array(w * h);
  let x0 = 10;
  let y0 = 10;
  let rowH = 0;
  let id = 1;
  for (const s of sides) {
    if (x0 + s + 10 > w) {
      x0 = 10;
      y0 += rowH + 10;
      rowH = 0;
    }
    if (y0 + s + 10 > h) throw new Error('grains do not fit');
    for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) masks[y * w + x] = id;
    id++;
    x0 += s + 10;
    rowH = Math.max(rowH, s);
  }
  const workingImage: WorkingImageResult = {
    data: new Uint8ClampedArray(0),
    width: w,
    height: h,
    originalWidth: w,
    originalHeight: h,
    effectiveScaleFactor: 1,
    scaleModeApplied: '1.0x',
  };
  const mm = opts.mmPerPx;
  return new AnalysisSession({
    workingImage,
    recommendation: { model: 'unet', reason: 'test', confidence: 1, metrics: {} } as never,
    masks,
    workingGrains: computeAllGrainMorphometrics(masks, w, h, 2),
    excludeBorder: true,
    borderMargin: 2,
    ...(mm
      ? { calibration: { mmPerPx: mm, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 100 * mm, pixelDistance: 100 } }
      : {}),
  });
}
