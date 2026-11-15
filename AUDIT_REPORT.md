# webGrainy (ImageGrains 2.0 Web): Independent Pre-Release Audit

- **Audited commit:** `494a3a0` (branch `claude/vibrant-brahmagupta-0y32mu`)
- **Audit date:** 2026-11-14
- **Environment:** Node 22.23.4, Chromium (Playwright, headless, no physical GPU), Python 3 with numpy 2.5.3, scipy 1.18.1 and scikit-image 0.26.0
- **Harness:** every script and captured output is in `audit/` (see `audit/README.md`). Nothing under `src/`, `tests/`, or the docs was modified.
- **Network access during the audit:**
  - Hugging Face was reachable. I downloaded `ig2_unet_fp32.onnx` and its SHA-256 matched the LFS oid.
  - Cellpose `dynamics.py` was fetched from MouseLand/cellpose `main`.
  - `github.com/dmair1989/imagegrains` was **not reachable** (403/404 through the proxy). Every statement about ImageGrains-specific upstream parameters is therefore **unverified**.
  - The 617 MB CP-SAM model was **not** run in a browser. There was no GPU, and the time budget did not allow it.

---

## 1. Verdict

**(a) Public release: NO-GO.** The built app cannot complete a single analysis. In `dist/`, ORT resolves `wasmPaths='./ort/'` relative to `dist/ui/main.js`. It therefore requests `/ui/ort/ort-wasm-simd-threaded.jsep.mjs`, gets a 404, and every photo ends as "Batch complete: 0 done, 1 failed", with no reason shown (F-01).

The service worker serves the fixed-name `ui/main.js` cache-first. Once deployed, users would stay on stale code until someone bumps `CACHE_NAME` by hand (F-04).

Weights come from an unpinned `resolve/main` URL, and nothing verifies their hash (F-03).

**Conditions for Go:** F-01, F-03, F-04, F-05 and F-07 fixed; CI added; docs corrected (F-12, F-17).

**(b) Scientific use: CONDITIONAL-GO for exploratory or relative work only. NO-GO for publishable absolute grain sizes** until the following hold:

- **The benchmark claim needs re-establishing.** The "held-out" benchmark is not demonstrably held out. 197 of 237 images carry `site=train`. The post-processor was tuned on images inside that same benchmark (the `0.15` guard is literally named the "`3ca10b7c` fix"). The browser engine "beats" the PyTorch reference it re-implements (F-02).
- **The reported b-axis is not a sieve or caliper b-axis.** It is a moment-ellipse minor axis, which differs from the minimum Feret width by −12 % to +16 % on non-elliptical shapes (F-06).
- **The shipped defaults are not the validated configuration** (F-08).
- **Exports carry no provenance:** no model hash, no settings, no app version (F-10).

The core statistics are correct, and I re-derived them independently: weighted percentiles, Folk & Ward, homography, FP16, and tiling (Section 4).

**Conditions for scientific use:**
1. Re-run the benchmark on a genuinely held-out set with frozen parameters, and publish per-image error distributions.
2. Label the b-axis honestly, and/or add a min-Feret metric.
3. Make the defaults match the validated configuration.
4. Embed provenance metadata in every export.
5. Ship the limitations statement in Section 5.

---

## 2. Findings

Ordered by severity. Confidence: **V** = verified (with a reproduction), **L** = likely (code reading, not executed), **U** = unverified.

| ID | Sev | Cat | Title | Location | Evidence / repro | Impact | Recommended fix | Conf |
|---|---|---|---|---|---|---|---|---|
| F-01 | **Blocker** | A/E | Built app cannot run inference: ORT path resolves to `/ui/ort/` (404) | `src/modules/onnxInference.ts:247`; `esbuild.config.mjs` (UI bundled to `dist/ui/main.js`, ORT copied to `dist/ort/`) | `node audit/browser_e2e.cjs` against `dist/`: `HTTP 404 /ui/ort/ort-wasm-simd-threaded.jsep.mjs`, and the status bar shows "Batch complete: 0 done, 1 failed". In a scratch copy with `dist/ui/ort -> ../ort`, plus `NOGPU=1` (WASM), the same photo completes ("1 done, 0 failed"). | The released app does nothing useful, and the 243 green tests never catch it. | Resolve against the document: `new URL('ort/', document.baseURI).href`, or `new URL('../ort/', import.meta.url)`. Add a Playwright smoke test on `dist/`. | V |
| F-02 | **Blocker** | C/H | The accuracy claims are not "held-out", and there is evidence of tuning on the benchmark | `full_dataset_validation_report.md:32-37` and its per-image table; `PROJECT.md:66` ("`maxGrainAreaFraction = 0.15` … (`3ca10b7c` fix)"); `README.md:43-46` | `python3 -I audit/recompute_validation.py …` (output in `audit/out/validation_recompute.txt`). Results:<br>• All 238 rows have `split=test`, but `site=train` for 198 of them and `site=test` for 40. The section calls 237 images the "Official Held-Out TEST Split".<br>• The browser engine's D50 MAPE vs GT (U-Net 22.93 %, CP-SAM 15.85 %) is lower than the PyTorch reference it ports (28.37 %, 23.59 %), while its PQ vs PyTorch is only 0.52 / 0.73.<br>• On the 40 `site=test` images, U-Net v4 MAPE is **31.3 %** (median 15.7 %, 10 of 40 images >50 % error).<br>• CP-SAM has a 1039 % error on `3ca10b7c` (D50 614 px vs GT 54 px). U-Net finds 1 grain vs 39 on `1c0517d2`. | Headline numbers are optimistically biased and cannot be cited as generalisation error. | Freeze all post-processing parameters, evaluate on images never used for tuning or training, report mean, median, P90 and the fraction >50 %, and state the metric's reference (GT vs PyTorch) explicitly. | V (numbers); L (leakage: the meaning of the `site` column is not documented) |
| F-03 | **High** | C/D | Model weights are unpinned and unverified; the cache trusts any non-empty buffer | `src/modules/modelCache.ts:13` (`…/resolve/main/`), `:256`/`:332` (length checked only if `Content-Length` is present and not compressed), `:365-371` (cache hit = any `byteLength>0`) | HF currently resolves to commit `7773328a…`. The LFS sha256 values are `5e692c55…2053c` (U-Net, 26,489,665 B), which I confirmed with `sha256sum`, and `944a114a…6230d` (CP-SAM, 617,364,567 B). The code has no hash or revision check. The download also redirects to a second host, `cdn.hf.co`. | A repo update or compromise silently changes the science, and cached and fresh installs diverge. Truncated or corrupted IndexedDB entries are never detected. | Pin `resolve/<commit>`, embed the expected SHA-256 and size, verify with `crypto.subtle.digest` before caching and on load, and store the hash in the cache record and in exports. | V |
| F-04 | **High** | D/E | The service worker serves stale code forever; offline-first only works after a successful online run | `src/sw.js:65-77` (cache-first for all same-origin), `:1` (hand-bumped `CACHE_NAME`), `:3-11` (precache omits `ort/*`) | `ui/main.js` and `workers/*.js` have fixed, unhashed names. Navigations are network-first, so after a deploy a user gets the new `index.html` with the old cached `main.js`. ORT `.mjs`/`.wasm` are cached only if fetched while online, and because of F-01 they never are. | Users can run outdated, buggy science with no indication. Offline use on a fresh install fails. | Content-hash the filenames and generate the precache list at build time (Workbox or a manifest). Use stale-while-revalidate for code, precache the one ORT variant actually used, and show the app version in the UI. | V (code); L (runtime staleness) |
| F-05 | **High** | F/E | Failure gives no reason, and some UI capability badges are wrong | `src/ui/main.ts` (batch status); topbar badges | E2E screenshot: "Batch complete: 0 done, 1 failed", with only an `error` chip and no message. The header said "WebGPU Ready" while ORT logged "No available adapters" and dropped the WebGPU EP. | Users cannot diagnose failures and may trust a backend that isn't used. | Surface `err.message` per photo. Base the WebGPU badge on `requestAdapter()` and not `navigator.gpu`. | V |
| F-06 | **High** | B | The "b-axis" is a moment-ellipse minor axis, not a sieve or Feret b-axis | `src/modules/postprocessCore.ts:745-746` (`4·sqrt(λ2)`); UI `src/ui/main.ts:864`; CSV header `b_axis_px/mm` | `audit/out/oracle_output.txt`. The value matches skimage `axis_minor_length` exactly. Ratio b_moment / min-Feret: rectangle 1.083, square 1.155, triangle 0.909, L-shape 0.883, half-disk (occluded) 1.047, ellipse 0.983. The a-axis on an 80×20 rectangle is 92.5 px vs max-Feret 83.5 px. | ±10–15 % shape-dependent bias in every percentile, in the same direction for a given lithology. It is not comparable to caliper or sieve b-axis datasets without saying so. | Rename it to "ellipse-equivalent minor axis" everywhere, or add a min-Feret width (rotating calipers on the convex hull already computed in `morphometricsExt.ts`). Document which metric ImageGrains upstream uses (U). | V |
| F-07 | **High** | B | Single-photo statistics ignore the ROI and exclusion polygons the user drew | `src/modules/pipelineController.ts:1223-1240` (`recomputeDerivedState` applies only rescale, calibration and border filter); `src/ui/main.ts:163` (single-photo dashboard uses `session.getStats()`) | Only `siteAnalysis.ts:1052` and the pooled-CSV export call `filterGrainsByRoiAndExclusion`. The photo summary CSV/JSON, the "Active Photo" D-values and Folk & Ward include grains on boots, rulers and vegetation that the user excluded. | The same photo gives different D50 in the "Active Photo" and "Pooled Site" views. Excluded objects contaminate exports. | Apply the ROI filter inside the session (or in `computeSedimentStats` callers), and add a test that an excluded grain changes D50. | L (code path traced; not driven in the UI) |
| F-08 | **High** | B/F | Shipped defaults differ from both the engine defaults and the validated configuration | UI `src/ui/state.ts:160-163` (`flowThreshold 0.4`, `minSize 15`); engine `postprocessCore.ts:7-15` (`0.45`, `30`); notebook (`flow_threshold 0.4`, `min_size 30`); upstream Cellpose `dynamics.py:622` (`0.4`, `min_size 15`, `max_size_fraction 0.4` vs `0.15` here) | Grep output in the audit log. | The configuration users run has never been benchmarked. `minSize` and the border margin also apply at *working* resolution, so the effective minimum grain size in original pixels depends on the auto-downscale factor (`pipelineController.ts:452-475`). | Use one source of truth for defaults, record the effective original-pixel min size, and validate exactly what ships. | V |
| F-09 | **High** | B | The flow-QC is not Cellpose's `flow_error`, and README/report parity wording overstates it | `postprocessCore.ts:236-390` | Upstream (`dynamics.py:292-319`): `mean(sum_c (dP_mask − dP_net/5)²)` against a threshold of 0.4. Port: `Σ w·25‖û_net − û_ideal‖² / Σw / 10` against 0.45, with magnitude weighting and center exclusion. This is a different statistic with a different scale. Mutation "remove magnitude weighting" **survives** the test suite. | Masks differ from upstream (PQ vs PyTorch 0.52 for U-Net). "Exact parity to eval_core.py" claims are not accurate against Cellpose itself. | Call it a "custom QC (v4.1)" in the docs, document the derivation, and add regression tests on real flow fields. | V |
| F-10 | **High** | F | Exports lack provenance and reproducibility metadata | `sedimentStats.ts:383-430` (`exportSummaryJson` = report only); `siteAnalysis.ts:1527+` | None of the CSV, JSON, GeoJSON or SVG exports contains the app version, model id/hash, post-processing parameters, scale factor, calibration method or date, CLAHE setting, or an unofficial-port/citation notice. | Results cannot be reproduced or audited after publication. | Add a `metadata` block or header rows to every export. | V |
| F-11 | **Medium** | D | CSV formula injection via photo labels (filenames or imported archives) | `src/modules/siteAnalysis.ts:1507-1513` (`csvEscape`), used at `:1690` for `photo_name` | `audit/edge_cases.audit.ts`: rows are emitted as `p1,=1+2.jpg,` and `p2,@SUM(1).jpg,`. | Opening the export in Excel/LibreOffice evaluates attacker-controlled formulas when an archive comes from someone else. | Prefix cells beginning with `= + - @ \t \r` with `'`, per OWASP. | V |
| F-12 | **Medium** | H | README benchmark table mixes references | `README.md:45-46` | "`22.93%` (Median `10.33%` vs. PyTorch)": 22.93 % is the mean vs **human GT**, while 10.33 % is the median vs **PyTorch**. Likewise "15.85 %" (vs GT) next to "2.21 %" (vs PyTorch). Recomputed in `audit/out/validation_recompute.txt`. | Misleading accuracy claim. | Split the columns: vs GT (mean/median/P90) and vs PyTorch. | V |
| F-13 | **Medium** | D | Archive import is unvalidated and can silently overwrite data | `src/modules/projectStorage.ts:503-578` | Only `format`, `version` and id strings are checked. `saveSite(arch.site)` overwrites an existing site with the same `siteId`. A failure mid-way leaves a partial import (no transaction). There is no size limit, and `base64ToUint8` on a huge string can exhaust memory. `workingImage.data` length, `effectiveScaleFactor` and `calibration.mmPerPx` types are unchecked; mask length *is* checked (`pipelineController.ts:585-600`). | Data loss on re-import, crashes on malformed files. | Use a schema validator, an id-collision prompt or new ids, a size cap, and an atomic multi-store transaction. | V (code) |
| F-14 | **Medium** | B | Statistics are reported for meaningless sample sizes | `sedimentStats.ts:182-232`, `:289-345` | With one grain, Folk & Ward returns σ=0 "Very Well Sorted", "Mesokurtic", and D16=D50=D84 (`audit/out/edge_cases.json`). There is no minimum-n guard on single-photo stats; the adequacy rating exists only at site level. | Users may report nonsense classifications. | Suppress or flag Folk & Ward and percentiles below n≈30–100, and show n next to every statistic. | V |
| F-15 | **Medium** | B | Mixed calibrated/uncalibrated grains silently fall back to px | `sedimentStats.ts:301-311` | A mm-calibrated grain plus an uncalibrated grain gives `unit:'px'`, D50 38.2 (edge_cases.json). The fallback is defensible, but no warning reaches the user. | Users may not notice a missing calibration. | Return a warning, and refuse mm stats with an explicit message. | V |
| F-16 | **Medium** | G | Test suite: all inference, IndexedDB and fetch are mocked; no real model; no UI or dist test; key formulas unprotected | `tests/e2e/helpers/mocks.ts`, `tests/onnxInference.test.ts` | Mutation check (`audit/out/mutation_results.txt`): 5 of 9 killed. **Survived:** binomial CI α vs α/2, Wentworth 64→32 mm edge, F&W sorting threshold, flow-QC weighting. No test touches `dist/`, which is why F-01 is invisible. | Regressions in science and integration go undetected. | Add a Playwright test on `dist/`, a real U-Net regression fixture with golden masks, property tests for stats, and tests for the class thresholds. | V |
| F-17 | **Medium** | A | Flaky timing tests | `tests/imagePreprocess.test.ts` (`< 5 ms`), plus a second "budget" test | Failed in 4 of 5 consecutive runs (57–82 ms) on this machine, and another timing test failed once. | CI would be red or noisy; the README "< 5 ms" claim is not met here. | Move benchmarks out of the unit suite, or use generous relative budgets. | V |
| F-18 | **Medium** | E | Peak memory when loading CP-SAM is about 2× the model size | `modelCache.ts:188-200` (`concatChunks` holds all chunks plus the merged buffer) | 617 MB × 2 transient, plus the ORT session copy. | Out-of-memory or tab crash on 4 GB devices and iOS. | Stream into a preallocated buffer when `Content-Length` is known, release chunks, and gate CP-SAM on `deviceMemory`. | L |
| F-19 | **Medium** | B | The binomial CI uses integer ranks with no interpolation, and has no tests | `siteAnalysis.ts:638-676` | `le` = last m with CDF≤α/2 and `ue` = first m with CDF≥1−α/2, without the interpolation used in Eaton et al. (2019) / GSDtools. Applied to area weights via Kish n_eff, which is an approximation that is labelled as such. Mutation α/2→α **survives**. | Slightly conservative or jagged CIs, and regressions would go unnoticed. | Interpolate ranks as in GSDtools, and add a test against published GSDtools output. | V (code) / U (exact paper parity: paper not consulted) |
| F-20 | **Low** | F | CI label is hard-coded to "95%" | `src/ui/main.ts:922` | It shows "95% CI" even when `confidenceLevel=0.9`. | Mislabelled uncertainty. | Use `report.bootstrapCi.confidenceLevel`. | V |
| F-21 | **Low** | E | No `onversionchange` handler for IndexedDB | `projectStorage.ts:121`, `modelCache.ts:79` (only `onblocked`) | grep | A second tab with a newer schema blocks forever. | Close the database on `versionchange`. | V |
| F-22 | **Low** | D | No CSP and no COOP/COEP, so `crossOriginIsolated=false` and WASM runs single-threaded | `src/index.html` | Smoke test: `coi:false`. | Slower WASM fallback; no defence-in-depth against XSS. | Add a CSP (`default-src 'self'; connect-src 'self' https://huggingface.co https://*.hf.co; img-src 'self' blob: data:; worker-src 'self'`) and document COOP/COEP headers. | V |
| F-23 | **Low** | H | Docs drift | `README.md:109` ("12 suites/218 tests"; actual 16 files/243 tests), `PROJECT.md:17` (`/home/antigravity/…`), `full_dataset_validation_report.md:23` (`figures/` does not exist; the PNG is at the repo root), HF card "~588 MB" (actually 617,364,567 B = 588.8 MiB) | ls/grep | Credibility. | Fix them. | V |
| F-24 | **Low** | H | Release hygiene gaps | repo root | No CI, CHANGELOG, CITATION.cff, NOTICE/third-party licences (ORT is MIT and bundled into `dist/ui/main.js` and `dist/ort`; SAM ViT encoder is Apache-2.0), deployment guide, or browser matrix. The notebook has no saved outputs, no pinned installs, and pulls weights from `main`. `dist/` is 111 MB because every ORT variant (webgl, jspi, asyncify…) is copied, although only `jsep.mjs`/`jsep.wasm` were requested. | Licence non-compliance risk and an irreproducible validation. | See the checklist in Section 6. | V |
| F-25 | **Info** | D | Network egress | grep of `src/` and `dist/ui/main.js` | The only `fetch` is `modelCache.ts:226`. No XHR, beacon or WebSocket. ORT strings reference only `web.dev` (a doc link). Observed browser requests: same origin plus `huggingface.co` (→ `cdn.hf.co` redirect). The "no data leaves the device" claim holds for imagery and measurements. EXIF GPS is stored and exported in archives, so users should be told. | — | Mention that GPS is retained in archives. | V |
| F-26 | **Info** | B | Wentworth "proportions" lump 2–64 mm as one class and call <2 mm "sand" | `sedimentStats.ts:238-283` | Cannot be resolved in photos anyway. The finer 0.5/1 φ histogram in `morphometricsExt.ts:449-461` is correct. | Low. | Label it "<2 mm (unresolved fines)". | V |

---

## 3. Claims vs reality

| Claim (source) | Reality | Status |
|---|---|---|
| "Zero external CDNs", "ORT binaries bundled locally" (README:5,13) | True: no CDN requests. However, the bundled path is wrong (F-01), so no ORT backend loads at all. | ✗ (functionally) |
| "Offline-first" (README:3) | Only the shell is precached. ORT is never cached (F-01/F-04). Code goes stale after deploys. | ✗ |
| "No imagery or measurements uploaded" | No egress except the model download (F-25). | ✓ |
| "12 test suites / 218 tests" (README:109; PROJECT.md:87 "DONE") | 16 files / 243 tests; 1–2 timing tests fail most runs. | ✗ |
| "`< 5 ms` complexity router" (README:18) | 57–82 ms measured under the test runner. | ✗ (here) |
| U-Net "22.93 % (Median 10.33 % vs. PyTorch)" (README:45) | 22.93 % is the mean vs GT; 10.33 % is the median vs PyTorch (`audit/out/validation_recompute.txt`). | ✗ mislabelled |
| CP-SAM "15.85 % (Median 2.21 % vs. PyTorch)" (README:46) | Same mix-up. One image has 1039 % error. | ✗ mislabelled |
| "Official Held-Out TEST split, 237 images" (report §3) | 197/237 have `site=train`. On `site=test` only (n=40), U-Net v4 is 31.3 % and CP-SAM 12.5 %. | ✗ unsupported |
| "exact parity to eval_core.py" (postprocessCore.ts docstring) | It reproduces the authors' own notebook, not Cellpose (F-09). PQ vs PyTorch is 0.52 (U-Net) and 0.73 (CP-SAM). | ⚠ |
| "Area-weighted (Wolman / grid-by-number equivalent)" (README:33; main.ts:896) | Correct in principle: P(grid hit) ∝ exposed area (Kellerhals & Bray 1971). Caveats: exposed 2D area only, and fines are truncated. | ✓ with caveat |
| "matches skimage.measure.regionprops" (tests/postprocess.test.ts) | Fixture reproduced with skimage 0.26 to 4 dp for all 4 cases. No generator script or version is recorded. | ✓ (provenance missing) |
| FP16 "round-to-nearest-even, subnormals, ±Inf, NaN" | 20,029 values bit-identical to numpy `float16` (the one apparent diff is −0 lost in JSON). | ✓ |
| "Folk & Ward with proper coarse-to-fine mapping" | φ16 = −log2 D84 etc. Formulas identical to an independent recomputation, and skew sign correct for a coarse-tailed sample. | ✓ |
| HF model "≈588 MB" | 617,364,567 bytes (588.8 MiB). | ⚠ units |
| Model licence | HF card: CC-BY-4.0 "derived from Zenodo 10.5281/zenodo.15728186". Repo code: BSD-3. Upstream ImageGrains licence could not be fetched. | U |
| Post-processing time "13–16 s/image" (report) | Not measured on GPU. **Correction (2026-11-15):** the "several minutes" originally reported here came from a bug in my audit script, which waited out its full timeout because its status selector never matched. Measured per stage in headless Chromium on 4 cores (`audit/perf/`), a 1024×768 photo with U-Net on WASM takes inference 18.4 s (single-threaded) / 6.7 s (cross-origin isolated, all cores) plus post-processing about 1.2 s. | V (CPU) |

---

## 4. Independently verified OK

| Item | How I checked | Result |
|---|---|---|
| typecheck, build, `npm audit` | `npm ci && npm run typecheck && npm run build && npm audit` | Pass; 0 vulnerabilities |
| Weighted percentiles (area and number), ties, n=1, n=2, edge clamping | 204 random and edge cases vs `np.interp(p, (cumsum(w)-w/2)/Σw, v)` in `audit/oracle.py` | Max relative error 2.1e-16 |
| Folk & Ward Mz, σI, SkI, KG and the φ↔D mapping | Recomputed from the TS percentiles in Python | Identical; skew sign correct (coarse tail → negative φ skew, "Coarse Skewed") |
| Folk & Ward class thresholds | Compared with Folk & Ward (1957) | Correct (sorting uses 0.70 vs the commonly quoted 0.71: negligible) |
| Moment axes and orientation | vs skimage `regionprops` (`axis_minor_length`, `orientation`) on 6 shapes | Identical (square orientation is degenerate) |
| Float32→Float16 conversion | 20,029 values incl. subnormals, ties, overflow, ±Inf, NaN vs numpy | Bit-identical |
| Tile coverage | `tileStarts` for L ∈ {1…4000} | Full coverage, last tile ends at L, no negative starts |
| Hanning blend | vs `np.clip(np.hanning(256),1e-3,1)` | Matches; min weight 1e-6 > 0, so no divide-by-zero |
| Reflection padding | vs `np.pad(mode='reflect')` | Identical over [−12, 25) |
| 4-point homography | vs SVD-DLT in numpy with ~4000 px coordinates | Reprojection error 1.4e-13 px; collinear input raises a clear error |
| Area vs linear rescaling to original resolution | Code review (`pipelineController.ts:452-475`) plus mutation (area×inv is killed by tests) | Correct (`area·s⁻²`, lengths `·s⁻¹`) |
| XSS in UI templates | Grep of every `${…}` in `innerHTML` templates | User-controlled strings (site/photo names, labels, status, warnings, chart titles) all pass through `esc()`. Thumbnails are `blob:` URLs. No injection found. |
| EXIF parser | Read `src/ui/exif.ts` | Every read bounds-checked, loops bounded by `uint16` counts, 128 KiB slice, no recursion. Safe. |
| Downloaded U-Net integrity | `sha256sum` vs HF LFS oid | Match (`5e692c55…`) |
| Pipeline logic with the ORT path fixed | Headless E2E with WASM backend and the real U-Net, in a patched scratch copy of `dist/` | Completes and produces masks (recall was low on my out-of-distribution synthetic ellipses, so this is not an accuracy statement) |

---

## 5. Scientific validity statement

**What the tool can be trusted for**, once F-01 is fixed:
- Correct statistics *given* a set of masks: percentiles, Folk & Ward, Wentworth histogram, homography rectification, and bootstrap/jackknife plumbing.
- Relative comparisons between photos taken with the same camera, height and lighting, processed with identical settings and model hash.

**What it cannot yet be trusted for:**
- **Absolute D50 / D84.** The best available evidence is the authors' own table. Expect a typical (median) D50 error of about 4–10 % vs hand-digitised masks, but a mean of 16–31 % and a long tail: 6–14 % of images are off by more than 50 %, and one by about 10×. These numbers are in **pixels against hand-digitised masks**, not against sieve or Wolman measurements, and probably include training-site images.
- **Sieve-equivalence.** The size metric is the ellipse-equivalent minor axis of the *exposed 2D* outline (F-06). It is biased against caliper b-axes by roughly ±15 % depending on shape, and further by burial, imbrication and the 2D projection of 3D clasts.
- **Fine tails (D5–D16).** These are truncated by `minSize` (15–30 px at working resolution, which grows in original pixels when images are downscaled) and by resolution generally.

**Conditions that degrade results:** wet or shiny surfaces, strong shadows, vegetation, sand matrix (the 0.15 area guard was added specifically for "sand sheets"), images with fewer than about 100 interior grains, very large clasts relative to the frame (border exclusion removes them preferentially), oblique photos without rectification, lens distortion (not modelled at all), and drone photos downscaled to ≤1024 px.

**Suggested README / UI wording:**
> *webGrainy is an unofficial browser port of ImageGrains 2.0 and is not endorsed by its authors. Its post-processing differs from Cellpose/ImageGrains. Reported "b-axis" values are the minor axis of the moment-equivalent ellipse of each grain's visible outline. They are not sieve or caliper b-axes. On the authors' benchmark, D50 errors against hand-digitised masks had a median of about 4–10 % but exceeded 50 % for 6–14 % of images, and that benchmark was not fully independent of tuning. Lens distortion is not corrected, and fine fractions below about 15–30 working-resolution pixels are not detected. Always calibrate scale, check the masks visually, report n, and validate against field measurements (Wolman or sieve) for your site before using the absolute values in publications.*

---

## 6. Minimum release checklist (in priority order)

| # | Item | Fixes | Effort |
|---|---|---|---|
| 1 | Fix the ORT `wasmPaths` resolution and add a Playwright smoke test on `dist/` that runs a real U-Net inference | F-01, F-16 | S |
| 2 | Pin the HF revision, verify SHA-256 and size before caching and on load, record the hash | F-03 | S |
| 3 | Hashed filenames and a build-generated SW precache that includes the ORT variant used; update prompt | F-04 | M |
| 4 | Show error reasons per photo; base capability badges on `requestAdapter()` | F-05 | S |
| 5 | Apply ROI/exclusion to single-photo stats and exports | F-07 | S |
| 6 | Unify defaults with the validated configuration; document the working-resolution `minSize` | F-08 | S |
| 7 | Provenance metadata in all exports (version, model hash, params, calibration, scale, date, notice) | F-10 | M |
| 8 | Rename or relabel "b-axis"; optionally add min-Feret | F-06 | M |
| 9 | Correct README/report metric labels; remove the "held-out" claim until re-validated | F-02, F-12, F-23 | S |
| 10 | CSV formula neutralisation; archive schema validation, id-collision handling, size cap | F-11, F-13 | M |
| 11 | n-guards and warnings for small or mixed-unit samples; CI-level label | F-14, F-15, F-20 | S |
| 12 | CI (typecheck, test without timing tests, build, audit, dist smoke) | F-16, F-17 | S |
| 13 | NOTICE / THIRD_PARTY_LICENSES (ORT MIT, SAM Apache-2.0, Cellpose BSD-3, weights CC-BY-4.0), CITATION.cff, CHANGELOG | F-24 | S |
| 14 | Deployment guide: HTTPS, `application/wasm` MIME, COOP/COEP, CSP, base path; browser matrix; prune unused ORT files | F-22, F-24 | M |
| 15 | Genuinely held-out re-validation (Section 7) | F-02 | L |

---

## 7. Recommended validation protocol

**For the maintainers:**
1. **Freeze the configuration.** Before evaluation, record the model commit and SHA-256, every post-processing parameter, the app version, and the scale mode.
2. **Use a held-out benchmark.** Select images from sites that were never used to train IG2 *and* never inspected while tuning the v4 engine. Publish the site list. Evaluate in the shipped browser engine, not the Python re-implementation. Report the following, per model and in a single table that clearly states its reference (GT or PyTorch):
   - D16, D50 and D84 errors: mean, median, P90, and the fraction above 25 % and above 50 %;
   - PQ;
   - signed bias.
3. **Run physical ground truth.** At 5 or more reaches, compare against Wolman counts (≥100 b-axis caliper measurements, grid-by-number) and, where possible, bulk sieve samples converted with Kellerhals & Bray. Report the bias of area-weighted photo D50 against Wolman D50 in mm, and the ellipse-minor vs caliper ratio.
4. **Build a regression suite with real model outputs.** Commit 3–5 small images with their frozen U-Net ONNX flow fields and golden masks/percentiles, generated from the pinned model. Run them in CI under Node ORT (WASM) and in Playwright on `dist/`, with explicit tolerances. Store the scripts that generate the skimage fixtures, with pinned versions.
5. **Add property and fuzz tests:** stats invariances (scaling all sizes by k scales the D-values by k; permutation invariance; φ skew sign flip under reflection), an archive-import fuzzer, and EXIF fuzzing.

**For users (put this in the user guide):**
1. At every site, photograph a reference scale in-plane (≥2 points, as far apart as possible), shoot near-nadir or rectify, and avoid wet or shadowed surfaces.
2. On at least one photo per campaign, do a 100-clast Wolman or caliper count of the same patch and compare D50 and D84. Proceed only if the difference is acceptable for your purpose.
3. Inspect every mask overlay. Delete false positives such as rulers, boots and vegetation, and split merged clasts.
4. Report n, the pooling mode, the weighting, the model id and hash, the settings, and the statement that the size metric is the ellipse minor axis.
5. Treat D16 and finer as truncated unless validated.

---

## 8. Remediation status (v1.1.0, 2026-11-15)

The fixes below were made after the audit. Each one is backed by a test or by a re-run of
the reproduction that originally exposed the finding.

| ID | Status | Fix | Verification |
|---|---|---|---|
| F-01 | **Fixed** | `resolveWasmPaths()` resolves ORT paths against `document.baseURI` (`src/modules/onnxInference.ts`) | `npm run test:e2e:browser` on `dist/`: "1 done, 0 failed", n = 19 grains. The same script on the original build fails ("0 done, 1 failed"). Unit tests added in `tests/onnxInference.test.ts`. |
| F-02 | **Documented (not fixable in code)** | README table split by reference, with a held-out caveat. Caveat block added to the validation report. | Numbers from `audit/recompute_validation.py`. A genuinely held-out re-validation (Section 7) is still required. |
| F-03 | **Fixed** | Pinned revision `7773328a…`; size and SHA-256 verified via WebCrypto before caching and on every cache hit; legacy records re-downloaded | 5 new tests in `tests/modelCache.test.ts` (tamper, wrong size, legacy record). The E2E run used the pinned URL. |
| F-04 | **Fixed** | Build stamps `sw.js` with a content hash and generated precache lists, plus a separate ORT cache; auto-activation with a reload prompt | Smoke test checks every precache asset returns 200 and that no placeholder is left. |
| F-05 | **Fixed** | Per-photo error text and the batch failure reason are shown; WebGPU is reported only when a real adapter exists | E2E screenshot shows "WASM SIMD" on a headless browser with no adapter. New engine and inference tests. |
| F-06 | **Fixed (labelling plus new metric)** | UI, README and export metadata define the size metric. Min/max Feret added (`computeFeretDiameters`, pooled CSV `min_feret_*`). | Matches the Python oracle exactly on 6 shapes (`audit/oracle.py` section 7). Unit test on a 20×80 rectangle. |
| F-07 | **Fixed** | `AnalysisSession.setRoiConfig()`: stats and exports exclude ROI-excluded grains; CSV `in_roi` column; UI wired | `tests/auditRegressions.test.ts` (n and D50 change, CSV flags) |
| F-08 | **Fixed** | UI defaults read from `DEFAULT_POSTPROCESS_OPTIONS` (0.45 / 30 = the benchmarked v4 configuration) | E2E screenshot shows 0.45 / 30 |
| F-09 | **Documented** | README states that the QC is custom and is not Cellpose `flow_error` | Magnitude-weighting regression test added (the mutant now dies) |
| F-10 | **Fixed** | `provenance.ts`: metadata in summary CSV/JSON, GeoJSON, SVG, printable PSD SVG, and `#` headers in grain CSVs; site exports list per-photo model hashes | `tests/auditRegressions.test.ts` (F-10 block) |
| F-11 | **Fixed** | `csvCell()` applies OWASP neutralisation to every CSV string cell | Unit tests, including the pooled CSV with an `=HYPERLINK` label |
| F-12 | **Fixed** | README table rewritten | — |
| F-13 | **Fixed** | Validate-then-write import, size and dimension caps, prototype-key stripping, MIME whitelist, id remap on collision | 3 new tests (mismatch causes no write, collision keeps the existing site, `__proto__` stripped) |
| F-14 / F-15 | **Fixed** | `warnings[]` on stats (n < 30, n < 100, mixed calibration, uncalibrated); Folk & Ward null for n < 2; shown in the dashboard | Unit tests |
| F-16 | **Fixed** | Real-model `dist/` smoke test, plus regression tests for all 4 surviving mutants | Mutation check: **9/9 killed** (`audit/out/mutation_results_after_fixes.txt`) |
| F-17 | **Fixed** | `perfBudget()` uses a 50× budget by default; `npm run test:perf` enforces the nominal budget | 3 consecutive full-suite runs green |
| F-18 | **Fixed** | Streaming into a preallocated buffer when `Content-Length` is known | Existing streaming tests, plus the E2E run |
| F-19 | **Fixed** | Linear interpolation of binomial ranks | Matches an independent scipy computation for 6 (n, p, α) cases to 1e-3 |
| F-20 | **Fixed** | CI label uses `bootstrapCi.confidenceLevel` | — |
| F-21 | **Fixed** | `db.onversionchange = () => db.close()` in both databases | — |
| F-22 | **Fixed (meta CSP; COOP/COEP documented)** | CSP `<meta>` in `index.html`; header guidance in `DEPLOYMENT.md` | E2E run on the CSP build: no violations, inference completes |
| F-23 | **Fixed** | PROJECT.md path and milestone, figure path, README counts removed in favour of CI | — |
| F-24 | **Fixed (one item still open for maintainers)** | CI, CHANGELOG, CITATION.cff, THIRD_PARTY_NOTICES.md, DEPLOYMENT.md (with browser matrix); `dist/` pruned from 111 MB to 35 MB | Open: confirm with upstream that redistributing the converted weights under CC BY 4.0 is compatible with the upstream terms (unverifiable from here) |

**Still open, and needed before scientific use:** a genuinely held-out validation against
physical measurements (Section 7), and a decision on whether to offer min-Feret as a
selectable pooling size metric (it is currently exported but not pooled). The revised
verdict for public release is **Conditional-Go**, subject to a green CI run on the target
host and the post-deployment checklist in `DEPLOYMENT.md`.
