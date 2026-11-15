#!/usr/bin/env python3
"""
Brown-Conrady radial (k1, k2) + tangential (p1, p2) lens distortion model
for quantifying apparent grain D50 error in webGrainy under:
  1. Center scale bar calibration
  2. Edge scale bar calibration
  3. 4-corner planar homography (as in src/modules/roiAndRectify.ts)

Outputs JSON results to audit/followup/lens_distortion_results.json.
"""
import json
from pathlib import Path
import numpy as np


def distort_points(x_u: np.ndarray, y_u: np.ndarray, k1: float, k2: float, p1: float, p2: float):
    r2 = x_u * x_u + y_u * y_u
    r4 = r2 * r2
    radial = 1.0 + k1 * r2 + k2 * r4
    x_d = x_u * radial + 2.0 * p1 * x_u * y_u + p2 * (r2 + 2.0 * x_u * x_u)
    y_d = y_u * radial + p1 * (r2 + 2.0 * y_u * y_u) + 2.0 * p2 * x_u * y_u
    return x_d, y_d


def local_linear_scale(x_u: np.ndarray, y_u: np.ndarray, k1: float, k2: float, p1: float, p2: float):
    """Isotropic local linear scale sqrt(|det(J)|) of the Brown-Conrady mapping."""
    eps = 1e-5
    xd_px, yd_px = distort_points(x_u + eps, y_u, k1, k2, p1, p2)
    xd_mx, yd_mx = distort_points(x_u - eps, y_u, k1, k2, p1, p2)
    xd_py, yd_py = distort_points(x_u, y_u + eps, k1, k2, p1, p2)
    xd_my, yd_my = distort_points(x_u, y_u - eps, k1, k2, p1, p2)

    j11 = (xd_px - xd_mx) / (2.0 * eps)
    j21 = (yd_px - yd_mx) / (2.0 * eps)
    j12 = (xd_py - xd_my) / (2.0 * eps)
    j22 = (yd_py - yd_my) / (2.0 * eps)

    det = np.abs(j11 * j22 - j12 * j21)
    return np.sqrt(det)


def simulate_camera(name: str, desc: str, f_35mm: float, aspect: float, k1: float, k2: float, p1: float, p2: float):
    # Half-width in normalized focal-plane coordinates (36 mm full-frame width)
    x_max = 18.0 / f_35mm
    y_max = x_max / aspect

    nx, ny = 81, 61
    xs = np.linspace(-x_max, x_max, nx)
    ys = np.linspace(-y_max, y_max, ny)
    xg, yg = np.meshgrid(xs, ys)

    s_grid = local_linear_scale(xg, yg, k1, k2, p1, p2)

    # 1. Center scale bar at (0, 0)
    s_center = float(local_linear_scale(np.array([0.0]), np.array([0.0]), k1, k2, p1, p2)[0])

    # 2. Edge scale bar at bottom-edge (0, 0.85 * y_max)
    s_edge = float(local_linear_scale(np.array([0.0]), np.array([0.85 * y_max]), k1, k2, p1, p2)[0])

    # 3. 4-corner homography at (±0.85 * x_max, ±0.85 * y_max):
    # A 4-point homography on a symmetric rectangle maps the distorted corner
    # span back to a rectangle with uniform scale equal to the corner radial ratio.
    cx, cy = 0.85 * x_max, 0.85 * y_max
    xd_c, yd_c = distort_points(np.array([cx]), np.array([cy]), k1, k2, p1, p2)
    s_homog = float(np.hypot(xd_c[0], yd_c[0]) / np.hypot(cx, cy))

    modes = {
        "center_scale_bar": s_center,
        "edge_scale_bar": s_edge,
        "four_corner_homography": s_homog,
    }

    mode_results = {}
    for mode_name, s_cal in modes.items():
        rel_err_pct = (s_grid / s_cal - 1.0) * 100.0
        mode_results[mode_name] = {
            "cal_scale_factor": round(s_cal, 5),
            "mean_d50_bias_pct": round(float(np.mean(rel_err_pct)), 3),
            "median_d50_bias_pct": round(float(np.median(rel_err_pct)), 3),
            "mean_abs_error_pct": round(float(np.mean(np.abs(rel_err_pct))), 3),
            "p95_abs_error_pct": round(float(np.percentile(np.abs(rel_err_pct), 95)), 3),
            "max_abs_error_pct": round(float(np.max(np.abs(rel_err_pct))), 3),
        }

    return {
        "camera": name,
        "description": desc,
        "f_35mm_eq": f_35mm,
        "aspect_ratio": aspect,
        "coefficients": {"k1": k1, "k2": k2, "p1": p1, "p2": p2},
        "max_normalized_radius": round(float(np.hypot(x_max, y_max)), 4),
        "calibration_modes": mode_results,
    }


def main():
    presets = [
        (
            "smartphone_oem_corrected",
            "Modern smartphone (iPhone/Pixel main 24 mm eq., JPEG/HEIC with OEM ISP lens correction)",
            24.0, 4.0 / 3.0, -0.015, 0.005, 0.0005, -0.0005,
        ),
        (
            "smartphone_uncorrected_wide",
            "Smartphone uncorrected RAW/DNG wide-angle (24 mm eq., no ISP distortion profile)",
            24.0, 4.0 / 3.0, -0.14, 0.03, 0.001, -0.001,
        ),
        (
            "dji_mavic_phantom_pro",
            "DJI Mavic 2 Pro / Phantom 4 Pro (24-28 mm eq., moderate residual barrel distortion)",
            26.0, 3.0 / 2.0, -0.08, 0.02, 0.0005, 0.0005,
        ),
        (
            "dji_phantom3_wide_uncorrected",
            "DJI Phantom 3 / Mini wide FOV (20 mm eq., uncorrected barrel distortion)",
            20.0, 4.0 / 3.0, -0.18, 0.05, 0.001, -0.001,
        ),
        (
            "action_cam_gopro_wide",
            "Action cam / GoPro Wide FOV (16 mm eq., strong barrel distortion)",
            16.0, 4.0 / 3.0, -0.32, 0.11, 0.002, -0.002,
        ),
    ]

    results = [simulate_camera(*p) for p in presets]
    summary = {
        "model": "Brown-Conrady radial (k1, k2) + tangential (p1, p2) Jacobian area-scale",
        "recommendation": (
            "Documentation-only for standard OEM-corrected smartphone/drone JPEGs (< 1-4% mean D50 error); "
            "warn users against uncorrected wide-FOV action cams / raw drone feeds (> 10-30% error, especially with edge scale bars) "
            "and recommend pre-undistorting wide-angle imagery or enabling camera ISP correction rather than adding a full Brown-Conrady UI in v1.x."
        ),
        "cameras": results,
    }

    out_path = Path("audit/followup/lens_distortion_results.json")
    out_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Wrote {out_path}")
    for cam in results:
        c = cam["calibration_modes"]
        print(
            f"- {cam['camera']}: "
            f"center mean_bias={c['center_scale_bar']['mean_d50_bias_pct']:+.2f}% (max={c['center_scale_bar']['max_abs_error_pct']:.2f}%), "
            f"edge mean_bias={c['edge_scale_bar']['mean_d50_bias_pct']:+.2f}%, "
            f"homog mean_bias={c['four_corner_homography']['mean_d50_bias_pct']:+.2f}%"
        )


if __name__ == "__main__":
    main()
