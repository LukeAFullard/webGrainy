# Item 2: Upstream Parity Matrix (`dmair1989/imagegrains` vs `webGrainy`)

Reference upstream repository: `dmair1989/imagegrains` (`main` branch, BSD-3-Clause), inspected via:
- `src/imagegrains/segmentation_helper.py` (1019 lines)
- `src/imagegrains/grainsizing.py` (1219 lines)
- `src/imagegrains/gsd_uncertainty.py` (699 lines)

Target `webGrainy` modules:
- `src/modules/postprocessCore.ts` (1173 lines)
- `src/modules/morphometricsExt.ts` (629 lines)

---

## 1. Post-Processing Parameters & Flow-to-Mask Algorithm

| Parameter / Step | Upstream (`dmair1989/imagegrains`) | `webGrainy` (`src/modules/postprocessCore.ts`) | Divergence & Rationale | Recommendation |
|---|---|---|---|---|
| **Post-processing engine** | Delegates directly to Cellpose `model.eval(...)` (`segmentation_helper.py:194, 200`). | Custom Browser Engine v4.1 `flowsToMasksBrowser()` (`postprocessCore.ts:782-1172`). | Browser has no PyTorch/SciPy/Cellpose runtime; custom typed-array implementation. | **Keep** custom engine (required for zero-backend browser execution). |
| **`niter` (Euler steps)** | Cellpose default (`200`, unless overridden in `config` at `segmentation_helper.py:185-194`). | `niter: 250` (`DEFAULT_POSTPROCESS_OPTIONS`, `postprocessCore.ts:8`), two-phase coarse (`min(100, floor(niter/2))` with stride `max(1, max(W,H)/256)`) + fine (`1.0 px`) (`postprocessCore.ts:861-949`). | Coarse-to-fine schedule converges large grains faster in 250 steps than fixed 1-px 200-step Euler. | **Keep** (`250` coarse+fine); document difference vs Cellpose `200`. |
| **`cellprobThreshold`** | Cellpose default `0.0` (unless overridden in `config`, `segmentation_helper.py:185-194`). | `cellprobThreshold: 0.0` (`postprocessCore.ts:9, 835`). | **Parity** (exact match). | **Keep**. |
| **`flowThreshold`** | Cellpose default `0.4` (unweighted MSE of flow vs heat-diffusion gradient, via `model.eval`). | `flowThreshold: 0.45` (`postprocessCore.ts:10`) with **magnitude-weighted QC** `evaluateGrainFlowQcV4()` (`postprocessCore.ts:241-394`): `wMag = min(1.0, rawMag / 1.5)`, `dist2 <= 2` sink exclusion, `normalizedErr = flowErr / 10.0 <= flowThreshold`. | Deliberate divergence (`F5_MagWeightedQC`): down-weights near-zero flow pixels and center sink artifacts where `atan2`/unit flow direction is noisy. | **Keep** `F5_MagWeightedQC` + `0.45` (validated on IG2; note that `0.4` vs `0.45` is not directly comparable due to magnitude weighting). |
| **`minSize`** | `min_size=15` px (`segmentation_helper.py:167, 228, 258`). | `minSize: 30` px (`postprocessCore.ts:11, 1100`). | Deliberate divergence: halves false-positive speckle fragments on high-res gravel photos, at the cost of dropping grains < 30 px (~6 px diameter). | **Keep `30` as default** for stability, **align/expose** `15` in UI/docs for fine-grained close-up photos where grains are 15–30 px. |
| **`minSeedDensity`** | Not exposed; Cellpose uses histogram thresholding / morphological seed clustering. | `minSeedDensity: 2` (`postprocessCore.ts:12, 960-976`) with fallback to `1` if no dense seed exists, followed by 2-pass 3×3 dilation (`:989-1012`) and `5×5` sink snapping (`:1057-1075`). | Deliberate divergence to suppress 1-pixel stray sink clusters while preserving recall on sparse images. | **Keep**. |
| **`maxGrainAreaFraction`** | Cellpose `max_size_fraction=0.4` (40% of image area). | `maxGrainAreaFraction: 0.15` (15% of image area, `postprocessCore.ts:14, 1089, 1106-1108`). | Deliberate v4.1 outlier guard (`3ca10b7c`): rejects merged background/cobble-sheet masks >15% of frame before QC/split. | **Keep** `0.15` guard (and measure its effect via ablation in Workstream A). |
| **Dumbbell splitting** | None in `segmentation_helper.py` / Cellpose `dynamics.py`. | `trySplitDumbbellV4()` (`postprocessCore.ts:402-420, 1126-1153`): splits QC-failed masks using 2-peak sink + inward-divergence (`dist2 >= 36`) and validates both children. | Deliberate divergence (`F3_SplitOnFailure`) to recover touching grain pairs that merged into one sink basin. | **Keep** (gated by `minSize`, `maxArea`, and child `evaluateGrainFlowQcV4`). |
| **Border exclusion** | Not filtered by default in `grains_from_masks()` (`grainsizing.py:153-230`), though `resample_masks()` has `edge_offset` (`grainsizing.py:660`). | `excludeBorderMargin: 2` (`postprocessCore.ts:13, 1161`) flags `touchesBorder` on grains within 2 px of image edge (`postprocessCore.ts:768`). | Flags edge-truncated grains for downstream filtering without silently deleting them from masks. | **Keep**. |

---

## 2. Grain-Axis & Morphometric Definitions

| Metric / Definition | Upstream (`dmair1989/imagegrains`) | `webGrainy` (`postprocessCore.ts` & `morphometricsExt.ts`) | Divergence & Rationale | Recommendation |
|---|---|---|---|---|
| **Default ellipse `a`-axis / `b`-axis** | `skimage.measure.regionprops_table` `major_axis_length` / `minor_axis_length`, renamed to `ell: a-axis (px)` / `ell: b-axis (px)` (`grainsizing.py:154, 187, 213-214`). | Second-order central moments `4 * sqrt(l1)` / `4 * sqrt(l2)` (`postprocessCore.ts:736-746`). | **Exact mathematical parity** with `skimage.measure.regionprops` inertia-tensor ellipse axes. | **Keep** (exact parity). |
| **Orientation** | `skimage.measure.regionprops` `orientation` (`grainsizing.py:154`), converted to azimuth via `(90 - degrees(orientation)) % 360` (`grainsizing.py:460-468`). | `orientationRad` matching `regionprops.orientation` (`postprocessCore.ts:749-757`). | **Exact parity**. | **Keep**. |
| **Equivalent diameter (`dEq`)** | `equivalent_diameter_area` in `filter_by_threshold_size` (`grainsizing.py:1191`) = `sqrt(4 * area / pi)`. | `dEqPx = Math.sqrt((4.0 * acc.area) / Math.PI)` (`postprocessCore.ts:747`). | **Exact parity**. | **Keep**. |
| **Alternative `a`-axis / `b`-axis (`convex_hull` / `mask_outline`)** | `fit_grain_axes(method='convex_hull' | 'mask_outline')` (`grainsizing.py:360-405`): `get_a_axis()` (`:447-458`) = max pairwise Euclidean distance on contour; `iterate_b()` (`:470-505`) = max chord perpendicular to `a_norm` within `outline_threshold = 0.5°` (widening by `+0.5°` up to `5°` if `b_ax == 0`). | `computeConvexHull()` + `computeFeretDiameters()` (`morphometricsExt.ts:127-226`): `maxFeretPx` = max pairwise hull vertex distance; `minFeretPx` = minimum caliper width via rotating calipers across hull edges (`morphometricsExt.ts:206-225`). | **Deliberate divergence**: Upstream's `iterate_b()` measures the longest chord perpendicular to `a`-axis (slow `O(k^2)` + angular tolerance heuristic); `webGrainy`'s `minFeretPx` measures true minimum caliper width (closest 2D analogue to physical caliper/sieve `b`-axis). | **Keep `minFeretPx`** (faster, deterministic, physically closer to caliper `b`-axis); document that it differs from `imagegrains`'s `convex hull: b axis` / `mask outline: b axis`. |
| **Crofton perimeter & circularity / solidity** | `perimeter_crofton`, `solidity` (renamed `convexity`), `isoperimetric_ratios` (`grainsizing.py:154, 223, 229-230`). | `computeCroftonPerimeterPx()` (`morphometricsExt.ts:78-118`), `circularity = min(1, 4*pi*A/P^2)` (`:7`), `solidity = min(1, A/convexArea)` (`:15`). | **Parity** on Crofton 4-direction perimeter and solidity. | **Keep**. |
| **Uncertainty (Binomial & Bootstrap)** | `QuantBD()` (`gsd_uncertainty.py:68-119`) and `bootstrapping()` (`gsd_uncertainty.py:128-160`, `num_it=1000`, `CI_bounds=[2.5, 97.5]`). | Implemented in `siteAnalysis.ts` (outside `postprocessCore.ts`/`morphometricsExt.ts`). | Same statistical methods (Eaton 2019 binomial quantile CI + 1000-iter percentile bootstrap). | **Keep**. |
