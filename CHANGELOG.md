# Changelog

All notable changes to webGrainy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Phones: the photo viewer had zero height and touch scrolling was blocked.** The
  phone layout rule was overridden by a later desktop rule, and the side panels'
  `overscroll-behavior: contain` stopped swipes from scrolling the page. The viewer now
  gets 60% of the screen height, and panels no longer trap scrolling.
- **Photo viewer had no touch gestures** (panning needed a middle mouse button or
  Space, zoom a mouse wheel). Now: pinch to zoom, two-finger drag to pan, one-finger
  drag pans when zoomed in and scrolls the page otherwise, tap runs the active tool,
  the brush draws with one finger. New *Finish shape* / *Cancel shape* buttons replace
  double-click / Enter / Esc for polygons and split lines on touch screens.
- **Grain ellipses were drawn mirrored.** The ellipse overlay was rotated by θ + 90°
  instead of 90° − θ, so every diagonal grain's ellipse leaned the wrong way (the
  orientation vectors were already correct). Hand-drawn or edited grains also used a
  different angle convention (from the x axis instead of skimage's row axis), which
  affected their exported `orientation_rad` and the orientation statistics. One shared
  convention now lives in `src/modules/orientationGeometry.ts`, with tests at 8 angles.
- **Intermittent broken thumbnails when loading a site.** Old thumbnail URLs were revoked before the new ones were in place (`net::ERR_FILE_NOT_FOUND`).
- **Cellpose-SAM on the CPU (WASM) crashed** with `std::bad_alloc` on full-size photos. It now runs one tile per call.
- **Recovery after WebGPU device loss.** After a loss, WebGPU is disabled for the page,
  GPU sessions are evicted, the capability is reported unavailable, and the image is
  retried once on WASM instead of failing. Previously the next WebGPU session reused the
  lost device. The UI shows "GPU reset · CPU mode (reload for GPU)".

### Changed
- **Simpler layout (progressive disclosure).** One status chip instead of three; settings
  folded into *Analysis settings* (with *Fine-tuning* and *Advanced*), *Statistics
  settings* and a *Display* menu, each showing a one-line summary; toolbar grouped into
  Scale / Exclude / Edit grains, with editing tools shown only after analysis; results
  (D16/D50/D84, charts) first in the right-hand panel; clearer button labels.
- **Getting started checklist** (left panel; ticks itself off; hide/show from Help) and
  an empty photo area with an *Add photos* button.
- **Progress bar for analyses**: a bar at the bottom of the screen shows the photo
  (n of N), the step (model download in MB, loading the model, tiles done of total with
  time left, tracing outlines), progress across all photos, and Cancel.
- **Phones and tablets:** Auto always picks U-Net; Cellpose-SAM stays selectable
  (labelled "not for phones"), uses the INT8 weights, and warns that it needs about
  1.5 GB of memory and can take 10+ minutes per photo. The settings panel starts
  collapsed on narrow screens, and buttons/inputs have larger touch targets.

### Added
- **Skip areas outside the ROI** (Advanced, default on). With an ROI or exclusions drawn
  before analysis, inference tiles that are entirely farther than 128 px (working image)
  from the valid bed area are not run. Predictions within that margin are identical to a
  full analysis (tested; on a real photo all 433 grains inside a test ROI were
  pixel-identical). The analysed area is recorded in provenance; if the ROI is later
  enlarged or an exclusion removed, the dashboard asks for re-analysis.
- **CPU threads setting** (Advanced; saved per browser, applied on reload).
- **Quantized Cellpose-SAM weights:** INT8 (316 MB) and FP4 (183 MB), from the model
  repository (revision `98e76b13`, SHA-256 pinned). Same benchmark accuracy as FP16
  (`audit/quantization/`). New *CP-SAM weights* setting: *Auto* (default) uses FP16 on a
  WebGPU GPU with shader-f16 and INT8 otherwise (half the download and memory, much
  faster loading, CPU speed equal to about 2× faster depending on the machine;
  `audit/quantization/APP_INTEGRATION_CHECK.md`). The weight file is recorded in provenance and exports. The model manager and
  the GPU check page list all three.
- **Exclusion overlap tolerance is configurable** (site option `maxExcludedFraction`,
  default 0.10). Applies immediately, and is recorded in exports.
- **Multi-threaded CPU inference on any host.** The service worker adds COOP/COEP headers,
  with one automatic reload on first visit, so WASM uses all cores (about 2–3× faster)
  even where server headers can't be set. Verified with the real model download. The top
  bar shows the CPU thread count.
- **In-app help for every setting:** a "?" button opens a plain-language explanation
  (what it does, default, when to change it). *Help* and *Settings help* buttons list all
  settings. Content mirrors `docs/SETTINGS_GUIDE.md`; tests check that every setting
  control has a help topic and that the documented defaults match the engine.
- **Previously fixed settings are now configurable:**
  - *Exclude border grains* (applies immediately) and *Border margin*;
  - *Advanced:* *Flow steps* and *Seed density*, with *Reset to defaults*;
  - site *Confidence level*, *Bootstrap repeats / seed*, *Two-stage bootstrap* and
    *Virtual Wolman points*;
  - per-photo *Facies weight* (Facies-weighted pooling).
- **Site settings recorded in exports:** site export metadata now includes the
  cutoffs, bootstrap settings and Wolman points.
- **Plain-language user guide:** `docs/SETTINGS_GUIDE.md`.
- **Site option `minSizeMm` ("Field-count cutoff (mm)")** to match a pebble count's minimum size.

### Changed
- **New default inference pipeline that reproduces PyTorch ImageGrains exactly.** The
  ONNX models were always exact; the outline gap came from webGrainy's tiling.
  - The new "Cellpose" pipeline replicates Cellpose's preparation and tiling:
    - U-Net: resize by 17/30, 224 px tiles;
    - Cellpose-SAM: 8 px zero border;
    - both: sigmoid-taper blending.
  - Results on 7 held-out IG2 images:
    - masks identical to PyTorch (U-Net) or 99.5 % identical (Cellpose-SAM);
    - app outline quality: U-Net 0.427 → 0.451, Cellpose-SAM 0.504 → 0.559;
    - median D50 error: U-Net 15.5 → 9.1 %, Cellpose-SAM 8.6 → 3.3 %.
  - The previous pipeline stays available as "Legacy" (Advanced) and is recorded in
    provenance. See `audit/parity/README.md`.
- **CPU inference uses multiple cores when the page is cross-origin isolated**
  (U-Net on a 1024×768 photo: 18.4 s → 6.7 s on 4 cores). Default: one fewer than the
  logical cores (at least 1, at most 8), so quad-core computers and phones keep a core free.
  See `DEPLOYMENT.md`.

### Documentation
- **Withdrew "outperforms upstream PyTorch".** The paired comparison is not significant
  (`audit/followup/paired_comparison.py`).
- **Benchmarked the 0.40 area-guard default** (PR #12): U-Net identical to 1.00; CP-SAM differs on 1 of 40 images (a cobble covering 50% of the frame is dropped). Not distinguishable from PyTorch.
- **K1 field discrepancy (~40% finer D50) traced to truncation:** the field count's 13 mm
  minimum. With a matching cutoff, D50 is within +3/+4% (`audit/k1/`).
- **Corrected the audit's CPU timing.**

## [1.1.0] — 2026-11-15

This release fixes the findings of the pre-release audit (`AUDIT_REPORT.md`, section
"Remediation status").

### Fixed
- **The built app could not run inference (F-01).** ORT resolved `./ort/` relative to
  `dist/ui/main.js` and got a 404. `wasmPaths` is now resolved against the page URL.
- **Single-photo statistics now honour ROI/exclusion polygons (F-07).** Excluded grains
  are flagged `in_roi=false` in the grains CSV, and the dashboard shows the count.
- **Photo GeoJSON/SVG exports** previously used working-resolution coordinates. They
  now use original-image pixels.
- **Per-photo error messages are shown** instead of a bare "error" badge, and the batch
  status line includes the first failure reason (F-05).
- **The WebGPU badge and execution provider** now require a real adapter
  (`navigator.gpu.requestAdapter()`), not just `navigator.gpu` (F-05).
- **The site dashboard explains why pooling is unavailable** (e.g. uncalibrated photos)
  instead of "Add & analyze photos".
- **The CI label reflects the configured confidence level** (90 or 95%) (F-20).

### Security
- **Model weights are pinned and verified (F-03).** They are fetched from Hugging Face
  revision `7773328a…` and checked for size and SHA-256 before use and on every cache
  hit. Legacy or unverified cache entries are re-downloaded.
- **CSV formula injection is neutralised** in all CSV exports (F-11).
- **Hardened archive import (F-13):**
  - size and dimension limits;
  - full validation before any write;
  - prototype-pollution keys stripped;
  - image MIME whitelist;
  - id collisions import as a copy instead of overwriting existing sites.
- **Added a Content-Security-Policy** `<meta>` tag and a header guide (F-22).
- **IndexedDB connections close on `versionchange`** (F-21).

### Changed
- **Service worker (F-04):** content-hashed cache name and a generated precache list,
  with the ORT runtime in its own version-keyed cache. Updates activate automatically
  and prompt for a reload. The cache name is no longer bumped by hand.
- **`dist/` is 35 MB instead of 111 MB:** only the ORT JSEP runtime that is actually
  loaded is shipped.
- **UI defaults now equal the engine defaults and the benchmarked configuration**
  (`flowThreshold 0.45`, `minSize 30`) (F-08).
- **Folk & Ward is suppressed for fewer than 2 grains (F-14 / F-15).** Statistics carry
  `warnings` for small n (< 30, < 100), mixed calibration and uncalibrated results,
  shown in the dashboard.
- **Binomial percentile CIs interpolate between integer ranks** (Eaton et al. 2019)
  (F-19).
- **Model download streams into a preallocated buffer** when the size is known, which
  halves peak memory for the 617 MB model (F-18).
- **The "b-axis" is labelled as the ellipse minor axis** throughout the UI, docs and
  export metadata (F-06).

### Added
- **Provenance metadata in every export (F-10):** app/ORT version, model id, revision
  and SHA-256, execution provider, post-processing parameters, scale factor,
  calibration, ROI use, timestamp, size-metric definition, and the unofficial-port and
  citation notice.
- **Min/max Feret (caliper) diameters** in the extended morphometrics and the pooled
  grains CSV (F-06).
- **`npm run test:e2e:browser`:** a headless Chromium smoke test of `dist/` that runs a
  real, SHA-256-verified U-Net analysis.
- **`npm run test:perf`** for strict timing budgets. The default suite uses generous
  budgets so timing noise no longer fails CI (F-17).
- **Audit regression tests** (`tests/auditRegressions.test.ts`). The audit's mutation
  check now kills 9/9 mutants (was 5/9).
- **GitHub Actions CI**, `DEPLOYMENT.md`, `THIRD_PARTY_NOTICES.md` and `CITATION.cff`.

### Documentation
- **README benchmark table:** references are separated (vs human GT vs PyTorch), and a
  held-out caveat and a limitations section are added (F-02, F-12). The Quick Start now
  uses the real API.
- **Validation report:** added interpretation caveats and fixed the figure path.

## [1.0.0]
- Initial browser app (see PROJECT.md milestones M1–M6).
