#!/usr/bin/env python3
"""
Generate summary visualizations for `validation/preprocessing/` from `results.json`
and `results_per_image.csv`.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

OUT_DIR = Path(__file__).resolve().parent


def main() -> None:
    results = json.loads((OUT_DIR / "results.json").read_text(encoding="utf-8"))
    df = pd.read_csv(OUT_DIR / "results_per_image.csv")

    if "unet_fp32" not in results["models"]:
        print("No unet_fp32 in results.json yet; skipping charts.")
        return

    m = results["models"]["unet_fp32"]
    core_vars = [v for v in ("A", "B", "C", "D", "E", "F") if v in m["variants"]]
    labels_map = {
        "A": "A\nBaseline",
        "B": "B\nCLAHE 2.0",
        "C": "C\nCLAHE 3.0",
        "D": "D\nUpscale ×1.5",
        "E": "E\nUpscale ×2.0",
        "F": "F\nAdaptive",
    }

    # 1. Core tradeoff + Size-class recall
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8))
    x = np.arange(len(core_vars))
    dpqs = [0.0 if v == "A" else m["paired_vs_A"][v]["mean_dPQ"] for v in core_vars]
    lo_err = [0.0 if v == "A" else dpqs[i] - m["paired_vs_A"][v]["dPQ_ci95"][0] for i, v in enumerate(core_vars)]
    hi_err = [0.0 if v == "A" else m["paired_vs_A"][v]["dPQ_ci95"][1] - dpqs[i] for i, v in enumerate(core_vars)]
    colors = ["#4a5568", "#dd6b20", "#c53030", "#3182ce", "#2b6cb0", "#2f855a"][: len(core_vars)]

    axes[0].axhline(0.0, color="#718096", linestyle="--", linewidth=1)
    axes[0].axhline(0.01, color="#2f855a", linestyle=":", linewidth=1.2, label="Cond 1 threshold (+0.01)")
    axes[0].bar(x, dpqs, color=colors, alpha=0.88, width=0.58)
    axes[0].errorbar(x[1:], dpqs[1:], yerr=[lo_err[1:], hi_err[1:]], fmt="none", ecolor="#1a202c", capsize=4, linewidth=1.3)
    for i, v in enumerate(core_vars):
        pq_val = m["variants"][v]["pq_vs_gt"]["mean"]
        y_txt = dpqs[i] + (hi_err[i] + 0.006 if dpqs[i] >= 0 else -lo_err[i] - 0.008)
        axes[0].text(i, y_txt, f"PQ={pq_val:.3f}", ha="center", va="bottom" if dpqs[i] >= 0 else "top", fontsize=8.5, fontweight="bold")
    axes[0].set_xticks(x)
    axes[0].set_xticklabels([labels_map[v] for v in core_vars], fontsize=9)
    axes[0].set_ylim(-0.064, 0.102)
    axes[0].set_ylabel("Paired ΔPQ vs Baseline A (with 95% CI)")
    axes[0].set_title("U-Net FP32 (n=40): Segmentation Quality Gain vs Baseline A")
    axes[0].legend(loc="lower right", fontsize=8.5)
    axes[0].grid(axis="y", alpha=0.25)

    bins = [("lt10", "<10 px"), ("10_20", "10–20 px"), ("20_40", "20–40 px"), ("gt40", ">40 px")]
    bw = 0.13
    bx = np.arange(len(bins))
    for i, v in enumerate(core_vars):
        vals = [m["variants"][v]["size_class_recall"][bk]["pooled_recall"] for bk, _ in bins]
        axes[1].bar(bx + (i - (len(core_vars) - 1) / 2) * bw, vals, width=bw, label=v, color=colors[i], alpha=0.9)
    axes[1].set_xticks(bx)
    axes[1].set_xticklabels([bl for _, bl in bins], fontsize=9.5)
    axes[1].set_ylim(0, 1.05)
    axes[1].set_ylabel("Pooled Recall (IoU > 0.5)")
    axes[1].set_title("U-Net FP32 (n=40): Grain Recall by GT b-axis Size Class")
    axes[1].legend(title="Variant", ncol=3, fontsize=8.5, loc="upper left")
    axes[1].grid(axis="y", alpha=0.25)

    plt.tight_layout()
    plt.savefig(OUT_DIR / "preprocessing_tradeoff.png", dpi=150)
    plt.close(fig)

    # 2. Per-site breakdown (PQ & ΔMed D50 APE)
    sites_order = ["CT", "NB2", "DV_4", "APF_2", "NZ2", "AR", "FH_2", "HP", "JF", "NZ1", "PP", "PR", "S1_2"]
    present_sites = [s for s in sites_order if s in m["paired_vs_A"]["D"]["per_site"]]
    fig, axes = plt.subplots(2, 1, figsize=(13, 8.2), sharex=True)
    sx = np.arange(len(present_sites))
    comp_vars = [v for v in ("A", "B", "D", "E", "F") if v in m["variants"]]
    v_colors = {"A": "#4a5568", "B": "#dd6b20", "D": "#3182ce", "E": "#2b6cb0", "F": "#2f855a"}
    w = 0.15
    for i, v in enumerate(comp_vars):
        pqs = [
            m["paired_vs_A"]["D"]["per_site"][s]["pq_A"]
            if v == "A"
            else m["paired_vs_A"][v]["per_site"][s]["pq_var"]
            for s in present_sites
        ]
        axes[0].bar(sx + (i - (len(comp_vars) - 1) / 2) * w, pqs, width=w, label=v, color=v_colors[v], alpha=0.9)
    axes[0].set_ylabel("Mean PQ vs GT")
    axes[0].set_title("U-Net FP32 Per-Site PQ (Fine sites CT, NB2, DV_4 left; Coarse sites NZ2, PR, S1_2 right)")
    axes[0].legend(ncol=len(comp_vars), fontsize=9)
    axes[0].grid(axis="y", alpha=0.25)

    non_base = [v for v in comp_vars if v != "A"]
    w2 = 0.18
    axes[1].axhline(0.0, color="#718096", linewidth=1)
    axes[1].axhline(2.0, color="#e53e3e", linestyle="--", linewidth=1.3, label="Cond 2 limit (+2.0 pp)")
    for i, v in enumerate(non_base):
        deltas = [m["paired_vs_A"][v]["per_site"][s]["dMed_d50_ape_pp"] for s in present_sites]
        axes[1].bar(sx + (i - (len(non_base) - 1) / 2) * w2, deltas, width=w2, label=v, color=v_colors[v], alpha=0.9)
    axes[1].set_xticks(sx)
    axes[1].set_xticklabels(present_sites, fontsize=9.5, fontweight="bold")
    axes[1].set_ylabel("Δ Median D50 APE vs A (pp)\n(negative = better)")
    axes[1].set_title("Per-Site Median D50 APE Shift vs Baseline A (Condition 2 guard: max <= +2.0 pp)")
    axes[1].set_ylim(-70, 50)
    axes[1].legend(ncol=len(non_base) + 1, fontsize=9, loc="lower right")
    axes[1].grid(axis="y", alpha=0.25)

    plt.tight_layout()
    plt.savefig(OUT_DIR / "site_breakdown.png", dpi=150)
    plt.close(fig)

    # 3. Sanity G, Denoise H, & Runtime cost
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.6))
    sub_vars = [v for v in ("G_gamma07", "G_gamma14", "G_bright_p20", "G_bright_m20", "H_bilateral", "H_median3") if v in m.get("subset_paired_vs_A", {})]
    sub_labels = {
        "G_gamma07": "Gamma 0.7\n(n=10)",
        "G_gamma14": "Gamma 1.4\n(n=10)",
        "G_bright_p20": "Bright +20%\n(n=10)",
        "G_bright_m20": "Bright -20%\n(n=10)",
        "H_bilateral": "Bilateral 5×5\n(10 noisiest)",
        "H_median3": "Median 3×3\n(10 noisiest)",
    }
    if sub_vars:
        sx2 = np.arange(len(sub_vars))
        dpqs_s = [m["subset_paired_vs_A"][v]["mean_dPQ"] for v in sub_vars]
        lo_s = [dpqs_s[i] - m["subset_paired_vs_A"][v]["dPQ_ci95"][0] for i, v in enumerate(sub_vars)]
        hi_s = [m["subset_paired_vs_A"][v]["dPQ_ci95"][1] - dpqs_s[i] for i, v in enumerate(sub_vars)]
        scols = ["#805ad5" if v.startswith("G_") else "#319795" for v in sub_vars]
        axes[0].axhline(0.0, color="#718096", linestyle="--", linewidth=1)
        axes[0].bar(sx2, dpqs_s, color=scols, alpha=0.85, width=0.55)
        axes[0].errorbar(sx2, dpqs_s, yerr=[lo_s, hi_s], fmt="none", ecolor="#1a202c", capsize=4)
        axes[0].set_xticks(sx2)
        axes[0].set_xticklabels([sub_labels[v] for v in sub_vars], fontsize=8.5)
        axes[0].set_ylabel("Paired ΔPQ vs Baseline A (95% CI)")
        axes[0].set_title("Sanity Check G & Optional Denoise H (n=10 subsets)")
        axes[0].grid(axis="y", alpha=0.25)

    cx = np.arange(len(core_vars))
    tiles_mean = [m["variants"][v]["total_tiles"]["mean"] for v in core_vars]
    wasm_s = [m["variants"][v].get("est_wasm_wall_s_total", 0.0) / 40.0 for v in core_vars]
    axes[1].bar(cx - 0.18, tiles_mean, width=0.35, label="Mean tiles / image", color="#4c51bf", alpha=0.85)
    axes[1].bar(cx + 0.18, wasm_s, width=0.35, label="Est. 2-thread WASM s / img", color="#ed8936", alpha=0.85)
    axes[1].set_xticks(cx)
    axes[1].set_xticklabels([labels_map[v] for v in core_vars], fontsize=9)
    axes[1].set_ylabel("Tiles or Seconds per Image")
    axes[1].set_title(f"U-Net FP32 Computational Cost (WASM {results.get('wasm_threads', 2)} threads)")
    axes[1].legend(fontsize=9)
    axes[1].grid(axis="y", alpha=0.25)

    plt.tight_layout()
    plt.savefig(OUT_DIR / "sanity_and_runtime.png", dpi=150)
    plt.close(fig)

    # 4. CP-SAM FP16 5-image spot check (per-site PQ & model comparison on matched 5 images)
    if "cpsam_fp16" in results["models"]:
        m2 = results["models"]["cpsam_fp16"]
        spot_uids = results.get("fp16_spot_uids", [])
        spot_sites = ["CT", "NB2", "DV_4", "APF_2", "NZ2"]
        spot_vars = [v for v in ("A", "B", "C", "D") if v in m2["variants"]]
        fig, axes = plt.subplots(1, 2, figsize=(13, 4.7))

        # Left: CP-SAM FP16 per-site PQ on the 5 spot images
        scols2 = {"A": "#4a5568", "B": "#dd6b20", "C": "#c53030", "D": "#3182ce"}
        sx3 = np.arange(len(spot_sites))
        w3 = 0.18
        sub_fp16 = df[df["model_key"] == "cpsam_fp16"]
        for i, v in enumerate(spot_vars):
            vals = []
            for s in spot_sites:
                row = sub_fp16[(sub_fp16["site"] == s) & (sub_fp16["variant"] == v)]
                vals.append(float(row["pq_vs_gt"].iloc[0]) if len(row) else 0.0)
            axes[0].bar(sx3 + (i - (len(spot_vars) - 1) / 2) * w3, vals, width=w3, label=labels_map[v].replace("\n", " "), color=scols2[v], alpha=0.9)
        axes[0].set_xticks(sx3)
        axes[0].set_xticklabels(spot_sites, fontsize=9.5, fontweight="bold")
        axes[0].set_ylim(0, 0.92)
        axes[0].set_ylabel("PQ vs GT")
        axes[0].set_title("CP-SAM FP16 5-Image Spot Check: Per-Image PQ by Variant")
        axes[0].legend(fontsize=8.5, ncol=2, loc="upper left")
        axes[0].grid(axis="y", alpha=0.25)

        # Right: Matched 5-image comparison U-Net FP32 vs CP-SAM FP16 (Mean PQ)
        vx = np.arange(len(spot_vars))
        sub_unet_5 = df[(df["model_key"] == "unet_fp32") & (df["uid"].isin(spot_uids))]
        unet_pqs_5 = [float(sub_unet_5[sub_unet_5["variant"] == v]["pq_vs_gt"].mean()) for v in spot_vars]
        cpsam_pqs_5 = [m2["variants"][v]["pq_vs_gt"]["mean"] for v in spot_vars]
        axes[1].bar(vx - 0.18, unet_pqs_5, width=0.35, label="U-Net FP32 (same 5 imgs)", color="#718096", alpha=0.88)
        axes[1].bar(vx + 0.18, cpsam_pqs_5, width=0.35, label="CP-SAM FP16 (same 5 imgs)", color="#2b6cb0", alpha=0.9)
        for i in range(len(spot_vars)):
            axes[1].text(i - 0.18, unet_pqs_5[i] + 0.015, f"{unet_pqs_5[i]:.3f}", ha="center", va="bottom", fontsize=8.5)
            axes[1].text(i + 0.18, cpsam_pqs_5[i] + 0.015, f"{cpsam_pqs_5[i]:.3f}", ha="center", va="bottom", fontsize=8.5, fontweight="bold")
        axes[1].set_xticks(vx)
        axes[1].set_xticklabels([labels_map[v] for v in spot_vars], fontsize=9)
        axes[1].set_ylim(0, 0.76)
        axes[1].set_ylabel("Mean PQ vs GT (n=5)")
        axes[1].set_title("Matched 5-Image Spot Check: U-Net FP32 vs CP-SAM FP16")
        axes[1].legend(fontsize=9, loc="upper left")
        axes[1].grid(axis="y", alpha=0.25)

        plt.tight_layout()
        plt.savefig(OUT_DIR / "cpsam_fp16_spotcheck.png", dpi=150)
        plt.close(fig)

    print("Generated preprocessing_tradeoff.png, site_breakdown.png, sanity_and_runtime.png, cpsam_fp16_spotcheck.png")


if __name__ == "__main__":
    main()
