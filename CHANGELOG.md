# Changelog

All notable changes to webGrainy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added (quality of life, batch 2: items 5 and 9)
- **Printable site report** (Export → Printable report, `ui/report.ts`). It fits on 1–2 A4 pages and contains:
  - the charts and key statistics with confidence intervals;
  - adequacy, and photo thumbnails with outlines;
  - settings, versions, warnings and citations.

  Every number is tied to its Site Summary CSV row, and a test checks they match. The report opens in a new tab with a Print / Save as PDF button; if pop-ups are blocked it is downloaded instead.
- **Comparing sites over time.**
  - Each site has an optional survey date, which defaults to the earliest EXIF photo date (`modules/surveyDate.ts`). It is validated when importing a project.
  - Compare sites can order by date, adds a *Survey date* column, and draws a D16/D50/D84 time-series chart with bootstrap CI bars (`renderTimeSeriesSvg`).
  - Undated sites are listed separately, and the comparison CSV has a `survey_date` row.

### Added (quality of life, batch 2: items 6–8)
- **Photo list tools.**
  - A summary line ("8 photos · 6 analysed · 2 not calibrated · 1 failed") whose parts filter the list.
  - **Select** mode with bulk include / leave out / re-analyse / delete. Delete asks first and gives the count.
  - New modules: `ui/photoList.ts`, plus `deletePhotos` and `setPhotosIncluded` in `workspaceActions`.
- **Grain inspector navigation.**
  - Prev / Next / Largest / Next flagged. Flagged means touching the edge, outside the ROI, or b/a < 0.35, and the card shows why.
  - The view pans and zooms to the grain (`ui/grainNav.ts`, `focusOnGrain`).
  - "Largest" and "Flagged (n)" are also in the Inspect tool bar.
- **Keyboard shortcuts** (`ui/shortcuts.ts`, a single table used by the key handler and the overlay):
  - **?** opens the overlay;
  - **[ ]** move between photos;
  - **1–9** pick tools;
  - Ctrl+Z / Ctrl+Y undo and redo.
  - Shortcuts no longer act while you type in a field, so a text field's own undo works there.

### Fixed
- Pressing a button on the grain inspector card also counted as a tap on the photo under it, which could select another grain or close the card.

### Changed (code organisation; no change in results)
- **App code split into modules** (`docs/plans/MODULE_REFACTOR_PLAN.md`, steps 1–5):
  - app actions in `ui/workspaceActions.ts`;
  - pure panel renderers in `ui/panels/`;
  - event handlers by area in `ui/events/`;
  - `siteAnalysis.ts` split into `siteTypes`, `siteCalibration`, `sitePooling`, `siteUncertainty`, `siteAdequacy` and `siteExportFormats`, with the public API re-exported.
- `main.ts` went from 2,850 to about 1,000 lines.
- Each step was checked against the previous build:
  - panel HTML was identical in 19 app states;
  - site reports and exports were identical in 123 cases.
- New unit tests cover actions, panels and events.
- The TypeScript checks now reject unused code (`noUnusedLocals`, `noUnusedParameters`). Three unused functions were removed.

### Added (quality of life, batch 1)
- **Backup reminder.** The Site panel shows when the open site was last saved as a project
  file. It warns when results changed since then, and has a **Back up now** button. It also
  shows browser storage use and whether the storage is protected from automatic clearing
  (`ui/backup.ts`).
- **Screen kept awake during analyses** (Screen Wake Lock API, re-acquired when the tab
  becomes visible again; `ui/wakeLock.ts`).
- **"Done" signal.** While the tab is in the background, its title shows progress
  (`(3/12) webGrainy`) and then `✓ Done`. Optionally, a system notification fires for
  analyses over a minute (`ui/doneSignal.ts`).
- **Analysis settings remembered between visits.** They are checked field by field on load,
  so stale or corrupt values fall back to the defaults (`ui/savedSettings.ts`).

### Changed (from the pre-processing benchmark, `audit/preprocessing/`)
- **CLAHE moved under Advanced with a warning.** It lowered accuracy with both models in
  the 40-photo benchmark (and badly for some sites). Still off by default.
- **"Enlarge for fine grains" offered for U-Net.** When the median grain is under 20 px in
  the analysed image, the photo's results suggest re-analysing enlarged ×1.5 (benchmark:
  PQ +0.025, 95% CI +0.007 to +0.049, no site worse). Offered rather than automatic because
  the threshold was chosen after seeing the test set. Saved per photo, recorded in
  provenance (`fineGrainUpscale`), with Undo. `imagePreprocess.upscaleWorkingImage` and a
  shared `resizeRgbaBilinear`.
- The results panel now also redraws when an analysis finishes (buttons in it no longer
  stay disabled).

### Fixed
- **Calibration messages are in plain language** and name the photos (not internal IDs),
  e.g. "No scale yet: 1 photo is not calibrated (K1_C2.jpg) … Calibrate each photo with
  Scale → Calibrate …". The old message mentioned an internal setting (`unit='px'`).
- **Dashboard tabs could become unclickable** on shorter windows: the side panels are
  scrolling flex columns, and a tall section was squashed so its content painted over the
  tabs. Sections now keep their height, the tab bar stays visible while scrolling (sticky),
  and charts no longer use `content-visibility` (which made their heights jump).
- **Aspect-ratio chart counted more grains than the statistics**: it included grains on
  the photo border and outside the ROI / inside exclusions. It now uses the same grains
  as n.
- **Grains inside excluded areas looked like counted grains.** They are still detected
  (the model sees the whole photo) but are now drawn grey and hatched, without ellipses or
  orientation lines, and the grain inspector marks them "not counted".

### Added
- **Analyse all sites** (under the site selector when there is more than one site):
  analyses every not-yet-analysed photo in every site, the open site first; Cancel stops
  the whole job.
- **Compare sites:** an *Open* button next to each site that needs attention, and a
  *Compare in pixels* option for uncalibrated sites (with a note that this is only
  meaningful for the same camera at the same height).
- **Compare sites** (Results → *Compare sites*): pick sites; overlaid cumulative curves
  with confidence bands and outlined size distributions (fixed colour per site,
  colour-blind-safe palette); comparison table (D16, D50 with CI, D84, Dg/σg, Sauter,
  sorting, gravel/cobble %); approximate pairwise D50 ratio with 95% interval and p-value;
  comparison CSV; SVG/PNG chart downloads. Other sites' saved results are loaded on
  demand and computed with the current statistics settings (`modules/siteComparison.ts`,
  tested).

### Changed
- **Results open on *This photo*;** switch to *Whole site* for the pooled statistics.
- **Cellpose-SAM failed with "The serialized keys and/or value are too large".** Chromium
  (Chrome/Edge) rejects single IndexedDB values over about 127 MB, and the cache stored
  each model as one ArrayBuffer (FP4 183 MB, INT8 316 MB, FP16 617 MB). Models are now
  stored as Blobs, which the browser keeps on disk outside that limit (verified in
  Chromium with a 150 MB model: the ArrayBuffer write did not complete; the Blob write
  and read-back worked). Existing cached models stay readable. If a model still cannot be
  cached (disk full, private mode), the analysis continues and a message says it will be
  downloaded again next time; only the explicit *Download* in the model manager reports
  it as an error. The app also asks the browser to keep its storage (persistent storage)
  so cached models are less likely to be evicted. Listing cached models no longer loads
  every model into memory.
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

### Internal
- **Code organisation (no change in results).** One copy of the PNG/GeoJSON/SVG
  writers (`exportFormats.ts`; two copies had drifted), one summary-CSV writer, `csvCell`
  everywhere, and `exports.ts` building every download. App logic moved out of the UI
  (`siteWorkspace.ts`); the dashboard uses cached session values instead of recomputing
  on each redraw; `pipelineController.ts` split into `analysisSession.ts` and `engine.ts`
  (re-exported, so imports are unchanged). Exports verified identical to the previous
  build except that photo-summary text labels are now quoted only when needed. The photo
  Fabric tab now uses the grains that count in the statistics, like its export.

### Added
- **Size distribution histogram on the PSD tab** for *This photo* and *Whole site*
  (area-weighted %, small to large; Wentworth φ classes in mm, or ×2 / ×√2 pixel classes
  before calibration). Previously the size histogram sat on the Shape tab, always showed
  the site, and was blank until photos were calibrated. Photo summary CSVs now include
  the pixel size classes too.
- **Download any chart as SVG or PNG** (buttons under each chart; light background, PNG
  at 3×, provenance metadata embedded).
- Histogram binning lives in `modules/histograms.ts`; `ui/charts.ts` only draws.
- **More grain-size statistics** (Results → PSD → *More statistics*, and in all summary
  exports): Sauter mean D[3,2], De Brouckère mean D[4,3], arithmetic mean D[1,0]
  (moment ratios over all grains, ISO 9276-2); geometric mean Dg and geometric standard
  deviation σg; D30, D60, D65; method-of-moments mean, sorting, skewness and kurtosis in φ
  (GRADISTAT, Blott & Pye 2001); uniformity Cu, curvature Cc, Trask sorting So, span and
  the Fredle index. Percentile-based values use the same weighting as the PSD curve.

### Changed
- **Name sites:** *+ New* asks for a name, and *Rename* changes it. The site name is in
  export file names and in the export metadata.
- **Exports now contain everything the dashboard shows.** Site summary CSV adds Folk &
  Ward confidence intervals, size-class histograms (1 φ and 0.5 φ), fabric statistics,
  adequacy details, jackknife, a per-photo breakdown by photo name, the confidence level
  and warnings. Photo grains CSV adds orientation, perimeter, circularity, aspect ratio,
  elongation, convexity, solidity, sphericity and an "included in statistics" flag. Photo
  summary CSV adds size-class histograms and fabric statistics. Listed in
  `docs/SETTINGS_GUIDE.md` §13.
- **Fabric tab shows its numbers** (mean orientation, alignment R, Rayleigh p).
- **Readable D16/D50/D84 labels** (real subscripts at a legible size instead of tiny
  Unicode subscript digits).
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
