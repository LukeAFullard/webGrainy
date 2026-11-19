import { csvCell } from './provenance.js';
import { buildContourGeoJson, buildContourSvg, encodeMaskPng } from './exportFormats.js';
import { computeExtraGrainStats, extraStatsCsvRows } from './grainStatsExtra.js';
import type {
  FolkWardStats,
  GrainMorphometrics,
  PsdPercentiles,
  SedimentStatsReport,
  SizeMetric,
  WentworthProportions,
} from '../types/index.js';

const DEFAULT_PERCENTILES = [5, 10, 16, 25, 50, 75, 84, 90, 95] as const;

/** Below this many grains, per-photo statistics are flagged as unreliable. */
export const MIN_GRAINS_RELIABLE = 30;
/** Commonly recommended minimum sample size for a stable D50 (e.g. Wolman counts). */
export const MIN_GRAINS_ADEQUATE = 100;

/**
 * Filters out border-touching grains when `excludeBorder` is `true` (default).
 */
export function filterBorderGrains(
  grains: readonly GrainMorphometrics[],
  excludeBorder = true,
): GrainMorphometrics[] {
  if (!excludeBorder) {
    return [...grains];
  }
  return grains.filter((g) => !g.touchesBorder);
}

/**
 * Computes weighted particle-size distribution percentiles with exact parity
 * to `eval_core.py` / `np.interp(p / 100.0, cdf, v)` using midpoint cumulative
 * weights `cdf = (cumsum(w) - 0.5 * w) / sum(w)`.
 */
export function weightedPsdPercentiles(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
  percentiles: readonly number[] = DEFAULT_PERCENTILES,
): Record<string, number> {
  const n = Math.min(values.length, weights.length);
  const pairs: Array<{ v: number; w: number }> = [];

  for (let i = 0; i < n; i++) {
    const v = values[i];
    const w = weights[i];
    if (
      v !== undefined &&
      w !== undefined &&
      Number.isFinite(v) &&
      Number.isFinite(w) &&
      v > 0 &&
      w > 0
    ) {
      pairs.push({ v, w });
    }
  }

  const out: Record<string, number> = {};
  if (pairs.length === 0) {
    for (const p of percentiles) {
      out[`D${p}`] = Number.NaN;
    }
    return out;
  }

  pairs.sort((a, b) => a.v - b.v);

  let totalWeight = 0;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (pair !== undefined) {
      totalWeight += pair.w;
    }
  }

  const count = pairs.length;
  const cdf = new Float64Array(count);
  const sortedV = new Float64Array(count);
  let cumSum = 0;

  for (let i = 0; i < count; i++) {
    const pair = pairs[i];
    if (pair === undefined) continue;
    cumSum += pair.w;
    cdf[i] = (cumSum - 0.5 * pair.w) / totalWeight;
    sortedV[i] = pair.v;
  }

  const firstCdf = cdf[0] ?? 0;
  const lastCdf = cdf[count - 1] ?? 1;
  const firstV = sortedV[0] ?? Number.NaN;
  const lastV = sortedV[count - 1] ?? Number.NaN;

  for (const p of percentiles) {
    const key = `D${p}`;
    const target = p / 100;

    if (target <= firstCdf) {
      out[key] = firstV;
      continue;
    }
    if (target >= lastCdf) {
      out[key] = lastV;
      continue;
    }

    // Binary search for largest idx where cdf[idx] <= target
    let lo = 0;
    let hi = count - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      const midVal = cdf[mid] ?? 0;
      if (midVal <= target) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    const c0 = cdf[lo] ?? 0;
    const c1 = cdf[hi] ?? 1;
    const v0 = sortedV[lo] ?? 0;
    const v1 = sortedV[hi] ?? 0;

    if (c1 === c0) {
      out[key] = v1;
    } else {
      const t = (target - c0) / (c1 - c0);
      out[key] = v0 + t * (v1 - v0);
    }
  }

  return out;
}

/**
 * Typed wrapper returning the standard `PsdPercentiles` (`D5`..`D95`).
 */
export function computePsdPercentiles(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
): PsdPercentiles {
  const raw = weightedPsdPercentiles(values, weights, DEFAULT_PERCENTILES);
  return {
    D5: raw['D5'] ?? Number.NaN,
    D10: raw['D10'] ?? Number.NaN,
    D16: raw['D16'] ?? Number.NaN,
    D25: raw['D25'] ?? Number.NaN,
    D50: raw['D50'] ?? Number.NaN,
    D75: raw['D75'] ?? Number.NaN,
    D84: raw['D84'] ?? Number.NaN,
    D90: raw['D90'] ?? Number.NaN,
    D95: raw['D95'] ?? Number.NaN,
  };
}

function classifySorting(sortingPhi: number): string {
  if (sortingPhi < 0.35) return 'Very Well Sorted';
  if (sortingPhi < 0.5) return 'Well Sorted';
  if (sortingPhi < 0.7) return 'Moderately Well Sorted';
  if (sortingPhi < 1.0) return 'Moderately Sorted';
  if (sortingPhi < 2.0) return 'Poorly Sorted';
  if (sortingPhi < 4.0) return 'Very Poorly Sorted';
  return 'Extremely Poorly Sorted';
}

function classifySkewness(skewnessPhi: number): string {
  if (skewnessPhi >= 0.3) return 'Very Fine Skewed';
  if (skewnessPhi >= 0.1) return 'Fine Skewed';
  if (skewnessPhi > -0.1) return 'Near Symmetrical';
  if (skewnessPhi > -0.3) return 'Coarse Skewed';
  return 'Very Coarse Skewed';
}

function classifyKurtosis(kurtosisPhi: number): string {
  if (kurtosisPhi < 0.67) return 'Very Platykurtic';
  if (kurtosisPhi < 0.9) return 'Platykurtic';
  if (kurtosisPhi < 1.11) return 'Mesokurtic';
  if (kurtosisPhi < 1.5) return 'Leptokurtic';
  if (kurtosisPhi < 3.0) return 'Very Leptokurtic';
  return 'Extremely Leptokurtic';
}

/**
 * Computes Folk & Ward (1957) graphic statistics in phi units (`phi = -log2(D_mm)`)
 * with proper coarse-to-fine percentile mapping (`phi5 = -log2(D95)`, etc.).
 */
export function computeFolkWardStats(
  psdMm: PsdPercentiles,
): FolkWardStats | null {
  const required = [
    psdMm.D5,
    psdMm.D16,
    psdMm.D25,
    psdMm.D50,
    psdMm.D75,
    psdMm.D84,
    psdMm.D95,
  ];
  for (const val of required) {
    if (!Number.isFinite(val) || val <= 0) {
      return null;
    }
  }

  const phi5 = -Math.log2(psdMm.D95);
  const phi16 = -Math.log2(psdMm.D84);
  const phi25 = -Math.log2(psdMm.D75);
  const phi50 = -Math.log2(psdMm.D50);
  const phi75 = -Math.log2(psdMm.D25);
  const phi84 = -Math.log2(psdMm.D16);
  const phi95 = -Math.log2(psdMm.D5);

  const meanPhi = (phi16 + phi50 + phi84) / 3;
  const sortingPhi = (phi84 - phi16) / 4 + (phi95 - phi5) / 6.6;

  const denom1 = 2 * (phi84 - phi16);
  const denom2 = 2 * (phi95 - phi5);
  const term1 = denom1 !== 0 ? (phi16 + phi84 - 2 * phi50) / denom1 : 0;
  const term2 = denom2 !== 0 ? (phi5 + phi95 - 2 * phi50) / denom2 : 0;
  const skewnessPhi = term1 + term2;

  const kurtDenom = 2.44 * (phi75 - phi25);
  const kurtosisPhi = kurtDenom !== 0 ? (phi95 - phi5) / kurtDenom : 1;

  const meanMm = 2 ** -meanPhi;

  return {
    meanPhi,
    sortingPhi,
    skewnessPhi,
    kurtosisPhi,
    meanMm,
    sortingLabel: classifySorting(sortingPhi),
    skewnessLabel: classifySkewness(skewnessPhi),
    kurtosisLabel: classifyKurtosis(kurtosisPhi),
  };
}

/**
 * Computes area-weighted (`areaPx`) Wentworth size class proportions on `bAxisMm`:
 * Sand (`< 2 mm`), Gravel (`2 <= d < 64`), Cobble (`64 <= d < 256`), Boulder (`>= 256`).
 */
export function computeWentworthProportions(
  grains: readonly GrainMorphometrics[],
  sizeMetric: SizeMetric = 'bAxis',
): WentworthProportions | null {
  if (grains.length === 0) {
    return null;
  }

  let sandArea = 0;
  let gravelArea = 0;
  let cobbleArea = 0;
  let boulderArea = 0;
  let totalArea = 0;

  for (const g of grains) {
    const d =
      sizeMetric === 'dEq'
        ? g.dEqMm
        : sizeMetric === 'minFeret'
          ? g.minFeretMm
          : g.bAxisMm;
    if (typeof d !== 'number' || !Number.isFinite(d)) {
      return null;
    }
    if (!Number.isFinite(g.areaPx) || g.areaPx <= 0) {
      continue;
    }
    const area = g.areaPx;
    totalArea += area;

    if (d < 2) {
      sandArea += area;
    } else if (d < 64) {
      gravelArea += area;
    } else if (d < 256) {
      cobbleArea += area;
    } else {
      boulderArea += area;
    }
  }

  if (totalArea <= 0) {
    return null;
  }

  return {
    sandPct: (sandArea / totalArea) * 100,
    gravelPct: (gravelArea / totalArea) * 100,
    cobblePct: (cobbleArea / totalArea) * 100,
    boulderPct: (boulderArea / totalArea) * 100,
  };
}

/**
 * Returns true if a grain passes the optional pixel (`minBaxisPx`) and physical (`minSizeMm`)
 * lower size cutoffs for the active size metric.
 */
export function grainPassesSizeCutoffs(
  grain: GrainMorphometrics,
  options?: { minBaxisPx?: number; minSizeMm?: number; sizeMetric?: SizeMetric },
): boolean {
  const minBaxisPx = Math.max(0, options?.minBaxisPx ?? 0);
  const minSizeMm = Math.max(0, options?.minSizeMm ?? 0);
  if (minBaxisPx <= 0 && minSizeMm <= 0) return true;
  const metric = options?.sizeMetric ?? 'bAxis';
  const pxSize =
    metric === 'minFeret'
      ? (grain.minFeretPx ?? grain.bAxisPx)
      : metric === 'dEq'
        ? grain.dEqPx
        : grain.bAxisPx;
  if (minBaxisPx > 0 && pxSize < minBaxisPx) return false;
  if (minSizeMm > 0) {
    const mmSize =
      metric === 'minFeret'
        ? grain.minFeretMm
        : metric === 'dEq'
          ? grain.dEqMm
          : grain.bAxisMm;
    if (mmSize !== undefined && Number.isFinite(mmSize) && mmSize < minSizeMm) {
      return false;
    }
  }
  return true;
}

/**
 * Computes the complete sediment statistics report (area-weighted & number-weighted
 * PSDs on `bAxis` and `dEq`, plus Folk & Ward and Wentworth when calibrated in `mm`).
 */
export function computeSedimentStats(
  grains: readonly GrainMorphometrics[],
  options?: {
    excludeBorder?: boolean;
    minAreaPx?: number;
    sizeMetric?: SizeMetric;
    minBaxisPx?: number;
    minSizeMm?: number;
  },
): SedimentStatsReport {
  const excludeBorder = options?.excludeBorder ?? true;
  const minAreaPx = options?.minAreaPx ?? 0;
  const sizeMetric = options?.sizeMetric ?? 'bAxis';
  const minBaxisPx = Math.max(0, options?.minBaxisPx ?? 0);
  const minSizeMm = Math.max(0, options?.minSizeMm ?? 0);

  const areaFiltered =
    minAreaPx > 0 ? grains.filter((g) => g.areaPx >= minAreaPx) : grains;
  const borderFiltered = filterBorderGrains(areaFiltered, excludeBorder);
  const excludedBorderGrains = areaFiltered.length - borderFiltered.length;
  const included =
    minBaxisPx > 0 || minSizeMm > 0
      ? borderFiltered.filter((g) =>
          grainPassesSizeCutoffs(g, { minBaxisPx, minSizeMm, sizeMetric }),
        )
      : borderFiltered;
  const excludedCutoffGrains = borderFiltered.length - included.length;

  const isCalibrated =
    included.length > 0 &&
    included.every(
      (g) =>
        typeof g.bAxisMm === 'number' &&
        Number.isFinite(g.bAxisMm) &&
        typeof g.dEqMm === 'number' &&
        Number.isFinite(g.dEqMm),
    );

  const unit: 'px' | 'mm' = isCalibrated ? 'mm' : 'px';

  const n = included.length;
  const bVals = new Float64Array(n);
  const dEqVals = new Float64Array(n);
  const areaWeights = new Float64Array(n);
  const numberWeights = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const g = included[i];
    if (g === undefined) continue;
    bVals[i] = unit === 'mm' ? (g.bAxisMm ?? g.bAxisPx) : g.bAxisPx;
    dEqVals[i] = unit === 'mm' ? (g.dEqMm ?? g.dEqPx) : g.dEqPx;
    areaWeights[i] = g.areaPx;
    numberWeights[i] = 1;
  }

  const areaWeightedB = computePsdPercentiles(bVals, areaWeights);
  const numberWeightedB = computePsdPercentiles(bVals, numberWeights);
  const areaWeightedDEq = computePsdPercentiles(dEqVals, areaWeights);
  const numberWeightedDEq = computePsdPercentiles(dEqVals, numberWeights);

  const hasFeret = n > 0 && included.every((g) => g.minFeretPx !== undefined);
  let areaWeightedMinFeret: PsdPercentiles | undefined;
  let numberWeightedMinFeret: PsdPercentiles | undefined;
  if (hasFeret) {
    const feretVals = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const g = included[i];
      if (g === undefined) continue;
      feretVals[i] =
        unit === 'mm'
          ? (g.minFeretMm ?? g.minFeretPx ?? g.bAxisPx)
          : (g.minFeretPx ?? g.bAxisPx);
    }
    areaWeightedMinFeret = computePsdPercentiles(feretVals, areaWeights);
    numberWeightedMinFeret = computePsdPercentiles(feretVals, numberWeights);
  }
  const fwPsd =
    sizeMetric === 'minFeret' && areaWeightedMinFeret
      ? areaWeightedMinFeret
      : sizeMetric === 'dEq'
        ? areaWeightedDEq
        : areaWeightedB;

  const warnings: string[] = [];
  if (n === 0) {
    warnings.push('No grains available for statistics after border/ROI filtering.');
  } else if (n < MIN_GRAINS_RELIABLE) {
    warnings.push(
      `Only ${n} grain(s) included: percentiles are highly uncertain and Folk & Ward classes are not meaningful (>= ${MIN_GRAINS_ADEQUATE} recommended).`,
    );
  } else if (n < MIN_GRAINS_ADEQUATE) {
    warnings.push(
      `${n} grains included: fewer than the ~${MIN_GRAINS_ADEQUATE} usually recommended for a stable D50; D84/D95 are especially uncertain.`,
    );
  }
  const calibratedCount = included.filter(
    (g) => typeof g.bAxisMm === 'number' && Number.isFinite(g.bAxisMm),
  ).length;
  if (calibratedCount > 0 && calibratedCount < n) {
    warnings.push(
      `Mixed calibration: ${n - calibratedCount} of ${n} grains lack a mm value, so all statistics are reported in pixels.`,
    );
  } else if (n > 0 && unit === 'px') {
    warnings.push('Uncalibrated: all sizes are in original-image pixels, not mm. Calibrate scale for physical units.');
  }

  const effectiveMetric: SizeMetric =
    sizeMetric === 'minFeret' && !hasFeret ? 'bAxis' : sizeMetric;
  const metricVals = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = included[i];
    if (g === undefined) continue;
    metricVals[i] =
      effectiveMetric === 'dEq'
        ? dEqVals[i]!
        : effectiveMetric === 'minFeret'
          ? unit === 'mm'
            ? (g.minFeretMm ?? g.minFeretPx ?? g.bAxisPx)
            : (g.minFeretPx ?? g.bAxisPx)
          : bVals[i]!;
  }
  const extra = n > 0 ? computeExtraGrainStats(metricVals, areaWeights, fwPsd, unit) : undefined;
  const folkWard =
    unit === 'mm' && n >= 2 ? computeFolkWardStats(fwPsd) : null;
  const wentworth =
    unit === 'mm' ? computeWentworthProportions(included, effectiveMetric) : null;

  return {
    totalGrains: grains.length,
    includedGrains: included.length,
    excludedBorderGrains,
    excludedCutoffGrains,
    unit,
    areaWeightedB,
    numberWeightedB,
    areaWeightedDEq,
    numberWeightedDEq,
    ...(areaWeightedMinFeret ? { areaWeightedMinFeret } : {}),
    ...(numberWeightedMinFeret ? { numberWeightedMinFeret } : {}),
    folkWard,
    wentworth,
    ...(extra ? { extra } : {}),
    warnings,
  };
}

/**
 * Exports per-grain morphometrics as a CSV Blob.
 */
export function exportGrainsCsv(grains: readonly GrainMorphometrics[]): Blob {
  const hasFeret = grains.some((g) => g.minFeretPx !== undefined);
  const header =
    'grain_id,centroid_x,centroid_y,area_px,a_axis_px,b_axis_px,d_eq_px,a_axis_mm,b_axis_mm,d_eq_mm' +
    (hasFeret ? ',min_feret_px,max_feret_px,min_feret_mm,max_feret_mm' : '') +
    ',touches_border';
  const lines: string[] = [header];

  for (const g of grains) {
    const row = [
      g.id,
      g.centroidX,
      g.centroidY,
      g.areaPx,
      g.aAxisPx,
      g.bAxisPx,
      g.dEqPx,
      g.aAxisMm !== undefined ? g.aAxisMm : '',
      g.bAxisMm !== undefined ? g.bAxisMm : '',
      g.dEqMm !== undefined ? g.dEqMm : '',
      ...(hasFeret
        ? [
            g.minFeretPx !== undefined ? g.minFeretPx : '',
            g.maxFeretPx !== undefined ? g.maxFeretPx : '',
            g.minFeretMm !== undefined ? g.minFeretMm : '',
            g.maxFeretMm !== undefined ? g.maxFeretMm : '',
          ]
        : []),
      g.touchesBorder,
    ].join(',');
    lines.push(row);
  }

  return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

/**
 * Exports the `SedimentStatsReport` as a JSON Blob.
 */
export function exportSummaryJson(report: SedimentStatsReport): Blob {
  return new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
}

/**
 * Summary rows (`section,metric,value,unit`, no header) for a single-photo report: counts,
 * D5–D95 for every distribution, Folk & Ward, Wentworth and the extra statistics.
 * The one place these rows are written (used by `exportSummaryCsv` and `AnalysisSession`).
 */
export function summaryCsvRows(report: SedimentStatsReport): string[] {
  const lines: string[] = [];
  lines.push(`summary,total_grains,${report.totalGrains},count`);
  lines.push(`summary,included_grains,${report.includedGrains},count`);
  lines.push(`summary,excluded_border_grains,${report.excludedBorderGrains},count`);
  lines.push(`summary,unit,${report.unit},unit`);

  const distributions: Array<[string, PsdPercentiles]> = [
    ['area_weighted_b', report.areaWeightedB],
    ['number_weighted_b', report.numberWeightedB],
    ['area_weighted_d_eq', report.areaWeightedDEq],
    ['number_weighted_d_eq', report.numberWeightedDEq],
    ...(report.areaWeightedMinFeret
      ? ([['area_weighted_min_feret', report.areaWeightedMinFeret]] as Array<[string, PsdPercentiles]>)
      : []),
    ...(report.numberWeightedMinFeret
      ? ([['number_weighted_min_feret', report.numberWeightedMinFeret]] as Array<[string, PsdPercentiles]>)
      : []),
  ];
  for (const [section, psd] of distributions) {
    for (const p of DEFAULT_PERCENTILES) {
      const key = `D${p}` as keyof PsdPercentiles;
      lines.push(`${section},${key},${psd[key]},${report.unit}`);
    }
  }

  if (report.folkWard !== null) {
    const fw = report.folkWard;
    lines.push(`folk_ward,mean_phi,${fw.meanPhi},phi`);
    lines.push(`folk_ward,sorting_phi,${fw.sortingPhi},phi`);
    lines.push(`folk_ward,skewness_phi,${fw.skewnessPhi},phi`);
    lines.push(`folk_ward,kurtosis_phi,${fw.kurtosisPhi},phi`);
    lines.push(`folk_ward,mean_mm,${fw.meanMm},mm`);
    lines.push(`folk_ward,sorting_label,${csvCell(fw.sortingLabel)},label`);
    lines.push(`folk_ward,skewness_label,${csvCell(fw.skewnessLabel)},label`);
    lines.push(`folk_ward,kurtosis_label,${csvCell(fw.kurtosisLabel)},label`);
  }

  if (report.wentworth !== null) {
    const w = report.wentworth;
    lines.push(`wentworth,sand_pct,${w.sandPct},%`);
    lines.push(`wentworth,gravel_pct,${w.gravelPct},%`);
    lines.push(`wentworth,cobble_pct,${w.cobblePct},%`);
    lines.push(`wentworth,boulder_pct,${w.boulderPct},%`);
  }

  if (report.extra) lines.push(...extraStatsCsvRows(report.extra, report.unit));
  return lines;
}

/** Exports the `SedimentStatsReport` as a structured summary CSV Blob. */
export function exportSummaryCsv(report: SedimentStatsReport): Blob {
  const lines = ['section,metric,value,unit', ...summaryCsvRows(report)];
  return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

// ============================================================================
// Mask PNG, GeoJSON and SVG exports (writers shared via exportFormats.ts)
// ============================================================================

/**
 * Exports an instance mask (`Int32Array`) as a lossless PNG Blob:
 * - `bitDepth = 16`: 16-bit grayscale (`colorType = 0`, big-endian uint16, clamped `0..65535`).
 * - `bitDepth = 32`: 32-bit RGBA (`colorType = 6, bitDepth = 8`, encoding 32-bit grain IDs).
 */
export function exportInstanceMaskPng(
  masks: Int32Array,
  width: number,
  height: number,
  bitDepth: 16 | 32 = 16,
): Blob {
  const png = encodeMaskPng(masks, width, height, bitDepth);
  return new Blob([png.slice().buffer], { type: 'image/png' });
}

/** Grain contours as a GeoJSON `FeatureCollection` Blob (marching squares). */
export function exportGeoJsonContours(
  masks: Int32Array,
  grains: readonly GrainMorphometrics[],
  width: number,
  height: number,
): Blob {
  return new Blob([JSON.stringify(buildContourGeoJson(masks, grains, width, height))], {
    type: 'application/geo+json',
  });
}

/** Grain contours as an SVG Blob with `<path fill-rule="evenodd">` elements. */
export function exportSvgContours(
  masks: Int32Array,
  grains: readonly GrainMorphometrics[],
  width: number,
  height: number,
): Blob {
  return new Blob([buildContourSvg(masks, grains, width, height)], { type: 'image/svg+xml' });
}
