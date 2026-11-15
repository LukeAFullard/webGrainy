---
license: cc-by-4.0
library_name: onnx
pipeline_tag: image-segmentation
tags:
  - onnx
  - onnxruntime-web
  - webgpu
  - wasm
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

Self-contained ONNX exports of the official **ImageGrains 2.0** pretrained weights for instance segmentation of sedimentary grains (fluvial gravels, cobbles, pebbles, and clasts) to derive Particle Size Distributions ($D_{16}, D_{50}, D_{84}$) and grain morphometrics.

These exports strip out Python/Numba dependencies and pack all model weights into single `.onnx` protobuf files ($< 2\text{ GB}$ browser limit) so they can run **100% client-side in the browser** via [`onnxruntime-web`](https://onnxruntime.ai/docs/tutorials/web/) (WebGPU / WebAssembly) with zero server uploads.

## Available Model Files

| File | Upstream Checkpoint | Architecture | Size | Precision | Max Abs Error vs. PyTorch | Target Runtime |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **[`ig2_unet_fp32.onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_unet_fp32.onnx)** | `IG2_full_set.200525` | Cellpose-2/3 `CPnet` U-Net | `25.3 MiB` (`26.5 MB`) | FP32 | $3.81 \times 10^{-6}$ | WebGPU & CPU WASM (Desktop + Mobile) |
| **[`ig2_cpsam_fp16.onnx`](https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_cpsam_fp16.onnx)** | `IG2_full_set_cp_SAM` | Cellpose-SAM ViT-L + Flow Decoder | `588.8 MiB` (`617.4 MB`) | Native FP16 | $3.91 \times 10^{-3}$ ($1\text{ ULP}$) | Desktop WebGPU (`Float16Array` support) |

### Direct Browser CDN URLs
* **Fast / Universal U-Net (`25.3 MiB` / `26.5 MB`):** `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_unet_fp32.onnx`
* **High-Accuracy Cellpose-SAM (`588.8 MiB` / `617.4 MB`):** `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_cpsam_fp16.onnx`

## Input / Output Tensor Contracts

Both models output the exact same 3-channel spatial prediction tensor (`[flow_y, flow_x, cellprob]`), allowing them to share identical downstream Euler flow-tracking and mask-extraction post-processing.

### 1. `ig2_unet_fp32.onnx` (Fast / Universal)
* **Input Name:** `image`
* **Input Shape & Dtype:** `[batch, 2, height, width]` (`float32` / `Float32Array`) — supports dynamic spatial dimensions (e.g., $256 \times 256$, $384 \times 512$).
* **Channel Layout:**
  * Channel `0`: Grayscale image intensity normalized to $[0.0, 1.0]$ (1st–99th percentile scaling recommended).
  * Channel `1`: All zeros ($0.0$).
* **Output Name:** `flows_cellprob`
* **Output Shape & Dtype:** `[batch, 3, height, width]` (`float32`) — `[flow_y, flow_x, cellprob_logits]`.

### 2. `ig2_cpsam_fp16.onnx` (High-Accuracy Desktop WebGPU)
* **Input Name:** `image`
* **Input Shape & Dtype:** `[batch, 3, 256, 256]` (`float16` / `Float16Array`) — fixed $256 \times 256$ tile resolution; dynamic batch axis ($1$ to $32$).
* **Channel Layout:**
  * Channels `0, 1, 2`: RGB channels normalized independently to $[0.0, 1.0]$ using 1st–99th percentile intensity clipping.
* **Output Name:** `flows_cellprob`
* **Output Shape & Dtype:** `[batch, 3, 256, 256]` (`float16`) — `[flow_y, flow_x, cellprob_logits]`.

## Quickstart: Browser Inference (`onnxruntime-web`)

```javascript
import * as ort from 'onnxruntime-web/webgpu';

// 1. Load the 25.3 MiB U-Net model directly from Hugging Face CDN (WebGPU + WASM fallback)
const MODEL_URL =
  'https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_unet_fp32.onnx';

const session = await ort.InferenceSession.create(MODEL_URL, {
  executionProviders: ['webgpu', 'wasm'],
});

// 2. Prepare a 256x256 tile: Ch 0 = normalized grayscale [0,1], Ch 1 = zeros
const tileData = new Float32Array(1 * 2 * 256 * 256);
// ... populate tileData[0 .. 256*256 - 1] with normalized grayscale pixels ...

const inputTensor = new ort.Tensor('float32', tileData, [1, 2, 256, 256]);
const results = await session.run({ image: inputTensor });
const flowsCellprob = results.flows_cellprob.data; // Float32Array [3, 256, 256]
```

For `ig2_cpsam_fp16.onnx`, fetch from `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/ig2_cpsam_fp16.onnx`, pass `executionProviders: ['webgpu']`, and construct inputs with `new Float16Array(1 * 3 * 256 * 256)` (`new ort.Tensor('float16', tileData, [1, 3, 256, 256])`, supported in Chrome/Edge $\ge 135$ and Safari $\ge 17.4$).

## Export Details & Statement of Changes

* **`ig2_unet_fp32.onnx` (`25.3 MiB` / `26.5 MB`):** Converted from upstream PyTorch checkpoint `IG2_full_set.200525` (`cellpose==3.1.1.1`, ONNX opset 17, FP32). Replaced `CPnet.make_style`'s dynamic-kernel `avg_pool2d` with an equivalent `ReduceMean` operation (`x.mean(dim=(-2, -1))`) to enable arbitrary dynamic `height` and `width` inputs, and packed into a single protobuf file. Verified against PyTorch FP32 ($\text{max\_abs\_error} = 3.81 \times 10^{-6}$).
* **`ig2_cpsam_fp16.onnx` (`588.8 MiB` / `617.4 MB`):** Converted from upstream PyTorch checkpoint `IG2_full_set_cp_SAM` (fine-tuned from `mouseland/cellpose-sam`, which incorporates the Segment Anything ViT-L image encoder from `facebookresearch/segment-anything`). Exported from `cellpose==4.1.x` via `torch.export.export` + PyTorch Dynamo ONNX exporter (opset 18), cast natively to `torch.float16` prior to tracing to prevent mixed-precision graph mismatches, and consolidated into a single protobuf binary. Verified against PyTorch FP16 ($\text{max\_abs\_error} = 3.91 \times 10^{-3}$, matching $1\text{ ULP}$ in `float16`).

## Upstream Resources & Data Stores

* **Original ImageGrains Repository:** [dmair1989/imagegrains](https://github.com/dmair1989/imagegrains)
* **Official Pretrained Weights (Zenodo):** [DOI: 10.5281/zenodo.15728186](https://zenodo.org/records/15728186)
* **Cellpose Framework & Cellpose-SAM:** [MouseLand/cellpose](https://github.com/MouseLand/cellpose) & [mouseland/cellpose-sam](https://huggingface.co/mouseland/cellpose-sam)
* **Segment Anything (SAM):** [facebookresearch/segment-anything](https://github.com/facebookresearch/segment-anything)

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

## License & Third-Party Notices

* **Converted ONNX Model Weights:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — derived from *ImageGrains 2.0 models* ([Zenodo `10.5281/zenodo.15728186`](https://zenodo.org/records/15728186), licensed under CC BY 4.0) by David Mair et al. Converted to ONNX (FP32 / FP16) by the `webGrainy` / `inYourOwnBrowser` contributors (see *Export Details & Statement of Changes* above).
* **Upstream `dmair1989/imagegrains` Software:** [BSD 3-Clause License](https://github.com/dmair1989/imagegrains/blob/main/LICENSE.md) (`Copyright (c) 2023, David Mair`).
* **Upstream `MouseLand/cellpose` & `mouseland/cellpose-sam`:** [BSD 3-Clause License](https://github.com/MouseLand/cellpose/blob/main/LICENSE) (`Copyright © 2020–2025 Howard Hughes Medical Institute`). Provided "AS IS" without warranty; neither HHMI's name nor its contributors' names may be used for endorsement without prior written permission. *Note: Per `MouseLand/cellpose/README.md`, Cellpose's own base training dataset is licensed under CC-BY-NC, while HHMI distributes `mouseland/cellpose-sam` under BSD 3-Clause.*
* **Upstream `facebookresearch/segment-anything` (SAM ViT-L Encoder in `ig2_cpsam_fp16.onnx`):** [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) (`Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.`).
  * `facebookresearch/segment-anything` contains **no `NOTICE` file** (Apache-2.0 §4(d)).
  * Modifications (Apache-2.0 §4(b)): SAM ViT-L weights were fine-tuned by HHMI into `cellpose-sam`, fine-tuned by Mair et al. into `IG2_full_set_cp_SAM`, and exported to native FP16 ONNX (opset 18) as `ig2_cpsam_fp16.onnx`.
  * A full copy of the Apache-2.0 license is available at <https://www.apache.org/licenses/LICENSE-2.0> (Apache-2.0 §4(a)) and in `webGrainy`'s `THIRD_PARTY_NOTICES.md`.
