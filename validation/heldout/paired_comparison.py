"""Paired comparison of D50 absolute percentage error (APE) between engines on the
same held-out images (validation/heldout/heldout_results_per_image.csv).

Usage: python3 -I validation/heldout/paired_comparison.py validation/heldout/heldout_results_per_image.csv
Reports, per model, the mean paired APE difference (A - B) with a 10,000-sample
percentile bootstrap 95% CI (seed 0), win counts, and an exact two-sided sign test.
A CI that includes 0 means the engines are not distinguishable on this sample.
"""
import csv, sys
from math import comb
import numpy as np

rows = list(csv.DictReader(open(sys.argv[1])))

def ape(r, k='D50'):
    g = float(r[f'gt_b_{k}']); p = float(r[f'pred_b_{k}'])
    return 100 * abs(p - g) / g

def series(model, engine):
    s = sorted((r for r in rows if r['model'] == model and r['engine'] == engine), key=lambda r: r['uid'])
    return (
        [r['uid'] for r in s],
        np.array([ape(r) for r in s]),
        np.array([float(r['pq_vs_gt']) for r in s]),
        np.array([float(r['pq_vs_pt']) for r in s]),
    )

def sign_test(wins, losses):
    n = wins + losses; k = min(wins, losses)
    return min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)

rng = np.random.default_rng(0)
for model in ('unet', 'cpsam'):
    for a, b in (
        ('ts_v41_guard100', 'pytorch_ref'),
        ('ts_v41_guard015', 'pytorch_ref'),
        ('ts_v41_guard100', 'ts_v41_guard015'),
        ('ts_v41_guard040', 'pytorch_ref'),
        ('ts_v41_guard040', 'ts_v41_guard100'),
        ('ts_v41_guard040', 'ts_v41_guard015'),
        ('ts_cellpose_guard040', 'pytorch_ref'),
        ('ts_cellpose_guard040', 'ts_v41_guard040'),
    ):
        ua, xa, pa, pta = series(model, a); ub, xb, pb, ptb = series(model, b)
        if not ua or not ub:
            continue
        assert ua == ub, 'image sets differ'
        d = xa - xb
        boots = np.array([rng.choice(d, d.size).mean() for _ in range(10000)])
        lo, hi = np.percentile(boots, [2.5, 97.5])
        wins, losses = int((d < 0).sum()), int((d > 0).sum())
        verdict = 'NOT distinguishable' if lo <= 0 <= hi else ('A better' if hi < 0 else 'B better')
        print(f'{model:5s} A={a:20s} B={b:20s} n={d.size}  mean dAPE={d.mean():+6.2f} pp  95% CI [{lo:+6.2f}, {hi:+6.2f}]  '
              f'A better on {wins}/{d.size} (ties {d.size - wins - losses})  sign-test p={sign_test(wins, losses):.3f}  '
              f'PQ_GT A={pa.mean():.3f} B={pb.mean():.3f}  PQ_PT A={pta.mean():.3f} B={ptb.mean():.3f}  -> {verdict}')
