# webGrainy — ImageGrains 2.0 Web

A **100% browser-native, privacy-first, offline-first** gravel and sediment grain-sizing engine in TypeScript, built on the validated **ImageGrains 2.0** ONNX segmentation pipeline.

All image preprocessing, neural inference (`onnxruntime-web` via WebGPU or SIMD WASM), gradient flow integration, multigrid PDE post-processing, interactive mask editing, and sedimentological statistics execute **entirely on the user's device**. No imagery or measurements are ever uploaded to a server, and no external CDNs are referenced at runtime.

> **Upstream Project:** This library is a client-side WebGPU/WASM port and extension of [**dmair1989/imagegrains**](https://github.com/dmair1989/imagegrains) (*A software library for segmenting and measuring sediment particles in images*). See [Citations & Acknowledgments](#citations--acknowledgments) below.

---

## Features

- **Zero Server-Side Processing & Zero External CDNs:** All ONNX Runtime WASM/WebGPU binaries and TypeScript modules are bundled locally (`dist/ort/`).
- **Offline Model Caching (`modelCache.ts`):** Streams `.onnx` weights from Hugging Face (`inYourOwnBrowser/imagegrains-2.0-onnx`) with byte-level progress (`loadedBytes`, `totalBytes`, `percent`, `speedMBps`) and persists them in **IndexedDB** (`imagegrains-onnx-cache-v1`) for sub-second offline reloads.
- **Adaptive Preprocessing & Complexity Router (`imagePreprocess.ts`):**
  - Optional pure-TypedArray **CLAHE** luminance normalization for harsh shadows and wet-stone glare.
  - **Adaptive Input Scaling** (`'auto' | '1.0x' | '0.5x' | '0.25x'`) to prevent large boulders (`> 350 px`) from being under-predicted in `256×256` tiles, while tracking `effectiveScaleFactor` so all morphometrics scale back to original image pixels and millimeters.
  - **`< 5 ms` Complexity Router (`recommendModel`)** combining Sobel gradient entropy, multi-scale contrast variance, shadow/glare dynamic range, and hardware capability (`navigator.gpu`, `deviceMemory`) to recommend U-Net vs. Cellpose-SAM.
- **WebGPU / WASM Inference (`onnxInference.ts`):**
  - **Fast Model (`ig2_unet_fp32.onnx`, 25.3 MB):** 16-px reflection padding, `[1, 2, H, W]` FP32 inference.
  - **High-Accuracy Model (`ig2_cpsam_fp16.onnx`, ~588 MB):** `256×256` overlapping tiles (`64 px` overlap / `192 px` stride), 2D clipped Hanning taper blending, zero-dependency IEEE-754 `Float32 <-> Float16` conversion, and `AbortSignal` cancellation.
- **Browser Engine v4.1 Web Worker (`grainPostprocess.worker.ts` & `postprocessCore.ts`):**
  - Zero-copy `ArrayBuffer` transfer.
  - Two-phase bilinear Euler flow integration (`100` coarse + `150` `1.0 px` steps).
  - 4-level coarse-to-fine Multigrid 9-point Jacobi PDE (`8× -> 4× -> 2× -> 1×`).
  - `F5_MagWeightedQC` and `F3_SplitOnFailure` dumbbell recovery with the **v4.1 `maxGrainAreaFraction = 0.15` upper-area guard** (prevents background sand sheets from splitting into giant false positives).
  - Border-grain flagging (`margin = 2 px`) and exact second-order central moments (`aAxisPx`, `bAxisPx`, `dEqPx`, `centroidX`, `centroidY`, `orientationRad`).
- **Interactive Human-in-the-Loop Editing (`interactiveEditor.ts`):**
  - Deterministic TypedArray `splitGrainAtLine`, `mergeGrains`, `deleteGrain`, and `addPolygonGrain`.
  - `< 1 ms` bounding-box diff `Undo/Redo` history stack.
  - Two-point spatial `ScaleCalibrator` (`mmPerPx`).
- **Sedimentology Statistics & Exports (`sedimentStats.ts`):**
  - Area-weighted (Wolman / grid-by-number equivalent) and number-weighted PSD percentiles ($D_5, D_{10}, D_{16}, D_{25}, D_{50}, D_{75}, D_{84}, D_{90}, D_{95}$).
  - **Folk & Ward (1957)** $\phi$-unit graphic mean ($M_z$), sorting ($\sigma_I$), skewness ($Sk_I$), kurtosis ($K_G$), and Wentworth size class proportions.
  - Client-side `Blob` exports: per-grain CSV, summary JSON/CSV, 16/32-bit PNG instance masks, and GeoJSON / SVG vector contours (Marching Squares).

---

## Hosted ONNX Models & Benchmark Context

Models are hosted at [`inYourOwnBrowser/imagegrains-2.0-onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx) and validated across **238 ground-truth photographs** (237 grain-bearing + 1 negative clutter control):

| Model | File | Size / Precision | Target Hardware | Area-Weighted $D_{50}$ MAPE ($n=237$) |
| :--- | :--- | :--- | :--- | :--- |
| **U-Net (Fast)** | `ig2_unet_fp32.onnx` | 25.3 MB (FP32) | Mobile / CPU WASM / WebGPU | `22.93%` (Median `10.33%` vs. PyTorch) |
| **Cellpose-SAM (High Accuracy)** | `ig2_cpsam_fp16.onnx` | ~588 MB (Native FP16) | Desktop WebGPU | `15.85%` (Median `2.21%` vs. PyTorch) |

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
│   └── pipelineController.ts       # ImageGrainsEngine & reactive AnalysisSession
└── workers/
    └── grainPostprocess.worker.ts  # Transferable Web Worker wrapper (v4.1)
```

---

## Quick Start

```ts
import { ImageGrainsEngine } from './dist/index.js';

const engine = new ImageGrainsEngine({
  workerUrl: './dist/workers/grainPostprocess.worker.js',
  ortWasmPaths: './dist/ort/',
});

await engine.initialize();

const session = await engine.analyzeImage(imageBitmap, {
  model: 'auto',          // Uses Complexity Router to pick 'unet' or 'cpsam'
  scaleMode: 'auto',      // Downscales longest edge > 1024 px, tracks effectiveScaleFactor
  applyClahe: false,
  mmPerPx: 0.5,           // Optional spatial calibration
  onProgress: (stage, pct, detail) => {
    console.log(`[${stage}] ${pct.toFixed(1)}% — ${detail ?? ''}`);
  },
});

console.log('D50 (mm):', session.stats.areaWeighted.bAxisMm.D50);
console.log('Folk & Ward Mean (phi):', session.stats.folkWard.meanPhi);

// Interactive correction & export
session.splitGrain(42, [{ x: 120, y: 80 }, { x: 155, y: 110 }]);
const csvBlob = session.exportCSV();
```

---

## Development & Verification

```bash
npm install
npm run typecheck   # Strict TypeScript check (tsc --noEmit)
npm run build       # Bundles ESM modules, Web Worker, and local ORT binaries into dist/
npm test            # Runs 12 test suites (218 unit, numerical parity, and E2E tests)
```

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

Licensed under the **BSD 3-Clause License** — see [LICENSE](LICENSE) for details, matching the licensing of [`dmair1989/imagegrains`](https://github.com/dmair1989/imagegrains).