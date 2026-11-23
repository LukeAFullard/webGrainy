# Tidy outlines on the held-out test images (Cellpose-SAM INT8)

webGrainy 0.1.0, default analysis (Cellpose pipeline, Auto image scale, CPU/WASM), 40 test images of the
ImageGrains 2.0 data (13 sites), then **Tidy outlines** on the same masks. PQ: outline agreement with the hand outlines
(grains matched at IoU > 0.5). D50 error: area-weighted b-axis D50 (interior grains, 15 px cutoff, photo px) against the
same statistic of the hand outlines. Produced by `validation/tidy/tidy_heldout.mjs`; per image: `tidy_per_image_cpsam.csv`.

| | Before | After Tidy |
|---|---:|---:|
| Mean PQ | 0.654 | 0.655 |
| Median D50 error | 2.9% | 2.6% |
| Mean D50 error | 8.9% | 8.7% |

- Images with detached fragments or enclosed holes: 36 of 40; grains made of more than one piece: 339 of 4352.
- Fragments: 423 joined a neighbouring grain, 215 removed, 0 became grains of their own; 152 holes filled.
- Pixels changed: median 0.003% of an image (max 0.160%).
- Change per image (after − before): PQ median 0.0000 (range -0.0002 to 0.0007); D50 error median 0.00 percentage points (range -4.48 to 0.13); D50 itself median 0.00%.

Examples (the photos with the most multi-part grains): `example_cpsam_1.png`, `example_cpsam_2.png`, `example_cpsam_3.png`.
