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
- CSV exports: a `#` in a photo or site name is quoted (so `pandas.read_csv(..., comment='#')` and R keep
  the row); values that cannot be computed are left empty instead of `NaN`; a calibrated photo with no
  grains reports in mm.
- 16-bit TIFFs are stretched between the 0.01st and 99.99th percentile, so one hot pixel no longer
  squeezes the image into a few grey levels.
- A project file may hold at most 10,000 photos.
- An adequacy rating capped by the photo count says so ("capped: 3 photos") on the results card, the
  comparison table and the printable report.
- Facies weights: the help and docs now say the weight is per photo (a surface type's share is the sum
  over its photos), and each photo shows its resulting share of the site.
- The printable report and every export state the validated accuracy and its limits.
- Docs: guidance to set the field-count cutoff to about 3× the detection limit for a reliable fine tail,
  and that the accuracy benchmark used mostly small images at full resolution.
- Held-out accuracy intervals resample whole sites (site-cluster bootstrap).
- Interval coverage checked on more variable beds (`variable_bed_coverage.audit.ts`).
- Auto image scale: photos over 1,024 px are analysed with a 1,024 px working image (before, photos of
  1,025–4,096 px were halved or quartered, so a 2,100 px photo got a 525 px working image but a
  2,048 px photo 1,024 px). Photos of that size now resolve finer grains and take longer. On the
  K1 field photos (1,300 px) U-Net now finds more than twice as many grains, so its D50 without a
  field-count cutoff is 22% finer than the pebble count (it matched before only because it missed
  small grains); with the 13 mm cutoff both models agree within 3%.
- Folk & Ward and moment skewness / kurtosis of degenerate distributions are reported as undefined.
- Counted grains with no weight get `stats_weight` 0; the interval columns of the site summary say how
  they were computed.
- TIFFs over 100 MP are refused with a clear message; the formula guard in CSV exports also covers pipe-
  and space-separated imports; cached model files are re-checked once per session; builds are
  reproducible (the same commit gives the same files).
- GeoTIFF map exports: a GIS put the mask in the wrong place because the world file (`.pgw`) carries
  no coordinate system. New **label mask GeoTIFF** (`mask_map.tif`) with the source GeoTIFF's position
  and GeoKeys (any CRS, also user-defined), a `.aux.xml` CRS file next to the PNG mask's world file,
  the map position kept after a 2× upscale, and accurate wording about which tools read the map
  GeoJSON's CRS. Checked with GDAL on an NZTM 2000 orthomosaic tile.
- GeoJSON in longitude/latitude (`outlines_lonlat.geojson`) for web maps, which ignore the map GeoJSON's
  CRS: converted offline for 2,698 EPSG coordinate systems (UTM, national grids, US State Plane) plus Web
  Mercator and geographic CRSs, within 0.04 mm of PROJ. The map-coordinate GeoJSON is renamed to name its
  CRS (`outlines_EPSG2193.geojson`, was `outlines_map.geojson`): web maps and ArcGIS Online read every
  GeoJSON as longitude/latitude (RFC 7946) and ignore its `crs` member.
- Photo and mask GeoTIFFs reprojected to Web Mercator (EPSG:3857, north-up) for web maps that draw a
  projected raster without rotating it by the grid convergence (about 1.5° for NZTM), which made correct
  outlines look slightly rotated. Identical to GDAL's gdalwarp on the NZTM test tile.
- Export option: outlines and masks of only the grains counted in the statistics, or (default) every grain.
- Export dialog: outlines, mask and photo are exported through three choices (what, format, coordinates)
  and one Download button, with a line describing the selected file, instead of one button per variant.
  Coordinate options name the photo's own CRS.
- The grain card says which cutoff excluded a grain and by how much (e.g. "b-axis 8.9 px < 15 px pixel
  cutoff"), instead of "below cutoff", which read as the segmentation Min Size.
- Licence notices for the bundled `utif2` and `pako` and for the optional PULSE upscaler weights added
  to `THIRD_PARTY_NOTICES.md`; the licence and notices are copied into the built app.
- Calibration: changing the preset, length or unit in the Calibrate toolbar no longer rewrites a GeoTIFF,
  rectified or copied scale (it re-used placeholder endpoints, e.g. turning 2 mm/px into 0.25 mm/px);
  only a scale measured with two clicked points is re-applied.
- WebGPU device loss: the CPU fallback is no longer raced against the lost GPU device, which failed the
  retry and every later CPU analysis in the tab until reload.
- GeoTIFFs with a projected model type but no ProjectedCSTypeGeoKey are no longer read as EPSG:4326 from
  their base-datum key (projected metres were exported as degrees); such a CRS is treated as user-defined.
- South-up and mirrored GeoTIFFs: mask / photo GeoTIFF exports write a ModelTransformation instead of an
  invalid negative pixel scale (which GDAL flips), and GeoTIFFs placed by a ModelTransformation without
  skew are auto-calibrated.

[0.1.0]: https://github.com/LukeAFullard/webGrainy/releases/tag/v0.1.0
