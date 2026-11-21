/**
 * Pooling photos into one site sample: per-grain sizes, weights per pooling mode, virtual Wolman grid hits, Wentworth classes.
 * Split out of siteAnalysis.ts, which re-exports the public parts.
 */
import type { GrainMorphometrics, PsdPercentiles, SizeMetric, WentworthProportions } from '../types/index.js';
import type { AnalysisSession } from './pipelineController.js';
import type { ValidBedMask } from './roiAndRectify.js';
import { grainSizeIn } from './sedimentStats.js';
import type { PoolingMode, SitePhotoInput, SiteAnalysisOptions } from './siteTypes.js';

export const PSD_KEYS: ReadonlyArray<keyof PsdPercentiles> = [
  'D5',
  'D10',
  'D16',
  'D25',
  'D50',
  'D75',
  'D84',
  'D90',
  'D95',
];

export const PERCENTILE_NUMS = [5, 10, 16, 25, 50, 75, 84, 90, 95] as const;

export function getStatisticalBasisLabel(mode: PoolingMode): string {
  switch (mode) {
    case 'physical-area':
      return 'Area-Weighted (Grid-by-Number equivalent, Kellerhals & Bray 1971; 2D surface sizes, not sieve sizes)';
    case 'equal-photo':
      return 'Equal-Photo Area-Weighted (Normalized Grid-by-Number Equivalent)';
    case 'virtual-wolman-grid':
      return 'Virtual Wolman Grid-by-Number (Discrete Point Count, Kellerhals & Bray 1971)';
    case 'number-weighted':
      return 'Number-Weighted (each grain once — not comparable with pebble counts or sieving)';
    case 'facies-weighted':
      return 'Facies-Weighted Area-Normalized (Stratified Grid-by-Number Equivalent)';
  }
}

export interface PreparedGrain {
  grain: GrainMorphometrics;
  sizeVal: number;
  areaVal: number;
  gridHits: number;
}

export interface PreparedPhoto {
  input: SitePhotoInput;
  mmPerPx?: number;
  rawGrainCount: number;
  preCutoffGrains: GrainMorphometrics[];
  validGrains: PreparedGrain[];
  excludedTruncationCount: number;
  excludedTruncationAreaMm2: number;
  sampledBedAreaPx: number;
  sampledBedAreaMm2?: number;
  clastPackingPct: number;
  exposedMatrixPct: number;
  gridGrainHits: number;
  gridMatrixHits: number;
  gridSubCutoffHits: number;
  faciesWeight: number;
  /** Smallest resolvable size in original-photo px (working-resolution floor or minBaxisPx). */
  detectionLimitPx: number;
}

export function emptyPsd(): PsdPercentiles {
  return {
    D5: Number.NaN,
    D10: Number.NaN,
    D16: Number.NaN,
    D25: Number.NaN,
    D50: Number.NaN,
    D75: Number.NaN,
    D84: Number.NaN,
    D90: Number.NaN,
    D95: Number.NaN,
  };
}

export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] ?? Number.NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const vLo = sorted[lo] ?? Number.NaN;
  const vHi = sorted[hi] ?? Number.NaN;
  if (lo === hi) return vLo;
  return vLo + (pos - lo) * (vHi - vLo);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return quantileSorted(sorted, 0.5);
}

/** Most virtual Wolman grid points per photo (the app offers up to a few hundred). */
export const MAX_WOLMAN_POINTS = 10_000;

export function computeVirtualWolmanHits(
  session: AnalysisSession,
  validBedMask: ValidBedMask,
  validGrainIds: ReadonlySet<number>,
  subCutoffGrainIds: ReadonlySet<number>,
  options: SiteAnalysisOptions,
  mmPerPx: number | undefined,
  unit: 'mm' | 'px',
): {
  hitCounts: Map<number, number>;
  gridGrainHits: number;
  gridMatrixHits: number;
  gridSubCutoffHits: number;
} {
  const result = session.getResult();
  const masks = result.masks;
  const workW = result.width;
  const workH = result.height;
  const origW = session.workingImage.originalWidth;
  const origH = session.workingImage.originalHeight;
  const sWork = session.workingImage.effectiveScaleFactor;

  const hitCounts = new Map<number, number>();
  let gridGrainHits = 0;
  let gridMatrixHits = 0;
  let gridSubCutoffHits = 0;

  const samplePoints: Array<{ x: number; y: number }> = [];

  if (
    options.wolmanGridSpacingMm !== undefined &&
    options.wolmanGridSpacingMm > 0 &&
    unit === 'mm' &&
    mmPerPx !== undefined &&
    mmPerPx > 0
  ) {
    // At most MAX_WOLMAN_POINTS per photo: a tiny spacing must not allocate millions of points.
    const stepPx = Math.max(options.wolmanGridSpacingMm / mmPerPx, Math.sqrt((origW * origH) / MAX_WOLMAN_POINTS));
    if (Number.isFinite(stepPx) && stepPx > 0) {
      for (let y = 0.5 * stepPx; y < origH; y += stepPx) {
        for (let x = 0.5 * stepPx; x < origW; x += stepPx) {
          samplePoints.push({ x, y });
        }
      }
    }
  } else if (validBedMask.validPixelCount > 0) {
    let minX = 0;
    let minY = 0;
    let boxW = origW;
    let boxH = origH;

    if (validBedMask.validPixelCount < workW * workH) {
      let minWx = workW;
      let maxWx = -1;
      let minWy = workH;
      let maxWy = -1;
      for (let wy = 0; wy < workH; wy++) {
        const rowOffset = wy * workW;
        for (let wx = 0; wx < workW; wx++) {
          if (validBedMask.valid[rowOffset + wx] === 1) {
            if (wx < minWx) minWx = wx;
            if (wx > maxWx) maxWx = wx;
            if (wy < minWy) minWy = wy;
            if (wy > maxWy) maxWy = wy;
          }
        }
      }
      if (maxWx >= minWx && maxWy >= minWy) {
        minX = Math.max(0, minWx / sWork);
        minY = Math.max(0, minWy / sWork);
        const maxX = Math.min(origW, (maxWx + 1) / sWork);
        const maxY = Math.min(origH, (maxWy + 1) / sWork);
        boxW = Math.max(1e-6, maxX - minX);
        boxH = Math.max(1e-6, maxY - minY);
      }
    }

    const k = Number.isFinite(options.wolmanPointsPerPhoto) ? options.wolmanPointsPerPhoto! : 100;
    const targetK = Math.min(MAX_WOLMAN_POINTS, Math.max(1, Math.round(k)));
    const cols = Math.max(1, Math.ceil(Math.sqrt((targetK * boxW) / Math.max(1e-6, boxH))));
    const rows = Math.max(1, Math.ceil(targetK / cols));
    const stepX = boxW / cols;
    const stepY = boxH / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        samplePoints.push({
          x: minX + (c + 0.5) * stepX,
          y: minY + (r + 0.5) * stepY,
        });
      }
    }
  }

  for (const pt of samplePoints) {
    const wx = Math.min(workW - 1, Math.max(0, Math.round(pt.x * sWork)));
    const wy = Math.min(workH - 1, Math.max(0, Math.round(pt.y * sWork)));
    const idx = wy * workW + wx;
    if (validBedMask.valid[idx] === 0) {
      continue;
    }
    const label = masks[idx] ?? 0;
    if (label === 0) {
      gridMatrixHits++;
    } else if (validGrainIds.has(label)) {
      hitCounts.set(label, (hitCounts.get(label) ?? 0) + 1);
      gridGrainHits++;
    } else if (subCutoffGrainIds.has(label)) {
      gridSubCutoffHits++;
    }
  }

  return { hitCounts, gridGrainHits, gridMatrixHits, gridSubCutoffHits };
}

/**
 * A grain's weight in the pooled site distribution: the one rule shared by the site PSD, the
 * bootstrap, the jackknife and the pooled-grains export. `photoAreaSum` is the summed `areaVal`
 * of the grain's photo (as drawn); `faciesNorm` the photo's share of the facies weights.
 */
export function grainPoolWeight(mode: PoolingMode, g: Pick<PreparedGrain, 'areaVal' | 'gridHits'>, photoAreaSum: number, faciesNorm: number): number {
  switch (mode) {
    case 'physical-area':
      return g.areaVal;
    case 'equal-photo':
      return photoAreaSum > 0 ? g.areaVal / photoAreaSum : 0;
    case 'virtual-wolman-grid':
      return g.gridHits;
    case 'number-weighted':
      return 1;
    case 'facies-weighted':
      return photoAreaSum > 0 ? faciesNorm * (g.areaVal / photoAreaSum) : 0;
  }
}

export function buildPooledArrays(
  photos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  sampledGrainsOverride?: ReadonlyArray<readonly PreparedGrain[]>,
): {
  values: number[];
  weights: number[];
  grains: GrainMorphometrics[];
  /** Index (into `photos`) of the photo each pooled grain comes from. */
  photoIndex: number[];
  photoWeightsPct: number[];
} {
  const photoIndex: number[] = [];
  const values: number[] = [];
  const weights: number[] = [];
  const grainsOut: GrainMorphometrics[] = [];
  const photoRawTotals = new Array<number>(photos.length).fill(0);

  let totalFacies = 0;
  if (poolingMode === 'facies-weighted') {
    for (const p of photos) {
      totalFacies += p.faciesWeight;
    }
  }

  for (let pIdx = 0; pIdx < photos.length; pIdx++) {
    const p = photos[pIdx];
    if (p === undefined) continue;
    const grains = sampledGrainsOverride ? sampledGrainsOverride[pIdx] ?? [] : p.validGrains;
    if (grains.length === 0) continue;

    let photoAreaSum = 0;
    if (poolingMode === 'equal-photo' || poolingMode === 'facies-weighted') {
      for (const g of grains) {
        photoAreaSum += g.areaVal;
      }
    }

    const faciesNorm =
      poolingMode === 'facies-weighted'
        ? totalFacies > 0
          ? p.faciesWeight / totalFacies
          : 1 / photos.length
        : 1;

    let photoWeightSum = 0;
    for (const g of grains) {
      const w = grainPoolWeight(poolingMode, g, photoAreaSum, faciesNorm);
      if (w > 0 && Number.isFinite(g.sizeVal) && g.sizeVal > 0) {
        values.push(g.sizeVal);
        weights.push(w);
        grainsOut.push(g.grain);
        photoIndex.push(pIdx);
        photoWeightSum += w;
      }
    }
    photoRawTotals[pIdx] = photoWeightSum;
  }

  let grandTotal = 0;
  for (const t of photoRawTotals) grandTotal += t;
  const photoWeightsPct = photoRawTotals.map((t) =>
    grandTotal > 0 ? (t / grandTotal) * 100 : 0,
  );

  return { values, weights, grains: grainsOut, photoIndex, photoWeightsPct };
}

export function getGrainSize(
  grain: GrainMorphometrics,
  sizeMetric: SizeMetric,
  unit: 'mm' | 'px',
): number {
  return grainSizeIn(grain, sizeMetric, unit);
}

/** A grain's size in mm for the metric (derived from its own scale when needed), or undefined without a mm scale. */
export function getGrainMmSize(
  grain: GrainMorphometrics,
  sizeMetric: SizeMetric,
): number | undefined {
  const mm = grainSizeIn(grain, sizeMetric, 'mm');
  return Number.isFinite(mm) ? mm : undefined;
}

/** Why a grain that passed the border and ROI rules is left out of the site statistics. */
export type SiteCutoffReason = 'below_px_cutoff' | 'below_mm_cutoff';

/**
 * The site size-cutoff rule, shared by `analyzeSite` and the pooled grains CSV so they always
 * agree: a grain is left out when its size (original-photo px) is below `minBaxisPx`, or its
 * mm size is below the common cutoff. Returns null when the grain counts.
 */
export function siteCutoffReason(
  grain: GrainMorphometrics,
  sizeMetric: SizeMetric,
  minBaxisPx: number,
  dCutoffCommonMm: number | null,
): SiteCutoffReason | null {
  if (minBaxisPx > 0 && getGrainSize(grain, sizeMetric, 'px') < minBaxisPx) return 'below_px_cutoff';
  const mmSize = getGrainMmSize(grain, sizeMetric);
  if (dCutoffCommonMm !== null && mmSize !== undefined && mmSize < dCutoffCommonMm) return 'below_mm_cutoff';
  return null;
}

export function computeSiteWentworth(
  photos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  sizeMetric: SizeMetric = 'bAxis',
): WentworthProportions | null {
  const { grains, weights } = buildPooledArrays(photos, poolingMode);
  if (grains.length === 0) return null;

  let sand = 0;
  let gravel = 0;
  let cobble = 0;
  let boulder = 0;
  let total = 0;

  for (let i = 0; i < grains.length; i++) {
    const grain = grains[i];
    const w = weights[i] ?? 0;
    if (grain === undefined || !Number.isFinite(w) || w <= 0) continue;

    const d = getGrainMmSize(grain, sizeMetric);
    if (typeof d !== 'number' || !Number.isFinite(d)) {
      return null;
    }
    total += w;
    if (d < 2) sand += w;
    else if (d < 64) gravel += w;
    else if (d < 256) cobble += w;
    else boulder += w;
  }

  if (total <= 0) return null;
  return {
    sandPct: (sand / total) * 100,
    gravelPct: (gravel / total) * 100,
    cobblePct: (cobble / total) * 100,
    boulderPct: (boulder / total) * 100,
  };
}
