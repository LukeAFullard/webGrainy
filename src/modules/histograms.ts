/**
 * Histogram data for the dashboard charts (binning only; drawing is in ui/charts.ts).
 */
import type { GrainMorphometrics, SizeMetric } from '../types/index.js';
import { grainSizeIn } from './grainSize.js';
import { computeWentworthHistogram, type WentworthBin } from './morphometricsExt.js';

export interface SizeHistogramBin {
  /** Bin edges in `unit`, smaller first. */
  lo: number;
  hi: number;
  /** Wentworth class (mm only). */
  className?: string;
  count: number;
  /** Share of the distribution weight (area-weighted = grid-by-number), %. */
  weightPct: number;
}

export interface SizeHistogram {
  unit: 'mm' | 'px';
  /** Bin width in log2 units (0.5 or 1; = φ for mm). */
  step: 0.5 | 1;
  /** Bins ordered from small to large size. */
  bins: SizeHistogramBin[];
  n: number;
}

/** From Wentworth φ bins (mm; φ increases towards fine) to small-to-large size bins. */
export function sizeHistogramFromWentworth(bins: readonly WentworthBin[], step: 0.5 | 1): SizeHistogram {
  const out = [...bins]
    .map((b) => ({ lo: b.mmMin, hi: b.mmMax, className: b.wentworthClass, count: b.grainCount, weightPct: b.weightPct }))
    .sort((a, b) => a.lo - b.lo);
  return { unit: 'mm', step, bins: out, n: out.reduce((s, b) => s + b.count, 0) };
}

function metricValue(g: GrainMorphometrics, metric: SizeMetric, unit: 'mm' | 'px'): number | undefined {
  const v = grainSizeIn(g, metric, unit);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Area-weighted size histogram of a photo's grains on a log2 scale: Wentworth φ classes
 * when calibrated (mm), otherwise power-of-two pixel classes (e.g. 8–16 px).
 */
export function photoSizeHistogram(
  grains: readonly GrainMorphometrics[],
  options: { step?: 0.5 | 1; sizeMetric?: SizeMetric } = {},
): SizeHistogram {
  const step = options.step ?? 1;
  const metric = options.sizeMetric ?? 'bAxis';
  const calibrated = grains.length > 0 && grains.every((g) => typeof g.bAxisMm === 'number' && Number.isFinite(g.bAxisMm));
  if (calibrated) {
    return sizeHistogramFromWentworth(computeWentworthHistogram(grains, { stepPhi: step, weighted: true, sizeMetric: metric }), step);
  }
  const counts = new Map<number, { count: number; w: number }>();
  let total = 0;
  for (const g of grains) {
    const d = metricValue(g, metric, 'px');
    if (d === undefined || !(d > 0) || !Number.isFinite(d)) continue;
    const k = Math.floor(Math.log2(d) / step);
    const e = counts.get(k) ?? { count: 0, w: 0 };
    e.count++;
    e.w += g.areaPx;
    total += g.areaPx;
    counts.set(k, e);
  }
  if (counts.size === 0 || total <= 0) return { unit: 'px', step, bins: [], n: 0 };
  const keys = [...counts.keys()];
  const bins: SizeHistogramBin[] = [];
  for (let k = Math.min(...keys); k <= Math.max(...keys); k++) {
    const e = counts.get(k) ?? { count: 0, w: 0 };
    bins.push({ lo: 2 ** (k * step), hi: 2 ** ((k + 1) * step), count: e.count, weightPct: (e.w / total) * 100 });
  }
  return { unit: 'px', step, bins, n: bins.reduce((s, b) => s + b.count, 0) };
}

/** Counts of b/a aspect ratios in `numBins` equal bins over [0, 1]. */
export function aspectRatioCounts(ratios: readonly number[], numBins = 10): number[] {
  const counts = new Array<number>(numBins).fill(0);
  for (const r of ratios) {
    if (!Number.isFinite(r)) continue;
    const idx = Math.min(numBins - 1, Math.max(0, Math.floor(r * numBins)));
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return counts;
}
