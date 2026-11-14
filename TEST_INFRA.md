# Test Infrastructure & E2E Architecture — ImageGrains 2.0 Web

## 1. Opaque-Box E2E Test Architecture

The E2E test suite under `tests/e2e/` validates **ImageGrains 2.0 Web** from the outside in against the requirements in `PROJECT.md` and `ORIGINAL_REQUEST.md`:
- **Zero internal coupling**: Tests import only public APIs from `src/index.ts`, `src/modules/*.ts`, and `src/types/index.ts` (using `.js` ESM specifiers for TypeScript `NodeNext`/`Bundler` resolution).
- **No SUT mocking**: Never mock `modelCache`, `imagePreprocess`, `onnxInference`, `postprocessCore`, `interactiveEditor`, `sedimentStats`, or `pipelineController`. Only external browser/runtime boundaries are mocked:
  1. **IndexedDB** (`imagegrains-onnx-cache-v1`)
  2. **`fetch`** (`ReadableStream` chunked byte delivery from Hugging Face `inYourOwnBrowser/imagegrains-2.0-onnx`)
  3. **`navigator` probes** (`navigator.storage.estimate()`, `navigator.gpu`, `navigator.deviceMemory`)
  4. **ONNX Runtime `InferenceSession`** (deterministic synthetic `flowY`, `flowX`, `cellprob` tensor outputs for U-Net FP32 and CP-SAM FP16)
  5. **Web `Worker` / `Blob` / `ImageData`** polyfills when running in a Node.js Vitest environment.

### Vitest Configuration Assumptions
- **Runner**: `vitest` (`>= 1.x` / `2.x`) with explicit imports (`describe, it, expect, vi, beforeEach, afterEach`) from `'vitest'`.
- **Environment**: `node` (default) with lightweight browser boundary mocks installed/restored per test via `setupBrowserMocks()` / `teardownBrowserMocks()` in `tests/e2e/helpers/mocks.ts`.
- **TypeScript**: Strict mode (`"strict": true`), no `any` leaks, explicit typed arrays (`Float32Array`, `Int32Array`, `Uint8ClampedArray`, `Uint16Array`).

---

## 2. External Boundary Mocks (`tests/e2e/helpers/mocks.ts`)

| Mock Component | Purpose | Configurable Behaviors |
|---|---|---|
| `MockIDBFactory` | In-memory IndexedDB (`imagegrains-onnx-cache-v1`) | `open`, `objectStore`, `get`, `put`, `delete`, `clear`, `getAll`, simulated `QuotaExceededError`, persistent store across `setupBrowserMocks` reloads |
| `createMockFetch` | `fetch` `ReadableStream` chunked byte-stream mock for HF `.onnx` URLs | Custom `Content-Length`, chunk count/delay, mid-stream network error, HTTP 404/500, `AbortSignal` cancellation |
| `mockNavigator` | Browser capability probes | `storage.estimate()` (`usage`, `quota`), `gpu` (`requestAdapter` present/absent), `deviceMemory` (`2`, `4`, `8`, `16`, or `undefined`) |
| `createMockOnnxSession` | Deterministic synthetic ONNX `InferenceSession` | Validates input tensor shapes (`[1, 2, H_pad, W_pad]` `float32` for U-Net; `[B, 3, 256, 256]` `float16`/`uint16` for CP-SAM) and returns deterministic `flowY`, `flowX`, `cellprob` output tensors |
| `MockWorker` | In-process `Worker` shim when `globalThis.Worker` is unavailable | Executes message handler or routes `postMessage` with Transferable `ArrayBuffer` semantics |

---

## 3. Deterministic Synthetic Data & Reference Oracles (`tests/e2e/helpers/syntheticData.ts`)

### Synthetic Images
- `createUniformGravelImage(width, height, seed?)`: Uniform fine gravel texture (`RGBA` `Uint8ClampedArray`) with low multi-scale heterogeneity.
- `createCoarseBoulderImage(width, height)`: High-contrast cobbles & boulders (`> 1024 px` capable) with large clast perimeters and high Sobel entropy.
- `createHarshShadowGlareImage(width, height)`: Half deep-shadow (`L ~ 15`), half specular-glare (`L ~ 245`) gravel scene for CLAHE normalization tests.
- `createFlatImage(width, height, value)`: Uniform constant-intensity image for zero-variance / division-by-zero boundary tests.

### Analytical Flow Fields (`flowY`, `flowX`, `cellprob`)
- `createIsolatedEllipsesFlowField(width, height, ellipses[])`: Generates exact analytical radial inward flow vectors pointing to each ellipse center `(cx, cy)` with semi-axes `(rx, ry)` and `cellprob = +4.0` inside, `-4.0` outside. Enables exact verification of `areaPx`, `aAxisPx`, `bAxisPx`, `dEqPx`, `centroidX`, `centroidY`, `orientationRad`.
- `createTouchingDumbbellFlowField(width, height)`: Two overlapping disks sharing a narrow neck with weak/perturbed flow at the neck (triggers `F3_SplitOnFailure`) and two distinct convergence peaks.
- `createBorderTouchingClastFlowField(width, height, margin)`: Clast positioned within `margin = 2 px` of image border vs. interior clast at `>= 3 px` from border.
- `createGiantSandSheetOutlierFlowField(width, height, fraction)`: Single connected region covering a controllable fraction of `width * height` (e.g., `0.149` vs. `0.151` for the `3ca10b7c` regression).

### Independent Reference Oracles
- `oracleMidpointWeightedPercentiles(values, weights, percentiles)`: Exact TypeScript port of `eval_core.py`'s `np.interp(p / 100.0, (cumsum(w) - 0.5 * w) / sum(w), v)` formula for `1e-6` numerical parity verification.
- `oracleFolkAndWardPhi(d5, d16, d25, d50, d75, d84, d95)`: Independent Folk & Ward (1957) $\phi = -\log_2(D_{\text{mm}})$ calculator for $M_z$, $\sigma_I$, $Sk_I$, $K_G$.

---

## 4. 4-Tier E2E Test Matrix (24 Features: `F1.1`–`F7.1`)

| Feature ID | Feature | Tier 1 (Feature) | Tier 2 (Boundaries) | Tier 3 (Combinations) | Tier 4 (Scenarios) |
|---|---|---|---|---|---|
| **F1.1** | Model streaming download | `tier1` (Model Cache) | `tier2` (Abort, HTTP error, 0-byte) | `tier3` (Cache + Engine) | S1, S5 |
| **F1.2** | IndexedDB persistence | `tier1` (Model Cache) | `tier2` (Corrupt/missing entry) | `tier3` (Offline hit + Engine) | S5 |
| **F1.3** | Cache inspection & quota | `tier1` (Model Cache) | `tier2` (Quota exceeded) | `tier3` (Cache + Engine) | S5 |
| **F2.1** | Client-side CLAHE | `tier1` (Preprocess) | `tier2` (Flat/1x1 image) | `tier3` (CLAHE + Router + Scale) | S2 |
| **F2.2** | Adaptive input scaling | `tier1` (Preprocess) | `tier2` (`1024 px` boundary, `0.25x`) | `tier3` (Scale + Moments + Calibrator) | S2 |
| **F2.3** | Complexity Router | `tier1` (Preprocess) | `tier2` (No WebGPU, low RAM, `<5 ms`) | `tier3` (CLAHE + Router) | S1, S2 |
| **F2.4** | Percentile normalizers | `tier1` (Preprocess) | `tier2` (Flat image `p99==p1`, NaN) | `tier3` (Preprocess + Inference) | S1, S2 |
| **F3.1** | ORT session manager | `tier1` (ONNX Inference) | `tier2` (WebGPU fallback to WASM) | `tier3` (Router + Session) | S1, S2 |
| **F3.2** | U-Net inference | `tier1` (ONNX Inference) | `tier2` (Non-mult-16 dims, `<16 px`) | `tier3` (U-Net + PostProcess) | S1 |
| **F3.3** | CP-SAM tiled inference | `tier1` (ONNX Inference) | `tier2` (`<256 px` pad, `AbortSignal`, FP16) | `tier3` (CP-SAM + Hanning + PostProcess) | S2 |
| **F4.1** | Flow integration & seeds | `tier1` (Post-Process) | `tier2` (Empty/0-grain mask) | `tier3` (Inference + PostProcess) | S1, S2, S3 |
| **F4.2** | Multigrid Jacobi PDE | `tier1` (Post-Process) | `tier2` (`maxDim < 192` vs `>= 192`) | `tier3` (Tiled + Multigrid) | S2 |
| **F4.3** | F5 QC & F3 Split | `tier1` (Post-Process) | `tier2` (Low flow / noise rejection) | `tier3` (F3 Split + Stats) | S3 |
| **F4.4** | v4.1 Upper-Area Guard | `tier1` (Post-Process) | `tier2` (`14.9%` vs `15.1%` `3ca10b7c`) | `tier3` (Guard + Dumbbell Split) | S3 |
| **F4.5** | Moments & border flag | `tier1` (Post-Process) | `tier2` (`margin=2` exact boundary) | `tier3` (Scale + Moments) | S1, S2, S5 |
| **F4.6** | Web Worker wrapper | `tier1` (Post-Process) | `tier2` (Zero-copy buffer transfer) | `tier3` (Engine + Worker) | S1, S2 |
| **F5.1** | Interactive split | `tier1` (Editor) | `tier2` (Split below `minSize`, miss) | `tier3` (Split + Undo + Stats) | S4 |
| **F5.2** | Interactive merge | `tier1` (Editor) | `tier2` (Single/invalid ID merge) | `tier3` (Merge + Stats) | S4 |
| **F5.3** | Delete, add & Undo/Redo | `tier1` (Editor) | `tier2` (Empty stack, `< 1 ms` latency) | `tier3` (Edit + Undo/Redo + Stats) | S4 |
| **F5.4** | Scale calibrator | `tier1` (Editor) | `tier2` (Zero/negative length, coincident pts) | `tier3` (Scale + Calibrator + Stats) | S2, S4 |
| **F6.1** | Border filter & PSD | `tier1` (Stats & Exports) | `tier2` (0 included grains, 1 grain) | `tier3` (Border toggle + PSD) | S1, S5 |
| **F6.2** | Folk & Ward + Wentworth | `tier1` (Stats & Exports) | `tier2` (Unclamped / uncalibrated `px`) | `tier3` (Edit + Folk-Ward) | S1, S2, S4 |
| **F6.3** | Client-side Blob exports | `tier1` (Stats & Exports) | `tier2` (Empty grain export validity) | `tier3` (Border toggle + GeoJSON/SVG) | S4 |
| **F7.1** | Pipeline controller | `tier1` (Controller) | `tier2` (Pre-aborted `AbortSignal`) | `tier3` (Engine + Session + Exports) | S1–S5 |
