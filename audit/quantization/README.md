# ImageGrains 2.0 ONNX Quantization Benchmark (`audit/quantization/`)

This directory contains the self-contained Colab pipeline ([`imagegrains_quantize_colab.ipynb`](imagegrains_quantize_colab.ipynb)) to export, quantize, and benchmark lower-precision variants of the ImageGrains 2.0 models (`IG2_full_set_cp_SAM` Cellpose-SAM ViT-L and `IG2_full_set.200525` U-Net) against **`onnxruntime-web@1.31.1`**.

> **Status:** Notebook and quantization/WASM compatibility checks are ready on branch `audit/quantization-fp8-fp4`. Full 40-image Colab GPU/High-RAM benchmark numbers (`results.json`, `results_per_image.csv`, SHA-256 hashes, and final shipping recommendation) will be populated once `imagegrains_quantize_colab.ipynb` is run on Colab (L4 or A100 High-RAM).

---

## Verified `onnxruntime-web@1.31.1` (WASM EP) Compatibility

Tested directly against the repo's bundled `node_modules/onnxruntime-web` (`1.31.1`, Node 24) on synthetic Conv + MatMul + Gemm graphs:

| Variant | Representation | Loads & Runs in ORT-Web 1.31.1 (WASM)? | Notes |
| --- | --- | --- | --- |
| `fp32` | Reference float32 | **Yes** | CPU reference only (CP-SAM app pipeline passes `float16` input) |
| `fp16` | Native float16 (`ig2_cpsam_fp16.onnx`) | **Yes** | Current shipped baseline (617 MB) |
| `fp8_e4m3` | `FLOAT8E4M3FN` weights + `DequantizeLinear(19)` -> `fp16` (symmetric, no zero-point) | **Yes** | Storage + dequantization; scalar `zero_point` fails `PrepareForQDQ`, omitting `zero_point` passes |
| `fp4_e2m1` | Native ONNX opset 23 `FLOAT4E2M1` + `DequantizeLinear(23)` / `Cast(23)` | **No (Fails)** | `Failed to find kernel for DequantizeLinear(23)` / `Cast(23)` — `tensor(float4e2m1)` is not implemented in ORT-Web 1.31.1 |
| `fp4_e2m1_lut` | Storage-only 4-bit FP4: packed `uint8` (2×4-bit) + `Cast(uint8->int32)` + `Gather([256,2] fp16 LUT)` + block-scale `Mul` | **Yes** | Same 4-bit weight storage as FP4 without opset-23 `float4e2m1` kernels; size saving only, no compute speedup |
| `int8_wo` | 8-bit weight-only symmetric (`DequantizeLinear` `INT8` -> `fp16` for CP-SAM, `fp32` for U-Net) | **Yes** | Note: `quantize_dynamic` on `fp16` fails (`DynamicQuantizeLinear` only supports `float32`), whereas `DequantizeLinear` works cleanly |
| `int4_mnb_bs32` | `MatMulNBits` 4-bit symmetric (`block_size=32`, activations `fp16`) | **Yes** | Dedicated ORT WebGPU/CPU kernel; best candidate for both size and speed |
| `int4_mnb_bs128` | `MatMulNBits` 4-bit symmetric (`block_size=128`, activations `fp16`) | **Yes** | Slightly smaller scales overhead than `bs=32` |

In all quantized variants, `Conv`, `patch_embed`, `norm` (`LayerNorm`), biases, and the output head are kept in `fp16`/`fp32`.

---

## Summary Table (Cellpose-SAM — Pending Colab Run)

| Variant | Size (MB, gz / br) | SHA-256 | Loads in ORT-Web? | All-zero `cellprob` < 0? | PQ vs GT | D50 med APE | Mask PQ vs FP16 | Speed (WASM / CPU / CUDA ms/tile) | Pass? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fp32` | *pending* | *pending* | Yes | *pending* | — | — | — | *pending* | *pending* |
| `fp16` | ~588.8 MiB (617.4 MB) | `944a114a...` | Yes | *pending* | *pending* | *pending* | `1.000` | *pending* | *pending* |
| `fp8_e4m3` | *pending* | *pending* | Yes | *pending* | *pending* | *pending* | *pending* | *pending* | *pending* |
| `fp4_e2m1` | *pending* | *pending* | **No** | — | — | — | — | — | **FAIL** |
| `fp4_e2m1_lut` | *pending* | *pending* | Yes | *pending* | *pending* | *pending* | *pending* | *pending* | *pending* |
| `int8_wo` | *pending* | *pending* | Yes | *pending* | *pending* | *pending* | *pending* | *pending* | *pending* |
| `int4_mnb_bs32` | *pending* | *pending* | Yes | *pending* | *pending* | *pending* | *pending* | *pending* | *pending* |
| `int4_mnb_bs128` | *pending* | *pending* | Yes | *pending* | *pending* | *pending* | *pending* | *pending* | *pending* |

---

## Pass Criteria

A variant passes only if **all four** hold:
1. Loads and runs in `onnxruntime-web@1.31.1` (WASM EP).
2. Zero non-finite outputs across all 23 test tiles, and the all-zero `256×256` tile `cellprob` stays negative (matches PyTorch `fp32` sign ≥ 99%).
3. On the 40-image `IG2_data.zip` (`official_split == 'test'`) held-out set: mean `PQ vs GT` within `0.01` of `fp16` and median `D50` APE within `1.0` percentage point of `fp16`.
4. Mean `mask PQ vs fp16 >= 0.95` on the 40 real images.

---

## How to Reproduce

1. Open [`imagegrains_quantize_colab.ipynb`](imagegrains_quantize_colab.ipynb) in Google Colab (**L4** or **A100** runtime with **High-RAM**).
2. Optionally adjust the `CONFIG` cell (`MODELS_TO_RUN`, `VARIANTS_TO_RUN`, `EVAL_MAX_IMAGES = 40`, `WASM_NUM_THREADS = 4`, `SEED = 42`).
3. Run all cells top to bottom:
   - Exports `fp32` / `fp16` models from Zenodo `10.5281/zenodo.15728186` using isolated `uv` venvs (`cellpose==3.1.1.1` for U-Net, `cellpose>=4.0.9,<4.2` for CP-SAM).
   - Quantizes and caches `.onnx` models to `/content/drive/MyDrive/imagegrains_onnx_quant/models/` (not committed to git).
   - Runs ORT-Web 1.31.1 WASM load/numerics/speed checks and the 40-image `audit/followup/ts_cellpose_runner.mjs` + `audit/followup/ts_postprocess_runner.mjs` (`maxGrainAreaFraction = 0.40`) evaluation.
   - Outputs `results.json` and `results_per_image.csv` to `/content/quant_work/outputs/` and `/content/drive/MyDrive/imagegrains_onnx_quant/`.
