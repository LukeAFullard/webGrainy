# Survey-change test: false-positive rate

`false_positive_rate.audit.ts` compares two simulated surveys of the same, unchanged bed with the
app's own `computeComparedSites` / `surveyChanges` and counts D50 changes with p < 0.05
(nominal 5%). 250 lognormal grains per photo (median 40 mm, sd 0.6 in ln units); each photo's
median varies by "patch sd" (ln units). 150 trials per row, 300 bootstrap replicates.

```bash
npx vitest run --config validation/comparison/vitest.config.ts
```

Results with the shipped test (200 trials per row; Welch t-test with each site's error
inflated by sqrt(n/(n-1)); one-photo sites get no test):

| Photos per survey | Patch sd | p given | p < 0.05 |
| ---: | ---: | ---: | ---: |
| 1 | 0.15 | 0 / 200 | — (no test) |
| 2 | 0.15 | 200 / 200 | 3.0% |
| 3 | 0.15 | 200 / 200 | 4.0% |
| 6 | 0.15 | 200 / 200 | 3.5% |
| 20 | 0.15 | 200 / 200 | 5.0% |
| 3 | 0 | 200 / 200 | 3.0% |
| 6 | 0 | 200 / 200 | 4.5% |
| 20 | 0 | 200 / 200 | 6.0% |

Before the fixes, the same comparisons reported p < 0.05 in about 30% of one-photo surveys
(their bootstrap only resamples grains within the photo and cannot see patch-to-patch
variation) and 17-40% with 2-4 photos (a z-test on a cluster bootstrap with few photos is
too narrow). The price of a calibrated test is power: with 6 photos per survey, a real 20%
change in D50 was detected in about 37% of simulated pairs (the old test's 50% included its
false positives). Take more photos per survey to detect smaller changes.
