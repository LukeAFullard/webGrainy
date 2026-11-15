# Draft: Updated README Accuracy Table & Limitations Wording

> **Note:** Cells marked `[PENDING COLAB RUN]` will be populated once `audit/followup/imagegrains_heldout_followup_colab.ipynb` is executed in Google Colab and `heldout_summary.json` is returned. All other numbers are verified from `audit/recompute_validation.py` on `full_dataset_validation_report.md` and `audit/followup/heldout_manifest.csv`.

---

## Hosted ONNX Models & Benchmark Context (Draft)

Models are hosted at [`inYourOwnBrowser/imagegrains-2.0-onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx) (pinned revision `7773328a544ac050b7820667e68cbfb02a2e954a`).

### 1. Official Within-Site Test Split (`IG2_data.zip`, `official_split == 'test'`, `n = 40` across 13 sites)

Evaluated using the **actual shipped TypeScript engine** (`src/modules/postprocessCore.ts`, `maxGrainAreaFraction = 0.15`, frozen v1.1.0 defaults) and **upstream PyTorch ImageGrains** against **hand-digitised pixel masks** (not physical sieve/Wolman data):

| Model | Engine / Guard | D50 MAPE vs GT: mean / median [95% CI] | D50 P90 / >25% / >50% | D50 signed bias | PQ vs GT |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **U-Net** (`ig2_unet_fp32.onnx`, 26.5 MB) | Shipped TS v4.1 (`guard = 0.15`) | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` |
| **U-Net** (`ig2_unet_fp32.onnx`) | Shipped TS v4.1 (`guard = 1.00`, ablation) | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` |
| **U-Net** (`IG2_full_set.200525`) | Upstream PyTorch reference | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` |
| **Cellpose-SAM** (`ig2_cpsam_fp16.onnx`, 617 MB) | Shipped TS v4.1 (`guard = 0.15`) | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` |
| **Cellpose-SAM** (`ig2_cpsam_fp16.onnx`) | Shipped TS v4.1 (`guard = 1.00`, ablation) | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` |
| **Cellpose-SAM** (`IG2_full_set_cp_SAM`) | Upstream PyTorch reference | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` | `[PENDING COLAB RUN]` |

### 2. Legacy Python-Port Benchmark (`full_dataset_validation_report.md`, `eval_core.py`, no `0.15` guard)

For reference, the earlier `v4` Python-port benchmark (`audit/recompute_validation.py`) reported on `site = test` (`n = 40`, within-site test split) and `all` (`n = 235`/`237`, including `198` `train` images):

- **U-Net (`site = test`, `n = 40`):** D50 MAPE vs GT `31.32%` mean / `15.70%` median (`P90 = 86.9%`, `10/40 > 50%`, signed bias `-1.5%`, `PQ = 0.448`; PyTorch ref `27.02%` mean).
- **Cellpose-SAM (`site = test`, `n = 40`):** D50 MAPE vs GT `12.51%` mean / `4.73%` median (`P90 = 38.5%`, `2/40 > 50%`, signed bias `-0.5%`, `PQ = 0.535`; PyTorch ref `14.27%` mean).

> ⚠️ **Important Scope Caveat:** `IG2_data.zip` contains `243` image/mask pairs (`40` `test`, `203` `train`) across `13` sites (`APF_2, AR, CT, DV_4, FH_2, HP, JF, NB2, NZ1, NZ2, PP, PR, S1_2`). **All 13 sites contributed `train/` images** to the IG2 models; there are **zero completely unseen sites** in `IG2_data.zip`. Therefore, the `n = 40` `test` split measures **within-site held-out performance**, not cross-site generalisation to unseen rivers.

---

## Limitations & Scientific Validity (Draft)

- **Unofficial port & custom post-processing:** `webGrainy` is an unofficial browser port of ImageGrains 2.0 and is not endorsed by its authors. Its flow-QC (`F5_MagWeightedQC` + `F3_SplitOnFailure` + `maxGrainAreaFraction = 0.15`) differs from upstream Cellpose/ImageGrains `flow_error`.
- **Size metric definitions (`bAxis` vs `minFeret` vs `dEq`):** Reported `bAxis` values are the **minor axis of the moment-equivalent ellipse** of the visible 2D outline, not a sieve or caliper b-axis. `minFeret` provides the 2D minimum caliper width (`[PENDING COLAB RUN]` median D50 shift vs `bAxis`). Partial burial, imbrication, and 2D projection of 3D clasts introduce additional physical bias.
- **No unseen-site or independent physical GT validation yet:** All IG2 benchmarks are in pixels against hand-digitised masks on the 13 IG2 sites. `K1_field_measurement.csv` (`n = 39` field b-axes) overlaps with `APF_2/train` and `APF_2/test` and is not an independent site validation.
- **Fine-tail truncation & lens distortion:** Fines below `30` working-resolution pixels are not detected (`D5–D16` are truncated unless validated). Lens distortion is not modelled. Oblique photos must be rectified (4-point tool) and calibrated (2-point tool).
- **Degrading conditions:** Wet/shiny clasts, strong shadows, vegetation, sand matrix, very large clasts relative to frame, and samples with `< 100` interior grains.

**Always calibrate scale, inspect and edit masks, report `n` and the pinned model hash (included in every export), and validate against co-located field measurements (Wolman count or sieve) before using absolute values in publications.**
