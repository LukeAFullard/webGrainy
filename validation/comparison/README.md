# Survey-change test: false-positive rate

`false_positive_rate.audit.ts` compares two simulated surveys of the same, unchanged bed with the
app's own `computeComparedSites` / `surveyChanges` and counts D50 changes with p < 0.05
(nominal 5%). 250 lognormal grains per photo (median 40 mm, sd 0.6 in ln units); each photo's
median varies by "patch sd" (ln units). 150 trials per row, 300 bootstrap replicates.

```bash
npx vitest run --config validation/comparison/vitest.config.ts
```

Results (after the single-photo fix):

| Photos per survey | Patch sd | p given | p < 0.05 |
| ---: | ---: | ---: | ---: |
| 1 | 0.15 | 0 / 150 | — (no test) |
| 3 | 0.15 | 150 / 150 | 21.3% |
| 6 | 0.15 | 150 / 150 | 8.7% |
| 20 | 0.15 | 150 / 150 | 8.0% |
| 6 | 0 | 150 / 150 | 8.0% |
| 20 | 0 | 150 / 150 | 6.7% |

Before the fix, one-photo surveys gave about 30% false "significant" changes at patch sd 0.15:
their bootstrap only resamples grains within the photo and cannot see patch-to-patch variation.
They now get no interval or p-value. Surveys with fewer than 5 photos are flagged as rough in the
compare view and CSV; the test is still anti-conservative there (and mildly so above 5 photos),
which a small-sample correction could address.
