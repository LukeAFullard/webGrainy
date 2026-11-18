#!/usr/bin/env python3
"""
ImageGrains 2.0 Web Preprocessing Benchmark (`audit/preprocessing/`).

Evaluates optional image pre-processing (CLAHE, bilinear upscaling, adaptive
upscaling, gamma/brightness invariance sanity check, and optional mild denoise)
using the exact shipped webGrainy TypeScript pipeline (`dist/` + `flowsToMasksBrowser`
defaults: flowThreshold=0.45, cellprobThreshold=0, minSize=30, maxGrainAreaFraction=0.40).

Usage:
  /tmp/bench_venv/bin/python audit/preprocessing/run_benchmark.py \
      --data-dir /tmp/ig2_bench/data \
      --models-dir /tmp/ig2_bench \
      --out-dir audit/preprocessing \
      --models unet_fp32
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import http.server
import json
import math
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)


def _fmt_dur(seconds: float) -> str:
    if not math.isfinite(seconds) or seconds < 0:
        return "?"
    s = int(round(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h > 0:
        return f"{h}h{m:02d}m"
    if m > 0:
        return f"{m}m{sec:02d}s"
    return f"{sec}s"


import cv2
import numpy as np
import onnxruntime as ort
import pandas as pd
from PIL import Image
from scipy.stats import pearsonr, spearmanr
from skimage.measure import regionprops

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MANIFEST_PATH = REPO_ROOT / "audit" / "followup" / "heldout_manifest.csv"
WORKER_MJS = REPO_ROOT / "audit" / "preprocessing" / "ts_preprocess_worker.mjs"

HF_REPO = "inYourOwnBrowser/imagegrains-2.0-onnx"
HF_REVISION = "98e76b1374dc22cfff8193aca71c308f2b4dd3b3"

MODEL_SPECS = {
    "unet_fp32": {
        "filename": "ig2_unet_fp32.onnx",
        "model_kind": "unet",
        "dtype": "float32",
        "sha256": "5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c",
        "label": "U-Net FP32",
    },
    "cpsam_int8": {
        "filename": "ig2_cpsam_int8_wo_fp32scale.onnx",
        "model_kind": "cpsam",
        "dtype": "float16",
        "sha256": "2cda0be5b81f1d0c0ac36998beb9f741e11833aacd089c4f5cee92488bab6f43",
        "label": "CP-SAM INT8-WO",
    },
    "cpsam_fp16": {
        "filename": "ig2_cpsam_fp16.onnx",
        "model_kind": "cpsam",
        "dtype": "float16",
        "sha256": "944a114a0cb1a3a215c11affefe7211caac6da2b74895c496d5a7b5a23b6230d",
        "label": "CP-SAM FP16 (spot check)",
    },
}

CORE_VARIANTS = ["A", "B", "C", "D", "E"]
SANITY_G_VARIANTS = ["G_gamma07", "G_gamma14", "G_bright_p20", "G_bright_m20"]
DENOISE_H_VARIANTS = ["H_bilateral", "H_median3"]

SIZE_BINS = [
    ("lt10", 0.0, 10.0),
    ("10_20", 10.0, 20.0),
    ("20_40", 20.0, 40.0),
    ("gt40", 40.0, float("inf")),
]

HIGHLIGHT_SITES = ["CT", "NB2", "DV_4", "NZ2", "APF_2"]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_rgb(path: Path) -> np.ndarray:
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is not None:
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return np.array(Image.open(path).convert("RGB"))


def load_gt_mask(path: Path, hw: tuple[int, int]) -> np.ndarray:
    arr = np.load(path) if str(path).endswith(".npy") else cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if arr is None:
        arr = np.array(Image.open(path))
    if arr.ndim == 3:
        if arr.shape[2] >= 3 and np.array_equal(arr[:, :, 0], arr[:, :, 1]) and np.array_equal(arr[:, :, 0], arr[:, :, 2]):
            arr = arr[:, :, 0]
        else:
            rgb = arr[:, :, :3].astype(np.int64)
            arr = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
    if arr.shape[:2] != hw:
        arr = np.array(
            Image.fromarray(arr.astype(np.int32), mode="I").resize((hw[1], hw[0]), Image.Resampling.NEAREST)
        )
    arr_i = arr.astype(np.int64)
    arr_i[arr_i < 0] = 0
    uniq, inv = np.unique(arr_i, return_inverse=True)
    out = inv.reshape(hw).astype(np.int32)
    return out + 1 if (len(uniq) > 0 and uniq[0] != 0) else out


def compute_gt_grain_table(gt_masks: np.ndarray, margin: int = 2) -> list[dict[str, Any]]:
    """Returns per-instance GT geometry in original-photo pixels."""
    H, W = gt_masks.shape
    grains = []
    for prop in regionprops(gt_masks):
        area = float(prop.area)
        if area <= 0:
            continue
        minr, minc, maxr, maxc = prop.bbox
        touches_border = (minr < margin) or (minc < margin) or (maxr > H - margin) or (maxc > W - margin)
        b_axis = float(prop.axis_minor_length) if hasattr(prop, "axis_minor_length") else float(prop.minor_axis_length)
        d_eq = math.sqrt(4.0 * area / math.pi)
        if b_axis > 0 and d_eq > 0:
            grains.append({
                "id": int(prop.label),
                "areaPx": area,
                "bAxisPx": b_axis,
                "dEqPx": d_eq,
                "touchesBorder": bool(touches_border),
            })
    return grains


def area_weighted_percentiles(grains: list[dict], key: str, pcts=(16.0, 50.0, 84.0)) -> dict[str, float]:
    valid = [
        (float(g[key]), float(g["areaPx"]))
        for g in grains
        if not g.get("touchesBorder", g.get("isBorder", False))
        and g.get(key, 0) > 0
        and g.get("areaPx", 0) > 0
    ]
    if not valid:
        return {f"D{int(p)}": float("nan") for p in pcts}
    valid.sort(key=lambda x: x[0])
    vals = np.array([v[0] for v in valid], dtype=np.float64)
    wts = np.array([v[1] for v in valid], dtype=np.float64)
    cdf = (np.cumsum(wts) - 0.5 * wts) / np.sum(wts) * 100.0
    return {f"D{int(p)}": float(np.interp(p, cdf, vals)) for p in pcts}


def working_median_b_axis(working_grains: list[dict]) -> float:
    interior = [float(g["bAxisPx"]) for g in working_grains if not g.get("touchesBorder", False) and g.get("bAxisPx", 0) > 0]
    if not interior:
        interior = [float(g["bAxisPx"]) for g in working_grains if g.get("bAxisPx", 0) > 0]
    return float(np.median(interior)) if interior else float("nan")


def compute_seg_and_size_recall(
    pred_inf: np.ndarray,
    gt_orig: np.ndarray,
    gt_grains: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Resizes `pred_inf` back to `gt_orig.shape` using nearest-neighbor and computes
    PQ, SQ, RQ (=F1@0.5), AP@0.5, AP@0.75, plus GT grain recall (IoU > 0.5) by b-axis class.
    """
    H, W = gt_orig.shape
    if pred_inf.shape != (H, W):
        pred = np.array(
            Image.fromarray(pred_inf.astype(np.int32), mode="I").resize((W, H), Image.Resampling.NEAREST)
        )
    else:
        pred = pred_inf

    pred_ids = np.unique(pred)
    pred_ids = pred_ids[pred_ids > 0]
    ref_ids = np.unique(gt_orig)
    ref_ids = ref_ids[ref_ids > 0]
    np_, nr_ = len(pred_ids), len(ref_ids)

    gt_by_id = {g["id"]: g for g in gt_grains}
    bin_total = {b[0]: 0 for b in SIZE_BINS}
    bin_tp = {b[0]: 0 for b in SIZE_BINS}
    for rid in ref_ids:
        g = gt_by_id.get(int(rid))
        if g is None:
            continue
        b = g["bAxisPx"]
        for name, lo, hi in SIZE_BINS:
            if lo <= b < hi:
                bin_total[name] += 1
                break

    if np_ == 0 and nr_ == 0:
        out = {"pq": 1.0, "sq": 1.0, "rq": 1.0, "f1_50": 1.0, "ap50": 1.0, "ap75": 1.0}
        for name, _, _ in SIZE_BINS:
            out[f"recall_{name}"] = float("nan")
            out[f"gt_n_{name}"] = 0
            out[f"gt_tp_{name}"] = 0
        return out

    if np_ == 0 or nr_ == 0:
        out = {"pq": 0.0, "sq": 0.0, "rq": 0.0, "f1_50": 0.0, "ap50": 0.0, "ap75": 0.0}
        for name, _, _ in SIZE_BINS:
            n_tot = bin_total[name]
            out[f"recall_{name}"] = 0.0 if n_tot > 0 else float("nan")
            out[f"gt_n_{name}"] = n_tot
            out[f"gt_tp_{name}"] = 0
        return out

    p_areas = dict(zip(*np.unique(pred[pred > 0], return_counts=True)))
    r_areas = dict(zip(*np.unique(gt_orig[gt_orig > 0], return_counts=True)))
    mask = (pred > 0) & (gt_orig > 0)
    cand50 = []
    if np.any(mask):
        pairs = pred[mask].astype(np.int64) * 1_000_000 + gt_orig[mask].astype(np.int64)
        uniq_pairs, counts = np.unique(pairs, return_counts=True)
        for code, inter in zip(uniq_pairs, counts):
            pi, ri = int(code // 1_000_000), int(code % 1_000_000)
            iou = float(inter) / float(int(p_areas[pi]) + int(r_areas[ri]) - int(inter))
            if iou > 0.5:
                cand50.append((iou, pi, ri))
    cand50.sort(reverse=True)
    tp50, tp75, iou_sum50 = 0, 0, 0.0
    mp, mr = set(), set()
    for iou, pi, ri in cand50:
        if pi not in mp and ri not in mr:
            mp.add(pi)
            mr.add(ri)
            tp50 += 1
            iou_sum50 += iou
            if iou >= 0.75:
                tp75 += 1
            g = gt_by_id.get(ri)
            if g is not None:
                b = g["bAxisPx"]
                for name, lo, hi in SIZE_BINS:
                    if lo <= b < hi:
                        bin_tp[name] += 1
                        break

    fp50, fn50 = np_ - tp50, nr_ - tp50
    sq = float(iou_sum50 / tp50) if tp50 > 0 else 0.0
    rq = float(tp50 / (tp50 + 0.5 * fp50 + 0.5 * fn50))
    pq = float(iou_sum50 / (tp50 + 0.5 * fp50 + 0.5 * fn50))
    ap50 = float(tp50 / (tp50 + fp50 + fn50))
    ap75 = float(tp75 / (tp75 + (np_ - tp75) + (nr_ - tp75)))
    out = {"pq": pq, "sq": sq, "rq": rq, "f1_50": rq, "ap50": ap50, "ap75": ap75}
    for name, _, _ in SIZE_BINS:
        n_tot = bin_total[name]
        tp_b = bin_tp[name]
        out[f"recall_{name}"] = float(tp_b / n_tot) if n_tot > 0 else float("nan")
        out[f"gt_n_{name}"] = int(n_tot)
        out[f"gt_tp_{name}"] = int(tp_b)
    return out


def prepare_working_dimensions(orig_w: int, orig_h: int) -> tuple[int, int]:
    md = max(orig_w, orig_h)
    if md <= 1024:
        ts = 1.0
    elif md <= 2048:
        ts = 0.5
    elif md <= 4096:
        ts = 0.25
    else:
        ts = 1024.0 / md
    if ts == 1.0:
        return orig_w, orig_h
    return max(1, round(orig_w * ts)), max(1, round(orig_h * ts))


def immerkaer_noise_sigma(rgb: np.ndarray) -> float:
    """Fast 3x3 Immerkaer Laplacian estimator for high-frequency pixel noise sigma."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float64)
    H, W = gray.shape
    M = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], dtype=np.float64)
    resp = cv2.filter2D(gray, cv2.CV_64F, M)
    sigma = float(np.sum(np.abs(resp)) * math.sqrt(0.5 * math.pi) / (6.0 * max(1, (W - 2) * (H - 2))))
    return sigma


class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def start_ort_bridge(sess: ort.InferenceSession):
    lock = threading.Lock()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                body = self.rfile.read(int(self.headers["Content-Length"]))
                dt = np.float16 if self.headers["x-dtype"] == "float16" else np.float32
                dims = [int(x) for x in self.headers["x-dims"].split(",")]
                arr = np.frombuffer(body, dtype=dt).reshape(dims).copy()
                with lock:
                    out = sess.run(["flows_cellprob"], {"image": arr})[0]
                payload = np.ascontiguousarray(out, dtype="<f4").tobytes()
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except Exception as e:
                err_b = repr(e).encode("utf-8", errors="replace")
                self.send_response(500)
                self.send_header("Content-Length", str(len(err_b)))
                self.end_headers()
                self.wfile.write(err_b)

    srv = _ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def check_5tile_parity(
    model_key: str,
    model_path: Path,
    test_rows: list[dict],
    data_dir: Path,
    wasm_threads: int,
    tol: float = 0.05,
) -> dict[str, Any]:
    spec = MODEL_SPECS[model_key]
    kind = spec["model_kind"]
    seen = set()
    pick = []
    for r in test_rows:
        if r["site"] not in seen:
            seen.add(r["site"])
            pick.append(r)
        if len(pick) == 5:
            break

    def make_tile(rgb: np.ndarray) -> np.ndarray:
        if kind == "unet":
            g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
            p1, p99 = np.percentile(g, [1, 99])
            gn = (g - p1) / (p99 - p1 + 1e-8)
            tile = cv2.resize(gn, (224, 224), interpolation=cv2.INTER_LINEAR)
            arr = np.zeros((1, 2, 224, 224), dtype=np.float32)
            arr[0, 0] = tile
            return arr
        else:
            arr = rgb.astype(np.float32)
            chw = np.zeros((1, 3, 256, 256), dtype=np.float32)
            for c in range(3):
                ch = arr[:, :, c]
                p1, p99 = np.percentile(ch, [1, 99])
                chw[0, c] = cv2.resize((ch - p1) / (p99 - p1 + 1e-8), (256, 256), interpolation=cv2.INTER_LINEAR)
            return chw.astype(np.float16)

    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    tile_mjs = """
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ort = await import(pathToFileURL(path.join(cfg.repoDir, "node_modules/onnxruntime-web/dist/ort.node.min.mjs")).href);
ort.env.wasm.numThreads = Number(cfg.numThreads);
ort.env.wasm.simd = true;
const tLoad0 = performance.now();
const s = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(cfg.modelPath)), { executionProviders: ["wasm"] });
const loadMs = performance.now() - tLoad0;
const times = [];
for (const item of cfg.tiles) {
  const buf = fs.readFileSync(item.inPath);
  const tensor = cfg.dtype === "float32"
    ? new ort.Tensor("float32", new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), item.dims)
    : new ort.Tensor("float16", new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2), item.dims);
  const t0 = performance.now();
  const out = await s.run({ image: tensor });
  times.push(performance.now() - t0);
  const d = out.flows_cellprob.data;
  let f32;
  if (d instanceof Float32Array) f32 = d;
  else { f32 = new Float32Array(d.length); for (let i = 0; i < d.length; i++) f32[i] = Number(d[i]); }
  fs.writeFileSync(item.outPath, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
}
console.log(JSON.stringify({ loadMs, times }));
await s.release?.();
process.exit(0);
"""
    with tempfile.TemporaryDirectory() as td:
        td_p = Path(td)
        tiles_cfg = []
        py_outs = {}
        py_times = []
        for i, r in enumerate(pick):
            rgb = load_rgb(data_dir / r["image_relpath"])
            x = make_tile(rgb)
            t0 = time.perf_counter()
            py_outs[i] = sess.run(["flows_cellprob"], {"image": x})[0].astype(np.float32).ravel()
            py_times.append((time.perf_counter() - t0) * 1000.0)
            ip = td_p / f"in_{i}.bin"
            x.tofile(ip)
            op = td_p / f"out_{i}.f32"
            tiles_cfg.append({"inPath": str(ip), "outPath": str(op), "dims": list(x.shape)})
        del sess
        import gc
        gc.collect()
        cfg_p = td_p / "cfg.json"
        cfg_p.write_text(json.dumps({
            "repoDir": str(REPO_ROOT),
            "modelPath": str(model_path),
            "dtype": spec["dtype"],
            "numThreads": wasm_threads,
            "tiles": tiles_cfg,
        }))
        js_p = td_p / "parity5.mjs"
        js_p.write_text(tile_mjs)
        pr = subprocess.run(["node", str(js_p), str(cfg_p)], capture_output=True, text=True, check=True)
        timing_info = json.loads(pr.stdout.strip().splitlines()[-1])
        per_tile_max, per_tile_mean = [], []
        for i, tc in enumerate(tiles_cfg):
            w = np.fromfile(tc["outPath"], dtype=np.float32)
            diff = np.abs(w - py_outs[i])
            per_tile_max.append(float(diff.max()))
            per_tile_mean.append(float(diff.mean()))
    overall_max = float(max(per_tile_max))
    return {
        "model_key": model_key,
        "n_tiles": len(pick),
        "sites": [r["site"] for r in pick],
        "overall_max_abs": overall_max,
        "overall_mean_abs": float(np.mean(per_tile_mean)),
        "per_tile_max_abs": per_tile_max,
        "tol": tol,
        "bridge_allowed": bool(overall_max <= tol),
        "wasm_threads": wasm_threads,
        "wasm_load_ms": float(timing_info["loadMs"]),
        "wasm_tile_ms_median": float(np.median(timing_info["times"])),
        "wasm_tile_ms_mean": float(np.mean(timing_info["times"])),
        "py_cpu_tile_ms_median": float(np.median(py_times)),
    }


class PersistentTSWorker:
    def __init__(self, model_kind: str, model_path: Path | None, bridge_url: str | None, wasm_threads: int, log_path: Path):
        self.td = tempfile.TemporaryDirectory()
        cfg_p = Path(self.td.name) / "wcfg.json"
        cfg_p.write_text(json.dumps({
            "repoDir": str(REPO_ROOT),
            "modelKind": model_kind,
            "modelPath": str(model_path) if model_path else None,
            "bridgeUrl": bridge_url,
            "numThreads": wasm_threads,
        }))
        self.log_f = open(log_path, "w", encoding="utf-8")
        self.proc = subprocess.Popen(
            ["node", str(WORKER_MJS), str(cfg_p)],
            cwd=str(REPO_ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log_f,
            text=True,
            bufsize=1,
        )
        while True:
            line = self.proc.stdout.readline()
            if line == "":
                raise RuntimeError(f"Worker died before READY (rc={self.proc.poll()}). Check {log_path}")
            s = line.strip()
            if s.startswith("__WORKER_READY__:"):
                self.ready_info = json.loads(s[len("__WORKER_READY__:"):])
                break

    def run_job(self, job: dict[str, Any], progress_label: str | None = None) -> dict[str, Any]:
        self.proc.stdin.write(json.dumps(job) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if line == "":
                raise RuntimeError(f"Worker closed stdout mid-job (rc={self.proc.poll()})")
            s = line.strip()
            if s.startswith("__WORKER_PROG__:"):
                if progress_label:
                    prog = json.loads(s[len("__WORKER_PROG__:"):])
                    done = int(prog.get("completedTiles", 0))
                    tot = int(prog.get("totalTiles", 0))
                    pct = int(prog.get("percent", 0))
                    el_s = float(prog.get("elapsedMs", 0.0)) / 1000.0
                    per_t = el_s / max(1, done)
                    eta_s = per_t * max(0, tot - done)
                    print(
                        f"      {progress_label} | tile {done}/{tot} ({pct}%, {per_t:.1f}s/tile, elapsed {_fmt_dur(el_s)}, img ETA ~{_fmt_dur(eta_s)})",
                        flush=True,
                    )
                continue
            if s.startswith("__WORKER_RESP__:"):
                resp = json.loads(s[len("__WORKER_RESP__:"):])
                if not resp.get("ok"):
                    raise RuntimeError(f"Worker job error: {resp.get('error')}")
                return resp

    def close(self):
        try:
            self.proc.stdin.write(json.dumps({"quit": True}) + "\n")
            self.proc.stdin.flush()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        self.log_f.close()
        self.td.cleanup()


def run_image_variant(
    worker: PersistentTSWorker,
    row: dict[str, str],
    variant: str,
    data_dir: Path,
    mask_out_path: Path | None = None,
    guard: float = 0.40,
    progress_label: str | None = None,
) -> dict[str, Any]:
    rgb = load_rgb(data_dir / row["image_relpath"])
    H, W = rgb.shape[:2]
    rgba = np.empty((H, W, 4), dtype=np.uint8)
    rgba[:, :, :3] = rgb
    rgba[:, :, 3] = 255

    with tempfile.TemporaryDirectory() as td:
        td_p = Path(td)
        mask_p = mask_out_path if mask_out_path else (td_p / "pred_mask.i32")
        job: dict[str, Any] = {
            "origWidth": int(W),
            "origHeight": int(H),
            "variant": variant,
            "guard": float(guard),
            "outMaskPath": str(mask_p),
            "reportProgress": bool(progress_label),
        }
        if variant == "H_bilateral":
            # Prepare working image to <= 1024 px matching prepareWorkingImage('auto')
            w0, h0 = prepare_working_dimensions(W, H)
            work_rgb = rgb if (w0 == W and h0 == H) else cv2.resize(rgb, (w0, h0), interpolation=cv2.INTER_LINEAR)
            filt_rgb = cv2.bilateralFilter(work_rgb, d=5, sigmaColor=25, sigmaSpace=25)
            pre_rgba = np.empty((h0, w0, 4), dtype=np.uint8)
            pre_rgba[:, :, :3] = filt_rgb
            pre_rgba[:, :, 3] = 255
            pre_p = td_p / "pre_work.rgba"
            pre_rgba.tofile(pre_p)
            job["preWorkingRgbaPath"] = str(pre_p)
            job["preWorkingWidth"] = int(w0)
            job["preWorkingHeight"] = int(h0)
            job["workWidth"] = int(w0)
            job["workHeight"] = int(h0)
        else:
            raw_p = td_p / "orig.rgba"
            rgba.tofile(raw_p)
            job["origRgbaPath"] = str(raw_p)

        resp = worker.run_job(job, progress_label=progress_label)
        inf_h, inf_w = int(resp["infHeight"]), int(resp["infWidth"])
        pred_inf = np.fromfile(mask_p, dtype="<i4").reshape((inf_h, inf_w)).copy()

    return {"resp": resp, "pred_inf": pred_inf, "orig_hw": (H, W)}


def evaluate_prediction_vs_gt(
    row: dict[str, str],
    run_out: dict[str, Any],
    gt_cache: dict[str, tuple[np.ndarray, list[dict], dict[str, float]]],
    data_dir: Path,
) -> dict[str, Any]:
    uid = row["uid"]
    H, W = run_out["orig_hw"]
    if uid not in gt_cache:
        gt_m = load_gt_mask(data_dir / row["mask_relpath"], (H, W))
        gt_g = compute_gt_grain_table(gt_m)
        gt_b = area_weighted_percentiles(gt_g, "bAxisPx")
        gt_cache[uid] = (gt_m, gt_g, gt_b)
    gt_m, gt_g, gt_b = gt_cache[uid]

    resp = run_out["resp"]
    pred_inf = run_out["pred_inf"]
    orig_grains = resp["origGrains"]
    work_grains = resp["workingGrains"]
    pred_b = area_weighted_percentiles(orig_grains, "bAxisPx")
    pred_d = area_weighted_percentiles(orig_grains, "dEqPx")
    seg = compute_seg_and_size_recall(pred_inf, gt_m, gt_g)
    n_pred_int = sum(1 for g in orig_grains if not g.get("touchesBorder", False))
    n_gt_int = sum(1 for g in gt_g if not g.get("touchesBorder", False))

    return {
        "uid": uid,
        "site": row["site"],
        "official_split": row["official_split"],
        "orig_h": H,
        "orig_w": W,
        "work_h": int(resp["workHeight"]),
        "work_w": int(resp["workWidth"]),
        "inf_h": int(resp["infHeight"]),
        "inf_w": int(resp["infWidth"]),
        "total_scale_factor": float(resp["totalScaleFactor"]),
        "total_tiles": int(resp["totalTiles"]),
        "preprocess_ms": float(resp["preprocessMs"]),
        "infer_ms": float(resp["inferMs"]),
        "postprocess_ms": float(resp["postprocessMs"]),
        "working_med_b_px": working_median_b_axis(work_grains),
        "n_gt": int(n_gt_int),
        "n_pred": int(n_pred_int),
        "gt_b_D16": gt_b["D16"],
        "gt_b_D50": gt_b["D50"],
        "gt_b_D84": gt_b["D84"],
        "pred_b_D16": pred_b["D16"],
        "pred_b_D50": pred_b["D50"],
        "pred_b_D84": pred_b["D84"],
        "pred_d_D50": pred_d["D50"],
        "pq_vs_gt": seg["pq"],
        "sq_vs_gt": seg["sq"],
        "rq_vs_gt": seg["rq"],
        "f1_50_vs_gt": seg["f1_50"],
        "ap50_vs_gt": seg["ap50"],
        "ap75_vs_gt": seg["ap75"],
        "recall_lt10": seg["recall_lt10"],
        "recall_10_20": seg["recall_10_20"],
        "recall_20_40": seg["recall_20_40"],
        "recall_gt40": seg["recall_gt40"],
        "gt_n_lt10": seg["gt_n_lt10"],
        "gt_tp_lt10": seg["gt_tp_lt10"],
        "gt_n_10_20": seg["gt_n_10_20"],
        "gt_tp_10_20": seg["gt_tp_10_20"],
        "gt_n_20_40": seg["gt_n_20_40"],
        "gt_tp_20_40": seg["gt_tp_20_40"],
        "gt_n_gt40": seg["gt_n_gt40"],
        "gt_tp_gt40": seg["gt_tp_gt40"],
    }


def boot_ci(arr: np.ndarray, fn, n_boot: int = 10000, seed: int = 42) -> list[float]:
    arr = np.asarray(arr, dtype=np.float64)
    arr = arr[np.isfinite(arr)]
    if len(arr) == 0:
        return [float("nan"), float("nan")]
    if len(arr) == 1:
        v = float(fn(arr))
        return [v, v]
    rng = np.random.default_rng(seed)
    boots = np.array([fn(arr[rng.integers(0, len(arr), size=len(arr))]) for _ in range(n_boot)], dtype=np.float64)
    return [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))]


def summarize_variant(sub: pd.DataFrame, wasm_tile_ms_median: float | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"n_images": int(len(sub))}
    for col in ("pq_vs_gt", "f1_50_vs_gt", "ap50_vs_gt", "total_tiles", "infer_ms", "preprocess_ms", "postprocess_ms"):
        arr = sub[col].to_numpy(dtype=np.float64)
        arr = arr[np.isfinite(arr)]
        if len(arr):
            out[col] = {
                "mean": float(np.mean(arr)),
                "median": float(np.median(arr)),
                "sum": float(np.sum(arr)),
                "ci95_mean": boot_ci(arr, np.mean),
            }
    if wasm_tile_ms_median is not None and "total_tiles" in out:
        tot_tiles = out["total_tiles"]["sum"]
        out["est_wasm_wall_s_total"] = float(tot_tiles * wasm_tile_ms_median / 1000.0)
        out["est_wasm_wall_s_mean_per_img"] = float(out["total_tiles"]["mean"] * wasm_tile_ms_median / 1000.0)
    # Pooled micro recall and mean per-image recall by size bin
    size_recall = {}
    for name, _, _ in SIZE_BINS:
        n_tot = int(sub[f"gt_n_{name}"].sum())
        tp_tot = int(sub[f"gt_tp_{name}"].sum())
        per_img = sub[f"recall_{name}"].to_numpy(dtype=np.float64)
        per_img = per_img[np.isfinite(per_img)]
        size_recall[name] = {
            "gt_grains": n_tot,
            "matched_tp": tp_tot,
            "pooled_recall": float(tp_tot / n_tot) if n_tot > 0 else float("nan"),
            "mean_img_recall": float(np.mean(per_img)) if len(per_img) > 0 else float("nan"),
            "n_imgs_with_bin": int(len(per_img)),
        }
    out["size_class_recall"] = size_recall

    grain_errs = {}
    for pct in ("D16", "D50", "D84"):
        rcol, pcol = f"gt_b_{pct}", f"pred_b_{pct}"
        valid = sub[sub[rcol].notna() & sub[pcol].notna() & (sub[rcol] > 0) & (sub[pcol] > 0)]
        if len(valid) == 0:
            grain_errs[pct] = {"n": 0}
            continue
        ref = valid[rcol].to_numpy(dtype=np.float64)
        pred = valid[pcol].to_numpy(dtype=np.float64)
        sre = 100.0 * (pred - ref) / ref
        ape = np.abs(sre)
        grain_errs[pct] = {
            "n": int(len(valid)),
            "mean_ape_pct": float(np.mean(ape)),
            "mean_ape_ci95": boot_ci(ape, np.mean),
            "median_ape_pct": float(np.median(ape)),
            "median_ape_ci95": boot_ci(ape, np.median),
            "mean_bias_pct": float(np.mean(sre)),
            "median_bias_pct": float(np.median(sre)),
        }
    out["vs_gt"] = grain_errs
    return out


def paired_vs_baseline(df: pd.DataFrame, model_key: str, var_b: str, var_a: str = "A", n_boot: int = 10000) -> dict[str, Any]:
    a = df[(df["model_key"] == model_key) & (df["variant"] == var_a)].set_index("uid")
    b = df[(df["model_key"] == model_key) & (df["variant"] == var_b)].set_index("uid")
    common = sorted(set(a.index) & set(b.index))
    a = a.loc[common]
    b = b.loc[common]

    ra = a["gt_b_D50"].to_numpy(dtype=np.float64)
    pa = a["pred_b_D50"].to_numpy(dtype=np.float64)
    pb = b["pred_b_D50"].to_numpy(dtype=np.float64)
    ape_a = np.where((ra > 0) & (pa > 0), 100.0 * np.abs(pa - ra) / ra, np.nan)
    ape_b = np.where((ra > 0) & (pb > 0), 100.0 * np.abs(pb - ra) / ra, np.nan)
    d_ape = ape_b - ape_a  # negative => B has lower error than A (B better)
    d_ape_v = d_ape[np.isfinite(d_ape)]

    d_pq = b["pq_vs_gt"].to_numpy(dtype=np.float64) - a["pq_vs_gt"].to_numpy(dtype=np.float64)
    d_pq_v = d_pq[np.isfinite(d_pq)]

    rng = np.random.default_rng(42)
    if len(d_ape_v) > 0:
        boots_ape = np.array([rng.choice(d_ape_v, d_ape_v.size).mean() for _ in range(n_boot)])
        ape_ci = [float(np.percentile(boots_ape, 2.5)), float(np.percentile(boots_ape, 97.5))]
        wins_ape = int((d_ape_v < 0).sum())
        losses_ape = int((d_ape_v > 0).sum())
        n_nz = wins_ape + losses_ape
        k = min(wins_ape, losses_ape)
        p_ape = min(1.0, 2.0 * sum(math.comb(n_nz, i) for i in range(k + 1)) / (2 ** n_nz)) if n_nz > 0 else 1.0
    else:
        ape_ci, wins_ape, losses_ape, p_ape = [float("nan"), float("nan")], 0, 0, 1.0

    if len(d_pq_v) > 0:
        boots_pq = np.array([rng.choice(d_pq_v, d_pq_v.size).mean() for _ in range(n_boot)])
        pq_ci = [float(np.percentile(boots_pq, 2.5)), float(np.percentile(boots_pq, 97.5))]
        wins_pq = int((d_pq_v > 0).sum())
        losses_pq = int((d_pq_v < 0).sum())
        n_nz_pq = wins_pq + losses_pq
        k_pq = min(wins_pq, losses_pq)
        p_pq = min(1.0, 2.0 * sum(math.comb(n_nz_pq, i) for i in range(k_pq + 1)) / (2 ** n_nz_pq)) if n_nz_pq > 0 else 1.0
    else:
        pq_ci, wins_pq, losses_pq, p_pq = [float("nan"), float("nan")], 0, 0, 1.0

    # Per-site median D50 APE diff (B - A)
    per_site = {}
    worst_site = None
    worst_site_delta = -float("inf")
    for site in sorted(a["site"].unique()):
        sa = a[a["site"] == site]
        sb = b[b["site"] == site]
        sra = sa["gt_b_D50"].to_numpy(dtype=np.float64)
        spa = sa["pred_b_D50"].to_numpy(dtype=np.float64)
        spb = sb["pred_b_D50"].to_numpy(dtype=np.float64)
        va = np.abs(spa - sra) / np.where(sra > 0, sra, np.nan) * 100.0
        vb = np.abs(spb - sra) / np.where(sra > 0, sra, np.nan) * 100.0
        med_a = float(np.nanmedian(va)) if np.any(np.isfinite(va)) else float("nan")
        med_b = float(np.nanmedian(vb)) if np.any(np.isfinite(vb)) else float("nan")
        delta = med_b - med_a
        pq_a = float(np.nanmean(sa["pq_vs_gt"]))
        pq_b = float(np.nanmean(sb["pq_vs_gt"]))
        per_site[site] = {
            "n": int(len(sa)),
            "pq_A": pq_a,
            "pq_var": pq_b,
            "dPQ": pq_b - pq_a,
            "med_d50_ape_A": med_a,
            "med_d50_ape_var": med_b,
            "dMed_d50_ape_pp": delta,
        }
        if math.isfinite(delta) and delta > worst_site_delta:
            worst_site_delta = delta
            worst_site = site

    # Decision rule evaluation
    cond1_d50 = bool(math.isfinite(ape_ci[1]) and ape_ci[1] < 0.0)
    cond1_pq = bool(math.isfinite(pq_ci[0]) and np.mean(d_pq_v) >= 0.01 and pq_ci[0] > 0.0)
    cond1 = cond1_d50 or cond1_pq
    cond2 = bool(worst_site_delta <= 2.0)

    return {
        "model_key": model_key,
        "variant": var_b,
        "vs": var_a,
        "n": len(common),
        "mean_dAPE_pp": float(np.mean(d_ape_v)) if len(d_ape_v) else float("nan"),
        "dAPE_ci95_pp": ape_ci,
        "d50_wins": wins_ape,
        "d50_losses": losses_ape,
        "d50_ties": int(len(d_ape_v) - wins_ape - losses_ape),
        "d50_sign_test_p": float(p_ape),
        "mean_dPQ": float(np.mean(d_pq_v)) if len(d_pq_v) else float("nan"),
        "dPQ_ci95": pq_ci,
        "pq_wins": wins_pq,
        "pq_losses": losses_pq,
        "pq_ties": int(len(d_pq_v) - wins_pq - losses_pq),
        "pq_sign_test_p": float(p_pq),
        "worst_site": worst_site,
        "worst_site_dMed_d50_ape_pp": float(worst_site_delta),
        "per_site": per_site,
        "decision_rule": {
            "pass_cond1_d50_ci_lt_0": cond1_d50,
            "pass_cond1_pq_ge_001_ci_gt_0": cond1_pq,
            "pass_cond1": cond1,
            "pass_cond2_no_site_worse_gt_2pp": cond2,
            "pass_default": bool(cond1 and cond2),
        },
    }


def select_stratified_rows(rows: list[dict], target_n: int, priority_sites: list[str] | None = None, seed: int = 42) -> list[dict]:
    """Deterministically picks up to `target_n` rows spread evenly across sites."""
    by_site: dict[str, list[dict]] = defaultdict(list)
    for r in sorted(rows, key=lambda x: x["uid"]):
        by_site[r["site"]].append(r)
    picked = []
    seen = set()
    if priority_sites:
        for s in priority_sites:
            if s in by_site and by_site[s]:
                r = by_site[s][0]
                if r["uid"] not in seen:
                    seen.add(r["uid"])
                    picked.append(r)
    site_order = sorted(by_site.keys())
    idx = 0
    while len(picked) < target_n and idx < 50:
        progressed = False
        for s in site_order:
            if len(picked) >= target_n:
                break
            if idx < len(by_site[s]):
                r = by_site[s][idx]
                if r["uid"] not in seen:
                    seen.add(r["uid"])
                    picked.append(r)
                    progressed = True
        if not progressed:
            break
        idx += 1
    return picked[:target_n]


def select_noisiest_rows(rows: list[dict], data_dir: Path, n_top: int = 10) -> tuple[list[dict], list[dict]]:
    """Ranks rows by high-frequency Immerkaer noise sigma on the working image (`auto` <=1024 px)."""
    scored = []
    for r in rows:
        rgb = load_rgb(data_dir / r["image_relpath"])
        H, W = rgb.shape[:2]
        w0, h0 = prepare_working_dimensions(W, H)
        work_rgb = rgb if (w0 == W and h0 == H) else cv2.resize(rgb, (w0, h0), interpolation=cv2.INTER_LINEAR)
        sig = immerkaer_noise_sigma(work_rgb)
        scored.append({"uid": r["uid"], "site": r["site"], "noise_sigma": float(sig), "row": r})
    scored.sort(key=lambda x: (-x["noise_sigma"], x["uid"]))
    top = [x["row"] for x in scored[:n_top]]
    meta = [{"uid": x["uid"], "site": x["site"], "noise_sigma": x["noise_sigma"]} for x in scored]
    return top, meta


def choose_adaptive_threshold_on_train(
    worker: PersistentTSWorker,
    train_rows: list[dict],
    data_dir: Path,
    cache_dir: Path,
    model_key: str,
) -> dict[str, Any]:
    """
    Runs A (baseline), D (1.5x), E (2.0x) on `official_split == 'train'` (strictly separate
    from the 40 test images) and chooses threshold T on baseline `working_med_b_px` + upscale
    factor (1.5x vs 2.0x) maximizing mean PQ_gt gain subject to no train site losing > 1.5 pp D50 APE.
    """
    gt_cache: dict[str, Any] = {}
    records: dict[str, dict[str, dict]] = {"A": {}, "D": {}, "E": {}}
    cache_csv = cache_dir / f"train_T_eval_{model_key}.csv"
    if cache_csv.exists():
        df_c = pd.read_csv(cache_csv)
        for _, row in df_c.iterrows():
            records[str(row["variant"])][str(row["uid"])] = row.to_dict()

    need_write = False
    for v in ("A", "D", "E"):
        n_cached = sum(1 for r in train_rows if r["uid"] in records[v])
        print(f"    [train/{model_key}/{v}] cached={n_cached}/{len(train_rows)}, remaining={len(train_rows) - n_cached}", flush=True)
        for idx, r in enumerate(train_rows, 1):
            uid = r["uid"]
            if uid in records[v]:
                continue
            plabel = f"[train/{model_key}/{v} {idx}/{len(train_rows)}] {uid}"
            out = run_image_variant(worker, r, v, data_dir, progress_label=plabel)
            rec = evaluate_prediction_vs_gt(r, out, gt_cache, data_dir)
            rec["model_key"] = model_key
            rec["variant"] = v
            records[v][uid] = rec
            need_write = True
            print(
                f"    [train/{model_key}/{v} {idx}/{len(train_rows)}] {uid}: PQ={rec['pq_vs_gt']:.3f}, "
                f"work_med_b={rec['working_med_b_px']:.1f}, tiles={rec['total_tiles']}, infer={_fmt_dur(rec['infer_ms']/1000.0)}",
                flush=True,
            )
            if idx % 5 == 0 or "cpsam" in model_key:
                all_recs = [records[vv][uu] for vv in ("A", "D", "E") for uu in sorted(records[vv].keys())]
                pd.DataFrame(all_recs).to_csv(cache_csv, index=False)
                need_write = False
        if need_write:
            all_recs = [records[vv][uu] for vv in ("A", "D", "E") for uu in sorted(records[vv].keys())]
            pd.DataFrame(all_recs).to_csv(cache_csv, index=False)
            need_write = False

    df_a = pd.DataFrame([records["A"][r["uid"]] for r in train_rows]).set_index("uid")
    df_d = pd.DataFrame([records["D"][r["uid"]] for r in train_rows]).set_index("uid")
    df_e = pd.DataFrame([records["E"][r["uid"]] for r in train_rows]).set_index("uid")

    med_b_vals = df_a["working_med_b_px"].to_numpy(dtype=np.float64)
    cand_T = sorted({float(t) for t in [6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 25, 30]})
    sweep = []
    best = None

    def eval_candidate(up_var: str, df_up: pd.DataFrame, T: float) -> dict[str, Any]:
        trig = df_a["working_med_b_px"] < T
        n_trig = int(trig.sum())
        pq_base = df_a["pq_vs_gt"].to_numpy(dtype=np.float64)
        pq_mix = np.where(trig, df_up["pq_vs_gt"], df_a["pq_vs_gt"])
        ra = df_a["gt_b_D50"].to_numpy(dtype=np.float64)
        pa = df_a["pred_b_D50"].to_numpy(dtype=np.float64)
        pmix = np.where(trig, df_up["pred_b_D50"], df_a["pred_b_D50"])
        ape_base = np.abs(pa - ra) / np.where(ra > 0, ra, np.nan) * 100.0
        ape_mix = np.abs(pmix - ra) / np.where(ra > 0, ra, np.nan) * 100.0
        mean_dpq = float(np.nanmean(pq_mix - pq_base))
        mean_dape = float(np.nanmean(ape_mix - ape_base))
        # Check worst train site median D50 APE delta
        worst_delta = -float("inf")
        for site in df_a["site"].unique():
            m = (df_a["site"] == site).to_numpy()
            s_a = np.nanmedian(ape_base[m]) if np.any(np.isfinite(ape_base[m])) else float("nan")
            s_m = np.nanmedian(ape_mix[m]) if np.any(np.isfinite(ape_mix[m])) else float("nan")
            if math.isfinite(s_a) and math.isfinite(s_m):
                worst_delta = max(worst_delta, float(s_m - s_a))
        tile_mult = float((df_a["total_tiles"].sum() + df_up.loc[trig, "total_tiles"].sum()) / max(1, df_a["total_tiles"].sum()))
        return {
            "upscale_variant": up_var,
            "T_px": float(T),
            "n_train": int(len(df_a)),
            "n_triggered": n_trig,
            "frac_triggered": float(n_trig / max(1, len(df_a))),
            "mean_dPQ_train": mean_dpq,
            "mean_dAPE_train_pp": mean_dape,
            "worst_train_site_dMed_APE_pp": float(worst_delta) if worst_delta > -float("inf") else 0.0,
            "tile_cost_mult": tile_mult,
            "site_safe": bool(worst_delta <= 1.5),
        }

    for up_var, df_up in (("D", df_d), ("E", df_e)):
        for T in cand_T:
            res = eval_candidate(up_var, df_up, T)
            sweep.append(res)
            # Prefer highest PQ gain among site-safe rules; tie-break lower D50 APE then lower tile cost (1.5x before 2.0x)
            if res["site_safe"] and res["n_triggered"] > 0:
                score = (res["mean_dPQ_train"], -res["mean_dAPE_train_pp"], -res["tile_cost_mult"])
                if best is None or score > best[0]:
                    best = (score, res)

    if best is None:
        # Fallback if no T improved PQ safely
        chosen = eval_candidate("D", df_d, 12.0)
    else:
        chosen = best[1]

    return {
        "n_train_evaluated": int(len(train_rows)),
        "train_working_med_b_percentiles": {
            f"p{p}": float(np.nanpercentile(med_b_vals, p)) for p in (5, 10, 25, 50, 75, 90)
        },
        "chosen": chosen,
        "sweep": sweep,
    }


def measure_wasm_wall_times(
    model_key: str,
    model_path: Path,
    rows_sample: list[dict],
    variants: list[str],
    data_dir: Path,
    wasm_threads: int,
    log_dir: Path,
) -> dict[str, Any]:
    """Runs native ORT-Web WASM on a sample of images per variant to record true WASM ms/tile and load time."""
    spec = MODEL_SPECS[model_key]
    worker = PersistentTSWorker(
        spec["model_kind"],
        model_path,
        None,
        wasm_threads,
        log_dir / f"wasm_timing_{model_key}.stderr.log",
    )
    out_stats: dict[str, Any] = {
        "wasm_threads": wasm_threads,
        "load_ms": float(worker.ready_info.get("loadMs", float("nan"))),
        "by_variant": {},
    }
    try:
        for v in variants:
            tile_ms_list = []
            img_ms_list = []
            tiles_list = []
            for r in rows_sample:
                res = run_image_variant(worker, r, v, data_dir)
                resp = res["resp"]
                n_t = max(1, int(resp["totalTiles"]))
                img_ms_list.append(float(resp["inferMs"]))
                tiles_list.append(int(resp["totalTiles"]))
                tile_ms_list.append(float(resp["inferMs"]) / n_t)
            out_stats["by_variant"][v] = {
                "n_sample": len(rows_sample),
                "mean_img_ms": float(np.mean(img_ms_list)),
                "median_tile_ms": float(np.median(tile_ms_list)),
                "mean_tile_ms": float(np.mean(tile_ms_list)),
                "sample_tiles": tiles_list,
            }
    finally:
        worker.close()
    return out_stats


def _estimate_tiles_for_image(img_path: Path, variant: str, model_kind: str) -> int:
    """Fast header-only tile count estimate matching cellposeTiling.ts for pre-flight ETA planning."""
    with Image.open(img_path) as im:
        w, h = im.size
    ww, wh = prepare_working_dimensions(w, h)
    scale = 1.5 if variant == "D" else (2.0 if variant == "E" else 1.0)
    iw, ih = max(1, round(ww * scale)), max(1, round(wh * scale))
    if model_kind == "unet":
        h2, w2 = max(1, int(ih * 17.0 / 30.0)), max(1, int(iw * 17.0 / 30.0))
        def u_n(L: int) -> int:
            lp = 16 * math.ceil(L / 16) - L
            padL = L + 16 + lp
            return 1 if padL <= 224 else math.ceil(1.2 * padL / 224)
        return u_n(h2) * u_n(w2)
    else:
        def cp_n(L: int) -> int:
            lp = max(0, 256 - L - 16) if L < 256 else (16 * math.ceil(L / 16) - L)
            padL = L + 16 + lp
            return 1 if padL <= 256 else math.ceil(1.5 * padL / 256)
        return cp_n(ih) * cp_n(iw)


def _write_outputs(
    out_dir: Path,
    summary: dict[str, Any],
    new_csv_rows: list[dict],
    merge_existing: Path | None,
) -> None:
    """Writes results_per_image.csv and results.json, optionally preserving previously completed models."""
    merged_summary = json.loads(json.dumps(summary))
    df_new = pd.DataFrame(new_csv_rows) if new_csv_rows else pd.DataFrame()
    df_all = df_new

    if merge_existing and merge_existing.exists():
        prev_json = json.loads(merge_existing.read_text(encoding="utf-8"))
        prev_csv_p = merge_existing.parent / "results_per_image.csv"
        if prev_csv_p.exists():
            df_prev = pd.read_csv(prev_csv_p)
            active_models = set(df_new["model_key"].unique()) if len(df_new) else set()
            if active_models and len(df_prev):
                df_prev = df_prev[~df_prev["model_key"].isin(active_models)]
            df_all = pd.concat([df_prev, df_new], ignore_index=True) if len(df_new) else df_prev
        for field in ("parity_5tile", "wasm_timing", "adaptive_threshold_train", "models"):
            prev_map = prev_json.get(field, {})
            cur_map = merged_summary.get(field, {})
            comb = dict(prev_map)
            comb.update(cur_map)
            merged_summary[field] = comb
        merged_summary["n_test_images"] = max(
            int(prev_json.get("n_test_images", 0)),
            int(merged_summary.get("n_test_images", 0)),
        )
        if len(prev_json.get("g_sanity_uids", [])) > len(merged_summary.get("g_sanity_uids", [])):
            merged_summary["g_sanity_uids"] = prev_json["g_sanity_uids"]
        if len(prev_json.get("fp16_spot_uids", [])) > len(merged_summary.get("fp16_spot_uids", [])):
            merged_summary["fp16_spot_uids"] = prev_json["fp16_spot_uids"]
        if not merged_summary.get("h_noisiest_10") and prev_json.get("h_noisiest_10"):
            merged_summary["h_noisiest_10"] = prev_json["h_noisiest_10"]

    if len(df_all):
        df_all.to_csv(out_dir / "results_per_image.csv", index=False)
        for mkey in sorted(df_all["model_key"].unique()):
            sub_m = df_all[df_all["model_key"] == mkey]
            # Only recompute model summary if we actually touched it or it wasn't already loaded from prev
            if mkey not in merged_summary["models"] or (len(df_new) and mkey in set(df_new["model_key"].unique())):
                wasm_t_ms = merged_summary["parity_5tile"].get(mkey, {}).get("wasm_tile_ms_median")
                m_sum: dict[str, Any] = {"variants": {}, "paired_vs_A": {}, "subset_paired_vs_A": {}}
                for var in sorted(sub_m["variant"].unique()):
                    sub_v = sub_m[sub_m["variant"] == var]
                    m_sum["variants"][var] = summarize_variant(sub_v, wasm_tile_ms_median=wasm_t_ms)
                    if var != "A":
                        if var in SANITY_G_VARIANTS or var in DENOISE_H_VARIANTS:
                            m_sum["subset_paired_vs_A"][var] = paired_vs_baseline(df_all, mkey, var, "A")
                        else:
                            m_sum["paired_vs_A"][var] = paired_vs_baseline(df_all, mkey, var, "A")
                merged_summary["models"][mkey] = m_sum

    with (out_dir / "results.json").open("w", encoding="utf-8") as f:
        json.dump(merged_summary, f, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run webGrainy preprocessing benchmark.")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--models-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, default=Path("audit/preprocessing"))
    parser.add_argument("--cache-dir", type=Path, default=Path("/tmp/ig2_bench/cache"))
    parser.add_argument("--models", nargs="+", default=["unet_fp32"], choices=list(MODEL_SPECS.keys()))
    parser.add_argument("--parity-only-models", nargs="*", default=[], choices=list(MODEL_SPECS.keys()), help="Only run SHA-256 verification and 5-tile WASM vs PyCPU parity check")
    parser.add_argument("--variants", nargs="+", default=CORE_VARIANTS + ["F"] + SANITY_G_VARIANTS + DENOISE_H_VARIANTS)
    parser.add_argument("--max-test", type=int, default=40)
    parser.add_argument("--stratified-test", action="store_true", help="When --max-test < 40, select stratified cross-site images prioritizing CT, NB2, DV_4, NZ2, APF_2")
    parser.add_argument("--train-t-max", type=int, default=203)
    parser.add_argument("--train-t-max-cpsam", type=int, default=13, help="Stratified train images for CP-SAM T selection (avoids multi-day WASM on 203 images)")
    parser.add_argument("--wasm-threads", type=int, default=0, help="0 = auto (min(8, max(2, cpu_count)))")
    parser.add_argument("--bridge-tol", type=float, default=0.05)
    parser.add_argument("--fixed-T", type=float, default=None, help="Optional fixed T override (else selected on train split)")
    parser.add_argument("--fixed-up", type=str, default=None, help="Optional fixed F upscale variant D or E")
    parser.add_argument("--merge-existing", type=Path, default=None, help="Optional existing results.json to preserve/merge completed models with")
    args = parser.parse_args()

    if args.wasm_threads <= 0:
        args.wasm_threads = min(8, max(2, os.cpu_count() or 4))

    args.out_dir.mkdir(parents=True, exist_ok=True)
    args.cache_dir.mkdir(parents=True, exist_ok=True)

    manifest = list(csv.DictReader(MANIFEST_PATH.open()))
    test_rows_all = sorted([r for r in manifest if r["official_split"] == "test"], key=lambda x: x["uid"])
    train_rows_all = sorted([r for r in manifest if r["official_split"] == "train"], key=lambda x: x["uid"])
    if args.stratified_test and args.max_test < len(test_rows_all):
        test_rows = select_stratified_rows(test_rows_all, args.max_test, priority_sites=HIGHLIGHT_SITES)
    else:
        test_rows = test_rows_all[: args.max_test]

    # Select 10 stratified images for sanity check G, 10 noisiest for H, 5 diverse for FP16 spot check
    g_rows = select_stratified_rows(test_rows, min(10, len(test_rows)), priority_sites=HIGHLIGHT_SITES)
    g_uids = {r["uid"] for r in g_rows}
    if any(v in args.variants for v in DENOISE_H_VARIANTS) and any(m != "cpsam_fp16" for m in args.models):
        h_rows, noise_ranking = select_noisiest_rows(test_rows, args.data_dir, n_top=min(10, len(test_rows)))
    else:
        h_rows, noise_ranking = [], []
    h_uids = {r["uid"] for r in h_rows}
    fp16_spot_rows = select_stratified_rows(test_rows_all, min(5, len(test_rows_all)), priority_sites=HIGHLIGHT_SITES)

    # Train split rows that exist locally on disk (allows fast stratified run or full 203 when full dataset extracted)
    avail_train_all = [
        r for r in train_rows_all
        if (args.data_dir / r["image_relpath"]).exists() and (args.data_dir / r["mask_relpath"]).exists()
    ]

    gt_cache: dict[str, Any] = {}
    all_csv_rows: list[dict] = []
    summary: dict[str, Any] = {
        "hf_repo": HF_REPO,
        "hf_revision": HF_REVISION,
        "seed": 42,
        "wasm_threads": args.wasm_threads,
        "n_test_images": len(test_rows),
        "g_sanity_uids": sorted(g_uids),
        "h_noisiest_10": noise_ranking[:10],
        "fp16_spot_uids": [r["uid"] for r in fp16_spot_rows],
        "parity_5tile": {},
        "wasm_timing": {},
        "adaptive_threshold_train": {},
        "models": {},
    }

    print(
        f"Config: models={args.models} | variants={args.variants} | test_n={len(test_rows)} "
        f"({'stratified' if args.stratified_test else 'prefix'}) | wasm_threads={args.wasm_threads}",
        flush=True,
    )

    for mkey in args.parity_only_models:
        if mkey in args.models:
            continue
        spec = MODEL_SPECS[mkey]
        mpath = args.models_dir / spec["filename"]
        assert mpath.exists(), f"Missing model {mpath}"
        assert sha256_file(mpath) == spec["sha256"], f"SHA mismatch for {mkey}"
        p_cache = args.cache_dir / f"parity_5tile_{mkey}_t{args.wasm_threads}.json"
        if p_cache.exists():
            parity = json.loads(p_cache.read_text())
        else:
            print(f"\n=== [{mkey}] Running 5-tile WASM vs PyCPU parity check (parity-only) ===", flush=True)
            parity = check_5tile_parity(mkey, mpath, test_rows_all, args.data_dir, args.wasm_threads, tol=args.bridge_tol)
            p_cache.write_text(json.dumps(parity, indent=2))
        summary["parity_5tile"][mkey] = parity
        print(f"  5-tile max_abs={parity['overall_max_abs']:.6f} (tol={args.bridge_tol}) -> bridge_allowed={parity['bridge_allowed']}, wasm_tile_ms_median={parity['wasm_tile_ms_median']:.1f}", flush=True)

    for mkey in args.models:
        spec = MODEL_SPECS[mkey]
        mpath = args.models_dir / spec["filename"]
        if not mpath.exists() and mkey == "unet_fp32":
            alt = REPO_ROOT / ".cache" / "ig2_unet_fp32.7773328a.onnx"
            if alt.exists():
                mpath = alt
        assert mpath.exists(), f"Missing model {mpath}"
        actual_sha = sha256_file(mpath)
        assert actual_sha == spec["sha256"], f"SHA mismatch for {mkey}: {actual_sha}"

        p_cache = args.cache_dir / f"parity_5tile_{mkey}_t{args.wasm_threads}.json"
        if p_cache.exists():
            parity = json.loads(p_cache.read_text())
        else:
            print(f"\n=== [{mkey}] Running 5-tile WASM vs PyCPU parity check ===", flush=True)
            parity = check_5tile_parity(mkey, mpath, test_rows_all, args.data_dir, args.wasm_threads, tol=args.bridge_tol)
            p_cache.write_text(json.dumps(parity, indent=2))
        summary["parity_5tile"][mkey] = parity
        use_bridge = parity["bridge_allowed"]
        backend = "ort_cpu_bridge(wasm_verified)" if use_bridge else "ort_web_wasm"
        tile_ms_est = float(parity["py_cpu_tile_ms_median"] if use_bridge else parity["wasm_tile_ms_median"])
        print(
            f"  5-tile max_abs={parity['overall_max_abs']:.6f} (tol={args.bridge_tol}) -> backend={backend} "
            f"(~{tile_ms_est/1000.0:.2f}s/tile)",
            flush=True,
        )

        eval_rows = fp16_spot_rows if mkey == "cpsam_fp16" else test_rows
        active_variants = [v for v in args.variants if v != "F"]
        if mkey == "cpsam_fp16":
            active_variants = [v for v in active_variants if v in CORE_VARIANTS]

        # Pre-flight execution & ETA plan
        need_train_T = "F" in args.variants and args.fixed_T is None and mkey != "cpsam_fp16"
        avail_train: list[dict] = []
        if need_train_T:
            t_cap = args.train_t_max if spec["model_kind"] == "unet" else args.train_t_max_cpsam
            avail_train = (
                select_stratified_rows(avail_train_all, t_cap, priority_sites=HIGHLIGHT_SITES)
                if t_cap < len(avail_train_all)
                else avail_train_all
            )

        rem_tiles_total = 0
        print(f"\n  [{mkey}] Pre-flight cache & runtime estimate:", flush=True)
        if need_train_T:
            tr_csv = args.cache_dir / f"train_T_eval_{mkey}.csv"
            tr_done = defaultdict(set)
            if tr_csv.exists():
                for _, trr in pd.read_csv(tr_csv).iterrows():
                    tr_done[str(trr["variant"])].add(str(trr["uid"]))
            for vv in ("A", "D", "E"):
                rem_r = [r for r in avail_train if r["uid"] not in tr_done[vv]]
                rt = sum(_estimate_tiles_for_image(args.data_dir / r["image_relpath"], vv, spec["model_kind"]) for r in rem_r)
                rem_tiles_total += rt
                print(f"    train/{vv:12s}: cached {len(avail_train)-len(rem_r)}/{len(avail_train)} | rem {len(rem_r)} imgs (~{rt} tiles, ~{_fmt_dur(rt*tile_ms_est/1000.0)})", flush=True)
        for var in active_variants:
            target_rows = g_rows if var in SANITY_G_VARIANTS else (h_rows if var in DENOISE_H_VARIANTS else eval_rows)
            var_csv = args.cache_dir / f"{mkey}_{var}.csv"
            done_u = set(pd.read_csv(var_csv)["uid"].astype(str)) if var_csv.exists() else set()
            rem_r = [r for r in target_rows if r["uid"] not in done_u]
            rt = sum(_estimate_tiles_for_image(args.data_dir / r["image_relpath"], var, spec["model_kind"]) for r in rem_r)
            rem_tiles_total += rt
            print(f"    test/{var:13s}: cached {len(target_rows)-len(rem_r)}/{len(target_rows)} | rem {len(rem_r)} imgs (~{rt} tiles, ~{_fmt_dur(rt*tile_ms_est/1000.0)})", flush=True)
        print(f"    >>> TOTAL REMAINING FOR {mkey}: ~{rem_tiles_total} tiles -> estimated wall time ~{_fmt_dur(rem_tiles_total*tile_ms_est/1000.0)}\n", flush=True)

        srv, bridge_url = None, None
        if use_bridge:
            sess = ort.InferenceSession(str(mpath), providers=["CPUExecutionProvider"])
            srv, port = start_ort_bridge(sess)
            bridge_url = f"http://127.0.0.1:{port}/{mkey}"

        worker = PersistentTSWorker(
            spec["model_kind"],
            None if use_bridge else mpath,
            bridge_url,
            args.wasm_threads,
            args.cache_dir / f"worker_{mkey}.stderr.log",
        )
        t_model_start = time.perf_counter()
        tiles_done_so_far = 0
        try:
            # 1) Determine adaptive T on train split BEFORE evaluating F on test
            if need_train_T:
                if not avail_train:
                    raise RuntimeError("No training images+masks available on disk to select adaptive T!")
                print(f"  Selecting adaptive T on {len(avail_train)} train images...", flush=True)
                t_info = choose_adaptive_threshold_on_train(worker, avail_train, args.data_dir, args.cache_dir, mkey)
                summary["adaptive_threshold_train"][mkey] = t_info
                chosen_T = t_info["chosen"]["T_px"]
                chosen_up = t_info["chosen"]["upscale_variant"]
                print(f"  Chosen on train: rescale={chosen_up} when working_med_b_px < {chosen_T} px (train dPQ={t_info['chosen']['mean_dPQ_train']:+.4f})", flush=True)
            else:
                chosen_T = float(args.fixed_T if args.fixed_T is not None else 12.0)
                chosen_up = str(args.fixed_up if args.fixed_up else "D")

            # 2) Run all requested variants
            model_records: dict[str, dict[str, dict]] = defaultdict(dict)
            for var in active_variants:
                if var in SANITY_G_VARIANTS:
                    target_rows = g_rows
                elif var in DENOISE_H_VARIANTS:
                    target_rows = h_rows
                else:
                    target_rows = eval_rows

                var_cache_csv = args.cache_dir / f"{mkey}_{var}.csv"
                cached = {}
                if var_cache_csv.exists():
                    for _, crow in pd.read_csv(var_cache_csv).iterrows():
                        cached[str(crow["uid"])] = crow.to_dict()

                new_added = False
                for idx, r in enumerate(target_rows, 1):
                    uid = r["uid"]
                    if uid in cached:
                        rec = cached[uid]
                        model_records[var][uid] = rec
                        continue
                    plabel = f"[{mkey}/{var} {idx}/{len(target_rows)}] {uid}"
                    print(f"    Starting {plabel}...", flush=True)
                    out = run_image_variant(worker, r, var, args.data_dir, progress_label=plabel)
                    rec = evaluate_prediction_vs_gt(r, out, gt_cache, args.data_dir)
                    rec["model_key"] = mkey
                    rec["variant"] = var
                    rec["backend"] = backend
                    model_records[var][uid] = rec
                    cached[uid] = rec
                    new_added = True
                    tiles_done_so_far += int(rec["total_tiles"])
                    elapsed_m = time.perf_counter() - t_model_start
                    rem_est_s = max(0, rem_tiles_total - tiles_done_so_far) * (elapsed_m / max(1, tiles_done_so_far)) if tiles_done_so_far else 0.0
                    print(
                        f"    DONE {plabel}: PQ={rec['pq_vs_gt']:.3f}, D50={rec['pred_b_D50']:.1f}/{rec['gt_b_D50']:.1f}, "
                        f"work_med_b={rec['working_med_b_px']:.1f}, tiles={rec['total_tiles']}, infer={_fmt_dur(rec['infer_ms']/1000.0)} "
                        f"| model elapsed {_fmt_dur(elapsed_m)}, remaining ETA ~{_fmt_dur(rem_est_s)}",
                        flush=True,
                    )
                    if idx % 5 == 0 or "cpsam" in mkey:
                        pd.DataFrame([cached[uu] for uu in sorted(cached.keys())]).to_csv(var_cache_csv, index=False)
                        new_added = False

                if new_added or not var_cache_csv.exists():
                    pd.DataFrame([model_records[var][r["uid"]] for r in target_rows]).to_csv(var_cache_csv, index=False)

                # Incremental results checkpoint after each completed variant
                partial_rows = [rec for vmap in model_records.values() for rec in vmap.values()]
                _write_outputs(args.out_dir, summary, all_csv_rows + partial_rows, args.merge_existing)
                print(f"  [checkpoint] Saved incremental {mkey}/{var} results to {args.out_dir}", flush=True)

            # 3) Compose F_adaptive on test images using A + chosen_up when working_med_b_px < chosen_T
            if "F" in args.variants and "A" in model_records and chosen_up in model_records and mkey != "cpsam_fp16":
                for r in eval_rows:
                    uid = r["uid"]
                    rec_a = dict(model_records["A"][uid])
                    triggered = bool(math.isfinite(rec_a["working_med_b_px"]) and rec_a["working_med_b_px"] < chosen_T)
                    if triggered:
                        rec_f = dict(model_records[chosen_up][uid])
                        rec_f["variant"] = "F"
                        rec_f["f_triggered"] = True
                        rec_f["f_threshold_T"] = chosen_T
                        rec_f["f_upscale_var"] = chosen_up
                        # Cumulative runtime & tiles: ran A first, then re-ran chosen_up
                        rec_f["total_tiles"] = int(rec_a["total_tiles"]) + int(rec_f["total_tiles"])
                        rec_f["infer_ms"] = float(rec_a["infer_ms"]) + float(rec_f["infer_ms"])
                        rec_f["preprocess_ms"] = float(rec_a["preprocess_ms"]) + float(rec_f["preprocess_ms"])
                        rec_f["postprocess_ms"] = float(rec_a["postprocess_ms"]) + float(rec_f["postprocess_ms"])
                    else:
                        rec_f = dict(rec_a)
                        rec_f["variant"] = "F"
                        rec_f["f_triggered"] = False
                        rec_f["f_threshold_T"] = chosen_T
                        rec_f["f_upscale_var"] = chosen_up
                    model_records["F"][uid] = rec_f

            for var, rmap in model_records.items():
                for uid, rec in rmap.items():
                    all_csv_rows.append(rec)
        finally:
            worker.close()
            if srv is not None:
                srv.shutdown()

        # 4) Measure real native WASM per-tile speed on 4 diverse images across A, B, D, E if bridge was used
        if use_bridge and mkey == "unet_fp32":
            wt_cache = args.cache_dir / f"wasm_timing_{mkey}_t{args.wasm_threads}.json"
            if wt_cache.exists():
                summary["wasm_timing"][mkey] = json.loads(wt_cache.read_text())
            else:
                wasm_sample = select_stratified_rows(eval_rows, 4, priority_sites=["CT", "APF_2", "NB2", "NZ2"])
                wt = measure_wasm_wall_times(
                    mkey, mpath, wasm_sample, ["A", "B", "D", "E"], args.data_dir, args.wasm_threads, args.cache_dir
                )
                wt_cache.write_text(json.dumps(wt, indent=2))
                summary["wasm_timing"][mkey] = wt

    _write_outputs(args.out_dir, summary, all_csv_rows, args.merge_existing)
    print(f"\nSaved {args.out_dir / 'results.json'} and {args.out_dir / 'results_per_image.csv'}", flush=True)


if __name__ == "__main__":
    main()

