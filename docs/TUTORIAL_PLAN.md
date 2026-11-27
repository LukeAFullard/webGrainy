# Tutorial videos: what they cover and why

The six original tutorial videos covered the main path (add photos, scale, edit, site results,
surveys over time, download) but left out most of what a new user needs to decide or check:
which model to use, how to take a usable photo, typed and copied scales, rectification, sampling
areas, the grain inspector, display options, every analysis and statistics setting, fine-grain
re-analysis and enhancement, the single-photo charts, bulk photo handling, comparing sites,
exports and the printable report, project files, and help.

This plan comes from going through every control in the app (`src/ui/panels/*`, `src/ui/modals.ts`,
`src/ui/help.ts`) and every section of [SETTINGS_GUIDE.md](SETTINGS_GUIDE.md). It has 25 short videos
(about 1½–3 minutes each, about 50 minutes in all) in six chapters, so each video teaches one task and can
be watched on its own.

| # | Video | Covers |
| ---: | :--- | :--- |
| | **1. Getting started** | |
| 01 | Welcome to webGrainy | What the app measures; privacy and offline use; the overview page and its five steps; status chips; *Skip this overview*; tour of the workspace (left panel, toolbar, photo, results, top bar) |
| 02 | Taking photos that measure well | Shoot straight down; a scale lying flat; smallest grains ≥ 10 px; light and wet stones; 100+ grains and 5+ photos per site; wide-angle lenses; hard conditions; keep originals |
| 03 | Add photos and run your first analysis | *Add Gravel Photos*; photo list and sites; storage notice; *Getting started* checklist; *Analyse*, model download and the progress bar; zoom, pan, *Fit*; D16/D50/D84 and the curve (in pixels) |
| 04 | Choosing a model | Auto / U-Net / CP-SAM and their accuracy; CP-SAM weights FP16 / INT8 / FP4; phones; same model for comparisons; engine chip (GPU / CPU threads); *Models* dialog, offline caching and which weights suit the CPU |
| | **2. Scale** | |
| 05 | Set the scale | *Calibrate*: presets, custom length and units, clicking both ends zoomed in; scale readout; one scale per photo; *Whole site* once all are scaled |
| 06 | Type a known scale, or copy one | *known scale* in mm/px or px/mm and *Set scale*; *Copy scale to photos…* (selection, pre-selection, same camera and height only); GeoTIFFs need no calibration |
| 07 | Straighten a photo taken at an angle | *Rectify*: real width and height, four corners in order, result and scale, *Undo rectify*, rectify before analysing (example photo tilted on purpose) |
| | **3. Areas and outlines** | |
| 08 | Mark the sampling area and leave things out | *ROI* (replaces on redraw), *Exclude* polygon, *Brush*, *Finish shape*, *Clear areas*; skipping areas outside the ROI; grains drawn but not counted; *Exclusion overlap*; exclude vs delete |
| 09 | Inspect grains and find suspect outlines | *Inspect* card (b and a axes, d_eq, Feret widths, area, shape, border); *Prev* / *Next*; *Largest*; *Next / Prev flagged*; *Flagged (n)* list by reason |
| 10 | Fix outlines: split, merge, delete and add | *Split*, *Merge*, *Delete*, *Add*; *Undo* / *Redo*; *Tidy outlines*; Enter, Esc, Ctrl+Z / Ctrl+Y and number keys |
| 11 | Display options and saving an image | Grain IDs, Wentworth size colours, ellipses, orientation lines, edge / too-small markers, outline opacity, magnifier; *Save image* (whole photo or visible area) |
| | **4. Analysis settings** | |
| 12 | Analysis settings explained | Tested defaults; Scale mode; Exclude border grains; Tidy outlines after analysis; Fine-tuning (flow threshold, cellprob, min size, max area fraction, border margin); Advanced; **?** help; *Re-analyse this photo*; *Reset analysis settings* |
| 13 | Fine grains and image enhancement | *Re-analyse enlarged ×1.5* and its *Undo*; Scale mode 1.0x; experimental *Deblur*, *Revert* and *2× Upscale* |
| | **5. Results** | |
| 14 | Read the results for one photo | *This photo*; n and left-out grains; D-values; size metric note; curve, mm / φ axis; SVG / PNG chart export; detection limit; histogram classes; Folk & Ward; *More statistics*; Shape and Fabric tabs |
| 15 | Whole-site results | Site name, place and survey date; *Whole site* pooling; confidence interval and few-photo warning; per-photo lines; Adequacy tab: convergence and photo influence |
| 16 | Statistics settings | Pooling modes (incl. facies weights); size metric; field-count cutoff; min b-axis; exclusion overlap; harmonize cutoff; uncertainty and sampling (confidence, bootstrap, seed, two-stage, Wolman points) |
| 17 | Working with many photos and sites | Photo summary filters; include / leave out; *Select* and bulk actions (include, leave out, re-analyse, tidy, delete); removing a photo; *+ New* site; switching sites; *Analyse all sites*; *Rename* |
| 18 | Compare sites | *Compare sites*; site picker and colours; comparison table; same size range; overlaid curves and distributions; *Differences between sites*; printable comparison report; comparison CSV |
| 19 | Compare surveys over time | Place names; *+ New survey of this place*; survey dates; *Compare surveys over time*; grain size over time; test reliability; comparison CSV and report |
| | **6. Keeping and sharing results** | |
| 20 | Download your results | Browser as a working space; *Results downloaded*; *Stored until* and *Keep longer*; retention choices; *Download results…* zip and its contents; project file option; storage line |
| 21 | Exports and the printable report | *Export* dialog: site and photo tables (with provenance), outlines / mask / photo, counted-only option, printable report options, the printable site report |
| 22 | GeoTIFFs and GIS | Scale from georeferencing; outlines in longitude / latitude or map coordinates; GeoPackage; label mask GeoTIFF and Web Mercator; *Site GeoPackage*; map files in the zip |
| 23 | Save and reopen a project | *.webgrainy* archive (contents, size, GPS privacy); in *Download results*; *Open* to reopen; overview page drop and *Open .webgrainy Project* |
| 24 | Help, shortcuts and good practice | *Help* topics and **?** buttons; getting-started guide; keyboard shortcuts; *About* and citations; checklist before reporting, comparing like with like, what to report |
| 25 | Open your results in a GIS | A GeoTIFF photo (scale from georeferencing); downloading the *Site GeoPackage* and the photo as a Web Mercator GeoTIFF; adding both to RustGIS (web.rustgis.app); *Zoom To Layer*; outlines over the photo; the attribute table |

**Not shown on screen** (mentioned in captions instead, because the recorder cannot do them
without extra downloads or hardware): running Cellpose-SAM (a 183–617 MB download), *2× Upscale* (downloads the PULSE model), system notifications and the storage-full flow.

Tutorial 25 records a third-party site, RustGIS, whose interface is drawn on a canvas: the script
clicks screen positions measured in November 2026 (see the top of `25-results-in-gis.mjs`), so a
change to RustGIS's layout can break it.

## Recording

See [README.md](../README.md#tutorial-videos). Each video starts with the webGrainy logo and name
and the tutorial's title, and ends with the logo, the app's address and the next tutorial. Every
caption and card is written out with its timing (`.srt`, `.vtt`, `.transcript.md`, `.transcript.json`)
for subtitles or a voiceover; captions stay up long enough to be read aloud at `TUTORIAL_WPS` words
per second (default 2.5). [`scripts/tutorials/webGrainy_tutorial_videos.ipynb`](../scripts/tutorials/webGrainy_tutorial_videos.ipynb)
records them all in Google Colab and saves them to Google Drive.
