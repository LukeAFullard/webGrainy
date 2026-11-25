#!/usr/bin/env python3
"""Score the shipped app's held-out results (run_app_heldout.mjs) against the hand outlines.

The metric and scoring functions are copied unchanged from imagegrains_heldout_followup_colab.ipynb
(load_gt_mask, compute_mask_grain_metrics, area_weighted_percentiles, compute_pq, bootstrap_ci,
summarize_col), except that masks are read with Pillow instead of OpenCV. For each image: the
absolute % error of the app's area-weighted b-axis D16 / D50 / D84 (photo px, interior grains,
>= 15 px) against the same statistic of the hand outlines (interior, >= 15 px), and panoptic
quality (PQ, IoU > 0.5) of the app's label mask (resized to the photo as in its mask export).

Usage: python3 -I validation/heldout/score_app_heldout.py [unet] [cpsam]
Writes validation/heldout/heldout_app_results.md and heldout_app_results_per_image.csv.
Scoring one model keeps the other model's committed rows. With --from-csv, only re-summarises
the committed heldout_app_results_per_image.csv.
"""
from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from skimage.measure import regionprops

ROOT = Path(__file__).resolve().parents[2]
MIN_SIZE_PX = 15.0


def load_gt_mask(path: str, hw: tuple[int, int]) -> np.ndarray:
    arr = np.array(Image.open(path))
    if arr.ndim == 3:
        if np.array_equal(arr[:, :, 0], arr[:, :, 1]) and np.array_equal(arr[:, :, 0], arr[:, :, 2]):
            arr = arr[:, :, 0]
        else:
            rgb = arr[:, :, :3].astype(np.int64)
            arr = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
    if arr.shape[:2] != hw:
        arr = np.array(Image.fromarray(arr.astype(np.int32), mode="I").resize((hw[1], hw[0]), Image.Resampling.NEAREST))
    arr_i = arr.astype(np.int64)
    arr_i[arr_i < 0] = 0
    uniq, inv = np.unique(arr_i, return_inverse=True)
    out = inv.reshape(hw).astype(np.int32)
    if len(uniq) > 0 and uniq[0] != 0:
        out += 1
    return out


def compute_mask_grain_metrics(masks: np.ndarray, exclude_border_margin: int = 2) -> list[dict]:
    H, W = masks.shape
    grains = []
    for prop in regionprops(masks):
        area = float(prop.area)
        if area <= 0:
            continue
        minr, minc, maxr, maxc = prop.bbox
        is_border = (minr < exclude_border_margin or minc < exclude_border_margin or
                     maxr > H - exclude_border_margin or maxc > W - exclude_border_margin)
        if is_border:
            continue
        b_axis = float(prop.axis_minor_length) if hasattr(prop, "axis_minor_length") else float(prop.minor_axis_length)
        d_eq = math.sqrt(4.0 * area / math.pi)
        if b_axis > 0 and d_eq > 0:
            grains.append({"areaPx": area, "bAxisPx": b_axis, "dEqPx": d_eq})
    return grains


def area_weighted_percentiles(grains: list[dict], key: str, pcts=(16.0, 50.0, 84.0), min_size_px: float = MIN_SIZE_PX) -> dict[str, float]:
    valid = [(float(g[key]), float(g["areaPx"])) for g in grains
             if not g.get("isBorder", False) and g.get(key, 0) > 0 and g.get("areaPx", 0) > 0
             and float(g[key]) >= min_size_px]
    if not valid:
        return {f"D{int(p)}": float("nan") for p in pcts}
    valid.sort(key=lambda x: x[0])
    vals = np.array([v[0] for v in valid], dtype=np.float64)
    wts = np.array([v[1] for v in valid], dtype=np.float64)
    cum = np.cumsum(wts)
    cdf = (cum - 0.5 * wts) / cum[-1] * 100.0
    return {f"D{int(p)}": float(2.0 ** np.interp(p, cdf, np.log2(vals))) for p in pcts}


def compute_pq(pred: np.ndarray, gt: np.ndarray, iou_thresh: float = 0.5) -> float:
    pred_ids = np.unique(pred); pred_ids = pred_ids[pred_ids > 0]
    gt_ids = np.unique(gt); gt_ids = gt_ids[gt_ids > 0]
    if len(pred_ids) == 0 and len(gt_ids) == 0:
        return 1.0
    if len(pred_ids) == 0 or len(gt_ids) == 0:
        return 0.0
    p_areas = {int(i): int((pred == i).sum()) for i in pred_ids}
    g_areas = {int(j): int((gt == j).sum()) for j in gt_ids}
    mask = (pred > 0) & (gt > 0)
    if not np.any(mask):
        return 0.0
    pairs = pred[mask].astype(np.int64) * 1_000_000 + gt[mask].astype(np.int64)
    uniq_pairs, counts = np.unique(pairs, return_counts=True)
    tp, iou_sum = 0, 0.0
    matched_p, matched_g = set(), set()
    candidates = []
    for code, inter in zip(uniq_pairs, counts):
        pi, gi = int(code // 1_000_000), int(code % 1_000_000)
        iou = float(inter) / float(p_areas[pi] + g_areas[gi] - int(inter))
        if iou > iou_thresh:
            candidates.append((iou, pi, gi))
    candidates.sort(reverse=True)
    for iou, pi, gi in candidates:
        if pi not in matched_p and gi not in matched_g:
            matched_p.add(pi); matched_g.add(gi); tp += 1; iou_sum += iou
    fp, fn = len(pred_ids) - tp, len(gt_ids) - tp
    denom = tp + 0.5 * fp + 0.5 * fn
    return float(iou_sum / denom) if denom > 0 else 0.0


def bootstrap_ci(arr: np.ndarray, fn, n_boot: int = 2000, seed: int = 42) -> list[float]:
    rng = np.random.default_rng(seed)
    if len(arr) < 2:
        val = float(fn(arr)) if len(arr) == 1 else float("nan")
        return [val, val]
    boots = np.empty(n_boot, dtype=np.float64)
    for i in range(n_boot):
        boots[i] = fn(arr[rng.integers(0, len(arr), size=len(arr))])
    return [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))]


def cluster_bootstrap_ci(arr: np.ndarray, groups: np.ndarray, fn, n_boot: int = 2000, seed: int = 42) -> list[float]:
    """95% percentile interval resampling whole sites (clusters) with replacement: images of one
    site are not independent, so resampling images would understate the uncertainty."""
    rng = np.random.default_rng(seed)
    sites = np.unique(groups)
    if len(sites) < 2:
        return bootstrap_ci(arr, fn, n_boot, seed)
    by_site = [arr[groups == g] for g in sites]
    boots = np.empty(n_boot, dtype=np.float64)
    for i in range(n_boot):
        pick = rng.integers(0, len(sites), size=len(sites))
        boots[i] = fn(np.concatenate([by_site[j] for j in pick]))
    return [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))]


def summarize(gt: np.ndarray, pr: np.ndarray, sites: np.ndarray) -> dict:
    ok = np.isfinite(gt) & np.isfinite(pr) & (gt > 0)
    gt, pr, sites = gt[ok], pr[ok], sites[ok]
    ape = 100.0 * np.abs(pr - gt) / gt
    return {"n": int(len(ape)), "mean": float(np.mean(ape)), "mean_ci": cluster_bootstrap_ci(ape, sites, np.mean),
            "median": float(np.median(ape)), "median_ci": cluster_bootstrap_ci(ape, sites, np.median),
            "gt50": float(100.0 * np.mean(ape > 50.0)), "bias_median": float(np.median(100.0 * (pr - gt) / gt))}


def summary_from_csv(version: str | None = None) -> list[tuple]:
    """Re-summarise the committed per-image results (no images or app runs needed)."""
    per = list(csv.DictReader(open(ROOT / "validation/heldout/heldout_app_results_per_image.csv")))
    if version is None:
        old = (ROOT / "validation/heldout/heldout_app_results.md").read_text().splitlines()[0]
        version = old.split("(webGrainy ", 1)[1].rstrip(")") if "(webGrainy " in old else "unknown"
    table = []
    for model in dict.fromkeys(r["model"] for r in per):
        rs = [r for r in per if r["model"] == model]
        num = lambda v: float(v) if v not in ("", "None", "nan") else float("nan")
        sites = np.array([r["site"] for r in rs])
        s = {k: summarize(np.array([num(r[f"gt_{k}"]) for r in rs]), np.array([num(r[f"app_{k}"]) for r in rs]), sites)
             for k in ("D16", "D50", "D84")}
        table.append((model, s, float(np.mean([float(r["pq"]) for r in rs])), version))
    return table


def main() -> None:
    if "--from-csv" in sys.argv:
        write_summary(summary_from_csv())
        return
    models = sys.argv[1:] or ["unet", "cpsam"]
    rows = [r for r in csv.DictReader(open(ROOT / "validation/heldout/heldout_manifest.csv")) if r["official_split"] == "test"]
    per_image, table = [], []
    for model in models:
        d = ROOT / ".cache/heldout_app" / model
        if not d.exists() or len(list(d.glob("*.json"))) < len(rows):
            print(f"skipping {model}: {len(list(d.glob('*.json'))) if d.exists() else 0}/{len(rows)} images analysed")
            continue
        gts = {k: [] for k in ("D16", "D50", "D84")}
        prs = {k: [] for k in ("D16", "D50", "D84")}
        pqs = []
        versions = set()
        for r in rows:
            app = json.load(open(d / f"{r['uid']}.json"))
            versions.add(app["appVersion"])
            hw = (app["height"], app["width"])
            pred = np.fromfile(d / f"{r['uid']}.i32", dtype=np.int32).reshape(hw)
            gt_mask = load_gt_mask(str(ROOT / ".cache/ig2" / r["mask_relpath"].replace("/", "__")), hw)
            gt = area_weighted_percentiles(compute_mask_grain_metrics(gt_mask), "bAxisPx")
            pq = compute_pq(pred, gt_mask)
            pqs.append(pq)
            for k in gts:
                gts[k].append(gt[k]); prs[k].append(app[k] if app[k] is not None else float("nan"))
            per_image.append({"uid": r["uid"], "site": r["site"], "model": model, "pred_grains": app["grains"],
                              **{f"gt_{k}": gt[k] for k in gts}, **{f"app_{k}": app[k] for k in gts}, "pq": pq})
        sites = np.array([r["site"] for r in rows])
        s = {k: summarize(np.array(gts[k], float), np.array(prs[k], float), sites) for k in gts}
        # Images re-run only when the analysis changed for them can come from different versions.
        table.append((model, s, float(np.mean(pqs)), " / ".join(sorted(versions))))
    if not table:
        return
    # Keep the committed rows of models not scored in this run (scoring only `unet` must not drop
    # the Cellpose-SAM results), in the usual model order.
    csv_path = ROOT / "validation/heldout/heldout_app_results_per_image.csv"
    scored = {m for m, *_ in table}
    kept = [r for r in csv.DictReader(open(csv_path)) if r["model"] not in scored] if csv_path.exists() else []
    order = {"unet": 0, "cpsam": 1}
    merged = sorted(per_image + kept, key=lambda r: order.get(r["model"], 9))
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(per_image[0].keys())); w.writeheader(); w.writerows(merged)
    version = table[0][3]
    if kept:
        table = summary_from_csv(version)
    write_summary(table)


def write_summary(table: list[tuple]) -> None:
    name = {"unet": "U-Net", "cpsam": "Cellpose-SAM (INT8, CPU)"}
    lines = [
        f"# Held-out accuracy of the shipped app (webGrainy {table[0][3]})",
        "",
        "40 test images (13 sites) of the ImageGrains 2.0 data against hand-digitised outlines. App default",
        "analysis (Cellpose pipeline, Auto image scale, default post-processing, Tidy outlines after analysis,",
        "CPU/WASM) and the numbers the",
        "app reports: area-weighted b-axis percentiles in photo px, interior grains, grains under 15 px left out",
        "(the same rule applied to the hand outlines). Errors are absolute % differences per image, with",
        "95% intervals from a site-cluster bootstrap (whole sites resampled, since images of one site are",
        "not independent). Produced by `run_app_heldout.mjs` + `score_app_heldout.py`.",
        "",
        "| Model | n | D50 error: mean [95% CI] | D50 error: median [95% CI] | D16 / D84 median error | D50 error > 50% | D50 median bias | PQ vs hand outlines |",
        "| --- | ---: | --- | --- | --- | ---: | ---: | ---: |",
    ]
    for model, s, pq, _ in table:
        d50 = s["D50"]
        lines.append(f"| {name[model]} | {d50['n']} | {d50['mean']:.1f}% [{d50['mean_ci'][0]:.1f}, {d50['mean_ci'][1]:.1f}] | "
                     f"{d50['median']:.1f}% [{d50['median_ci'][0]:.1f}, {d50['median_ci'][1]:.1f}] | "
                     f"{s['D16']['median']:.1f}% / {s['D84']['median']:.1f}% | {d50['gt50']:.1f}% | {d50['bias_median']:+.1f}% | {pq:.3f} |")
    lines += ["", "n < 40 where an image has no grain of at least 15 px in the prediction or the hand outlines."]
    if " / " in table[0][3]:
        lines += ["Several versions: an image is re-run only when a version changes its analysis (e.g. 0.1.0's Auto",
                  "image scale changed the 2 images over 1,024 px); the other images give identical results."]
    lines += [""]
    (ROOT / "validation/heldout/heldout_app_results.md").write_text("\n".join(lines))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
