# webGrainy (v1.1.0): Pre-Release Audit Follow-Up Report

- **Branch:** `claude/vibrant-brahmagupta-0y32mu` (v1.1.0)
- **Follow-up date:** 2026-11-15
- **Baseline:** `AUDIT_REPORT.md` (commit `494a3a0` + v1.1.0 remediation)
- **Environment:** Node, Playwright headless Chromium `153.0.8010.12` (no physical GPU / `/dev/dri`), Python 3.11.2 (without `scipy`).
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

**Remaining conditions before public release:**
1. Apply `audit/followup/THIRD_PARTY_NOTICES_PROPOSED.md` to `THIRD_PARTY_NOTICES.md` and `audit/followup/HF_MODEL_CARD_PROPOSED.md` to `inYourOwnBrowser/imagegrains-2.0-onnx` (correcting the erroneous `GPL-3.0` software license claim to `BSD 3-Clause` and adding Apache-2.0 / HHMI BSD-3 notices).
2. Run `audit/followup/verify_cpsam_webgpu.mjs` on a machine with a WebGPU `shader-f16` GPU (and consider adding `adapter.features.has('shader-f16')` + `device.lost` handling in `src/modules/onnxInference.ts`).
3. Complete the manual Safari/iOS PWA checklist (`audit/followup/offline_sw_results.json`).

### (b) Scientific Use: **CONDITIONAL-GO for exploratory, relative, or calibrated mask-inspected work; NO-GO for unvalidated publishable absolute grain sizes**
`webGrainy` v1.1.0 now provides:
- Selectable `minFeret` alongside `bAxis` (moment-ellipse minor axis) and `dEq` (equivalent circular diameter) end-to-end (`Workstream C`).
- Pinned model revision (`7773328a544ac050b7820667e68cbfb02a2e954a`) with SHA-256 verification and full export provenance.
- Single-photo and site-level ROI/exclusion filtering, sample-size warnings, and calibrated scale/homography tools.

**Remaining conditions before publishable absolute grain-size claims:**
1. Execute `audit/followup/imagegrains_heldout_followup_colab.ipynb` on Google Colab (GPU) and report `heldout_summary.json` to establish frozen v1.1.0 shipped-TS accuracy (with `maxGrainAreaFraction = 0.15` vs `1.00` ablation) on the `n = 40` within-site `test` split.
2. Validate against co-located physical ground truth (Wolman pebble count `n >= 100` clasts or bulk sieve) per `audit/followup/physical_gt_and_protocol.md` (and `AUDIT_REPORT.md` §7).

---

## 2. Workstream A — Held-Out Accuracy & Colab Notebook

### Findings & Confidence
- **True dataset split (`verified`):** Inspection of `IG2_data.zip` (Zenodo `17866827`) via HTTP Range requests (`audit/followup/build_manifest.py` → `audit/followup/heldout_manifest.csv`) shows **243 image/mask pairs** (`486` files: `40` `test`, `203` `train`) across **13 sites**. **All 13 sites contributed `train/` images**, so there are **zero completely unseen sites** in `IG2_data.zip`. The `n = 40` `official_split == 'test'` set measures **within-site held-out performance**, not cross-site generalisation.
- **Meaning of `split` and `site` in `full_dataset_validation_report.md` (`verified`):** `audit/recompute_validation.py` (`audit/out/validation_recompute.txt`) shows all `238` rows have `split = 'test'`, while `site` is `'train'` for `198` rows and `'test'` for `40` rows. Recomputed `site=test` (`n = 40`) numbers from the legacy Python-port benchmark (`eval_core.py`, without the `0.15` area guard):
  - **Cellpose-SAM (`site=test`, `n=40`):** v4 D50 MAPE vs GT = `12.51%` mean / `4.73%` median (`P90 = 38.5%`, `2/40 > 50%`, signed bias `-0.5%`, `PQ v4/GT = 0.535`); PyTorch ref vs GT = `14.27%` mean; v4 vs PyTorch = `28.27%` mean / `2.17%` median. (Across all `n=237`: `15.85%` mean / `3.72%` median.)
  - **U-Net (`site=test`, `n=40`):** v4 D50 MAPE vs GT = `31.32%` mean / `15.70%` median (`P90 = 86.9%`, `10/40 > 50%`, signed bias `-1.5%`, `PQ v4/GT = 0.448`); PyTorch ref vs GT = `27.02%` mean; v4 vs PyTorch = `18.48%` mean / `5.86%` median. (Across all `n=235`: `22.93%` mean / `10.67%` median.)
- **Shipped TS post-processing runner (`verified`):** `audit/followup/ts_postprocess_runner.mjs` bundles `src/modules/postprocessCore.ts` (`flowsToMasksBrowser`, `DEFAULT_POSTPROCESS_OPTIONS`) and `src/modules/morphometricsExt.ts` (`computeExtendedMorphometrics`) via `esbuild` so Colab runs the exact shipped TypeScript engine. `--selftest` verified `maxGrainAreaFraction = 0.15` (`2` grains) vs `1.00` (`3` grains).
- **Shipped-TS held-out benchmark & `0.15` ablation (`unverified` — pending Colab GPU run):** `audit/followup/imagegrains_heldout_followup_colab.ipynb` (6 cells, `nbformat=4`, zero pre-filled outputs, pinned `MODEL_REVISION = 7773328a544ac050b7820667e68cbfb02a2e954a` and SHA-256 hashes matching `src/modules/modelCache.ts`) could not be executed on this GPU-less VM.
- **Physical ground truth (`verified`):** `IG2_data.zip` contains zero sieve, Wolman, or caliper files (all GT masks are hand-digitised 2D pixel outlines). `dmair1989/imagegrains` `demo_data/K1_field_measurement.csv` (`n = 39` field b-axes, `13–225 mm` at `0.39 mm/px`) overlaps with `APF_2/train` (`8` rows) and `APF_2/test` (`1` row: `K1_2_C1_DJI_0385_clipped_4.jpg`), flagged as `is_k1_overlap=true` (`9` rows) in `heldout_manifest.csv`. Thus K1 is a metric-comparison sanity check, not an independent site validation.

### Evidence: `IG2_data.zip` Site Breakdown (`audit/followup/heldout_manifest.csv`)

| Site | `test` | `train` | Total |
| :--- | ---: | ---: | ---: |
| `APF_2` | 10 | 49 | 59 |
| `AR` | 3 | 13 | 16 |
| `CT` | 1 | 5 | 6 |
| `DV_4` | 3 | 16 | 19 |
| `FH_2` | 1 | 7 | 8 |
| `HP` | 1 | 6 | 7 |
| `JF` | 1 | 8 | 9 |
| `NB2` | 7 | 35 | 42 |
| `NZ1` | 2 | 18 | 20 |
| `NZ2` | 4 | 19 | 23 |
| `PP` | 1 | 7 | 8 |
| `PR` | 2 | 5 | 7 |
| `S1_2` | 4 | 15 | 19 |
| **Total** | **40** | **203** | **243** |

*(9 rows in `APF_2` have `is_k1_overlap=true`: 8 in `train`, 1 in `test`.)*

### Recommendation & Instructions to Run Colab Notebook
1. **Run `audit/followup/imagegrains_heldout_followup_colab.ipynb` in Google Colab:**
   - Upload or open `audit/followup/imagegrains_heldout_followup_colab.ipynb` in Google Colab and select a **GPU runtime** (T4 or better).
   - Ensure `audit/followup/heldout_manifest.csv` and `audit/followup/ts_postprocess_runner.mjs` (or the `webGrainy` repo clone) are accessible as configured in Cell 1.
   - Run all 6 cells sequentially. The notebook downloads `IG2_data.zip` (Zenodo `17866827`), the pinned ONNX weights from `7773328a544ac050b7820667e68cbfb02a2e954a` (verifying SHA-256), and upstream PyTorch weights from Zenodo `15728186`; runs both shipped TS v4.1 (`guard = 0.15` and `1.00` ablation) and upstream PyTorch on all `n = 40` `test` images; computes bootstrap 95% CIs, PQ, and `bAxis`/`minFeret`/`dEq` shifts; and checks `K1_C2_385.jpg` / `K1_C3_0449.jpg` against `K1_field_measurement.csv`.
   - Download the generated **`heldout_summary.json`** and share it back so `audit/followup/README_accuracy_draft.md` can be finalised into `README.md`.
2. **Adopt the §7 field validation protocol** (`audit/followup/physical_gt_and_protocol.md`) in the user guide and require co-located Wolman/sieve checks before publishing absolute grain sizes.

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
- **D50 shift across metrics (`verified` via `node audit/followup/metric_shift_check.mjs`):**
  - Per-shape (`1 px = 1 mm`): `circle_r30` (`minFeret=60.53`, `bAxis=59.93`, `dEq=59.93`), `ellipse_60x20` (`40.99`, `39.79`, `69.16`), `rect_80x20` (`20.00`, `23.07`, `45.14`), `rot_rect_45deg` (`21.21`, `23.67`, `45.68`), `L_shape_concave` (`79.30`, `68.00`, `70.24`).
  - 24-grain elongated gravel mixture (`physical-area`, `mm`): `minFeret D50 = 26.56 mm` (`D16=18.51, D84=30.49`), `bAxis D50 = 25.99 mm` (**`-2.14%`** vs `minFeret`), `dEq D50 = 39.53 mm` (**`+48.84%`** vs `minFeret`).
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
- **Recommendation:** Keep all v4.1 divergences; document `minSize=15` for fine close-up imagery.

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
| **P0** | Run held-out + ablation benchmark on Colab GPU | Execute `audit/followup/imagegrains_heldout_followup_colab.ipynb`, return `heldout_summary.json`, update `README.md` from `README_accuracy_draft.md` | Scientific use (publishable absolute sizes) |
| **P1** | Apply licensing fixes & notify upstream | Apply `THIRD_PARTY_NOTICES_PROPOSED.md` & `HF_MODEL_CARD_PROPOSED.md`; review `CC-BY-NC` note; email `david.mair@unibe.ch` (`licensing_review.md` §5) | Public release |
| **P1** | Verify CP-SAM WebGPU `shader-f16` & harden fallback | Run `node audit/followup/verify_cpsam_webgpu.mjs` on WebGPU `shader-f16` host; add `shader-f16` check + `device.lost` handler | CP-SAM browser sign-off |
| **P2** | Physical ground-truth campaign | Co-located Wolman count (`n >= 100`) or sieve per `audit/followup/physical_gt_and_protocol.md` (`>= 5` reaches for method validation) | Scientific use (absolute mm calibration) |
| **P2** | Safari/iOS manual PWA check | Run 4-item checklist in `audit/followup/offline_sw_results.json` (7-day ITP, memory, standalone, SW update) | Mobile/Safari sign-off |
| **P3** | Minor polish & `oracle.py` re-run | Re-run `python3 -I audit/oracle.py` with `scipy`; optionally wire `dashboardScope === 'photo'` (`src/ui/main.ts:913-915`) to `sizeMetric` | Nice-to-have |
