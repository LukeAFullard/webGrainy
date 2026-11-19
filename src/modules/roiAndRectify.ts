import type { GrainMorphometrics, Point2D } from '../types/index.js';
import type { ImageBufferLike } from './imagePreprocess.js';

export interface ExclusionBrushStroke {
  /** Stroke polyline vertices in original image coordinates. */
  points: Point2D[];
  /** Brush radius in original image pixels. */
  radiusPx: number;
}

export interface RoiExclusionConfig {
  /** Optional analysis ROI polygon in original image coordinates (default: full image). */
  roiPolygon?: Point2D[];
  /** Exclusion polygons in original image coordinates (rulers, coins, boots, shadows, etc.). */
  exclusionPolygons: Point2D[][];
  /** Exclusion brush strokes in original image coordinates. */
  exclusionStrokes: ExclusionBrushStroke[];
  /** Maximum fraction of a grain's pixels allowed in excluded area (default: 0.10; 0 for strict). */
  maxExcludedFraction?: number;
  /** Alias for `maxExcludedFraction`. */
  maxOverlapFraction?: number;
  /** Optional user-recorded unresolved fines/sand fraction in `[0, 1]`. */
  unresolvedFinesFraction?: number;
  /** Optional user-recorded unresolved sand/fines percentage in `[0, 100]`. */
  unresolvedSandFractionPct?: number;
}

export interface ValidBedMask {
  width: number;
  height: number;
  /** `1` = valid bed pixel (inside ROI and outside exclusions), `0` = excluded. */
  valid: Uint8Array;
  validPixelCount: number;
}

export interface ExclusionFilterResult {
  includedGrains: GrainMorphometrics[];
  excludedGrainIds: Set<number>;
  validBedMask: ValidBedMask;
  /** Valid sampled bed area in original-image px². */
  sampledBedAreaPx: number;
  /** Valid sampled bed area in mm² (when `mmPerPx` is provided). */
  sampledBedAreaMm2?: number;
  /** Percentage of sampled bed area covered by valid grains (`0..100`). */
  clastPackingPct: number;
  /** Remaining percentage of sampled bed area (`max(0, 100 - clastPackingPct)`). */
  exposedMatrixPct: number;
  /** Optional user-recorded unresolved fines fraction `[0, 1]`. */
  unresolvedFinesFraction?: number;
}

export interface HomographyInput {
  /** Four source corners ordered TL, TR, BR, BL in source image pixels. */
  srcCorners: [Point2D, Point2D, Point2D, Point2D];
  /** Physical width between TL-TR / BL-BR in mm. */
  physicalWidthMm: number;
  /** Physical height between TL-BL / TR-BR in mm. */
  physicalHeightMm: number;
  /** Target output resolution in mm/px (default: derived from mean edge pixel length). */
  targetMmPerPx?: number;
  /** Optional padding margin around the reference quad in output pixels (default: 0). */
  paddingPx?: number;
  /** Safety cap on max output dimension in pixels (default: 4096). */
  maxOutputDimPx?: number;
}

export interface RectifiedImageResult extends ImageBufferLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  mmPerPx: number;
  /** 3x3 row-major homography mapping source -> rectified output. */
  homography: Float64Array;
  /** 3x3 row-major inverse homography mapping rectified output -> source. */
  inverseHomography: Float64Array;
  /** Reference rectangle `[x, y, w, h]` in the rectified output image. */
  roiRectInOutput: [number, number, number, number];
}

function rasterizePolygon(
  mask: Uint8Array,
  width: number,
  height: number,
  polygon: readonly Point2D[],
  fillValue: 0 | 1,
): void {
  const n = polygon.length;
  if (n < 3) return;

  let minY = height;
  let maxY = -1;
  for (let i = 0; i < n; i++) {
    const pt = polygon[i];
    if (pt === undefined) continue;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(height - 1, Math.ceil(maxY));
  const intersections: number[] = [];

  for (let y = yStart; y <= yEnd; y++) {
    const sy = y + 0.5;
    intersections.length = 0;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = polygon[i];
      const pj = polygon[j];
      if (pi === undefined || pj === undefined) continue;

      if ((pi.y > sy) !== (pj.y > sy)) {
        const xInt = pi.x + ((sy - pi.y) * (pj.x - pi.x)) / (pj.y - pi.y);
        intersections.push(xInt);
      }
    }

    if (intersections.length < 2) continue;
    intersections.sort((a, b) => a - b);

    const rowOffset = y * width;
    for (let k = 0; k + 1 < intersections.length; k += 2) {
      const xLeft = intersections[k];
      const xRight = intersections[k + 1];
      if (xLeft === undefined || xRight === undefined) continue;

      const xStart = Math.max(0, Math.ceil(xLeft - 0.5));
      const xEnd = Math.min(width - 1, Math.floor(xRight - 0.5));
      for (let x = xStart; x <= xEnd; x++) {
        mask[rowOffset + x] = fillValue;
      }
    }
  }
}

function distSqPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  const ex = px - projX;
  const ey = py - projY;
  return ex * ex + ey * ey;
}

function rasterizeStroke(
  mask: Uint8Array,
  width: number,
  height: number,
  points: readonly Point2D[],
  radiusPx: number,
): void {
  if (points.length === 0 || radiusPx < 0) return;

  const rSq = radiusPx * radiusPx;
  const rCeil = Math.ceil(radiusPx);

  if (points.length === 1) {
    const p = points[0];
    if (p === undefined) return;
    const xStart = Math.max(0, Math.floor(p.x) - rCeil);
    const xEnd = Math.min(width - 1, Math.ceil(p.x) + rCeil);
    const yStart = Math.max(0, Math.floor(p.y) - rCeil);
    const yEnd = Math.min(height - 1, Math.ceil(p.y) + rCeil);
    for (let y = yStart; y <= yEnd; y++) {
      const rowOffset = y * width;
      for (let x = xStart; x <= xEnd; x++) {
        const dx = x - p.x;
        const dy = y - p.y;
        if (dx * dx + dy * dy <= rSq) {
          mask[rowOffset + x] = 0;
        }
      }
    }
    return;
  }

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) continue;

    const xStart = Math.max(0, Math.floor(Math.min(a.x, b.x)) - rCeil);
    const xEnd = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x)) + rCeil);
    const yStart = Math.max(0, Math.floor(Math.min(a.y, b.y)) - rCeil);
    const yEnd = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y)) + rCeil);

    for (let y = yStart; y <= yEnd; y++) {
      const rowOffset = y * width;
      for (let x = xStart; x <= xEnd; x++) {
        if (distSqPointToSegment(x, y, a.x, a.y, b.x, b.y) <= rSq) {
          mask[rowOffset + x] = 0;
        }
      }
    }
  }
}

/**
 * Rasterizes the valid bed area `V = R ∧ ¬E` at working-mask resolution.
 */
export function buildValidBedMask(
  workingWidth: number,
  workingHeight: number,
  effectiveScaleFactor: number,
  config: RoiExclusionConfig,
): ValidBedMask {
  if (
    !Number.isInteger(workingWidth) ||
    !Number.isInteger(workingHeight) ||
    workingWidth <= 0 ||
    workingHeight <= 0
  ) {
    throw new RangeError(
      `Invalid working mask dimensions: ${workingWidth}x${workingHeight}`,
    );
  }
  if (!Number.isFinite(effectiveScaleFactor) || effectiveScaleFactor <= 0) {
    throw new RangeError(
      `Invalid effectiveScaleFactor: ${effectiveScaleFactor}`,
    );
  }

  const totalPixels = workingWidth * workingHeight;
  const valid = new Uint8Array(totalPixels);

  if (config.roiPolygon === undefined) {
    valid.fill(1);
  } else if (config.roiPolygon.length >= 3) {
    const scaledRoi = config.roiPolygon.map((p) => ({
      x: p.x * effectiveScaleFactor,
      y: p.y * effectiveScaleFactor,
    }));
    rasterizePolygon(valid, workingWidth, workingHeight, scaledRoi, 1);
  }

  for (const poly of config.exclusionPolygons) {
    if (poly.length < 3) continue;
    const scaledPoly = poly.map((p) => ({
      x: p.x * effectiveScaleFactor,
      y: p.y * effectiveScaleFactor,
    }));
    rasterizePolygon(valid, workingWidth, workingHeight, scaledPoly, 0);
  }

  for (const stroke of config.exclusionStrokes) {
    if (stroke.points.length === 0 || stroke.radiusPx < 0) continue;
    const scaledPoints = stroke.points.map((p) => ({
      x: p.x * effectiveScaleFactor,
      y: p.y * effectiveScaleFactor,
    }));
    rasterizeStroke(
      valid,
      workingWidth,
      workingHeight,
      scaledPoints,
      stroke.radiusPx * effectiveScaleFactor,
    );
  }

  let validPixelCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (valid[i] === 1) {
      validPixelCount++;
    }
  }

  return {
    width: workingWidth,
    height: workingHeight,
    valid,
    validPixelCount,
  };
}

/**
 * Non-destructively filters grains against ROI and exclusion regions.
 * Never mutates `masks`.
 */
export function filterGrainsByRoiAndExclusion(
  masks: Int32Array,
  grains: readonly GrainMorphometrics[],
  workingWidth: number,
  workingHeight: number,
  effectiveScaleFactor: number,
  config: RoiExclusionConfig,
  mmPerPx?: number,
): ExclusionFilterResult {
  if (masks.length !== workingWidth * workingHeight) {
    throw new RangeError(
      `Mask buffer length (${masks.length}) does not match ${workingWidth}x${workingHeight}.`,
    );
  }

  const validBedMask = buildValidBedMask(
    workingWidth,
    workingHeight,
    effectiveScaleFactor,
    config,
  );

  const maxExcludedFraction =
    config.maxExcludedFraction ?? config.maxOverlapFraction ?? 0.1;

  const includedGrains: GrainMorphometrics[] = [];
  const excludedGrainIds = new Set<number>();

  for (const grain of grains) {
    const cx = Math.min(
      workingWidth - 1,
      Math.max(0, Math.round(grain.centroidX * effectiveScaleFactor)),
    );
    const cy = Math.min(
      workingHeight - 1,
      Math.max(0, Math.round(grain.centroidY * effectiveScaleFactor)),
    );

    if (validBedMask.valid[cy * workingWidth + cx] === 0) {
      excludedGrainIds.add(grain.id);
      continue;
    }

    const minX = Math.max(0, Math.floor(grain.bbox[0] * effectiveScaleFactor) - 1);
    const minY = Math.max(0, Math.floor(grain.bbox[1] * effectiveScaleFactor) - 1);
    const maxX = Math.min(
      workingWidth - 1,
      Math.ceil(grain.bbox[2] * effectiveScaleFactor) + 1,
    );
    const maxY = Math.min(
      workingHeight - 1,
      Math.ceil(grain.bbox[3] * effectiveScaleFactor) + 1,
    );

    let grainPixels = 0;
    let excludedPixels = 0;

    for (let y = minY; y <= maxY; y++) {
      const rowOff = y * workingWidth;
      for (let x = minX; x <= maxX; x++) {
        const idx = rowOff + x;
        if (masks[idx] === grain.id) {
          grainPixels++;
          if (validBedMask.valid[idx] === 0) {
            excludedPixels++;
          }
        }
      }
    }

    const excludedFraction = grainPixels > 0 ? excludedPixels / grainPixels : 0;
    if (excludedFraction > maxExcludedFraction) {
      excludedGrainIds.add(grain.id);
    } else {
      includedGrains.push(grain);
    }
  }

  const scaleSq = effectiveScaleFactor * effectiveScaleFactor;
  const sampledBedAreaPx = validBedMask.validPixelCount / scaleSq;
  const sampledBedAreaMm2 =
    mmPerPx !== undefined && Number.isFinite(mmPerPx) && mmPerPx > 0
      ? sampledBedAreaPx * mmPerPx * mmPerPx
      : undefined;

  let coveredAreaPx = 0;
  for (const grain of includedGrains) {
    coveredAreaPx += grain.areaPx;
  }

  const clastPackingPct =
    sampledBedAreaPx > 0
      ? Math.min(100, (coveredAreaPx / sampledBedAreaPx) * 100)
      : 0;
  const exposedMatrixPct = Math.max(0, 100 - clastPackingPct);

  const unresolvedFinesFraction =
    config.unresolvedFinesFraction !== undefined
      ? config.unresolvedFinesFraction
      : config.unresolvedSandFractionPct !== undefined
        ? config.unresolvedSandFractionPct / 100
        : undefined;

  return {
    includedGrains,
    excludedGrainIds,
    validBedMask,
    sampledBedAreaPx,
    ...(sampledBedAreaMm2 !== undefined ? { sampledBedAreaMm2 } : {}),
    clastPackingPct,
    exposedMatrixPct,
    ...(unresolvedFinesFraction !== undefined ? { unresolvedFinesFraction } : {}),
  };
}

/**
 * Solves the 3x3 planar homography `H` (`h33 = 1`) mapping `srcCorners` to `dstCorners`
 * via 8x8 Gaussian elimination with partial pivoting.
 */
export function solveHomography(
  srcCorners: readonly [Point2D, Point2D, Point2D, Point2D],
  dstCorners: readonly [Point2D, Point2D, Point2D, Point2D],
): Float64Array {
  const A = new Float64Array(64);
  const b = new Float64Array(8);

  for (let k = 0; k < 4; k++) {
    const src = srcCorners[k];
    const dst = dstCorners[k];
    if (src === undefined || dst === undefined) {
      throw new Error('Homography requires exactly 4 point correspondences.');
    }
    const u = src.x;
    const v = src.y;
    const x = dst.x;
    const y = dst.y;

    const r0 = (2 * k) * 8;
    A[r0] = u;
    A[r0 + 1] = v;
    A[r0 + 2] = 1;
    A[r0 + 3] = 0;
    A[r0 + 4] = 0;
    A[r0 + 5] = 0;
    A[r0 + 6] = -x * u;
    A[r0 + 7] = -x * v;
    b[2 * k] = x;

    const r1 = (2 * k + 1) * 8;
    A[r1] = 0;
    A[r1 + 1] = 0;
    A[r1 + 2] = 0;
    A[r1 + 3] = u;
    A[r1 + 4] = v;
    A[r1 + 5] = 1;
    A[r1 + 6] = -y * u;
    A[r1 + 7] = -y * v;
    b[2 * k + 1] = y;
  }

  for (let col = 0; col < 8; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(A[col * 8 + col] ?? 0);
    for (let row = col + 1; row < 8; row++) {
      const val = Math.abs(A[row * 8 + col] ?? 0);
      if (val > maxAbs) {
        maxAbs = val;
        pivotRow = row;
      }
    }

    if (maxAbs < 1e-10) {
      throw new Error(
        'Degenerate or collinear quadrilateral: cannot solve 4-point planar homography.',
      );
    }

    if (pivotRow !== col) {
      const cOff = col * 8;
      const pOff = pivotRow * 8;
      for (let j = col; j < 8; j++) {
        const tmp = A[cOff + j] ?? 0;
        A[cOff + j] = A[pOff + j] ?? 0;
        A[pOff + j] = tmp;
      }
      const tmpB = b[col] ?? 0;
      b[col] = b[pivotRow] ?? 0;
      b[pivotRow] = tmpB;
    }

    const pivotVal = A[col * 8 + col] ?? 0;
    for (let row = col + 1; row < 8; row++) {
      const rOff = row * 8;
      const factor = (A[rOff + col] ?? 0) / pivotVal;
      if (factor === 0) continue;
      A[rOff + col] = 0;
      for (let j = col + 1; j < 8; j++) {
        A[rOff + j] = (A[rOff + j] ?? 0) - factor * (A[col * 8 + j] ?? 0);
      }
      b[row] = (b[row] ?? 0) - factor * (b[col] ?? 0);
    }
  }

  const h = new Float64Array(9);
  h[8] = 1;
  for (let row = 7; row >= 0; row--) {
    let sum = b[row] ?? 0;
    const rOff = row * 8;
    for (let j = row + 1; j < 8; j++) {
      sum -= (A[rOff + j] ?? 0) * (h[j] ?? 0);
    }
    const diag = A[rOff + row] ?? 0;
    if (Math.abs(diag) < 1e-10) {
      throw new Error(
        'Degenerate or collinear quadrilateral: singular back-substitution in homography.',
      );
    }
    h[row] = sum / diag;
  }

  return h;
}

/**
 * Computes the exact inverse of a 3x3 row-major matrix.
 */
export function invert3x3(m: Float64Array): Float64Array {
  if (m.length < 9) {
    throw new RangeError('Expected 9-element 3x3 matrix.');
  }
  const m00 = m[0] ?? 0;
  const m01 = m[1] ?? 0;
  const m02 = m[2] ?? 0;
  const m10 = m[3] ?? 0;
  const m11 = m[4] ?? 0;
  const m12 = m[5] ?? 0;
  const m20 = m[6] ?? 0;
  const m21 = m[7] ?? 0;
  const m22 = m[8] ?? 0;

  const c00 = m11 * m22 - m12 * m21;
  const c01 = -(m10 * m22 - m12 * m20);
  const c02 = m10 * m21 - m11 * m20;

  const det = m00 * c00 + m01 * c01 + m02 * c02;
  if (Math.abs(det) < 1e-12) {
    throw new Error('Homography matrix is singular and cannot be inverted.');
  }

  const invDet = 1 / det;
  const out = new Float64Array(9);
  out[0] = c00 * invDet;
  out[1] = -(m01 * m22 - m02 * m21) * invDet;
  out[2] = (m01 * m12 - m02 * m11) * invDet;
  out[3] = c01 * invDet;
  out[4] = (m00 * m22 - m02 * m20) * invDet;
  out[5] = -(m00 * m12 - m02 * m10) * invDet;
  out[6] = c02 * invDet;
  out[7] = -(m00 * m21 - m01 * m20) * invDet;
  out[8] = (m00 * m11 - m01 * m10) * invDet;
  return out;
}

/**
 * Projects a 2D point through a 3x3 row-major homography matrix.
 */
export function applyHomographyPoint(h: Float64Array, p: Point2D): Point2D {
  const w = (h[6] ?? 0) * p.x + (h[7] ?? 0) * p.y + (h[8] ?? 1);
  if (Math.abs(w) < 1e-12) {
    throw new Error('Homography projection produced zero homogeneous coordinate.');
  }
  return {
    x: ((h[0] ?? 0) * p.x + (h[1] ?? 0) * p.y + (h[2] ?? 0)) / w,
    y: ((h[3] ?? 0) * p.x + (h[4] ?? 0) * p.y + (h[5] ?? 0)) / w,
  };
}

function edgeLen(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Performs 4-point planar homography perspective rectification on an RGBA buffer
 * using inverse bilinear interpolation.
 */
export function rectifyPerspective(
  image: ImageBufferLike,
  input: HomographyInput,
): RectifiedImageResult {
  const srcW = image.width;
  const srcH = image.height;
  if (!Number.isInteger(srcW) || !Number.isInteger(srcH) || srcW <= 0 || srcH <= 0) {
    throw new RangeError(`Invalid source image dimensions: ${srcW}x${srcH}`);
  }
  if (image.data.length < srcW * srcH * 4) {
    throw new RangeError('Source RGBA buffer is smaller than width * height * 4.');
  }
  if (
    !Number.isFinite(input.physicalWidthMm) ||
    !Number.isFinite(input.physicalHeightMm) ||
    input.physicalWidthMm <= 0 ||
    input.physicalHeightMm <= 0
  ) {
    throw new RangeError('Physical width and height must be positive finite numbers.');
  }

  const [tl, tr, br, bl] = input.srcCorners;
  const meanWpx = 0.5 * (edgeLen(tl, tr) + edgeLen(bl, br));
  const meanHpx = 0.5 * (edgeLen(tl, bl) + edgeLen(tr, br));
  if (meanWpx < 1 || meanHpx < 1) {
    throw new Error(
      'Degenerate quadrilateral: edge lengths must be at least 1 pixel.',
    );
  }

  let mmPerPx =
    input.targetMmPerPx !== undefined && input.targetMmPerPx > 0
      ? input.targetMmPerPx
      : 0.5 * (input.physicalWidthMm / meanWpx + input.physicalHeightMm / meanHpx);

  const paddingPx = Math.max(0, Math.round(input.paddingPx ?? 0));
  const maxOutputDimPx = Math.max(64, Math.round(input.maxOutputDimPx ?? 4096));

  // The reference rectangle maps to exactly physicalWidthMm / mmPerPx by
  // physicalHeightMm / mmPerPx output pixels (not rounded), so output pixels are square and
  // `mmPerPx` holds on both axes. The canvas is the rectangle rounded up, plus padding.
  const ceilPx = (v: number): number => Math.max(1, Math.ceil(v - 1e-9));
  let outW = ceilPx(input.physicalWidthMm / mmPerPx) + 2 * paddingPx;
  let outH = ceilPx(input.physicalHeightMm / mmPerPx) + 2 * paddingPx;

  if (outW > maxOutputDimPx || outH > maxOutputDimPx) {
    const availW = Math.max(1, maxOutputDimPx - 2 * paddingPx);
    const availH = Math.max(1, maxOutputDimPx - 2 * paddingPx);
    const minMmPerPx = Math.max(
      input.physicalWidthMm / availW,
      input.physicalHeightMm / availH,
    );
    mmPerPx = Math.max(mmPerPx, minMmPerPx);
    outW = Math.min(maxOutputDimPx, ceilPx(input.physicalWidthMm / mmPerPx) + 2 * paddingPx);
    outH = Math.min(maxOutputDimPx, ceilPx(input.physicalHeightMm / mmPerPx) + 2 * paddingPx);
  }

  const refW = input.physicalWidthMm / mmPerPx;
  const refH = input.physicalHeightMm / mmPerPx;
  const actualMmPerPx = mmPerPx;
  const dstCorners: [Point2D, Point2D, Point2D, Point2D] = [
    { x: paddingPx, y: paddingPx },
    { x: paddingPx + refW, y: paddingPx },
    { x: paddingPx + refW, y: paddingPx + refH },
    { x: paddingPx, y: paddingPx + refH },
  ];

  const homography = solveHomography(input.srcCorners, dstCorners);
  const inverseHomography = invert3x3(homography);

  const ih00 = inverseHomography[0] ?? 0;
  const ih01 = inverseHomography[1] ?? 0;
  const ih02 = inverseHomography[2] ?? 0;
  const ih10 = inverseHomography[3] ?? 0;
  const ih11 = inverseHomography[4] ?? 0;
  const ih12 = inverseHomography[5] ?? 0;
  const ih20 = inverseHomography[6] ?? 0;
  const ih21 = inverseHomography[7] ?? 0;
  const ih22 = inverseHomography[8] ?? 1;

  const src = image.data;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const maxSrcX = srcW - 1;
  const maxSrcY = srcH - 1;
  const eps = 1e-6;

  for (let y = 0; y < outH; y++) {
    const rowOutOffset = y * outW * 4;
    for (let x = 0; x < outW; x++) {
      const w = ih20 * x + ih21 * y + ih22;
      if (Math.abs(w) < 1e-12) continue;

      const u = (ih00 * x + ih01 * y + ih02) / w;
      const v = (ih10 * x + ih11 * y + ih12) / w;

      if (u < -eps || u > maxSrcX + eps || v < -eps || v > maxSrcY + eps) {
        continue;
      }

      const uc = Math.min(maxSrcX, Math.max(0, u));
      const vc = Math.min(maxSrcY, Math.max(0, v));

      const x0 = Math.floor(uc);
      const y0 = Math.floor(vc);
      const x1 = Math.min(maxSrcX, x0 + 1);
      const y1 = Math.min(maxSrcY, y0 + 1);

      const fx = uc - x0;
      const fy = vc - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const dstIdx = rowOutOffset + x * 4;
      out[dstIdx] = Math.round(
        w00 * (src[i00] ?? 0) +
          w10 * (src[i10] ?? 0) +
          w01 * (src[i01] ?? 0) +
          w11 * (src[i11] ?? 0),
      );
      out[dstIdx + 1] = Math.round(
        w00 * (src[i00 + 1] ?? 0) +
          w10 * (src[i10 + 1] ?? 0) +
          w01 * (src[i01 + 1] ?? 0) +
          w11 * (src[i11 + 1] ?? 0),
      );
      out[dstIdx + 2] = Math.round(
        w00 * (src[i00 + 2] ?? 0) +
          w10 * (src[i10 + 2] ?? 0) +
          w01 * (src[i01 + 2] ?? 0) +
          w11 * (src[i11 + 2] ?? 0),
      );
      out[dstIdx + 3] = Math.round(
        w00 * (src[i00 + 3] ?? 0) +
          w10 * (src[i10 + 3] ?? 0) +
          w01 * (src[i01 + 3] ?? 0) +
          w11 * (src[i11 + 3] ?? 0),
      );
    }
  }

  return {
    data: out,
    width: outW,
    height: outH,
    mmPerPx: actualMmPerPx,
    homography,
    inverseHomography,
    roiRectInOutput: [paddingPx, paddingPx, refW, refH],
  };
}
