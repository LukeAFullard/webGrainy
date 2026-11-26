import { csvBlob, csvCell } from './provenance.js';
import { weightedPsdPercentiles } from './percentiles.js';
import { grainSizeIn } from './grainSize.js';
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

export { grainSizeIn };

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
 * Weighted particle-size distribution percentiles (midpoint CDF, log2 interpolation): see
 * percentiles.ts. Linear interpolation in size (ImageGrains' `eval_core.py`) agrees closely
 * for typical samples (mean |difference| ~0.1-1% for D16/D50/D84) but can differ by 10-20%
 * where few grains span a wide size gap.
 */
export { weightedPsdPercentiles };

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
  if (!Number.isFinite(skewnessPhi)) return 'Undefined';
  if (skewnessPhi >= 0.3) return 'Very Fine Skewed';
  if (skewnessPhi >= 0.1) return 'Fine Skewed';
  if (skewnessPhi > -0.1) return 'Near Symmetrical';
  if (skewnessPhi > -0.3) return 'Coarse Skewed';
  return 'Very Coarse Skewed';
}

function classifyKurtosis(kurtosisPhi: number): string {
  if (!Number.isFinite(kurtosisPhi)) return 'Undefined';
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
  // Degenerate distributions (one grain, all grains equal, or one clast carrying the middle of the
  // weight so phi25 = phi75) have no defined skewness / kurtosis: NaN, labelled "Undefined",
  // never a made-up "Near Symmetrical" or "Mesokurtic". (|x| < 1e-9 phi is rounding noise.)
  const zero = (x: number): boolean => Math.abs(x) < 1e-9;
  const skewnessPhi =
    zero(denom1) || zero(denom2)
      ? Number.NaN
      : (phi16 + phi84 - 2 * phi50) / denom1 + (phi5 + phi95 - 2 * phi50) / denom2;

  const kurtDenom = 2.44 * (phi75 - phi25);
  const kurtosisPhi = zero(kurtDenom) ? Number.NaN : (phi95 - phi5) / kurtDenom;

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
    const d = grainSizeIn(g, sizeMetric, 'mm');
    if (!Number.isFinite(d)) {
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
  if (minBaxisPx > 0 && grainSizeIn(grain, metric, 'px') < minBaxisPx) return false;
  if (minSizeMm > 0) {
    // NaN (no mm scale) never passes a comparison, so an uncalibrated grain is not cut in mm.
    const mmSize = grainSizeIn(grain, metric, 'mm');
    if (mmSize < minSizeMm) return false;
  }
  return true;
}

/** Display names of the size metrics in cutoff explanations. */
const METRIC_LABEL: Record<SizeMetric, string> = { bAxis: 'b-axis', dEq: 'equivalent diameter', minFeret: 'min-Feret width' };

/**
 * Why a grain fails the size cutoffs, with its size and the cutoff (e.g. "b-axis 8.9 px < 15 px
 * pixel cutoff"), or null when it passes. The same rule as grainPassesSizeCutoffs.
 */
export function sizeCutoffExplanation(
  grain: GrainMorphometrics,
  options?: { minBaxisPx?: number; minSizeMm?: number; sizeMetric?: SizeMetric },
): string | null {
  const minBaxisPx = Math.max(0, options?.minBaxisPx ?? 0);
  const minSizeMm = Math.max(0, options?.minSizeMm ?? 0);
  const metric = options?.sizeMetric ?? 'bAxis';
  const label = METRIC_LABEL[metric] ?? metric;
  const px = grainSizeIn(grain, metric, 'px');
  if (minBaxisPx > 0 && px < minBaxisPx) return `${label} ${px.toFixed(1)} px < ${+minBaxisPx.toFixed(2)} px pixel cutoff`;
  const mm = grainSizeIn(grain, metric, 'mm');
  if (minSizeMm > 0 && mm < minSizeMm) return `${label} ${mm.toFixed(1)} mm < ${+minSizeMm.toFixed(2)} mm size cutoff`;
  return null;
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
    /** The photo has a mm scale: with no grains at all the unit is still mm. */
    calibrated?: boolean;
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

  // With no counted grain, the unit follows the photo's grains (a calibrated photo whose grains
  // are all below the cutoff still reports in mm, with no values), or its calibration if it has none.
  const unitBasis = included.length > 0 ? included : grains;
  const isCalibrated =
    unitBasis.length === 0 ? options?.calibrated === true :
    unitBasis.every(
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
    bVals[i] = grainSizeIn(g, 'bAxis', unit);
    dEqVals[i] = grainSizeIn(g, 'dEq', unit);
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
      feretVals[i] = grainSizeIn(g, 'minFeret', unit);
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
          ? grainSizeIn(g, 'minFeret', unit)
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
 * @deprecated No provenance metadata. Use AnalysisSession.exportCsv (provenance, included_in_stats, shape columns).
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

  return csvBlob(lines.join('\n'));
}

/**
 * Exports the `SedimentStatsReport` as a JSON Blob.
 * @deprecated No provenance metadata. Use AnalysisSession.exportSummaryJson (with provenance metadata).
 */
export function exportSummaryJson(report: SedimentStatsReport): Blob {
  return new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
}

/** A number for a CSV cell: empty when not finite (no "NaN" / "Infinity" text). */
const numCell = (v: number): string => (Number.isFinite(v) ? String(v) : '');

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
  lines.push(`summary,excluded_cutoff_grains,${report.excludedCutoffGrains ?? 0},count`);
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
      lines.push(`${section},${key},${numCell(psd[key])},${report.unit}`);
    }
  }

  if (report.folkWard !== null) {
    const fw = report.folkWard;
    lines.push(`folk_ward,mean_phi,${numCell(fw.meanPhi)},phi`);
    lines.push(`folk_ward,sorting_phi,${numCell(fw.sortingPhi)},phi`);
    lines.push(`folk_ward,skewness_phi,${numCell(fw.skewnessPhi)},phi`);
    lines.push(`folk_ward,kurtosis_phi,${numCell(fw.kurtosisPhi)},phi`);
    lines.push(`folk_ward,mean_mm,${numCell(fw.meanMm)},mm`);
    lines.push(`folk_ward,sorting_label,${csvCell(fw.sortingLabel)},label`);
    lines.push(`folk_ward,skewness_label,${csvCell(fw.skewnessLabel)},label`);
    lines.push(`folk_ward,kurtosis_label,${csvCell(fw.kurtosisLabel)},label`);
  }

  if (report.wentworth !== null) {
    const w = report.wentworth;
    lines.push(`wentworth,sand_pct,${numCell(w.sandPct)},%`);
    lines.push(`wentworth,gravel_pct,${numCell(w.gravelPct)},%`);
    lines.push(`wentworth,cobble_pct,${numCell(w.cobblePct)},%`);
    lines.push(`wentworth,boulder_pct,${numCell(w.boulderPct)},%`);
  }

  if (report.extra) lines.push(...extraStatsCsvRows(report.extra, report.unit));
  return lines;
}

/** Exports the `SedimentStatsReport` as a structured summary CSV Blob.  * @deprecated No provenance metadata. Use AnalysisSession.exportSummaryCsv (with provenance metadata).
 */
export function exportSummaryCsv(report: SedimentStatsReport): Blob {
  const lines = ['section,metric,value,unit', ...summaryCsvRows(report)];
  return csvBlob(lines.join('\n'));
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
