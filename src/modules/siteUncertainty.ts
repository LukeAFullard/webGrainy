/**
 * Uncertainty of site statistics: cluster/two-stage bootstrap, binomial order-statistic CIs, leave-one-photo-out jackknife, convergence curve.
 * Split out of siteAnalysis.ts, which re-exports the public parts.
 */
import type { PsdPercentiles } from '../types/index.js';
import { computeFolkWardStats, computePsdPercentiles } from './sedimentStats.js';
import { PSD_KEYS, PERCENTILE_NUMS, type PreparedGrain, type PreparedPhoto, emptyPsd, quantileSorted, buildPooledArrays } from './sitePooling.js';
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

export function lnGamma(z: number): number {
  const g = 7;
  const p = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  const zm1 = z - 1;
  let x = p[0] ?? 1;
  for (let i = 1; i < g + 2; i++) {
    x += (p[i] ?? 0) / (zm1 + i);
  }
  const t = zm1 + g + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (zm1 + 0.5) * Math.log(t) -
    t +
    Math.log(x)
  );
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
    const z = alpha <= 0.055 ? 1.959963984540054 : 1.6448536269514722;
    const sd = Math.sqrt(n * p * (1 - p));
    const le = Math.max(0, Math.floor(n * p - z * sd));
    const ue = Math.min(n, Math.ceil(n * p + z * sd));
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

export function evalWeightedLog2PsdAtProb(
  sortedPairs: ReadonlyArray<{ v: number; w: number }>,
  cdf: Float64Array,
  prob: number,
): number {
  const count = sortedPairs.length;
  if (count === 0) return Number.NaN;
  const firstCdf = cdf[0] ?? 0;
  const lastCdf = cdf[count - 1] ?? 1;
  const firstV = sortedPairs[0]?.v ?? Number.NaN;
  const lastV = sortedPairs[count - 1]?.v ?? Number.NaN;

  if (prob <= firstCdf) return firstV;
  if (prob >= lastCdf) return lastV;

  let lo = 0;
  let hi = count - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if ((cdf[mid] ?? 0) <= prob) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const c0 = cdf[lo] ?? 0;
  const c1 = cdf[hi] ?? 1;
  const v0 = sortedPairs[lo]?.v ?? 1;
  const v1 = sortedPairs[hi]?.v ?? 1;
  if (c1 === c0) return v1;
  const t = (prob - c0) / (c1 - c0);
  const log2Val = Math.log2(v0) + t * (Math.log2(v1) - Math.log2(v0));
  return 2 ** log2Val;
}

export function computeBinomialCi(
  values: readonly number[],
  weights: readonly number[],
  poolingMode: PoolingMode,
  confidenceLevel: 0.9 | 0.95,
): BinomialCiResult {
  const alpha = confidenceLevel === 0.9 ? 0.1 : 0.05;
  const pairs: Array<{ v: number; w: number }> = [];
  let sumW = 0;
  let sumW2 = 0;

  for (let i = 0; i < values.length; i++) {
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
      sumW += w;
      sumW2 += w * w;
    }
  }

  if (pairs.length === 0 || sumW <= 0) {
    return {
      confidenceLevel,
      sampleSizeUsed: 0,
      isKishApproximation: false,
      lower: emptyPsd(),
      upper: emptyPsd(),
    };
  }

  pairs.sort((a, b) => a.v - b.v);
  const cdf = new Float64Array(pairs.length);
  let cumSum = 0;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (pair === undefined) continue;
    cumSum += pair.w;
    cdf[i] = (cumSum - 0.5 * pair.w) / sumW;
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
    lower[key] = evalWeightedLog2PsdAtProb(pairs, cdf, le / nUsed);
    upper[key] = evalWeightedLog2PsdAtProb(pairs, cdf, ue / nUsed);
  }

  return {
    confidenceLevel,
    sampleSizeUsed: nUsed,
    isKishApproximation: isKish,
    lower,
    upper,
  };
}

export function runBootstrap(
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

/** Leave-one-photo-out jackknife of D16/D50/D84, and each photo's D50 without it. */
export function computeJackknife(
  preparedPhotos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  psd: PsdPercentiles,
): { jackknife: JackknifeSensitivityReport | null; d50WithoutMap: Map<string, number> } {
  let jackknife: JackknifeSensitivityReport | null = null;
  const d50WithoutMap = new Map<string, number>();

  if (preparedPhotos.length >= 2) {
    const perPhotoJack: JackknifePhotoSensitivity[] = [];
    for (let j = 0; j < preparedPhotos.length; j++) {
      const target = preparedPhotos[j];
      if (target === undefined) continue;
      const subset = preparedPhotos.filter((_, idx) => idx !== j);
      const subPool = buildPooledArrays(subset, poolingMode);
      const subPsd = computePsdPercentiles(subPool.values, subPool.weights);

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

    const n = perPhotoJack.length;
    const mean16 =
      perPhotoJack.reduce((s, r) => s + r.D16Without, 0) / n;
    const mean50 =
      perPhotoJack.reduce((s, r) => s + r.D50Without, 0) / n;
    const mean84 =
      perPhotoJack.reduce((s, r) => s + r.D84Without, 0) / n;
    const factor = (n - 1) / n;
    const seD16 = Math.sqrt(
      factor * perPhotoJack.reduce((s, r) => s + (r.D16Without - mean16) ** 2, 0),
    );
    const seD50 = Math.sqrt(
      factor * perPhotoJack.reduce((s, r) => s + (r.D50Without - mean50) ** 2, 0),
    );
    const seD84 = Math.sqrt(
      factor * perPhotoJack.reduce((s, r) => s + (r.D84Without - mean84) ** 2, 0),
    );

    jackknife = { perPhoto: perPhotoJack, seD16, seD50, seD84 };
  }

  return { jackknife, d50WithoutMap };
}

/** D50 and its confidence interval as photos are added one by one (the last point uses the full bootstrap). */
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
  const convergence: ConvergencePoint[] = [];
  let runningGrains = 0;
  for (let k = 1; k <= preparedPhotos.length; k++) {
    const prefix = preparedPhotos.slice(0, k);
    const last = prefix[k - 1];
    if (last === undefined) continue;
    runningGrains += last.validGrains.length;

    if (k === preparedPhotos.length) {
      const ciLo = boot.psdCi.lower.D50;
      const ciHi = boot.psdCi.upper.D50;
      const width = ciHi - ciLo;
      const relHalf = psd.D50 > 0 ? (width / (2 * psd.D50)) * 100 : Number.NaN;
      convergence.push({
        photoCount: k,
        photoId: last.input.photoId,
        label: last.input.label,
        cumulativeGrains: runningGrains,
        D16: psd.D16,
        D50: psd.D50,
        D84: psd.D84,
        ciLoD50: ciLo,
        ciHiD50: ciHi,
        ciWidthD50: width,
        relativeHalfWidthD50Pct: relHalf,
      });
    } else {
      const subPool = buildPooledArrays(prefix, poolingMode);
      const subPsd = computePsdPercentiles(subPool.values, subPool.weights);
      const subBoot = runBootstrap(
        prefix,
        poolingMode,
        unit,
        Math.min(bootstrapReplicates, 250),
        bootstrapSeed + k,
        bootstrapTwoStage,
        confidenceLevel,
      );
      const ciLo = subBoot.psdCi.lower.D50;
      const ciHi = subBoot.psdCi.upper.D50;
      const width = ciHi - ciLo;
      const relHalf =
        subPsd.D50 > 0 ? (width / (2 * subPsd.D50)) * 100 : Number.NaN;
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
        relativeHalfWidthD50Pct: relHalf,
      });
    }
  }
  return convergence;
}
