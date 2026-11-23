/**
 * Display colours of the Wentworth size classes ("Size colours" in the Display menu, and the
 * printable report's photo overlay), so the screen and the report always agree.
 */
import type { GrainMorphometrics, SizeMetric } from '../types/index.js';

export interface WentworthDisplayClass {
  label: string;
  /** Upper limit in mm (exclusive); Infinity for the last class. */
  maxMm: number;
  rgb: [number, number, number];
}

export const WENTWORTH_DISPLAY_CLASSES: readonly WentworthDisplayClass[] = [
  { label: 'Sand (< 2 mm)', maxMm: 2, rgb: [245, 166, 35] },
  { label: 'Fine–medium gravel (2–16 mm)', maxMm: 16, rgb: [59, 158, 255] },
  { label: 'Coarse gravel (16–64 mm)', maxMm: 64, rgb: [46, 204, 113] },
  { label: 'Cobble (64–256 mm)', maxMm: 256, rgb: [155, 89, 182] },
  { label: 'Boulder (≥ 256 mm)', maxMm: Number.POSITIVE_INFINITY, rgb: [231, 76, 60] },
];

/** A grain's size in mm for `sizeMetric`, or undefined when the photo is not calibrated. */
export function grainSizeMm(grain: GrainMorphometrics, sizeMetric: SizeMetric = 'bAxis'): number | undefined {
  const mm =
    sizeMetric === 'minFeret'
      ? (grain.minFeretMm ?? grain.bAxisMm)
      : sizeMetric === 'dEq'
        ? (grain.dEqMm ?? grain.bAxisMm)
        : grain.bAxisMm;
  return mm !== undefined && mm > 0 ? mm : undefined;
}

/** Index into WENTWORTH_DISPLAY_CLASSES for a size in mm. */
export function wentworthClassIndex(mm: number): number {
  const i = WENTWORTH_DISPLAY_CLASSES.findIndex((c) => mm < c.maxMm);
  return i === -1 ? WENTWORTH_DISPLAY_CLASSES.length - 1 : i;
}

/** Display colour of a grain's Wentworth class, or null when the grain has no size in mm. */
export function wentworthRgb(grain: GrainMorphometrics, sizeMetric: SizeMetric = 'bAxis'): [number, number, number] | null {
  const mm = grainSizeMm(grain, sizeMetric);
  return mm === undefined ? null : WENTWORTH_DISPLAY_CLASSES[wentworthClassIndex(mm)]!.rgb;
}
