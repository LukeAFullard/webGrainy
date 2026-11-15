# webGrainy (v1.1.0): Pre-Release Audit Follow-Up Report

- **Branch:** `audit/followup-v1.1.0` (from `claude/vibrant-brahmagupta-0y32mu`, v1.1.0)
- **Follow-up date:** 2026-11-15
- **Baseline:** `AUDIT_REPORT.md` (commit `494a3a0` + v1.1.0 remediation)
- **Environments:**
  - **Local VM:** Node.js, Playwright headless Chromium `153.0.8010.12` (no physical GPU / `/dev/dri`), Python 3.11.2 (without `scipy`).
  - **Google Colab GPU Run (Workstream A):** `audit/followup/imagegrains_heldout_followup_colab.ipynb` executed on `IG2_data.zip` (`official_split == 'test'`, `n = 40` across all 13 sites), producing `audit/followup/heldout_summary.json` and `audit/followup/heldout_results_per_image.csv`.
- **Artifacts:** All new follow-up scripts, manifests, drafts, and results are under `audit/followup/`. Code changes were restricted exclusively to Workstream C (`minFeret`).

---

## 1. Updated Verdict

### (a) Public Release: **CONDITIONAL-GO**
All v1.1.0 code-level blockers from `AUDIT_REPORT.md` (F-01 through F-24) are resolved and independently verified:
- `npm run typecheck` passes (exit `0`).
- `npm test` passes (`17` files, `280/280` tests).
- `npm run build` succeeds (`dist/sw.js` stamped, `ORT 1.31.1`).
- `npm run test:e2e:browser` passes (`SMOKE PASS (n = 19 grains)`).
- `bash audit/mutation_check.sh` kills `9/9` mutants.
- `node audit/followup/verify_offline_sw.mjs` passes cold install, offline reload + U-Net inference (`19` grains, SHA-256 provenance), and service-worker update prompt in headless Chromium.
- `onnxruntime-web` WASM vs Python ONNX Runtime U-Net parity verified across 3 test images (`max_abs_diff <= 0.0202`, `audit/followup/heldout_summary.json`).

**Remaining conditions before public release:**
1. **Fix or relax `maxGrainAreaFraction = 0.15` (`P0` scientific regression found in Workstream A ablation):** On the `n = 40` held-out test set, the v1.1.0 `0.15` guard deletes legitimate large cobbles on `10/40` images in Cellpose-SAM and `6/40` in U-Net, more than doubling CP-SAM D50 error (`9.43%` → `21.85%` mean APE; `2.63%` → `6.50%` median APE) and introducing `-12.87%` mean fine bias (`audit/followup/heldout_summary.json`). Raising this to `0.40` (matching upstream Cellpose `max_size_fraction=0.4`) or exposing/disabling it is strongly recommended before tagging a release.
2. Apply `audit/followup/THIRD_PARTY_NOTICES_PROPOSED.md` to `THIRD_PARTY_NOTICES.md` and `audit/followup/HF_MODEL_CARD_PROPOSED.md` to `inYourOwnBrowser/imagegrains-2.0-onnx` (correcting the erroneous `GPL-3.0` software license claim to `BSD 3-Clause` and adding Apache-2.0 / HHMI BSD-3 notices).
3. Run `audit/followup/verify_cpsam_webgpu.mjs` on a machine with a WebGPU `shader-f16` GPU (and consider adding `adapter.features.has('shader-f16')` + `device.lost` handling in `src/modules/onnxInference.ts`).
4. Complete the manual Safari/iOS PWA checklist (`audit/followup/offline_sw_results.json`).

### (b) Scientific Use: **CONDITIONAL-GO for exploratory, relative, or calibrated mask-inspected work (strongly preferring `maxGrainAreaFraction >= 0.40` / disabled on cobble-rich frames); NO-GO for unvalidated publishable absolute grain sizes**
`webGrainy` v1.1.0 now provides:
- Verified within-site held-out benchmark (`n = 40`, shipped TS engine + PyTorch reference + `0.15` guard ablation). With the `0.15` guard disabled (`guard = 1.00`), Cellpose-SAM achieves **`2.63%` median D50 APE** (`95% CI [2.01, 4.74]`) and **`9.43%` mean D50 APE** (`95% CI [4.91, 15.19]`) vs hand-digitised masks (`PQ = 0.571`)—outperforming upstream PyTorch on D50 (`14.32%` mean / `4.42%` median). Under the shipped `0.15` guard (`guard = 0.15`), however, CP-SAM degrades to **`21.85%` mean / `6.50%` median D50 APE** (`P90 = 67.28%`, `20.0% > 50%`).
- Selectable `minFeret` alongside `bAxis` (moment-ellipse minor axis) and `dEq` (equivalent circular diameter) end-to-end (`Workstream C`).
- Pinned model revision (`7773328a544ac050b7820667e68cbfb02a2e954a`) with SHA-256 verification and full export provenance.
- Single-photo and site-level ROI/exclusion filtering, sample-size warnings, and calibrated scale/homography tools.

**Remaining conditions before publishable absolute grain-size claims:**
1. Validate against co-located physical ground truth (Wolman pebble count `n >= 100` clasts or bulk sieve) per `audit/followup/physical_gt_and_protocol.md` (and `AUDIT_REPORT.md` §7), and note that `IG2_data.zip` contains zero completely unseen sites.
2. Address `maxGrainAreaFraction = 0.15` truncation on scenes with cobbles >15% of frame (either by code update or user mask review).

---

## 2. Workstream A — Held-Out Accuracy & Ablation (`verified`)

### Findings & Confidence
- **True dataset split (`verified`):** Inspection of `IG2_data.zip` (Zenodo `17866827`) via HTTP Range requests (`audit/followup/build_manifest.py` → `audit/followup/heldout_manifest.csv`) shows **243 image/mask pairs** (`486` files: `40` `test`, `203` `train`) across **13 sites**. **All 13 sites contributed `train/` images**, so there are **zero completely unseen sites** in `IG2_data.zip`. The `n = 40` `official_split == 'test'` set measures **within-site held-out performance**, not cross-site generalisation.
- **Meaning of `split` and `site` in `full_dataset_validation_report.md` (`verified`):** In the legacy Colab validation notebook, `IG2_data.zip` was extracted under `/content/test_images/`, so `'test' in path.lower()` matched every file (`split = 'test'` for all `238` rows), while `site` recorded whether the parent folder was `/train/` (`198` rows) or `/test/` (`40` rows).
- **Shipped TS engine held-out accuracy & `0.15` ablation (`verified` via Google Colab GPU execution of `audit/followup/imagegrains_heldout_followup_colab.ipynb` → `audit/followup/heldout_summary.json` & `audit/followup/heldout_results_per_image.csv`):**
  - Executed the **actual bundled TypeScript engine** (`src/modules/postprocessCore.ts` + `src/modules/morphometricsExt.ts` via `audit/followup/ts_postprocess_runner.mjs`, frozen v1.1.0 defaults) and **upstream PyTorch Cellpose/ImageGrains** (`venv_cp3` `cellpose==3.1.1.1` for `IG2_full_set.200525`, `venv_cp4` `cellpose>=4.0.9,<4.2` for `IG2_full_set_cp_SAM`) on all `n = 40` `official_split == 'test'` images.
  - **`onnxruntime-web` WASM parity (`verified`):** On 3 held-out test images (`APF_2__test__DS8-S2_3`, `APF_2__test__GU_bar7_0`, `APF_2__test__K1_2_C1_DJI_0385_clipped_4`), Node `onnxruntime-web` WASM U-Net raw tensor output matched Python `onnxruntime` within `max_abs_diff = 0.0202`, `0.0087`, and `0.0194`.
  - **Ablation impact of `maxGrainAreaFraction = 0.15` (`verified`):** Comparing `ts_v41_guard015` (`0.15`) vs `ts_v41_guard100` (`1.00`, guard off) shows the `0.15` guard dropped legitimate large cobbles (>15% of frame area) on **`10/40` CP-SAM images** and **`6/40` U-Net images** (`audit/followup/heldout_results_per_image.csv`). In CP-SAM, `9/10` affected images suffered severe D50 underprediction (e.g., `NB2__test__P5251741_Crop2`: GT `265.3 px` → `36.6 px` (`86.2%` APE) with `0.15` vs `273.7 px` (`3.2%` APE) with `1.00`; `APF_2__test__kanakacreek_020_4`: GT `186.3 px` → `41.2 px` (`77.9%` APE) vs `186.3 px` (`0.0%` APE)). Only `1` image (`AR__test__DSC_0577_1` under U-Net) improved (`54.7%` → `3.4%`).
- **Physical ground truth (`verified`):** `IG2_data.zip` contains zero sieve, Wolman, or caliper files (all GT masks are hand-digitised 2D pixel outlines). `dmair1989/imagegrains` `demo_data/K1_field_measurement.csv` (`field_n = 251`, caliper `D16/D50/D84 = 19.0 / 27.0 / 48.0 mm`) overlaps with `APF_2/train` (`8` rows) and `APF_2/test` (`1` row: `K1_2_C1_DJI_0385_clipped_4.jpg`). On `K1_C2_385.jpg` + `K1_C3_0449.jpg` (`0.39 mm/px`), pooled shipped-TS `D50` (`bAxis 15.67–15.70 mm`, `minFeret 16.51–16.71 mm`, `dEq 18.69–18.99 mm`) is ~`38–42%` finer than field caliper `D50 = 27.0 mm`, reflecting fine surface pebbles (<15 mm) omitted/truncated in manual counts and 2D burial/imbrication projection (`audit/followup/physical_gt_and_protocol.md`).

### Held-Out Results Table (`official_split == 'test'`, `n = 40` across 13 sites)

#### D50 & Panoptic Quality (PQ)

| Model | Engine / Guard | D50 Mean APE [95% CI] | D50 Median APE [95% CI] | D50 P90 | >25% / >50% | Signed Bias (Med / Mean) | PQ vs GT | PQ vs PT |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **U-Net** | Shipped TS v4.1 (`guard = 0.15`) | `31.02%` `[19.76, 45.54]` | `15.31%` `[9.17, 26.25]` | `83.31%` | `35.0%` / `20.0%` | `-8.93%` / `-10.10%` | `0.480` | `0.576` |
| **U-Net** | Shipped TS v4.1 (`guard = 1.00`) | `27.48%` `[16.93, 42.12]` | `14.84%` `[7.35, 23.02]` | `83.31%` | `30.0%` / `17.5%` | `-2.38%` / `-3.74%` | `0.485` | `0.582` |
| **U-Net** | Upstream PyTorch (`cp3`) | `27.47%` `[14.83, 46.34]` | `9.26%` `[6.33, 17.04]` | `78.51%` | `27.5%` / `15.0%` | `+2.18%` / `+10.88%` | `0.528` | `1.000` |
| **CP-SAM** | Shipped TS v4.1 (`guard = 0.15`) | `21.85%` `[13.74, 31.00]` | `6.50%` `[2.48, 17.90]` | `67.28%` | `30.0%` / `20.0%` | `-1.30%` / `-12.87%` | `0.562` | `0.773` |
| **CP-SAM** | Shipped TS v4.1 (`guard = 1.00`) | `9.43%` `[4.91, 15.19]` | `2.63%` `[2.01, 4.74]` | `25.67%` | `10.0%` / `5.0%` | `+0.51%` / `+0.37%` | `0.571` | `0.777` |
| **CP-SAM** | Upstream PyTorch (`cp4`) | `14.32%` `[7.98, 21.82]` | `4.42%` `[2.42, 8.33]` | `41.84%` | `20.0%` / `10.0%` | `-1.11%` / `-7.68%` | `0.642` | `1.000` |

#### D16 and D84 Error vs Human GT

| Model | Engine / Guard | D16 Mean [95% CI] | D16 Med [95% CI] | D16 P90 / >25% / >50% | D16 Bias (Med/Mean) | D84 Mean [95% CI] | D84 Med [95% CI] | D84 P90 / >25% / >50% | D84 Bias (Med/Mean) |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **U-Net** | TS v4.1 (`0.15`) | `27.80%` `[20.81, 35.65]` | `17.44%` `[13.18, 31.78]` | `57.78%` / `42.5%` / `17.5%` | `-9.87%` / `-6.24%` | `25.41%` `[17.03, 34.74]` | `16.02%` `[2.43, 34.90]` | `72.47%` / `37.5%` / `15.0%` | `-2.43%` / `-21.38%` |
| **U-Net** | TS v4.1 (`1.00`) | `24.41%` `[17.45, 32.18]` | `14.18%` `[9.18, 28.57]` | `57.78%` / `37.5%` / `12.5%` | `+1.36%` / `-0.21%` | `18.71%` `[11.47, 27.00]` | `4.26%` `[1.40, 16.28]` | `48.65%` / `27.5%` / `7.5%` | `-1.02%` / `-14.66%` |
| **U-Net** | PyTorch (`cp3`) | `43.57%` `[25.62, 71.51]` | `21.50%` `[14.53, 34.65]` | `81.50%` / `47.5%` / `25.0%` | `+18.75%` / `+33.08%` | `14.61%` `[8.40, 21.85]` | `3.32%` `[1.18, 9.47]` | `51.22%` / `20.0%` / `12.5%` | `-0.10%` / `-5.60%` |
| **CP-SAM** | TS v4.1 (`0.15`) | `21.55%` `[15.03, 28.59]` | `11.14%` `[5.18, 30.25]` | `55.75%` / `37.5%` / `17.5%` | `+2.30%` / `-3.67%` | `20.78%` `[13.11, 29.74]` | `5.18%` `[2.03, 21.32]` | `64.89%` / `32.5%` / `15.0%` | `-1.26%` / `-13.32%` |
| **CP-SAM** | TS v4.1 (`1.00`) | `15.17%` `[9.44, 21.77]` | `6.39%` `[4.23, 11.50]` | `48.47%` / `20.0%` / `10.0%` | `+3.94%` / `+8.31%` | `7.38%` `[3.70, 12.30]` | `1.82%` `[1.09, 3.88]` | `15.64%` / `10.0%` / `2.5%` | `-0.14%` / `+0.45%` |
| **CP-SAM** | PyTorch (`cp4`) | `15.80%` `[10.52, 21.59]` | `8.67%` `[5.22, 13.31]` | `42.35%` / `20.0%` / `7.5%` | `+1.43%` / `+0.60%` | `11.64%` `[6.26, 17.75]` | `2.01%` `[1.06, 6.60]` | `38.04%` / `20.0%` / `2.5%` | `-0.77%` / `-8.76%` |

*(Note: `test_40` includes 1 row `APF_2__test__K1_2_C1_DJI_0385_clipped_4` with `is_k1_overlap=true`, where CP-SAM D50 APE was `0.33%` (`PQ = 0.663`) and U-Net D50 APE was `9.70%` (`PQ = 0.474`). Full site manifest in `audit/followup/heldout_manifest.csv`.)*

### Recommendation
1. **Change or make configurable `maxGrainAreaFraction` (`P0`):** Raise the default from `0.15` (at minimum to `0.40` matching upstream Cellpose, or expose it in Advanced Options / remove it) so large cobbles are not silently dropped.
2. **Update `README.md`** using the verified draft in `audit/followup/README_accuracy_draft.md`.
3. **Adopt the §7 field validation protocol** (`audit/followup/physical_gt_and_protocol.md`) in the user guide and require co-located Wolman/sieve checks before publishing absolute grain sizes.

---

## 3. Workstream B — Licensing of Converted Weights

### Findings & Confidence (`verified` via direct HTTP fetches; technical analysis, not legal advice)
- **Zenodo `10.5281/zenodo.15728186`:** Licensed under **CC BY 4.0** (`{"id": "cc-by-4.0"}`), 15 creators led by `Mair, David`, containing `IG2_full_set.200525` and `IG2_full_set_cp_SAM`.
- **`dmair1989/imagegrains`:** Licensed under **BSD 3-Clause** (`LICENSE.md`, `Copyright (c) 2023, David Mair`) — *not* GPL-3.0.
- **`MouseLand/cellpose` & `mouseland/cellpose-sam`:** Licensed under **BSD 3-Clause** (`Copyright © 2020–2025 Howard Hughes Medical Institute`), with `MouseLand/cellpose/README.md:37` noting that Cellpose's own training dataset is **CC-BY-NC**.
- **`facebookresearch/segment-anything`:** Licensed under **Apache License 2.0** (`Copyright (c) Meta Platforms, Inc. and affiliates.`), with **no `NOTICE` file** in the repository root (Apache-2.0 §4(d) is N/A).
- **Compatibility verdict:** Redistributing `ig2_unet_fp32.onnx` and `ig2_cpsam_fp16.onnx` on Hugging Face (`inYourOwnBrowser/imagegrains-2.0-onnx` at `7773328a544ac050b7820667e68cbfb02a2e954a`) under **CC BY 4.0** is **permitted and compatible**, provided Apache-2.0 §4(a)–(c), BSD-3 §1–§3, and CC BY 4.0 §3(a) attribution/change notices are satisfied.
- **Current documentation gaps:**
  - HF `README.md` at `7773328a` erroneously states `GNU General Public License v3.0 (GPL-3.0)` with a 404 link, omits Meta Apache-2.0 license text/copyright and Statement of Changes, omits HHMI BSD-3 notice, states `≈ 588 MB` instead of `588.8 MiB (617.4 MB)`, and omits 2026/2025/2023 citations and 11 of 15 Zenodo creators.
  - Local `THIRD_PARTY_NOTICES.md` retains the stale F-24 "could not reach upstream" placeholder and omits full Apache-2.0 text and per-model Statement of Changes.

### Evidence
- `audit/followup/licensing_review.md` (§1–§6 with verbatim headers and verification `curl` commands)
- `audit/followup/THIRD_PARTY_NOTICES_PROPOSED.md`
- `audit/followup/HF_MODEL_CARD_PROPOSED.md`

### Recommendation
1. Replace `THIRD_PARTY_NOTICES.md` with `audit/followup/THIRD_PARTY_NOTICES_PROPOSED.md`.
2. Update `inYourOwnBrowser/imagegrains-2.0-onnx/README.md` with `audit/followup/HF_MODEL_CARD_PROPOSED.md` (note: pushing to HF creates a new commit SHA; update `MODEL_REVISION` in `src/modules/modelCache.ts` only if pointing to the new commit).
3. **Human decisions required:** review the Cellpose `CC-BY-NC` training-data note if commercial use is contemplated, confirm HF repo ownership/PR workflow, decide on optional legal counsel review, and send the draft courtesy email (`audit/followup/licensing_review.md` §5) to `david.mair@unibe.ch`.

---

## 4. Workstream C — `minFeret` as a Selectable Size Metric

### Findings & Confidence (`verified`, except `oracle.py` re-run `unverified`)
- **End-to-end implementation (`verified`):** Added `SizeMetric = 'bAxis' | 'dEq' | 'minFeret'` (`src/types/index.ts`) and wired `'minFeret'` through `ScaleCalibrator.scaleMorphometrics` (`src/modules/interactiveEditor.ts`), `rescaleGrainToOriginal` & `AnalysisSession.ensureFeret()` (`src/modules/pipelineController.ts`), `computeSedimentStats` & `computeWentworthProportions` & exports (`src/modules/sedimentStats.ts`), `analyzeSite` / `getGrainSize` / `getGrainMmSize` / truncation cutoffs / CIs / Wentworth (`src/modules/siteAnalysis.ts`), `SIZE_METRIC_DEFINITION` (`src/modules/provenance.ts`), `renderPrintablePsdSvg` (`src/ui/charts.ts`), and the UI `<select data-site-opt="sizeMetric">` + grain inspector (`src/ui/main.ts`).
- **Hull-corner optimization & cache invalidation (`verified`):** `computeExtendedMorphometrics` (`src/modules/morphometricsExt.ts`) builds pixel-edge corners from `hull` vertices instead of all `boundaryPoints` (mathematically identical by Minkowski sum convexity; verified `0` mismatches across `66` shapes by Challenger) and caches working-coordinate geometry in `GrainHullCache` (`Map<number, CachedGrainGeometry>`). `AnalysisSession` invalidates affected IDs on `splitGrainAtLine`, `mergeGrains`, `deleteGrain`, `addPolygonGrain`, and clears on `undo`/`redo`.
- **Minor UI note (`verified`):** In `src/ui/main.ts:913-915`, `dashboardScope === 'photo'` ("This Photo" scope) still reads `single?.areaWeightedB` (`bAxis`), while site-level scope (`dashboardScope === 'site'`), exports, and grain inspector reflect `sizeMetric`.
- **D50 shift across metrics (`verified`):**
  - **Real IG2 held-out test set (`n = 40`, `ts_v41_guard015`, `audit/followup/heldout_summary.json`):**
    - **CP-SAM (`n = 40`):** `minFeret` vs `bAxis` median D50 shift = **`+3.09%`**; `dEq` vs `bAxis` = **`+23.02%`**; `minFeret` vs `dEq` = **`-15.34%`**.
    - **U-Net (`n = 40`):** `minFeret` vs `bAxis` median D50 shift = **`+4.04%`**; `dEq` vs `bAxis` = **`+23.00%`**; `minFeret` vs `dEq` = **`-15.21%`**.
  - **K1 field frames (`K1_C2_385.jpg` + `K1_C3_0449.jpg`, `0.39 mm/px`):** CP-SAM D50 = `15.70 mm` (`bAxis`), `16.71 mm` (`minFeret`, `+6.5%` vs `bAxis`), `18.99 mm` (`dEq`, `+21.0%` vs `bAxis`).
  - **Synthetic 24-grain elongated mixture (`node audit/followup/metric_shift_check.mjs`):** `minFeret D50 = 26.56 mm`, `bAxis D50 = 25.99 mm` (`-2.14%` vs `minFeret`), `dEq D50 = 39.53 mm` (`+48.84%` vs `minFeret`).
- **Verification outputs (`verified`):**
  - `npm run typecheck`: exit `0`.
  - `npm test`: `Test Files 17 passed (17)`, `Tests 280 passed (280)`.
  - `npm run build`: exit `0` (`dist/sw.js` stamped).
  - `npm run test:e2e:browser`: `SMOKE PASS (n = 19 grains)`.
  - `bash audit/mutation_check.sh`: **9/9 mutants KILLED**.
- **`oracle.py` caveat (`unverified`):** System `python3` lacks `scipy`, so `python3 -I audit/oracle.py` could not be re-executed; however, `computeFeretDiameters` itself was not modified and matches exact analytical rotating-calipers geometry (`rect_80x20 = 20.00`, `rot_rect_45deg = 21.21`).

### Recommendation
Keep the Workstream C implementation. Optionally wire `dashboardScope === 'photo'` in `src/ui/main.ts:913-915` to respect `sizeMetric`, and re-run `python3 -I audit/oracle.py` in a Python environment with `scipy`.

---

## 5. Workstream D — Previously Unverified Items

### D.1 CP-SAM in a Real Browser (`ig2_cpsam_fp16.onnx`, 617 MB)
- **Confidence:** `unverified` (live WebGPU `shader-f16` execution, peak memory, `13–16 s/image` timing, `device.lost` runtime behavior, Python ORT parity); `verified` (code-level gaps).
- **Findings & Evidence:** VM has no GPU (`/dev/dri`, `nvidia-smi`, `vulkaninfo`, `lspci` absent). Code inspection (`audit/followup/cpsam_browser_findings.md`) identified: (1) `hasWebGpuAdapter()` (`src/modules/onnxInference.ts:299-309`) does not check `adapter.features.has('shader-f16')`; (2) no `device.lost` listener/recovery (`onnxInference.ts:281-295, 391-574`); (3) no `shader-f16` capability diagnostic in `pipelineController.ts:1418-1430`.
- **Recommendation:** Run `node audit/followup/verify_cpsam_webgpu.mjs` on a WebGPU `shader-f16` host; add `adapter.features.has('shader-f16')` and `device.lost` handling in a follow-up PR.

### D.2 Upstream Parity (`dmair1989/imagegrains`)
- **Confidence:** `verified` (inspected `segmentation_helper.py`, `grainsizing.py`, `gsd_uncertainty.py` vs `postprocessCore.ts` and `morphometricsExt.ts` in `audit/followup/upstream_parity_matrix.md`).
- **Findings:** Exact mathematical parity on moment-ellipse `a`/`b` axes (`skimage.measure.regionprops`), orientation, `dEq`, Crofton perimeter, solidity, and Eaton (2019) binomial + 1000-iter bootstrap CIs. Deliberate Browser Engine v4.1 divergences: `niter=250` coarse+fine (vs Cellpose `200`), `F5_MagWeightedQC` + `flowThreshold=0.45` (vs `0.4`), `minSize=30` (vs `15`), `maxGrainAreaFraction=0.15` (vs `0.4`), `F3_SplitOnFailure` dumbbell splitting, and `minFeretPx` rotating calipers (vs `iterate_b` perpendicular chord).
- **Recommendation:** Keep all v4.1 divergences **except `maxGrainAreaFraction = 0.15`** (which Workstream A ablation showed degrades CP-SAM D50 error from `9.43%` to `21.85%`); raise to `0.40` (matching upstream Cellpose) or make optional, and document `minSize=15` for fine close-up imagery.

### D.3 Lens Distortion
- **Confidence:** `verified` (Brown-Conrady `(k1, k2, p1, p2)` Jacobian area-scale model in `audit/followup/lens_distortion_model.py` → `audit/followup/lens_distortion_results.json`).
- **Findings (center scale bar):**
  - `smartphone_oem_corrected`: `-0.71%` mean D50 bias (`1.74%` max).
  - `dji_mavic_phantom_pro`: `-3.32%` mean (`8.51%` max).
  - `smartphone_uncorrected_wide`: `-7.35%` mean (`18.57%` max).
  - `dji_phantom3_wide_uncorrected`: `-11.77%` mean (`22.58%` max).
  - `action_cam_gopro_wide`: `-22.21%` mean (`33.03%` max).
- **Recommendation:** **Documentation-only** for standard OEM-corrected smartphones and moderate DJI drones (`< 1–4%` mean bias); warn users against uncorrected wide-FOV / GoPro feeds (`> 10–33%` error) and recommend pre-undistorting wide-angle imagery before upload.

### D.4 Offline-First PWA / Service Worker
- **Confidence:** `verified` in headless Chromium `153.0.8010.12` (`audit/followup/verify_offline_sw.mjs` → `audit/followup/offline_sw_results.json`); `unverified` on physical Safari/iOS.
- **Findings:** Cold install activated SW (`webgrainy-shell-<hash>`, `webgrainy-ort-1.31.1`) and completed U-Net inference (`19` grains). Offline reload (`onLine: false`, `hasController: true`) completed U-Net inference (`19` grains) with pinned SHA-256 provenance. Build-to-build update (`oldBuildHash` → `newBuildHash`) triggered `controllerChanged: true` and the reload prompt.
- **Recommendation:** Execute the 4-item Safari/iOS manual checklist in `audit/followup/offline_sw_results.json` on physical Apple hardware.

---

## 6. Prioritised Open Items

| Priority | Item | Action / File | Blocks |
| :--- | :--- | :--- | :--- |
| **P0** | Raise or disable `maxGrainAreaFraction = 0.15` | Ablation (`audit/followup/heldout_summary.json`) proved `0.15` deletes real cobbles on `10/40` CP-SAM test images (`D50` mean APE `9.43%` → `21.85%`); raise to `0.40` (upstream Cellpose) or make optional, and apply `audit/followup/README_accuracy_draft.md` to `README.md` | Scientific accuracy & release |
| **P1** | Apply licensing fixes & notify upstream | Apply `THIRD_PARTY_NOTICES_PROPOSED.md` & `HF_MODEL_CARD_PROPOSED.md`; review `CC-BY-NC` note; email `david.mair@unibe.ch` (`licensing_review.md` §5) | Public release |
| **P1** | Verify CP-SAM WebGPU `shader-f16` & harden fallback | Run `node audit/followup/verify_cpsam_webgpu.mjs` on WebGPU `shader-f16` host; add `shader-f16` check + `device.lost` handler | CP-SAM browser sign-off |
| **P2** | Physical ground-truth campaign | Co-located Wolman count (`n >= 100`) or sieve per `audit/followup/physical_gt_and_protocol.md` (`>= 5` reaches for method validation) | Scientific use (absolute mm calibration) |
| **P2** | Safari/iOS manual PWA check | Run 4-item checklist in `audit/followup/offline_sw_results.json` (7-day ITP, memory, standalone, SW update) | Mobile/Safari sign-off |
| **P3** | Minor polish & `oracle.py` re-run | Re-run `python3 -I audit/oracle.py` with `scipy`; optionally wire `dashboardScope === 'photo'` (`src/ui/main.ts:913-915`) to `sizeMetric` | Nice-to-have |
