# Tidy outlines on the held-out test images (Cellpose-SAM INT8): partial run, 32 of 40 images

Same procedure as `tidy_results_unet.md` (`validation/tidy/tidy_heldout.mjs cpsam`). On the CPU the run
was stopped at a 2-hour time limit after 32 of the 40 test images, before the script wrote its summary
and examples; the per-image lines it printed are in `tidy_cpsam_partial_log.txt`, and the figures below
are computed from them. Re-run the script on a faster machine for all 40 images.

| First 32 test images | Before | After Tidy |
|---|---:|---:|
| Mean PQ | 0.628 | 0.629 |
| Median D50 error | 3.0% | 3.0% |
| Mean D50 error | 10.0% | 10.0% |

- Images with detached fragments or enclosed holes: 28 of 32; grains made of more than one piece: 218.
- Fragments: 262 joined a neighbouring grain, 171 removed, 0 became grains of their own; 127 holes filled.
- Change per image (after − before): D50 error median 0.0 percentage points (range −0.1 to +0.2); PQ +0.000 to +0.001.
