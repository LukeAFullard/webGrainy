# Physical Ground Truth Findings & Field Validation Protocol

## 1. Findings from `IG2_data.zip` and `dmair1989/imagegrains`

1. **`IG2_data.zip` (Zenodo `17866827`) contains zero physical ground-truth files.**
   - Central-directory inspection of `IG2_data.zip` (`525` zip entries, `486` files = `243` image/mask pairs across `13` sites: `40` `test`, `203` `train`) confirms **no** sieve, Wolman, or caliper CSVs are included.
   - All `IG2_data.zip` ground-truth masks are **hand-digitised 2D outlines in pixels**, not physical sieve or caliper measurements.
   - Furthermore, all 13 sites (`APF_2, AR, CT, DV_4, FH_2, HP, JF, NB2, NZ1, NZ2, PP, PR, S1_2`) contributed `train/` images to the IG2 models (`IG2_full_set.200525` and `IG2_full_set_cp_SAM`), so **zero completely unseen sites** exist inside `IG2_data.zip`. True cross-site generalisation requires either external unseen-site datasets or leave-one-site-out cross-validation.

2. **`dmair1989/imagegrains` `demo_data/K1_field_measurement.csv` (`field_n = 251` field b-axes):**
   - `demo_data/K1_field_measurement.csv` contains `251` manual field b-axis measurements (`field_D16 = 19.0 mm`, `field_D50 = 27.0 mm`, `field_D84 = 48.0 mm`) paired with `demo_data/K1/K1_C2_385.jpg` and `demo_data/K1/K1_C3_0449.jpg` at `0.39 mm/px` (per `notebooks/Complete_grain_size_and_shape_analysis_colab.ipynb` cell 21).
   - **Measured photo vs field comparison (`audit/followup/heldout_summary.json`):** Pooling `K1_C2_385.jpg` + `K1_C3_0449.jpg` through the shipped TS v4.1 engine (`guard = 0.15`, `0.39 mm/px`):
     - **U-Net (`n = 3,579` interior grains):** `bAxis` D16/D50/D84 = `6.56 / 15.67 / 38.18 mm`; `minFeret` = `7.02 / 16.51 / 41.48 mm`; `dEq` = `8.10 / 18.69 / 46.90 mm`.
     - **Cellpose-SAM (`n = 3,700` interior grains):** `bAxis` D16/D50/D84 = `6.57 / 15.70 / 37.63 mm`; `minFeret` = `7.09 / 16.71 / 39.36 mm`; `dEq` = `8.03 / 18.99 / 47.43 mm`.
     - On these frames, pooled photo `D50` underpredicts manual field caliper `D50` (`27.0 mm`) by `-41.9%` (`bAxis`) and `-38.1%` (`minFeret`), whereas `dEq` D84 (`46.9–47.4 mm`) is close to field D84 (`48.0 mm`). **The cause is unexplained.** Hypotheses, none of them tested yet:
       (a) the photo detects fines below ~15 mm that hand counts skip;
       (b) 2D burial/imbrication shortens visible b-axes;
       (c) area-weighted photo vs grid-by-number field weighting;
       (d) calibration error.
       Each can be tested: compare at matched truncation (drop grains below the field-count minimum), compare D84 only, and re-check `mm/px`.
   - **Critical overlap caveat:** Crops from those exact K1 photographs (`K1_2_C1_DJI_0385_1.jpg`, `K1_2_C1_DJI_0385_clipped_0..6`, `K1_2_C1_DJI_0449_1.jpg`) appear in `IG2_data.zip` under **`APF_2/train` (8 pairs) and `APF_2/test` (1 pair: `K1_2_C1_DJI_0385_clipped_4.jpg`)**, flagged as `is_k1_overlap = true` (`9` rows total) in `audit/followup/heldout_manifest.csv`.
   - Therefore, K1 is useful as a **metric-comparison sanity check** (`bAxis` ellipse minor axis vs `minFeret` caliper width vs `dEq` vs `n = 251` field caliper b-axes at `0.39 mm/px`), **not** as an independent held-out site validation.
   - `demo_data/FH_resolutions.csv` provides `0.39 mm/px` scale metadata for `FH` imagery, but no physical Wolman/sieve measurements.

---

## 2. Field Validation Protocol for Users (from `AUDIT_REPORT.md` §7)

Before using absolute grain-size values from `webGrainy` in publications or engineering decisions, follow this site-level protocol:

1. **In-plane scale & geometry at every site:**
   - Place a rigid, high-contrast reference scale (e.g., survey rod or calibration board) **in the plane of the gravel bed** with two clearly visible endpoints as far apart as possible.
   - Shoot **near-nadir** (camera sensor parallel to the bed). If oblique, include a 4-point planar target and rectify using the 4-point homography tool before calibrating scale.
   - Avoid wet/glare-heavy surfaces, deep shadows, vegetation, and sand-dominated patches where possible.

2. **Co-located physical ground truth (minimum 1 patch per campaign; ≥ 5 reaches for method validation):**
   - On at least one photographed patch per campaign, perform a **Wolman pebble count (`n ≥ 100` clasts, grid-by-number)** measuring the **b-axis with a caliper** (or gravelometer/sieve equivalent), or collect a bulk sieve sample converted via Kellerhals & Bray (1971) grid-by-number equivalence.
   - Compare **area-weighted photo `D50` and `D84` (in mm)** against the Wolman/caliper `D50` and `D84`. Record both the **ellipse minor-axis (`bAxis`)** and **minimum Feret (`minFeret`)** ratios against caliper b-axes. Proceed only if the bias is acceptable for your application.

3. **Visual mask QC & manual editing:**
   - Inspect every mask overlay. Use the interactive editor to **delete false positives** (rulers, boots, shadows, vegetation, sand sheets) and **split merged clasts** or **merge over-segmented clasts**.

4. **Truncation & sample-size discipline:**
   - Treat **`D16` and finer percentiles as truncated** by the working-resolution `minSize` (`30 px` at working resolution, which corresponds to larger physical sizes when images > 1024 px are downscaled) unless independently validated against sieve data.
   - Aim for **`n ≥ 100` interior grains** per site/sample (the app warns below `30` and `100`).

5. **Full provenance reporting:**
   - Always report: sample size `n`, pooling mode, weighting (`area-weighted`), size metric definition (`ellipse minor axis`, `equivalent circular diameter`, or `min-Feret`), `modelId`, pinned `modelRevision` & SHA-256 hash, `effectiveScaleFactor`, `mmPerPx`, and post-processing parameters (all included in `webGrainy` export metadata).
