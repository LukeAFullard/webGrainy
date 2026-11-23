# webGrainy — ImageGrains 2.0 in the browser

**Live app:** <https://lukeafullard.github.io/webGrainy/> · **GPU check:** <https://lukeafullard.github.io/webGrainy/gpucheck.html> (tests whether your graphics card gives the same results as the CPU)

webGrainy measures gravel and other coarse sediment from photos, entirely in the web browser. It runs the pretrained [ImageGrains 2.0](https://github.com/dmair1989/imagegrains) segmentation models (U-Net and Cellpose-SAM) with ONNX Runtime Web, outlines every grain, and reports grain-size distributions and statistics for single photos, whole sites, and sites compared over time.

Photos and results never leave your device. The only network requests are the one-time downloads of the pinned, checksum-verified model files from Hugging Face; after that the app works offline.

> **Status: first release, v0.1.0 (19 December 2026).** See [CHANGELOG.md](CHANGELOG.md). Results, file formats and settings may still change in later versions.

> **Disclaimer.** webGrainy is an independent, unofficial port. It is not affiliated with or endorsed by the ImageGrains or Cellpose authors. Its post-processing differs from the official Python implementation, so outlines and sizes are close to, but not identical with, ImageGrains output. Please cite the original work (see [Citations](#citations)).

---

## What it does

- **Segmentation.**
  - U-Net (fast) or Cellpose-SAM (more accurate). Cellpose-SAM comes as FP16 weights for WebGPU, or as INT8 / FP4 weights that are smaller and match FP16 accuracy.
  - The tiling reproduces Cellpose's own pipeline.
  - Inference runs on the GPU (WebGPU) where supported, otherwise on the CPU (WebAssembly) in a background worker, so the page stays responsive.
- **Measurement.**
  - Per grain: b-axis (moment-ellipse minor axis), minimum and maximum Feret width, equal-area diameter, shape and orientation.
  - Sizes are in mm after two-point calibration, perspective rectification, or from GeoTIFF georeferencing.
- **Editing.** Split, merge, delete and draw grains, with undo/redo. Regions of interest and exclusion areas.
- **Statistics.**
  - Area-weighted (grid-by-number) and number-weighted percentiles D5–D95.
  - Folk & Ward statistics, Wentworth classes, moment statistics and fabric (orientation).
  - Site-level pooling with bootstrap and binomial confidence intervals, a jackknife, a convergence curve and sample-adequacy checks.
- **Sites and surveys.**
  - Each site is one survey. Repeat surveys of a place share a place name and can be followed over time.
  - Sites are compared side by side and over time like for like: same statistics settings and common size range, with a warning when photos were analysed differently.
- **Exports.**
  - Per-grain and summary CSV/JSON, label-mask PNGs, GeoJSON/SVG outlines, chart images and a printable report.
  - Every export records the app version and commit, model and its SHA-256, and all settings.
  - Projects can be saved and reopened as `.webgrainy` files.

A plain-language guide to every setting is in **[docs/SETTINGS_GUIDE.md](docs/SETTINGS_GUIDE.md)**.
How every step works (models, outlines, measurements, statistics, uncertainty, comparisons), for writing up your methods, is in **[docs/METHODS.md](docs/METHODS.md)**.

---

## Accuracy

Measured on the held-out test split of the ImageGrains 2.0 data (`IG2_data.zip`, 40 images from 13 sites) against hand-digitised grain outlines. Errors are absolute percentage errors of each image's area-weighted b-axis percentile (in pixels); PQ is panoptic quality of the outlines.

**The app as shipped** (default settings, the numbers the app reports: log2 interpolation, interior grains, grains under 15 px left out of both prediction and hand outlines; 95% intervals resample whole sites, since photos of one site are not independent; [`validation/heldout/heldout_app_results.md`](validation/heldout/heldout_app_results.md)):

| Model | D50 error: mean [95% CI] | D50 error: median [95% CI] | D16 / D84 median error | D50 error > 50% | PQ vs hand outlines |
| :--- | :--- | :--- | :--- | ---: | ---: |
| U-Net | 15.6% [7.3, 25.1] | 5.7% [2.8, 19.3] | 8.4% / 2.4% | 10% of images | 0.540 |
| Cellpose-SAM (INT8) | 8.9% [3.7, 14.9] | 2.9% [1.9, 5.3] | 5.1% / 1.1% | 5% of images | 0.654 |

**Earlier benchmark with the upstream PyTorch ImageGrains for reference** (linear interpolation, no size cutoff, intervals resampling images rather than sites, so not directly comparable with the table above):

| Model | Engine | D50 error: mean [95% CI] | D50 error: median [95% CI] | D16 / D84 median error | PQ vs hand outlines |
| :--- | :--- | :--- | :--- | :--- | ---: |
| U-Net | webGrainy | 24.4% [13.7, 39.2] | 9.4% [5.3, 14.9] | 23.8% / 2.9% | 0.539 |
| U-Net | ImageGrains (PyTorch) | 27.5% [14.8, 46.3] | 9.3% [6.3, 17.0] | 21.5% / 3.3% | 0.528 |
| Cellpose-SAM | webGrainy | 8.9% [4.0, 15.6] | 2.9% [2.0, 4.9] | 6.3% / 1.3% | 0.652 |
| Cellpose-SAM | ImageGrains (PyTorch) | 14.3% [8.0, 21.8] | 4.4% [2.4, 8.3] | 8.7% / 2.0% | 0.642 |

- **Within-site, not unseen sites.** All 13 sites also contributed training images, and more than half of the test images (at least 22 of 40) are tiles cut from the same source photo, orthomosaic or CT scan as training tiles. These figures therefore describe held-out tiles of familiar beds, closer to an optimistic within-photo estimate than to new photos, and say nothing about new rivers.
- **Tails are long.** 5% of Cellpose-SAM images and 10% of U-Net images have D50 errors above 50% (17.5% of U-Net images in the earlier benchmark below). Check the outlines.
- **Quantized weights.** INT8 and FP4 Cellpose-SAM give the same benchmark accuracy as FP16 (outline agreement with FP16: PQ 0.994 and 0.966).
- **Field comparison (one site).** At the K1 site, with the field count's 13 mm minimum applied to the photos, the app's D50 agrees with a 251-stone pebble count within 3% and D84 within 5–6% (both models). Without that cutoff, Cellpose-SAM's D50 is 31% finer and U-Net's 22% finer, because the photos include the many grains below 13 mm the count skipped. This is a consistency check, not an independent validation: both photos overlap the ImageGrains training data. To compare with a field count, set **Field-count cutoff (mm)** to its minimum size. Details: [`validation/k1/k1_app_results.md`](validation/k1/k1_app_results.md).
- **Reproduce.** `node validation/heldout/run_app_heldout.mjs unet` (or `cpsam`) and `validation/heldout/score_app_heldout.py`; the data are fetched from Zenodo by `validation/parity/fetch_ig2_files.py`.

## Limitations

- **b-axis is not a sieve or caliper b-axis.** It is the minor axis of the ellipse fitted to the visible 2D outline. Partial burial, imbrication and the 2D view of 3D grains add bias. Minimum Feret width is the closest 2D equivalent of a caliper b-axis.
- **Fine grains are truncated.** Grains smaller than the detection limit (shown in the app, in mm) are missed, and grains up to a few times that size are partly missed, so D5–D16 are biased coarse. Large photos are analysed at up to 1024 px unless you choose a larger image scale, so a 12–48 MP photo is analysed at 0.13–0.25×. The accuracy benchmark above used mostly 512 px images at full resolution. To describe the fine tail, set **Field-count cutoff (mm)** to at least about 3× the detection limit.
- **The browser is not an archive.** Photos and results stay in the browser only for a set number of days after a site was last used (30 by default). After that a site is removed automatically only if its results were downloaded after its last change; otherwise the app keeps it and asks you to download, keep or remove it. Use **Download results…** to keep your results; keep your original photos in your own folders.
- **Lens distortion is not corrected.** It is small for most phones, but wide-angle and action cameras can bias sizes by 7–22%. Undistort such photos first. Oblique photos must be rectified.
- **Hard conditions:** wet or shiny surfaces, strong shadows, vegetation, sand matrix, single grains covering a large part of the frame, and fewer than about 100 grains.

**Before using absolute values in publications:** calibrate the scale, inspect and correct the outlines, report n and the model hash (both are in every export), and check against field measurements at your site.

---

## Development

```bash
npm ci
npm run typecheck          # TypeScript (strict)
npm test                   # unit, numerical-parity and end-to-end tests (Vitest)
npm run build              # builds the static app into dist/
npm run test:e2e:browser   # headless Chromium on dist/ with a real U-Net analysis
                           # (SMOKE_MODEL=cpsam for Cellpose-SAM)
npm run test:e2e:sw        # service-worker updates with two builds and several tabs (dist/)
npm run test:perf          # strict timing budgets (run on an idle machine)
```

CI runs all of these except `test:perf` on every push and pull request. The app is a static site: [DEPLOYMENT.md](DEPLOYMENT.md) explains hosting, including the headers needed for multi-threaded CPU inference.

### Tutorial videos

Six short, silent tutorial videos (1280×720 MP4, about a minute each) are generated from the built app, so they can be re-recorded whenever the interface changes:

```bash
npm run build
npm run tutorials          # all six, into tutorials/out/
npm run tutorials -- 03    # only those whose file name contains "03"
```

| File | Shows |
| --- | --- |
| `01-first-analysis` | adding photos and running a first analysis |
| `02-set-scale` | calibrating each photo from a ruler; Copy scale and Rectify |
| `03-edit-outlines` | Inspect, Split, Merge, Delete, excluding the ruler, Flagged grains |
| `04-site-results` | naming a site; Whole-site results, confidence interval, adequacy, settings |
| `05-compare-surveys` | a second survey of the same place and the comparison over time |
| `06-download-and-gis` | the results .zip, and GeoJSON in map coordinates from a GeoTIFF |

Each tutorial is a Playwright script in `scripts/tutorials/` that drives headless Chromium. Frames come from the Chrome DevTools screencast; an overlay draws the cursor, clicks, captions, highlights and title cards, and ffmpeg (which must be installed) encodes the MP4. Model waits are sped up and say so on screen. The sample photos are two ImageGrains demo images (K1 site; BSD-3-Clause, © 2023 David Mair), downloaded from a pinned commit and checked by SHA-256. Tutorial 6 turns one into an example GeoTIFF at an invented location. Videos are not committed: attach them to a release or upload them elsewhere.

### Repository layout

```text
src/modules/     analysis engine and data (no UI): models, inference, post-processing,
                 measurements, statistics, sites, exports, storage
src/ui/          the browser app: state, panels, event handlers, charts, canvas
src/workers/     post-processing and CPU-inference workers
tests/           Vitest unit, parity and end-to-end tests
scripts/         browser smoke tests of the built app; tutorial-video recorder
validation/      benchmarks and their data: held-out accuracy, parity with upstream
                 Cellpose/ImageGrains, K1 field comparison, preprocessing and
                 quantization studies, GPU-vs-CPU checks, numerical oracle
docs/            settings guide
```

### Library use

The engine can be used without the app:

```ts
import { ImageGrainsEngine, ScaleCalibrator, analyzeSite, photoCutoffs, DEFAULT_SITE_OPTIONS } from './dist/index.js';

const engine = new ImageGrainsEngine({ sessionCreateOptions: { wasmPaths: './ort/' } });
await engine.initialize();

const session = await engine.analyzeImage(imageBitmap, {
  model: 'auto', // 'unet' or 'cpsam'
  calibration: ScaleCalibrator.calibrate({ x: 100, y: 200 }, { x: 600, y: 200 }, 250), // 250 mm
});

// The app's numbers for this photo: grains under 15 px are not counted and, when the photo is
// calibrated, neither are grains under its detection limit in mm (the site's common cutoff).
const photos = [{ photoId: 'p1', label: 'photo1.jpg', included: true, session }];
const site = analyzeSite(photos, DEFAULT_SITE_OPTIONS); // several photos: one entry each
const cutoffs = photoCutoffs(DEFAULT_SITE_OPTIONS, site, 'p1');
const stats = session.getStats('bAxis', cutoffs);
console.log('D50', stats.areaWeightedB.D50, stats.unit, 'n =', stats.includedGrains);
console.log('site D50', site.psd.D50, 'interval', site.bootstrapCi.lower.D50, site.bootstrapCi.upper.D50);
const csv = session.exportCsv({ includeMetadata: true, cutoffs });
```

---

## Citations

If you use webGrainy in scientific work, please cite the ImageGrains and Cellpose papers (the methods and model weights), and optionally this software ([CITATION.cff](CITATION.cff)):

- Mair, D., Witz, G., Do Prado, A., Garefalakis, P., Wild, A., Ville, F., Schuster, B., Horn, M., Österle, J., Fabbri, S. C., Litty, C., Achleitner, S., Leistner, S., Hiller, C., and Schlunegger, F. (2026): *ImageGrains 2.0: Improved precision and generalization for grain segmentation*, Earth Surf. Dyn., 14, 527–551, https://doi.org/10.5194/esurf-14-527-2026
- Mair, D., Witz, G., Do Prado, A.H., Garefalakis, P. & Schlunegger, F. (2023): *Automated detecting, segmenting and measuring of grains in images of fluvial sediments*, Earth Surface Processes and Landforms, https://doi.org/10.1002/esp.5755
- Pachitariu, M., Rariden, M., Stringer, C. (2025): *Cellpose-SAM: superhuman generalization for cellular segmentation*, bioRxiv, https://doi.org/10.1101/2025.04.28.651001
- Stringer, C.A., Pachitariu, M. (2021): *Cellpose: a generalist algorithm for cellular segmentation*, Nat Methods 18, 100–106, https://doi.org/10.1038/s41592-020-01018-x

Model weights: ImageGrains 2.0 pretrained models, https://doi.org/10.5281/zenodo.15728186, converted to ONNX at [`inYourOwnBrowser/imagegrains-2.0-onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx).

## License

BSD 3-Clause ([LICENSE](LICENSE)). Third-party components and model weights are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
