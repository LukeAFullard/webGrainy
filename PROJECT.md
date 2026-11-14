# Project: ImageGrains 2.0 Web

## Architecture
100% client-side, privacy-first, offline-first gravel and sediment grain-sizing engine in strict TypeScript (`"strict": true`) with zero external CDN dependencies and zero server-side processing.

- **Data Flow**:
  1. `modelCache.ts`: Stream-downloads `.onnx` weights from Hugging Face (`inYourOwnBrowser/imagegrains-2.0-onnx`) with `ReadableStream` byte progress and persists them in IndexedDB (`imagegrains-onnx-cache-v1`).
  2. `imagePreprocess.ts`: Optional pure-TypedArray CLAHE on luminance, `< 5 ms` Complexity Router (`recommendModel`) on a `256×256` thumbnail + WebGPU/deviceMemory probe, adaptive input scaling (`ScaleMode: 'auto' | '1.0x' | '0.5x' | '0.25x'` with `effectiveScaleFactor`), and 1st–99th percentile normalizers (`normalizeGray`, `normalizeRgbJoint99`).
  3. `onnxInference.ts`: `onnxruntime-web` session manager (`webgpu` primary with automatic `wasm` SIMD fallback, using locally bundled WASM/MJS assets in `dist/ort/`), U-Net FP32 inference (16-px reflection padding + crop), and Cellpose-SAM FP16 tiled inference (`256×256` tiles, `64 px` overlap / `192 px` stride, 2D clipped Hanning taper, IEEE-754 `Float32 <-> Float16` conversion, `AbortSignal`, progress callbacks).
  4. `postprocessCore.ts` + `grainPostprocess.worker.ts` (Browser Engine v4.1): Zero-dependency Web Worker with Transferable `ArrayBuffer` I/O, two-phase Euler flow integration (`100` coarse + `150` `1.0 px`), 2D sink histogram + 2-pass `3×3` dilation + 8-connected BFS + `2 px` snap, 4-level Multigrid 9-point Jacobi heat-diffusion PDE (`8× -> 4× -> 2× -> 1×` with `nFine = min(120, max(60, floor((bh+bw)/2)))`), `F5_MagWeightedQC`, `F3_SplitOnFailure`, mandatory v4.1 `maxGrainAreaFraction = 0.15` upper-area guard (`3ca10b7c` fix), `touchesBorder` (`margin = 2`), second-order central moments (`aAxisPx`, `bAxisPx`, `dEqPx`, `centroidX`, `centroidY`, `orientationRad`).
  5. `interactiveEditor.ts`: Deterministic pure-TypedArray mask editing (`splitGrainAtLine`, `mergeGrains`, `deleteGrain`, `addPolygonGrain`), bounding-box `Int32Array` diff `Undo/Redo` stack (`< 1 ms`), and `ScaleCalibrator` (`mmPerPx`).
  6. `sedimentStats.ts`: Border-grain filtering (toggleable, default `true`), area-weighted & number-weighted PSD percentiles (`D5..D95`, midpoint CDF `np.interp` parity to `1e-6`), Folk & Ward (1957) $\phi$-statistics ($M_z, \sigma_I, Sk_I, K_G$), Wentworth classes, and client-side `Blob` exports (per-grain CSV, summary JSON/CSV, 16/32-bit PNG mask, GeoJSON & SVG Marching Squares contours).
  7. `pipelineController.ts`: Event-driven `ImageGrainsEngine` and reactive `AnalysisSession` orchestrating the full pipeline.

## Code Layout
```
/home/antigravity/LukeAFullard/webGrainy/
├── .gitignore
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── PROJECT.md
├── src/
│   ├── index.ts
│   ├── types/
│   │   └── index.ts
│   ├── modules/
│   │   ├── modelCache.ts
│   │   ├── imagePreprocess.ts
│   │   ├── onnxInference.ts
│   │   ├── postprocessCore.ts
│   │   ├── interactiveEditor.ts
│   │   ├── sedimentStats.ts
│   │   └── pipelineController.ts
│   └── workers/
│       └── grainPostprocess.worker.ts
├── tests/
│   ├── fixtures/               # Ground-truth JSON fixtures from Python/skimage/eval_core.py
│   ├── modelCache.test.ts
│   ├── imagePreprocess.test.ts
│   ├── onnxInference.test.ts
│   ├── postprocess.test.ts
│   ├── interactiveEditor.test.ts
│   ├── sedimentStats.test.ts
│   ├── pipelineController.test.ts
│   └── e2e/                    # E2E opaque-box test suite (Tiers 1-4 + Tier 5)
└── dist/                       # Build output (gitignored): ES modules, worker, dist/ort/ WASM
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1.1 | Model streaming download | Stream `.onnx` weights from HF `inYourOwnBrowser/imagegrains-2.0-onnx` with `ReadableStream` progress (`loadedBytes`, `totalBytes`, `percent`, `speedMBps`) | M1 | ORIGINAL_REQUEST §3.1 |
| F1.2 | IndexedDB persistence | Persist models in `imagegrains-onnx-cache-v1` for `< 1s` offline reload | M1 | ORIGINAL_REQUEST §3.1 |
| F1.3 | Cache inspection & quota | `getCachedModels()`, `clearModelCache()`, `navigator.storage.estimate()` | M1 | ORIGINAL_REQUEST §3.1 |
| F2.1 | Client-side CLAHE | Pure TypedArray CLAHE on luminance `L` channel | M2 | ORIGINAL_REQUEST §3.2 |
| F2.2 | Adaptive input scaling | `ScaleMode: 'auto' \| '1.0x' \| '0.5x' \| '0.25x'` (`auto` downscales `>1024 px`), tracks `effectiveScaleFactor` | M2 | ORIGINAL_REQUEST §3.2 |
| F2.3 | Complexity Router | `< 5 ms` `256×256` feature extractor (Sobel entropy, multi-scale contrast variance, shadow/glare range) + WebGPU/memory probe -> `unet \| cpsam`, confidence, rationale | M2 | ORIGINAL_REQUEST §3.2 |
| F2.4 | Percentile normalizers | `normalizeGray` & `normalizeRgbJoint99` (`(x - p1) / (p99 - p1 + 1e-8)`) | M2 | infer_unet.py / infer_cpsam.py |
| F3.1 | ORT session manager | `onnxruntime-web` `webgpu` primary with `wasm` SIMD fallback, local `dist/ort/` WASM paths | M2 | ORIGINAL_REQUEST §3.3 |
| F3.2 | U-Net inference | `[1, 2, H_pad, W_pad]` `float32`, 16-px reflection pad, ch1=0, crop `[3, H, W]` | M2 | infer_unet.py |
| F3.3 | CP-SAM tiled inference | `256×256` tiles, `64 px` overlap (`192` stride), reflect-pad if `<256`, Hanning taper, IEEE-754 `Float16` utils, progress + `AbortSignal` | M2 | infer_cpsam.py |
| F4.1 | Flow integration & seeds | Two-phase Euler (`100` coarse + `150` `1.0 px`), sink hist, 2-pass `3×3` dilation, 8-BFS, `2 px` snap | M3 | eval_core.py / worker.ts |
| F4.2 | Multigrid Jacobi PDE | 9-point Jacobi with `8× -> 4× -> 2× -> 1×` (`maxDim >= 192` `8×` level) and bounded `nFine` | M3 | eval_core.py |
| F4.3 | F5 QC & F3 Split | `F5_MagWeightedQC` (`w = min(1, \|\|dP\|\|/1.5)`, `dist2 <= 2` exclusion) + `F3_SplitOnFailure` | M3 | eval_core.py / worker.ts |
| F4.4 | v4.1 Upper-Area Guard | `maxGrainAreaFraction = 0.15` guard before split & acceptance (`3ca10b7c` fix) | M3 | ORIGINAL_REQUEST §3.4 |
| F4.5 | Moments & border flag | `touchesBorder` (`margin=2`), `areaPx`, `aAxisPx`, `bAxisPx`, `dEqPx`, `centroidX`, `centroidY`, `orientationRad` | M3 | eval_core.py / ORIGINAL_REQUEST §3.4 |
| F4.6 | Web Worker wrapper | Zero-copy Transferable `ArrayBuffer` worker (`grainPostprocess.worker.ts`) | M3 | ORIGINAL_REQUEST §3.4 |
| F5.1 | Interactive split | `splitGrainAtLine` polyline rasterization, 8-BFS partition, `minSize` check, local moment recompute | M4 | ORIGINAL_REQUEST §3.5 |
| F5.2 | Interactive merge | `mergeGrains` with 1-pass closing in combined bbox, local moment recompute | M4 | ORIGINAL_REQUEST §3.5 |
| F5.3 | Delete, add & Undo/Redo | `deleteGrain`, `addPolygonGrain`, bbox `Int32Array` diff `Undo/Redo` (`< 1 ms`) | M4 | ORIGINAL_REQUEST §3.5 |
| F5.4 | Scale calibrator | `ScaleCalibrator`: 2-point click + physical length (`mm`/`cm`) -> `mmPerPx`, scales mm metrics | M4 | ORIGINAL_REQUEST §3.5 |
| F6.1 | Border filter & PSD | Toggleable `touchesBorder` filter, area/number-weighted PSD (`D5..D95`) matching `eval_core.py` to `1e-6` | M4 | eval_core.py / ORIGINAL_REQUEST §3.6 |
| F6.2 | Folk & Ward + Wentworth | $\phi = -\log_2(D_{\text{mm}})$: $M_z, \sigma_I, Sk_I, K_G$ + % Sand/Gravel/Cobble/Boulder | M4 | ORIGINAL_REQUEST §3.6 |
| F6.3 | Client-side Blob exports | Per-grain CSV, Summary JSON/CSV, 16/32-bit PNG mask, GeoJSON & SVG Marching Squares contours | M4 | ORIGINAL_REQUEST §3.6 |
| F7.1 | Pipeline controller | `ImageGrainsEngine` (`initialize`, `analyzeImage`) & reactive `AnalysisSession` + `src/index.ts` | M5 | ORIGINAL_REQUEST §3.7 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Scaffold, Shared Types & Model Cache | `.gitignore`, `package.json`, `tsconfig.json` (`strict: true`), `esbuild.config.mjs`, `src/types/index.ts`, `src/modules/modelCache.ts`, `tests/modelCache.test.ts` | none | DONE (`14/14` tests, `dist/ort/` 26 files) |
| M2 | Preprocessing & ONNX Inference | `src/modules/imagePreprocess.ts`, `src/modules/onnxInference.ts`, `tests/imagePreprocess.test.ts`, `tests/onnxInference.test.ts` | M1 | DONE (`31/31` tests, 65536 FP16 exact) |
| M3 | Post-Processing Worker v4.1 | `src/modules/postprocessCore.ts`, `src/workers/grainPostprocess.worker.ts`, `tests/postprocess.test.ts` (incl. `skimage.measure.regionprops` parity & `3ca10b7c` regression) | M1 | DONE (`14/14` tests, `3.55e-15 px` parity) |
| M4 | Interactive Editor & Sediment Stats | `src/modules/interactiveEditor.ts`, `src/modules/sedimentStats.ts`, `tests/interactiveEditor.test.ts`, `tests/sedimentStats.test.ts` (incl. `eval_core.py` `1e-6` parity) | M1 | DONE (`28/28` tests, `6.395e-13` PSD parity) |
| M5 | Pipeline Controller & Integration | `src/modules/pipelineController.ts`, `src/index.ts`, `tests/pipelineController.test.ts`, full typecheck + bundle build | M1, M2, M3, M4 | DONE (`7/7` M5, `94/94` unit tests, `npm run build` exit 0) |
| E2E | E2E Testing Track | Requirement-driven opaque-box E2E test suite (Tiers 1–4) + `TEST_INFRA.md` + `TEST_READY.md` | parallel | DONE (`95` E2E tests, `TEST_READY.md` published) |
| M6 | Final Milestone (E2E Pass + Tier 5) | Phase 1: Pass 100% E2E Tiers 1–4; Phase 2: Adversarial Tier 5 coverage hardening | M5, E2E | DONE (`12/12` files, `218/218` tests, `tsc` & `build` exit 0) |

## Interface Contracts

### `src/types/index.ts` (Owned by M1, consumed by M2–M5)
- `ModelId = 'ig2_unet_fp32' | 'ig2_cpsam_fp16'`
- `ModelKind = 'unet' | 'cpsam'`
- `ScaleMode = 'auto' | '1.0x' | '0.5x' | '0.25x'`
- `DownloadProgress`: `{ loadedBytes: number; totalBytes: number; percent: number; speedMBps: number }`
- `CachedModelInfo`: `{ modelId: ModelId; fileName: string; sizeBytes: number; cachedAt: number }`
- `StorageQuotaInfo`: `{ usageBytes: number; quotaBytes: number; availableBytes: number }`
- `WorkingImageResult`: `{ data: Uint8ClampedArray; width: number; height: number; originalWidth: number; originalHeight: number; effectiveScaleFactor: number; scaleModeApplied: Exclude<ScaleMode, 'auto'> }`
- `ModelRecommendation`: `{ model: ModelKind; confidence: number; rationale: string; metrics: { sobelEntropy: number; multiScaleContrastVar: number; shadowGlareRange: number; hasWebGPU: boolean; deviceMemoryGB: number | null; elapsedMs: number } }`
- `InferenceProgress`: `{ completedTiles: number; totalTiles: number; percent: number }`
- `InferenceOutput`: `{ flowY: Float32Array; flowX: Float32Array; cellprob: Float32Array; width: number; height: number }`
- `PostProcessOptions`: `{ niter?: number; cellprobThreshold?: number; flowThreshold?: number; minSize?: number; minSeedDensity?: number; excludeBorderMargin?: number; maxGrainAreaFraction?: number }`
- `GrainMorphometrics`: `{ id: number; areaPx: number; centroidX: number; centroidY: number; aAxisPx: number; bAxisPx: number; dEqPx: number; orientationRad: number; touchesBorder: boolean; bbox: [number, number, number, number]; areaMm2?: number; aAxisMm?: number; bAxisMm?: number; dEqMm?: number }`
- `PostProcessResult`: `{ masks: Int32Array; width: number; height: number; grains: GrainMorphometrics[]; grainCount: number }`
- `WorkerRequest` / `WorkerResponse`: Transferable `ArrayBuffer` message types for `grainPostprocess.worker.ts`.
- `Point2D`: `{ x: number; y: number }`
- `CalibrationResult`: `{ mmPerPx: number; pointA: Point2D; pointB: Point2D; physicalLengthMm: number; pixelDistance: number }`
- `PsdPercentiles`: `{ D5: number; D10: number; D16: number; D25: number; D50: number; D75: number; D84: number; D90: number; D95: number }`
- `FolkWardStats`: `{ meanPhi: number; sortingPhi: number; skewnessPhi: number; kurtosisPhi: number; meanMm: number; sortingLabel: string; skewnessLabel: string; kurtosisLabel: string }`
- `WentworthProportions`: `{ sandPct: number; gravelPct: number; cobblePct: number; boulderPct: number }`
- `SedimentStatsReport`: `{ totalGrains: number; includedGrains: number; excludedBorderGrains: number; unit: 'px' | 'mm'; areaWeightedB: PsdPercentiles; numberWeightedB: PsdPercentiles; areaWeightedDEq: PsdPercentiles; numberWeightedDEq: PsdPercentiles; folkWard: FolkWardStats | null; wentworth: WentworthProportions | null }`
- `AnalysisConfig`: `{ model?: ModelKind | 'auto'; scaleMode?: ScaleMode; applyClahe?: boolean; claheClipLimit?: number; excludeBorder?: boolean; postProcess?: PostProcessOptions; calibration?: CalibrationResult; signal?: AbortSignal; onProgress?: (stage: string, detail?: unknown) => void }`
