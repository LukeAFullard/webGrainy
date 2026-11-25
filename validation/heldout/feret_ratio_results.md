# min-Feret vs b-axis D50 on the held-out photos

Area-weighted D50 of interior grains (15 px cutoff) measured as minimum Feret width, relative to the
moment-ellipse b-axis D50 of the same grains, on the app's own outlines of the 40 held-out test photos.
Produced by `feret_ratio.mjs` from the masks written by `run_app_heldout.mjs`.

| Model | Photos | Median difference | Middle half | Range |
| --- | ---: | ---: | --- | --- |
| U-Net | 40 | +3.3% | +0.6% to +3.9% | -4.3% to +10.6% |
| Cellpose-SAM (INT8) | 40 | +2.9% | +0.2% to +4.5% | -4.1% to +13.1% |
