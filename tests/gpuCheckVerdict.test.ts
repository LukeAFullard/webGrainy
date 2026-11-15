import { describe, expect, it } from 'vitest';
import { classifyCase, overallVerdict } from '../src/modules/gpuCheckVerdict.js';

const base = { nonFiniteWebgpu: 0, maskPQ: 0.996, unmatchedGrains: 1, cellprobSignAgreementPct: 99.98 };

describe('GPU check verdict rules', () => {
  it('passes close mask agreement', () => {
    expect(classifyCase(base)).toBe('ok');
  });
  it('treats a single borderline grain on a tiny image as ok (Intel Xe-LPG report: 7 vs 6 grains, PQ 0.922)', () => {
    expect(classifyCase({ ...base, maskPQ: 0.922, unmatchedGrains: 1, cellprobSignAgreementPct: 99.97 })).toBe('ok');
  });
  it('flags real mask differences', () => {
    expect(classifyCase({ ...base, maskPQ: 0.8, unmatchedGrains: 9 })).toBe('differs');
    expect(classifyCase({ ...base, maskPQ: 0.93, unmatchedGrains: 1, cellprobSignAgreementPct: 97 })).toBe('differs');
  });
  it('flags non-finite outputs', () => {
    expect(classifyCase({ ...base, nonFiniteWebgpu: 3 })).toBe('differs');
  });
  it('flags the all-black sign flip as a numeric fault even with no grains (Intel Xe-LPG report)', () => {
    const blank = { signAgreementPct: 0, gpuGrainPixels: 0, cpuGrainPixels: 0, pixels: 65536 };
    expect(classifyCase({ ...base, maskPQ: 1, unmatchedGrains: 0, cellprobSignAgreementPct: 0, blank })).toBe('numeric');
  });
  it('flags false grains inside a black area', () => {
    const blank = { signAgreementPct: 10, gpuGrainPixels: 900, cpuGrainPixels: 0, pixels: 147456 };
    expect(classifyCase({ ...base, blank })).toBe('differs');
  });
  it('overall wording separates real-image, blank-area and numeric-only faults', () => {
    const r = (c: string, v: 'ok' | 'numeric' | 'differs', blank = false) => ({ case: c, verdict: v, hasBlankArea: blank });
    expect(overallVerdict([r('photo', 'ok'), r('all-black', 'ok', true)], 'Cellpose-SAM')).toMatch(/^✓/);
    expect(overallVerdict([r('photo', 'ok'), r('all-black', 'numeric', true), r('photo-black', 'ok', true)], 'X')).toMatch(/^⚠.*not affected/);
    expect(overallVerdict([r('photo', 'ok'), r('photo-black', 'differs', true)], 'X')).toMatch(/false grains/);
    expect(overallVerdict([r('photo', 'differs'), r('photo-black', 'differs', true)], 'X')).toMatch(/ordinary images\. Use the CPU/);
  });
});
