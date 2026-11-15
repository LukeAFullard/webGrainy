# Third-Party Notices

webGrainy's own source code is licensed under the BSD 3-Clause License (see `LICENSE`).
This file lists third-party software that is **bundled into `dist/`** and the
**model lineage** of the weights that the app downloads at runtime.

## Bundled software

### ONNX Runtime Web (`onnxruntime-web`, `onnxruntime-common`) — MIT

Bundled into `dist/ui/main.js` and `dist/modules/*`, and shipped as
`dist/ort/ort-wasm-simd-threaded.jsep.{mjs,wasm}`.
Source: <https://github.com/microsoft/onnxruntime>

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

ONNX Runtime itself incorporates further third-party components. Their notices are
published at <https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt>.

## Model weights (downloaded at runtime, not bundled)

| Artifact | Source | License (as stated by the distributor) |
|---|---|---|
| `ig2_unet_fp32.onnx`, `ig2_cpsam_fp16.onnx` (revision `7773328a544ac050b7820667e68cbfb02a2e954a`) | <https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx> | CC BY 4.0 (model card) |
| ImageGrains 2.0 pretrained weights (upstream of the ONNX conversion) | Zenodo, doi:10.5281/zenodo.15728186; code at <https://github.com/dmair1989/imagegrains> | See the Zenodo record and the upstream repository |
| Cellpose / Cellpose-SAM architecture and training code | <https://github.com/MouseLand/cellpose> | BSD 3-Clause |
| Segment Anything (SAM) ViT image encoder used by Cellpose-SAM | <https://github.com/facebookresearch/segment-anything> | Apache License 2.0 |

Attribution for CC BY 4.0: *ImageGrains 2.0 models by D. Mair et al.; converted to ONNX
by the webGrainy / inYourOwnBrowser contributors; changes: format conversion (PyTorch →
ONNX, FP16 export of Cellpose-SAM).* The app shows the attribution and citation notice in
"About & Citations" and embeds it in every export.

The audit could not reach the upstream ImageGrains repository to confirm its license
terms for the weights. Maintainers should confirm that redistributing the converted
weights under CC BY 4.0 is compatible with the upstream release terms and with Apache-2.0
for the SAM-derived encoder (AUDIT_REPORT.md F-24).
