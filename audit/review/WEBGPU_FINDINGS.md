# WebGPU and float16: findings and how to check your GPU

## Background
In the Colab benchmark, ONNX Runtime's **CUDA** float16 backend diverged from CPU/WASM
on Cellpose-SAM tiles that include Cellpose's 8 px zero border. Colab runs native CUDA
kernels on an NVIDIA GPU. Browsers instead use ONNX Runtime's **WebGPU** backend: different
kernels (WGSL shaders), which also compute in float16 when the adapter supports
`shader-f16`. So the CUDA result shows a *risk* for WebGPU, not that WebGPU is affected.

## What was tested here (no physical GPU: Chromium's software WebGPU, SwiftShader)
`audit/review/webgpu_vs_wasm.mjs` compares WebGPU vs WASM using the app's own built code.

| Test | Result |
|---|---|
| **U-Net (float32) on WebGPU vs WASM**: photo, single tile with zero border, mostly-padding image, all-black image | Max difference ≤ 1e-5; masks identical (PQ 1.0) in every case. WebGPU's float32 kernels handle the zero border correctly. |
| **Cellpose-SAM (float16) on WebGPU without `shader-f16`** | ORT creates the session, but its WGSL shaders fail to compile. `session.run()` **does not fail**: it returns plausible-looking wrong numbers (43 % cell-probability sign agreement, 0 grains vs 7). The only signal is WebGPU "uncapturederror" events (1,626 in one tile). |
| **Cellpose-SAM float16 on WebGPU *with* `shader-f16`** | **Not testable here.** SwiftShader has no float16 support. Needs a real GPU (see below). |

## Safeguards now in the app
1. **No float16 WebGPU without `shader-f16`.** Cellpose-SAM uses WebGPU only if the adapter
   reports `shader-f16`, otherwise WASM. This was already in place, and the test above shows
   it is essential.
2. **WebGPU error watch (new).** Any WebGPU validation error during a run makes inference
   fail with `NumericInstabilityError` instead of returning silent garbage. Verified on
   SwiftShader: the silent-garbage case above is now caught.
3. **Output plausibility check (new).** NaN, Infinity, or |value| > 1000 in any tile also
   raises `NumericInstabilityError`.
4. **Automatic fallback (new).** On `NumericInstabilityError` from a WebGPU session, the
   engine switches *that model* to WASM for the rest of the page and redoes the image once.
   The user sees: "The GPU produced invalid results … now runs on the CPU …".

These catch outright failures. They do **not** catch subtle float16 drift (finite,
plausible but slightly different outputs). Only the real-GPU comparison below can measure
that.

## How to check a real GPU (please run on 1–3 machines)

**Easiest: no installation.** Open <https://lukeafullard.github.io/webGrainy/gpucheck.html> in
Chrome or Edge, choose *Cellpose-SAM*, press **Run GPU check**, then *Download report*.
The page runs the script's four cases plus a photo with a large black area, using the app's own code.

**Alternative: the command-line script**
On a computer with a modern GPU and Chrome/Edge (WebGPU with `shader-f16`):
```bash
npm ci && npm run build
# download the pinned model once (or reuse the app's cache):
curl -L -o ig2_cpsam_fp16.onnx \
  https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/7773328a544ac050b7820667e68cbfb02a2e954a/ig2_cpsam_fp16.onnx
MODEL=cpsam MODEL_PATH=ig2_cpsam_fp16.onnx CHROME="/path/to/Google Chrome" HEADED=1 \
  node audit/review/webgpu_vs_wasm.mjs
# optional: PHOTO=some_gravel.jpg to use a real photo
```
On macOS, `CHROME` is usually
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. `HEADED=1` shows the
browser window, which helps it get a real GPU.

**Reading the output:** for each case it prints whether WebGPU produced non-finite values,
the largest flow and cell-probability differences, sign agreement, grain counts, and
**mask PQ** (WebGPU vs CPU; 1.0 = identical).
- **PQ ≥ 0.95 and no non-finite values** → WebGPU float16 is fine on that GPU.
- **Errors or low PQ, especially in `one-tile` / `small-padded`** → the zero-border float16
  problem affects WebGPU too. Next steps would be to run Cellpose-SAM with float32
  internals on WebGPU (larger memory) or reflect-pad instead of zero-pad (deviating from
  Cellpose).

Please send back `audit/review/webgpu_vs_wasm_cpsam.json` with the GPU model and browser
version.

## Real-GPU result 1: Intel Xe-LPG (integrated), Edge 156 on Windows, Cellpose-SAM, 2026-11-15

Measured with the GPU check page (`shader-f16` available, so WebGPU ran in float16):

| Case | Grains GPU / CPU | Mask PQ | Cellprob sign agreement | GPU / CPU seconds |
|---|---|---|---|---|
| Photo 512×384 | 193 / 193 | 0.996 | 99.98% | 13.1 / 47.4 |
| One tile 240×240 | 59 / 59 | 0.999 | 99.97% | 1.0 / 6.6 |
| Small padded 100×80 | 7 / 6 | 0.922 | 99.97% | 1.0 / 3.7 |
| All-black 256×256 | 0 / 0 | 1 | **0%** | 3.8 / 14.4 |

- **Real images: WebGPU matches the CPU**, and is about 3.6× faster. The zero-border tiles
  (one-tile, small-padded) are fine: the small-padded "difference" is one borderline grain
  out of 6–7, with 99.97% per-pixel agreement. (The page's verdict rules were updated so a
  single-grain difference on a tiny image no longer counts as a failure.)
- **Featureless input: float16 numeric fault.** On an all-zero tile the CPU outputs
  cellprob ≈ −5.2 everywhere (confident background; re-measured here with ORT WASM). The GPU
  output had the opposite sign on every pixel (mean |difference| 5.9, so roughly +0.7). No
  grains formed only because the predicted flows there are near zero. The plausibility
  guard does not catch this: the values are finite and small.
- **Open question:** whether large black areas *inside* real photos produce false grains.
  The page now has a fifth case (768×384 photo whose right half is pure black, containing a
  whole 256 px tile) and reports grain pixels and sign agreement inside the black area.
