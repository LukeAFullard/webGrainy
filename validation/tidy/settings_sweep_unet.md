# Settings and stray fragments (U-Net)

The 40 held-out test images of the ImageGrains 2.0 data, analysed with the defaults and with one setting changed at a time,
then with **Tidy outlines**. Fragments: extra 4-connected pieces of grains (each grain should be one piece); PQ: outline
agreement with the hand outlines (IoU > 0.5); D50 error: area-weighted b-axis D50 (interior grains, 15 px cutoff) against the
hand outlines. Photos better / worse: PQ changed by more than 0.005 against the defaults. Produced by
`validation/tidy/settings_sweep.mjs`.

| Setting | Mean PQ | Mean PQ after Tidy | Median D50 error | Mean D50 error | Fragments | Grains in pieces | Grains | Photos better / worse (PQ) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Defaults | 0.540 | 0.540 | 5.7% | 15.6% | 489 | 248 | 3202 | – |
| Cellprob threshold −0.5 | 0.543 | 0.543 | 6.2% | 16.0% | 671 | 341 | 3512 | 17 / 13 |
| Cellprob threshold +0.5 | 0.526 | 0.526 | 4.2% | 13.7% | 424 | 229 | 2943 | 8 / 26 |
| Cellprob threshold +1 | 0.503 | 0.503 | 5.5% | 13.7% | 409 | 217 | 2652 | 3 / 33 |
| Flow threshold 0.3 | 0.536 | 0.536 | 7.1% | 16.5% | 399 | 211 | 3039 | 3 / 15 |
| Flow threshold 0.6 | 0.540 | 0.540 | 4.9% | 15.5% | 762 | 273 | 3279 | 5 / 7 |
| Seed density 4 | 0.541 | 0.541 | 5.7% | 15.6% | 490 | 249 | 3206 | 2 / 0 |
| Flow steps 400 | 0.540 | 0.540 | 5.7% | 15.6% | 489 | 248 | 3202 | 0 / 0 |
| Min size 60 px² | 0.540 | 0.540 | 5.7% | 15.6% | 489 | 248 | 3201 | 0 / 0 |
| Image scale 1.0x Full | 0.540 | 0.539 | 4.9% | 15.5% | 4314 | 738 | 3630 | 1 / 1 |
| Enlarge ×1.5 | 0.564 | 0.564 | 8.8% | 19.4% | 1481 | 548 | 4156 | 26 / 12 |

*Image scale 1.0x Full* differs from *Auto* only for photos larger than 1024 px: 2 of the 40 test images.
