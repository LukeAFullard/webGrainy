# webGrainy User Guide: Settings and When to Change Them

This guide explains every setting in webGrainy: what it does, its default, and when it
makes sense to change it. It is written for new users. You don't need to know how the
underlying neural networks work.

> **The short version:** the defaults are the settings that were tested. For most gravel
> photos you only need to do three things:
> 1. **calibrate the scale**,
> 2. **check the outlines** and fix obvious mistakes,
> 3. **set the field-count cutoff** if you will compare with a pebble count.
>
> Change other settings only for the reasons given below, and write down what you changed.

> **Help inside the app:** every setting has a small **?** button next to it. Click it
> for the same explanation as in this guide: what the setting does, its default, and when
> to change it. The **Help** button (top bar) and **Settings help** (analysis panel) list
> all settings in one place.

---

## 1. What webGrainy does

webGrainy takes a top-down photo of a gravel or cobble surface and:

1. **finds and outlines every visible grain** using a neural network (ImageGrains 2.0);
2. **measures each grain** (size, shape, orientation);
3. **turns the measurements into a grain-size distribution** (D16, D50, D84, …), with
   uncertainty, for a single photo or for a whole site of several photos.

Everything runs in your browser. Photos and results never leave your computer. The only
download is the model itself, fetched once and then stored for offline use.

### Typical workflow
The **Getting started** checklist at the top of the left panel walks through these steps
and ticks them off as you go. Hide it with *Hide*; bring it back from *Help*.

1. **Create a site** (`+ New`) and **add photos** (`Add photos`, or drag them onto the photo list).
2. **Calibrate each photo** (`Scale → Calibrate`). Without this, all sizes are in pixels.
3. **Rectify oblique photos** (`Scale → Rectify`) if the camera was not pointing straight down.
4. **Exclude non-gravel areas** (`Exclude → Area` or `Brush`): boots, rulers, vegetation,
   water. Doing this before analysing is faster (areas far from the counted area are skipped).
5. **Run the analysis** (`Analyse` in the photo list). A bar at the bottom of the screen shows
   the current step, the tiles done and the time left, with a Cancel button.
6. **Check the outlines.** The `Edit grains` tools (Split, Merge, Delete, Add) appear once a
   photo is analysed.
7. **Read the results** on the right (*Whole site* or *This photo*) and **export** them.

Rarely needed options are folded away: *Analysis settings* (left), *Fine-tuning* and
*Advanced* inside it, *Statistics settings* (right) and *Display* (above the photo). Each
folded section shows a one-line summary, e.g. "tested defaults" or "2 settings changed".

---

## 2. Before you start: taking good photos

Settings cannot fix a poor photo. For best results:

- **Shoot straight down.** If you can't, include four reference points for rectification.
- **Include a scale** (ruler, quadrat frame or coin) lying flat on the gravel, near the middle of the photo.
- **Prefer even, diffuse light** (overcast or shade). Avoid hard shadows and wet, shiny stones.
- **Get enough grains:** aim for **at least 100 grains fully inside the frame** per site, ideally several hundred.
- **Make the smallest grains you care about at least ~10 pixels across.** Get closer if they aren't.
- **Avoid wide-angle and fisheye lenses** (e.g. GoPro). They distort sizes towards the edges by 10–30%.
  Normal phone cameras and most drone cameras are fine (typically under 1–4% error).

---

## 3. Analysis settings (left panel, "Analysis settings"; tuning values under "Fine-tuning")

These control how grains are found and outlined. They take effect the next time you
analyse a photo. They do not change photos that are already analysed.

### Model
| | |
|---|---|
| **Options** | `Auto (Router)` · `U-Net (25 MB)` · `CP-SAM` |
| **Default** | `Auto` |
| **What it does** | Chooses which neural network finds the grains. |

- **CP-SAM (Cellpose-SAM)** is the **more accurate** model. On the test set its median D50
  error was about 3%. It is a larger download (183–617 MB, see *CP-SAM weights*) and needs a computer with a
  reasonably modern graphics card for good speed. Without a suitable graphics card it
  still works, but runs on the processor and takes **several minutes per photo**.
- **U-Net** is **small and fast** and works on almost any device, including phones. It is
  **less accurate**: median D50 error was about 15%.
- **Auto** picks one based on the photo and your hardware. It avoids CP-SAM when your
  device can't run it efficiently, and **always picks U-Net on phones and tablets**:
  CP-SAM needs about 1.5 GB of memory and can take 10+ minutes per photo on a phone,
  and mobile browsers often close the tab first. You can still choose CP-SAM by hand
  (it then uses the smaller INT8 weights).

**When to change it:** choose **CP-SAM** for any result you will report or publish. Use
**U-Net** for a quick first look, on a phone, or when you just need a rough estimate.
Use the same model for all photos you want to compare.

### CP-SAM weights
| | |
|---|---|
| **Options** | `Auto` (GPU: FP16, CPU: INT8) · `FP16 (617 MB)` · `INT8 (316 MB)` · `FP4 (183 MB)` |
| **Default** | `Auto` |
| **What it does** | Chooses which copy of the Cellpose-SAM network to download and run. Only used when the model is CP-SAM. |

FP16 is the original network. INT8 and FP4 store the same network in compressed form.
On the 40-photo benchmark all three gave **the same accuracy** (outline score 0.652–0.653,
median D50 error 2.8–2.9%; the differences are within measurement noise).

| | FP16 | INT8 | FP4 |
|---|---|---|---|
| Download | 617 MB | 316 MB | 183 MB |
| Memory while running (CPU) | about 3.8 GB | **about 2.1 GB** | about 3.7 GB |
| Speed on the CPU | baseline | same to about 2× faster | same to about 2× faster |
| Loading time | slowest | **fastest** | middle |

- **Auto** uses FP16 on a graphics card that supports WebGPU float16, and INT8 otherwise.
- **INT8** is the best choice on the processor (no suitable graphics card). It needs about
  half the memory and half the download of FP16. Its speed is the same or better: up to
  about 2× faster in the benchmark, but the same on a 4-core test machine.
- **FP4** has the smallest download, for slow or metered connections. It needs about as much
  memory as FP16 while running, so use it on computers with at least 8 GB of memory.

**When to change it:** usually never. On a graphics card, FP16 has been checked against the
processor on real hardware; INT8 and FP4 have not yet. You can check yours on the GPU check
page. Keep the same choice for all photos you compare. The weight file used is recorded in
every export.

### Scale Mode
| | |
|---|---|
| **Options** | `Auto (≤1024px)` · `1.0x Full` · `0.5x` · `0.25x` |
| **Default** | `Auto` (shrinks photos so the longest side is at most 1024 pixels) |
| **What it does** | Sets the resolution the model works at. Results are always converted back to the original photo's pixels and to mm. |

**When to change it:**
- **`1.0x Full`** keeps small grains detectable when the photo has many small grains and
  is larger than 1024 px. It is slower and uses more memory.
- **`0.5x` / `0.25x`** suit photos of large cobbles or boulders taken from close up,
  where single stones are hundreds of pixels across. The model sees large stones better
  when they appear smaller.

> Shrinking the photo also raises the smallest grain that can be detected (see
> *Min Size*). If fine gravel matters to you, avoid heavy downscaling.

### Flow Threshold
| | |
|---|---|
| **Range** | 0.05 – 1.0 |
| **Default** | **0.45** |
| **What it does** | A quality check on each candidate grain. Higher values accept more candidates (including odd-shaped or doubtful ones). Lower values keep only clean, convincing outlines. |

**When to change it:**
- **Raise it (e.g. 0.6)** if obvious grains are **missing** and the gaps are not shadows or sand.
- **Lower it (e.g. 0.3)** if you see many **ragged or nonsensical outlines**.

Change it in small steps and check the outlines each time.

### Cellprob Thresh (cell probability threshold)
| | |
|---|---|
| **Range** | −4 to +4 |
| **Default** | **0** |
| **What it does** | How confident the model must be that a pixel belongs to a grain. Lower values include more of the image as "grain". Higher values are stricter. |

**When to change it:**
- **Lower it (e.g. −1)** if outlines are **too small**, cutting off grain edges, or if
  dark or low-contrast stones are missed.
- **Raise it (e.g. +1)** if outlines **bleed into the sand or shadow** between grains.

### Min Size (px²)
| | |
|---|---|
| **Range** | 4 – 500 |
| **Default** | **30** (pixel area at the working resolution, i.e. about 6 px across) |
| **What it does** | Discards detected objects smaller than this area. This sets the smallest grain the app can report. |

**When to change it:**
- **Lower it (e.g. 15)** for sharp, close-up photos where you want the finest grains.
  It may add some noise.
- **Raise it** if the photo is grainy or noisy and you see lots of tiny false grains.

> Fine grains near this limit are always under-counted. Treat D16 and finer as
> approximate unless you have checked them.

### Max Area Frac (maximum grain area fraction)
| | |
|---|---|
| **Range** | 0.01 – 1.0 |
| **Default** | **0.40** (no single grain may cover more than 40% of the photo) |
| **What it does** | A safety limit that stops large non-grain areas (a sand patch, water, a big shadow) being treated as one giant "grain". |

**When to change it:**
- **Raise it to 1.0** if a **single boulder genuinely covers more than 40% of the
  photo** and it is being left out.
- **Lower it (e.g. 0.15)** if you see **huge false grains** covering sand or water.
  Be aware this will also drop any real large stones above that size.

*Evidence:* the earlier default of 0.15 silently dropped real cobbles in 10 of 40 test
images. That doubled the average D50 error of Cellpose-SAM. The value 0.40 matches the
upstream Cellpose default.

### Apply CLAHE / CLAHE Clip
| | |
|---|---|
| **Default** | **Off**; clip limit **2.0** (range 1–8) |
| **What it does** | Boosts local contrast before analysis, which helps in harsh light. |

**When to change it:** turn it on for photos with **strong shadows, glare, or very flat,
low-contrast lighting** where grains are missed. Increase the clip limit (3–4) for
stronger enhancement. Leave it off for normal, evenly lit photos. It was not part of the
accuracy testing.

### Exclude border grains / Border margin (px)
| | |
|---|---|
| **Default** | **On**, margin **2 px** (working resolution) |
| **What it does** | Leaves out grains touching the photo edge. They are cut off by the frame, so they look smaller than they are. The margin sets how close to the edge counts as "touching". |

**When to change it:**
- **Keep the switch on** for normal use. Turn it off only if the photo edge coincides
  with a real boundary of your sample area. The switch applies immediately to photos
  that are already analysed.
- **Increase the margin** (5–10 px) if the photo edges are blurred, vignetted or
  distorted. The margin applies the next time photos are analysed.

### Advanced: Inference pipeline
| | |
|---|---|
| **Options** | `Cellpose (matches ImageGrains)` · `Legacy (webGrainy ≤ v1.1)` |
| **Default** | **Cellpose** |
| **What it does** | How the photo is prepared and cut into tiles before the neural network runs. "Cellpose" reproduces the original ImageGrains/Cellpose software exactly: identical grain outlines to the original in tests. |

**When to change it:** keep **Cellpose**. In tests on 7 photos it gave clearly better
outlines and D50 than Legacy (median D50 error 3.3 % vs 8.6 % for Cellpose-SAM). Choose
**Legacy** only to reproduce results made with webGrainy v1.1 or earlier.

### Advanced (rarely needed): Flow steps, Seed density
| | |
|---|---|
| **Defaults** | Flow steps **250**, Seed density **2** (the tested values) |
| **What they do** | Internal post-processing settings. *Flow steps* is how far each pixel is traced towards the centre of its grain. *Seed density* is how many pixels must meet at one point before a new grain is started. |

**When to change them:**
- **Flow steps:** increase (e.g. 400) if very large or elongated stones are split into pieces.
- **Seed density:** increase (e.g. 4–6) if noise creates many tiny fragment grains.

Leave both at the defaults otherwise. **Reset analysis settings to defaults** restores
every analysis setting to the tested values.

### Advanced: CPU threads
| | |
|---|---|
| **Options** | `Auto` · `1` … all processor threads |
| **Default** | `Auto`: one fewer than the processor threads, at most 8 (e.g. 3 on a 4-thread computer or phone) |
| **What it does** | How many processor threads the network uses when it runs on the CPU (no graphics card). Saved in this browser. **Takes effect after you reload the page.** |

**When to change it:** lower it if the device becomes unresponsive or hot during analysis.
Raise it (up to all threads) on a computer you aren't using for anything else, for a little
more speed. More threads than physical cores rarely helps. It has no effect when a graphics
card runs the model. Multi-threading also needs a cross-origin isolated page, which the app
sets up automatically (the top bar shows the thread count).

### Advanced: Skip areas outside the ROI
| | |
|---|---|
| **Default** | **On** |
| **What it does** | When a photo has a region of interest (ROI) or exclusion areas (section 6), the network only runs near the area that is counted, plus a 128-pixel safety margin. |

Grains inside the ROI get **exactly the same outlines** as a full analysis, unless they reach
more than 128 pixels outside the ROI. The time saved is roughly the share of the photo that
is far (more than 128 pixels plus one tile) from the ROI, so it helps most on large photos
with small ROIs or large exclusions.

**Draw the ROI before analysing.** If you enlarge the ROI or remove an exclusion afterwards,
the dashboard warns that part of the new area was not analysed; re-analyse that photo. Turn
the option off if you expect to change ROIs a lot after analysing, or if grains much larger
than 256 pixels cross the ROI edge.

---

## 4. Scale and geometry tools (toolbar)

### Calibrate
**Always do this.** Without calibration, every size is in **pixels**, not millimetres,
and some statistics (Folk & Ward, Wentworth classes) are switched off.

1. Pick a preset (`100 mm Ruler`, `25 mm Coin`, `500 mm Quadrat`) or `Custom…`.
2. Click the two ends of the known length on the photo.

**Tips:**
- Measure the **longest** reference you can. Short references give larger errors.
- Put the reference **flat on the gravel**, not raised above it.
- **Copy Scale to Site** applies one photo's scale to all photos in the site. Only use it
  if every photo was taken at the **same height with the same camera and zoom**.

### 4-Pt Rectify
Corrects photos taken at an angle. Click four points that form a rectangle on the ground
(e.g. the corners of a quadrat). The photo is straightened and must then be re-analysed.
**Use it** whenever the camera was noticeably tilted. Perspective makes far grains look
smaller.

---

## 5. Checking and editing grains (toolbar)

The model makes mistakes, so always look at the outlines. All edits can be undone and
redone, and statistics update immediately.

| Tool | Use it when… |
|---|---|
| **Inspect** | You want to click a grain and see its measurements. |
| **Split** | Two or more stones were outlined as one. Draw a line across where they meet. |
| **Merge** | One stone was cut into pieces. Select the pieces, then press `Merge`. |
| **Delete** | Something that isn't a grain was outlined (a leaf, a ruler, a shadow). |
| **Add** | A grain was missed. Draw around it, then press *Finish shape* (or double-click / Enter). |

---

## 6. Excluding areas (toolbar)

| Tool | Use it when… |
|---|---|
| **Exclude → Area** | You want to remove a region: a ruler, boot, quadrat frame, vegetation, water or deep shadow. Draw around it. |
| **Exclude → Brush** | You want to paint over smaller or irregular areas to remove them. |

Grains with more than 10% of their area inside an excluded region are left out of the statistics (exports flag them). The 10% can be changed with **Exclusion overlap** in the dashboard. The
dashboard shows how many were excluded. Excluding is better than deleting for objects
like rulers, because it also stops the area from counting as "bed".

---

## 7. Site statistics settings (dashboard, right-hand panel)

These settings control how measurements are turned into a grain-size distribution,
especially when several photos are combined into one site result.

### Pooling Mode
| Option | What it means | When to use it |
|---|---|---|
| **Physical Area-Weighted** *(default)* | Each grain counts in proportion to its visible area. This is the photo equivalent of a **grid / Wolman pebble count** (Kellerhals & Bray 1971). | **Most cases.** Use it for comparison with pebble counts or for standard sediment reporting. |
| **Equal-Photo Weighted** | Each photo contributes equally, whatever its size or number of grains. | Photos cover very different areas, and you want each location to count the same. |
| **Virtual Wolman Grid** | Simulates a pebble count: a virtual grid is laid over each photo and the grain under each point is counted. | You want results that mimic a field pebble count as closely as possible. |
| **Number-Weighted** | Every grain counts once, whatever its size. | **Rarely.** This gives much finer results and is **not comparable** with pebble counts or sieving. Use it only if you specifically need a by-count distribution. |
| **Facies-Weighted** | Photos are weighted by a "facies weight" (e.g. how much of the reach each surface type covers). | Stratified sampling of a reach with distinct surface patches. When this mode is selected, a **Facies weight** box appears under each photo in the photo list (default 1). |

### Size Metric
| Option | What it measures | Notes |
|---|---|---|
| **b-axis (ellipse minor)** *(default)* | The short axis of an ellipse fitted to the grain outline. | Standard for photo-sieving and comparable with other image tools. It is **not** exactly what a caliper measures: it can differ by about ±15% depending on shape. |
| **min-Feret (caliper width)** | The narrowest width of the outline, like closing calipers on the stone from above. | Closest to a hand-measured b-axis. On the test set, D50 was typically 3–4% larger than the ellipse b-axis. |
| **d_eq (equal-area circle)** | The diameter of a circle with the same area as the grain. | Useful for area-based comparisons. Typically about 23% larger than the b-axis. |

**When to change it:** keep **b-axis** for consistency with published photo-sieving work.
Use **min-Feret** when comparing directly with caliper measurements. Whichever you
choose, **report it**: the three give different numbers for the same stones.

> All sizes are measured on the **visible, top-down outline**. Partly buried or
> overlapping stones look smaller than they really are.

### Min b-axis (px)
| | |
|---|---|
| **Range** | 0 – 50 |
| **Default** | **15** pixels |
| **What it does** | Grains smaller than this (in original photo pixels) are left out of the site statistics because they are too small to measure reliably. They are shown as "truncated" in the overlay. |

**When to change it:** lower it (e.g. 10) for very sharp, high-resolution photos. Raise
it if small grains look unreliable.

### Harmonize Cutoff
| | |
|---|---|
| **Default** | **On** |
| **What it does** | When photos have different scales, the smallest reliably measurable size (in mm) differs between them. This option applies the **largest** of those cutoffs to every photo, so all photos describe the same size range. |

**When to change it:** keep it on when combining photos taken at different heights or
zooms. Turning it off includes more fine grains from the sharper photos, but the site
result then mixes different size ranges.

### Field-count cutoff (mm)
| | |
|---|---|
| **Range** | 0 – 256 mm |
| **Default** | **0** (off) |
| **What it does** | Leaves out all grains smaller than this size. |

**Set this to the smallest stone your field method records** whenever you compare with,
or want results like, a **pebble count**. Typical values are 8–16 mm. Field pebble counts
usually skip small material, while the photo includes it. That alone can make the photo
D50 look **about 40% finer**: this happened at the K1 test site. With a matching 13 mm
cutoff, the photo D50 agreed with the field D50 within about 3–4%.

Leave it at **0** if you want to describe everything visible down to the detection limit.

### Exclusion overlap
| | |
|---|---|
| **Range** | 0 – 1 |
| **Default** | **0.10** |
| **What it does** | How much of a grain may overlap an excluded area (ruler, boot, vegetation…) before the grain is left out. At 0.10, a grain is dropped if more than 10% of it is inside an excluded region. |

**When to change it:**
- **Lower it to 0** to drop any grain that touches an exclusion, e.g. when the exclusion
  marks a disturbed patch.
- **Raise it (e.g. 0.5)** if your exclusions are rough and clip the edges of real grains
  you want to keep.

Changes apply immediately.

### Compare sites (Results → Compare sites)

Tick the sites to compare. Their cumulative grain-size curves (with confidence bands) and
size distributions are overlaid in different colours, and a table lists photos and grains,
D16, D50 with its 95% interval, D84, geometric mean and spread, Sauter mean, sorting and
gravel/cobble share. **All sites use the current statistics settings** (pooling mode, size
metric, cutoffs), so the comparison is like for like. Sites must be calibrated to be
plotted together.

If a site shows "No scale yet", press *Open* next to it, select each photo and use
*Scale → Calibrate* (or *Copy Scale to Site* after calibrating one photo, if all photos share
the same camera and height). *Compare in pixels* compares uncalibrated sites directly; this is
only meaningful if all photos were taken with the same camera at the same height.
*Analyse all sites* (under the site selector) analyses every photo not yet analysed in all sites.

For each pair of sites, *D50 differences* gives the ratio of their D50s with a 95% interval
and a p-value. This is approximate: it combines each site's bootstrap interval on a log
scale (z-test). Treat p < 0.05 as "likely different" and look at the curves; for a formal
test use a full two-sample method such as GSDtools (Eaton et al. 2019). *Download
comparison CSV* saves the table and the pairwise results; each chart has SVG/PNG buttons.

### Uncertainty & sampling (expandable section)
| Setting | Default | What it does | When to change it |
|---|---|---|---|
| **Confidence level** | 95% | Width of the reported uncertainty ranges. | Use 90% only if your reporting standard requires it. |
| **Bootstrap repeats** | 500 | How many resamples are used to estimate site uncertainty. | 1000–2000 for final reported results. Lower (e.g. 200) for faster updates while editing. |
| **Bootstrap seed** | 42 | Fixed starting point for the random resampling, so results are repeatable. | Normally leave it. Changing it shows how much the ranges vary by chance (only slightly). |
| **Two-stage bootstrap** | Off | Also resamples grains within each photo, giving wider, more conservative ranges. | Turn on with few photos, or few grains per photo. |
| **Virtual Wolman points** | 100 per photo | Grid points per photo in *Virtual Wolman Grid* pooling (only that mode). | Set to about the number of stones you would count in the field per photo area. |

---

## 8. Display options ("Display" menu above the photo)

These only change what you see, never the results.

| Option | Shows |
|---|---|
| **Grain IDs** | Grain numbers. |
| **Size colours (Wentworth)** | Colours grains by size class (sand, gravel classes, cobble, boulder). |
| **Ellipses (a/b axes)** | The fitted ellipse and its axes for each grain. |
| **Orientation lines** | Grain orientation (long-axis direction). |
| **Mark edge/too-small grains** | Highlights grains excluded for touching the photo edge or being too small. |
| **Outline opacity** | How strongly outlines are drawn over the photo. |
| **Magnifier (2×)** | A magnifier that follows the cursor, for precise editing. |

On a touch screen: pinch to zoom, drag with two fingers to move the photo. With one finger,
a drag moves the photo when zoomed in and scrolls the page otherwise; a tap uses the active tool.

---

## 9. Where each setting lives

| Panel | Settings |
|---|---|
| **Left panel → Analysis settings** | Model, CP-SAM weights, Scale mode, Exclude border grains; *Fine-tuning:* Flow threshold, Cellprob threshold, Min size, Max area fraction, Border margin, CLAHE; *Advanced:* Flow steps, Inference pipeline, Seed density, CPU threads, Skip areas outside the ROI |
| **Left sidebar → photo list** | Include/exclude photo from the site; Facies weight (Facies-weighted mode only) |
| **Toolbar (above the photo)** | *Scale:* Calibrate, Rectify · *Exclude:* Area, Brush · *Edit grains* (after analysis): Split, Merge, Delete, Add · Display |
| **Right-hand panel → Statistics settings** | Pooling mode, Size metric, Field-count cutoff, Min b-axis, Exclusion overlap, Harmonize cutoff, *Uncertainty & sampling:* Confidence level, Bootstrap repeats, Bootstrap seed, Two-stage bootstrap, Virtual Wolman points |

All settings are recorded in every export.

---|---|---|
| Border exclusion | On, 2 px | Grains touching the photo edge are left out, because they are cut off and would look too small. |
| Bootstrap repeats | 500, seed 42 | Number of resamples used for the site confidence interval. The fixed seed makes results repeatable. |
| Confidence level | 95% | Width of the reported uncertainty ranges. |
| Virtual Wolman points | 100 per photo | Grid density for the Virtual Wolman Grid pooling mode. |
| Post-processing iterations etc. | as tested | Internal model settings, matched to the accuracy test. |

---

## 10. Quick recipes

| Situation | Suggested changes |
|---|---|
| Normal gravel bar, results for a report | Model **CP-SAM**; calibrate; check outlines; exclude rulers and boots; **Physical Area-Weighted**; **b-axis**. |
| Comparing with a field pebble count | As above, plus **Field-count cutoff = your field minimum** (e.g. 10–16 mm). Consider **min-Feret** if the field data are caliper b-axes. |
| Big cobbles or boulders, few per photo | Scale Mode **0.5x**; **Max Area Frac 1.0** if a single stone fills much of the frame; take more photos to reach 100+ grains. |
| Fine gravel, many small grains | Scale Mode **1.0x Full**; consider **Min Size 15**; get the camera closer. |
| Harsh sun, deep shadows | Turn on **CLAHE**; use **Exclude → Brush** on deep shadows; check for split or merged grains. |
| Huge false "grains" over sand or water | Lower **Max Area Frac** (e.g. 0.2), or exclude those areas. |
| Many grains missed | Lower **Cellprob** (−1), then try raising **Flow Threshold** (0.6). |
| Messy, ragged outlines | Raise **Cellprob** (+1), or lower **Flow Threshold** (0.3). |
| Quick look on a phone | Model **U-Net**; accept a rougher answer. |

---

## 11. How accurate is it?

Tested on 40 held-out photos from the ImageGrains dataset, against grain outlines drawn
by hand:

| Model | Typical (median) D50 error | Average D50 error | Photos more than 50% off |
|---|---|---|---|
| **Cellpose-SAM** | about 3% | about 12% | 3 of 40 |
| **U-Net** | about 15% | about 27% | 7 of 40 |

On these figures webGrainy is **as accurate as the original ImageGrains software**: the
small differences are within the noise of 40 photos. Its grain outlines are a little
less precise than the original's.

**Important limits:**
- **Test coverage:** the test photos come from rivers the model was trained on. Accuracy
  on a completely new river is not yet known.
- **Occasional large errors:** most photos are accurate, but a few are badly wrong (for
  example when one huge stone dominates the frame). **Always look at the outlines.**
- **Sizes are 2D:** they come from the visible top-down outline. Buried or overlapping
  stones look smaller.
- **Fine grains are under-counted.** Treat D16 and finer with caution.
- **Validate before publishing:** compare with a field pebble count or sieve sample at
  some of your own sites, using the field-count cutoff.

---

## 12. What to report

Every export already includes the app version, model and its checksum, all settings,
calibration and the date. When you publish or share results, also state:

- the **model** (CP-SAM or U-Net) and **size metric** (b-axis, min-Feret or d_eq);
- the **pooling mode** and any **field-count cutoff**;
- **how many grains** were measured, and the **number of photos**;
- **that outlines were checked and edited**, and roughly how much;
- that webGrainy is an **unofficial browser version of ImageGrains 2.0**, and cite the
  ImageGrains and Cellpose papers (see *About* in the app).

---

## 13. What you can export (Export button)

Every file starts with the provenance metadata (app and model versions, model file and
SHA-256, all settings, site name) so results can be reproduced.

**Whole site**

| File | Contains |
|---|---|
| **Site Summary CSV** | D5–D95 with bootstrap and binomial confidence intervals; mean diameters (Sauter D[3,2], De Brouckère D[4,3], arithmetic), geometric mean and SD, D30/D60/D65, moment statistics in φ, Cu, Cc, Trask sorting, span, Fredle index; Folk & Ward mean, sorting, skewness, kurtosis with confidence intervals; Wentworth class percentages and size-class histograms (1 φ and 0.5 φ bins, % and counts); fabric (mean orientation, alignment R, circular variance, Rayleigh test, rose bins); sample adequacy (rating, effective grain count, largest clast, outlier photos); jackknife sensitivity; a per-photo breakdown by photo name (scale, grain counts, truncation, sampled area, packing/matrix %, D16/D50/D84, weight, influence, cumulative D50); warnings; citations. |
| **Site Summary JSON** | Everything above, plus the convergence series and per-photo jackknife detail, in one structured file. |
| **Pooled Grains CSV** | One row per grain from all included photos: size (px and mm), axes, Feret widths, orientation, perimeter, circularity, aspect ratio, elongation, convexity/solidity, 2D sphericity. |
| **Printable SVG PSD Figure** | The grain-size curve with confidence band, for reports. |
| **.webgrainy.json archive** | The whole project (photos, scale, ROIs, results) to reopen later or share. |

**Charts:** every chart on the right-hand panel has **SVG** and **PNG** buttons. The file is
drawn on a white background for reports (PNG at 3× resolution) and carries the same
provenance metadata as the other exports. The PSD tab shows the cumulative curve and the
**size distribution histogram** (area-weighted %, Wentworth φ classes in mm, or ×2 / ×√2
pixel classes before calibration); the Shape tab shows the aspect-ratio distribution.

**This photo**

| File | Contains |
|---|---|
| **Photo Grains CSV** | One row per grain: as in the pooled grains CSV, plus whether the grain is inside the ROI and whether it counts in the statistics. |
| **Photo Summary CSV / JSON** | D5–D95 for the area- and number-weighted b-axis, equivalent diameter and min-Feret; Folk & Ward; the *More statistics* values (as in the site summary); Wentworth classes and size-class histograms (φ classes in mm, or pixel classes before calibration); fabric statistics; warnings. |
| **16/32-bit PNG mask** | The grain label image (each grain a different value), for GIS or Python. |
| **GeoJSON / SVG contours** | Grain outlines in original photo coordinates. |

### The extra statistics (Results → PSD → More statistics)

| Statistic | Definition | Typical use |
|---|---|---|
| Sauter mean D[3,2] | Σd³/Σd² over all grains (= the area-weighted mean size) | "Mean grain size" in transport and roughness formulas |
| De Brouckère mean D[4,3] | Σd⁴/Σd³ | Mean emphasising the large grains |
| Arithmetic mean D[1,0] | Σd/n | Simple average grain |
| Geometric mean Dg, σg | exp(mean ln d), exp(SD ln d), weighted like the PSD | River engineering; σg ≈ √(D84/D16) for log-normal beds |
| D30, D60, D65 | Percentiles of the PSD | D65: Einstein roughness; D30/D60 for Cu and Cc |
| Moments (φ) | Method-of-moments mean, sorting, skewness, kurtosis on the φ scale | Alternative to Folk & Ward (GRADISTAT) |
| Uniformity Cu, curvature Cc | D60/D10, D30²/(D10·D60) | Engineering gradation (well/poorly graded) |
| Trask sorting So, span | √(D75/D25), (D90−D10)/D50 | Spread of the distribution |
| Fredle index | Dg/So | Spawning-gravel quality (Lotspeich & Everest 1981) |

All are 2D surface measures from photos: like D50, they cannot see fines hidden under the
surface layer or the subsurface, and they use the chosen size metric (b-axis by default).
