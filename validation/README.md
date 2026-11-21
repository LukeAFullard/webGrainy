# Validation

Benchmarks behind the accuracy figures in the main README, with the scripts, notebooks and
results needed to reproduce them. Model weights and datasets are downloaded by the scripts
(they are not stored here).

| Folder | What it checks |
| --- | --- |
| [`heldout/`](heldout/) | Accuracy on the held-out test split of the ImageGrains 2.0 data (40 images, 13 sites) against hand-digitised outlines: webGrainy vs upstream PyTorch ImageGrains, per-image results and paired comparisons. Also the lens-distortion bias model. |
| [`parity/`](parity/README.md) | That webGrainy's ONNX models and Cellpose tiling reproduce upstream Cellpose / ImageGrains outputs. |
| [`k1/`](k1/README.md) | Photo vs field pebble count at the K1 site, and the effect of the field count's size cutoff. |
| [`preprocessing/`](preprocessing/README.md) | Whether optional preprocessing (CLAHE, upscaling, denoising) improves results. |
| [`quantization/`](quantization/README.md) | FP16 vs INT8 / FP4 Cellpose-SAM weights: accuracy, size, speed and memory. |
| [`gpu/`](gpu/) | WebGPU vs CPU (WASM) agreement of the network outputs. |
| [`perf/`](perf/) | Timing of the analysis stages and CPU thread counts. |
| [`interval_coverage/`](interval_coverage/) | Coverage of the site interval by simulation, in every pooling mode and with the two-stage bootstrap (real label masks). |
| [`comparison/`](comparison/README.md) | False-positive rate of the survey/site comparison test on simulated unchanged beds, and its power for a real 20% change (`power.audit.ts`). |
| [`oracle/`](oracle/) | Independent numpy / scipy / scikit-image re-computation of percentiles, Folk & Ward, grain moments, Feret diameters, tiling and homography, compared with the TypeScript implementation. |

Run the numerical oracle:

```bash
npx vitest run --config validation/oracle/vitest.config.ts   # writes validation/oracle/ts_dump.json
pip install numpy scipy scikit-image
python3 -I validation/oracle/oracle.py validation/oracle/ts_dump.json --check   # exit 1 on any mismatch (CI runs this)
```

Scripts that load the built engine (`dist/`) need `npm run build` first.
