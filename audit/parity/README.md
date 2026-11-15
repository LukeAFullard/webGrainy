# Why webGrainy's outlines differed from PyTorch ImageGrains, and the fix

## Question
The browser engine matched PyTorch ImageGrains on D50, but its grain outlines were
worse: panoptic quality (PQ) vs hand-digitised masks was about 0.53 vs 0.63 for
Cellpose-SAM on the full benchmark. Where did the gap come from?

## Method
- **Images:** 7 held-out IG2 test images (`official_split == test`, 6 sites) with
  hand-digitised masks. They were fetched from Zenodo with `fetch_ig2_files.py`.
- **Reference:** upstream **PyTorch Cellpose** with the original weights
  (Zenodo 15728186), using the benchmark settings:
  - U-Net: Cellpose 3.1.1.1 (`channels=[0,0]`, `diameter=30`);
  - Cellpose-SAM: Cellpose 4.1.1 (`diameter=None`, `tile_overlap=0.25`).
- **Sources compared:** each source's network output (flows + cell probability) goes
  through the **same** Cellpose dynamics, and the masks are scored by PQ vs ground truth
  and vs PyTorch. The sources are:
  - PyTorch;
  - **our ONNX model inside Cellpose's own pipeline**, with only the network swapped
    (`OnnxNet`);
  - webGrainy's real output, dumped from `dist/`;
  - single-change variants.

## Findings
1. **The ONNX models are exact.** Inside Cellpose's pipeline, our U-Net gives
   *identical* masks to PyTorch (PQ vs PyTorch 1.000). Cellpose-SAM gives 0.995; the
   remainder is float16 vs bfloat16 precision.
2. **The gap came entirely from how webGrainy prepared and tiled the photo:**
   - **U-Net:** Cellpose 3 resizes the image by `diam_mean/diameter = 17/30`. It then
     runs **224 px tiles**, so the network's global "style" vector is computed per tile,
     with an 8 px zero border and sigmoid-taper blending. webGrainy ran the whole image
     at full size. Resizing alone made things worse; resizing plus tiling reproduces
     PyTorch.
   - **Cellpose-SAM:** Cellpose 4 pads every image with an **8 px zero border**, and pads
     images under 256 px with zeros up to 256. That single difference accounts for
     essentially all of the gap. Per-channel normalisation, taper and tile placement each
     changed PQ by less than 0.01.

| Network output → Cellpose dynamics (7 images) | U-Net PQ vs GT | U-Net PQ vs PT | CP-SAM PQ vs GT | CP-SAM PQ vs PT |
|---|---|---|---|---|
| PyTorch Cellpose | 0.445 | 1.000 | 0.565 | 1.000 |
| webGrainy legacy pipeline (≤ v1.1) | 0.413 | 0.575 | 0.488 | 0.775 |
| **webGrainy Cellpose pipeline (new default)** | **0.445** | **1.000** | **0.565** | **0.995** |

End to end, with webGrainy's **own** post-processor (what the app outputs):

| App result (7 images) | PQ vs GT | D50 error, median | D50 error, mean |
|---|---|---|---|
| U-Net, legacy | 0.427 | 15.5 % | 42.2 % |
| **U-Net, Cellpose pipeline** | **0.451** | **9.1 %** | 38.7 % |
| Cellpose-SAM, legacy | 0.504 | 8.6 % | 11.7 % |
| **Cellpose-SAM, Cellpose pipeline** | **0.559** | **3.3 %** | 9.7 % |

One image (`NB2__test__P5220768_2_cut`, 203 tiny grains in 231×156 px) is badly wrong in
every pipeline, including PyTorch, and dominates the U-Net means.

## Caveats
- **Sample size:** 7 images is enough to show *parity* with PyTorch, which is a
  deterministic property, but not to measure accuracy precisely.
- **Next step:** re-run the 40-image held-out benchmark with the new default.

## Files
- `cellposeTiling.ts` (in `src/modules/`): the replica. Its tests use reference values
  generated from Cellpose's own functions (`make_tiling_fixture.py` →
  `tests/fixtures/cellpose_tiling_v{3,4}.json`).
- `unet_parity.py`, `cpsam_parity.py`: variant experiments. Results are in
  `parity_unet_results.json` and `parity_cpsam_results.jsonl`.
- `cpsam_tile_probe.py`: found the 8 px border by capturing Cellpose's actual input tiles.
- `dump_ours*.mjs`, `score_dirs.py`, `our_postprocess.mjs`, `score_masks.py`: TypeScript
  output dumps and scoring. Results are in `score_unet.json` and `score_cpsam.json`.
