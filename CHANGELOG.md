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

### GeoPackage export

- Grain outlines as an OGC **GeoPackage** (`.gpkg`), e.g. for ArcGIS Pro: Export → Outlines → Format
  *GeoPackage*, in the photo's map coordinates (with its EPSG CRS), longitude/latitude or photo pixels.
  One polygon layer with the measurements as fields named like `grains.csv`; the results `.zip` adds
  one per GeoTIFF photo. Written by a small built-in SQLite writer (no extra download); every file is
  checked with SQLite's integrity check in the tests.
- **Site GeoPackage**: the whole site in one file (Export → *Site GeoPackage*, and in the results `.zip`):
  every photo's grain outlines in one layer, with `photo_id` and `included_in_stats`, and a
  `photo_footprints` layer with each photo's D16 / D50 / D84. In the photos' shared map CRS, or
  longitude/latitude when they differ.

### Optional outline clean-up

- **Tidy outlines** (toolbar, or photo list → *Select* → *Tidy outlines*), only when the user chooses
  it: every grain becomes one solid piece. Detached specks of a grain join the neighbouring grain they
  share the longest edge with, become grains of their own (at least *Min size*) or are removed; holes
  enclosed by one grain are filled. One undo step per photo; recorded in exports and the printable
  report. Checked with both models on the 40 held-out test images (`validation/tidy/`), with
  before/after examples: outline agreement unchanged; median D50 error unchanged (U-Net) or slightly
  lower (Cellpose-SAM, 2.9% → 2.6%).

### Reports and comparisons

- **Printable report options** (Export → Printable report options, remembered in the browser):
  grains on the photos drawn as outlines, **Wentworth size colours** (the Display colours, with a
  legend of the classes present), counted vs not counted, or not at all; photos two per row or one
  per row at twice the resolution; and the optional sections below.
- The printable report adds **grain shape** (b/a histogram, median b/a) and **fabric** (orientation
  rose, mean orientation, R, Rayleigh p), and the D50 **convergence** and **leave-one-photo-out**
  charts in the adequacy section. Sections and figures are numbered in order whatever is left out.
  The site summary CSV gains the shape summary.
- **Printable comparison report** (Compare sites): the compared sites side by side with their
  curves, size distributions and composition; with *Order by survey date*, the **change over time**
  chart and the change between consecutive surveys of each place; the pairwise D16 / D50 / D84
  tests; shape and fabric by site; the like-for-like checks up front; and each site's analysis
  settings side by side, with differences highlighted.
- The Compare sites view and its report share one calculation (`comparisonView.ts`); the D16 and D84
  tests of each pair are matched to the pair by site, not by position in a list.
- `validation/tidy/settings_sweep.mjs`: which analysis settings reduce stray grain fragments, and
  at what cost (none does without one; Tidy outlines is the remedy).

### Navigation, image export and removals

- **Prev flagged / Next flagged** step backwards and forwards through grains that need checking, and a
  **Flagged** list groups them by reason (touches the photo edge; outside the ROI or in an excluded area;
  very elongated), each entry jumping to its grain.
- **Save image** (next to *Display*): the photo as shown on screen (outline colours and opacity,
  ellipses, orientation lines, markers, ROI and exclusions, calibration line) as a PNG at the photo's own
  resolution, for the whole photo or only the visible area, with provenance in the PNG text.
- **Printable report** redesigned: a summary of key figures, numbered sections and figures, every
  percentile D5–D95 with its interval, a table of results by photo, larger photos (two to a row) with
  scale bars, and page numbers.
- The grain-size curve has a **legend** naming the D16 / D50 / D84 points (with their values), the
  confidence band, the photo curves and the detection limit, and a y-axis label.
- The **Legacy inference pipeline** is removed: every analysis uses the Cellpose tiling, which reproduces
  the original ImageGrains software. Older projects and exports that recorded "legacy" still open.

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
- Photos with no counted grains show `—` for D16 / D50 / D84 instead of `NaN`, keep φ class labels when
  calibrated, and the convergence and time-series charts skip undefined values instead of drawing at `NaN`.
- New **ROI** tool (toolbar *Areas → ROI*): draw the sampling area and only grains inside it are counted
  (the engine, exports and ROI tile skipping already supported it, but nothing in the app could draw one).
  *Clear areas* removes a photo's ROI and exclusions, which could not be removed before.
- Split: a line drawn from outside one side of a grain to outside the other now splits it (before, only
  the clicked points were tested, so this cut silently did nothing); a split that does nothing says why.
- GPU check page: when ONNX Runtime falls back to the CPU for the "GPU" run, the check stops and says so,
  instead of comparing CPU with CPU and reporting WebGPU as safe.
- First visit on a host without COOP/COEP headers (GitHub Pages): the one-off reload that enables
  multi-threaded CPU inference waits until the user is on the landing page and idle, instead of
  interrupting work in the workspace; a tab that was in the workspace returns there after a reload.
- Backup reminder and retention: changing a site's statistics settings, name, place or survey date now
  marks it as changed since the last download (before, such a site could be removed automatically as
  "downloaded").
- The printable report's *Print / Save as PDF* button also works when `site_report.html` is opened from
  the results `.zip` or a download.
- After the CPU inference worker crashes or is stopped, the next analysis loads the model again instead of
  failing on the dead worker's session until reload.
- Library build: shared code is emitted to `dist/chunks/`, so `ImageGrainsEngine` with the default
  `useWorker: true` finds `dist/workers/` (it resolved a worker URL outside `dist/`); the build now fails
  if any relative worker URL in `dist/` points to a missing file.
- Photo `grains.csv`: Feret widths are filled in for grains added, split or merged after Feret widths
  were first computed (they were blank), and a new `area_mm2` column matches the site pooled CSV.
- Statistics settings: a cleared or out-of-range number (e.g. an empty *Min b-axis*, which read as 0
  and switched the resolution floor off, or 9,999,999 bootstrap replicates) is refused with a message,
  using the same limits as imported projects; a cleared facies weight is refused too.
- Rectify: corners clicked out of order (a crossed shape) are refused instead of scrambling the photo,
  and output pixels beyond the horizon of a strongly oblique photo stay empty instead of showing an
  upside-down copy. New **Undo rectify** (toolbar) restores the photo as it was before rectification
  (image, scale, areas, metadata and any enhancement backup); the original is kept in browser storage
  and in `.webgrainy` project files.
- `site_summary.csv`: `per_photo` rows for a photo whose name needs quoting (comma, quote, `#`) were
  malformed (`"a,b.jpg"_D50`) and rejected by strict CSV readers (Python `csv` strict mode, DuckDB,
  Polars); the whole metric name is now one quoted cell.
- Cellpose-SAM with *Auto* weights: when the GPU fails during a photo, the retry on the CPU uses the INT8
  weights instead of the 617 MB FP16 file (about 3.8 GB of memory on the CPU).
- *This photo*: the detection limit shown is the cutoff actually applied; when the site's common
  cutoff (set by a coarser photo) or the field-count cutoff raises it, the note says so and gives the
  photo's own limit.
- Binomial percentile intervals (`psd_binomial_ci_*`): order-statistic ranks are now read at the
  right place on the size curve (they were half a grain too fine), and the large-sample formula
  (over 5,000 grains) no longer jumps at the switch.
- GeoTIFF exports (`mask_map.tif`, `mask_webmercator.tif`, `photo_webmercator.tif`) record provenance
  like the other exports: `Software` (app version and commit) and the provenance JSON in
  `ImageDescription`.
- GeoJSON outlines follow the right-hand rule (exterior rings counter-clockwise, holes clockwise) in
  pixel and map coordinates, also for south-up and mirrored GeoTIFFs; pixel-coordinate GeoJSON and
  map GeoJSON in a user-defined CRS carry `"crs": null`, so they are not taken as WGS84 degrees.
- Site statistics on small samples: no Folk & Ward sorting for a single grain; with few photos the
  sorting and kurtosis intervals stay positive (log scale) and skewness stays within [-1, 1]; the
  jackknife no longer gives `NaN` when leaving a photo out leaves only zero-weight facies photos.
- A long unbroken name in the footer or toolbar wraps instead of widening the photo column over the
  Results panel.
- Results panel labels match what is shown: the pooling note says pooling applies to *Whole site*;
  the site histogram title names its basis (area-weighted, by grain count or by grid points); no
  mm / φ axis buttons for pixel sizes; the *Shape* tab shows the whole site in *Whole site*; the
  *Adequacy* tab says it describes the site; the comparison table names the confidence level used;
  the grain card says a border grain is counted when border grains are kept; a photo's facies share
  no longer changes with the photo-list filter.
- TIFF import: CRS names with non-ASCII characters keep the GeoKeys (they were all dropped);
  band-interleaved colour TIFFs and BigTIFFs are refused with a conversion command instead of
  decoding black or failing vaguely; transparent no-data pixels no longer set the 16-bit black point
  and stay transparent through 2× upscaling and Web Mercator export; a projected EPSG CRS without
  ProjLinearUnitsGeoKey gets its unit (metre or foot) from the CRS table, so it is auto-calibrated.
- Surveys over time: an uncalibrated survey between two calibrated ones no longer hides their
  change, a survey with no counted grains is left out instead of giving a `NaN` ratio, and other
  sites' photos are pooled in the site's photo order (as when the site is open), so their
  intervals match.
- Results `.zip`: photo folders are always unique (a crafted name could make the download fail), and
  README.txt describes the CSV metadata, the `|` escape, the *Open* button and the GeoTIFF files
  correctly.
- Seed density 0 (library API or project file) is refused: it made every pixel a seed and found no grains.
- Project import: a scale with a non-positive stored length, a georeference that is singular or has a
  non-positive size, photo-order entries for photos not in the file, and masks that are shared between
  results or do not match their image size are dropped or refused before any mask is decoded.
- The cached-model list counts only the segmentation models (the optional upscaler inflated it), and
  deleting or clearing a model makes a later copy be re-checked by SHA-256 in the same session.
- Offline and updates: the licence and third-party notices linked from *About* are precached, and the
  page itself is served from the same build's cache as its scripts (a newer page with older scripts
  could mismatch); new versions are still found and offered as before.
- Accessibility: the landing drop zone's accessible name matches its visible text; workflow tabs name
  their panels; scrollable dialog bodies can be scrolled from the keyboard; workspace shortcuts no
  longer act while the landing page is shown; contrast fixes for grain-card flags (light), completed
  guide steps (dark), photo errors and remove links (dark) and the GPU check page.
- Docs: the held-out benchmark is described as held-out tiles from the training sites (more than half
  cut from the same source photos as training tiles, so the figures are optimistic), in the README,
  METHODS, the settings guide and every export's accuracy note; the settings guide's accuracy table,
  U-Net figure, CLAHE recipe and *Copy scale to photos…* name are corrected, and a test keeps its
  table in step with the results file.
- Help and citations: the Cellpose-SAM pipeline comparison quotes the right outline scores (0.565 vs
  0.488); the fine-grain enlargement is described as bilinear and about 1.5–2× the time for the photos
  it applies to; every export's citation note adds ImageGrains 2.0 and Cellpose-SAM; the printable
  report lists Cellpose and Cellpose-SAM; Cellpose (2021) lists all four authors in the README and
  CITATION.cff; a chart subtitle sits on its own line instead of colliding with a long title.
- Validation and CI: the pre-processing benchmark's worker script is restored and its paths fixed, the
  edge-case probe uses real sessions again, the false-positive-rate study defaults to the 400 trials
  its results report, `npm run test:perf` runs files one at a time so strict timings do not flake, and
  the GitHub Pages deploy waits for CI to pass on the same commit.
- Polish: the About dialog's citation list is no longer numbered twice; all byte sizes use decimal units;
  the project-file size estimate includes the label masks; opening *Export* before anything is analysed
  no longer ticks the last getting-started step; the landing page lists the real editing shortcuts
  (6–9) and the *Download results…* button, and does not count the empty first site as a saved site.

[0.1.0]: https://github.com/LukeAFullard/webGrainy/releases/tag/v0.1.0
