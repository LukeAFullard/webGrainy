# K1 field-comparison gap: investigation (2026-11-15)

> **Current numbers: [`k1_app_results.md`](k1_app_results.md)**, produced by
> `node validation/k1/run_app_k1.mjs` with the app as shipped (Cellpose pipeline, Auto image
> scale, the app's own site statistics). With the 13 mm field-count cutoff: D50 +3% (both models),
> D84 −6% (Cellpose-SAM) / −5% (U-Net). Without it, the photo D50 is 31% (Cellpose-SAM) and 22%
> (U-Net) finer. (Before v0.1.0 Auto analysed these photos at half size and U-Net, missing most
> small grains, matched the field D50 by chance.) The investigation below used the earlier legacy
> full-resolution pipeline and a separate Python analysis; its conclusion (the gap is truncation)
> still holds, but its figures are not the app's current output.

**Question:** at the K1 site, webGrainy's photo D50 (about 15.7 mm) is about 42% finer than
the field caliper count (D50 27.0 mm, n = 251). Why?

**Answer:** almost entirely **truncation**. The two numbers describe different size
ranges. The field count's smallest recorded clast is 13 mm, so grains below about
13 mm were not recorded. The photo analysis includes every grain it detects, down to a
few mm. In these photos, grains below 13 mm cover **about 43% of the bed area**. When the
photo distribution is cut at the same 13 mm, D50 agrees with the field count to within
**+3% (U-Net) / +4% (Cellpose-SAM)**.

## Data and method
- **Field data:** `dmair1989/imagegrains` `demo_data/K1_field_measurement.csv`: 251 b-axes
  in cm. D16/D50/D84 = 19.0 / 27.0 / 48.0 mm; minimum 13 mm.
- **Photos:** `demo_data/K1/K1_C2_385.jpg` (1200×1350) and `K1_C3_0449.jpg` (1287×1267),
  0.39 mm/px (scale taken from the upstream demo notebook).
- **Engine:** shipped webGrainy code (`dist/`) and pinned, SHA-256-verified weights,
  WASM backend, full resolution, default post-processing settings
  (`run_engine_k1.mjs`). Size metric is the reported `bAxis`; both photos pooled.
- **Analysis:** `analyze_k1.py`. Full output in `k1_results.txt`. Bootstrap 95% CIs
  use 2000 resamples.

Reproduce:
```bash
node validation/k1/run_engine_k1.mjs unet <ig2_unet_fp32.onnx> K1_C2_385.rgba 1200 1350 unet_K1_C2_385
python3 -I validation/k1/analyze_k1.py K1_field_measurement.csv unet_K1_C2_385 unet_K1_C3_0449 ...
```
The `.rgba` files are raw RGBA bytes of the JPEGs. The comment in each script shows how
they were produced.

## Results (D50 vs field 27.0 mm)

| Photo statistic | U-Net D50 | CP-SAM D50 | vs field |
|---|---|---|---|
| App default: all interior grains, area-weighted | 15.6 mm | 15.8 mm | −42% |
| Same grains, true grid-by-number (18 px grid, repeat hits counted) | 15.6 | 15.7 | −42% |
| All grains, by number | 5.9 | 5.8 | −78% |
| Upstream ImageGrains demo recipe (edge 21%, b > 8 px, 18 px grid, unique grains, by number) | 7.3 | 7.2 | −73% |
| **Truncated at the field minimum (13 mm), area-weighted** | **27.7** | **28.2** | **+3% / +4%** |
| Truncated at 13 mm, by number | 18.1 | 18.3 | −33% |

With the 13 mm cutoff, D16/D84 are 16.9/45.8 mm (U-Net) and 16.9/45.3 mm (CP-SAM),
against 19.0/48.0 mm in the field: within −11% and −6%.

## What this shows
1. **The weighting is implemented correctly.** Area-weighted percentiles equal a true
   grid-by-number count on the same masks (15.6 vs 15.6 mm). Area weighting is the
   right analogue of a Wolman count, and by-number statistics are not comparable with
   one (−78%).
2. **The gap is a sampling-definition mismatch, not a segmentation or scale error.** Once
   the photo is restricted to the size range the field count covers, D50 and D84 agree
   within a few percent for both models. That leaves little room for a large
   calibration or burial bias at this site.
3. **The upstream demo recipe is not a like-for-like comparison either.** Its 18 px grid
   counts each grain once, which makes it close to by-number (D50 about 7 mm).

## Caveats
- **The cutoff is an assumption.** It is the smallest clast in the field data (13 mm).
  The actual field protocol is not documented. The result is sensitive to this value:
  D50 error is −8% at 10 mm, +3% to +4% at 13 mm, and +13% to +14% at 16 mm (see the
  sweep in `k1_results.txt`). D84 is robust (within ±7% for cutoffs of 8–20 mm).
- **One site, two photos.** Crops of both photos are in the IG2 training set
  (`APF_2/train`, one in `APF_2/test`). This is a consistency check, not an
  independent validation.
- **D16 remains about 11% fine** at the 13 mm cutoff. This is consistent with a fuzzy
  field cutoff rather than a hard one.

## Consequences
- **Raw photo D-values are not comparable with field counts.** A photo D50 from all
  detected grains includes fines that pebble counts normally skip. It will be finer than
  a field D50 by an amount that depends on how much of the bed is fine material (43% of
  the area at K1).
- **The app now has a `Field-count cutoff (mm)` site option** (`minSizeMm`). Set it to
  the smallest clast your field protocol records when comparing with, or replacing, a
  pebble count. Leave it at 0 to describe everything visible down to the detection
  limit.
