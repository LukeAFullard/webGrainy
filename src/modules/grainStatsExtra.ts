/**
 * Additional grain-size statistics, beyond percentiles and Folk & Ward.
 *
 * Two bases are used, and both are stated in the output:
 * - Moment-ratio mean diameters D[p,q] = Σ d^p / Σ d^q use every measured grain once
 *   (number basis), as in particle-sizing standards (ISO 9276-2). D[3,2] (Sauter) equals the
 *   area-weighted mean diameter when grain area ∝ d², i.e. the mean of the grid-by-number
 *   distribution.
 * - Distribution statistics (extra percentiles, geometric mean and standard deviation,
 *   method-of-moments in φ) use the same weights as the reported PSD (area-weighted /
 *   grid-by-number unless another pooling mode is chosen), so they agree with D16/D50/D84.
 *
 * References: ISO 9276-2:2014; Blott & Pye (2001) GRADISTAT, Earth Surf. Proc. Landforms
 * 26, 1237–1248; Trask (1932); Lotspeich & Everest (1981) Fredle index, USDA Res. Note PNW-369;
 * Bunte & Abt (2001) RMRS-GTR-74.
 */
import { weightedPsdPercentiles } from './sedimentStats.js';

export interface ExtraGrainStats {
  /** Number of grains used. */
  n: number;
  /** Number basis (each grain once). */
  arithmeticMeanD10: number;
  sauterMeanD32: number;
  deBrouckereMeanD43: number;
  /** Distribution basis (same weights as the PSD). */
  D30: number;
  D60: number;
  D65: number;
  geometricMean: number;
  geometricSd: number;
  /** Method of moments on log2 sizes (φ = −log2 d[mm]); only with mm units. */
  momentMeanPhi: number | null;
  momentSortingPhi: number | null;
  momentSkewness: number | null;
  momentKurtosis: number | null;
  /** Percentile ratios. */
  traskSorting: number;
  uniformityCu: number;
  curvatureCc: number;
  span: number;
  fredleIndex: number;
}

const nan = Number.NaN;

/**
 * @param sizes grain sizes (mm or px) for the chosen size metric
 * @param weights distribution weights of the reported PSD (e.g. grain area)
 * @param percentiles the PSD's D10/D25/D75/D90/D50, to keep ratios consistent with it
 * @param unit 'mm' enables φ statistics
 */
export function computeExtraGrainStats(
  sizes: ArrayLike<number>,
  weights: ArrayLike<number>,
  percentiles: { D10: number; D25: number; D50: number; D75: number; D90: number },
  unit: 'mm' | 'px',
  options?: { multiplicity?: ArrayLike<number> },
): ExtraGrainStats {
  const multiplicity = options?.multiplicity;
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, n = 0;
  let wSum = 0, lnMean = 0;
  const m = Math.min(sizes.length, weights.length);
  for (let i = 0; i < m; i++) {
    const d = sizes[i]!;
    const w = weights[i]!;
    if (!(d > 0) || !Number.isFinite(d)) continue;
    const mult = multiplicity ? multiplicity[i]! : 1;
    if (mult > 0 && Number.isFinite(mult)) {
      n += mult;
      s1 += mult * d;
      s2 += mult * d * d;
      s3 += mult * d * d * d;
      s4 += mult * d * d * d * d;
    }
    if (w > 0 && Number.isFinite(w)) {
      wSum += w;
      lnMean += w * Math.log(d);
    }
  }
  const empty: ExtraGrainStats = {
    n, arithmeticMeanD10: nan, sauterMeanD32: nan, deBrouckereMeanD43: nan, D30: nan, D60: nan, D65: nan,
    geometricMean: nan, geometricSd: nan, momentMeanPhi: null, momentSortingPhi: null, momentSkewness: null,
    momentKurtosis: null, traskSorting: nan, uniformityCu: nan, curvatureCc: nan, span: nan, fredleIndex: nan,
  };
  if (n === 0 || wSum <= 0) return empty;
  lnMean /= wSum;
  // Weighted central moments of ln d and of φ = −log2 d.
  let lnVar = 0, p2 = 0, p3 = 0, p4 = 0;
  const phiMean = -lnMean / Math.LN2;
  for (let i = 0; i < m; i++) {
    const d = sizes[i]!;
    const w = weights[i]!;
    if (!(d > 0) || !Number.isFinite(d) || !(w > 0) || !Number.isFinite(w)) continue;
    const ln = Math.log(d);
    lnVar += w * (ln - lnMean) ** 2;
    const dp = -Math.log2(d) - phiMean;
    p2 += w * dp * dp;
    p3 += w * dp * dp * dp;
    p4 += w * dp * dp * dp * dp;
  }
  lnVar /= wSum;
  p2 /= wSum;
  p3 /= wSum;
  p4 /= wSum;
  const sdPhi = Math.sqrt(p2);
  const extra = weightedPsdPercentiles(sizes, weights, [30, 60, 65]);
  const D30 = extra['D30'] ?? nan;
  const D60 = extra['D60'] ?? nan;
  const D65 = extra['D65'] ?? nan;
  const geometricMean = Math.exp(lnMean);
  const traskSorting = Math.sqrt(percentiles.D75 / percentiles.D25);
  const isMm = unit === 'mm';
  return {
    n,
    arithmeticMeanD10: s1 / n,
    sauterMeanD32: s3 / s2,
    deBrouckereMeanD43: s4 / s3,
    D30,
    D60,
    D65,
    geometricMean,
    geometricSd: Math.exp(Math.sqrt(lnVar)),
    momentMeanPhi: isMm ? phiMean : null,
    momentSortingPhi: isMm ? sdPhi : null,
    momentSkewness: isMm && sdPhi > 0 ? p3 / sdPhi ** 3 : null,
    momentKurtosis: isMm && sdPhi > 0 ? p4 / sdPhi ** 4 : null,
    traskSorting,
    uniformityCu: D60 / percentiles.D10,
    curvatureCc: (D30 * D30) / (percentiles.D10 * D60),
    span: (percentiles.D90 - percentiles.D10) / percentiles.D50,
    fredleIndex: geometricMean / traskSorting,
  };
}

/** Rows `section,metric,value,unit` for summary CSV exports. */
export function extraStatsCsvRows(x: ExtraGrainStats, unit: 'mm' | 'px'): string[] {
  const f = (v: number | null): string => (v === null || !Number.isFinite(v) ? '' : String(v));
  return [
    `mean_diameters,n_grains,${x.n},count`,
    `mean_diameters,arithmetic_mean_D10,${f(x.arithmeticMeanD10)},${unit} (number basis)`,
    `mean_diameters,sauter_mean_D32,${f(x.sauterMeanD32)},${unit} (sum d^3 / sum d^2)`,
    `mean_diameters,de_brouckere_mean_D43,${f(x.deBrouckereMeanD43)},${unit} (sum d^4 / sum d^3)`,
    `distribution,D30,${f(x.D30)},${unit}`,
    `distribution,D60,${f(x.D60)},${unit}`,
    `distribution,D65,${f(x.D65)},${unit}`,
    `distribution,geometric_mean_Dg,${f(x.geometricMean)},${unit}`,
    `distribution,geometric_sd_sigma_g,${f(x.geometricSd)},ratio`,
    `moments_phi,mean,${f(x.momentMeanPhi)},phi`,
    `moments_phi,sorting,${f(x.momentSortingPhi)},phi`,
    `moments_phi,skewness,${f(x.momentSkewness)},dimensionless`,
    `moments_phi,kurtosis,${f(x.momentKurtosis)},dimensionless`,
    `ratios,trask_sorting_So,${f(x.traskSorting)},sqrt(D75/D25)`,
    `ratios,uniformity_Cu,${f(x.uniformityCu)},D60/D10`,
    `ratios,curvature_Cc,${f(x.curvatureCc)},D30^2/(D10*D60)`,
    `ratios,span,${f(x.span)},(D90-D10)/D50`,
    `ratios,fredle_index,${f(x.fredleIndex)},${unit} (Dg/So)`,
  ];
}
