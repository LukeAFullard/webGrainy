# Survey-change test: false-positive rate

`false_positive_rate.audit.ts` compares two simulated surveys of the same, unchanged bed with the
app's own `computeComparedSites` / `surveyChanges` and counts D50 changes with p < 0.05
(nominal 5%). 250 lognormal grains per photo (median 40 mm, sd 0.6 in ln units); each photo's
median varies by "patch sd" (ln units). 400 trials per row, 500 bootstrap replicates.

```bash
npx vitest run --config validation/comparison/vitest.config.ts
```

Results with the shipped test (400 trials per row, 500 bootstrap replicates; each site's SE is
the larger of the bootstrap SE x sqrt(n/(n-1)) and the leave-one-photo-out jackknife SE; Welch
t-test with n-1 degrees of freedom per site; one-photo sites get no test). The script also
writes this table to `false_positive_rate_results.md`:

| Photos per survey | Patch sd | p given | D16 p < 0.05 | D50 p < 0.05 | D84 p < 0.05 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.15 | 0 / 400 | 0.0% | 0.0% | 0.0% |
| 2 | 0.15 | 400 / 400 | 2.3% | 2.0% | 3.5% |
| 3 | 0.15 | 400 / 400 | 3.8% | 3.5% | 1.3% |
| 5 | 0.15 | 400 / 400 | 3.0% | 4.5% | 3.3% |
| 10 | 0.15 | 400 / 400 | 4.3% | 5.0% | 3.5% |
| 20 | 0.15 | 400 / 400 | 4.3% | 4.3% | 4.5% |
| 3 | 0.30 | 400 / 400 | 1.8% | 1.8% | 1.5% |
| 5 | 0.30 | 400 / 400 | 3.8% | 4.8% | 3.5% |
| 10 | 0.30 | 400 / 400 | 7.8% | 7.3% | 6.8% |
| 20 | 0.30 | 400 / 400 | 3.3% | 4.0% | 4.0% |
| 6 | 0.00 | 400 / 400 | 2.5% | 4.0% | 2.0% |

With the bootstrap SE alone (the previous version), 5–20 photos gave 7–12% at patch sd 0.3.
Unadjusted p-values over many pairs still give false positives (8 identical sites: at least one
p < 0.05 in 59% of studies), so the app also reports Holm-adjusted p-values.

Before the fixes, the same comparisons reported p < 0.05 in about 30% of one-photo surveys
(their bootstrap only resamples grains within the photo and cannot see patch-to-patch
variation) and 17-40% with 2-4 photos (a z-test on a cluster bootstrap with few photos is
too narrow). The price of a calibrated test is power: with 6 photos per survey, a real 20%
change in D50 was detected in about 37% of simulated pairs (the old test's 50% included its
false positives). Take more photos per survey to detect smaller changes.
