/**
 * Verdict rules for the GPU check page (gpucheck.html). Kept separate from the UI so
 * they can be unit-tested.
 *
 * - Mask agreement: a case passes when the GPU and CPU grain outlines agree (PQ ≥ 0.95),
 *   or when at most one grain differs and the per-pixel grain/background call agrees on
 *   ≥ 99.5% of pixels. On tiny images (≈6 grains), one borderline grain alone pulls PQ
 *   below 0.95, which is not a meaningful difference.
 * - Blank areas: on featureless (all-black) input the CPU is confidently "background".
 *   If the GPU's cell probability has the wrong sign there, that is a float16 numeric
 *   fault even when no grain outlines happen to form. It is reported as 'numeric', and
 *   as 'differs' when the GPU also produced grain pixels inside the blank area.
 */
export type CaseVerdict = 'ok' | 'numeric' | 'differs' | 'error';

export interface CaseMetrics {
  nonFiniteWebgpu: number;
  maskPQ: number;
  /** Grains present in only one of the two results (unmatched at IoU > 0.5). */
  unmatchedGrains: number;
  /** % of pixels where GPU and CPU agree on the sign of the cell probability. */
  cellprobSignAgreementPct: number;
  /** Only for cases with a blank (all-black) area. */
  blank?: {
    signAgreementPct: number;
    gpuGrainPixels: number;
    cpuGrainPixels: number;
    pixels: number;
  };
}

export const MASK_PQ_OK = 0.95;
export const SIGN_AGREEMENT_OK = 99.5;
export const BLANK_SIGN_AGREEMENT_OK = 99;

export function classifyCase(m: CaseMetrics): CaseVerdict {
  if (m.nonFiniteWebgpu > 0) return 'differs';
  const masksOk =
    m.maskPQ >= MASK_PQ_OK || (m.unmatchedGrains <= 1 && m.cellprobSignAgreementPct >= SIGN_AGREEMENT_OK);
  if (!masksOk) return 'differs';
  if (m.blank) {
    // False grains in the blank area beyond what the CPU finds (0.1% of the area tolerance).
    const extra = m.blank.gpuGrainPixels - m.blank.cpuGrainPixels;
    if (extra > Math.max(20, 0.001 * m.blank.pixels)) return 'differs';
    if (m.blank.signAgreementPct < BLANK_SIGN_AGREEMENT_OK) return 'numeric';
  }
  return 'ok';
}

export interface VerdictInput {
  case: string;
  verdict?: CaseVerdict | undefined;
  hasBlankArea: boolean;
}

export function overallVerdict(results: VerdictInput[], modelLabel: string): string {
  if (results.every((r) => r.verdict === 'ok')) {
    return `✓ Your GPU gives the same ${modelLabel} results as the CPU. WebGPU is safe to use on this computer.`;
  }
  if (results.some((r) => r.verdict === 'error')) {
    return '✗ Part of the check failed to run (see the table and log). Please send the report.';
  }
  const realBad = results.some((r) => r.verdict === 'differs' && !r.hasBlankArea);
  const blankBad = results.some((r) => r.verdict === 'differs' && r.hasBlankArea);
  const numericOnly = results.every((r) => r.verdict === 'ok' || r.verdict === 'numeric');
  if (realBad) {
    return '✗ Your GPU gives different grain results from the CPU on ordinary images. Use the CPU for analyses on this computer, and please send the report.';
  }
  if (blankBad) {
    return '✗ Your GPU matches the CPU on ordinary images, but finds false grains in large black/blank areas (a float16 precision fault). Avoid images with large blank areas on the GPU, or use the CPU. Please send the report.';
  }
  if (numericOnly) {
    return '⚠ Your GPU gives the same grains as the CPU, but its numbers are wrong on completely black areas (a float16 precision fault). Grain outlines were not affected in this check. Please send the report.';
  }
  return '✗ Your GPU differs from the CPU. Please send the report.';
}
