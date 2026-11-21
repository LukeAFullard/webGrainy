# K1 field comparison with the shipped app (webGrainy 0.1.0)

Produced by `node validation/k1/run_app_k1.mjs` (see the script header). Both K1 demo photos, 0.39 mm/px,
app default analysis (Cellpose pipeline, Auto image scale, default post-processing, CPU/WASM) and
the app's site statistics (`analyzeSite`, default settings: area-weighted, b-axis, 15 px cutoff, harmonised
detection limit, 95% interval with the few-photo correction).

Field count: n = 251 b-axes, smallest 13 mm. D16 / D50 / D84 = 19.0 / 27.0 / 48.3 mm
(each stone once, the app's percentile rule).

| Model | Field-count cutoff | Photo grains counted | D16 | D50 (95% interval) | D84 | D50 vs field | D84 vs field |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| U-Net | none (limit 5.9 mm) | 1200 | 10.4 | 21.1 (13.6–33.0) | 44.8 | -22% | -7% |
| U-Net | 10 mm | 639 | 12.8 | 23.9 (14.7–38.7) | 45.4 | -12% | -6% |
| U-Net | 13 mm | 346 | 16.9 | 27.7 (19.3–39.9) | 45.9 | +3% | -5% |
| U-Net | 16 mm | 227 | 19.5 | 29.6 (20.2–43.4) | 47.3 | +10% | -2% |
| Cellpose-SAM (INT8) | none (limit 5.9 mm) | 1851 | 8.4 | 18.7 (14.2–24.7) | 43.9 | -31% | -9% |
| Cellpose-SAM (INT8) | 10 mm | 591 | 13.4 | 24.8 (18.5–33.2) | 44.8 | -8% | -7% |
| Cellpose-SAM (INT8) | 13 mm | 335 | 16.9 | 27.8 (18.8–41.1) | 45.3 | +3% | -6% |
| Cellpose-SAM (INT8) | 16 mm | 217 | 19.6 | 30.4 (23.9–38.6) | 47.3 | +12% | -2% |

Caveats: one site and two photos, both of which overlap the ImageGrains training data (a consistency
check, not an independent validation); the cutoff is the smallest clast in the field data, not a
documented protocol; with 2 photos the interval is wide by design (t with 1 degree of freedom).
