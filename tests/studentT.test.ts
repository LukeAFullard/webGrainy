import { describe, expect, it } from 'vitest';
import { tTwoSidedP, tTwoSidedQuantile } from '../src/modules/studentT.js';

describe('Student t', () => {
  it('quantiles match standard tables', () => {
    for (const [df, q] of [[1, 12.7062047], [2, 4.30265273], [5, 2.57058184], [10, 2.22813885], [30, 2.04227246], [1000, 1.96233908]] as const) {
      expect(tTwoSidedQuantile(0.95, df)).toBeCloseTo(q, 6);
    }
    expect(tTwoSidedQuantile(0.9, 4)).toBeCloseTo(2.13184679, 6);
  });
  it('two-sided p-values match scipy.stats.t.sf * 2', () => {
    expect(tTwoSidedP(2, 10)).toBeCloseTo(0.0733880347, 8);
    expect(tTwoSidedP(1, 1)).toBeCloseTo(0.5, 10);
    expect(tTwoSidedP(0, 7)).toBeCloseTo(1, 12);
    expect(tTwoSidedP(3.5, 2.7)).toBeGreaterThan(0.03);
    expect(tTwoSidedP(1.959963984540054, 1e7)).toBeCloseTo(0.05, 5);
  });
});
