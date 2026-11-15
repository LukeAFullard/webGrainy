# webGrainy — ImageGrains 2.0 Web

A **100% browser-native, privacy-first, offline-first** gravel and sediment grain-sizing engine in TypeScript, built to run the pretrained **ImageGrains 2.0** segmentation models directly in the browser via ONNX Runtime Web.

All image preprocessing, neural inference (`onnxruntime-web` via WebGPU or SIMD WASM), gradient flow integration, multigrid PDE post-processing, interactive mask editing, and sedimentological statistics execute **entirely on the user's device**. No imagery or measurements are ever uploaded to a server, and no external CDNs are referenced at runtime.

> **Disclaimer & Attribution:** This is an **independent, unofficial** browser implementation and is **not affiliated with, endorsed by, or maintained by** the original ImageGrains or Cellpose authors. It is an independent effort to convert and package the pretrained weights into ONNX ([`inYourOwnBrowser/imagegrains-2.0-onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx)) and build a browser-native processing pipeline around them. The architecture, post-processing, and workflows differ from the official Python library at [**dmair1989/imagegrains**](https://github.com/dmair1989/imagegrains). Please cite the original authors' work below if you use these models or methods.

---

## Features

- **Zero Server-Side Processing & Zero External CDNs:** All ONNX Runtime WASM/WebGPU binaries and TypeScript modules are bundled locally (`dist/ort/`).
- **Pinned, Integrity-Verified Model Caching (`modelCache.ts`):** Streams `.onnx` weights from a **pinned Hugging Face commit** (`inYourOwnBrowser/imagegrains-2.0-onnx@7773328a`), verifies each file's **size and SHA-256** with WebCrypto before use, and persists the verified buffer in **IndexedDB** (`imagegrains-onnx-cache-v1`). Cache entries with a missing or mismatched hash are re-downloaded. This network request (to `huggingface.co` and its `*.hf.co` CDN) is the app's only one.
- **Adaptive Preprocessing & Complexity Router (`imagePreprocess.ts`):**
  - Optional pure-TypedArray **CLAHE** luminance normalization for harsh shadows and wet-stone glare.
  - **Adaptive Input Scaling** (`'auto' | '1.0x' | '0.5x' | '0.25x'`) to prevent large boulders (`> 350 px`) from being under-predicted in `256×256` tiles, while tracking `effectiveScaleFactor` so all morphometrics scale back to original image pixels and millimeters.
  - **Complexity Router (`recommendModel`)**, nominally ~5 ms on a 256×256 thumbnail on desktop hardware and slower on mobile or under load. It combines Sobel gradient entropy, multi-scale contrast variance, shadow/glare dynamic range, and hardware capability (WebGPU adapter, `shader-f16` support for FP16 CP-SAM, `deviceMemory`) to recommend U-Net vs. Cellpose-SAM. The recommendation is a heuristic; check the masks.
- **WebGPU / WASM Inference (`onnxInference.ts`):**
  - **Fast Model (`ig2_unet_fp32.onnx`, 25.3 MiB / 26.5 MB):** 16-px reflection padding, `[1, 2, H, W]` FP32 inference.
  - **High-Accuracy Model (`ig2_cpsam_fp16.onnx`, 588.8 MiB / 617.4 MB):** `256×256` overlapping tiles (`64 px` overlap / `192 px` stride), 2D clipped Hanning taper blending, zero-dependency IEEE-754 `Float32 <-> Float16` conversion, WebGPU `shader-f16` capability gating with explicit CPU WASM fallback warning, WebGPU `device.lost` recovery (evicting poisoned sessions), and `AbortSignal` cancellation.
- **Browser Engine v4.1 Web Worker (`grainPostprocess.worker.ts` & `postprocessCore.ts`):**
  - Zero-copy `ArrayBuffer` transfer.
  - Two-phase bilinear Euler flow integration (`100` coarse + `150` `1.0 px` steps).
  - 4-level coarse-to-fine Multigrid 9-point Jacobi PDE (`8× -> 4× -> 2× -> 1×`).
  - `F5_MagWeightedQC` and `F3_SplitOnFailure` dumbbell recovery with **`maxGrainAreaFraction = 0.40`** (matching upstream Cellpose `max_size_fraction=0.4`, raised from `0.15` after the held-out ablation showed `0.15` dropped real cobbles on `10/40` CP-SAM test images). Configurable up to `1.0` in the sidebar. **This flow-QC is a custom criterion, not Cellpose's `flow_error`** (which compares `masks_to_flows` against `dP/5` with threshold 0.4), so masks differ from upstream Cellpose/ImageGrains output.
  - Border-grain flagging (`margin = 2 px`) and second-order central moments (`aAxisPx`, `bAxisPx`, `dEqPx`, `centroidX`, `centroidY`, `orientationRad`), plus min/max **Feret (caliper) diameters** (`min_feret_*`, `max_feret_*`) computed on demand via rotating calipers with cached convex hulls.
  - Other defaults (`flowThreshold 0.45`, `cellprobThreshold 0`, `minSize 30 px`, `niter 250`, border margin `2 px`) match the benchmarked configuration. `minSize` and the border margin apply at *working* resolution, so after auto-downscaling they correspond to larger sizes in original pixels.
- **Interactive Human-in-the-Loop Editing (`interactiveEditor.ts`):**
  - Deterministic TypedArray `splitGrainAtLine`, `mergeGrains`, `deleteGrain`, and `addPolygonGrain`.
  - Bounding-box diff `Undo/Redo` history stack (about 1 ms per step on desktop).
  - Two-point spatial `ScaleCalibrator` (`mmPerPx`) and 4-point perspective homography rectification.
- **Sedimentology Statistics & Exports (`sedimentStats.ts` & `siteAnalysis.ts`):**
  - Area-weighted and number-weighted PSD percentiles ($D_5 \dots D_{95}$). Area weighting approximates a grid-by-number (Wolman) sample in principle, because the chance of a grid point hitting a grain is proportional to its exposed area (Kellerhals & Bray 1971). It uses only the *exposed 2D* area, and fines below the detection limit are truncated.
  - **Selectable Size Metric (`sizeMetric: 'bAxis' | 'minFeret' | 'dEq'`):** Both Pooled Site and Active Photo views support switching between **moment-ellipse minor axis (`bAxis`, default)**, **minimum Feret rotating-calipers width (`minFeret`)**, and **equal-area circle diameter (`dEq`)**, updating PSD percentiles, Folk & Ward statistics, Wentworth classes, and exports consistently. Note that ellipse `b_axis` is **not a sieve or caliper b-axis**; `minFeret` is the closest 2D analogue of a caliper b-axis.
  - **Folk & Ward (1957)** $\phi$-unit graphic mean ($M_z$), sorting ($\sigma_I$), skewness ($Sk_I$), kurtosis ($K_G$), and Wentworth size class proportions.
  - Client-side `Blob` exports: per-grain CSV, summary JSON/CSV, 16/32-bit PNG instance masks, and GeoJSON / SVG vector contours (Marching Squares, original-image coordinates).
  - **Every export carries provenance metadata:** app and ORT versions, model id, revision and SHA-256, execution provider, post-processing parameters, scale factor, calibration, ROI use, date, the size-metric definition, and the unofficial-port and citation notice. CSV cells are protected against spreadsheet formula injection.

---

## Hosted ONNX Models & Benchmark Accuracy

Models are hosted at [`inYourOwnBrowser/imagegrains-2.0-onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx) (pinned revision `7773328a544ac050b7820667e68cbfb02a2e954a`).

### Within-Site Held-Out Test Split (`IG2_data.zip`, `official_split == 'test'`, `n = 40` across 13 sites)

Evaluated using the **actual shipped TypeScript engine** (`src/modules/postprocessCore.ts`, frozen defaults: `niter=250, cellprobThreshold=0.0, flowThreshold=0.45, minSize=30, minSeedDensity=2, excludeBorderMargin=2`) comparing **`maxGrainAreaFraction = 0.15`** (legacy v1.1.0 default) vs **`1.00`** (guard disabled), alongside **upstream PyTorch ImageGrains**, against **hand-digitised 2D pixel masks** (`bAxis`, moment-ellipse minor axis; *not* physical sieve/Wolman data):

#### D50 Error vs Human GT (Primary Grain-Size Metric)

| Model | Engine / Guard | D50 MAPE: mean [95% CI] | D50 MAPE: median [95% CI] | P90 / >25% / >50% | Signed bias (med / mean) | PQ vs GT |
| :--- | :--- | :--- | :--- | :--- | :--- | ---: |
| **U-Net** (`ig2_unet_fp32.onnx`, 26.5 MB) | Shipped TS v4.1 (`guard = 0.15`) | `31.02%` `[19.76, 45.54]` | `15.31%` `[9.17, 26.25]` | `83.31%` / `35.0%` / `20.0%` | `-8.93%` / `-10.10%` | `0.480` |
| **U-Net** (`ig2_unet_fp32.onnx`) | Shipped TS v4.1 (`guard = 1.00`, ablation) | `27.48%` `[16.93, 42.12]` | `14.84%` `[7.35, 23.02]` | `83.31%` / `30.0%` / `17.5%` | `-2.38%` / `-3.74%` | `0.485` |
| **U-Net** (`IG2_full_set.200525`) | Upstream PyTorch (`cellpose==3.1.1.1`) | `27.47%` `[14.83, 46.34]` | `9.26%` `[6.33, 17.04]` | `78.51%` / `27.5%` / `15.0%` | `+2.18%` / `+10.88%` | `0.528` |
| **Cellpose-SAM** (`ig2_cpsam_fp16.onnx`, 617.4 MB) | Shipped TS v4.1 (`guard = 0.15`) | `21.85%` `[13.74, 31.00]` | `6.50%` `[2.48, 17.90]` | `67.28%` / `30.0%` / `20.0%` | `-1.30%` / `-12.87%` | `0.562` |
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

> **Comparison with upstream PyTorch:** Paired on the same 40 images (`audit/followup/paired_comparison.py`), the shipped engine is **not distinguishable from upstream PyTorch** on D50 error: CP-SAM mean ΔAPE `-4.88` pp, 95% CI `[-11.50, +0.68]`, better on `19/40` images, sign test p = `0.88`; U-Net `+0.01` pp, `[-7.76, +7.41]`, `22/40`. Its PQ is lower than PyTorch (CP-SAM `0.571` vs `0.642`; U-Net `0.485` vs `0.528`). Only the guard effect is significant: for CP-SAM, `1.00` beats `0.15` by `-12.41` pp `[-20.64, -5.33]`, p = `0.002`; for U-Net it is not significant.

> ⚠️ **Ablation Finding (`maxGrainAreaFraction`):** The legacy v1.1.0 `0.15` upper-area guard silently dropped legitimate cobbles occupying >15% of the image frame (`10/40` test images for CP-SAM, `6/40` for U-Net), doubling CP-SAM D50 error (`9.43%` → `21.85%` mean APE) and introducing a `-12.87%` mean fine bias. The default has been raised to `0.40` (matching upstream Cellpose `max_size_fraction=0.4`) and can be set up to `1.00` in the sidebar when single boulders span >40% of the frame. **The `0.40` default has not itself been benchmarked**, and it was chosen after inspecting these test images. Full reproduction manifests and data are in [`FOLLOWUP_REPORT.md`](FOLLOWUP_REPORT.md) and [`audit/followup/heldout_summary.json`](audit/followup/heldout_summary.json).

> ⚠️ **Within-Site Scope Caveat:** `IG2_data.zip` contains `243` image/mask pairs (`40` `test`, `203` `train`) across `13` sites. **All 13 sites contributed `train/` images** to the IG2 models (`0` completely unseen sites). The `n = 40` `test` split measures **within-site held-out performance**, not cross-site generalisation to unseen rivers.

---

## Limitations & Scientific Validity

webGrainy is an unofficial browser port of ImageGrains 2.0 and is not endorsed by its authors. Its post-processing (`F5_MagWeightedQC` + `F3_SplitOnFailure`) differs from Cellpose/ImageGrains `flow_error`.

- **Size metric definitions (`bAxis` vs `minFeret` vs `dEq`):** Reported `bAxis` values are **ellipse minor axes of the visible 2D outline**, not sieve or caliper b-axes. On the `n = 40` held-out IG2 test set, median image D50 shifts by **`+3.09%`** (CP-SAM) / **`+4.04%`** (U-Net) for `minFeret` vs `bAxis`, and by **`+23.02%`** (CP-SAM) / **`+23.00%`** (U-Net) for `dEq` vs `bAxis`. Partial burial, imbrication, and 2D projection of 3D clasts add further physical bias.
- **No unseen-site or independent physical GT validation yet:** On the held-out `n = 40` within-site test set against hand-digitised 2D masks, D50 median error is **`2.6%`–`6.5%`** for CP-SAM and **`14.8%`–`15.3%`** for U-Net, with **`5%`–`20%`** of images exceeding `50%` error depending on model and area guard. On the only co-located physical dataset found (`dmair1989/imagegrains` `demo_data/K1_field_measurement.csv`, caliper `D50 = 27.0 mm`), pooled photo `D50` (`bAxis 15.7 mm`, `minFeret 16.5–16.7 mm`, `dEq 18.7–19.0 mm`) is **~40% finer, and the gap is unexplained**. Fines skipped in the manual count, 2D burial/imbrication, the weighting basis and calibration are all candidate causes, but none has been tested. This is one site and two photos, and crops of them are in the IG2 training set. **Until a field campaign resolves it, assume absolute D50 can be substantially biased (here, too fine).** See [`audit/followup/physical_gt_and_protocol.md`](audit/followup/physical_gt_and_protocol.md) and [`AUDIT_REPORT.md`](AUDIT_REPORT.md) §7 for the field validation protocol.
- **Lens distortion is not corrected:** Modeling Brown-Conrady distortion shows `< 1%` mean center-bar D50 bias on OEM-corrected smartphones and `-3.3%` on moderate DJI drone lenses, but **`-7.4%` to `-22.2%`** (`33%` max) on uncorrected wide-FOV/GoPro cameras; pre-undistort wide-angle footage before upload. Oblique photos must be rectified (4-point tool) and calibrated (2-point tool).
- **Fine-tail truncation & hardware constraints:** Fines below about `30` working-resolution pixels are not detected (`D5–D16` are truncated unless validated; consider `minSize = 15` on unscaled high-detail frames). CP-SAM WebGPU execution requires adapter `shader-f16` support (devices without `shader-f16` fall back to slow CPU WASM with a warning and have not yet been benchmarked on physical consumer GPUs in CI).
- **Degrading conditions:** Wet or shiny surfaces, strong shadows, vegetation, sand matrix, very large clasts relative to the frame (`> maxGrainAreaFraction`), and images with fewer than about `100` interior grains (the app warns below `30` and `100`).

**Always calibrate scale, inspect and edit the masks, report `n` and the pinned model hash (included in every export), and validate against field measurements (Wolman count `n >= 100` or bulk sieve) for your site before using absolute values in publications.**


---

## Module Architecture

```text
src/
├── index.ts                        # Public library exports
├── types/
│   └── index.ts                    # Shared TypeScript interfaces & types
├── modules/
│   ├── modelCache.ts               # Streaming HF downloader + IndexedDB cache
│   ├── imagePreprocess.ts          # CLAHE, adaptive scaling, complexity router
│   ├── onnxInference.ts            # WebGPU/WASM sessions, tiling, FP16 utilities
│   ├── postprocessCore.ts          # Flow integration, Multigrid PDE, QC, moments
│   ├── interactiveEditor.ts        # Split/merge/delete/add, undo/redo, calibration
│   ├── sedimentStats.ts            # PSD percentiles, Folk & Ward, CSV/JSON/PNG/GeoJSON/SVG
│   ├── pipelineController.ts       # ImageGrainsEngine & reactive AnalysisSession
│   ├── provenance.ts               # Export metadata, versions, notices, CSV-safe cells
│   ├── roiAndRectify.ts            # ROI/exclusion masks, 4-point homography rectification
│   ├── morphometricsExt.ts         # Shape metrics, Feret diameters, fabric statistics
│   ├── siteAnalysis.ts             # Multi-photo pooling, bootstrap / binomial CIs, adequacy
│   └── projectStorage.ts           # IndexedDB projects, validated archive import/export
└── workers/
    └── grainPostprocess.worker.ts  # Transferable Web Worker wrapper (v4.1)
```

---

## Quick Start

```ts
import { ImageGrainsEngine, ScaleCalibrator } from './dist/index.js';

const engine = new ImageGrainsEngine({
  // Relative paths are resolved against the page (document.baseURI).
  sessionCreateOptions: { wasmPaths: './ort/' },
});

await engine.initialize();

const session = await engine.analyzeImage(imageBitmap, {
  model: 'auto',          // Complexity Router picks 'unet' or 'cpsam'
  scaleMode: 'auto',      // Downscales longest edge > 1024 px, tracks effectiveScaleFactor
  applyClahe: false,
  // Optional two-point calibration in original-image pixels:
  calibration: ScaleCalibrator.calibrate({ x: 100, y: 200 }, { x: 600, y: 200 }, 250),
  onProgress: (stage, detail) => console.log(stage, detail),
});

const stats = session.getStats();
console.log('D50:', stats.areaWeightedB.D50, stats.unit, 'n =', stats.includedGrains);
console.log('Warnings:', stats.warnings);
console.log('Folk & Ward mean (phi):', stats.folkWard?.meanPhi);

// Interactive correction & export (CSV with '#' provenance header lines)
session.splitGrainAtLine(42, [{ x: 120, y: 80 }, { x: 155, y: 110 }]);
const csv = session.exportCsv({ includeMetadata: true });
```

---

## Development & Verification

```bash
npm ci
npm run typecheck          # Strict TypeScript check (tsc --noEmit)
npm test                   # Unit, numerical-parity and mocked E2E tests (Vitest)
npm run build              # dist/: app, worker, ORT JSEP runtime, content-hashed service worker
npm run test:e2e:browser   # Headless Chromium on dist/: real U-Net analysis (pinned, SHA-256 verified)
npm run test:perf          # Micro-benchmarks with strict nominal time budgets (idle machine)
```

CI (`.github/workflows/ci.yml`) runs all of the above except `test:perf` on every push and pull request. See [DEPLOYMENT.md](DEPLOYMENT.md) for hosting requirements and [CHANGELOG.md](CHANGELOG.md) for release notes. Audit scripts that reproduce `AUDIT_REPORT.md` are in [`audit/`](audit/README.md).

---

## Citations & Acknowledgments

This project builds directly upon the research, pretrained models, and algorithms of [**dmair1989/imagegrains**](https://github.com/dmair1989/imagegrains). If you use **webGrainy / ImageGrains 2.0 Web** in scientific work, please cite the upstream ImageGrains and Cellpose papers:

- **ImageGrains 2.0:**
  Mair, D., Witz, G., Do Prado, A., Garefalakis, P., Wild, A., Ville, F., Schuster, B., Horn, M., Österle, J., Fabbri, S. C., Litty, C., Achleitner, S., Leistner, S., Hiller, C., and Schlunegger, F. (2026): *ImageGrains 2.0: Improved precision and generalization for grain segmentation*, Earth Surf. Dyn., 14, 527–551, https://doi.org/10.5194/esurf-14-527-2026

- **Cellpose-SAM:**
  Pachitariu, M., Rariden, M., Stringer, C. (2025): *Cellpose-SAM: superhuman generalization for cellular segmentation*, bioRxiv 2025.04.28.651001, https://doi.org/10.1101/2025.04.28.651001

- **ImageGrains 1.0 (legacy IG1 / Cellpose 2 models):**
  Mair, D., Witz, G., Do Prado, A.H., Garefalakis, P. & Schlunegger, F. (2023): *Automated detecting, segmenting and measuring of grains in images of fluvial sediments: The potential for large and precise data from specialist deep learning models and transfer learning*, Earth Surface Processes and Landforms, 1–18, https://doi.org/10.1002/esp.5755

- **Cellpose 1.0:**
  Stringer, C.A., Pachitariu, M. (2021): *Cellpose: a generalist algorithm for cellular segmentation*, Nat Methods 18, 100–106, https://doi.org/10.1038/s41592-020-01018-x

- **Grain-Size Percentile Uncertainties:**
  Mair, D., Henrique, A., Prado, D., Garefalakis, P., Lechmann, A., Whittaker, A., and Schlunegger, F. (2022): *Grain size of fluvial gravel bars from close-range UAV imagery—uncertainty in segmentation-based data*, Earth Surf. Dyn., 10, 953–973, https://doi.org/10.5194/esurf-10-953-2022

- **Folk & Ward Graphic Statistics:**
  Folk, R. L., & Ward, W. C. (1957): *Brazos River bar: a study in the significance of grain size parameters*, Journal of Sedimentary Petrology, 27(1), 3–26.

---

## License

The webGrainy source code is licensed under the **BSD 3-Clause License** (see [LICENSE](LICENSE)). The model weights are distributed separately by Hugging Face under **CC BY 4.0**, derived from the ImageGrains release (Zenodo [10.5281/zenodo.15728186](https://doi.org/10.5281/zenodo.15728186)). Bundled third-party software (ONNX Runtime Web, MIT) and the model lineage (Cellpose, BSD-3; SAM, Apache-2.0) are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Citation metadata is in [CITATION.cff](CITATION.cff).