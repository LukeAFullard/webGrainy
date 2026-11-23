# Tidy outlines on the held-out test images (U-Net)

webGrainy 0.1.0, default analysis (Cellpose pipeline, Auto image scale, CPU/WASM), 40 test images of the
ImageGrains 2.0 data (13 sites), then **Tidy outlines** on the same masks. PQ: outline agreement with the hand outlines
(grains matched at IoU > 0.5). D50 error: area-weighted b-axis D50 (interior grains, 15 px cutoff, photo px) against the
same statistic of the hand outlines. Produced by `validation/tidy/tidy_heldout.mjs`; per image: `tidy_per_image_unet.csv`.

| | Before | After Tidy |
|---|---:|---:|
| Mean PQ | 0.540 | 0.540 |
| Median D50 error | 5.7% | 5.7% |
| Mean D50 error | 15.6% | 15.7% |

- Images with detached fragments or enclosed holes: 35 of 40; grains made of more than one piece: 248 of 3202 before Tidy, **0 after** (every grain should be one piece).
- Fragments: 294 joined a neighbouring grain, 193 removed, 2 became grains of their own; 217 holes filled.
- Pixels changed: median 0.005% of an image (max 0.026%).
- Change per image (after − before): PQ median 0.0000 (range -0.0035 to 0.0003); D50 error median 0.00 percentage points (range -0.03 to 3.67); D50 itself median 0.00%.

Examples (the photos with the most multi-part grains): `example_unet_1.png`, `example_unet_2.png`, `example_unet_3.png`.
