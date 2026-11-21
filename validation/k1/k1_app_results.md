# K1 field comparison with the shipped app (webGrainy 0.1.0-dev)

Produced by `node validation/k1/run_app_k1.mjs` (see the script header). Both K1 demo photos, 0.39 mm/px,
app default analysis (Cellpose pipeline, Auto image scale, default post-processing, CPU/WASM) and
the app's site statistics (`analyzeSite`, default settings: area-weighted, b-axis, 15 px cutoff, harmonised
detection limit, 95% interval with the few-photo correction).

Field count: n = 251 b-axes, smallest 13 mm. D16 / D50 / D84 = 19.0 / 27.0 / 48.3 mm
(each stone once, the app's percentile rule).

| Model | Field-count cutoff | Photo grains counted | D16 | D50 (95% interval) | D84 | D50 vs field | D84 vs field |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| U-Net | none (limit 5.9 mm) | 519 | 14.7 | 26.4 (18.2–38.4) | 45.9 | -2% | -5% |
| U-Net | 10 mm | 428 | 15.9 | 26.8 (23.1–31.0) | 46.2 | -1% | -4% |
| U-Net | 13 mm | 317 | 17.7 | 28.0 (20.7–37.8) | 47.0 | +4% | -3% |
| U-Net | 16 mm | 230 | 19.8 | 29.5 (21.3–40.9) | 47.6 | +9% | -2% |

Caveats: one site and two photos, both of which overlap the ImageGrains training data (a consistency
check, not an independent validation); the cutoff is the smallest clast in the field data, not a
documented protocol; with 2 photos the interval is wide by design (t with 1 degree of freedom).
