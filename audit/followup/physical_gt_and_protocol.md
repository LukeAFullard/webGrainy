# Physical Ground Truth Findings & Field Validation Protocol

## 1. Findings from `IG2_data.zip` and `dmair1989/imagegrains`

1. **`IG2_data.zip` (Zenodo `17866827`) contains zero physical ground-truth files.**
   - Central-directory inspection of `IG2_data.zip` (`525` zip entries, `486` files = `243` image/mask pairs across `13` sites: `40` `test`, `203` `train`) confirms **no** sieve, Wolman, or caliper CSVs are included.
   - All `IG2_data.zip` ground-truth masks are **hand-digitised 2D outlines in pixels**, not physical sieve or caliper measurements.
   - Furthermore, all 13 sites (`APF_2, AR, CT, DV_4, FH_2, HP, JF, NB2, NZ1, NZ2, PP, PR, S1_2`) contributed `train/` images to the IG2 models (`IG2_full_set.200525` and `IG2_full_set_cp_SAM`), so **zero completely unseen sites** exist inside `IG2_data.zip`. True cross-site generalisation requires either external unseen-site datasets or leave-one-site-out cross-validation.

2. **`dmair1989/imagegrains` `demo_data/K1_field_measurement.csv` (`n = 39` field b-axes):**
   - `demo_data/K1_field_measurement.csv` contains 39 manual field b-axis measurements in centimetres (1.3–22.5 cm, i.e. 13–225 mm) paired with `demo_data/K1/K1_C2_385.jpg` and `demo_data/K1/K1_C3_0449.jpg` at `0.39 mm/px` (per `notebooks/Complete_grain_size_and_shape_analysis_colab.ipynb` cell 21).
   - **Critical overlap caveat:** Crops from those exact K1 photographs (`K1_2_C1_DJI_0385_1.jpg`, `K1_2_C1_DJI_0385_clipped_0..6`, `K1_2_C1_DJI_0449_1.jpg`) appear in `IG2_data.zip` under **`APF_2/train` (8 pairs) and `APF_2/test` (1 pair: `K1_2_C1_DJI_0385_clipped_4.jpg`)**, flagged as `is_k1_overlap = true` (`9` rows total) in `audit/followup/heldout_manifest.csv`.
   - Therefore, K1 is useful as a **metric-comparison sanity check** (`bAxis` ellipse minor axis vs `minFeret` caliper width vs `dEq` vs `n = 39` field caliper b-axes at `0.39 mm/px`), **not** as an independent held-out site validation. (Colab execution of `K1_C2_385.jpg` & `K1_C3_0449.jpg` is included in `audit/followup/imagegrains_heldout_followup_colab.ipynb`.)
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
