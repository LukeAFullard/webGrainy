# Item 1: CP-SAM in a Real Browser — Hardware Block & Code Findings

## Status
**UNVERIFIED (hardware-blocked on this VM)** for live WebGPU `shader-f16` execution, peak memory, 13–16 s/image timing, and `device.lost` runtime behavior.
**VERIFIED (code-level)** for capability-detection and error-handling gaps in `src/modules/`.

---

## 1. Hardware Block on This VM
Probed on this Linux VM (`node v24.22.2`, `python3 3.11.2`):
- `ls -la /dev/dri` → `ls: cannot access '/dev/dri': No such file or directory`
- `which nvidia-smi vulkaninfo lspci` → none found (no GPU / Vulkan / DRI device nodes exposed).
- Because no physical or virtual GPU is present, headless Chromium cannot obtain a WebGPU `GPUAdapter` with the `shader-f16` feature required by `ig2_cpsam_fp16.onnx` (`617,364,567` bytes, SHA-256 `944a114a0cb1a3a215c11affefe7211caac6da2b74895c496d5a7b5a23b6230d`, pinned at HF commit `7773328a544ac050b7820667e68cbfb02a2e954a`).

---

## 2. Code-Level Findings (`src/modules/onnxInference.ts`, `src/modules/modelCache.ts`, `src/modules/pipelineController.ts`)

1. **`hasWebGpuAdapter()` does not check `adapter.features.has('shader-f16')`** (`src/modules/onnxInference.ts:299-309`):
   - Currently:
     ```ts
     return (await gpu.requestAdapter()) != null;
     ```
   - `ig2_cpsam_fp16.onnx` always constructs `new ort.Tensor('float16', ...)` (`src/modules/onnxInference.ts:433, 508`).
   - On browsers/GPUs that expose WebGPU (`requestAdapter() != null`) **without** `shader-f16` (e.g., older iGPUs, some SwiftShader/software adapters, or WebGPU implementations without f16 shader support), `hasWebGpuAdapter()` returns `true` and `createInferenceSession()` (`src/modules/onnxInference.ts:281-291`) attempts `executionProviders: ['webgpu']`. If `InferenceSession.create` succeeds without `shader-f16` or fails only at `session.run()` time, there is no mid-inference fallback to WASM.

2. **No `device.lost` listener or recovery** (`src/modules/onnxInference.ts:281-295, 391-574`):
   - `onnxInference.ts` never requests or inspects the WebGPU `GPUDevice` (`device.lost.then(...)`).
   - During large multi-tile `runCpsamTiledInference()` batches (`batchSize = 16`, `tileSize = 256`, `overlap = 64`), a GPU TDR / OOM `device.lost` event will surface as an unhandled/opaque ORT `session.run()` rejection with no diagnostic distinguishing GPU device loss from model error and no automatic retry/fallback.

3. **No `shader-f16`-unsupported diagnostic or user-facing warning** (`src/modules/pipelineController.ts:1418-1430`):
   - `pipelineController.ts` records `hasWebGPU` via `hasWebGpuAdapter()` and `deviceMemoryGB`, without recording whether `shader-f16` is supported.
   - If `createInferenceSession()` falls back to `['wasm']` silently (`onnxInference.ts:288-294`), running the 617 MB FP16 CP-SAM model on CPU WASM will be orders of magnitude slower than 13–16 s/image and may hit browser WASM memory limits without warning the user beforehand.

4. **Model download & memory peak** (`src/modules/modelCache.ts:25-34, 360-361`):
   - `modelCache.ts:360-361` preallocates a single `Uint8Array(totalBytes)` when `Content-Length` is known, avoiding the 2× chunk-concatenation peak (~1.2 GB) during download. However, IndexedDB write + `ort.InferenceSession.create(bytes)` still hold the 617 MB buffer in JS/WASM/GPU memory simultaneously during first-time initialization.

---

## 3. Verification Script for a Real WebGPU `shader-f16` Host
A ready-to-run Playwright verification script has been written to:
- `audit/followup/verify_cpsam_webgpu.mjs`

Run it on a machine with a WebGPU `shader-f16`-capable GPU (Chrome/Chromium with WebGPU enabled):
```bash
npm run build
node audit/followup/verify_cpsam_webgpu.mjs
```
Optional environment variables:
- `MODEL_PATH=/path/to/ig2_cpsam_fp16.onnx` (otherwise downloads pinned commit `7773328a` into `.cache/` and verifies SHA-256)
- `REFERENCE_TILES_JSON=/path/to/python_ort_reference.json` (compares browser `flows_cellprob` / D50 / grain count against Python ONNX Runtime outputs)
- `CPSAM_TIMEOUT_MS=600000`
