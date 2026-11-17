# App integration check: quantized Cellpose-SAM weights (2026-11-17)

The two quantized files were downloaded from the pinned revision
`98e76b1374dc22cfff8193aca71c308f2b4dd3b3`. Their SHA-256 values match the model card:
- `ig2_cpsam_int8_wo_fp32scale.onnx`: `2cda0be5…6bab6f43`
- `ig2_cpsam_fp4_e2m1_lut.onnx`: `d49d8f07…44320c99`

Each file was run through the app's own Cellpose-SAM pipeline (`runCpsamCellposeInference` +
`flowsToMasksBrowser`, `dist/`) in onnxruntime-web 1.31.1, WASM, Node, 4 threads.

Inputs:
- a real gravel photo, K1 site, resized to 504×512 px;
- an all-black 256×256 image.

| Weights | Load | Process memory | Photo time | Grains | Mask PQ vs FP16 | Cellprob sign agreement vs FP16 | All-black mean cellprob |
|---|---|---|---|---|---|---|---|
| FP16 | 18.2 s | 3.1 GB | 189 s | 943 | 1 | — | −5.17 |
| INT8 | 2.2 s | **1.4 GB** | 185 s | 946 | **0.988** | 99.92% | −5.17 |
| FP4 | 5.3 s | 3.2 GB | 187 s | 955 | 0.953 | 99.31% | −5.08 |

**Mask agreement and memory** match the 40-image benchmark in `README.md`, which reported mask PQ vs
FP16 of 0.994 (INT8) and 0.966 (FP4), and lower peak memory for INT8.

**Speed differs from the benchmark.** The benchmark measured INT8 at about 2.2× faster per
tile than FP16. On this 4-thread machine, all three files ran a whole photo in the same
time. So the speed gain depends on the machine (thread count, memory bandwidth). INT8's
dependable advantages are a half-size download, about half the memory, and much faster loading.

**On a WebGPU GPU:** not yet tested. The GPU check page now offers INT8 and FP4.
