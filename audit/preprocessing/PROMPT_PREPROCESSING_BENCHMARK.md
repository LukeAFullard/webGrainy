# Prompt: does optional image pre-processing improve webGrainy's accuracy?

Copy everything below the line into the other coding AI.

---

You are working in the repository **LukeAFullard/webGrainy**, a browser app (TypeScript,
onnxruntime-web 1.31.1) that measures grain sizes from gravel photos with the ImageGrains 2.0
models (Cellpose U-Net and Cellpose-SAM).

**Rules:**
- Create a branch `audit/preprocessing-benchmark` from `main` and work only there. Do not merge.
- Do not change `src/`, `tests/` or the user docs.
- Put everything in `audit/preprocessing/`.
- Do not commit model files or the dataset.

## Question

Does any optional image pre-processing improve accuracy, and should the app offer it or turn
it on by default? Only add what measurably helps.

Background (verify, don't assume):
- Both models normalise each colour channel to its own 1st–99th percentile before inference.
  So global brightness, exposure and white-balance changes should mostly cancel out. Confirm
  with one quick check (variant **G** below), not a full sweep.
- The app already offers CLAHE (`applyCLAHE` in `dist/modules/imagePreprocess.js`, default
  clip 2.0, 8×8 tiles, off by default). It has never been benchmarked.
- Cellpose finds grains best near the size it was trained on. Fine-grained sites (CT, NB2,
  DV_4) were the weakest in earlier benchmarks: U-Net PQ 0.10 on CT. Enlarging the image
  before inference may recover small grains, at a cost in tiles and time.

## Setup

Reuse the data and scoring of `audit/followup/imagegrains_heldout_followup_colab.ipynb` and
`audit/quantization/imagegrains_final_4model_benchmark_colab.ipynb`:
- `IG2_data.zip` (Zenodo 17866827), `official_split == 'test'`, n = 40 images, 13 sites.
- Models from Hugging Face `inYourOwnBrowser/imagegrains-2.0-onnx` at revision
  `98e76b1374dc22cfff8193aca71c308f2b4dd3b3`:
  - `ig2_unet_fp32.onnx`;
  - `ig2_cpsam_int8_wo_fp32scale.onnx`, the app's CPU default. Use FP16 only as a spot check
    on 5 images.
- Run the **shipped TypeScript pipeline** (`npm ci && npm run build`, then
  `audit/followup/ts_cellpose_runner.mjs` and `flowsToMasksBrowser` with the app defaults:
  flow 0.45, cellprob 0, min size 30, max area fraction 0.40).
  - Apply each pre-processing step to the image the app would pass to inference: after
    `prepareWorkingImage(..., 'auto')`, which shrinks the longest side to ≤ 1024 px.
  - For INT8, the native WASM path or the Python ORT bridge may be used only if it matches
    WASM on 5 tiles. Otherwise use WASM.
- **Measure in original-photo pixels.** When an image is resized by a factor s, divide the
  measured lengths by s and areas by s². Compare against the ground-truth masks at their own
  resolution. For PQ against ground truth, resize the predicted label image back to the
  ground-truth size with nearest-neighbour.

## Variants (each against the baseline, same images)

| ID | Pre-processing |
|---|---|
| **A** | Baseline (none) — what the app does today |
| **B** | CLAHE, clip 2.0 (the app's option) |
| **C** | CLAHE, clip 3.0 |
| **D** | Upscale ×1.5 (bilinear) before inference |
| **E** | Upscale ×2.0 (bilinear) before inference |
| **F** | Adaptive upscale: run A first. If its median grain b-axis (working px) is below a threshold T, re-run with ×1.5 (or ×2). Choose T on the training split (`official_split == 'train'`), never on the 40 test images, and report T. |
| **G** | Sanity check: global gamma 0.7 and 1.4, and ±20% brightness, on 10 images. These are expected to change almost nothing. |

Optional, only if time allows: a mild denoise (bilateral or median 3×3) on the 10 noisiest
images. Report it but don't let it drive the recommendation.

## Metrics (per model × variant)

- **Agreement with ground truth:** PQ, F1@0.5, and recall of ground-truth grains by size class
  (< 10 px, 10–20 px, 20–40 px, > 40 px b-axis), to show whether small grains are recovered.
- **Size errors:** D16 / D50 / D84 absolute % error (mean and median), and signed bias.
- **Paired comparisons against A:** bootstrap 95% CIs (10,000 draws) on the per-image
  difference in D50 APE and in PQ, plus wins / losses / sign test.
- **Per-site breakdown,** highlighting CT, NB2, DV_4 and the coarse sites (NZ2, APF_2).
  Upscaling must not hurt coarse sites.
- **Cost:** tiles per image and wall time (WASM, state the thread count) for every variant.
  Upscaling ×2 means about 4× the tiles.

## Decision rule (state pass/fail)

Recommend a variant **as the default** only if all three hold:
- the 95% CI of the paired D50-APE difference against A is below 0, or PQ improves by ≥ 0.01
  with a CI excluding 0;
- no site's median D50 APE gets worse by more than 2 percentage points;
- the runtime cost is stated.

Recommend it **as an option** if it helps a definable group of photos (e.g. fine gravel) and
the app can detect that group automatically, as in variant F. Say how.

Otherwise recommend leaving it out, or removing CLAHE if it hurts.

## Deliverables

- `audit/preprocessing/preprocessing_benchmark_colab.ipynb`:
  - runs top to bottom on a fresh Colab (High-RAM CPU is fine; GPU not needed);
  - has a `CONFIG` cell for models, variants, number of images and Drive paths;
  - caches per-image results on Drive.
- `audit/preprocessing/results.json` and `results_per_image.csv`.
- `audit/preprocessing/README.md` containing:
  - a plain-language summary table (variant, PQ, D50 error, small-grain recall, time, verdict);
  - the per-site table;
  - the recommendation, with the exact settings to implement (e.g. "auto-upscale ×1.5 when
    baseline median b-axis < 12 px");
  - the commands to reproduce.
- Fixed seeds. No credentials in the notebook. Commit and push to
  `audit/preprocessing-benchmark`; do not open a PR unless asked.
