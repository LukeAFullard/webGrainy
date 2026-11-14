import type { GrainMorphometrics, Point2D } from '../types/index.js';

export interface ExtendedGrainMorphometrics extends GrainMorphometrics {
  perimeterPx: number;
  perimeterMm?: number;
  /** Isoperimetric quotient `min(1.0, 4 * pi * A / P^2)` in `[0, 1]`. */
  circularity: number;
  /** `bAxisPx / aAxisPx` in `(0, 1]`. */
  aspectRatio: number;
  /** `1 - bAxisPx / aAxisPx` in `[0, 1)`. */
  elongation: number;
  convexAreaPx: number;
  convexAreaMm2?: number;
  /** `min(1.0, areaPx / convexAreaPx)` in `[0, 1]`. */
  solidity: number;
  /**
   * 2D apparent projection sphericity proxy (`dEqPx / aAxisPx`).
   * Note: Vertical c-axis is unobserved in 2D nadir imagery.
   */
  sphericity2D: number;
}

export interface FabricRoseBin {
  binIndex: number;
  /** Bin start angle in `[0, 180)` degrees. */
  startDeg: number;
  /** Bin end angle in `(0, 180]` degrees. */
  endDeg: number;
  count: number;
  weightSum: number;
  proportionPct: number;
}

export interface FabricRoseStats {
  grainCount: number;
  weighted: boolean;
  /** Mean axial direction in `[-pi/2, pi/2]` radians from image vertical y-axis. */
  meanAngleRad: number;
  /** Mean axial direction in `[0, 180)` degrees. */
  meanAxialDeg: number;
  /** Circular resultant length `R` in `[0, 1]`. */
  resultantLength: number;
  /** Circular variance `1 - R` in `[0, 1]`. */
  circularVariance: number;
  /** Rayleigh test statistic `Z = n * R^2`. */
  rayleighZ: number;
  /** Approximate Rayleigh p-value `exp(-Z)` when `n >= 10`, else `null`. */
  rayleighP: number | null;
  /** Axial `180°` histogram sectors over `[0, 180)`. */
  bins: FabricRoseBin[];
}

export interface WentworthBin {
  phiMin: number;
  phiMax: number;
  mmMin: number;
  mmMax: number;
  label: string;
  wentworthClass: string;
  grainCount: number;
  weightPct: number;
}

/**
 * Computes the Crofton 4-direction intercept perimeter at working-mask resolution
 * within a 1-pixel padded bounding box around `workingBbox`.
 */
export function computeCroftonPerimeterPx(
  masks: Int32Array,
  width: number,
  height: number,
  grainId: number,
  workingBbox: readonly [number, number, number, number],
): number {
  const minX = Math.max(0, workingBbox[0]);
  const minY = Math.max(0, workingBbox[1]);
  const maxX = Math.min(width - 1, workingBbox[2]);
  const maxY = Math.min(height - 1, workingBbox[3]);

  if (maxX < minX || maxY < minY) {
    return 0;
  }

  const isInside = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return masks[y * width + x] === grainId;
  };

  let n0 = 0;
  let n90 = 0;
  let n45 = 0;
  let n135 = 0;

  for (let y = minY - 1; y <= maxY + 1; y++) {
    for (let x = minX - 1; x <= maxX + 1; x++) {
      const c = isInside(x, y);
      if (c !== isInside(x + 1, y)) n0++;
      if (c !== isInside(x, y + 1)) n90++;
      if (c !== isInside(x + 1, y + 1)) n45++;
      if (c !== isInside(x - 1, y + 1)) n135++;
    }
  }

  return (
    (Math.PI / 8) * (n0 + n90) +
    (Math.PI / (8 * Math.SQRT2)) * (n45 + n135)
  );
}

function cross2D(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Computes the 2D convex hull of a point set using Andrew's monotone chain (`O(k log k)`).
 */
export function computeConvexHull(points: readonly Point2D[]): Point2D[] {
  if (points.length <= 1) {
    return points.map((p) => ({ x: p.x, y: p.y }));
  }

  const sorted = points
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));

  // Deduplicate identical consecutive points
  const unique: Point2D[] = [];
  for (const pt of sorted) {
    const prev = unique[unique.length - 1];
    if (prev === undefined || prev.x !== pt.x || prev.y !== pt.y) {
      unique.push(pt);
    }
  }

  if (unique.length <= 2) {
    return unique;
  }

  const lower: Point2D[] = [];
  for (const pt of unique) {
    while (lower.length >= 2) {
      const o = lower[lower.length - 2];
      const a = lower[lower.length - 1];
      if (o === undefined || a === undefined || cross2D(o, a, pt) > 0) {
        break;
      }
      lower.pop();
    }
    lower.push(pt);
  }

  const upper: Point2D[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const pt = unique[i];
    if (pt === undefined) continue;
    while (upper.length >= 2) {
      const o = upper[upper.length - 2];
      const a = upper[upper.length - 1];
      if (o === undefined || a === undefined || cross2D(o, a, pt) > 0) {
        break;
      }
      upper.pop();
    }
    upper.push(pt);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * Computes Shoelace polygon area and Euclidean perimeter of a closed convex hull.
 */
export function computePolygonAreaAndPerimeter(hull: readonly Point2D[]): {
  area: number;
  perimeter: number;
} {
  const n = hull.length;
  if (n === 0) return { area: 0, perimeter: 0 };
  if (n === 1) return { area: 0, perimeter: 0 };
  if (n === 2) {
    const p0 = hull[0];
    const p1 = hull[1];
    if (p0 === undefined || p1 === undefined) return { area: 0, perimeter: 0 };
    const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    return { area: 0, perimeter: 2 * dist };
  }

  let shoelace2 = 0;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    shoelace2 += a.x * b.y - b.x * a.y;
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }

  return {
    area: Math.abs(shoelace2) * 0.5,
    perimeter,
  };
}

/**
 * Computes extended 2D shape morphometrics for all `grains` using the working-resolution `masks`.
 * Measurements computed on `masks` are rescaled back to original-image coordinates via `effectiveScaleFactor`.
 */
export function computeExtendedMorphometrics(
  masks: Int32Array,
  grains: readonly GrainMorphometrics[],
  workingWidth: number,
  workingHeight: number,
  effectiveScaleFactor = 1,
  mmPerPx?: number,
): ExtendedGrainMorphometrics[] {
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
  if (masks.length !== workingWidth * workingHeight) {
    throw new RangeError(
      `Mask buffer length (${masks.length}) does not match ${workingWidth}x${workingHeight}.`,
    );
  }
  if (!Number.isFinite(effectiveScaleFactor) || effectiveScaleFactor <= 0) {
    throw new RangeError(
      `Invalid effectiveScaleFactor: ${effectiveScaleFactor}`,
    );
  }

  const hasCalib =
    mmPerPx !== undefined && Number.isFinite(mmPerPx) && mmPerPx > 0;
  const scaleSq = effectiveScaleFactor * effectiveScaleFactor;

  return grains.map((grain) => {
    const minX = Math.max(
      0,
      Math.floor(grain.bbox[0] * effectiveScaleFactor) - 1,
    );
    const minY = Math.max(
      0,
      Math.floor(grain.bbox[1] * effectiveScaleFactor) - 1,
    );
    const maxX = Math.min(
      workingWidth - 1,
      Math.ceil(grain.bbox[2] * effectiveScaleFactor) + 1,
    );
    const maxY = Math.min(
      workingHeight - 1,
      Math.ceil(grain.bbox[3] * effectiveScaleFactor) + 1,
    );

    const workingBbox: [number, number, number, number] = [
      minX,
      minY,
      maxX,
      maxY,
    ];
    const perimeterWorking = computeCroftonPerimeterPx(
      masks,
      workingWidth,
      workingHeight,
      grain.id,
      workingBbox,
    );
    const perimeterPx = perimeterWorking / effectiveScaleFactor;

    const boundaryPoints: Point2D[] = [];
    for (let y = minY; y <= maxY; y++) {
      const rowOff = y * workingWidth;
      for (let x = minX; x <= maxX; x++) {
        if (masks[rowOff + x] !== grain.id) continue;
        const isBoundary =
          x === 0 ||
          x === workingWidth - 1 ||
          y === 0 ||
          y === workingHeight - 1 ||
          masks[rowOff + x - 1] !== grain.id ||
          masks[rowOff + x + 1] !== grain.id ||
          masks[(y - 1) * workingWidth + x] !== grain.id ||
          masks[(y + 1) * workingWidth + x] !== grain.id;
        if (isBoundary) {
          boundaryPoints.push({ x, y });
        }
      }
    }

    let convexAreaWorking = grain.areaPx * scaleSq;
    if (boundaryPoints.length > 0) {
      const hull = computeConvexHull(boundaryPoints);
      const { area, perimeter } = computePolygonAreaAndPerimeter(hull);
      // Pixel-center Minkowski correction (+ 0.5 * hullPerimeter + 1) ensures convexArea >= areaPx
      convexAreaWorking = Math.max(1, area + 0.5 * perimeter + 1);
    }

    const convexAreaPx = convexAreaWorking / scaleSq;
    const solidity =
      convexAreaPx > 0
        ? Math.min(1.0, Math.max(0, grain.areaPx / convexAreaPx))
        : 1.0;

    const circularity =
      perimeterPx > 0
        ? Math.min(
            1.0,
            Math.max(
              0,
              (4 * Math.PI * grain.areaPx) / (perimeterPx * perimeterPx),
            ),
          )
        : 0;

    const aspectRatio =
      grain.aAxisPx > 0
        ? Math.min(1.0, Math.max(0, grain.bAxisPx / grain.aAxisPx))
        : 1.0;
    const elongation = Math.max(0, 1.0 - aspectRatio);
    const sphericity2D =
      grain.aAxisPx > 0
        ? Math.min(1.0, Math.max(0, grain.dEqPx / grain.aAxisPx))
        : 1.0;

    const perimeterMm = hasCalib ? perimeterPx * mmPerPx : undefined;
    const convexAreaMm2 = hasCalib
      ? convexAreaPx * mmPerPx * mmPerPx
      : undefined;

    return {
      ...grain,
      perimeterPx,
      ...(perimeterMm !== undefined ? { perimeterMm } : {}),
      circularity,
      aspectRatio,
      elongation,
      convexAreaPx,
      ...(convexAreaMm2 !== undefined ? { convexAreaMm2 } : {}),
      solidity,
      sphericity2D,
    };
  });
}

/**
 * Computes double-angle axial fabric statistics and `180°` rose diagram bins
 * from `orientationRad` (`[-pi/2, pi/2]` from the vertical y-axis).
 */
export function computeFabricRoseStats(
  grains: readonly GrainMorphometrics[],
  options?: { weighted?: boolean; binCount?: number; weights?: readonly number[] },
): FabricRoseStats {
  const customWeights =
    options?.weights !== undefined && options.weights.length === grains.length
      ? options.weights
      : undefined;
  const weighted = options?.weighted ?? (customWeights !== undefined);
  const binCount = Math.max(1, Math.round(options?.binCount ?? 12));
  const binWidthDeg = 180 / binCount;

  const bins: FabricRoseBin[] = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({
      binIndex: i,
      startDeg: i * binWidthDeg,
      endDeg: (i + 1) * binWidthDeg,
      count: 0,
      weightSum: 0,
      proportionPct: 0,
    });
  }

  let validCount = 0;
  let totalWeight = 0;
  let sumCos2 = 0;
  let sumSin2 = 0;

  for (let i = 0; i < grains.length; i++) {
    const grain = grains[i];
    if (grain === undefined) continue;
    if (!Number.isFinite(grain.orientationRad)) continue;
    const w = customWeights ? (customWeights[i] ?? 0) : weighted ? grain.areaPx : 1;
    if (!Number.isFinite(w) || w <= 0) continue;

    validCount++;
    totalWeight += w;

    const twoTheta = 2 * grain.orientationRad;
    sumCos2 += w * Math.cos(twoTheta);
    sumSin2 += w * Math.sin(twoTheta);

    const rawDeg = (grain.orientationRad * 180) / Math.PI;
    const axialDeg = ((rawDeg % 180) + 180) % 180;
    const binIdx = Math.min(binCount - 1, Math.floor(axialDeg / binWidthDeg));
    const bin = bins[binIdx];
    if (bin !== undefined) {
      bin.count++;
      bin.weightSum += w;
    }
  }

  if (validCount === 0 || totalWeight <= 0) {
    return {
      grainCount: 0,
      weighted,
      meanAngleRad: 0,
      meanAxialDeg: 0,
      resultantLength: 0,
      circularVariance: 1,
      rayleighZ: 0,
      rayleighP: null,
      bins,
    };
  }

  const cMean = sumCos2 / totalWeight;
  const sMean = sumSin2 / totalWeight;
  const meanAngleRad = 0.5 * Math.atan2(sMean, cMean);
  const meanAxialDeg =
    (((meanAngleRad * 180) / Math.PI) % 180 + 180) % 180;
  const resultantLength = Math.min(1, Math.hypot(cMean, sMean));
  const circularVariance = Math.max(0, 1 - resultantLength);
  const rayleighZ = validCount * resultantLength * resultantLength;
  const rayleighP = validCount >= 10 ? Math.exp(-rayleighZ) : null;

  for (const bin of bins) {
    bin.proportionPct = (bin.weightSum / totalWeight) * 100;
  }

  return {
    grainCount: validCount,
    weighted,
    meanAngleRad,
    meanAxialDeg,
    resultantLength,
    circularVariance,
    rayleighZ,
    rayleighP,
    bins,
  };
}

function classifyWentworthBin(phiMid: number): string {
  if (phiMid >= -1) return 'Sand';
  if (phiMid >= -2) return 'Very Fine Gravel';
  if (phiMid >= -3) return 'Fine Gravel';
  if (phiMid >= -4) return 'Medium Gravel';
  if (phiMid >= -5) return 'Coarse Gravel';
  if (phiMid >= -6) return 'Very Coarse Gravel';
  if (phiMid >= -7) return 'Small Cobble';
  if (phiMid >= -8) return 'Large Cobble';
  return 'Boulder';
}

/**
 * Computes `0.5φ` or `1.0φ` Wentworth histogram bins over `[-12φ, +4φ]`
 * using `bAxisMm`, with normalized `weightPct` summing to `100%`.
 */
export function computeWentworthHistogram(
  grains: readonly GrainMorphometrics[],
  options?: {
    stepPhi?: 0.5 | 1.0;
    weighted?: boolean;
    autoTrim?: boolean;
    weights?: readonly number[];
  },
): WentworthBin[] {
  const stepPhi = options?.stepPhi ?? 1.0;
  const weighted = options?.weighted ?? true;
  const autoTrim = options?.autoTrim ?? true;
  const customWeights =
    options?.weights !== undefined && options.weights.length === grains.length
      ? options.weights
      : undefined;

  const minPhi = -12;
  const maxPhi = 4;
  const numBins = Math.round((maxPhi - minPhi) / stepPhi);

  const bins: WentworthBin[] = [];
  for (let i = 0; i < numBins; i++) {
    const phiMin = minPhi + i * stepPhi;
    const phiMax = phiMin + stepPhi;
    const mmMin = 2 ** -phiMax;
    const mmMax = 2 ** -phiMin;
    const wentworthClass = classifyWentworthBin(0.5 * (phiMin + phiMax));
    bins.push({
      phiMin,
      phiMax,
      mmMin,
      mmMax,
      label: `${wentworthClass} (${phiMin}φ to ${phiMax}φ)`,
      wentworthClass,
      grainCount: 0,
      weightPct: 0,
    });
  }

  const binWeights = new Float64Array(numBins);
  let totalWeight = 0;

  for (let i = 0; i < grains.length; i++) {
    const grain = grains[i];
    if (grain === undefined) continue;
    const dMm = grain.bAxisMm;
    if (typeof dMm !== 'number' || !Number.isFinite(dMm) || dMm <= 0) {
      continue;
    }
    const w = customWeights ? (customWeights[i] ?? 0) : weighted ? grain.areaPx : 1;
    if (!Number.isFinite(w) || w <= 0) continue;

    const phi = -Math.log2(dMm);
    const rawIdx = Math.floor((phi - minPhi) / stepPhi);
    const idx = Math.min(numBins - 1, Math.max(0, rawIdx));

    const bin = bins[idx];
    if (bin !== undefined) {
      bin.grainCount++;
      binWeights[idx] = (binWeights[idx] ?? 0) + w;
      totalWeight += w;
    }
  }

  if (totalWeight <= 0) {
    return autoTrim ? [] : bins;
  }

  let firstOccupied = -1;
  let lastOccupied = -1;
  for (let i = 0; i < numBins; i++) {
    const bin = bins[i];
    if (bin === undefined) continue;
    const w = binWeights[i] ?? 0;
    bin.weightPct = (w / totalWeight) * 100;
    if (bin.grainCount > 0) {
      if (firstOccupied === -1) firstOccupied = i;
      lastOccupied = i;
    }
  }

  if (!autoTrim || firstOccupied === -1) {
    return bins;
  }

  const start = Math.max(0, firstOccupied - 1);
  const end = Math.min(numBins - 1, lastOccupied + 1);
  return bins.slice(start, end + 1);
}
