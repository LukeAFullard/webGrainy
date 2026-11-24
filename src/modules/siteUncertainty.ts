/**
 * Uncertainty of site statistics: cluster/two-stage bootstrap, binomial order-statistic CIs, leave-one-photo-out jackknife, convergence curve.
 * Split out of siteAnalysis.ts, which re-exports the public parts.
 */
import type { PsdPercentiles } from '../types/index.js';
import { computeFolkWardStats, computePsdPercentiles } from './sedimentStats.js';
import { sizeAtCumulative, weightedMidpointCdf } from './percentiles.js';
import { lnGamma, tTwoSidedQuantile } from './studentT.js';

export { lnGamma };
import { PSD_KEYS, PERCENTILE_NUMS, type PreparedGrain, type PreparedPhoto, emptyPsd, quantileSorted, buildPooledArrays, grainPoolWeight } from './sitePooling.js';
import type { PoolingMode, PsdConfidenceInterval, FolkWardConfidenceInterval, BinomialCiResult, JackknifePhotoSensitivity, JackknifeSensitivityReport, ConvergencePoint } from './siteTypes.js';

/**
 * Deterministic seeded PRNG (Mulberry32).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function binomialConfidenceRanks(
  n: number,
  p: number,
  alpha: number,
): { le: number; ue: number } {
  if (n <= 0) {
    return { le: 0, ue: 0 };
  }
  if (n > 5000) {
    // Normal approximation on the same scale as the exact branch below (0-based, interpolated
    // order-statistic positions, continuity-corrected to n*p - 0.5), with the Cornish-Fisher
    // skewness term so it meets the exact ranks at n = 5000 (within 0.01 rank) instead of jumping.
    const z = alpha <= 0.055 ? 1.959963984540054 : 1.6448536269514722;
    const sd = Math.sqrt(n * p * (1 - p));
    const skew = sd > 0 ? ((z * z - 1) * (1 - 2 * p)) / (6 * sd) : 0;
    const le = Math.max(0, n * p - 0.5 + sd * (-z + skew));
    const ue = Math.min(n, n * p - 0.5 + sd * (z + skew));
    return { le, ue };
  }

  const lnN = lnGamma(n + 1);
  const lnP = Math.log(p);
  const lnQ = Math.log(1 - p);

  // Binomial CDF F(m) = P(X <= m). Ranks are found where F crosses alpha/2 and
  // 1 - alpha/2 and linearly interpolated between integer ranks (Eaton et al. 2019,
  // GSDtools), rather than snapped to the conservative integer.
  const lowTarget = alpha / 2;
  const highTarget = 1 - alpha / 2;
  let prevCum = 0;
  let cum = 0;
  let le = 0;
  let ue = n;
  let foundLe = false;
  let foundUe = false;

  for (let m = 0; m <= n; m++) {
    const logPmf =
      lnN - lnGamma(m + 1) - lnGamma(n - m + 1) + m * lnP + (n - m) * lnQ;
    prevCum = cum;
    cum += Math.exp(logPmf);
    if (!foundLe && cum >= lowTarget) {
      const frac = cum > prevCum ? (lowTarget - prevCum) / (cum - prevCum) : 0;
      le = Math.max(0, m - 1 + frac);
      foundLe = true;
    }
    if (!foundUe && cum >= highTarget) {
      const frac = cum > prevCum ? (highTarget - prevCum) / (cum - prevCum) : 0;
      ue = Math.min(n, m - 1 + frac);
      foundUe = true;
      break;
    }
  }

  return { le, ue };
}

export function computeBinomialCi(
  values: readonly number[],
  weights: readonly number[],
  poolingMode: PoolingMode,
  confidenceLevel: 0.9 | 0.95,
): BinomialCiResult {
  const alpha = confidenceLevel === 0.9 ? 0.1 : 0.05;
  const curve = weightedMidpointCdf(values, weights);
  let sumW = 0;
  let sumW2 = 0;
  for (let i = 0; i < Math.min(values.length, weights.length); i++) {
    const v = values[i]!;
    const w = weights[i]!;
    if (Number.isFinite(v) && Number.isFinite(w) && v > 0 && w > 0) {
      sumW += w;
      sumW2 += w * w;
    }
  }

  if (curve.sizes.length === 0 || sumW <= 0) {
    return {
      confidenceLevel,
      sampleSizeUsed: 0,
      isKishApproximation: false,
      lower: emptyPsd(),
      upper: emptyPsd(),
    };
  }

  const isKish =
    poolingMode !== 'number-weighted' && poolingMode !== 'virtual-wolman-grid';
  const rawN = isKish
    ? (sumW * sumW) / Math.max(1e-12, sumW2)
    : sumW;
  const nUsed = Math.max(1, Math.round(rawN));

  const lower = emptyPsd();
  const upper = emptyPsd();

  for (let i = 0; i < PERCENTILE_NUMS.length; i++) {
    const pNum = PERCENTILE_NUMS[i];
    const key = PSD_KEYS[i];
    if (pNum === undefined || key === undefined) continue;
    const { le, ue } = binomialConfidenceRanks(nUsed, pNum / 100, alpha);
    // `le` / `ue` are 0-based order-statistic positions; on the midpoint CDF the grain at
    // position i sits at cumulative fraction (i + 0.5) / n.
    lower[key] = sizeAtCumulative(curve, (le + 0.5) / nUsed);
    upper[key] = sizeAtCumulative(curve, (ue + 0.5) / nUsed);
  }

  return {
    confidenceLevel,
    sampleSizeUsed: nUsed,
    isKishApproximation: isKish,
    lower,
    upper,
  };
}

/** Grains of all photos, sorted once by size, for fast weighted percentiles. */
interface SortedPool {
  /** Grain count (valid grains only: finite size > 0). */
  n: number;
  /** Sizes, ascending (ties keep pooled order). */
  values: Float64Array;
  /** For each photo, its grains' positions in `values` (-1 for grains that never count). */
  posOf: Int32Array[];
}

function buildSortedPool(photos: readonly PreparedPhoto[]): SortedPool {
  const vals: number[] = [];
  const owner: Array<[number, number]> = [];
  photos.forEach((p, pi) => {
    p.validGrains.forEach((g, gi) => {
      if (Number.isFinite(g.sizeVal) && g.sizeVal > 0) {
        vals.push(g.sizeVal);
        owner.push([pi, gi]);
      }
    });
  });
  const idx = vals.map((_, i) => i);
  idx.sort((a, b) => vals[a]! - vals[b]! || a - b);
  const posOf = photos.map((p) => new Int32Array(p.validGrains.length).fill(-1));
  const values = new Float64Array(idx.length);
  idx.forEach((orig, pos) => {
    values[pos] = vals[orig]!;
    const [pi, gi] = owner[orig]!;
    posOf[pi]![gi] = pos;
  });
  return { n: idx.length, values, posOf };
}

/** The pool of the first `k` photos, taken from the full pool without re-sorting. */
function prefixPool(pool: SortedPool, k: number): SortedPool {
  const keep = new Int32Array(pool.n).fill(-1);
  for (let pi = 0; pi < k; pi++) for (const at of pool.posOf[pi]!) if (at >= 0) keep[at] = 0;
  let next = 0;
  const values: number[] = [];
  for (let i = 0; i < pool.n; i++) {
    if (keep[i] === 0) {
      keep[i] = next++;
      values.push(pool.values[i]!);
    }
  }
  const posOf = pool.posOf.slice(0, k).map((pos) => pos.map((at) => (at >= 0 ? keep[at]! : -1)));
  return { n: next, values: Float64Array.from(values), posOf };
}

/**
 * Weighted percentiles from per-grain pooled weights in sorted order, identical to
 * `weightedPsdPercentiles` on the expanded pair list: a grain pooled several times (photo
 * drawn repeatedly) adds midpoint-CDF knots for its first and last copy, which are the only
 * ones that affect interpolation. `first`/`last` are the first and last copy's weights.
 */
const PCT_TARGETS = Float64Array.from(PERCENTILE_NUMS, (p) => p / 100);

function percentilesFromSorted(
  values: Float64Array,
  total: Float64Array,
  first: Float64Array,
  last: Float64Array,
): PsdPercentiles {
  const n = values.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += total[i]!;
  const out = emptyPsd();
  if (!(sum > 0)) return out;
  // Stream the midpoint-CDF knots once (targets ascending). For a target t between knots
  // (c0, v0) and (c1, v1) with c0 <= t < c1, interpolate in log2 size; below the first knot
  // take its size; at or above the last knot the largest size.
  const nT = PCT_TARGETS.length;
  const res = new Float64Array(nT);
  let k = 0;
  let t = PCT_TARGETS[0]!;
  let havePrev = false;
  let c0 = 0;
  let v0 = 0;
  let cum = 0;
  const inv = 1 / sum;
  for (let i = 0; i < n; i++) {
    const w = total[i]!;
    if (!(w > 0)) continue;
    const v = values[i]!;
    const lo = (cum + 0.5 * first[i]!) * inv;
    const hi = (cum + w - 0.5 * last[i]!) * inv;
    cum += w;
    // knot 1: (lo, v)
    while (t < lo) {
      res[k] = !havePrev || lo === c0 ? v : 2 ** (Math.log2(v0) + ((t - c0) / (lo - c0)) * (Math.log2(v) - Math.log2(v0)));
      if (++k === nT) break;
      t = PCT_TARGETS[k]!;
    }
    if (k === nT) break;
    havePrev = true;
    c0 = lo;
    v0 = v;
    // knot 2 (same size): targets in [lo, hi) interpolate between equal sizes -> v
    if (hi !== lo) {
      while (t < hi) {
        res[k] = v;
        if (++k === nT) break;
        t = PCT_TARGETS[k]!;
      }
      if (k === nT) break;
      c0 = hi;
    }
  }
  for (; k < nT; k++) res[k] = v0;
  for (let j = 0; j < nT; j++) out[PSD_KEYS[j]!] = res[j]!;
  return out;
}

/** Pooled weight of each grain for one copy of its photo (`buildPooledArrays` rules). */
function singleCopyWeights(photos: readonly PreparedPhoto[], pool: SortedPool, mode: PoolingMode): Float64Array {
  const w = new Float64Array(pool.n);
  let anyFacies = false;
  for (const p of photos) if (p.faciesWeight > 0) anyFacies = true;
  photos.forEach((p, pi) => {
    let areaSum = 0;
    for (const g of p.validGrains) areaSum += g.areaVal;
    const pos = pool.posOf[pi]!;
    p.validGrains.forEach((g, gi) => {
      const at = pos[gi]!;
      if (at < 0) return;
      // A common factor (1 / total facies weight) does not change percentiles.
      const x = grainPoolWeight(mode, g, areaSum, mode === 'facies-weighted' ? (anyFacies ? p.faciesWeight : 1) : 1);
      w[at] = x > 0 ? x : 0;
    });
  });
  return w;
}

/** PSD of the photos selected by `include` (each once), from the shared sorted pool. */
function subsetPercentiles(
  photos: readonly PreparedPhoto[],
  pool: SortedPool,
  base: Float64Array,
  include: (pi: number) => boolean,
  scratch: { total: Float64Array },
): PsdPercentiles {
  const total = scratch.total;
  total.fill(0);
  photos.forEach((_p, pi) => {
    if (!include(pi)) return;
    const pos = pool.posOf[pi]!;
    for (let gi = 0; gi < pos.length; gi++) {
      const at = pos[gi]!;
      if (at >= 0) total[at] = base[at]!;
    }
  });
  return percentilesFromSorted(pool.values, total, total, total);
}

/**
 * Cluster / two-stage bootstrap of the site PSD (and Folk & Ward). Draws exactly the same
 * resamples as `runBootstrapReference` (same seed -> same photos and grains), but sorts the
 * grains once and evaluates each replicate's weighted percentiles in one pass, so a site of
 * 60 photos x 300 grains takes well under a second instead of tens of seconds.
 */
export function runBootstrap(
  photos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  unit: 'mm' | 'px',
  replicates: number,
  seed: number,
  twoStage: boolean,
  confidenceLevel: 0.9 | 0.95,
  /** Pre-sorted pool of exactly these photos (internal; saves re-sorting). */
  presorted?: SortedPool,
): {
  mode: 'cluster' | 'two-stage-cluster' | 'single-photo-grain-fallback';
  psdCi: PsdConfidenceInterval;
  folkWardCi: FolkWardConfidenceInterval | null;
} {
  const alpha = confidenceLevel === 0.9 ? 0.1 : 0.05;
  const qLo = alpha / 2;
  const qHi = 1 - alpha / 2;
  const rand = mulberry32(seed);
  const B = Math.max(1, Math.round(replicates));
  const nPhotos = photos.length;
  const isSinglePhoto = nPhotos === 1;
  const mode: 'cluster' | 'two-stage-cluster' | 'single-photo-grain-fallback' = isSinglePhoto
    ? 'single-photo-grain-fallback'
    : twoStage
      ? 'two-stage-cluster'
      : 'cluster';

  const pool = presorted ?? buildSortedPool(photos);
  const total = new Float64Array(pool.n);
  const first = new Float64Array(pool.n);
  const last = new Float64Array(pool.n);
  const counts = photos.map((p) => new Int32Array(p.validGrains.length));
  const totalFacies = (sampled: readonly number[]): number => {
    let t = 0;
    for (const pi of sampled) t += photos[pi]!.faciesWeight;
    return t;
  };

  /** Adds one pooled copy of photo `pi` with grain multiplicities `mult` (null = each once). */
  const addCopy = (pi: number, mult: Int32Array | null, faciesNorm: number): void => {
    const p = photos[pi]!;
    const grains = p.validGrains;
    if (grains.length === 0) return;
    let areaSum = 0;
    if (poolingMode === 'equal-photo' || poolingMode === 'facies-weighted') {
      for (let gi = 0; gi < grains.length; gi++) {
        const m = mult ? mult[gi]! : 1;
        if (m > 0) areaSum += m * grains[gi]!.areaVal;
      }
    }
    const pos = pool.posOf[pi]!;
    for (let gi = 0; gi < grains.length; gi++) {
      const m = mult ? mult[gi]! : 1;
      if (m <= 0) continue;
      const at = pos[gi]!;
      if (at < 0) continue;
      const g = grains[gi]!;
      const w = grainPoolWeight(poolingMode, g, areaSum, faciesNorm);
      if (!(w > 0)) continue;
      if (total[at] === 0) first[at] = w;
      last[at] = w;
      total[at]! += m * w;
    }
  };

  const dists: Record<keyof PsdPercentiles, number[]> = {
    D5: [], D10: [], D16: [], D25: [], D50: [], D75: [], D84: [], D90: [], D95: [],
  };
  const fwMeanPhi: number[] = [];
  const fwSortingPhi: number[] = [];
  const fwSkewnessPhi: number[] = [];
  const fwKurtosisPhi: number[] = [];
  const fwMeanMm: number[] = [];

  // Cluster mode (the default): a replicate only changes how often each photo is drawn, so
  // a grain's pooled weight is (draw count) x (its single-copy weight). Precompute those.
  const clusterFast = !isSinglePhoto && !twoStage;
  const baseW = clusterFast ? singleCopyWeights(photos, pool, poolingMode) : null;
  const baseNoFacies =
    clusterFast && poolingMode === 'facies-weighted' ? singleCopyWeights(photos, pool, 'equal-photo') : null;
  const photoPos = photos.map((_, pi) => Array.from(pool.posOf[pi]!).filter((at) => at >= 0));
  const draws = new Int32Array(nPhotos);

  for (let b = 0; b < B; b++) {
    total.fill(0);
    if (clusterFast) {
      draws.fill(0);
      for (let k = 0; k < nPhotos; k++) draws[Math.floor(rand() * nPhotos)]!++;
      // Facies weights: a common 1/total factor cancels; if the drawn photos all have weight
      // 0 the reference falls back to equal photo weights.
      let w = baseW!;
      if (baseNoFacies !== null) {
        let tf = 0;
        for (let pi = 0; pi < nPhotos; pi++) if (draws[pi]! > 0) tf += draws[pi]! * photos[pi]!.faciesWeight;
        if (!(tf > 0)) w = baseNoFacies;
      }
      for (let pi = 0; pi < nPhotos; pi++) {
        const m = draws[pi]!;
        if (m === 0) continue;
        for (const at of photoPos[pi]!) {
          const x = w[at]!;
          total[at] = m * x;
          first[at] = x;
          last[at] = x;
        }
      }
    } else if (isSinglePhoto) {
      const only = photos[0];
      if (!only || only.validGrains.length === 0) continue;
      const c = counts[0]!;
      c.fill(0);
      const gCount = only.validGrains.length;
      for (let i = 0; i < gCount; i++) c[Math.floor(rand() * gCount)]!++;
      addCopy(0, c, 1);
    } else {
      // Same draw order as the reference: photo index, then (two-stage) its grains.
      const sampled: number[] = [];
      const grainDraws: Array<Int32Array | null> = [];
      for (let k = 0; k < nPhotos; k++) {
        const pIdx = Math.floor(rand() * nPhotos);
        const p = photos[pIdx];
        if (p === undefined) continue;
        sampled.push(pIdx);
        if (twoStage && p.validGrains.length > 0) {
          const gCount = p.validGrains.length;
          const c = new Int32Array(gCount);
          for (let i = 0; i < gCount; i++) c[Math.floor(rand() * gCount)]!++;
          grainDraws.push(c);
        } else {
          grainDraws.push(null);
        }
      }
      const tf = poolingMode === 'facies-weighted' ? totalFacies(sampled) : 0;
      for (let k = 0; k < sampled.length; k++) {
        const pi = sampled[k]!;
        const faciesNorm =
          poolingMode === 'facies-weighted' ? (tf > 0 ? photos[pi]!.faciesWeight / tf : 1 / nPhotos) : 1;
        addCopy(pi, grainDraws[k]!, faciesNorm);
      }
    }
    const psd = percentilesFromSorted(pool.values, total, first, last);
    if (!Number.isFinite(psd.D50)) continue; // nothing pooled in this replicate
    for (const key of PSD_KEYS) {
      const val = psd[key];
      if (Number.isFinite(val)) dists[key].push(val);
    }
    if (unit === 'mm') {
      const fw = computeFolkWardStats(psd);
      if (fw !== null) {
        fwMeanPhi.push(fw.meanPhi);
        fwSortingPhi.push(fw.sortingPhi);
        if (Number.isFinite(fw.skewnessPhi)) fwSkewnessPhi.push(fw.skewnessPhi);
        if (Number.isFinite(fw.kurtosisPhi)) fwKurtosisPhi.push(fw.kurtosisPhi);
        fwMeanMm.push(fw.meanMm);
      }
    }
  }

  const lower = emptyPsd();
  const upper = emptyPsd();
  for (const key of PSD_KEYS) {
    const arr = dists[key];
    arr.sort((a, b) => a - b);
    lower[key] = quantileSorted(arr, qLo);
    upper[key] = quantileSorted(arr, qHi);
  }
  let folkWardCi: FolkWardConfidenceInterval | null = null;
  if (unit === 'mm' && fwMeanPhi.length > 0) {
    for (const a of [fwMeanPhi, fwSortingPhi, fwSkewnessPhi, fwKurtosisPhi, fwMeanMm]) a.sort((x, y) => x - y);
    folkWardCi = {
      meanPhi: [quantileSorted(fwMeanPhi, qLo), quantileSorted(fwMeanPhi, qHi)],
      sortingPhi: [quantileSorted(fwSortingPhi, qLo), quantileSorted(fwSortingPhi, qHi)],
      skewnessPhi: [quantileSorted(fwSkewnessPhi, qLo), quantileSorted(fwSkewnessPhi, qHi)],
      kurtosisPhi: [quantileSorted(fwKurtosisPhi, qLo), quantileSorted(fwKurtosisPhi, qHi)],
      meanMm: [quantileSorted(fwMeanMm, qLo), quantileSorted(fwMeanMm, qHi)],
    };
  }
  return { mode, psdCi: { confidenceLevel, lower, upper }, folkWardCi };
}

/**
 * Reference implementation of `runBootstrap` (re-pools and re-sorts every replicate).
 * Kept to validate the fast path in tests; O(B * n log n), too slow for large sites.
 */
export function runBootstrapReference(
  photos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  unit: 'mm' | 'px',
  replicates: number,
  seed: number,
  twoStage: boolean,
  confidenceLevel: 0.9 | 0.95,
): {
  mode: 'cluster' | 'two-stage-cluster' | 'single-photo-grain-fallback';
  psdCi: PsdConfidenceInterval;
  folkWardCi: FolkWardConfidenceInterval | null;
} {
  const alpha = confidenceLevel === 0.9 ? 0.1 : 0.05;
  const qLo = alpha / 2;
  const qHi = 1 - alpha / 2;
  const rand = mulberry32(seed);
  const B = Math.max(1, Math.round(replicates));

  const dists: Record<keyof PsdPercentiles, number[]> = {
    D5: [],
    D10: [],
    D16: [],
    D25: [],
    D50: [],
    D75: [],
    D84: [],
    D90: [],
    D95: [],
  };

  const fwMeanPhi: number[] = [];
  const fwSortingPhi: number[] = [];
  const fwSkewnessPhi: number[] = [];
  const fwKurtosisPhi: number[] = [];
  const fwMeanMm: number[] = [];

  const nPhotos = photos.length;
  const isSinglePhoto = nPhotos === 1;
  const mode: 'cluster' | 'two-stage-cluster' | 'single-photo-grain-fallback' =
    isSinglePhoto
      ? 'single-photo-grain-fallback'
      : twoStage
        ? 'two-stage-cluster'
        : 'cluster';

  for (let b = 0; b < B; b++) {
    let values: number[];
    let weights: number[];

    if (isSinglePhoto) {
      const onlyPhoto = photos[0];
      if (!onlyPhoto || onlyPhoto.validGrains.length === 0) continue;
      const gCount = onlyPhoto.validGrains.length;
      const resampled: PreparedGrain[] = [];
      for (let i = 0; i < gCount; i++) {
        const gIdx = Math.floor(rand() * gCount);
        const g = onlyPhoto.validGrains[gIdx];
        if (g !== undefined) resampled.push(g);
      }
      const pooled = buildPooledArrays([onlyPhoto], poolingMode, [resampled]);
      values = pooled.values;
      weights = pooled.weights;
    } else {
      const sampledPhotos: PreparedPhoto[] = [];
      const sampledGrains: PreparedGrain[][] = [];
      for (let k = 0; k < nPhotos; k++) {
        const pIdx = Math.floor(rand() * nPhotos);
        const p = photos[pIdx];
        if (p === undefined) continue;
        sampledPhotos.push(p);
        if (twoStage && p.validGrains.length > 0) {
          const gList: PreparedGrain[] = [];
          const gCount = p.validGrains.length;
          for (let i = 0; i < gCount; i++) {
            const gIdx = Math.floor(rand() * gCount);
            const g = p.validGrains[gIdx];
            if (g !== undefined) gList.push(g);
          }
          sampledGrains.push(gList);
        } else {
          sampledGrains.push(p.validGrains);
        }
      }
      const pooled = buildPooledArrays(sampledPhotos, poolingMode, sampledGrains);
      values = pooled.values;
      weights = pooled.weights;
    }

    if (values.length === 0) continue;
    const psd = computePsdPercentiles(values, weights);
    for (const key of PSD_KEYS) {
      const val = psd[key];
      if (Number.isFinite(val)) {
        dists[key].push(val);
      }
    }

    if (unit === 'mm') {
      const fw = computeFolkWardStats(psd);
      if (fw !== null) {
        fwMeanPhi.push(fw.meanPhi);
        fwSortingPhi.push(fw.sortingPhi);
        fwSkewnessPhi.push(fw.skewnessPhi);
        fwKurtosisPhi.push(fw.kurtosisPhi);
        fwMeanMm.push(fw.meanMm);
      }
    }
  }

  const lower = emptyPsd();
  const upper = emptyPsd();
  for (const key of PSD_KEYS) {
    const arr = dists[key];
    arr.sort((a, b) => a - b);
    lower[key] = quantileSorted(arr, qLo);
    upper[key] = quantileSorted(arr, qHi);
  }

  let folkWardCi: FolkWardConfidenceInterval | null = null;
  if (unit === 'mm' && fwMeanPhi.length > 0) {
    fwMeanPhi.sort((a, b) => a - b);
    fwSortingPhi.sort((a, b) => a - b);
    fwSkewnessPhi.sort((a, b) => a - b);
    fwKurtosisPhi.sort((a, b) => a - b);
    fwMeanMm.sort((a, b) => a - b);

    folkWardCi = {
      meanPhi: [quantileSorted(fwMeanPhi, qLo), quantileSorted(fwMeanPhi, qHi)],
      sortingPhi: [
        quantileSorted(fwSortingPhi, qLo),
        quantileSorted(fwSortingPhi, qHi),
      ],
      skewnessPhi: [
        quantileSorted(fwSkewnessPhi, qLo),
        quantileSorted(fwSkewnessPhi, qHi),
      ],
      kurtosisPhi: [
        quantileSorted(fwKurtosisPhi, qLo),
        quantileSorted(fwKurtosisPhi, qHi),
      ],
      meanMm: [quantileSorted(fwMeanMm, qLo), quantileSorted(fwMeanMm, qHi)],
    };
  }

  return {
    mode,
    psdCi: { confidenceLevel, lower, upper },
    folkWardCi,
  };
}

/** Photos per site below which the site interval is marked approximate (as the site comparison). */
export const MIN_PHOTOS_FOR_RELIABLE_CI = 5;

/** How far a site interval can be trusted (see `calibrateSiteInterval`). */
/** 'no-grains': no grain is counted, so there is nothing to estimate. */
export type SiteCiStatus = 'ok' | 'few-photos' | 'single-photo' | 'degenerate' | 'no-grains';

/**
 * Turns a cluster-bootstrap percentile interval into the reported site interval.
 *
 * A percentile bootstrap over n photos is too narrow: its variance is biased low by (n-1)/n and
 * it ignores that the spread is itself estimated from n photos. In simulation (2-30 photos,
 * realistic patch-to-patch variation) nominal 95% intervals covered the true D50 only 43-94% of
 * the time. The reported interval is therefore a t-interval on the log scale around the site
 * value: SE = (ln upper - ln lower) / (2 z) x sqrt(n/(n-1)), half-width t(n-1) x SE. The same
 * simulation gives 88-97% coverage. Folk & Ward phi measures use the same rule on their own
 * (linear) scale; the mean in mm uses the log scale.
 *
 * Single-photo sites keep the within-photo grain bootstrap (status 'single-photo', warned
 * separately). When the photos give identical bootstrap results (zero-width interval, e.g. the
 * same photo added twice) the interval cannot be estimated: it is reported as NaN, status
 * 'degenerate', never as a precise [x, x].
 */
export function calibrateSiteInterval(
  raw: { psdCi: PsdConfidenceInterval; folkWardCi: FolkWardConfidenceInterval | null },
  estimate: { psd: PsdPercentiles; folkWard: { meanPhi: number; sortingPhi: number; skewnessPhi: number; kurtosisPhi: number; meanMm: number } | null },
  nPhotos: number,
  confidenceLevel: 0.9 | 0.95,
  /** Leave-one-photo-out jackknife SE of ln(Dx); the larger of it and the bootstrap SE is used. */
  jackknifeLogSe?: PsdPercentiles,
): { psdCi: PsdConfidenceInterval; folkWardCi: FolkWardConfidenceInterval | null; status: SiteCiStatus; logSe: PsdPercentiles } {
  if (nPhotos < 2) {
    return { psdCi: raw.psdCi, folkWardCi: raw.folkWardCi, status: 'single-photo', logSe: emptyPsd() };
  }
  const z = confidenceLevel === 0.9 ? 1.6448536269514722 : 1.959963984540054;
  const inflate = Math.sqrt(nPhotos / (nPhotos - 1));
  const t = tTwoSidedQuantile(confidenceLevel, nPhotos - 1);
  const lower = emptyPsd();
  const upper = emptyPsd();
  const logSe = emptyPsd();
  // Only D16 / D50 / D84 decide the status: a degenerate extreme tail (D5, D95) is shown as not
  // available but must not hide the few-photos warning on the main percentiles.
  let degenerate = false;
  for (const key of PSD_KEYS) {
    const lo = raw.psdCi.lower[key];
    const hi = raw.psdCi.upper[key];
    const est = estimate.psd[key];
    if (!(lo > 0) || !(hi > 0) || !(est > 0) || !Number.isFinite(t)) continue;
    const seBoot = ((Math.log(hi) - Math.log(lo)) / (2 * z)) * inflate;
    const seJack = jackknifeLogSe?.[key];
    const se = Number.isFinite(seJack) ? Math.max(seBoot, seJack!) : seBoot;
    if (!(se > 1e-12)) {
      if (key === 'D16' || key === 'D50' || key === 'D84') degenerate = true;
      continue; // stays NaN: not estimable
    }
    logSe[key] = se;
    lower[key] = Math.exp(Math.log(est) - t * se);
    upper[key] = Math.exp(Math.log(est) + t * se);
  }
  let folkWardCi: FolkWardConfidenceInterval | null = null;
  if (raw.folkWardCi !== null && estimate.folkWard !== null && Number.isFinite(t)) {
    const fw = estimate.folkWard;
    const lin = (r: [number, number], e: number): [number, number] => {
      const se = ((r[1] - r[0]) / (2 * z)) * inflate;
      return se > 1e-12 && Number.isFinite(e) ? [e - t * se, e + t * se] : [Number.NaN, Number.NaN];
    };
    const logS = (r: [number, number], e: number): [number, number] => {
      if (!(r[0] > 0) || !(r[1] > 0) || !(e > 0)) return [Number.NaN, Number.NaN];
      const se = ((Math.log(r[1]) - Math.log(r[0])) / (2 * z)) * inflate;
      return se > 1e-12 ? [Math.exp(Math.log(e) - t * se), Math.exp(Math.log(e) + t * se)] : [Number.NaN, Number.NaN];
    };
    // Sorting and kurtosis are positive ratios: interval on the log scale, so it never goes
    // below 0 with few photos (t = 12.7 for 2 photos). Skewness is bounded to [-1, 1].
    const sk = lin(raw.folkWardCi.skewnessPhi, fw.skewnessPhi);
    const clampSk = (v: number): number => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : v);
    folkWardCi = {
      meanPhi: lin(raw.folkWardCi.meanPhi, fw.meanPhi),
      sortingPhi: logS(raw.folkWardCi.sortingPhi, fw.sortingPhi),
      skewnessPhi: [clampSk(sk[0]), clampSk(sk[1])],
      kurtosisPhi: logS(raw.folkWardCi.kurtosisPhi, fw.kurtosisPhi),
      meanMm: logS(raw.folkWardCi.meanMm, fw.meanMm),
    };
  }
  const status: SiteCiStatus = !(estimate.psd.D50 > 0)
    ? 'no-grains'
    : degenerate
      ? 'degenerate'
      : nPhotos < MIN_PHOTOS_FOR_RELIABLE_CI
        ? 'few-photos'
        : 'ok';
  return { psdCi: { confidenceLevel, lower, upper }, folkWardCi, status, logSe };
}

/** Leave-one-photo-out jackknife of D16/D50/D84, and each photo's D50 without it. */
export function computeJackknife(
  preparedPhotos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  psd: PsdPercentiles,
): { jackknife: JackknifeSensitivityReport | null; d50WithoutMap: Map<string, number> } {
  let jackknife: JackknifeSensitivityReport | null = null;
  const d50WithoutMap = new Map<string, number>();

  if (preparedPhotos.length >= 2) {
    // One shared sorted pool: each leave-one-out PSD is a single pass (no re-sorting).
    const pool = buildSortedPool(preparedPhotos);
    const base = singleCopyWeights(preparedPhotos, pool, poolingMode);
    const scratch = { total: new Float64Array(pool.n) };
    const perPhotoJack: JackknifePhotoSensitivity[] = [];
    const logWithout: Record<keyof PsdPercentiles, number[]> = {
      D5: [], D10: [], D16: [], D25: [], D50: [], D75: [], D84: [], D90: [], D95: [],
    };
    for (let j = 0; j < preparedPhotos.length; j++) {
      const target = preparedPhotos[j];
      if (target === undefined) continue;
      const subPsd = subsetPercentiles(preparedPhotos, pool, base, (pi) => pi !== j, scratch);
      for (const key of PSD_KEYS) logWithout[key].push(Math.log(subPsd[key]));

      d50WithoutMap.set(target.input.photoId, subPsd.D50);

      const deltaD16 = subPsd.D16 - psd.D16;
      const deltaD50 = subPsd.D50 - psd.D50;
      const deltaD84 = subPsd.D84 - psd.D84;
      const relPctD16 = psd.D16 > 0 ? (deltaD16 / psd.D16) * 100 : 0;
      const relPctD50 = psd.D50 > 0 ? (deltaD50 / psd.D50) * 100 : 0;
      const relPctD84 = psd.D84 > 0 ? (deltaD84 / psd.D84) * 100 : 0;
      const highInfluence =
        Math.abs(relPctD16) > 10 ||
        Math.abs(relPctD50) > 10 ||
        Math.abs(relPctD84) > 10;

      perPhotoJack.push({
        photoId: target.input.photoId,
        label: target.input.label,
        D16Without: subPsd.D16,
        D50Without: subPsd.D50,
        D84Without: subPsd.D84,
        deltaD16,
        deltaD50,
        deltaD84,
        relPctD16,
        relPctD50,
        relPctD84,
        highInfluence,
      });
    }

    // Leave-one-out sets with nothing left to pool (e.g. only zero-weight facies photos) have no
    // estimate: the standard errors use the other photos' replicates.
    const jackSe = (vals: readonly number[]): number => {
      const v = vals.filter((x) => Number.isFinite(x));
      const k = v.length;
      if (k < 2) return Number.NaN;
      const m = v.reduce((a, b) => a + b, 0) / k;
      return Math.sqrt(((k - 1) / k) * v.reduce((a, b) => a + (b - m) ** 2, 0));
    };
    const seD16 = jackSe(perPhotoJack.map((r) => r.D16Without));
    const seD50 = jackSe(perPhotoJack.map((r) => r.D50Without));
    const seD84 = jackSe(perPhotoJack.map((r) => r.D84Without));

    const logSe = emptyPsd();
    for (const key of PSD_KEYS) logSe[key] = jackSe(logWithout[key]);
    jackknife = { perPhoto: perPhotoJack, seD16, seD50, seD84, logSe };
  }

  return { jackknife, d50WithoutMap };
}

/** Bootstrap replicates per intermediate convergence CI (the final point uses the full bootstrap). */
export const CONVERGENCE_REPLICATES = 100;

/** At most this many photo counts get a bootstrap CI on the convergence curve. */
export const MAX_CONVERGENCE_CI_POINTS = 15;

/** Photo counts (1..n) that get a convergence CI: all when n <= max, else evenly spaced incl. 1 and n. */
export function convergenceCheckpoints(n: number, max = MAX_CONVERGENCE_CI_POINTS): Set<number> {
  const out = new Set<number>();
  if (n <= max) {
    for (let k = 1; k <= n; k++) out.add(k);
    return out;
  }
  for (let i = 0; i < max; i++) out.add(1 + Math.round((i * (n - 1)) / (max - 1)));
  return out;
}

/**
 * D16/D50/D84 as photos are added one by one (every photo count), with the D50 site interval
 * (`calibrateSiteInterval`; `boot` is the interval reported for all photos)
 * at up to `MAX_CONVERGENCE_CI_POINTS` evenly spaced counts (the last point uses the full
 * bootstrap; the others use `CONVERGENCE_REPLICATES`). Other points have NaN CI fields. Bounding the CI points keeps the cost linear
 * in the number of photos (a bootstrap at every photo count would be quadratic).
 */
export function computeConvergence(
  preparedPhotos: readonly PreparedPhoto[],
  psd: PsdPercentiles,
  boot: ReturnType<typeof runBootstrap>,
  opts: {
    poolingMode: PoolingMode;
    unit: 'mm' | 'px';
    bootstrapReplicates: number;
    bootstrapSeed: number;
    bootstrapTwoStage: boolean;
    confidenceLevel: 0.9 | 0.95;
  },
): ConvergencePoint[] {
  const { poolingMode, unit, bootstrapReplicates, bootstrapSeed, bootstrapTwoStage, confidenceLevel } = opts;
  const n = preparedPhotos.length;
  const convergence: ConvergencePoint[] = [];
  if (n === 0) return convergence;
  const pool = buildSortedPool(preparedPhotos);
  const base = singleCopyWeights(preparedPhotos, pool, poolingMode);
  const scratch = { total: new Float64Array(pool.n) };
  const checkpoints = convergenceCheckpoints(n);
  let runningGrains = 0;
  for (let k = 1; k <= n; k++) {
    const last = preparedPhotos[k - 1]!;
    runningGrains += last.validGrains.length;
    const isLast = k === n;
    const subPsd = isLast ? psd : subsetPercentiles(preparedPhotos, pool, base, (pi) => pi < k, scratch);
    let ciLo = Number.NaN;
    let ciHi = Number.NaN;
    if (isLast) {
      ciLo = boot.psdCi.lower.D50;
      ciHi = boot.psdCi.upper.D50;
    } else if (checkpoints.has(k)) {
      const subBoot = runBootstrap(
        preparedPhotos.slice(0, k),
        poolingMode,
        unit,
        Math.min(bootstrapReplicates, CONVERGENCE_REPLICATES),
        bootstrapSeed + k,
        bootstrapTwoStage,
        confidenceLevel,
        prefixPool(pool, k),
      );
      // Same calibrated interval as the final point (t-interval on the log scale for k photos).
      const fwSub = unit === 'mm' ? computeFolkWardStats(subPsd) : null;
      const jk = k >= 2 ? computeJackknife(preparedPhotos.slice(0, k), poolingMode, subPsd).jackknife : null;
      const cal = calibrateSiteInterval(subBoot, { psd: subPsd, folkWard: fwSub }, k, confidenceLevel, jk?.logSe);
      ciLo = cal.psdCi.lower.D50;
      ciHi = cal.psdCi.upper.D50;
    }
    const width = ciHi - ciLo;
    convergence.push({
      photoCount: k,
      photoId: last.input.photoId,
      label: last.input.label,
      cumulativeGrains: runningGrains,
      D16: subPsd.D16,
      D50: subPsd.D50,
      D84: subPsd.D84,
      ciLoD50: ciLo,
      ciHiD50: ciHi,
      ciWidthD50: width,
      relativeHalfWidthD50Pct: subPsd.D50 > 0 ? (width / (2 * subPsd.D50)) * 100 : Number.NaN,
    });
  }
  return convergence;
}
