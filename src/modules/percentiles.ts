/**
 * The one weighted-percentile rule used for every grain-size percentile: sort grains by size,
 * give each the midpoint cumulative weight `(cumsum(w) - 0.5 w) / sum(w)`, and read a
 * percentile off that curve by linear interpolation in log2(size) (φ space), clamping to the
 * smallest / largest grain outside the curve. Same as `2 ** np.interp(p, cdf, log2(v))`.
 *
 * (The site bootstrap evaluates the same rule in a streaming form for speed,
 * `siteUncertainty.percentilesFromSorted`, and is tested against this one.)
 */

/** Valid (size > 0, weight > 0, both finite) grains sorted by size, with their midpoint CDF. */
export interface WeightedCdf {
  sizes: Float64Array;
  cdf: Float64Array;
  totalWeight: number;
}

/** Sorted sizes and midpoint cumulative weights of the valid (size, weight) pairs. */
export function weightedMidpointCdf(values: ArrayLike<number>, weights: ArrayLike<number>): WeightedCdf {
  const n = Math.min(values.length, weights.length);
  const pairs: Array<{ v: number; w: number }> = [];
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    const w = weights[i]!;
    if (Number.isFinite(v) && Number.isFinite(w) && v > 0 && w > 0) pairs.push({ v, w });
  }
  pairs.sort((a, b) => a.v - b.v);
  let total = 0;
  for (const p of pairs) total += p.w;
  const sizes = new Float64Array(pairs.length);
  const cdf = new Float64Array(pairs.length);
  let cum = 0;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    cum += p.w;
    cdf[i] = (cum - 0.5 * p.w) / total;
    sizes[i] = p.v;
  }
  return { sizes, cdf, totalWeight: total };
}

/** The size at cumulative weight `prob` (0-1): log2 interpolation, clamped at both ends; NaN when empty. */
export function sizeAtCumulative(c: WeightedCdf, prob: number): number {
  const count = c.sizes.length;
  if (count === 0) return Number.NaN;
  if (prob <= c.cdf[0]!) return c.sizes[0]!;
  if (prob >= c.cdf[count - 1]!) return c.sizes[count - 1]!;
  let lo = 0;
  let hi = count - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (c.cdf[mid]! <= prob) lo = mid;
    else hi = mid;
  }
  const c0 = c.cdf[lo]!;
  const c1 = c.cdf[hi]!;
  const v0 = c.sizes[lo]!;
  const v1 = c.sizes[hi]!;
  if (c1 === c0) return v1;
  const t = (prob - c0) / (c1 - c0);
  return 2 ** (Math.log2(v0) + t * (Math.log2(v1) - Math.log2(v0)));
}

/** `{ D<p>: size }` for each percentile `p` (0-100); NaN for every key when no grain is valid. */
export function weightedPsdPercentiles(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
  percentiles: readonly number[] = [5, 10, 16, 25, 50, 75, 84, 90, 95],
): Record<string, number> {
  const c = weightedMidpointCdf(values, weights);
  const out: Record<string, number> = {};
  for (const p of percentiles) out[`D${p}`] = sizeAtCumulative(c, p / 100);
  return out;
}
