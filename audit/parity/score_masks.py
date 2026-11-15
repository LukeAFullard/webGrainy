"""PQ vs GT of mask files (<uid>.i32) produced by our_postprocess.mjs.
Usage: python3 -I audit/parity/score_masks.py <imgdir> name=dir [...]"""
import glob, os, sys, json
import numpy as np
from skimage.io import imread
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cpsam_parity_common import pq
from skimage.measure import regionprops

def d50(labels, margin=2):
    """Area-weighted D50 of the ellipse minor axis, border grains excluded (as the benchmark)."""
    H, W = labels.shape; b = []; w = []
    for r in regionprops(labels):
        y0, x0, y1, x1 = r.bbox
        if y0 < margin or x0 < margin or y1 > H - margin or x1 > W - margin: continue
        b.append(r.axis_minor_length); w.append(r.area)
    if not b: return float('nan')
    o = np.argsort(b); b = np.array(b)[o]; w = np.array(w, float)[o]
    cdf = (np.cumsum(w) - 0.5 * w) / w.sum(); return float(np.interp(0.5, cdf, b))
imgdir = sys.argv[1]; src = dict(a.split('=', 1) for a in sys.argv[2:])
res = {k: [] for k in src}; err = {k: [] for k in src}
for jpg in sorted(glob.glob(os.path.join(imgdir, '*.jpg'))):
    uid = os.path.basename(jpg)[:-4]; gt = imread(jpg[:-4] + '_mask.tif').astype(np.int64)
    for k, d in src.items():
        m = np.fromfile(os.path.join(d, uid + '.i32'), np.int32).reshape(gt.shape)
        res[k].append(round(pq(gt, m), 3))
        g = d50(gt); e = d50(m)
        err[k].append(round(100 * abs(e - g) / g, 1) if np.isfinite(e) and np.isfinite(g) else float('nan'))
for k, v in res.items():
    print(f'{k:24s} mean PQ vs GT = {np.mean(v):.3f}  per-image {v}')
    print(f'{"":24s} D50 abs % error: mean {np.nanmean(err[k]):.1f}, median {np.nanmedian(err[k]):.1f}  per-image {err[k]}')
