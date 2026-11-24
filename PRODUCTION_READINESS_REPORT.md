# Production readiness report: webGrainy v0.1.0

- **Audited commit:** `f740f522f484` (`main`, "Merge pull request #101", the merge of the review batches 1–11)
- **Date:** 2026-11-24
- **Environment:** Linux container, Node 22.23.5, npm 10.9.9, 4 CPU cores, no GPU. Headless Chromium (Playwright 1.63.0). Outbound access to Hugging Face, Zenodo and GitHub.
- **Method:** I ran every gate listed in the brief. I added scratch harnesses (kept outside the repository) for behaviour that no repository test covers. During the audit no source, test, config or documentation file in the repository was changed; this report was the only new file. The fixes for B1, M1 and M2 came afterwards, in a separate commit (section 8).

---

## 1. Verdict

> **Update after the fixes (section 8):** B1, M1 and M2 are fixed, and each fix has a regression test that fails on the old code. Typecheck, the full suite (860 tests), the build, and both browser smoke tests and the service-worker smoke test pass on the fixed tree. **Re-assessed verdict for the fixed tree: PRODUCTION READY. No blocking or major issues remain open.** One thing can only be observed on GitHub after the merge: that the first Pages run on `main` shows `deploy: success`. That is step 1 of the release checklist (section 7). The verdict below is the original one, for the audited commit `f740f522f484`.

### **NOT PRODUCTION READY** (audited commit `f740f522f484`)

The code itself is in very good shape:

- **Build, type safety and audit:** the build is clean, the type check has 0 errors, and `npm audit` reports 0 vulnerabilities.
- **Tests:** all 847 unit/parity/E2E tests pass on 3 runs (including strict perf). Both browser smoke tests (U-Net and Cellpose-SAM) and the service-worker update test pass. The numerical oracle and the CRS/PROJ check pass.
- **Accuracy:** I reproduced the README's U-Net accuracy end to end from the raw held-out data, and the regenerated per-image file is byte-identical to the committed one. The Cellpose-SAM re-run matches exactly so far (every image finished at the time of writing).
- **Privacy, offline and security:** the privacy claim and the offline mode hold in a real browser. Model integrity checks are sound, and fuzzing found no crash in the TIFF and project-file parsers. Accessibility scans are clean.

**One release-blocking defect remains: the documented release path does not deploy.** Since the review batches merged, `pages.yml` builds on every push to `main` but **skips its `deploy` job**, and the run still reports success. The live site is still the pre-review build from 23 Nov. Merging v0.1.0 to `main` would therefore not publish it, and nothing would turn red.

There are also two MAJOR issues:

- **Service-worker updates can serve stale code on GitHub Pages.** The update can install the old files under the new version's cache name. The ONNX Runtime cache can stay stale across later deploys.
- **Incomplete ONNX Runtime licence notices** for the redistributed WebAssembly binary.

All three fixes are small. Once B1 is fixed and a deploy is confirmed live, I see no further blocker.

---

## 2. Blocking issues

### B1. The automatic GitHub Pages deploy is silently skipped, so a merge to `main` does not publish

- **Severity:** BLOCKER (broken deploy; the documented behaviour is false).
- **Introduced by:** review batch 4 (F-17, commit `44bed0d`). That batch added a `ci` job that runs only on manual dispatch and made `build` depend on it.

**Evidence**

`.github/workflows/pages.yml:33-34` and `:66-67`:

```yaml
  build:
    needs: ci          # ci is skipped on workflow_run (it only runs on workflow_dispatch)
    if: >- !cancelled() && ( ... )   # build overrides the skip, so it runs
  ...
  deploy:
    needs: build       # no `if:` → implicit success() sees the skipped `ci` ancestor → deploy is SKIPPED
```

GitHub Actions data (via the GitHub API):

| Pages run | Commit | Result | Jobs |
| --- | --- | --- | --- |
| #84 (45331923132), 24 Nov 05:14, first run with the new workflow | HEAD `f740f52` | `success` | `ci`: skipped, `build`: success, **`deploy`: skipped** |
| #83 (45272102973), 23 Nov 21:40, old workflow | `8de98fc` | `success` | `build`: success, `deploy`: success |

The live site confirms it. `curl -I https://lukeafullard.github.io/webGrainy/ui/main.js` returns `last-modified: Mon, 23 Nov 2026 21:41:38 GMT`, size 2,003,524 bytes, unminified, and `sw.js` has `BUILD_HASH = '8d272521b074e71f'`. HEAD builds `main.js` at 1,373,926 bytes, minified, with `BUILD_HASH 'a30b23209e256628'`.

**Impact**

- `DEPLOYMENT.md:8` says Pages "publishes `dist/` on every push to `main`"; it does not.
- Merging the release would leave users on the pre-review build, without any of the F-01 to F-38 fixes.
- The run is green, so nobody is alerted. The manual "Run workflow" path should still deploy, because `ci` then succeeds, but it has **not been exercised** since the change (UNVERIFIED).

**Recommended fix:** give `deploy` an explicit condition:

```yaml
  deploy:
    needs: build
    if: ${{ !cancelled() && needs.build.result == 'success' }}
```

Then trigger a deploy and confirm the live `sw.js` `BUILD_HASH` and the `main.js` banner (`/*! webGrainy 0.1.0 build <commit> */`) match the release commit.

---

## 3. Major and minor issues

### MAJOR

#### M1. Service-worker precache reads through the HTTP cache: an "update" can install old code, and a stale ONNX Runtime can persist

- **Severity:** MAJOR (update and offline correctness on the target host). It is not a blocker because the install handler that runs is always the *new* `sw.js`, so a fix in any later release takes effect. Fixing it before release is still recommended: it is about 2 lines.

**Evidence**

- `src/sw.js:47` uses `cache.addAll(SHELL_ASSETS)` and `src/sw.js:54` uses `cache.addAll(missing)`. Both use the default request cache mode, so they are served from the browser's HTTP cache.
- GitHub Pages sends `Cache-Control: max-age=600` on every file (checked live with `curl -I`).
- The repository's own update test serves `Cache-Control: no-cache` (`scripts/smoke-sw-update.mjs:45`), so it cannot see this.

Reproduced with a scratch copy of that test, `swstale.cjs`, using two builds of `dist/` and a deploy inside the 10-minute window:

| Server header | Requests that reached the server after the deploy | New cache `webgrainy-shell-v2…` holds | After "Reload to update" |
| --- | --- | --- | --- |
| `max-age=600` (GitHub Pages) | only `/sw.js` | **v1** `main.js`, `index.html` and worker | page still runs **v1** |
| `no-cache` (control) | all 14 shell assets | v2 | v2 |

A second harness, `swort.cjs`, used three deploys with an ONNX Runtime version bump in v2 and `max-age=15`:

- After v2, the cache `webgrainy-ort-9.9.9` held the **v1** runtime.
- After v3, once the HTTP cache had expired, the shell updated to v3 but **`webgrainy-ort-9.9.9` still held the v1 runtime**.
- Install only fetches ORT files that are missing from that cache (`sw.js:48-55`), so the stale runtime is never replaced.

**Impact**

- Users who loaded the app within 10 minutes before a deploy are told an update is ready, reload, and keep running the old build until the *next* deploy. Exports still record the true (old) commit, so provenance stays honest.
- At the first future ONNX Runtime upgrade, affected users would pair the new ORT JavaScript (inside `main.js` and the worker) with the old `.wasm`. That likely breaks all inference for them until the next ORT version bump or a manual cache clear.
- For v0.1.0 itself only the stale-shell part applies: the live site is already on ORT 1.31.1.

**Recommended fix**

- Use `cache.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: 'reload' })))`, and the same for `missing` ORT assets.
- Optionally hash-check the ORT files, or key the ORT cache by build as well.
- Add a `max-age=600` variant to `smoke-sw-update.mjs`.

#### M2. ONNX Runtime's third-party notices are only linked, and to a moving branch

- **Severity:** MAJOR (licence completeness; it can ship only with explicit acceptance).

**Evidence**

- `dist/ort/ort-wasm-simd-threaded.jsep.wasm` (29.5 MB) contains compiled third-party code. `strings` shows `protobuf-src`, `abseil_cpp`, `re2` and `onnx::` symbols. These are BSD-3-Clause and Apache-2.0 code whose licences require their notices or licence text to accompany binary redistribution.
- `THIRD_PARTY_NOTICES.md:41-42` only links to `https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt`. That is the moving `main` branch, not the v1.31.1 tag.
- The `onnxruntime-web` npm package ships no LICENSE or ThirdPartyNotices file (`ls node_modules/onnxruntime-web`), so the build cannot copy one.
- Everything else bundled is fully covered: ORT and onnxruntime-common (MIT), UTIF, pako (MIT + Zlib) and EPSG, plus the model weights (CC BY 4.0, BSD-3-Clause, Apache-2.0, MIT, with a statement of changes).

**Impact:** a strict reading of BSD-3-Clause clause 2 and Apache-2.0 §4(a) is not met for the redistributed `.wasm`.

**Recommended fix:** vendor `ThirdPartyNotices.txt` from the `v1.31.1` tag into the repository and copy it to `dist/` (and the precache list), or append it to `THIRD_PARTY_NOTICES.md`. Point the link at the tag.

### MINOR

| # | Issue | Evidence | Recommended fix |
| --- | --- | --- | --- |
| m1 | **Fixed (section 9).** After **Cancel**, the photo keeps a "running" badge until the page is reloaded. Storage is correct: it shows `pending` after a reload, and re-running works. | `cancel.cjs`: "Batch cancelled (0/1 completed)" but the item still shows `running` 3 s later, and `pending` after a reload. On abort, `workspaceActions.ts:716-748` never resets the in-memory `photoStatuses` entry. | In `finally`/abort, set any `'running'` entry back to `'pending'`. |
| m2 | **Fixed (section 9).** Cancelling takes effect only between CPU tiles: 23.4 s measured for Cellpose-SAM INT8. This was a documented decision in batch 10. | `cancel.cjs` | Show "stopping after the current tile…" to the user. |
| m3 | **Fixed (section 9).** Unhelpful import messages. HEIC, corrupt and empty files show "The source image could not be decoded". About 2% of mutated TIFFs surface raw `TypeError`s from UTIF, e.g. "Cannot read properties of undefined (reading '0')". Both fail safely. | `reject.cjs`, `fuzz_tiff.mjs` | Map decode errors to "unsupported or damaged image (HEIC: export as JPEG)", and wrap UTIF errors. |
| m4 | **Fixed (section 9).** `pages.yml:18-21` grants `pages: write` and `id-token: write` workflow-wide, so the `build` job (which runs `npm ci` and the tests) holds them too. | workflow file | Move both permissions to the `deploy` job. |
| m5 | **Fixed (section 9).** `README.md:93` says "CI runs … on every push and pull request". CI runs on pushes to `main` and on PRs only. | `ci.yml:3-7` | Reword. |
| m6 | `CHANGELOG.md:265` says "the GitHub Pages deploy waits for CI". True, but no deploy happens on push (see B1). | | Fix B1. |
| m7 | Release date 2026-12-19 is future-dated in README:9, CHANGELOG:6 and CITATION.cff; the CHANGELOG link points to tag `v0.1.0`, which does not exist yet. | | Confirm the date when tagging; create the tag and GitHub release. |
| m8 | The float16 encoder writes `+0.0` as `0x8000` (−0). The oracle reports 1 mismatch in 20,029 values; this is numerically harmless. | oracle output | Optional. |
| m9 | The CSV comment-line formula guard inserts `'` inside prose, e.g. `# sizeMetricDefinition: b_axis '= minor axis …`. Cosmetic. | `prov_check.mjs` output | Optional: skip the word guard for known static notices. |
| m10 | **Fixed (section 9).** `package.json` has no `engines` field; CI uses Node 22. | | Add `"engines": {"node": ">=22"}`. |
| m11 | The smoke tests intercept the Hugging Face URL, so CI never exercises the real CDN, CORS, COEP and CSP path. I verified it manually (see matrix). | `smoke-dist.mjs` routes `https://huggingface.co/**` | Optional scheduled, non-blocking real-download check. |

---

## 4. Verification matrix

PASS means I ran it and it passed. UNVERIFIED means I could not run it here.

| Check | Command / method | Result | Notes |
| --- | --- | --- | --- |
| Clean install | `npm ci` (no `node_modules` beforehand) | PASS | 62 packages in 4 s, 0 vulnerabilities, no deprecation warnings (only an npm "new major version" notice). |
| Type safety | `npm run typecheck` | PASS | 0 errors under `strict`, `noUncheckedIndexedAccess`, `noUnused*`. |
| Build | `npm run build` | PASS | Required assets present: `index.html`, `gpucheck.html`, `sw.js` (placeholders stamped), `manifest.webmanifest`, icons, `ui/main.{js,css}`, both workers, `ort/*.jsep.{mjs,wasm}`, `LICENSE.txt`, `THIRD_PARTY_NOTICES.md`. All URLs relative. The build's own `new URL(...)` check passes. |
| Bundle sizes | `stat` / `gzip -9` | PASS | `main.js` 1,373 KB (413 KB gzip); ORT worker 427 KB (117 KB); `gpucheck.js` 467 KB; CSS 38 KB; ORT wasm 29.5 MB (6.9 MB gzip). Deployed app ≈ 40 MB including maps. |
| Source maps / secrets in `dist/` | inspected `.map`; grep | PASS | Maps are intentional (`esbuild.config.mjs`), use relative paths and include `sourcesContent`; the repository is public (HTTP 200 unauthenticated), so nothing new is exposed. No secrets found. |
| Pages sub-path `/webGrainy/` | code review, live headers, smoke test served at root | PASS | All URLs relative to the page; ORT path from `document.baseURI`. Live `.wasm` → `application/wasm`, `.mjs` → `text/javascript`, `.webmanifest` → `application/manifest+json`. |
| Unit / parity / E2E suite, run 1 | `npx vitest run --reporter=verbose` | PASS | 81 files, **847 passed, 0 failed, 0 skipped, 0 todo**. No `.only`, `.skip`, `.todo`, `skipIf`, `xit` anywhere in `tests/` or `validation/`. |
| Suite, run 2 (flakiness) | `npx vitest run` | PASS | 847/847 again. |
| Strict perf | `npm run test:perf` (serial, `PERF_STRICT=1`) | PASS | 847/847. A third clean run; no flakes in 3 runs. |
| Skips hiding gaps | grep plus `tests/setup.ts` | PASS (note) | The tests turn SHA-256 enforcement off globally, but production can't: the only caller of the switch is the test setup, and the default is `true` (`modelCache.ts:45-55`). `tests/modelCache.test.ts` re-enables it. |
| Browser smoke, U-Net | `MODEL_PATH=… npm run test:e2e:browser` | PASS | 16 precache assets; commit stamped; no console errors; hostile project imported inertly; analysis 4 s; longest main-thread task 0.07 s; ROI, Tidy, Save image, GeoPackage, site GeoPackage, Rectify/Undo, report and comparison checks pass. |
| Browser smoke, Cellpose-SAM INT8 | `SMOKE_MODEL=cpsam … npm run test:e2e:browser` | PASS | n = 53 grains; 4 min 13 s. |
| SW update smoke | `npm run test:e2e:sw` | PASS | Passes, but it serves `no-cache`. Under GitHub Pages' real `max-age=600`, updates can install stale code (M1). |
| Numerical oracle (CI step) | `npx vitest run --config validation/oracle/vitest.config.ts` then `oracle.py --check` (numpy 2.5.5, scipy 1.18.1, scikit-image 0.26.0) | PASS | Percentiles: worst relative error 6.8e-16 against log2 `np.interp`. Folk & Ward identical. Moment axes equal `skimage`. Feret widths match. Homography error 1.4e-13 px. One float16 −0 mismatch (m8). |
| CRS conversions vs PROJ (CI step) | `node validation/geotiff/check_crs_table.mjs` | PASS | 2,698 CRSs; worst 0.039 mm. |
| CI on GitHub | Actions API | PASS (CI) / **FAIL (deploy)** | CI run #205 on HEAD: success. Pages run #84: `deploy` skipped (B1). |
| Main flow end to end | smoke tests plus my harnesses on `dist/` | PASS | Add photo, choose model, segment, ROI/exclusions, Tidy, Rectify/Undo, site statistics, compare over time, exports, project import. Calibration is covered by unit tests and the smoke test's calibrated report. Grain split/merge/draw and undo/redo are covered by unit tests only (`interactiveEditor.test.ts`, `maskEditHistory`), not driven by hand. |
| Percentiles vs METHODS §9 | read `percentiles.ts`; oracle | PASS | Midpoint CDF `(cumsum − w/2)/W`, log2 interpolation, clamped ends, NaN when empty, exactly as documented. |
| Area- vs number-weighting | read `sedimentStats.ts:301-316`, `siteAnalysis.ts:243`, `sitePooling.ts:225-238` | PASS | Single photo uses `areaPx` (uniform scale); pooled calibrated sites use mm² (`areaMm2` is set by `ScaleCalibrator`); number weight 1. |
| Folk & Ward / Wentworth | read `sedimentStats.ts:96-140`; oracle | PASS | φ₅ = −log₂D95 … φ₉₅ = −log₂D5. Degenerate skewness/kurtosis → NaN ("Undefined"). Formulas and constants (6.6, 2.44) as in METHODS §10. |
| Site intervals (bootstrap / t / jackknife) | read `siteUncertainty.ts:665-733` against METHODS §12 | PASS | SE = (ln U − ln L)/(2z)·√(n/(n−1)); max with jackknife SE; t(n−1); log scale; degenerate → NaN. Seed 42 (Mulberry32). Binomial CI and Kish n_eff are covered by tests. |
| b-axis / Feret / d_eq | oracle; `SIZE_METRIC_DEFINITION` | PASS | b = 4√λ₂ equals `skimage` `minor_axis_length`; Feret via rotating calipers matches the oracle. |
| README accuracy table vs `validation/` | recomputed from `heldout_app_results_per_image.csv` | PASS | Every number matches. My site-cluster bootstrap CIs agree within Monte-Carlo noise. The earlier-benchmark table matches `heldout_summary.json` (`ts_cellpose_guard040`, `pytorch_ref`), as do the 17.5% tail, PQ 0.994/0.966 (`quantization/README.md`), K1 −22%/−31%/+3% (`k1_app_results.md`), 40 images / 13 sites (manifest) and the DEPLOYMENT thread timings (`cpu_threads_results.txt`). |
| U-Net accuracy reproduced from scratch | `fetch_ig2_files.py` (80 files from Zenodo) → `run_app_heldout.mjs unet` → `score_app_heldout.py unet`, in a scratch copy | PASS | 40/40 images in 3 min 45 s. The regenerated per-image CSV is **byte-identical** to the committed one; the table matches the README exactly. |
| Cellpose-SAM accuracy reproduced | `run_app_heldout.mjs cpsam` (INT8, CPU) | PARTIAL / UNVERIFIED (remainder) | About 3 min per image on this machine. Every image finished at the time of writing is **identical** to the committed per-image values (6 of 6 when this report was written). The full 40 was not finished; see §5. |
| CPU (WASM) path and worker | smoke long-task check; harnesses | PASS | Inference runs in the worker (longest main-thread task 0.07 s). Cross-origin isolated through the SW on reload; "3 CPU threads" on 4 cores. |
| WebGPU path | `gpucheck.html` headless | UNVERIFIED | No GPU here. The page degrades cleanly ("No WebGPU adapter…", no errors). The fallback logic (no adapter, no shader-f16, device loss, NaN output) is unit-tested in `onnxInference.test.ts`. |
| Edge-case inputs | `edge.cjs` on `dist/` | PASS | CMYK JPEG, CMYK TIFF, 16-bit PNG and TIFF, RGBA, 1×1, 8×8, uniform grey (0 grains), 20000×100, and 48 MP JPEG all analysed (`12 done, 0 failed`, 30 s). Corrupt, fake-HEIC and empty files were refused with a message (m3). |
| Storage quota exceeded | `quota.cjs` (CDP `Storage.overrideQuotaForOrigin` 4 MB) | PASS | Analysis still runs when the model can't be cached. "Browser storage is full: small.png was analysed but could not be saved…" is shown with the storage-full banner. A 3.3 MB import over quota is refused with a message. No silent loss. |
| Cancel mid-run | `cancel.cjs` | PASS (minor issues) | "Batch cancelled (0/1 completed)"; re-run succeeds; persisted state `pending`. Stale badge (m1); about 23 s latency (m2). |
| Old project formats | `archiveV2.test.ts`, `archiveSanitize.test.ts`, smoke import of a v1 JSON | PASS | v1 `.webgrainy.json` and v2 binary import. Projects that recorded the removed "legacy" pipeline still open (test-covered). |
| Network inventory / privacy | grep of `src/`; request logging in browser harnesses | PASS | The only third-party fetches are `modelCache.ts:351` (segmentation weights) and `imageEnhance.ts:233` (optional PULSE upscaler). Both use pinned revisions, `credentials: 'omit'` and `no-referrer`. No analytics, fonts or CDNs. Hosts actually contacted: `huggingface.co` and `us.aws.cdn.hf.co` only. |
| Model pinning and integrity | `modelCache.ts`; `curl -I` to HF for all 5 files | PASS | Exact revision URLs. Size and SHA-256 are checked before caching and before use; cached bytes are re-hashed once per session; downloads are bounded to the pinned size (`modelCache.ts:381-455`). All 5 pinned sizes and hashes equal HF `x-linked-size` / `x-linked-etag`. |
| Real HF download (CSP + 302 + CORS + COEP) | `realhf.cjs` (no request interception) | PASS | Isolated page, real 26.5 MB download, hash verified, analysis done. HF returns `access-control-allow-origin` for the Pages origin. |
| CSP | `index.html`, `gpucheck.html`, `REPORT_CSP`; DEPLOYMENT comparison | PASS | No `unsafe-inline` or `unsafe-eval` for scripts (`wasm-unsafe-eval` only); `connect-src` limited to HF; `form-action 'none'`; `base-uri 'self'`. Header and nginx examples equal the meta tag plus `frame-ancestors`. `style-src 'unsafe-inline'` is required by the inline style attributes. |
| XSS sinks | static review of every `innerHTML` / `document.write` interpolation; `edge.cjs` hostile filename; smoke hostile project | PASS | User text goes through `esc()` (also in chart titles and report titles). A filename `"><img src=x onerror=…><b class=xss><meta http-equiv=refresh…>.png` rendered as text across the list, panels and dialogs: no element injected, no navigation. |
| CSV formula guard | read `provenance.ts:128-195` | PASS | Leading `=+-@` TAB CR (after spaces), inner delimiters and word starts are guarded; `#`, `;` and TAB are quoted. Only numbers and booleans bypass `csvCell`. |
| Untrusted TIFF / GeoTIFF parsing | `fuzz_tiff.mjs` on built `decodeTiffBuffer`, 4,000 mutations | PASS | No hang (worst 815 ms, the first call), RSS ≤ 120 MB, every failure is a caught exception. |
| Untrusted `.webgrainy` parsing | scratch Vitest fuzz, 1,500 type-confused v2 headers, with the repository's mock IndexedDB | PASS | 291 imported with invariants intact, 1,209 rejected by validation, no prototype pollution, no generic crashes. |
| `npm audit --omit=dev` / `npm audit` | | PASS | 0 / 0 vulnerabilities. |
| Actions pinned to SHAs | `git ls-remote --tags` for all 7 actions | PASS | All 7 SHAs equal their tagged commits. |
| Least-privilege permissions | read workflows | PASS (minor) | CI `contents: read`; no secrets used; `workflow_run` deploy limited to `event == 'push'` on `main`. m4: `build` holds `pages` and `id-token`. |
| Pages deploy workflow | Actions API, live site | **FAIL** | B1. |
| SW caching / versioning / cleanup | `sw.js` review; smoke tests | PASS | Content-hash cache name; old `webgrainy-*` caches deleted on activate; navigations served from this build's cache. |
| SW update correctness on GitHub Pages | `swstale.cjs`, `swort.cjs` | **FAIL** | M1. |
| Offline after first load | `offline.cjs` (`setOffline(true)`, server down) | PASS | App shell loads offline (still isolated, "Offline" shown); new analysis `1 done`; **0** HF requests; only `sw.js` update checks hit the server. |
| COOP/COEP on GitHub Pages | live headers; harness | PASS | Pages sends none; the SW adds them; `crossOriginIsolated === true` after the first reload. |
| DEPLOYMENT.md accuracy | read against code and live behaviour | FAIL (B1) / otherwise PASS | Line 8 is wrong (B1). MIME types, hosts, CSP, nginx rules, isolation, caching and the checklist are accurate. |
| Export provenance | `prov_check.mjs` with built `dist/index.js` (U-Net, calibrated) | PASS | Summary JSON and CSV carry `appVersion 0.1.0`, `appCommit f740f522f484`, `ortVersion 1.31.1`, model ID/file/revision/SHA-256, scale mode, every post-processing parameter, calibration and accuracy notice. Site export provenance is covered by the F-26 tests. |
| Version strings | grep | PASS | `package.json`, lockfile, CHANGELOG `[0.1.0]`, CITATION `0.1.0`, README `v0.1.0` and in-app `APP_VERSION` (from `package.json`) all say 0.1.0. Dates: m7. |
| Console errors / unhandled rejections | `pageerror` + `console` listeners in all harnesses | PASS | None, apart from ORT's expected warning "No available adapters." with WebGPU disabled. |
| Memory / resource release | `leak.cjs` (8 re-analyses, CDP GC + heap) | PASS (indicative) | Main heap 4.7 → 5.3 MB; worker count constant at 4. `createObjectURL` is always paired with `revokeObjectURL` (5/5); sessions released (13 call sites). |
| Accessibility | axe-core 4.10.3 (WCAG 2.0/2.1 A + AA) via `a11y.cjs` | PASS | 0 violations: landing (dark and light), workspace after analysis, About, Models, Export, Help. Dialogs: native modal, focus inside, labelled, Escape closes, focus returns to the opener. Skip link first in tab order; 2 px focus outline. Canvas grain editing by keyboard not assessed. |
| Browser support | Chromium only | UNVERIFIED | Safari, Firefox and mobile were not tested (see §5). DEPLOYMENT says "expected; not exhaustively tested". |
| LICENSE compatibility | `npm ls --omit=dev`; licence fields | PASS | BSD-3-Clause app; bundled MIT, Zlib, ISC, Apache-2.0 and BSD-3 dependencies are compatible. Model weights CC BY 4.0 (attribution and changes stated), BSD-3-Clause, Apache-2.0, MIT. |
| THIRD_PARTY_NOTICES completeness | bundle inspection | FAIL (MAJOR) | M2 (ORT wasm third-party notices). Everything else is complete. |
| CITATION.cff | `cffconvert --validate` | PASS | "valid according to schema version 1.2.0". |
| Docs vs code | README, METHODS, SETTINGS_GUIDE, CHANGELOG spot checks; `docNumbers` and `uiSettingsHelp` tests | PASS (minor) | Defaults (0.45, 0, 30, 0.40, 2 px, 250, 2, 15 px, 500, seed 42, 30 days) match code. Sampled CHANGELOG features exist (Holm/Welch, 10,000-photo cap, 100 MP TIFF cap, 1e-4 stretch). m5 and m6. |
| Leftovers | grep `TODO`, `FIXME`, `XXX`, `HACK`, `console.log`, `debugger`, debug flags, absolute paths, commented-out code | PASS | None in `src/`. Only two intentional `console.error` calls and one `console.warn`. |

---

## 5. Unverified areas

| Area | Why it could not be checked here | How to verify |
| --- | --- | --- |
| WebGPU inference (FP16 Cellpose-SAM, U-Net on GPU, device-loss fallback, NaN fallback) | No GPU in the container | On Chrome or Edge ≥ 121 with a `shader-f16` adapter, open `/webGrainy/gpucheck.html`, run it and save the report. Analyse one photo with Cellpose-SAM FP16 and compare D50 with the CPU INT8 result. Repeat on at least one other GPU vendor: `validation/gpu/` covers only an Intel Xe. |
| Manual "Run workflow" Pages deploy | Not run since the F-17 change; it would publish to the live site | After fixing B1, run it once and confirm the live `sw.js` `BUILD_HASH` and the `main.js` banner commit. |
| Full Cellpose-SAM held-out re-run | CPU only, about 3 min per image (about 2 h for 40) | `node validation/heldout/run_app_heldout.mjs cpsam`, then `score_app_heldout.py cpsam`, then `git diff validation/heldout/`. A byte-identical CSV confirms it. Every image I completed matched exactly. |
| Safari (macOS/iOS), Firefox, Android | Only Chromium is installed | Manual pass on Safari ≥ 17.4 and current Firefox: load, U-Net analysis, export, offline reload, update prompt. On phones: U-Net on a downscaled photo, and check memory warnings. |
| Real camera photos (EXIF orientation, very large JPEGs from phones and drones) and real HEIC | Synthetic inputs only | Use a handful of real field photos, including a rotated EXIF JPEG and an iPhone HEIC in Safari. |
| Low-memory devices (Cellpose-SAM needs about 2–4 GB) | No device | Test on an 8 GB laptop and a phone; confirm the out-of-memory message (`siteBatch.ts:108-112`) appears rather than a crash. |
| Grain editing by hand (split/merge/draw, undo/redo, brush exclusions) | Driven only by unit tests, not by a person | A 5-minute manual session on the deployed build. |

---

## 6. Regression check of previous review batches

All F-items with tests pass at HEAD (`productionReview.test.ts` and companions: 75 tests in those files). I also checked items independently where the brief called for it:

| Batch (commit) | Items | Status | Independent evidence |
| --- | --- | --- | --- |
| 1 (`91f2c19`) | F-01 to F-04 (fabric rose, compare in px, photo order, record sync) | Confirmed fixed | Tests pass. |
| 2 (`3fd6e24`) | F-05, F-06, F-09, F-14 (site GeoPackage, report CSS/CSP, composition SVG, seed density) | Confirmed fixed | `REPORT_CSP` read; site GeoPackage opens in SQLite (smoke test). |
| 3 (`cf1e1a7`) | F-07, F-08, F-10, F-11 (hostile TIFFs, archive byte references, colour fallback, storage errors) | Confirmed fixed | TIFF fuzz (4,000) and archive fuzz (1,500): no hangs or crashes. |
| 4 (`44bed0d`) | F-12, F-13, F-16, **F-17** | F-12, F-13, F-16 confirmed. **F-17 REGRESSED** | The manual-deploy gate caused **B1**: automatic deploys are skipped. |
| 5 (`7105078`, `944b333`) | F-18 to F-20 | Confirmed fixed | Tests pass. |
| 6 (`bb86bca`) | F-21 to F-23 | Confirmed fixed | Tests pass. |
| 7 (`27da295`) | F-24, F-25, F-27, F-28 | Confirmed fixed | Tests pass. |
| 8 (`669cd68`) | F-26, F-29, F-30 (export provenance, CSV guard, bounded downloads) | Confirmed fixed | Provenance in real exports; `csvCell` reviewed; size bound read at `modelCache.ts:381-455`. |
| 9 (`6dd0256`) | F-31, F-33, F-35 (update prompts, accessibility, copy) | Confirmed fixed | axe: 0 violations; update prompt shown in the SW harness. M1 is a separate, pre-existing SW issue, not a regression of F-33. |
| 10 (`ec5121f`) | F-32, F-34 (large photos, storage errors, smaller deploy, pinned Actions) | Confirmed fixed | 48 MP photo analysed; quota harness; minified bundles with commit banner; library build excluded from Pages; 7/7 SHAs verified. |
| 11 (`a85c45f`) | F-36 to F-38 (hardening, exact dependency pins, BSD-3 metadata, PWA icons) | Confirmed fixed | `package.json` pins `1.31.1` / `4.1.0` exactly; `"license": "BSD-3-Clause"`; 192/512 px icons in `dist/`. |
| — | F-15 | Not verifiable as a batch item | No batch commit claims F-15. An older test (`auditRegressions.test.ts:191`, "F-14 / F-15 sample-size and calibration warnings") passes. |

---

## 7. Release checklist for v0.1.0

1. **B1, fixed (section 8).** After merging to `main`, confirm the *Deploy app to GitHub Pages* run shows `deploy: success` (not skipped). Confirm the live `sw.js` `BUILD_HASH` and the `main.js` banner commit equal the release commit (now step 1 of the post-deployment checklist in `DEPLOYMENT.md`).
2. ~~Fix M1~~: **done** (section 8). Users of the pre-release will re-download the ~30 MB runtime once.
3. ~~Fix M2~~: **done** (section 8).
4. Minor fixes: m1–m5 and m10 are **done** (section 9). m6 is resolved by B1; m7 is step 7 below; m8, m9 and m11 remain optional.
5. Finish the Cellpose-SAM held-out re-run and confirm `git diff validation/heldout/` shows no data change.
6. Run the manual WebGPU check (`gpucheck.html`) on at least one shader-f16 GPU, and a short manual pass on Safari and Firefox.
7. Set the final release date consistently in `README.md:9`, `CHANGELOG.md:6` and `CITATION.cff` (`date-released`).
8. Tag `v0.1.0` on the deployed commit and create the GitHub release; the CHANGELOG link points to it. Optionally attach the tutorial videos (`npm run tutorials`).
9. Run the post-deployment checklist in `DEPLOYMENT.md` on the live URL: console clean, U-Net analysis, offline reload, and the exported `modelSha256` equal to the pinned hash.

---

## 8. Follow-up: fixes for B1, M1 and M2

Each fix comes with a regression test, and I checked that each test **fails on the old code** and passes on the fix.

### B1: Pages deploy job skipped → fixed

| | |
| --- | --- |
| **Change** | `.github/workflows/pages.yml`: the `deploy` job gets `if: ${{ !cancelled() && needs.build.result == 'success' }}`, with a comment explaining why. |
| **Regression test** | `tests/deployWorkflow.test.ts` (4 tests). It checks that `deploy` has the condition, and that *every* job downstream of the manual-only `ci` job states its own `!cancelled()` condition. On the old workflow: 2 failures. On the fix: 4/4 pass. |
| **Other checks** | The workflow parses (PyYAML) with the expected `needs` and `if` on each job. The `build` job uses the same `!cancelled()` override and **ran** in run #84 although `ci` was skipped, which is live evidence that the expression works on GitHub. |
| **Can only be confirmed after merging** | That the deploy actually happens: GitHub runs `pages.yml` only after CI on `main`. This is now step 1 of the post-deployment checklist in `DEPLOYMENT.md`. |

### M1: service worker precached stale files → fixed

| | |
| --- | --- |
| **Change** | `src/sw.js`: every precache request (shell and runtime) is `new Request(url, { cache: 'reload' })`, so it bypasses the browser's HTTP cache. Each ONNX Runtime file is stored only after its SHA-256 matches the build; on a mismatch or HTTP error the install fails and the browser retries it later. The runtime cache is named `webgrainy-ort-<version>-<files id>`, so any older, possibly stale, runtime cache is removed on activation. `esbuild.config.mjs` stamps `ORT_SHA256` and `ORT_FILES_ID` into `sw.js`. |
| **Unit test** | `tests/swPrecache.test.ts` (6 tests) runs the real `src/sw.js` install and activate handlers against in-memory caches. It checks: every precache request uses `cache: 'reload'`; runtime files are stored with their content type; a stale or mismatching runtime file fails the install and is not cached; an HTTP error is not cached; verified runtime files are not downloaded again; activation removes the old version-only cache. **Old `sw.js`: 6/6 fail. New: 6/6 pass.** |
| **Browser test** | `scripts/smoke-sw-update.mjs` now serves `Cache-Control: max-age=600` (GitHub Pages), deploys a v2 that also changes the ONNX Runtime file, then a v3 whose runtime file does not match its build. 9 checks, **PASS**. Against a copy of the fixed build with `cache: 'reload'` removed: **5 checks FAIL**. In that run the new SHA-256 check also refused the stale runtime, so nothing wrong was installed. |
| **Original audit harness** | `swstale.cjs` with `max-age=600`: after the deploy all 15 shell files reached the server, the new cache holds v2, and the page serves v2 after "Reload to update". Before the fix only `/sw.js` reached the server and the page stayed on v1. |
| **Offline re-check** | `offline.cjs`: first load, analysis, offline reload, analysis again: `1 done`, 0 Hugging Face requests. Caches: `webgrainy-shell-<build>`, `webgrainy-ort-1.31.1-4ea53ca2caee`. Same result with the server gzip-encoding responses as GitHub Pages does (`offline_gzip.cjs`: `Content-Encoding: gzip`, compressed `Content-Length`), so the hash check runs on the decoded bytes and the cached runtime loads. |
| **Side effect** | Browsers that used a pre-release download the 29.5 MB runtime once more, because its cache name changed. This is recorded in the CHANGELOG. |
| **Docs** | `DEPLOYMENT.md` Caching section updated. |

### M2: ONNX Runtime third-party notices → fixed

| | |
| --- | --- |
| **Change** | `licenses/onnxruntime-1.31.1-ThirdPartyNotices.txt`, unchanged from `onnxruntime/ThirdPartyNotices.txt` in the official `onnxruntime` 1.31.1 wheel on PyPI (file SHA-256 `143764b9…3de3`). It covers the components found in the `.wasm`: protobuf, abseil, re2, ONNX, Eigen, SafeInt, nlohmann/json, FlatBuffers and GSL. |
| **Shipping** | The build copies it to `dist/ort/ThirdPartyNotices.txt` and adds it to the service-worker precache (offline). The build **fails** if the notices for the installed ONNX Runtime version are missing. The About dialog links it. `THIRD_PARTY_NOTICES.md` replaces the link to the moving `main` branch with the vendored file, its source and its SHA-256. |
| **Test** | `tests/thirdPartyNotices.test.ts` (3 tests): the vendored file matches the installed `onnxruntime-web` version and names the compiled-in components; `THIRD_PARTY_NOTICES.md` names it with the correct SHA-256 and no longer links `main`; it is copied, precached and linked from About. |
| **Checked in the browser** | Offline: `./ort/ThirdPartyNotices.txt` → `200` from the service-worker cache. |
| **Limitation** | `raw.githubusercontent.com` is blocked from this environment, so I could not diff the file against the `v1.31.1` git tag. The wheel's copy is Microsoft's published notices for the same release. |

### Gates on the fixed tree

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS (0 errors) |
| `npx vitest run` | PASS: 84 files, **860 tests** (847 + 13 new) |
| `npm run build` | PASS; 17 precache assets (adds `ort/ThirdPartyNotices.txt`) |
| `npm run test:e2e:browser` (U-Net) | PASS (n = 37 grains, longest main-thread task 0.10 s) |
| `npm run test:e2e:browser` (`SMOKE_MODEL=cpsam`) | PASS (n = 53 grains, same as before the fixes) |
| `npm run test:e2e:sw` (now with `max-age=600`) | PASS (9/9 checks) |
| Offline after first load (`offline.cjs`) | PASS |
| Cellpose-SAM held-out re-run (scratch copy) | 21 of 40 images re-run so far, all **identical** to the committed per-image results (still running, about 3 min per image) |

`CHANGELOG.md` has a new "Fixed before release (production readiness review)" subsection for these three fixes. Minor issues m1–m5 and m10 were fixed afterwards (section 9).

---

## 9. Follow-up: minor issues m1–m5 and m10

| # | Change | Verification |
| --- | --- | --- |
| m1 | When a batch ends, photos still marked `running` go back to `pending` (`workspaceActions.ts`, `clearRunningStatuses`), as a reload already showed. | Unit test (cancel during a photo) fails on the old code, passes now. Browser (`cancel_m12.cjs`): the photo shows `pending` right after Cancel, 3 s later and after a reload; re-running works. |
| m2 | Cancel immediately shows *Stopping…* (disabled) in the activity bar and the photo list, with "Stopping: the current step finishes first…", including the measured time per tile once one is known. A second click does nothing. | Unit tests for the progress model, activity bar, photo list and the cancel flow. In the browser the first run found a gap that unit tests could not: the photo list's Cancel button stayed live, because `batchStopping` was missing from the sidebar's re-render conditions in `main.ts`. Fixed; now there are 0 live Cancel buttons and 2 disabled *Stopping…* buttons. This is now also checked in the Cellpose-SAM browser smoke test, where a CPU tile is long enough to make the check deterministic. |
| m3 | A photo the browser cannot decode is reported as empty, as HEIC/HEIF (with how to get a JPEG on an iPhone), or as damaged/unsupported (`src/ui/importErrors.ts`; the browser's error is kept as `cause`). In the TIFF decoder, raw errors and non-`Error` values thrown inside UTIF become "This TIFF file is damaged or not a valid TIFF (its image data could not be read)…"; its own explanations are unchanged. | Two real fuzz-found TIFFs are kept as fixtures (`tests/fixtures/damaged_tiff_utif_*.tif`): one hit a `TypeError` inside UTIF, the other made UTIF throw the number `1`. Both tests fail on the old decoder. Fuzzing 6,000 mutated TIFFs: **0** raw errors (before: about 200 per 6,000). Browser (`reject_m3.cjs`): all 5 bad files give the new messages. |
| m4 | `pages.yml`: workflow-level `contents: read` only; `build` gets `contents: read` and `pages: read` (`configure-pages` v5.0.0 only calls `GET …/pages`); `deploy` gets `contents: read`, `pages: write` and `id-token: write`, the same set the whole workflow had before. | Workflow test (5 tests) checks each job's permissions; PyYAML parse. Checked the pinned `configure-pages` and `upload-pages-artifact` sources: the latter does not use the GitHub token. |
| m5 | README states the supported Node.js versions and that CI runs on every pull request and every push to `main`, followed by the Pages deploy. | — |
| m10 | `package.json` `engines`: `^22.13.0 \|\| ^24.0.0 \|\| >=26.0.0`. This is Vitest 5's own range, and `node:sqlite`, used by the GeoPackage tests and the smoke test, needs no flag from 22.13. The lockfile gains only the same `engines` block. | `npm ci` clean on Node 22.23.5 (no `EBADENGINE`). |

Two fixes to the smoke test itself while adding the cancel check: (1) it now reads the visible status line (`#viewport-footer`). `document.body.innerText` also contains the screen-reader announcer, which by design keeps the previous batch's result while a batch runs, so after a cancelled batch a re-run looked finished at once. (2) The cancel waits for the tile loop ("tile N of M"): plain "Finding grains…" already shows before the model download, which Cancel stops at once.

Gates after these changes: typecheck 0 errors; **85 files, 869 tests** pass; build; U-Net browser smoke PASS; Cellpose-SAM browser smoke with the new cancel check PASS, twice in a row (n = 53 grains both times); SW update smoke PASS.

---

### Appendix: scratch harnesses

These were written for this audit and live outside the repository, in the session scratchpad. Each serves `dist/` locally, or uses the built library.

| Harness | What it checks |
| --- | --- |
| `edge.cjs`, `reject.cjs` | Edge-case inputs and the hostile filename |
| `swstale.cjs`, `swort.cjs` | SW stale precache and the ORT cache case |
| `offline.cjs` | Offline mode after the first load |
| `realhf.cjs` | Real Hugging Face download path |
| `quota.cjs` | Storage quota exceeded |
| `cancel.cjs` | Cancel mid-run |
| `leak.cjs` | Memory across repeated analyses |
| `a11y.cjs` | axe and keyboard/dialog checks |
| `gpucheck.cjs` | GPU check page without a GPU |
| `prov_check.mjs` | Export provenance |
| `fuzz_tiff.mjs`, `tests/scratch/archiveFuzz.test.ts` | Parser fuzzing (in a scratch copy of the repository) |
| `cmp_cpsam.py` | Held-out Cellpose-SAM reproduction |
