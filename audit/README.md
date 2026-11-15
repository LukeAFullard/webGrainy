# Audit harness (read-only with respect to `src/`, `tests/`, docs)

| File | Purpose | Run |
|---|---|---|
| `dump.audit.ts` | Runs the real TS implementations (percentiles, Folk & Ward, moments, FP16, tiling, reflect, homography) and dumps outputs | `npx vitest run --config audit/vitest.config.ts audit/dump.audit.ts` |
| `oracle.py` | Independent numpy / scipy / scikit-image oracle for the dump | `python3 -I audit/oracle.py audit/out/ts_dump.json` |
| `edge_cases.audit.ts` | Degenerate inputs (0/1 grain, all-border, mixed px/mm, NaN area) and CSV formula injection | `npx vitest run --config audit/vitest.config.ts audit/edge_cases.audit.ts` |
| `recompute_validation.py` | Recomputes headline metrics from the per-image table in `full_dataset_validation_report.md`, split by `site` | `python3 -I audit/recompute_validation.py full_dataset_validation_report.md` |
| `mutation_check.sh` | 9 targeted mutations of key formulas in a scratch copy, then runs the suite | `bash audit/mutation_check.sh /tmp/mut` |
| `make_synthetic_gravel.py` | Synthetic ellipse "gravel" PNG and ground-truth JSON | `python3 -I audit/make_synthetic_gravel.py out.png out.json` |
| `browser_smoke.cjs` / `browser_e2e.cjs` | Headless Chromium drive of the built `dist/` (serve it first with `python3 -m http.server 8765` inside `dist/`) | `node audit/browser_e2e.cjs <ig2_unet_fp32.onnx> <img.png> http://127.0.0.1:8765/` (set `NOGPU=1` to force WASM) |

Captured outputs are in `audit/out/`. Requires `pip install scipy scikit-image` (tested with numpy 2.5.3, scipy 1.18.1, scikit-image 0.26.0).
