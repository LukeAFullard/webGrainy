/**
 * Wall-clock budgets for micro-benchmarks embedded in the unit suite.
 *
 * Timing is not a correctness property and is unreliable on shared CI runners or under
 * parallel test load (the audit measured 57-104 ms for a "< 5 ms" check). By default the
 * nominal budget is multiplied by 50 so the assertion still catches algorithmic
 * regressions (e.g. accidental O(n^2)) without flaking. Run `npm run test:perf`
 * (PERF_STRICT=1) on an idle machine to enforce the nominal budgets.
 */
export function perfBudget(nominalMs: number): number {
  const strict = typeof process !== 'undefined' && process.env['PERF_STRICT'] === '1';
  return strict ? nominalMs : nominalMs * 50;
}
