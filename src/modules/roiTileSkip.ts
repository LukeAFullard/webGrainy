/**
 * Skipping inference tiles outside the analysis ROI.
 *
 * A tile is run when it touches the valid bed area (inside the ROI and outside the
 * exclusions) grown by a safety margin. Every pixel within the margin of the valid area is
 * therefore covered only by tiles that run, so its prediction is identical to a full
 * analysis: grains whose centroid is inside the ROI keep their whole outline unless they
 * reach more than the margin beyond it.
 */
import { buildValidBedMask, type RoiExclusionConfig } from './roiAndRectify.js';

/** Margin (working-image px) around the valid area that is always analysed. */
export const ROI_TILE_MARGIN_PX = 128;

/**
 * Returns a test `(x0, y0, x1, y1) => boolean` (working-image px, end-exclusive) that is
 * true when a region needs inference, or `null` when the whole image must be analysed
 * (no ROI and no exclusions, or the grown valid area covers the whole image).
 */
export function buildRegionNeedTest(
  width: number,
  height: number,
  effectiveScaleFactor: number,
  roi: RoiExclusionConfig,
  marginPx: number = ROI_TILE_MARGIN_PX,
): ((x0: number, y0: number, x1: number, y1: number) => boolean) | null {
  const hasRoi = roi.roiPolygon !== undefined && roi.roiPolygon.length >= 3;
  const hasExcl =
    roi.exclusionPolygons.some((p) => p.length >= 3) ||
    roi.exclusionStrokes.some((s) => s.points.length > 0);
  if (!hasRoi && !hasExcl) return null;
  const { valid, validPixelCount } = buildValidBedMask(width, height, effectiveScaleFactor, roi);
  if (validPixelCount === width * height) return null;
  // Integral image of the valid mask: O(1) "any valid pixel in this rectangle?" queries.
  const W1 = width + 1;
  const integral = new Uint32Array(W1 * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += valid[y * width + x]!;
      integral[(y + 1) * W1 + x + 1] = integral[y * W1 + x + 1]! + row;
    }
  }
  const m = Math.max(0, Math.ceil(marginPx));
  return (x0, y0, x1, y1) => {
    const ax = Math.max(0, Math.floor(x0) - m);
    const ay = Math.max(0, Math.floor(y0) - m);
    const bx = Math.min(width, Math.ceil(x1) + m);
    const by = Math.min(height, Math.ceil(y1) + m);
    if (bx <= ax || by <= ay) return false;
    const sum =
      integral[by * W1 + bx]! - integral[ay * W1 + bx]! - integral[by * W1 + ax]! + integral[ay * W1 + ax]!;
    return sum > 0;
  };
}

/**
 * Fraction of the valid bed area (for `roi`) that lies outside the analysed rectangles
 * `[x0, y0, x1, y1]` (working px, end-exclusive). Non-zero after the ROI was enlarged
 * or exclusions removed following an analysis that skipped tiles.
 */
export function unanalysedValidFraction(
  width: number,
  height: number,
  effectiveScaleFactor: number,
  roi: RoiExclusionConfig | undefined,
  analysedRects: ReadonlyArray<readonly [number, number, number, number]>,
): number {
  const covered = new Uint8Array(width * height);
  for (const [x0, y0, x1, y1] of analysedRects) {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      covered.fill(1, y * width + Math.max(0, x0), y * width + Math.min(width, x1));
    }
  }
  const valid =
    roi === undefined
      ? null
      : buildValidBedMask(width, height, effectiveScaleFactor, roi).valid;
  let nValid = 0;
  let nUncovered = 0;
  for (let i = 0; i < covered.length; i++) {
    if (valid !== null && valid[i] === 0) continue;
    nValid++;
    if (covered[i] === 0) nUncovered++;
  }
  return nValid === 0 ? 0 : nUncovered / nValid;
}
