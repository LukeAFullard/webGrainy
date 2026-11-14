# Architectural Plan: `webGrainy` (ImageGrains 2.0 Web) — Phases 2, 3 & 4

**Status:** Approved Architecture Specification  
**Baseline:** `webGrainy` TypeScript core engine (7 modules, 1 Web Worker, `src/index.ts`, 12 Vitest suites / 218 passing tests, `tsc --noEmit` 0 errors, `esbuild` -> `dist/`).

---

## 1. Executive Summary & Non-Negotiable Guardrails

`webGrainy` (ImageGrains 2.0 Web) is a **100% browser-native, privacy-first, offline-first gravel and sediment grain-sizing application** built on top of the existing TypeScript ONNX/WebGPU/WASM core engine. Phases 2–4 extend the single-image core into a multi-image fluvial geomorphology & photo-sieving workstation with:
- **Phase 2:** Four framework-agnostic TypeScript modules (`roiAndRectify.ts`, `morphometricsExt.ts`, `siteAnalysis.ts`, `projectStorage.ts`) implementing ROI/exclusion masking, 4-point planar homography rectification, 2D shape & axial fabric morphometrics, 5-mode multi-image site pooling with Kellerhals & Bray (1971) equivalency labeling, deterministic cluster bootstrapping, Eaton et al. (2019) binomial CIs, jackknife sensitivity, convergence diagnostics, IndexedDB persistence (`imagegrains-projects-v1`), and memory-safe sequential batch execution.
- **Phase 3:** A modular, zero-dependency browser UI (`src/index.html`, `src/sw.js`, `src/ui/*`) bundled by `esbuild.config.mjs` into a self-contained `dist/` static app.
- **Phase 4:** Comprehensive Vitest unit/integration tests, strict `typecheck`/`build`/`test` gates, and headless Chromium CDP offline verification.

### Non-Negotiable Guardrails
1. **Zero Server-Side Processing:** User photos, segmentation masks, calibrations, exclusion regions, and statistics never leave the browser. Only optional ONNX model weights (`ig2_unet_fp32.onnx`, `ig2_cpsam_fp16.onnx`) are downloaded client-side from Hugging Face via `modelCache.ts` into IndexedDB (`imagegrains-onnx-cache-v1`).
2. **Zero External CDN Dependencies:** No external `<script>`, `<link>`, Google Fonts, or hosted charting libraries at runtime. Use system font stacks (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; monospace `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`), zero-dependency SVG/Canvas2D charts, and local `dist/ort/` ONNX Runtime Web binaries.
3. **Unofficial Attribution & Citations (`README.md:7, 114–140`):** Preserve the explicit disclaimer that `webGrainy` is an **independent, unofficial** browser implementation using independently converted ONNX weights (`inYourOwnBrowser/imagegrains-2.0-onnx`), not affiliated with `dmair1989/imagegrains` or Cellpose authors. Display this notice and full bibliographic citations (Mair et al. 2026, 2023/2024, 2022; Pachitariu et al. 2025; Stringer et al. 2021; Eaton et al. 2019; Wolman 1954; Kellerhals & Bray 1971; Bunte & Abt 2001; Graham et al. 2005a,b, 2010; Detert & Weitbrecht 2012; Purinton & Bookhagen 2019; Sylvester et al. 2025; Folk & Ward 1957; Wentworth 1922; Blair & McPherson 1999; Curray 1956; Mardia & Jupp 2000) in the About & Citations modal and exported report metadata.
4. **Backward Compatibility & Strict Quality:** All existing `src/index.ts` exports (lines 1–92) and all 218 existing tests (12 test files) must remain green. All new code must satisfy `tsconfig.json` (`"strict": true`, `"noUncheckedIndexedAccess": true`, `"verbatimModuleSyntax": true`) and explicit `.js` ESM import specifiers.

---

## 2. Codebase Baseline & Integration Contracts

### 2.1 `AnalysisSession` Working-vs-Original Scale Factor
In `src/modules/pipelineController.ts`:
- `AnalysisSession.getResult()` returns `masks: Int32Array` at **working resolution** (`workingImage.width × workingImage.height`), while `grains: GrainMorphometrics[]` are rescaled to **original image resolution** (`originalWidth × originalHeight`) by `1 / effectiveScaleFactor` (linear) and `1 / effectiveScaleFactor^2` (area).
- **Contract for Phase 2 & 3:**
  - Any function indexing `masks` from original-image coordinates `(x_orig, y_orig)` (Canvas hit-testing, exclusion mask intersection, Virtual Grid-by-Number sampling, contour/perimeter/convex-hull extraction) **MUST** multiply coordinates by `s_work = workingImage.effectiveScaleFactor` (`Math.round(x_orig * s_work)` clamped to `[0, workingWidth - 1]`).
  - Any pixel-space measurement computed on `masks` (e.g., Crofton perimeter, convex hull area) **MUST** be rescaled by `1 / s_work` (length) or `1 / (s_work * s_work)` (area) before attaching to original-resolution `GrainMorphometrics` or computing `mm` / `mm²` quantities.

### 2.2 `workerFactory` & `wasmPaths: './ort/'`
- `ImageGrainsEngine.getOrCreateWorker()` defaults to `new URL('../workers/grainPostprocess.worker.js', import.meta.url)`.
- When the UI bundles `src/ui/main.ts` -> `dist/ui/main.js`, `../workers/grainPostprocess.worker.js` happens to resolve to `dist/workers/grainPostprocess.worker.js`, **but** to guarantee path stability regardless of code-splitting chunk locations, the UI **MUST** instantiate `ImageGrainsEngine` with explicit options:
  ```ts
  const engine = new ImageGrainsEngine({
    useWorker: true,
    workerFactory: () => new Worker('./workers/grainPostprocess.worker.js', { type: 'module' }),
    sessionCreateOptions: { wasmPaths: './ort/' },
  });
  ```
  (Note: `ImageGrainsEngineOptions` in `src/modules/pipelineController.ts` uses `workerFactory` and `sessionCreateOptions`, not `workerUrl`.)

### 2.3 `AnalysisSession` Serialization, Hydration & Getters
Currently, `calibration`, `excludeBorder`, and `borderMargin` are `private` on `AnalysisSession`, and there is no serialization/hydration API. To allow `projectStorage.ts` and `siteAnalysis.ts` to persist, restore, and inspect `AnalysisSession` without re-running ONNX inference, add backward-compatible methods to `AnalysisSession` (in `src/modules/pipelineController.ts`):
- **Read-only getters:**
  - `getCalibration(): CalibrationResult | undefined`
  - `getExcludeBorder(): boolean`
  - `getBorderMargin(): number`
- **Serialization & Hydration:**
  ```ts
  export interface SerializedAnalysisSession {
    version: 1;
    workingMasks: Int32Array;
    workingImage: WorkingImageResult;
    recommendation: ModelRecommendation;
    calibration?: CalibrationResult;
    excludeBorder: boolean;
    borderMargin: number;
  }
  ```
  - `toSerialized(): SerializedAnalysisSession` — returns a snapshot with a cloned `workingMasks` buffer and current config.
  - `static fromSerialized(data: SerializedAnalysisSession): AnalysisSession` — reconstructs an `AnalysisSession` by recomputing `workingGrains` via `computeAllGrainMorphometrics(workingMasks, width, height, borderMargin)` and running `recomputeDerivedState()`, with a fresh `MaskEditHistory`.

### 2.4 `src/index.ts` Exports
- Preserve all existing re-exports in `src/index.ts` (lines 1–92) untouched.
- Append re-exports for all public types, constants, classes, and functions from:
  - `./modules/roiAndRectify.js`
  - `./modules/morphometricsExt.js`
  - `./modules/siteAnalysis.js`
  - `./modules/projectStorage.js`

---

## 3. Phase 2: New Core Modules & Exact Scientific Specifications

### 3.1 `src/modules/roiAndRectify.ts`
**Purpose:** Non-destructive ROI/exclusion masking, clast packing / exposed matrix metrics, and offline 4-point planar homography perspective rectification.

#### A. ROI & Exclusion Regions
- **Types:**
  ```ts
  export interface ExclusionBrushStroke {
    points: Point2D[];      // original image coordinates
    radiusPx: number;       // stroke radius in original image pixels
  }
  export interface RoiExclusionConfig {
    roiPolygon?: Point2D[];                // optional analysis ROI (default: full image)
    exclusionPolygons: Point2D[][];        // rulers, coins, boots, vegetation, shadows, sand patches
    exclusionStrokes: ExclusionBrushStroke[];
    maxOverlapFraction?: number;           // default 0.10 (10%); 0.0 for strict exclusion
    unresolvedSandFractionPct?: number;    // optional user-recorded unresolved fines %
  }
  export interface ValidBedMask {
    width: number;          // working-resolution width
    height: number;         // working-resolution height
    valid: Uint8Array;      // 1 = valid bed pixel (inside ROI && outside exclusions), 0 = excluded
    validPixelCount: number;
  }
  export interface ExclusionFilterResult {
    includedGrains: GrainMorphometrics[];
    excludedGrainIds: Set<number>;
    validBedMask: ValidBedMask;
    sampledBedAreaPx: number;       // original-image px²
    sampledBedAreaMm2?: number;     // if calibrated
    clastPackingPct: number;        // 100 * sum(valid grain areas, incl. border grains in V_j) / sampledBedArea
    exposedMatrixPct: number;       // 100 - clastPackingPct
  }
  ```
- **Rasterization & Non-Destructive Filtering:**
  - `buildValidBedMask(workingWidth, workingHeight, effectiveScaleFactor, config): ValidBedMask`:
    - Scales `roiPolygon`, `exclusionPolygons`, and `exclusionStrokes` by `effectiveScaleFactor`.
    - Scanline-fills `roiPolygon` (or initializes all `1` if omitted), then zeroes pixels inside `exclusionPolygons` and within `radiusPx * effectiveScaleFactor` of any segment in `exclusionStrokes`.
  - `applyRoiAndExclusions(masks, grains, workingImage, config, calibration?): ExclusionFilterResult`:
    - **Never mutates `masks`**.
    - For each grain `i`, checks centroid `(round(centroidX * s), round(centroidY * s))` against `validBedMask.valid`. If centroid is outside `V_j`, exclude.
    - Otherwise scans grain's working-resolution bounding box in `masks` to compute `f_excl = |G_i \ V_j| / |G_i|`. Exclude if `f_excl > maxOverlapFraction` (default `0.10`).
    - Computes `sampledBedAreaPx = validPixelCount / (s * s)`, `sampledBedAreaMm2 = sampledBedAreaPx * mmPerPx^2`.
    - **Clast Packing %:** Sum `areaPx` of **all** grains inside `V_j` (including border-touching grains inside `V_j` so bed cover is not underestimated) divided by `sampledBedAreaPx * 100`; `exposedMatrixPct = Math.max(0, 100 - clastPackingPct)`.

#### B. 4-Point Planar Homography Rectification (Pure `TypedArray`)
- **Types:**
  ```ts
  export interface HomographyInput {
    srcCorners: [Point2D, Point2D, Point2D, Point2D]; // TL, TR, BR, BL in source image px
    physicalWidthMm: number;
    physicalHeightMm: number;
    targetMmPerPx?: number;     // default derived from mean edge pixel length
    paddingPx?: number;         // optional margin around reference quad (default 0)
    maxOutputDimPx?: number;    // safety cap (default 4096) to prevent browser OOM
  }
  export interface HomographyResult {
    homography: Float64Array;      // 3x3 row-major (H)
    invHomography: Float64Array;   // 3x3 row-major (H^-1)
    rectifiedImage: ImageBufferLike;
    mmPerPx: number;
    roiRectInOutput: [number, number, number, number]; // [x, y, w, h] of reference quad
  }
  ```
- **Algorithm:**
  - `solveHomography(srcCorners, dstCorners): Float64Array`:
    - Builds the $8 \times 8$ DLT linear system $\mathbf{A}\mathbf{h} = \mathbf{b}$ ($h_{33} = 1$) for the 4 point correspondences.
    - Solves via Gaussian elimination with partial pivoting in `Float64Array`. Throws a descriptive `Error` if $|\text{pivot}| < 10^{-10}$ (collinear/degenerate quad).
  - `invert3x3(m: Float64Array): Float64Array`: exact $3\times 3$ adjugate / determinant inverse.
  - `rectifyPerspective(image: ImageBufferLike, input: HomographyInput): HomographyResult`:
    - Computes `targetMmPerPx` if omitted from average edge length of `srcCorners`.
    - Computes output dimensions `W_px`, `H_px` (including `paddingPx`, clamped to `maxOutputDimPx`).
    - Inverse-warps each output pixel $(x', y')$ via $\mathbf{H}^{-1}$ to $(u, v)$ in source image, sampling RGBA via **bilinear interpolation** (or `[0, 0, 0, 0]` outside `[0, W_src - 1] × [0, H_src - 1]`).
    - Returns rectified `ImageBufferLike` with exact uniform `mmPerPx`.

---

### 3.2 `src/modules/morphometricsExt.ts`
**Purpose:** Extended 2D shape descriptors, double-angle axial fabric statistics, and $0.5\phi / 1.0\phi$ Wentworth histograms without breaking `GrainMorphometrics` compatibility.

- **Types:**
  ```ts
  export interface ExtendedGrainMorphometrics extends GrainMorphometrics {
    perimeterPx: number;
    perimeterMm?: number;
    circularity: number;         // min(1.0, 4 * pi * A / P^2)
    aspectRatio: number;         // b / a in (0, 1]
    elongation: number;          // 1 - b / a in [0, 1)
    convexAreaPx: number;
    convexAreaMm2?: number;
    solidity: number;            // min(1.0, A / A_convex)
    sphericity2D: number;        // d_eq / a = sqrt(4 * A / (pi * a^2)) — 2D apparent projection proxy
  }
  export interface FabricRoseBin {
    binIndex: number;
    startDeg: number;            // [0, 180)
    endDeg: number;
    count: number;
    weightSum: number;
    proportionPct: number;
  }
  export interface FabricRoseStats {
    grainCount: number;
    weighted: boolean;
    meanAxialRad: number;        // [-pi/2, pi/2]
    meanAxialDeg: number;        // [0, 180)
    resultantLengthR: number;    // [0, 1]
    circularVariance: number;    // 1 - R
    rayleighZ: number;           // n * R^2
    rayleighP: number | null;    // exp(-Z) when n >= 10, else null
    bins: FabricRoseBin[];       // K sectors over [0, 180)
  }
  export interface WentworthBin {
    phiMin: number;
    phiMax: number;
    mmMin: number;
    mmMax: number;
    label: string;               // e.g., "Coarse Gravel (-4φ to -5φ)"
    wentworthClass: string;
    grainCount: number;
    weightPct: number;
  }
  ```
- **Exact Algorithms:**
  1. **Crofton 4-Neighborhood Perimeter (`computeCroftonPerimeter`):** Scans $2 \times 2$ pixel neighborhoods inside each grain's 1-px padded working-resolution bounding box, matching `skimage.measure.perimeter` (4-connectivity Crofton intercept estimator), then rescales by `1 / effectiveScaleFactor`.
  2. **Andrew's Monotone Chain Convex Hull (`computeConvexHull`):** Extracts boundary pixels of grain `id` (at working resolution), sorts lexicographically by `(x, y)` ($O(k \log k)$), builds lower & upper hulls, computes polygon area via Shoelace formula + `0.5 * hullPerimeter` pixel-center correction so $A_{\text{convex}} \ge A_{\text{px}}$, rescales by `1 / s_work^2`, and computes `solidity = Math.min(1, areaPx / convexAreaPx)`.
  3. **Circularity, Aspect Ratio, Elongation, 2D Sphericity Proxy:** Computed directly from `areaPx`, `perimeterPx`, `aAxisPx`, `bAxisPx`, `dEqPx` (clamped to `(0, 1]`).
  4. **Double-Angle Axial Fabric (`computeFabricRoseStats`):** Uses `orientationRad` ($\theta_i \in [-\pi/2, \pi/2]$ from vertical $y$-axis):
     - $C = \frac{1}{W}\sum w_i \cos(2\theta_i)$, $S = \frac{1}{W}\sum w_i \sin(2\theta_i)$
     - $\bar{\theta} = \frac{1}{2}\operatorname{atan2}(S, C)$, $R = \sqrt{C^2 + S^2}$, $V = 1 - R$, $Z = n R^2$, $p = \exp(-Z)$ ($n \ge 10$).
     - Bins mapped to $[0^\circ, 180^\circ)$ into $K$ sectors (default $K = 12$ for $15^\circ$ sectors, configurable e.g. $18$ for $10^\circ$).
  5. **Wentworth Histograms (`computeWentworthHistogram`):** Supports `stepPhi: 0.5 | 1.0` over `[-12, +4]` $\phi$ (auto-trimmed to occupied range $\pm 1$ bin), using Blair & McPherson (1999) / Wentworth (1922) grade boundaries.

---

### 3.3 `src/modules/siteAnalysis.ts`
**Purpose:** Multi-image site pooling, Kellerhals & Bray (1971) labeling, calibration & truncation harmonization, deterministic cluster bootstrap, Eaton et al. (2019) binomial order-statistic CIs, jackknife sensitivity, convergence/adequacy diagnostics, and multi-image exports.

- **Key Types:**
  ```ts
  export type PoolingMode =
    | 'physical-area'       // w_ij = A_ij (mm²) — Composite Bed Patch
    | 'equal-photo'         // w_ij = A_ij / sum_k(A_kj) — Normalized per Image
    | 'virtual-wolman-grid' // w_ij = grid hit count c_ij — Digital Wolman Count
    | 'number-weighted'     // w_ij = 1 — Area-by-Number Frequency
    | 'facies-weighted';    // w_ij = W_j_norm * A_ij / sum_k(A_kj)

  export interface SitePhotoEntry {
    photoId: string;
    label: string;
    included: boolean;
    session: AnalysisSession;
    roiConfig?: RoiExclusionConfig;
    faciesWeight?: number;          // used in 'facies-weighted' mode
    metadata?: { timestamp?: string; gps?: { lat: number; lon: number }; notes?: string };
  }

  export interface SiteAnalysisOptions {
    poolingMode: PoolingMode;
    sizeMetric?: 'bAxis' | 'dEq';           // default 'bAxis'
    minBaxisPx?: number;                    // default 15 (0 to disable)
    harmonizePhysicalCutoff?: boolean;      // default true when calibrated
    wolmanGridSpacingMm?: number;           // Mode A: regular physical grid
    wolmanPointsPerPhoto?: number;          // Mode B: fixed K points per photo (default 100)
    bootstrapReplicates?: number;           // default 1000 (200..2000)
    bootstrapSeed?: number;                 // default 42
    bootstrapTwoStage?: boolean;            // default false
    confidenceLevel?: 0.90 | 0.95;          // default 0.95
  }
  ```
- **Core Capabilities:**
  1. **Calibration Validation (`validateSiteCalibration`):**
     - Checks all included photos. If mixed (some have `mmPerPx > 0`, some do not), returns `{ valid: false, unit: 'mixed', uncalibratedPhotoIds, message }` and blocks physical `mm` pooling until resolved (or user switches to pixel/normalized mode with explicit warning).
  2. **Truncation Harmonization:**
     - Per-photo pixel cutoff: exclude grains with $b_{ij,\text{px}} < \text{minBaxisPx}$.
     - When `harmonizePhysicalCutoff === true` and calibrated: compute $d_{\text{cutoff, common}} = \max_j (\text{minBaxisPx} \cdot s_j)$ and exclude grains with $b_{ij,\text{mm}} < d_{\text{cutoff, common}}$. Report `dCutoffCommonMm`, `excludedTruncationCount`, and `excludedTruncationAreaMm2`.
  3. **5 Pooling Modes & Kellerhals & Bray (1971) Labeling:**
     - Exact weighting formulas per Section 1.2 of the domain specification.
     - Virtual Wolman Grid-by-Number samples deterministic grid nodes inside each photo's valid bed mask $V_j$ (reading `masks[round(y * s_work) * W_work + round(x * s_work)]`), tracking `gridGrainHits`, `gridMatrixHits`, and `gridSubCutoffHits`.
     - Every `SiteAnalysisReport` includes `statisticalBasisLabel` (e.g., `'Area-Weighted (Grid-by-Number / Sieve-Equivalent, Kellerhals & Bray 1971)'` vs. `'Number-Weighted (Area-by-Number Frequency — NOT Sieve-Equivalent)'`) and never silently modifies raw grain axes.
  4. **Deterministic Cluster Bootstrap (`mulberry32`):**
     - Seeded Mulberry32 PRNG (`seed = 42` default).
     - For $N \ge 2$: resamples $N$ photos with replacement (`B = 1000` replicates), optionally resampling grains within each sampled photo (`twoStage`), computing percentile CIs (`D5`..`D95` + Folk & Ward).
     - For $N = 1$: automatically falls back to within-photo grain-level bootstrap with `bootstrapMode: 'single-photo-grain-fallback'` and explicit warning.
  5. **Eaton et al. (2019) Binomial Order-Statistic CI:**
     - Uses exact discrete count $n$ for `number-weighted` / `virtual-wolman-grid` and Kish's effective sample size $n_{\text{eff}} = (\sum w_i)^2 / \sum w_i^2$ (explicitly labeled) for area-weighted modes.
     - Evaluates exact Binomial CDF (log-space summation for $n \le 5000$, normal approximation fallback for $n > 5000$) and maps $(l_e, u_e)$ to grain sizes in $\log_2(d)$ space.
  6. **Leave-One-Photo-Out (Jackknife) Sensitivity:**
     - For $N \ge 2$, computes $D_p^{(-j)}$, $\Delta D_p^{(-j)}$, $\delta_p^{(-j)}(\%)$, jackknife SE, and flags high-influence photos ($|\delta_p^{(-j)}| > 10\%$).
  7. **Cumulative Convergence Curve ($1 \dots N$) & Sample Adequacy:**
     - Computes running $D_{16}(k), D_{50}(k), D_{84}(k)$ and 95% CI width for $k = 1 \dots N$.
     - Adequacy rating: `Insufficient` ($<100$), `Minimal` ($100\text{–}199$), `Adequate` ($200\text{–}399$), `High Precision` ($\ge 400$).
     - Largest-clast-area ratio $r_{\max}$ warning (`> 5%` moderate, `> 10%` critical) and per-photo outlier flags ($|\log_2(D_{50,j}/D_{50}^{(-j)})| > 1.0\phi$, $N_j < 15$, or scale $s_j > 3\times$ site median).
  8. **Site Exports:**
     - `exportSiteSummaryCsv(report): Blob` & `exportSiteSummaryJson(report): Blob` (includes full bibliographic citations, pooling mode, statistical basis label, CI bounds, Folk & Ward, Wentworth, convergence, jackknife).
     - `exportSiteGrainsCsv(entries, report): Blob` (combined per-grain CSV with `photo_id`, `photo_name`, `mm_per_px`, morphometrics, and extended shape metrics).

---

### 3.4 `src/modules/projectStorage.ts`
**Purpose:** Offline IndexedDB project persistence (`imagegrains-projects-v1`), portable `.webgrainy.json` archive import/export, and memory-safe sequential batch runner.

#### A. IndexedDB Project Store (`imagegrains-projects-v1`)
- Separate DB from `imagegrains-onnx-cache-v1` so clearing ONNX model weights never deletes user fieldwork.
- **Object Stores (`DB_VERSION = 1`):**
  1. `sites` (`keyPath: 'siteId'`): `{ siteId, name, createdAt, updatedAt, options: SiteAnalysisOptions, photoOrder: string[] }`
  2. `photos` (`keyPath: 'photoId'`, index `'siteId'`): `{ photoId, siteId, label, imageBlob: Blob, width, height, addedAt, included, faciesWeight, calibration?, homography?, roiConfig?, analysisConfig?, metadata? }`
  3. `results` (`keyPath: 'photoId'`): `{ photoId, status: 'pending' | 'running' | 'done' | 'error', errorMessage?, serializedSession?: SerializedAnalysisSession, updatedAt }`
- **Portable Archive (`.webgrainy.json`):**
  - `exportSiteArchive(siteId): Promise<Blob>` — serializes site, photos (image `Blob`s base64-encoded), and `SerializedAnalysisSession`s (masks RLE/base64-encoded) into a self-contained JSON archive.
  - `importSiteArchive(blob: Blob): Promise<string>` — validates schema version and restores into IndexedDB with fresh or preserved IDs.

#### B. Memory-Safe Sequential Batch Runner (`runSiteBatch`)
- Processes pending photos strictly 1-at-a-time (`for (const photo of pending)`), reusing the single `ImageGrainsEngine` instance (keeping the ONNX `InferenceSession` and Web Worker alive).
- Checks `signal?.aborted` before and after each stage.
- Decodes `photo.imageBlob` via `createImageBitmap(blob)` inside the loop, runs `engine.analyzeImage(bitmap, config)`, immediately calls `bitmap.close()` in a `finally` block, persists `session.toSerialized()` to `results` store, and invokes `onPhotoComplete` / `onProgress` callbacks so raw pixel buffers are garbage-collected between photos.

---

## 4. Phase 3: Privacy-First Browser Application UI

### 4.1 Directory Structure
- `src/index.html` — Semantic HTML5 shell, zero external `<script>`/`<link>` tags, loads `./ui/styles.css` and `./ui/main.js` (`type="module"`).
- `src/sw.js` — Progressive-enhancement Service Worker (`location.protocol !== 'file:'`) using cache-first for same-origin app assets (`./`, `./index.html`, `./ui/main.js`, `./ui/styles.css`, `./workers/grainPostprocess.worker.js`, `./ort/*`) and network pass-through for Hugging Face `.onnx` downloads (already cached in `imagegrains-onnx-cache-v1`).
- `src/ui/styles.css` — Dark/light field-friendly high-contrast scientific theme using system font stacks and CSS Grid/Flexbox.
- `src/ui/state.ts` — Reactive store (`AppStore` with `subscribe()`) managing active `siteId`, `photoId`, `AnalysisSession` map, `SiteAnalysisReport`, active tool mode, overlay toggles, selection state, and batch runner `AbortController`.
- `src/ui/exif.ts` — Lightweight, zero-dependency local JPEG EXIF parser (`DataView` over `APP1` `0xFFE1` marker) extracting optional `DateTimeOriginal` and GPS `lat/lon` without external libraries.
- `src/ui/charts.ts` — Zero-dependency SVG chart renderers:
  - Cumulative PSD Plot (`mm` log10 / `phi` toggle, Wentworth grade shading, faint per-photo curves, bold pooled curve, 95% Bootstrap CI ribbon, $D_{16}/D_{50}/D_{84}$ reference lines).
  - Convergence Plot ($D_{16}, D_{50}, D_{84}$ & 95% CI width vs. $1 \dots N$ photos).
  - Jackknife Influence Bar Chart ($\delta_p^{(-j)}\%$ per photo).
  - Wentworth $0.5\phi / 1.0\phi$ Histogram & Aspect-Ratio ($b/a$) Histogram.
  - $180^\circ$ Symmetric Axial Fabric Rose Diagram (SVG polar wedges + mean resultant vector $\bar{\theta}$).
- `src/ui/canvasViewport.ts` — Dual-layer high-DPI `<canvas>` (base image + offscreen-rendered `Int32Array` label LUT RGBA overlay with opacity slider) + crisp `<svg>` vector overlay (fitted ellipses, orientation vectors, border/truncated flags, exclusion polygons, scale bar, rubber-band edit lines) + smooth wheel-zoom / space-drag pan + optional 2×/4× circular **Precision Loupe** cursor.
- `src/ui/modals.ts` — Model Manager Drawer (`ig2_unet_fp32` 25.3 MB vs. `ig2_cpsam_fp16` ~588 MB, `ReadableStream` progress bar, `checkStorageQuota()`, cancel/delete/clear), Export Drawer (all CSV/JSON/PNG/GeoJSON/SVG/`.webgrainy.json` downloads), and About & Citations Modal (preserving `README.md` unofficial notice + full bibliography).
- `src/ui/main.ts` — Application bootstrapper wiring `ImageGrainsEngine` (`workerFactory` + `wasmPaths: './ort/'`), `projectStorage`, `siteAnalysis`, keyboard shortcuts (`Ctrl+Z` / `Ctrl+Y`), and UI panels.

### 4.2 UI Layout
1. **Top Offline & Privacy Status Bar:**
   - Persistent badge: **"100% Local Processing — No Data Leaves Your Device"**.
   - Live pills: WebGPU / WASM SIMD status (`engine.initialize()`), Service Worker offline-ready status, `navigator.onLine` indicator.
   - Action buttons: **Models**, **Export**, **About & Citations**.
2. **Left Sidebar — Site & Multi-Image Workspace:**
   - Site selector / New Site / Import `.webgrainy.json`.
   - Drag-and-drop & multi-file `<input type="file" accept="image/*" multiple>` photo importer.
   - Photo queue list (thumbnail, status badge, Complexity Router `recommendModel` badge, include-in-site checkbox, calibration badge, **"Run All Pending"** / **"Cancel"**).
   - Collapsible **Inference & Post-Processing Controls**: Model (`auto` / `unet` / `cpsam`), `ScaleMode`, CLAHE toggle + clip-limit slider, `flowThreshold`, `cellprobThreshold`, `minSize`, `maxGrainAreaFraction`, `minBaxisPx` truncation cutoff.
3. **Center Viewport — Inspection & Editing:**
   - Toolbar modes: **Inspect**, **Split** (polyline -> `session.splitGrainAtLine`), **Merge** (multi-select -> `session.mergeGrains`), **Delete**, **Add Polygon**, **Exclusion Zone** (polygon/brush), **Calibrate Scale** (2-point `ScaleCalibrator` with presets: 100 mm ruler, 25 mm coin, 500 mm quadrat, custom `mm`/`cm` + **"Copy scale to other photos in site"**), **4-Point Perspective Rectify**, **Undo / Redo** (`Ctrl+Z` / `Ctrl+Y`).
   - Overlay toggles: **Instance IDs**, **Wentworth Colors**, **$a$/$b$ Ellipses**, **Orientation Vectors**, **Border/Truncated Flags**, **Opacity Slider**, **Loupe Toggle**.
4. **Right / Bottom Scientific Dashboard (Single Photo / Pooled Site Toggle):**
   - Pooling mode selector (with Kellerhals & Bray 1971 basis label), Common Physical Cutoff toggle, Adequacy Gauge ($100/200/400$ thresholds + $r_{\max}$ & outlier warnings), Folk & Ward summary cards, Clast Packing / Exposed Matrix %, and tabbed SVG charts (PSD + 95% CI, Convergence & Jackknife, Wentworth & Shape, Fabric Rose).

### 4.3 `esbuild.config.mjs` Updates
Extend `esbuild.config.mjs` (while keeping steps 1–4 intact) with:
- **Step 5:** Bundle `src/ui/main.ts` -> `dist/ui/main.js` (`format: 'esm'`, `platform: 'browser'`, `target: 'es2022'`, `bundle: true`, `sourcemap: true`) and `src/ui/styles.css` -> `dist/ui/styles.css` (`bundle: true`).
- **Step 6:** Copy `src/index.html` -> `dist/index.html` and `src/sw.js` -> `dist/sw.js`.
- **Resulting `dist/`:** `index.html`, `sw.js`, `index.js`, `modules/*.js`, `ui/main.js`, `ui/styles.css`, `workers/grainPostprocess.worker.js`, `ort/*.wasm` + `ort/*.mjs`.

---

## 5. Phase 4: Test & Verification Strategy

### 5.1 Unit & Integration Tests (`tests/`)
Add Vitest suites (using existing `tests/e2e/helpers/mocks.ts` / `MockIDBFactory` patterns in `node` environment):
1. `tests/roiAndRectify.test.ts`:
   - ROI & exclusion polygon/brush filtering (non-destructive mask preservation, `f_excl` threshold, Clast Packing % & Exposed Matrix %).
   - 4-point homography rectification on synthetic tilted checkerboards/grids: verify corner recovery error $< 0.5\text{ px}$, uniform `mmPerPx`, and collinearity error handling.
2. `tests/morphometricsExt.test.ts`:
   - Crofton perimeter & circularity on synthetic circles/squares, Andrew's monotone chain convex hull & solidity on concave shapes, 2D sphericity proxy.
   - Double-angle axial fabric: verify $\theta = -\pi/2$ and $\theta = +\pi/2$ yield identical vectors and $R = 1.0$; isotropic distribution yields $R \approx 0$.
   - $0.5\phi$ and $1.0\phi$ Wentworth binning accuracy.
3. `tests/siteAnalysis.test.ts`:
   - Pooling parity: `physical-area` across $N$ identical-scale photos equals concatenated grain pool; `virtual-wolman-grid` converges toward `physical-area` as $\Delta_{\text{mm}} \to 0$.
   - Mixed-calibration validation blocks `mm` pooling when an included photo lacks `mmPerPx`; common physical truncation cutoff harmonizes varying `mmPerPx`.
   - Bootstrap determinism (`seed = 42` bit-identical across runs), single-photo fallback flag, and 95% CI width contraction as $N$ increases.
   - Eaton et al. (2019) binomial order-statistic CI & jackknife leave-one-out sensitivity ($>10\%$ influence flag).
   - Site CSV/JSON exports contain expected headers, citations, and statistical basis labels.
4. `tests/projectStorage.test.ts`:
   - IndexedDB (`imagegrains-projects-v1`) CRUD round-trips, `AnalysisSession.toSerialized()` / `fromSerialized()` hydration parity, `.webgrainy.json` archive export/import, and sequential `runSiteBatch` cancellation via `AbortSignal`.

### 5.2 Build, Typecheck & Offline Browser Verification
1. **Core Gates:**
   ```bash
   npm run typecheck   # tsc --noEmit -> exit 0, 0 errors
   npm run build       # node esbuild.config.mjs -> exit 0, full dist/ output
   npm test            # vitest run -> exit 0, all 218+ existing + new tests pass
   ```
2. **Zero External CDN Audit:**
   ```bash
   grep -rnE 'https?://(cdn|fonts\.googleapis|unpkg|jsdelivr)' dist/
   # Expected: 0 matches
   ```
3. **Offline Headless Chromium CDP Check:**
   - Serve `dist/` locally on `127.0.0.1:4173` (`python3 -m http.server 4173 -d dist`).
   - Launch `/usr/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=9222 http://127.0.0.1:4173` and connect via Node 24's built-in `fetch` + `WebSocket` (CDP):
     - Assert **0** `Runtime.consoleAPICalled` (`error`) messages.
     - Assert **0** `Runtime.exceptionThrown` uncaught exceptions.
     - Assert **0** external network requests (`Network.requestWillBeSent` URLs strictly `http://127.0.0.1:4173/...`, `data:`, or `blob:`).
     - Verify DOM rendering of the Privacy Status Bar, Site Workspace, Canvas Viewport, Scientific Dashboard, and interactive modal/tab transitions.
