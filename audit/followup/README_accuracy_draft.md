# Draft: Updated README Accuracy Table & Limitations Wording

> **Status:** All numbers below are **verified** from `audit/followup/heldout_summary.json` and `audit/followup/heldout_results_per_image.csv` (executed in Google Colab on `official_split == 'test'`, `n = 40` across all 13 sites in `IG2_data.zip`, using the actual shipped TypeScript post-processing engine `src/modules/postprocessCore.ts` + `src/modules/morphometricsExt.ts` with pinned HF revision `7773328a544ac050b7820667e68cbfb02a2e954a`).

---

## Hosted ONNX Models & Benchmark Accuracy (Draft)

Models are hosted at [`inYourOwnBrowser/imagegrains-2.0-onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx) (pinned revision `7773328a544ac050b7820667e68cbfb02a2e954a`).

### 1. Official Within-Site Test Split (`IG2_data.zip`, `official_split == 'test'`, `n = 40` across 13 sites)

Evaluated using the **actual shipped TypeScript engine** (`src/modules/postprocessCore.ts`, frozen v1.1.0 defaults: `niter=250, cellprobThreshold=0.0, flowThreshold=0.45, minSize=30, minSeedDensity=2, excludeBorderMargin=2`) with `maxGrainAreaFraction = 0.15` (shipped v1.1.0 default) vs `1.00` (ablation, guard disabled), alongside **upstream PyTorch ImageGrains**, against **hand-digitised 2D pixel masks** (`bAxis`, moment-ellipse minor axis; *not* physical sieve/Wolman data):

#### D50 Error vs Human GT (Primary Grain-Size Metric)

| Model | Engine / Guard | D50 MAPE: mean [95% CI] | D50 MAPE: median [95% CI] | P90 / >25% / >50% | Signed bias (med / mean) | PQ vs GT |
| :--- | :--- | :--- | :--- | :--- | :--- | ---: |
| **U-Net** (`ig2_unet_fp32.onnx`, 26.5 MB) | Shipped TS v4.1 (`guard = 0.15`, v1.1.0) | `31.02%` `[19.76, 45.54]` | `15.31%` `[9.17, 26.25]` | `83.31%` / `35.0%` / `20.0%` | `-8.93%` / `-10.10%` | `0.480` |
| **U-Net** (`ig2_unet_fp32.onnx`) | Shipped TS v4.1 (`guard = 1.00`, ablation) | `27.48%` `[16.93, 42.12]` | `14.84%` `[7.35, 23.02]` | `83.31%` / `30.0%` / `17.5%` | `-2.38%` / `-3.74%` | `0.485` |
| **U-Net** (`IG2_full_set.200525`) | Upstream PyTorch (`cellpose==3.1.1.1`) | `27.47%` `[14.83, 46.34]` | `9.26%` `[6.33, 17.04]` | `78.51%` / `27.5%` / `15.0%` | `+2.18%` / `+10.88%` | `0.528` |
| **Cellpose-SAM** (`ig2_cpsam_fp16.onnx`, 617 MB) | Shipped TS v4.1 (`guard = 0.15`, v1.1.0) | `21.85%` `[13.74, 31.00]` | `6.50%` `[2.48, 17.90]` | `67.28%` / `30.0%` / `20.0%` | `-1.30%` / `-12.87%` | `0.562` |
| **Cellpose-SAM** (`ig2_cpsam_fp16.onnx`) | Shipped TS v4.1 (`guard = 1.00`, ablation) | `9.43%` `[4.91, 15.19]` | `2.63%` `[2.01, 4.74]` | `25.67%` / `10.0%` / `5.0%` | `+0.51%` / `+0.37%` | `0.571` |
| **Cellpose-SAM** (`IG2_full_set_cp_SAM`) | Upstream PyTorch (`cellpose>=4.0.9,<4.2`) | `14.32%` `[7.98, 21.82]` | `4.42%` `[2.42, 8.33]` | `41.84%` / `20.0%` / `10.0%` | `-1.11%` / `-7.68%` | `0.642` |

#### D16 and D84 Error vs Human GT

| Model | Engine / Guard | D16 mean / median [95% CI] | D16 P90 / >25% / >50% | D84 mean / median [95% CI] | D84 P90 / >25% / >50% |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **U-Net** | TS v4.1 (`guard = 0.15`) | `27.80%` / `17.44%` `[13.18, 31.78]` | `57.78%` / `42.5%` / `17.5%` | `25.41%` / `16.02%` `[2.43, 34.90]` | `72.47%` / `37.5%` / `15.0%` |
| **U-Net** | TS v4.1 (`guard = 1.00`) | `24.41%` / `14.18%` `[9.18, 28.57]` | `57.78%` / `37.5%` / `12.5%` | `18.71%` / `4.26%` `[1.40, 16.28]` | `48.65%` / `27.5%` / `7.5%` |
| **U-Net** | Upstream PyTorch | `43.57%` / `21.50%` `[14.53, 34.65]` | `81.50%` / `47.5%` / `25.0%` | `14.61%` / `3.32%` `[1.18, 9.47]` | `51.22%` / `20.0%` / `12.5%` |
| **Cellpose-SAM** | TS v4.1 (`guard = 0.15`) | `21.55%` / `11.14%` `[5.18, 30.25]` | `55.75%` / `37.5%` / `17.5%` | `20.78%` / `5.18%` `[2.03, 21.32]` | `64.89%` / `32.5%` / `15.0%` |
| **Cellpose-SAM** | TS v4.1 (`guard = 1.00`) | `15.17%` / `6.39%` `[4.23, 11.50]` | `48.47%` / `20.0%` / `10.0%` | `7.38%` / `1.82%` `[1.09, 3.88]` | `15.64%` / `10.0%` / `2.5%` |
| **Cellpose-SAM** | Upstream PyTorch | `15.80%` / `8.67%` `[5.22, 13.31]` | `42.35%` / `20.0%` / `7.5%` | `11.64%` / `2.01%` `[1.06, 6.60]` | `38.04%` / `20.0%` / `2.5%` |

> ⚠️ **Ablation Finding (`maxGrainAreaFraction = 0.15`):** The v1.1.0 `0.15` upper-area guard silently drops legitimate cobbles that occupy >15% of the image frame (`10/40` test images for CP-SAM, `6/40` for U-Net), doubling CP-SAM D50 error (`9.43%` → `21.85%` mean APE; `2.63%` → `6.50%` median APE) and creating a `-12.87%` mean fine bias. For imagery containing large cobbles relative to the frame, disabling or raising this guard (e.g., to `0.40` matching upstream Cellpose or `1.00`) is strongly recommended.

> ⚠️ **Important Scope Caveat:** `IG2_data.zip` contains `243` image/mask pairs (`40` `test`, `203` `train`) across `13` sites (`APF_2, AR, CT, DV_4, FH_2, HP, JF, NB2, NZ1, NZ2, PP, PR, S1_2`). **All 13 sites contributed `train/` images** to the IG2 models; there are **zero completely unseen sites** in `IG2_data.zip`. Therefore, the `n = 40` `test` split measures **within-site held-out performance**, not cross-site generalisation to unseen rivers.

---

## Limitations & Scientific Validity (Draft)

- **Unofficial port & custom post-processing:** `webGrainy` is an unofficial browser port of ImageGrains 2.0 and is not endorsed by its authors. Its flow-QC (`F5_MagWeightedQC` + `F3_SplitOnFailure` + `maxGrainAreaFraction = 0.15` in v1.1.0) differs from upstream Cellpose/ImageGrains `flow_error`.
- **Size metric definitions (`bAxis` vs `minFeret` vs `dEq`):** Reported `bAxis` values are the **minor axis of the moment-equivalent ellipse** of the visible 2D outline, not a sieve or caliper b-axis. On the `n = 40` held-out IG2 test set (`ts_v41_guard015`), median image D50 shifts by **`+3.09%`** (CP-SAM) / **`+4.04%`** (U-Net) for `minFeret` vs `bAxis`, and by **`+23.02%`** (CP-SAM) / **`+23.00%`** (U-Net) for `dEq` vs `bAxis` (on highly elongated clasts, `dEq` can exceed `minFeret` by ~`49%`). Partial burial, imbrication, and 2D projection of 3D clasts introduce additional physical bias.
- **No unseen-site or independent physical GT validation yet:** All IG2 benchmarks are in pixels against hand-digitised masks on the 13 IG2 sites. `dmair1989/imagegrains` `demo_data/K1_field_measurement.csv` (`field_n = 251`, caliper `D16/D50/D84 = 19.0 / 27.0 / 48.0 mm`) overlaps with `APF_2/train` and `APF_2/test`; on `K1_C2_385.jpg` + `K1_C3_0449.jpg` (`0.39 mm/px`), pooled photo `D50` (`bAxis 15.7 mm`, `minFeret 16.5–16.7 mm`, `dEq 18.7–19.0 mm`) is ~40% finer than manual field caliper `D50 = 27.0 mm`. **The gap is unexplained.** Finer surface pebbles, 2D overlap/burial, sampling/weighting differences and calibration are all candidate causes, but none has been tested.
- **Fine-tail truncation & lens distortion:** Fines below `30` working-resolution pixels are not detected (`D5–D16` are truncated unless validated). Uncorrected wide-angle/GoPro lens distortion introduces `-7.4%` to `-22.2%` center-bar D50 bias (`< 1%` for OEM-corrected smartphones); oblique photos must be rectified (4-point tool) and calibrated (2-point tool).
- **Degrading conditions:** Wet/shiny clasts, strong shadows, vegetation, sand matrix, single cobbles >15% of frame (under v1.1.0 `maxGrainAreaFraction = 0.15`), and samples with `< 100` interior grains.

**Always calibrate scale, inspect and edit masks, report `n` and the pinned model hash (included in every export), and validate against co-located field measurements (Wolman count or sieve) before using absolute values in publications.**
