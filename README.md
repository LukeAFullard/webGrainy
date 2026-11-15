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
  - **Complexity Router (`recommendModel`)**, nominally ~5 ms on a 256×256 thumbnail on desktop hardware and slower on mobile or under load. It combines Sobel gradient entropy, multi-scale contrast variance, shadow/glare dynamic range, and hardware capability (WebGPU adapter, `deviceMemory`) to recommend U-Net vs. Cellpose-SAM. The recommendation is a heuristic; check the masks.
- **WebGPU / WASM Inference (`onnxInference.ts`):**
  - **Fast Model (`ig2_unet_fp32.onnx`, 25.3 MB):** 16-px reflection padding, `[1, 2, H, W]` FP32 inference.
  - **High-Accuracy Model (`ig2_cpsam_fp16.onnx`, ~588 MB):** `256×256` overlapping tiles (`64 px` overlap / `192 px` stride), 2D clipped Hanning taper blending, zero-dependency IEEE-754 `Float32 <-> Float16` conversion, and `AbortSignal` cancellation.
- **Browser Engine v4.1 Web Worker (`grainPostprocess.worker.ts` & `postprocessCore.ts`):**
  - Zero-copy `ArrayBuffer` transfer.
  - Two-phase bilinear Euler flow integration (`100` coarse + `150` `1.0 px` steps).
  - 4-level coarse-to-fine Multigrid 9-point Jacobi PDE (`8× -> 4× -> 2× -> 1×`).
  - `F5_MagWeightedQC` and `F3_SplitOnFailure` dumbbell recovery with the **v4.1 `maxGrainAreaFraction = 0.15` upper-area guard** (prevents background sand sheets from splitting into giant false positives). **This flow-QC is a custom criterion, not Cellpose's `flow_error`** (which compares `masks_to_flows` against `dP/5` with threshold 0.4), so masks differ from upstream Cellpose/ImageGrains output.
  - Border-grain flagging (`margin = 2 px`) and second-order central moments (`aAxisPx`, `bAxisPx`, `dEqPx`, `centroidX`, `centroidY`, `orientationRad`), plus min/max **Feret (caliper) diameters** in the extended morphometrics.
  - Default parameters (`flowThreshold 0.45`, `cellprobThreshold 0`, `minSize 30 px`, `niter 250`, border margin 2 px) are the configuration benchmarked in the validation report. `minSize` and the border margin apply at *working* resolution, so after auto-downscaling they correspond to larger sizes in original pixels.
- **Interactive Human-in-the-Loop Editing (`interactiveEditor.ts`):**
  - Deterministic TypedArray `splitGrainAtLine`, `mergeGrains`, `deleteGrain`, and `addPolygonGrain`.
  - Bounding-box diff `Undo/Redo` history stack (about 1 ms per step on desktop).
  - Two-point spatial `ScaleCalibrator` (`mmPerPx`).
- **Sedimentology Statistics & Exports (`sedimentStats.ts`):**
  - Area-weighted and number-weighted PSD percentiles ($D_5 \dots D_{95}$). Area weighting approximates a grid-by-number (Wolman) sample in principle, because the chance of a grid point hitting a grain is proportional to its exposed area (Kellerhals & Bray 1971). It uses only the *exposed 2D* area, and fines below the detection limit are truncated.
  - **Size metric:** the reported `b_axis` is the **minor axis of the moment-equivalent ellipse** of each grain's visible outline. It is **not a sieve or caliper b-axis**, and on non-elliptical shapes it can differ from the minimum Feret width by about ±15%. `min_feret_*` columns in the pooled grains CSV give the caliper-style width.
  - **Folk & Ward (1957)** $\phi$-unit graphic mean ($M_z$), sorting ($\sigma_I$), skewness ($Sk_I$), kurtosis ($K_G$), and Wentworth size class proportions.
  - Client-side `Blob` exports: per-grain CSV, summary JSON/CSV, 16/32-bit PNG instance masks, and GeoJSON / SVG vector contours (Marching Squares, original-image coordinates).
  - **Every export carries provenance metadata:** app and ORT versions, model id, revision and SHA-256, execution provider, post-processing parameters, scale factor, calibration, ROI use, date, the size-metric definition, and the unofficial-port and citation notice. CSV cells are protected against spreadsheet formula injection.

---

## Hosted ONNX Models & Benchmark Context

Models are hosted at [`inYourOwnBrowser/imagegrains-2.0-onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx) (pinned revision `7773328a`). They were evaluated on **238 ground-truth photographs** (237 grain-bearing plus 1 negative control) in [`full_dataset_validation_report.md`](full_dataset_validation_report.md). D50 errors are area-weighted, **in pixels, against hand-digitised masks** (not sieve or Wolman data):

| Model (browser engine v4) | Size | D50 error vs human GT: mean / median | Images with >50% D50 error | D50 difference vs PyTorch reference: mean / median |
| :--- | :--- | :--- | :--- | :--- |
| **U-Net** `ig2_unet_fp32.onnx` | 26.5 MB (FP32) | 22.9% / 10.7% | 34 of 235 | 21.7% / 10.4% |
| **Cellpose-SAM** `ig2_cpsam_fp16.onnx` | 617 MB (FP16) | 15.9% / 3.7% | 14 of 237 | 23.3% / 2.2% |

> ⚠️ **These figures are not a held-out generalisation estimate.** 197 of the 237 images carry `site = train` in the report. Post-processing parameters (including the 0.15 area guard) were tuned on images in this set. On the 40 `site = test` images, U-Net mean D50 error is 31.3% (median 15.7%) and Cellpose-SAM is 12.5% (median 4.7%). See `AUDIT_REPORT.md` (F-02) and `audit/recompute_validation.py`.

---

## Limitations & Scientific Validity

webGrainy is an unofficial browser port of ImageGrains 2.0 and is not endorsed by its authors. Its post-processing differs from Cellpose/ImageGrains.

- Reported **b-axis values are ellipse minor axes of the visible 2D outline**, not sieve or caliper b-axes. Partial burial, imbrication, and 2D projection of 3D clasts add further bias.
- On the authors' benchmark, D50 errors against hand-digitised masks had a **median of about 4–11%**, but **exceeded 50% for 6–14% of images**, and that benchmark was not fully independent of tuning.
- **Lens distortion is not corrected.** Oblique photos must be rectified (4-point tool) and calibrated (2-point tool). Uncalibrated results are reported in pixels.
- **Fines below about 30 working-resolution pixels are not detected**, so D5–D16 are truncated unless validated.
- Results degrade with wet or shiny surfaces, strong shadows, vegetation, sand matrix, very large clasts relative to the frame, and images with fewer than about 100 interior grains (the app warns below 30 and 100).

**Always calibrate scale, inspect the masks, report n and the model hash (included in every export), and validate against field measurements (Wolman count or sieve) for your site before using absolute values in publications.**

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