# Prompt: low-precision (FP8 / FP4) ImageGrains models — Colab notebook

Copy everything below the line into the other coding AI.

---

You are working in the repository **LukeAFullard/webGrainy**, a browser app (TypeScript,
onnxruntime-web 1.31.1, WebGPU + WASM backends) that runs the ImageGrains 2.0 grain-segmentation
models. **Create a branch `audit/quantization-fp8-fp4` from `main` and do all work there. Do not
modify `src/`, `tests/` or the user docs, and do not merge.** Put your work in `audit/quantization/`.

## Goal

Build one self-contained Google Colab notebook,
`audit/quantization/imagegrains_quantize_colab.ipynb`, that **creates smaller, lower-precision
versions of the two models and tests them in the same notebook**. We want to know whether we keep
accuracy while cutting the download size (Cellpose-SAM is currently 617 MB) and, if possible,
speeding up inference.

Base it on the existing export notebook:
https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/blob/main/imagegrains_to_onnx_colab.ipynb
Reuse its approach:
- download the checkpoints from Zenodo `10.5281/zenodo.15728186` (`IG2_full_set.200525` = U-Net,
  needs `cellpose==3.1.1.1`; `IG2_full_set_cp_SAM` = Cellpose-SAM ViT-L, needs
  `cellpose>=4.0.9,<4.2`);
- use separate `uv` virtual environments for cellpose 3 and 4;
- keep the same export wrappers (`CPnetWrapper` with the `DynamicMakeStyle` fix, `CPSAMWrapper`),
  the same input/output names and layouts, and the same dynamic batch/height/width axes.
  CP-SAM: input `[N,3,256,256]`, output `[N,3,256,256]` = (flowY, flowX, cellprob).
  U-Net: input `[N,2,H,W]`.
- save outputs to Google Drive (`/content/drive/MyDrive/imagegrains_onnx_quant/`).

Recommended runtime: L4 or A100 with High-RAM (T4 is fine but slower).

## Variants to build

The main target is **Cellpose-SAM** (most of its weights are in transformer MatMul/Gemm layers,
so it quantizes well). Do the U-Net too, but it is small (26 MB), so it is lower priority.

Build and test each of these. Record the file size of every one:

| Name | What | Why |
|---|---|---|
| `fp32` | Reference export (float32) | Ground truth for numerics, CPU only |
| `fp16` | The current shipped model (`ig2_cpsam_fp16.onnx`) | Baseline we compare against |
| `fp8_e4m3` | FP8 E4M3FN **weights** (ONNX opset ≥ 19, `DequantizeLinear` with float8 zero-point / QDQ), compute in fp16/fp32 | Requested: true FP8 |
| `fp4_e2m1` | FP4 E2M1 **weights** (ONNX opset ≥ 23 `FLOAT4E2M1`, block scales), compute in fp16/fp32 | Requested: true FP4 |
| `int8_wo` | 8-bit weight-only (per-channel, symmetric), e.g. `onnxruntime.quantization` `quantize_dynamic` / QDQ | Practical 8-bit fallback |
| `int4_mnb` | 4-bit block-wise **`MatMulNBits`** (block size 32 and 128), via `onnxruntime.quantization.matmul_4bits_quantizer` (RTN; optionally HQQ/GPTQ), activations fp16 | Practical 4-bit: ORT has dedicated WebGPU and CPU kernels for this op |

**Important realities. Please verify them; don't take them on trust:**
- onnxruntime-web (both the WASM and WebGPU execution providers) has little or no kernel support
  for float8 / float4 tensor types, and WGSL has no fp8/fp4 types. The FP8/FP4 models may not
  load at all in the browser runtime. If one doesn't load, try a "storage-only" form: weights
  stored as fp8/fp4 + `DequantizeLinear`/`Cast` to fp16 at the start of the graph. That gives
  the download-size saving but no compute speed-up. Report exactly which forms load and run, and
  which fail with what error.
- `MatMulNBits` (int4) is the 4-bit format onnxruntime-web is known to accelerate on WebGPU, so
  it is the most likely to give both a size and a speed win.
- Keep conv layers, the patch embedding, norms and the output head in fp16/fp32 unless tests
  show quantizing them is harmless. Report which layers were quantized and the fraction of
  weight bytes that covers.
- **Known fp16 risk, test it explicitly:** with fp16, CUDA (in an earlier Colab run) and WebGPU
  (Intel Xe-LPG, measured with our GPU-check page) both gave wrong outputs on featureless input.
  On an all-zero 256×256 tile, the fp32/CPU cellprob is about −5.2 everywhere (confident
  background). WebGPU fp16 gave the opposite sign on every pixel (about +0.7). Lower precision
  may make this worse.

## Tests (in the same notebook)

Run every variant through these, in this order. Cache intermediate results on Drive so a
disconnect doesn't lose hours.

1. **Load check in the browser runtime.** In Colab, install Node 22, clone the repo, run
   `npm ci && npm run build`, and load each `.onnx` with **onnxruntime-web 1.31.1 in Node (WASM
   EP)**. This is the runtime the app ships. Python `onnxruntime` / CUDA results are indicative
   only, because they are not what the browser runs. Record load success, load time and peak
   memory.

2. **Tile-level numerics vs the fp32 PyTorch reference** (not vs fp16). Use these tiles:
   - 20 real 256×256 tiles cut from held-out images;
   - an all-zero tile;
   - a tile with an 8-pixel zero border (`get_pad_yx` padding: the app pads by 8 px);
   - a 100×80 image zero-padded to 256×256.

   Report per variant: max/mean abs difference in flowY/flowX/cellprob, cellprob sign agreement
   %, and non-finite count. Flag any variant whose all-zero tile cellprob is not negative.

3. **Full pipeline accuracy on the 40-image held-out test set.** Use the same data and scoring as
   `audit/followup/imagegrains_heldout_followup_colab.ipynb`: `IG2_data.zip`, Zenodo 17866827,
   `official_split == 'test'`, n = 40, across all 13 sites. Run the **shipped TypeScript
   pipeline** with each variant via `audit/followup/ts_cellpose_runner.mjs` (WASM, or the Python
   ORT tile bridge it supports when the WASM load check passed and the bridge matches WASM on the
   20 tiles). Report per variant, with bootstrap 95% CIs:
   - PQ vs ground truth;
   - D16/D50/D84 absolute % error (mean and median);
   - grain-count ratio;
   - mask PQ vs the fp16 model's masks.

4. **Speed** (indicative). Measure per-tile time:
   - ORT-web WASM in Node (state the thread count);
   - Python ORT CPU;
   - Python ORT CUDA.

   Real browser WebGPU speed will be measured separately with the app's GPU-check page, so
   **save every variant that loads, so we can host it and test it in a browser.**

5. **Size.** For each file, record: bytes on disk, gzip/brotli-compressed size (what a CDN would
   serve), and SHA-256.

## Pass criteria (state pass/fail per variant)

- Loads and runs in onnxruntime-web 1.31.1 (WASM).
- No non-finite outputs, and the all-zero tile cellprob stays negative (matches fp32 sign ≥ 99%).
- 40-image PQ vs ground truth within **0.01** of fp16. D50 median absolute % error within
  **1 percentage point** of fp16.
- Mask PQ vs fp16 ≥ 0.95 on real images.

## Deliverables

- `audit/quantization/imagegrains_quantize_colab.ipynb`: runs top to bottom on a fresh Colab
  runtime with no manual edits, apart from a `CONFIG` cell (which variants, which model, test-set
  size, Drive paths).
- `audit/quantization/results.json` and `results_per_image.csv`: all numbers above.
- `audit/quantization/README.md`: a plain-language summary table (variant, size, loads in
  browser?, PQ, D50 error, speed, pass/fail), a recommendation of which variant (if any) the app
  should ship, and the exact commands/settings to reproduce.
- **Do not commit model files** (too large). Leave them on Drive and list their SHA-256 in the
  README.
- Keep your scripts deterministic (fixed seeds), and never put credentials or tokens in the
  notebook.
- Commit to `audit/quantization-fp8-fp4` and push. Don't open a PR unless asked.
