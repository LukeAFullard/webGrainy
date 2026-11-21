# Changelog

All notable changes to webGrainy are listed here. Versions follow [Semantic Versioning](https://semver.org/);
while the version is 0.x, results, file formats and settings may still change between minor versions.

## [0.1.0] - 2026-12-19

First public release.

### Features

- **Segmentation in the browser** with the pretrained ImageGrains 2.0 models: U-Net, or Cellpose-SAM
  (FP16 for WebGPU, or the smaller INT8 / FP4 weights). Runs on the GPU (WebGPU) where supported,
  otherwise on the CPU (WebAssembly) in a background worker. Model files are pinned and checked by SHA-256.
- **Measurement per grain:** b-axis (moment-ellipse minor axis), minimum and maximum Feret width,
  equal-area diameter, shape and orientation. Sizes in mm from two-point calibration, perspective
  rectification or GeoTIFF georeferencing.
- **Editing:** split, merge, delete and draw grains, with undo / redo; regions of interest and exclusion areas.
- **Statistics:** area-weighted (grid-by-number) and number-weighted percentiles D5–D95, Folk & Ward,
  Wentworth classes, moment statistics and fabric.
- **Sites and surveys:** photos pooled into sites with confidence intervals, a convergence curve and
  sample-adequacy checks; sites compared side by side and over time, with Welch tests and Holm-adjusted
  p-values.
- **Exports:** per-grain and summary CSV / JSON, label-mask PNGs, GeoJSON / SVG outlines, chart images,
  a printable report, and `.webgrainy` project files. Every export records the app version, model and
  settings.
- **Private and offline:** photos and results stay on the device; after the one-time model download the
  app works offline.

### Validation

- Held-out ImageGrains 2.0 test split (40 images, 13 sites): median D50 error 2.9% (Cellpose-SAM) and
  5.7% (U-Net). See the README and `validation/`.
- Site intervals and the survey-change test were checked by simulation (`validation/comparison/`,
  `validation/interval_coverage/`), including the test's power for a 20% change.

### Fixed before release (pre-publication audit)

- Imported `.webgrainy` files are checked field by field; a crafted file can no longer inject markup or
  navigate the page, and settings outside the accepted ranges are dropped.
- Sites are removed automatically after the retention period only if they have no photos or their results
  were downloaded after the last change; other old sites are listed for the user to keep or remove.
- Figures quoted in the documentation and the app match the validation results files, and a test keeps
  them in step.
- Licence notices for the bundled `utif2` and `pako` and for the optional PULSE upscaler weights added
  to `THIRD_PARTY_NOTICES.md`; the licence and notices are copied into the built app.

[0.1.0]: https://github.com/LukeAFullard/webGrainy/releases/tag/v0.1.0
