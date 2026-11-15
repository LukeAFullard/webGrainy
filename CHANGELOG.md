# Changelog

All notable changes to webGrainy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Intermittent broken thumbnails when loading a site.** Old thumbnail URLs were revoked before the new ones were in place (`net::ERR_FILE_NOT_FOUND`).
- **Cellpose-SAM on the CPU (WASM) crashed** with `std::bad_alloc` on full-size photos. It now runs one tile per call.
- **Recovery after WebGPU device loss.** After a loss, WebGPU is disabled for the page,
  GPU sessions are evicted, the capability is reported unavailable, and the image is
  retried once on WASM instead of failing. Previously the next WebGPU session reused the
  lost device. The UI shows "GPU reset · CPU mode (reload for GPU)".

### Added
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
- **CPU inference uses all cores (capped at 8) when the page is cross-origin isolated**
  (U-Net on a 1024×768 photo: 18.4 s → 6.7 s on 4 cores). See `DEPLOYMENT.md`.

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
