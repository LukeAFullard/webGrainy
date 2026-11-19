---
license: cc-by-4.0
library_name: onnx
pipeline_tag: image-segmentation
tags:
  - onnx
  - onnxruntime-web
  - webgpu
  - wasm
  - quantization
  - int8
  - fp4
  - image-segmentation
  - instance-segmentation
  - geoscience
  - sedimentology
  - fluvial-geomorphology
  - particle-size-distribution
  - grain-size
  - cellpose
  - cellpose-sam
  - imagegrains
---

# ImageGrains 2.0: Browser-Ready ONNX Models (WebGPU & WASM)

Self-contained ONNX exports (including quantized CP-SAM variants) of the official **ImageGrains 2.0** pretrained weights for instance segmentation of sedimentary grains (fluvial gravels, cobbles, pebbles, and clasts) to derive Particle Size Distributions ($D_{16}, D_{50}, D_{84}$) and grain morphometrics.

All files pack weights into single self-contained `.onnx` binaries ($< 620\text{ MB}$, zero external data files) designed to run **100% client-side in the browser** via [`onnxruntime-web`](https://onnxruntime.ai/docs/tutorials/web/) (WebGPU / WebAssembly) with zero server uploads.

---

## Which Model Should I Choose?

All three **Cellpose-SAM** variants (`fp16`, `int8_wo_fp32scale`, `fp4_e2m1_lut`) deliver **statistically indistinguishable segmentation and $D_{50}$ accuracy** on the 40-image held-out ImageGrains 2.0 test benchmark (`PQ = 0.652–0.653`, median $D_{50}$ error `2.8–2.9%`), while differing in download footprint, WASM memory, and runtime speed:

| Model File | Best For | Raw Size (Brotli) | WASM Load | Peak WASM RAM | WASM Speed (`256×256` tile) | Mean PQ vs GT | Med (Mean) $D_{50}$ APE vs GT |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **[`ig2_cpsam_int8_wo_fp32scale.onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_cpsam_int8_wo_fp32scale.onnx)** | **Recommended CP-SAM default (WASM / standard laptops)** — best accuracy, half the RAM, `2.2×` faster than FP16 | `301.6 MiB` (`255.6 MiB`) | `3.12 s` | **`2,081 MB`** | `14.5 s` | **`0.6529`** | `2.88%` (`8.91%`) |
| **[`ig2_cpsam_fp4_e2m1_lut.onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_cpsam_fp4_e2m1_lut.onnx)** | **Smallest CP-SAM download** (`65%` smaller than FP16) — slow/metered connections with `>= 8 GB` system RAM | **`174.8 MiB`** (`156.6 MiB`) | `9.12 s` | `3,708 MB` | **`14.3 s`** | `0.6520` | **`2.79%`** (`8.97%`) |
| **[`ig2_cpsam_fp16.onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_cpsam_fp16.onnx)** | **WebGPU (`shader-f16`) reference** — native FP16 kernels on fast broadband + GPU | `588.8 MiB` (`444.3 MiB`) | `4.55 s` | `3,837 MB` | `32.4 s` | `0.6521` | `2.87%` (`8.91%`) |
| **[`ig2_unet_fp32.onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_unet_fp32.onnx)** | **Mobile / low-RAM / fast batch preview** (`~43×` faster per tile than FP16 in WASM) | **`25.3 MiB`** (`23.4 MiB`) | **`0.91 s`** | **`696 MB`** | **`0.76 s`** | `0.5397` | `9.44%` (`24.38%`) |

> **Important memory note on FP4 vs INT8 in ORT-Web WASM:** Although `ig2_cpsam_fp4_e2m1_lut.onnx` has the smallest download (`156.6 MiB` compressed), its `Gather` + `Mul` LUT dequantization materializes FP16 weights in memory during execution (`3,708 MB` peak WASM RAM, `9.12 s` load). Choose **`ig2_cpsam_int8_wo_fp32scale.onnx`** if browser memory (`2,081 MB`) is the constraint; choose **`ig2_cpsam_fp4_e2m1_lut.onnx`** if download size / cache quota is the constraint.

---

## Verified Checksums & Direct CDN URLs

| File | Exact Bytes | SHA-256 | Direct URL |
| :--- | ---: | :--- | :--- |
| `ig2_unet_fp32.onnx` | `26,489,665` | `5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c` | `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_unet_fp32.onnx` |
| `ig2_cpsam_fp16.onnx` | `617,364,567` | `944a114a0cb1a3a215c11affefe7211caac6da2b74895c496d5a7b5a23b6230d` | `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_cpsam_fp16.onnx` |
| `ig2_cpsam_int8_wo_fp32scale.onnx` | `316,272,029` | `2cda0be5b81f1d0c0ac36998beb9f741e11833aacd089c4f5cee92488bab6f43` | `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_cpsam_int8_wo_fp32scale.onnx` |
| `ig2_cpsam_fp4_e2m1_lut.onnx` | `183,292,650` | `d49d8f0779af3956b45b506719702bc3f9b7e0044a2d2a0a6842751544320c99` | `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_cpsam_fp4_e2m1_lut.onnx` |

---

## Headline Accuracy & Parity Benchmark (`40` Held-Out IG2 Test Images)

Evaluated using [`onnxruntime-web@1.31.1`](https://www.npmjs.com/package/onnxruntime-web) and the shipped `webGrainy` TypeScript inference + Euler flow-tracking pipeline (`flowThreshold = 0.45`, `cellprobThreshold = 0.0`, `minSize = 30`, `maxGrainAreaFraction = 0.40`) on all `40` `official_split == 'test'` images from [`IG2_data.zip`](https://zenodo.org/records/17866827), alongside upstream PyTorch baselines (`cellpose==3.1.1.1` / `4.1.x`).

| Model / Reference | PQ vs GT | F1@0.5 vs GT | AP@0.5 vs GT | $D_{50}$ Med APE vs GT | $D_{50}$ Mean APE vs GT | PQ vs PyTorch | Mask PQ vs `fp16` | Catastrophic Fails (`PQ < 0.20`) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PyTorch U-Net (`cp3`) | `0.5282` | `0.6162` | `0.4713` | `9.26%` | `27.47%` | `1.0000` | — | `2 / 40` |
| **`ig2_unet_fp32.onnx`** | `0.5397` | `0.6348` | `0.4920` | `9.44%` | `24.38%` | `0.9298` | — | `2 / 40` |
| PyTorch CP-SAM (`cp4`) | `0.6424` | `0.7575` | `0.6233` | `4.42%` | `14.52%` | `1.0000` | — | `0 / 40` |
| **`ig2_cpsam_fp16.onnx`** | `0.6521` | `0.7655` | `0.6314` | `2.87%` | `8.91%` | `0.9327` | `1.0000` | **`0 / 40`** |
| **`ig2_cpsam_int8_wo_fp32scale.onnx`** | **`0.6529`** | **`0.7667`** | **`0.6328`** | `2.88%` | `8.91%` | **`0.9334`** | **`0.9940`** | **`0 / 40`** |
| **`ig2_cpsam_fp4_e2m1_lut.onnx`** | `0.6520` | `0.7660` | `0.6324` | **`2.79%`** | `8.97%` | `0.9218` | `0.9664` | **`0 / 40`** |

- **23-tile numerical verification vs PyTorch FP32 (ORT-Web WASM):** `0` non-finite values across all 4 models; all-zero `256×256` background `cellprob` mean stays strongly negative (`-7.88` U-Net, `-5.19` FP16, `-5.19` INT8-WO, `-5.09` FP4-LUT; `100.0%` sign agreement vs PyTorch FP32).
- **Paired bootstrap comparisons (10,000 draws on $D_{50}$ APE vs GT):** Differences between `cpsam_fp16`, `cpsam_int8`, and `cpsam_fp4` are all statistically indistinguishable (`95%` CIs span `[-0.31, +0.31] pp`).

---

## Input / Output Tensor Contracts

All four models output the same 3-channel spatial prediction tensor (`[flow_y, flow_x, cellprob]`) for downstream Euler flow-tracking and mask extraction.

### `ig2_unet_fp32.onnx` (Fast / Universal)
* **Input Name:** `image`
* **Input Shape & Dtype:** `[batch, 2, height, width]` (`float32` / `Float32Array`) — supports dynamic spatial dimensions (multiples of 16 recommended; e.g., $224 \times 224$, $256 \times 256$).
* **Channel Layout:**
  * Channel `0`: Grayscale image intensity normalized using 1st–99th percentile scaling.
  * Channel `1`: All zeros ($0.0$).
* **Output Name & Shape:** `flows_cellprob` — `[batch, 3, height, width]` (`float32`), `[flow_y, flow_x, cellprob_logits]`.

### All `ig2_cpsam_*.onnx` Models (`fp16`, `int8_wo_fp32scale`, `fp4_e2m1_lut`)
All three CP-SAM variants share an identical tensor contract:
* **Input Name:** `image`
* **Input Shape & Dtype:** `[batch, 3, 256, 256]` (`float16`) — fixed $256 \times 256$ tile resolution; dynamic batch axis.
* **Channel Layout:**
  * Channels `0, 1, 2`: RGB channels normalized independently per channel using 1st–99th percentile intensity scaling.
* **Output Name & Shape:** `flows_cellprob` — `[batch, 3, 256, 256]` (`float16`), `[flow_y, flow_x, cellprob_logits]`.

---

## Quickstart: Browser Inference (`onnxruntime-web`)

```javascript
import * as ort from 'onnxruntime-web/webgpu';

// Example 1: Universal U-Net (25.3 MiB, WebGPU + WASM)
const UNET_URL =
  'https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_unet_fp32.onnx';

const session = await ort.InferenceSession.create(UNET_URL, {
  executionProviders: ['webgpu', 'wasm'],
});

// Ch 0 = 1st-99th percentile normalized grayscale, Ch 1 = zeros
const tileData = new Float32Array(1 * 2 * 256 * 256);
// ... populate tileData[0 .. 256*256 - 1] ...

const inputTensor = new ort.Tensor('float32', tileData, [1, 2, 256, 256]);
const results = await session.run({ image: inputTensor });
const flowsCellprob = results.flows_cellprob.data; // Float32Array [3, 256, 256]
```

For any of the CP-SAM models (`ig2_cpsam_int8_wo_fp32scale.onnx`, `ig2_cpsam_fp4_e2m1_lut.onnx`, or `ig2_cpsam_fp16.onnx`), pass IEEE-754 binary16 data (`Uint16Array` bits or `Float16Array`) as `new ort.Tensor('float16', tileF16, [1, 3, 256, 256])`. On WebAssembly CPU (`executionProviders: ['wasm']`), `ig2_cpsam_int8_wo_fp32scale.onnx` is recommended for its ~2.1 GB peak memory and ~14.5 s/tile latency.

---

## Export Details & Statement of Changes

* **`ig2_unet_fp32.onnx` (`25.26 MiB`):** Exported from upstream PyTorch checkpoint `IG2_full_set.200525` (`cellpose==3.1.1.1`, ONNX opset 17, FP32). Replaced `CPnet.make_style`'s dynamic-kernel `avg_pool2d` with an equivalent `ReduceMean` operation (`x.mean(dim=(-2, -1))`) to enable arbitrary dynamic `height` and `width` inputs, and packed into a single protobuf file. Verified against PyTorch FP32 ($\text{max\_abs\_error} = 3.81 \times 10^{-6}$).
* **`ig2_cpsam_fp16.onnx` (`588.76 MiB`):** Exported from upstream PyTorch checkpoint `IG2_full_set_cp_SAM` (fine-tuned from `mouseland/cellpose-sam`, incorporating the Segment Anything ViT-L image encoder from `facebookresearch/segment-anything`). Exported from `cellpose==4.1.x` via `torch.export.export` + PyTorch Dynamo ONNX exporter (opset 18), instantiated natively in `torch.float16` prior to tracing to prevent mixed-precision graph mismatches, and consolidated into a single protobuf binary. Verified against PyTorch FP16 ($\text{max\_abs\_error} = 3.91 \times 10^{-3}$, matching $1\text{ ULP}$ in `float16`) and ORT-Web WASM vs PyTorch FP32 ($\text{NRMSE} = 3.44 \times 10^{-4}$).
* **`ig2_cpsam_int8_wo_fp32scale.onnx` (`301.62 MiB`):** Weight-only symmetric per-channel `INT8` quantization derived from `ig2_cpsam_fp16.onnx` across `96` transformer/MLP linear `MatMul` weight tensors (`98.16%` of parameters). Uses `DequantizeLinear` with `float32` scales followed by `Cast` to `float16` for full `onnxruntime-web@1.31.1` WASM compatibility (`Conv`, `LayerNormalization`, biases, and activations remain `fp16`).
* **`ig2_cpsam_fp4_e2m1_lut.onnx` (`174.80 MiB`):** Block-32 asymmetric `FP4` (`E2M1`) weight-only quantization derived from `ig2_cpsam_fp16.onnx` across the same `96` `MatMul` weight tensors (`98.16%` of parameters). Packs two 4-bit indices per `uint8` and decodes at runtime via opset-18-compatible `Cast(uint8->int32)` + `Gather` on a 256×2 `float16` lookup table + block-scale `Mul`, requiring zero custom ops or opset-23 FP4 kernels.

---

## Upstream Resources & Data Stores

* **Browser Application & Benchmark Suite:** [LukeAFullard/webGrainy](https://github.com/LukeAFullard/webGrainy)
* **Original ImageGrains Repository:** [dmair1989/imagegrains](https://github.com/dmair1989/imagegrains)
* **Official Pretrained Weights (Zenodo):** [DOI: 10.5281/zenodo.15728186](https://zenodo.org/records/15728186)
* **Held-Out Benchmark Dataset (`IG2_data.zip`):** [DOI: 10.5281/zenodo.17866827](https://zenodo.org/records/17866827)
* **Cellpose Framework & Cellpose-SAM:** [MouseLand/cellpose](https://github.com/MouseLand/cellpose) & [mouseland/cellpose-sam](https://huggingface.co/mouseland/cellpose-sam)
* **Segment Anything (SAM):** [facebookresearch/segment-anything](https://github.com/facebookresearch/segment-anything)

---

## Citation & Attribution

If you use these models in academic work, reports, or software, please cite the original **ImageGrains**, **Cellpose / Cellpose-SAM**, and **Segment Anything** publications:

```bibtex
@article{Mair2026ImageGrains2,
  author  = {Mair, David and Witz, Guillaume and Do Prado, Ariel and Garefalakis, Philippos and Wild, Amanda and Ville, Fanny and Schuster, Bennet and Horn, Michael and {\"O}sterle, J{\"u}rgen and Fabbri, Stefano Claudio and Litty, Camille and Achleitner, Stefan and Leistner, Sebastian and Hiller, Clemens and Schlunegger, Fritz},
  title   = {ImageGrains 2.0: Improved precision and generalization for grain segmentation},
  journal = {Earth Surface Dynamics},
  volume  = {14},
  pages   = {527--551},
  year    = {2026},
  doi     = {10.5194/esurf-14-527-2026}
}

@dataset{Mair2025ImageGrains2Weights,
  author    = {Mair, David and Witz, Guillaume and do Prado, Ariel and Garefalakis, Philippos and Wild, Amanda Lily and Ville, Fanny and Schuster, Bennet and Horn, Michael and {\"O}sterle, J{\"u}rgen and Fabbri, Stefano Claudio and Litty, Camille and Achleitner, Stefan and Leistner, Sebastian and Hiller, Clemens and Schlunegger, Fritz},
  title     = {ImageGrains 2.0 models},
  year      = {2025},
  publisher = {Zenodo},
  doi       = {10.5281/zenodo.15728186},
  url       = {https://zenodo.org/records/15728186}
}

@article{Mair2024ImageGrains,
  author  = {Mair, David and Witz, Guillaume and Do Prado, Ariel Henrique and Garefalakis, Philippos and Schlunegger, Fritz},
  title   = {Automated detecting, segmenting and measuring of grains in images of fluvial gravels: The potential for large and precise data from specialist deep learning models and transfer learning},
  journal = {Earth Surface Processes and Landforms},
  volume  = {49},
  number  = {3},
  pages   = {1099--1116},
  year    = {2024},
  doi     = {10.1002/esp.5755}
}

@article{Pachitariu2025CellposeSAM,
  author  = {Pachitariu, Marius and Rariden, Michael and Stringer, Carsen},
  title   = {Cellpose-SAM: superhuman generalization for cellular segmentation},
  journal = {bioRxiv},
  year    = {2025},
  doi     = {10.1101/2025.04.28.651001}
}

@article{Stringer2021Cellpose,
  author  = {Stringer, Carsen and Wang, Tim and Michaelos, Michalis and Pachitariu, Marius},
  title   = {Cellpose: a generalist algorithm for cellular segmentation},
  journal = {Nature Methods},
  volume  = {18},
  number  = {1},
  pages   = {100--106},
  year    = {2021},
  doi     = {10.1038/s41592-020-01018-x}
}

@inproceedings{Kirillov2023SAM,
  author    = {Kirillov, Alexander and Mintun, Eric and Ravi, Nikhila and Mao, Hanzi and Rolland, Chloe and Gustafson, Laura and Xiao, Tete and Whitehead, Spencer and Berg, Alexander C. and Lo, Wan-Yen and Doll{\'a}r, Piotr and Girshick, Ross},
  title     = {Segment Anything},
  booktitle = {Proceedings of the IEEE/CVF International Conference on Computer Vision (ICCV)},
  pages     = {4015--4026},
  year      = {2023},
  doi       = {10.1109/ICCV51070.2023.00371}
}
```

---

## License & Third-Party Notices

* **Converted & Quantized ONNX Model Weights:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — derived from *ImageGrains 2.0 models* ([Zenodo `10.5281/zenodo.15728186`](https://zenodo.org/records/15728186), licensed under CC BY 4.0) by David Mair et al. Exported and quantized by the `webGrainy` / `inYourOwnBrowser` contributors (see *Export Details & Statement of Changes* above).
* **Upstream `dmair1989/imagegrains` Software:** [BSD 3-Clause License](https://github.com/dmair1989/imagegrains/blob/main/LICENSE.md) (`Copyright (c) 2023, David Mair`).
* **Upstream `MouseLand/cellpose` & `mouseland/cellpose-sam`:** [BSD 3-Clause License](https://github.com/MouseLand/cellpose/blob/main/LICENSE) (`Copyright © 2020–2025 Howard Hughes Medical Institute`). Provided "AS IS" without warranty; neither HHMI's name nor its contributors' names may be used for endorsement without prior written permission. *Note: Per `MouseLand/cellpose/README.md`, Cellpose's own base training dataset is licensed under CC-BY-NC, while HHMI distributes `mouseland/cellpose-sam` under BSD 3-Clause.*
* **Upstream `facebookresearch/segment-anything` (SAM ViT-L Encoder in `ig2_cpsam_*.onnx`):** [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) (`Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.`).
  * `facebookresearch/segment-anything` contains **no `NOTICE` file** (Apache-2.0 §4(d)).
  * Modifications (Apache-2.0 §4(b)): SAM ViT-L weights were fine-tuned by HHMI into `cellpose-sam`, fine-tuned by Mair et al. into `IG2_full_set_cp_SAM`, exported to native FP16 ONNX (opset 18) as `ig2_cpsam_fp16.onnx`, and weight-only quantized into `ig2_cpsam_int8_wo_fp32scale.onnx` and `ig2_cpsam_fp4_e2m1_lut.onnx`.
  * A full copy of the Apache-2.0 license is available at <https://www.apache.org/licenses/LICENSE-2.0> (Apache-2.0 §4(a)) and in `webGrainy`'s `THIRD_PARTY_NOTICES.md`.
