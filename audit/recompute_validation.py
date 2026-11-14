"""Audit: recompute headline metrics from the per-image table in full_dataset_validation_report.md.
Usage: python3 -I audit/recompute_validation.py full_dataset_validation_report.md"""
import sys, numpy as np
rows = []
for line in open(sys.argv[1]):
    if line.startswith('| IG2 '):
        c = [x.strip() for x in line.strip().strip('|').split('|')]
        if len(c) == 17: rows.append(c)
H = 'model split site uid shape gt pt cp v4 pq_v4_cp pq_pt_gt pq_v4_gt gtD50 ptD50 v4D50 err_gt err_pt'.split()
import collections
for model in sorted(set(r[0] for r in rows)):
    R = [dict(zip(H, r)) for r in rows if r[0] == model]
    print(f'== {model}: rows={len(R)}  split values={collections.Counter(r["split"] for r in R)}  site values={collections.Counter(r["site"] for r in R)}')
    def stats(sub, tag):
        g = [r for r in sub if float(r['gt']) > 0 and 'N/A' not in (r['gtD50'], r['v4D50'], r['ptD50'])]
        gt = np.array([float(r['gtD50']) for r in g]); v4 = np.array([float(r['v4D50']) for r in g]); pt = np.array([float(r['ptD50']) for r in g])
        e_v4 = 100 * np.abs(v4 - gt) / gt; e_pt = 100 * np.abs(pt - gt) / gt; e_v4pt = 100 * np.abs(v4 - pt) / pt
        print(f'  [{tag:10s}] n={len(g):3d}  v4 D50 MAPE vs GT={e_v4.mean():6.2f}% (med {np.median(e_v4):5.2f}, P90 {np.percentile(e_v4,90):5.1f}, >50%: {int((e_v4>50).sum())})  PT vs GT={e_pt.mean():6.2f}%  v4 vs PT={e_v4pt.mean():6.2f}% (med {np.median(e_v4pt):5.2f})  PQ v4/GT={np.mean([float(r["pq_v4_gt"]) for r in g]):.3f}  signed bias v4={np.median((v4-gt)/gt)*100:+.1f}%')
    stats(R, 'all'); stats([r for r in R if r['site'] == 'test'], 'site=test'); stats([r for r in R if r['site'] == 'train'], 'site=train')
    worst = sorted(R, key=lambda r: -float(r['err_gt']) if r['err_gt'] not in ('N/A','') else 0)[:5]
    print('  worst:', [(r['uid'][:8], r['gt'], r['v4'], r['err_gt']) for r in worst])
