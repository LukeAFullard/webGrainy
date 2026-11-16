# ImageGrains 2.0 ONNX Quantization Benchmark (`audit/quantization/`)

This directory contains the self-contained Colab pipeline ([`imagegrains_quantize_colab.ipynb`](imagegrains_quantize_colab.ipynb)) to export, quantize, and benchmark lower-precision variants of the ImageGrains 2.0 models (`IG2_full_set_cp_SAM` Cellpose-SAM ViT-L and `IG2_full_set.200525` U-Net) against **`onnxruntime-web@1.31.1`**.

> **Status:** Colab L4/High-RAM benchmark complete (`results.json`, `results_per_image.csv` committed on branch `audit/quantization-fp8-fp4`).

---

## Verified `onnxruntime-web@1.31.1` (WASM EP) Compatibility

Tested both on synthetic graphs and full exported ImageGrains 2.0 models against **`onnxruntime-web@1.31.1`** (Node 24, WASM EP):

| Variant | Representation | Loads & Runs in ORT-Web 1.31.1 (WASM)? | Notes |
| --- | --- | --- | --- |
| `fp32` | Reference float32 | **Yes** | CPU reference only (CP-SAM app pipeline passes `float16` input) |
| `fp16` | Native float16 (`ig2_cpsam_fp16.onnx`) | **Yes** | Current shipped baseline (588.76 MiB / 617.4 MB) |
| `fp8_e4m3` | `FLOAT8E4M3FN` weights + `DequantizeLinear(19)` -> `fp16` (symmetric, no zero-point) | **Yes** | Quantizes 96 layers (98.16% of weights); omitting `zero_point` is required |
| `fp4_e2m1` | Native ONNX opset 23 `FLOAT4E2M1` + `DequantizeLinear(23)` / `Cast(23)` | **No (Fails)** | `Failed to find kernel for DequantizeLinear(23)` — `tensor(float4e2m1)` is unsupported |
| `fp4_e2m1_lut` | Storage-only 4-bit FP4: packed `uint8` (2×4-bit) + `Cast(uint8->int32)` + `Gather([256,2] fp16 LUT)` + block-scale `Mul` | **Yes** | Quantizes 96 layers (98.16% of weights) without opset-23 FP4 kernels |
| `int8_wo` | `DequantizeLinear(INT8 -> FLOAT16)` with `fp16` scale | **No (Fails)** | ORT-Web rejects `float16` scale on `INT8` `DequantizeLinear` (`float32` scale + `Cast` required) |
| `int4_mnb_bs32` | `MatMulNBits` 4-bit symmetric (`block_size=32`, activations `fp16`) | **Yes** | Only matched 48 `MatMul` layers (40.90% of weights) |
| `int4_mnb_bs128` | `MatMulNBits` 4-bit symmetric (`block_size=128`, activations `fp16`) | **Yes** | Only matched 48 `MatMul` layers (40.90% of weights) |

In all quantized CP-SAM variants, `Conv` layers (`patch_embed`, `neck`, `out` head), `LayerNorm`, and biases remain in `fp16`.

---

## Summary Table — Cellpose-SAM (`IG2_full_set_cp_SAM`, 40 Held-Out Images)

| Variant | Size (MiB, gz / br) | SHA-256 (prefix) | ORT-Web Load | All-zero `cellprob` mean | PQ vs GT | D50 Mean / Med APE | Mask PQ vs FP16 | Speed (WASM / PyCPU / CUDA ms/tile) | Pass? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fp32` | 1175.54 (547.0 / 478.8) | `2e27d7d1` | Yes (5.60s) | `-5.19` | — | — | — | 13,395 / 2,091 / 93.8 | **PASS** (ref) |
| `fp16` | 588.76 (449.4 / 444.3) | `ffee5e66` | Yes (4.54s) | `-5.19` | `0.6521` | `8.91%` / `2.87%` | `1.0000` | 13,917 / 2,273 / 50.0 | **PASS** (base) |
| **`fp8_e4m3`** | **301.19 (244.4 / 241.9)** | `0f37439d` | **Yes (2.54s)** | **`-5.17`** | **`0.6530`** | **`8.95%` / `2.83%`** | **`0.9893`** | 17,887 / 4,850 / 57.3 | **PASS** |
| `fp4_e2m1` | 157.19 (133.9 / 132.3) | `2a196605` | **No** | — | — | — | — | — | **FAIL** |
| **`fp4_e2m1_lut`** | **174.80 (157.7 / 156.6)** | `d49d8f07` | **Yes (9.47s)** | **`-5.09`** | **`0.6520`** | **`8.97%` / `2.79%`** | **`0.9664`** | **14,178** / 2,426 / 55.2 | **PASS** |
| `int8_wo` | 301.19 (257.6 / 255.4) | `3410ab46` | **No** | — | — | — | — | — | **FAIL** |
| `int4_mnb_bs32` | 416.19 (324.8 / 321.3) | `8c79db8f` | Yes (3.45s) | `-5.14` | `0.6504` | `10.18%` / `3.17%` | `0.9780` | 14,193 / 2,314 / 53.9 | **PASS** (outlier) |
| `int4_mnb_bs128` | 410.56 (317.1 / 313.4) | `4515f10a` | Yes (3.49s) | `-5.17` | `0.6508` | `10.13%` / `3.09%` | `0.9714` | 14,202 / 2,313 / 54.1 | **PASS** (outlier) |

### Key Findings & Per-Image Stability
1. **`fp8_e4m3` is virtually lossless and cuts download size nearly in half:**
   - **301.19 MiB** raw (**241.86 MiB** brotli, **45.6% smaller** than `fp16`'s 444.28 MiB brotli).
   - Loads faster (`2.54s` vs `4.54s`) and uses **1 GB less peak RAM** (`2808 MB` vs `3868 MB`) in WASM.
   - `PQ vs GT` (`0.6530`) and `D50` median APE (`2.83%`) match or slightly beat `fp16`, with `0.9893` mean mask PQ vs `fp16` and **zero** bad images (worst per-image mask PQ vs `fp16` is `0.9471`; worst D50 APE delta is `+1.55%`).
2. **`fp4_e2m1_lut` cuts download size by 65% with no accuracy loss and no WASM slowdown:**
   - **174.80 MiB** raw (**156.63 MiB** brotli, **64.7% smaller** than `fp16`).
   - Runs at virtually the **same WASM speed** as `fp16` (`14.18s/tile` vs `13.92s/tile`) and uses less RAM (`3474 MB` vs `3868 MB`).
   - `PQ vs GT` (`0.6520`), `D50` mean/median APE (`8.97%` / `2.79%`), and `mask PQ vs fp16` (`0.9664`) all pass cleanly with **zero** catastrophic failures (worst per-image mask PQ vs `fp16` is `0.9138`; worst D50 APE delta is `+2.47%`).
   - Trade-off: slower WASM session initialization (`9.47s` vs `4.54s`) due to LUT unpacking at load time.
3. **`int4_mnb_bs32` / `int4_mnb_bs128` underperform both `fp8_e4m3` and `fp4_e2m1_lut`:**
   - `MatMulNBitsQuantizer` only matched `48` `MatMul` ops (`40.9%` of weights), leaving size at **410–416 MiB** (`313–321 MiB` brotli) with **no WASM speedup** (`14.2s/tile`).
   - Worse, both had a **+44.3% D50 APE spike** on `NB2__test__P5240929_Crop_3`, pushing mean D50 APE from `8.91%` to `10.18%`.
4. **All passing CP-SAM variants preserve negative `cellprob` on the all-zero tile** (`-5.09` to `-5.19`, `100%` negative).

### Recommendation
- **Best drop-in replacement (minimal risk):** `fp8_e4m3` (242 MiB brotli, `0.9893` mask PQ vs `fp16`, faster load, 1 GB less RAM).
- **Best maximum-compression option:** `fp4_e2m1_lut` (157 MiB brotli, `0.9664` mask PQ vs `fp16`, same WASM speed as `fp16`).
- **Follow-up experiment:** [`imagegrains_quantize_mixed_w4_w8_colab.ipynb`](imagegrains_quantize_mixed_w4_w8_colab.ipynb) tests the sensitivity-guided mixed W4/W8 scheme from [arXiv:2609.21038](https://arxiv.org/abs/2609.21038) (keeping `blocks.0.mlp.lin2` and `blocks.23.attn.qkv` in `fp8_e4m3`/`fp16` while quantizing the remaining 94 layers to `fp4_e2m1_lut`).

---

## Summary — U-Net (`IG2_full_set.200525`)

U-Net is already small (**25.26 MiB** raw / **23.42 MiB** brotli) and fast (**755 ms/tile** WASM):
- `fp32` (`5e692c55`): **PASS** (`755 ms/tile` WASM, `138 ms/tile` PyCPU, `5.0 ms/tile` CUDA).
- `fp16` (`768fd1ab`, `12.69 MiB`): loads & runs (`761 ms/tile` WASM), `cellprob` mean `-7.88` on all-zero tile; `runUnetCellposeInference` passes `float32` input so `fp16` was not run through the 40-image TS runner.
- `fp8_e4m3`, `fp4_e2m1`, `fp4_e2m1_lut`, `int8_wo`: failed to load in ORT-Web due to `onnx.version_converter` upgrading `ReduceMean` to opset 18+ (`Unrecognized attribute: axes for operator ReduceMean`).
- `int4_mnb_bs32` / `int4_mnb_bs128`: `0` layers quantized (U-Net is `Conv` + `Gemm`, no `MatMul`).

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
3. Run all cells top to bottom. Outputs (`results.json`, `results_per_image.csv`) are saved to `/content/quant_work/outputs/` and `/content/drive/MyDrive/imagegrains_onnx_quant/`.
