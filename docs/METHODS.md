# webGrainy methods

This document describes how webGrainy turns photos of a gravel bed into grain-size numbers,
step by step: which models it uses, how grains are outlined and measured, which grains are
counted, and how every statistic and uncertainty is calculated. It is written for
geomorphologists and field scientists. Where a formula is given, a plain explanation comes
with it. You do not need it to use the app, but you may want it to report your methods or
to judge whether a result can be trusted.

For what each setting does and when to change it, see the [Settings guide](SETTINGS_GUIDE.md).
For accuracy tests, see [Validation](#15-validation) and [`validation/`](../validation/).

webGrainy is an independent browser version of **ImageGrains 2.0** (Mair et al.). It uses the
ImageGrains models but its own image handling and post-processing. Please cite ImageGrains
and Cellpose when you publish results (see [References](#17-references)).

---

## Contents

1. [Overview](#1-overview)
2. [Photos in](#2-photos-in)
3. [Scale (calibration)](#3-scale-calibration)
4. [Preparing the image for the model](#4-preparing-the-image-for-the-model)
5. [The segmentation models](#5-the-segmentation-models)
6. [From model output to grain outlines](#6-from-model-output-to-grain-outlines)
7. [Measuring each grain](#7-measuring-each-grain)
8. [Which grains are counted](#8-which-grains-are-counted)
9. [The grain-size distribution and percentiles](#9-the-grain-size-distribution-and-percentiles)
10. [Summary statistics](#10-summary-statistics)
11. [Combining photos into a site](#11-combining-photos-into-a-site)
12. [Uncertainty and sample adequacy](#12-uncertainty-and-sample-adequacy)
13. [Comparing sites and surveys over time](#13-comparing-sites-and-surveys-over-time)
14. [Reproducibility, provenance and storage](#14-reproducibility-provenance-and-storage)
15. [Validation](#15-validation)
16. [Limitations](#16-limitations)
17. [References](#17-references)

---

## 1. Overview

Everything runs in your web browser; photos are never uploaded. For each photo:

```
photo ─► scale (mm per pixel) ─► resize for the model ─► segmentation model
      ─► grain outlines ─► measurements per grain ─► grains that count
      ─► grain-size distribution ─► percentiles and statistics
```

For a site (several photos of one reach on one occasion), the counted grains of all photos
are pooled into one distribution, and the app estimates how uncertain the result is from how
much the photos differ from each other. Sites can be compared, and repeat surveys of one
place can be followed over time.

Two words used throughout:

- **Pixel (px)**: always a pixel of the **original photo** as you added it, even if the
  model saw a smaller copy. All sizes in pixels refer to the original photo.
- **mm per pixel**: the ground size of one photo pixel, from the scale you set. Sizes in mm
  are pixel sizes multiplied by this number.

---

## 2. Photos in

**Formats.** JPEG, PNG, WebP and other formats the browser can open, and TIFF / GeoTIFF.
16-bit TIFFs are converted to 8 bits by their own brightness range, from the 0.01st to the
99.99th percentile of the samples (recorded in the photo's notes; brighter or darker samples are
clipped, so one hot pixel does not compress the range). Data that uses only part of the 16-bit
range (e.g. 12-bit cameras) keeps its detail.
Very large photos (over 16.7 megapixels) are read at a reduced size to stay within browser
memory limits. Measurements are still reported in the pixels of the original photo.

**Photo checks.** The app warns, but does not refuse, when:

- the photo looks **blurred** (a sharpness score from the variation of edges in a small copy
  of the photo; below 60 the photo is flagged);
- the camera has a **wide-angle lens** (35 mm-equivalent focal length under 20 mm) or is an
  **action camera** (GoPro, Insta360 and similar), because lens distortion then changes sizes
  across the photo (see [Limitations](#16-limitations)).

**Optional image steps.** These change the image before analysis and are recorded with the
results:

- **Perspective rectification**: for photos not taken straight down. You click the four
  corners of a rectangle of known size on the bed (a quadrat); the photo is warped so the
  rectangle becomes a true rectangle (a 4-point *homography*), and the scale is set from it.
  The rectified photo is at most 2,048 px on its longest side, so rectifying a large photo can
  coarsen its detection limit (Section 8).
- **2× upscale (PULSE model)** and **deblur (Richardson–Lucy)**: optional enhancement of
  small or soft photos. Use with care: they create or sharpen detail, and the result depends
  on the enhancement model.

---

## 3. Scale (calibration)

Sizes in mm need the photo's scale, **mm per pixel**. There are four ways to set it:

| Method | How | Notes |
|---|---|---|
| **Two points** | Click both ends of an object of known length (ruler, scale bar) and type its length. | mm per pixel = known length ÷ pixel distance between the points. Use the longest reference you can, lying flat on the bed surface. |
| **Rectification** | Four corners of a known rectangle (Section 2). | The output photo has square pixels of a known size. |
| **GeoTIFF** | Read from the file's georeferencing (e.g. drone orthomosaics). | Used only for projected coordinates in metres or feet with near-square pixels. Web-Mercator map units are corrected for latitude; geographic (degree) files are ignored. |
| **Copy scale** | Give other photos the same scale. | Only correct if they were taken with the same camera, zoom, resolution and height above the bed. The app warns when the photos' pixel sizes differ. 2× enhanced photos are adjusted automatically. |

A single scale is used for the whole photo. This assumes the photo is taken straight down
over a roughly flat bed, with negligible lens distortion. Photos without a scale are
reported in pixels and cannot be pooled with calibrated photos.

---

## 4. Preparing the image for the model

**Working size.** The models were trained on photos of moderate size, and big photos would
be slow, so each photo is resized to a **working image** before analysis. With the default
*Scale Mode: Auto*:

| Longest side of the photo | Working image |
|---|---|
| up to 1,024 px | unchanged |
| over 1,024 px | longest side 1,024 px |

(Before v0.1.0, photos of 1,025–4,096 px were shrunk to half or quarter size, so a 2,100 px
photo got a 525 px working image but a 2,048 px photo 1,024 px.)

Shrinking averages all the photo pixels that fall in each working pixel (like a
lower-resolution camera). Outlines found in the working image are converted back to original
photo pixels for all measurements. **Consequence:** the smallest grain that can be found
depends on the working size, not only on the photo (see *detection limit*, Section 8).

**Fine-grain enlargement (optional).** For U-Net results whose grains are very small in the
working image (median b-axis under 20 px), the app suggests re-analysing with the working
image enlarged ×1.5. In tests this improved outlines of fine gravel. It is a suggestion, not
applied automatically.

**Contrast enhancement (optional, off by default).** CLAHE (contrast-limited adaptive
histogram equalisation) can help photos with deep shadows or glare.

**Brightness normalisation.** Before the model sees the image, brightness is stretched so
that the darkest 1% and brightest 1% of pixels map to 0 and 1 (Cellpose's standard
normalisation). This makes results less sensitive to exposure.

---

## 5. The segmentation models

**What the models do.** Both models are *Cellpose-style* neural networks, originally designed
to outline cells in microscope images and retrained by the ImageGrains authors on hand-outlined
gravel photos. For every pixel they predict:

- the **probability that the pixel belongs to a grain** (rather than to the gaps, sand or water
  between grains), and
- a **flow vector**: the direction from that pixel towards the centre of the grain it belongs to.

Grains are then found by following these flows (Section 6). This is why touching grains can be
separated: their pixels flow to different centres.

**The two models.**

| | U-Net | Cellpose-SAM |
|---|---|---|
| Basis | Cellpose 3 network, retrained on gravel (ImageGrains 2.0) | Cellpose 4 network built on Meta's Segment Anything (a large vision transformer), retrained on gravel |
| Size / speed | 25 MB, a few seconds per photo | 180–620 MB depending on the weights, from seconds (with a graphics card) to minutes (CPU) per photo |
| Accuracy | good on uniform gravel | better outlines, especially on mixed sizes, shadows and complex beds |
| Weights | 32-bit (25 MB) | 16-bit (617 MB, graphics card), or compressed 8-bit (316 MB) / 4-bit (183 MB) versions with the same benchmark accuracy |

**Auto model choice.** *Auto* picks U-Net on phones, without a suitable graphics card (WebGPU
with 16-bit support) or with less than 4 GB of memory. Otherwise it scores the photo's
complexity (how varied its edges and local contrast are, and how wide its range from shadow
to glare is, from a small copy of the photo). If the score is 0.45 or more it chooses
Cellpose-SAM; otherwise U-Net. You can always choose the model yourself, and should report
which one you used.

**Running the model exactly as the original.** To reproduce the published ImageGrains
results, the app reproduces upstream Cellpose's image handling exactly:

- *U-Net*: the image is converted to grey, rescaled by 17/30 (Cellpose's size convention for
  these weights), padded with a narrow border, and processed in overlapping 224 × 224 px
  tiles. Tile results are blended with smooth weights that fade towards tile edges.
- *Cellpose-SAM*: colour, padded, processed in 256 × 256 px tiles with 25% overlap and blended
  the same way.

Checked against the original PyTorch software, the *networks* give identical (U-Net) or
near-identical (Cellpose-SAM, 16-bit rounding) outputs. webGrainy's own post-processing then
turns these into outlines; its final outlines agree with PyTorch ImageGrains' at a panoptic
quality of about 0.93 (Section 15), so grain outlines and sizes are close to, but not the same
as, the original software's.

**Graphics card or CPU.** The models run on the graphics card (WebGPU) where available, else
on the CPU (WebAssembly). U-Net gives the same results on both (float32); Cellpose-SAM on the
graphics card runs in 16-bit and its outlines differ slightly (outline agreement 0.996 on a test
photo; only one graphics card, an Intel Xe, has been checked so far: see `validation/gpu/`).
The device used is recorded in every export. If the graphics card produces
invalid numbers, the app switches that model to the CPU automatically.

**Model integrity.** Model files are downloaded once from a fixed version on Hugging Face and
checked against a SHA-256 fingerprint before use. The fingerprint is written into every export,
so you can show exactly which model produced a result.

---

## 6. From model output to grain outlines

This step (post-processing) turns the per-pixel predictions into separate grains. It is
webGrainy's own implementation of Cellpose's procedure.

1. **Grain pixels.** Pixels with grain probability above the *cell probability threshold*
   (default 0, i.e. more likely grain than not) are grain pixels.
2. **Follow the flows.** From each grain pixel, the app takes small steps along the predicted
   flow directions (250 steps by default). Pixels of one grain end up gathered at its centre.
3. **Find grain centres.** Places where enough pixels end up (at least 2 by default) become
   grain centres ("seeds").
4. **Assign pixels.** Each grain pixel joins the centre it reached (or a centre within 2 px).
5. **Remove implausible grains.**
   - Grains smaller than the *minimum size* (30 working-image pixels) are dropped as noise.
   - Grains larger than 40% of the image are dropped. One huge false grain would otherwise
     dominate an area-weighted distribution.
6. **Flow quality check.** For each grain, the app compares the model's flows inside it with
   the flows an ideal grain of that exact shape would have. If they disagree by more than the
   *flow threshold* (default 0.45), the outline is probably wrong: usually two grains merged.
   The app then tries to split it into two grains that each pass the check, and drops it if
   it cannot.
7. **Border grains.** Grains within 2 working-image pixels of the photo edge are marked as
   *touching the border* (they are cut off by the frame; Section 8).

You can then correct the outlines by hand: split, merge, delete or draw grains, with undo.
Edits are kept with the results, and the number of edited photos is reported.

**Defaults** (changeable under *Advanced analysis*, but the defaults are the tested values):

| Setting | Default |
|---|---|
| Flow steps | 250 |
| Cell probability threshold | 0 |
| Flow threshold | 0.45 |
| Minimum grain size | 30 working-image px |
| Minimum pixels per seed | 2 |
| Border margin | 2 working-image px |
| Largest grain | 40% of the image |

---

## 7. Measuring each grain

Every grain is measured from its outline in the working image and converted to original
photo pixels (lengths ÷ the working scale, areas ÷ its square), then to mm with the photo's
scale.

### Size measures

| Measure | Definition | In plain terms |
|---|---|---|
| **Area** | Number of pixels in the outline. | Visible grain area (mm² when calibrated). |
| **b-axis** (default size) | Minor axis of the ellipse with the same spread of pixels as the grain: 4 × √(smaller eigenvalue of the pixel coordinates' covariance). | The "width" of the ellipse that best matches the grain's shape. |
| **a-axis** | Major axis of the same ellipse: 4 × √(larger eigenvalue). | Its "length". |
| **Equivalent diameter** (d_eq) | √(4 × area / π). | Diameter of a circle with the grain's area. |
| **Minimum Feret width** | Smallest distance between two parallel lines touching the outline, over all directions (calipers). | Closest 2D equivalent of measuring the b-axis with calipers. |
| **Maximum Feret length** | Largest such distance. | Longest caliper length. |

**Which size to use.** The b-axis is the ImageGrains standard and the default. It is **not**
a sieve or caliper b-axis: it is measured on the visible 2D outline from above. For
ellipse-like grains it is close to the minimum Feret width; for angular or irregular grains
the two can differ by about ±15%. Choose the *size metric* in the Site panel; every result
states which one it uses.

### Shape and orientation

| Measure | Definition |
|---|---|
| **Aspect ratio** | b-axis ÷ a-axis (1 = round, smaller = elongated) |
| **Elongation** | 1 − aspect ratio |
| **Circularity** | 4π × area ÷ perimeter² (1 for a circle) |
| **Solidity** | area ÷ area of the convex hull (1 = no concave parts) |
| **2D sphericity** | d_eq ÷ a-axis |
| **Perimeter** | Crofton estimate from boundary crossings in 4 directions (less biased than counting edge pixels) |
| **Orientation** | Angle of the a-axis, from the vertical of the photo (0° = up–down in the image) |

**Known biases of the shape measures.** They are computed on pixel outlines, so:

- *Small grains look less round and less solid.* A disc 16 px across gets a circularity of about
  0.91 and a solidity of about 0.93 (both 1 for a perfect disc); at 80 px both are about 0.99.
  Compare shapes only between grains of similar size in pixels.
- *The perimeter depends a little on orientation.* The 4-direction Crofton estimate is about 5%
  low for edges along the image axes and slightly high for diagonal edges, so circularity of an
  elongated grain changes by up to about 10% with its orientation.
- *Moment axes of angular grains.* For a rectangle, the moment-ellipse axes are about 15% longer
  than its sides (Section 7); minimum Feret width measures the side directly.

---

## 8. Which grains are counted

Not every outlined grain goes into the statistics. A grain is counted only if it passes all
of these rules; excluded grains stay in the grain tables, flagged.

1. **Border grains are left out** (default). A grain cut by the photo edge looks smaller
   than it is. Leaving them out avoids this bias but slightly under-represents the largest
   grains, which are more likely to touch an edge. You can switch this off.
2. **Region of interest (ROI) and exclusion areas.** If you draw an ROI (e.g. the inside of a
   quadrat) or exclusion areas (vegetation, water, shadow, the ruler), a grain counts only if
   its centre lies in the valid area **and** no more than 10% of its pixels fall in excluded
   parts. The 10% tolerance is adjustable.
3. **Smallest grain counted (pixel cutoff).** Grains with a size under **15 px** (on the chosen
   size measure, in original photo pixels) are left out by default. Very small grains are
   outlined unreliably.
4. **Detection limit (smallest grain kept).** The smallest grain a photo can keep is the larger
   of the pixel cutoff and the size of the post-processing's minimum grain (30 working pixels of
   area, as an equal-area diameter, about 6 working pixels) converted to photo pixels. Photos
   shrunk more for analysis have a coarser limit. The app shows this limit in mm. It is a floor,
   not the size above which every grain is found: in the pre-processing benchmark
   (`validation/preprocessing/`), U-Net found about 4% of the hand-outlined grains under 10
   working pixels and about 46% of those of 10–20 working pixels (Cellpose-SAM, on 5 photos:
   about 49% and 78%). Fine grains up to a few times this limit are therefore under-counted,
   and D5–D16 are biased coarse, more so for photos analysed at a smaller working size.
   Recall is high only from about 20 working pixels (20–40 px: Cellpose-SAM about 93%, U-Net
   about 64%). To describe the fine tail, or to compare surveys shot at different resolutions,
   set the **Field-count cutoff** (item 6) to at least about 3× the detection limit shown.
   The held-out accuracy benchmark (README) used mostly small images (median long side 512 px;
   38 of 40 analysed at full resolution). Typical 12–48 MP field photos are analysed at about
   0.13–0.25× (Auto, longest side 1024 px), so their grains are 4–8× smaller in working pixels
   than in the benchmark, and their fine tail is less reliable than the benchmark suggests.
5. **Common size cutoff for a site (calibrated sites).** Photos taken from different heights
   or with different cameras can resolve different smallest sizes. To pool them fairly, the
   app finds each photo's detection limit in mm and applies the **largest** of them to every
   photo. All photos then describe the same size range. This *harmonisation* is on by default.
   Inside a site, each photo's own statistics, grain table (`included_in_stats`) and summary
   file use the same cutoff, so they match the site's per-photo breakdown.
6. **Field-count cutoff (optional, mm).** To compare with a pebble count that ignored grains
   below, say, 8 mm, set the same minimum here. Without it, photo distributions include finer
   grains than the field count and look finer.

**Why this matters.** The grain-size distribution is always *truncated* at the smallest
counted size: sand and fine gravel below it are not in it. Percentiles describe the
distribution **above the cutoff**. Two surveys should be compared over the same size range
(Section 13 does this automatically).

---

## 9. The grain-size distribution and percentiles

### Weighting: grid-by-number vs. number-weighted

How much each grain counts in the distribution is a choice with a big effect on the result:

- **Area-weighted (default).** Each grain counts in proportion to its visible area. This is
  the photo equivalent of a **grid (Wolman) pebble count**: if you dropped points at random on
  the bed and measured the grain under each point, large grains would be hit more often in
  proportion to their area. It is the basis comparable to field pebble counts (Kellerhals &
  Bray 1971).
- **Number-weighted.** Each grain counts once. It gives much finer percentiles (many small
  grains), not comparable with pebble counts or sieving. Shown for completeness.

Other site pooling options are described in Section 11.

### Percentiles (D5 … D95)

Dx is the size that x% of the (weighted) distribution is finer than; D50 is the median.
The calculation:

1. Sort the counted grains by size. Give each a weight w (its area, or 1).
2. Each grain's cumulative position is the weight of all smaller grains plus **half its own
   weight**, divided by the total weight (a "mid-point" cumulative curve).
3. Dx is read off this curve, **interpolating on a logarithmic size scale** (in φ units)
   between neighbouring grains. Values beyond the smallest or largest grain are set to that
   grain.

In formula form, with sizes sorted, weights wᵢ and total W:

> cumulative position of grain i: Fᵢ = (w₁ + … + wᵢ − ½ wᵢ) / W
>
> Dx = 2^( interpolate x/100 between the Fᵢ in log₂(size) )

Interpolating on the log scale suits grain sizes, which are naturally compared as ratios.
Linear interpolation (as in ImageGrains' own evaluation code) gives nearly the same values for
normal samples (typically within 0.1–1%), but can differ by 10–20% where a few grains span a
wide gap.

The app reports D5, D10, D16, D25, D50, D75, D84, D90 and D95 for the b-axis, equivalent
diameter and (when computed) minimum Feret width, both area- and number-weighted.

---

## 10. Summary statistics

Unless stated, statistics use the same weighting as the percentiles. Sizes in mm are
converted to the **phi (φ) scale** where needed: **φ = −log₂(size in mm)**, so larger grains
have more negative φ (e.g. 64 mm = −6 φ).

### Folk & Ward graphic measures (calibrated photos only)

Computed from the percentiles, after converting them to φ. φ_x denotes the size x% coarser
than (so φ₁₆ = −log₂ D84):

| Measure | Formula | Meaning |
|---|---|---|
| Graphic mean | (φ₁₆ + φ₅₀ + φ₈₄) / 3 | average size (also given in mm) |
| Sorting | (φ₈₄ − φ₁₆)/4 + (φ₉₅ − φ₅)/6.6 | spread: small = well sorted |
| Skewness | (φ₁₆+φ₈₄−2φ₅₀)/(2(φ₈₄−φ₁₆)) + (φ₅+φ₉₅−2φ₅₀)/(2(φ₉₅−φ₅)) | asymmetry: negative = tail of coarse grains |
| Kurtosis | (φ₉₅ − φ₅) / (2.44 (φ₇₅ − φ₂₅)) | peakedness |

Descriptive classes (Folk & Ward 1957):

| Sorting (φ) | | Skewness | | Kurtosis | |
|---|---|---|---|---|---|
| < 0.35 | very well sorted | ≥ 0.3 | very fine skewed | < 0.67 | very platykurtic |
| 0.35–0.5 | well sorted | 0.1 to 0.3 | fine skewed | 0.67–0.9 | platykurtic |
| 0.5–0.7 | moderately well sorted | −0.1 to 0.1 | near symmetrical | 0.9–1.11 | mesokurtic |
| 0.7–1.0 | moderately sorted | −0.3 to −0.1 | coarse skewed | 1.11–1.5 | leptokurtic |
| 1.0–2.0 | poorly sorted | ≤ −0.3 | very coarse skewed | 1.5–3.0 | very leptokurtic |
| 2.0–4.0 | very poorly sorted | | | > 3.0 | extremely leptokurtic |
| > 4.0 | extremely poorly sorted | | | | |

With fewer than about 30 grains these classes are not meaningful (the app warns).

### More statistics

| Statistic | Definition | Use |
|---|---|---|
| Geometric mean D_g | exp(weighted mean of ln size) | a "typical" size |
| Geometric standard deviation σ_g | exp(weighted standard deviation of ln size) | spread as a ratio |
| Moment mean, sorting, skewness, kurtosis (φ) | weighted mean, standard deviation, 3rd and 4th standardised moments of φ (GRADISTAT, Blott & Pye 2001) | alternative to Folk & Ward using all grains |
| Arithmetic mean D[1,0] | Σd / n, each grain once | |
| Sauter mean D[3,2] | Σd³ / Σd², each grain once | area-based mean size |
| De Brouckère mean D[4,3] | Σd⁴ / Σd³, each grain once | weights large grains more |
| D30, D60, D65 | percentiles as in Section 9 | D65 for some roughness formulas |
| Uniformity Cu | D60 / D10 | engineering gradation |
| Curvature Cc | D30² / (D10 × D60) | engineering gradation |
| Trask sorting | √(D75 / D25) | |
| Span | (D90 − D10) / D50 | |
| Fredle index | D_g / Trask sorting | spawning-gravel quality |

### Size classes

- **Wentworth classes** (% by the same weighting as the percentiles; area-weighted by default): sand < 2 mm, gravel 2–64 mm, cobble 64–256 mm,
  boulder ≥ 256 mm. "Sand" here means only the counted grains under 2 mm, normally few
  because of the size cutoff. It is **not** the sand content of the bed.
- **Size histogram** in 1 φ or ½ φ classes (area-weighted %, with grain counts). Before
  calibration, power-of-two pixel classes are used instead.

### Shape and fabric

- **Shape**: distribution of aspect ratios (b/a) and their median, each grain once.
- **Fabric (orientation)**: grain orientations are *axial* (a grain at 10° is the same as at
  190°), so they are averaged by doubling the angles, the standard method for axial data.
  The app reports:
  - the mean orientation;
  - the strength of alignment *R* (0 = random, 1 = all parallel) and the circular variance (1 − R);
  - a **Rayleigh test** of whether there is any preferred orientation, with its p-value, given
    when there are at least 10 grains (effective);
  - a rose diagram in 15° bins.

  Orientations are relative to the photo frame, so compare them only between photos taken
  the same way round.

---

## 11. Combining photos into a site

A site is several photos of one reach on one occasion. Their counted grains are pooled into
one distribution. *How* photos are combined is the **pooling mode**:

| Pooling mode | Each grain's weight | When to use |
|---|---|---|
| **Physical area-weighted** (default) | its area in mm² | Standard. Equivalent to a grid count over the whole photographed area. Photos covering more bed count more. |
| **Equal-photo** | its area as a share of its photo's total grain area | Each photo (location) counts equally, whatever area it covers. |
| **Virtual Wolman grid** | number of grid points landing on it | Mimics a field pebble count: a regular grid of points per photo (default about 100, or a fixed spacing in mm). Points on gaps or excluded grains are counted separately. |
| **Facies-weighted** | as equal-photo, × the photo's facies weight ÷ the total weight | Stratified sampling. The weight is per photo, so a facies' share is the sum over its photos: for 70% riffle (4 photos) and 30% pool (1 photo), give 0.175 per riffle photo and 0.3 to the pool photo. |
| **Number-weighted** | 1 | Each grain once. Not comparable with pebble counts. |

The per-photo breakdown shows each photo's grains, D16/D50/D84, packing (% of bed area
covered by counted grains), detection limit and share of the pooled weight.

**Photos analysed differently.** If the photos of one site were analysed with different model
weights or settings (for example *Auto* chose U-Net for some photos and Cellpose-SAM for others,
or only some were enhanced), the app warns: the models have different size biases, and pooling
mixes them. Choose the model yourself for photos you will pool, and re-analyse. The printable
report lists the model of every photo.

---

## 12. Uncertainty and sample adequacy

A D50 from photos is an estimate. It would differ with other photos of the same reach. The app
estimates how much, in several complementary ways.

### Bootstrap confidence intervals (main uncertainty)

The **bootstrap** asks: *if I had taken a different set of photos of this reach, how different
would D50 be?* It cannot take new photos, so it simulates them by re-drawing from the photos
you have:

1. Draw as many photos as you have, **at random with replacement** (some photos appear twice,
   others not at all).
2. Pool their grains and compute D5–D95 and the Folk & Ward measures.
3. Repeat 500 times (the *Bootstrap repeats* setting; use 1,000–2,000 for reported results).
4. Turn the spread of the results into the **95% interval** (90% can be chosen). The plain
   bootstrap range (2.5th to 97.5th of the results) is too narrow when a site has few photos:
   in simulation, nominal 95% ranges contained the true D50 only about 45–50% of the time with
   2 photos, 65–75% with 3 and 75–80% with 5. The app therefore reports a *t-interval on the
   log scale* around the site value:

   > SE_boot = (ln upper − ln lower) / (2 × 1.96) × √(n/(n−1))
   > SE = larger of SE_boot and the leave-one-photo-out jackknife SE of ln D
   > interval = D × exp(± t × SE)

   where n is the number of photos and t the Student-t value with n − 1 degrees of freedom
   (12.7 for 2 photos, 4.3 for 3, 2.8 for 5). In the same simulation this interval contained
   the truth about 90–97% of the time for 3–20 photos (the bootstrap SE alone gave 88–96%).
   Folk & Ward φ measures use the bootstrap rule on their own scale. The plain bootstrap range
   is kept in the JSON export (`bootstrapPercentileCi`), and the SE in `ciLogSe`; the site
   comparison test (Section 13) uses that same SE.

This is a **cluster bootstrap**: photos, not grains, are re-drawn. Grains within a photo are not
independent (neighbouring grains are alike), so treating each grain as independent would make
intervals far too narrow. Re-drawing photos captures the real patch-to-patch variation of the
bed. Options:

- **Two-stage**: also re-draws grains within each drawn photo, adding counting variation.
- **One photo only**: with a single photo, only grains can be re-drawn. The interval then
  shows counting uncertainty only, not how representative that one patch is. The app warns.
- **Fewer than 5 photos**: the interval is marked *approximate* and the app warns. It is wide
  because the photo-to-photo variation is estimated from very few photos.
- **No interval**: when the photos give identical bootstrap results (for example the same photo
  added twice) the uncertainty cannot be estimated. The interval is shown as not available,
  never as a precise [x, x], and the app warns. Photos with identical grains are reported as
  likely duplicates.

The random draws use a fixed seed (42), so the same data always give the same interval.

Coverage was also checked in every pooling mode (physical-area, equal-photo, number-weighted,
facies-weighted, virtual Wolman on real label masks) and with the two-stage bootstrap: 91–98% for
3–10 photos (two-stage: 96–100%, i.e. conservative); see `validation/interval_coverage/`. That bed
varies only in its median from photo to photo. On beds that vary more (every photo the same
footprint, so fine patches give more grains; sorting varying between photos; 10% of photos of a
3× coarser patch; `variable_bed_coverage.audit.ts`), coverage for 5–20 photos was 87–99% in
physical-area and number-weighted pooling, and fell to 85–89% for D84 in physical-area pooling
where patches differ strongly (patch sd 0.5). **Coverage depends on how the bed varies;** treat
the D84 interval as approximate on very patchy beds.

### Binomial (order-statistic) intervals

A second, faster interval for each percentile, as in Eaton et al. (2019, GSDtools). If n grains
are measured, the number of them finer than the true D50 follows a binomial distribution; this
gives the range of grain ranks that contains the true percentile with 95% probability, read off
the measured distribution. For area-weighted pooling, n is the **effective number of grains**
(below), not the raw count. This interval treats grains as independent, so it reflects counting
uncertainty only and is usually narrower than the bootstrap interval.

### Effective number of grains

With area weighting, a few large grains carry much of the weight, so the sample behaves like
fewer grains than you counted. The **effective number** (Kish 1965) is

> n_eff = (Σ wᵢ)² / Σ wᵢ²

It equals the grain count when all weights are equal and falls as weights become unequal.

### Sample adequacy rating

Based on n_eff (grid hits for the Wolman mode; grains for number-weighted):

| n_eff | Rating |
|---|---|
| < 100 | Insufficient |
| 100–199 | Minimal |
| 200–399 | Adequate |
| ≥ 400 | High precision |

About 100 grains is the usual minimum for a stable D50 in pebble counts. D84 and D95 need
more. Many grains from few photos still say little about how the bed varies from patch to
patch, so the rating is also capped by the number of photos: at most *Minimal* for one photo
and *Adequate* for 2–4 photos (the export notes when the photo count limits it). Also flagged:

- a **single very large clast** carrying over 5% (moderate) or 10% (critical) of the total
  grain area;
- **photos to check**: fewer than 15 counted grains, a D50 more than twice or less than half
  that of the rest of the site, or a scale more than 3× different from the site median.

### Leave-one-photo-out (jackknife)

The site D16/D50/D84 is recomputed leaving out each photo in turn. A photo whose removal
changes a percentile by more than 10% is marked **high influence**. Check it for problems
(bad outlines, wrong scale, different bed type). A jackknife standard error is also given.

### Convergence curve

D50 (with its bootstrap interval at up to 15 points) as photos are added one by one. If the
curve and interval are still changing at the last photo, more photos would help.

### Single-photo warnings

For one photo: fewer than 30 counted grains, "percentiles highly uncertain and Folk & Ward
classes not meaningful"; fewer than 100, "D84/D95 especially uncertain".

---

## 13. Comparing sites and surveys over time

**Like for like.** When sites are compared, the app:

- computes all of them with the **same statistics settings** (pooling, size measure, cutoffs);
- applies the **largest common size cutoff** of all compared sites to every site, so a survey
  photographed from higher up does not look coarser just because it cannot see small grains;
- warns when photos were **analysed differently** (model, image scale, enhancement,
  post-processing settings), since such differences can create apparent changes.

**Ratio and test.** For each pair of sites, and for consecutive surveys of the same place
(*later ÷ earlier*), the app reports the ratio of D16, D50 and D84 (above 1 = coarser), a 95%
interval for the ratio and a p-value:

1. Each site's standard error on the log scale is the one behind its reported interval
   (Section 12): the larger of the bootstrap SE × √(n/(n−1)) and the leave-one-photo-out
   jackknife SE, for a site of n photos.
2. The log of the ratio is compared with its combined SE using a **Welch t-test**, with
   degrees of freedom from the numbers of photos (n−1 per site). The 95% interval uses the
   matching t value.
3. With several pairs (or several consecutive surveys), each p-value is also given **adjusted
   for the number of comparisons** (Holm 1979), separately for D16, D50 and D84. The * mark
   uses the adjusted p-value, so within one percentile the chance of *any* false "significant"
   result stays below 5%. The three percentiles are adjusted separately, so reading a star in
   *any* of D16, D50 and D84 as a change is more permissive: for two surveys of an unchanged
   bed this happened in about 5–9% of simulated comparisons.

**In plain terms:** the test asks whether the difference is larger than the photo-to-photo
variation of both surveys would produce by chance, allowing for how few photos each has.

**Rules:**

- **One-photo surveys get no p-value or interval.** One photo cannot show how much the bed
  varies between patches. In simulation, comparing one-photo surveys of an *unchanged* bed
  gave "significant" changes about 30% of the time. Take several photos per survey.
- With fewer than 5 photos per site, intervals are wide and only large differences show.
- In simulation of unchanged beds (2–20 photos per survey, moderate and strong patch-to-patch
  variation), a single comparison gave p < 0.05 in 1–8% of cases for D16, D50 and D84 (mostly 2–5%)
  (the expected rate is 5%; `validation/comparison/`). The cost is power: where photos of the bed
  differ little (patch sd 0.15), a real 20% change in D50 was detected
  about 27% of the time with 5 photos per survey and about 48% with 10. Where photos differ more in median and in
  sorting (patch sd 0.30), it was detected in 7% with 5 photos and 12% with 10
  (`validation/comparison/power.audit.ts`, `power_results.md`). D16 changes are detected
  somewhat more often and D84 changes less often. **More photos per survey detect smaller
  changes; a single survey pair rarely shows a 20% change in a variable bed.**
- Without the adjustment, many pairs produce false "significant" results: with 8 identical
  sites (28 pairs), at least one pair had unadjusted p < 0.05 in 59% of simulated studies.
  Read the adjusted p-value when looking at several comparisons. This is a screening test, not
  a formal two-sample analysis; for that see GSDtools (Eaton et al. 2019).

**Survey dates and places.** A survey's date is the date you set, or else the earliest photo
date (from the camera's EXIF data). Repeat surveys of one place share a place name (case and
spacing are ignored) and are drawn as one line over time.

---

## 14. Reproducibility, provenance and storage

**Recorded with every result and export:**

- app version and the exact source code version (git commit);
- model name, version and SHA-256 fingerprint;
- all analysis settings, and whether the graphics card or CPU was used;
- image steps (enhancement, rectification), the scale and how it was set;
- ROI use, manual edits, and the statistics settings (pooling, size measure, cutoffs);
- bootstrap seed and number of draws, the interval method and its status (ok, approximate, single photo, not estimable), and the date.

CSV files start with this information in lines beginning with `#`; read them with, for
example, `pandas.read_csv(path, comment='#')`. In those lines, commas, semicolons and tabs are
written as `%2C`, `%3B` and `%09` (and `%` as `%25`), so spreadsheets keep each line in one
cell.

**Same input, same output.** Given the same photo, scale, settings and model, the app gives the
same outlines and numbers (bootstrap draws use a fixed seed). U-Net gives the same results on
the graphics card and the CPU; Cellpose-SAM differs slightly (Section 5), and *Auto* may pick
different Cellpose-SAM weights on different computers (recorded in the exports). A page that was updated to a new app version in another tab refuses to
analyse until it is reloaded, so results are never computed by a mix of versions.

**Your data stays in your browser, temporarily.** Photos and results are stored only in this
browser, and a site is removed after a set number of days without use (30 by default), but only
automatically if its results were downloaded after its last change; a site with work that was
never downloaded is kept until you choose to download, keep or remove it. Use
**Download results…** to keep a .zip of every result file:

- site summaries, pooled grains (with a column marking the grains used in the statistics and
  `stats_weight`, each grain's weight in them: pooling the counted grains with these weights
  reproduces the site percentiles in every pooling mode),
  the grain-size curve and a printable report;
- for each photo: its grains table, summary, label mask (an image whose pixel values are
  grain numbers) and outlines (GeoJSON);
- optionally, the project file that reopens the site.

When a project file is opened, every record in it is checked, because the file may come from
someone else: only the fields and values the app itself writes are kept (statistics settings
fall back to the defaults, unknown fields are dropped), texts are kept as plain text, the
working scale of each analysis is taken from its image sizes, a photo keeps only its fine-grain
enlargement setting (at most ×2), and dates in the future are reset. A file whose analysis sizes
do not match is refused.

**GIS.** For a GeoTIFF photo (e.g. a drone orthomosaic tile), the app keeps the file's pixel-to-map
transform and its GeoKeys (the coordinate system, also a user-defined one). It then also exports:

- the **label mask as a GeoTIFF** (`mask_map.tif`) with the source file's transform and GeoKeys,
  background as nodata: it opens in the right place in any GIS;
- the **outlines as GeoJSON in longitude / latitude** (`outlines_lonlat.geojson`, RFC 7946), for
  web maps and any GeoJSON reader. The app converts the GeoTIFF's map coordinates itself (offline):
  Transverse Mercator (Krüger series to n⁶) and Lambert Conformal Conic, with parameters for
  2,698 EPSG coordinate systems on the GRS 1980 / WGS 84 ellipsoids (UTM zones, national grids
  such as NZTM, US State Plane) taken from the EPSG dataset with PROJ, plus Web Mercator and
  geographic CRSs. Only CRSs whose datum PROJ places within 1 m of WGS84 are included, and no
  datum shift is applied. Checked against PROJ 9.8.1 for every CRS: largest difference 0.04 mm
  (`validation/geotiff/`). For other CRSs this file is not offered;
- the **outlines as GeoJSON in map coordinates** (`outlines_EPSG<code>.geojson`, e.g.
  `outlines_EPSG2193.geojson`), exact, with each
  grain's centroid in map coordinates and the CRS as a `crs` member. QGIS and other GDAL-based
  tools read it; readers that follow RFC 7946 (web maps, ArcGIS Online) ignore the `crs` member,
  read every GeoJSON as longitude/latitude and cannot place it. The file name names the CRS for
  that reason;
- a **world file** for the 16-bit PNG mask (`mask16.pgw`) with a `mask16.png.aux.xml` sidecar
  naming the CRS (a world file alone holds no CRS);
- the **photo and the mask reprojected to Web Mercator** (`photo_webmercator.tif`,
  `mask_webmercator.tif`, EPSG:3857, north-up). A projected GeoTIFF's pixel rows run along grid
  east, which differs from true east by the grid convergence (−1.49° for NZTM at 175.3°E). A web
  viewer that draws such a raster north-up inside its corner coordinates, without that rotation,
  misaligns it with correctly converted outlines (by up to ~23 cm across a 9 m photo). On the
  Web Mercator grid no rotation is needed, so photo, mask and longitude / latitude outlines line
  up in any viewer. Each output pixel is taken back to the photo exactly (forward Transverse
  Mercator / Lambert projections, checked against PROJ like the inverse) and sampled nearest
  neighbour (mask) or bilinear (photo). On the NZTM test tile the mask is identical to GDAL's
  `gdalwarp` and the photo within 0.25 grey levels on average.

Outline and mask exports hold every detected grain by default; an option in the Export and
Download dialogs limits them to the grains counted in the statistics (border rule, ROI and size
cutoffs: the grains with `included_in_stats = true` in the grain table).

All of these were checked with GDAL 3.12 on an NZTM 2000 orthomosaic tile: CRS and extent equal the
source GeoTIFF's, and the mask GeoTIFF holds the same grain ids as the PNG mask. The map position
applies while the photo is still the GeoTIFF raster or a 2× upscale of it (the pixel size is then
halved); not after rectification. All other exports (`outlines.geojson`, grain tables, other masks)
are in photo pixels: a GIS would read their pixel coordinates as longitude/latitude.

---

## 15. Validation

**Accuracy against hand-drawn outlines.** Tested on the 40 test photos (13 sites) of the
ImageGrains 2.0 data, against hand-digitised grains. Errors are the absolute % difference of
each photo's percentile (b-axis, in pixels):

| Model | Engine | D50 error, median [95% CI] | D50 error, mean [95% CI] | D16 / D84 median error | Outline quality (PQ) |
|---|---|---|---|---|---|
| U-Net | webGrainy | 9.4% [5.3, 14.9] | 24.4% [13.7, 39.2] | 23.8% / 2.9% | 0.539 |
| U-Net | ImageGrains (original) | 9.3% [6.3, 17.0] | 27.5% [14.8, 46.3] | 21.5% / 3.3% | 0.528 |
| Cellpose-SAM | webGrainy | 2.9% [2.0, 4.9] | 8.9% [4.0, 15.6] | 6.3% / 1.3% | 0.652 |
| Cellpose-SAM | ImageGrains (original) | 4.4% [2.4, 8.3] | 14.3% [8.0, 21.8] | 8.7% / 2.0% | 0.642 |

PQ (panoptic quality) scores how well individual outlines match, from 0 to 1. Important
caveats:

- These sites also contributed training photos, and more than half of the test images (at least
  22 of 40) are tiles cut from the same source photo, orthomosaic or CT scan as training tiles
  (`validation/heldout/heldout_manifest.csv`). The figures describe held-out tiles of familiar
  beds, an optimistic estimate even for new photos of those rivers, and say nothing about new rivers.
- Errors have long tails: 5% (Cellpose-SAM) and 17.5% (U-Net) of photos had D50 errors over
  50%. **Always check the outlines.**
- The table above used an earlier percentile calculation (linear, no 15 px cutoff). Re-run with
  the app as shipped (log2 interpolation, 15 px cutoff on prediction and hand outlines, default
  settings), U-Net gives a D50 error of 15.6% mean [7.3, 25.1] and 5.7% median, D16 / D84 median
  errors of 8.4% / 2.4%, 10% of photos above 50%, and PQ 0.540
  and Cellpose-SAM (INT8 weights) 8.9% mean [3.7, 14.9] and 2.9% median, D16 / D84 5.1% / 1.1%,
  5% of photos above 50%, PQ 0.654 (`validation/heldout/heldout_app_results.md`; 95% intervals
  resample whole sites).

**Same networks as the original software.** With the same photo, the networks' outputs, run
through Cellpose's own post-processing, match the original PyTorch ImageGrains exactly (U-Net)
or almost exactly (Cellpose-SAM: outline agreement 0.995; 7 test photos, `validation/parity/`).
webGrainy's own post-processing differs: on the 40 held-out photos its final outlines agree
with PyTorch ImageGrains' at a panoptic quality of 0.93 (both models).
The 8-bit and 4-bit Cellpose-SAM versions give the same benchmark accuracy as the 16-bit one
(outline agreement 0.994 and 0.966).

**Field comparison (one site).** At the K1 site (two photos, 0.39 mm/px, field count of 251
b-axes, smallest 13 mm, field D50 27.0 mm), the app as shipped (default settings) gives:

| | Cellpose-SAM | U-Net |
|---|---|---|
| D50, all detected grains | 18.7 mm (−31%) | 21.1 mm (−22%) |
| D50, field-count cutoff 13 mm | 27.8 mm (+3%) | 27.7 mm (+3%) |
| D84, field-count cutoff 13 mm | 45.3 mm (−6%) | 45.9 mm (−5%) |

With the field count's size range applied to the photos, both models agree with the field count
within a few percent. Without it, the photo D50 depends on how many small grains the model finds:
Cellpose-SAM counts about 1.5 times as many grains as U-Net here, so its D50 is finer still.
(Before v0.1.0 these 1,300 px photos were analysed at half size; U-Net then missed most grains
below about 10 mm, and its D50 without a cutoff happened to match the field count, by chance.)
Caveats: one site and two photos, both of which overlap the ImageGrains training
data, so this is a consistency check, not an independent validation; the 13 mm cutoff is the
smallest clast in the field data, not a documented protocol (with 10 or 16 mm the D50 difference
is −8% or +12% for Cellpose-SAM). Reproduce with `node validation/k1/run_app_k1.mjs`
(`validation/k1/k1_app_results.md`). Always match the size range when comparing with field data
(Section 8).

**Independent checks of the calculations.** Percentiles, Folk & Ward, ellipse axes and
orientation, Feret widths, tiling and rectification are checked automatically against
independent Python implementations (numpy, scipy, scikit-image) on every code change. The
site-comparison test was checked by simulation (Section 13).

---

## 16. Limitations

- **2D surface measurements.** Sizes are of the visible outline from above, not sieve or
  caliper sizes. Buried or imbricated grains look smaller than they are; the 3D shape is not
  seen.
- **The b-axis is an ellipse width**, not a caliper b-axis (Section 7). Minimum Feret width is
  the closest 2D equivalent.
- **Fine grains are truncated** below the detection limit (Section 8). Fines between and under
  the grains, and the subsurface, are not measured.
- **Lens distortion is not corrected.** It is small for most phone cameras, but wide-angle and
  action cameras can change sizes by 7–22% towards the photo edges. Undistort such photos
  first.
- **Outline resolution.** Outlines are traced on the working image (section 4), so on a large photo analysed at *Auto* each outline step is several photo pixels: exported masks and GeoJSON/SVG outlines have stepped edges. Analyse at *Scale Mode: 1.0x Full* for finer outlines (photos over 16.7 megapixels are still read at 16.7 MP). Outline coordinates are photo pixels, except the map-coordinate exports of GeoTIFF photos (section 14).
- **One scale per photo.** Photos must be taken straight down over a roughly flat bed, or be
  rectified. Tilted photos change the scale across the image.
- **Model limits.** The models were trained on the ImageGrains photo collection. On very
  different beds (other lithologies, wet or algae-covered grains, strong shadows, very small
  grains in the image) outlines can be poor. Check them and edit where needed.
- **Uncertainty needs several photos.** One photo cannot show patch-to-patch variation.

---

## 17. References

- Mair, D., et al. (2023). Automated detecting, segmenting and measuring of grains in images of
  fluvial sediments. *Earth Surface Processes and Landforms*, doi:10.1002/esp.5755.
- Mair, D., et al. (2026). ImageGrains 2.0: Improved precision and generalization for grain
  segmentation. *Earth Surface Dynamics* 14, 527–551, doi:10.5194/esurf-14-527-2026.
  Model weights: doi:10.5281/zenodo.15728186.
- Stringer, C., Wang, T., Michaelos, M., Pachitariu, M. (2021). Cellpose: a generalist algorithm
  for cellular segmentation. *Nature Methods* 18, 100–106, doi:10.1038/s41592-020-01018-x.
- Blott, S. J., Pye, K. (2001). GRADISTAT: a grain size distribution and statistics package for
  the analysis of unconsolidated sediments. *Earth Surface Processes and Landforms* 26, 1237–1248.
- Bunte, K., Abt, S. R. (2001). Sampling surface and subsurface particle-size distributions in
  wadable gravel- and cobble-bed streams. USDA Forest Service RMRS-GTR-74.
- Eaton, B. C., Moore, R. D., MacKenzie, L. G. (2019). Percentile-based grain size distribution
  analysis tools (GSDtools) – estimating confidence limits and hypothesis tests for comparing
  two samples. *Earth Surface Dynamics* 7, 789–806.
- Folk, R. L., Ward, W. C. (1957). Brazos River bar: a study in the significance of grain size
  parameters. *Journal of Sedimentary Petrology* 27, 3–26.
- ISO 9276-2:2014. Representation of results of particle size analysis: calculation of average
  particle sizes/diameters and moments from particle size distributions.
- Kellerhals, R., Bray, D. I. (1971). Sampling procedures for coarse fluvial sediments. *Journal
  of the Hydraulics Division, ASCE* 97, 1165–1180.
- Kish, L. (1965). *Survey Sampling*. Wiley, New York.
- Lotspeich, F. B., Everest, F. H. (1981). A new method for reporting and interpreting textural
  composition of spawning gravel. USDA Forest Service Research Note PNW-369.
- Wentworth, C. K. (1922). A scale of grade and class terms for clastic sediments. *Journal of
  Geology* 30, 377–392.
