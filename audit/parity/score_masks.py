"""PQ vs GT of mask files (<uid>.i32) produced by our_postprocess.mjs.
Usage: python3 -I audit/parity/score_masks.py <imgdir> name=dir [...]"""
import glob, os, sys, json
import numpy as np
from skimage.io import imread
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cpsam_parity_common import pq
imgdir = sys.argv[1]; src = dict(a.split('=', 1) for a in sys.argv[2:])
res = {k: [] for k in src}
for jpg in sorted(glob.glob(os.path.join(imgdir, '*.jpg'))):
    uid = os.path.basename(jpg)[:-4]; gt = imread(jpg[:-4] + '_mask.tif').astype(np.int64)
    for k, d in src.items():
        m = np.fromfile(os.path.join(d, uid + '.i32'), np.int32).reshape(gt.shape)
        res[k].append(round(pq(gt, m), 3))
for k, v in res.items(): print(f'{k:24s} mean PQ vs GT = {np.mean(v):.3f}  per-image {v}')
