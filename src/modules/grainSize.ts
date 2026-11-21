/**
 * The size of a grain for the chosen size metric and unit: the one rule every statistic, cutoff,
 * histogram and export uses, so they can never disagree about a grain's size.
 */
import type { GrainMorphometrics, SizeMetric } from '../types/index.js';

/**
 * A grain's size for `metric` in `unit`, never mixing units. In px, a missing min-Feret
 * falls back to the b-axis (px). In mm, a missing mm value is derived from the grain's own
 * px value and scale (`bAxisMm / bAxisPx`); if no mm scale exists the result is NaN (the
 * grain is then skipped), never a px number labelled as mm.
 */
export function grainSizeIn(grain: GrainMorphometrics, metric: SizeMetric, unit: 'mm' | 'px'): number {
  const px = metric === 'dEq' ? grain.dEqPx : metric === 'minFeret' ? (grain.minFeretPx ?? grain.bAxisPx) : grain.bAxisPx;
  if (unit === 'px') return px;
  const mm = metric === 'dEq' ? grain.dEqMm : metric === 'minFeret' ? grain.minFeretMm : grain.bAxisMm;
  if (typeof mm === 'number' && Number.isFinite(mm)) return mm;
  const b = grain.bAxisMm;
  if (typeof b === 'number' && Number.isFinite(b) && grain.bAxisPx > 0) return px * (b / grain.bAxisPx);
  return Number.NaN;
}
