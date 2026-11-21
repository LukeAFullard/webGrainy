# Held-out accuracy of the shipped app (webGrainy 0.1.0 / 0.1.0-dev)

40 test images (13 sites) of the ImageGrains 2.0 data against hand-digitised outlines. App default
analysis (Cellpose pipeline, Auto image scale, default post-processing, CPU/WASM) and the numbers the
app reports: area-weighted b-axis percentiles in photo px, interior grains, grains under 15 px left out
(the same rule applied to the hand outlines). Errors are absolute % differences per image, with
95% intervals from a site-cluster bootstrap (whole sites resampled, since images of one site are
not independent). Produced by `run_app_heldout.mjs` + `score_app_heldout.py`.

| Model | n | D50 error: mean [95% CI] | D50 error: median [95% CI] | D16 / D84 median error | D50 error > 50% | D50 median bias | PQ vs hand outlines |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: |
| U-Net | 40 | 15.6% [7.3, 25.1] | 5.7% [2.8, 19.3] | 8.4% / 2.4% | 10.0% | -0.4% | 0.540 |
| Cellpose-SAM (INT8, CPU) | 40 | 8.9% [3.7, 14.9] | 2.9% [1.9, 5.3] | 5.1% / 1.1% | 5.0% | +0.3% | 0.654 |

n < 40 where an image has no grain of at least 15 px in the prediction or the hand outlines.
Several versions: an image is re-run only when a version changes its analysis (e.g. 0.1.0's Auto
image scale changed the 2 images over 1,024 px); the other images give identical results.
