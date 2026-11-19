"""Score dumped network outputs (<uid>.f32 = [flowY, flowX, cellprob]) against PyTorch
Cellpose and hand-digitised GT, using the same Cellpose dynamics for every source.

Usage (cellpose 4 env for cpsam; PYTHONPATH=<cellpose 3> for unet; run without -I):
  python validation/parity/score_dirs.py <unet|cpsam> <weights> <imgdir> <out.json> name=dir [name=dir ...]
"""
import glob, json, os, sys
import numpy as np, torch
from skimage.io import imread
from cellpose import models, dynamics
sys.path.insert(0, os.path.dirname(__file__))
from cpsam_parity_common import pq  # noqa: E402
kind, weights, imgdir, out = sys.argv[1:5]
sources = dict(a.split('=', 1) for a in sys.argv[5:])
torch.set_num_threads(os.cpu_count())
model = models.CellposeModel(gpu=False, pretrained_model=weights)
niter = int(200 / (17 / 30)) if kind == 'unet' else 200

def masks_from(dP, cp):
    m = dynamics.compute_masks(dP, cp, niter=niter, cellprob_threshold=0.0, flow_threshold=0.4, min_size=30, max_size_fraction=0.4)
    return m[0] if isinstance(m, tuple) else m

rows = []
for jpg in sorted(glob.glob(os.path.join(imgdir, '*.jpg'))):
    uid = os.path.basename(jpg)[:-4]
    img = imread(jpg)
    if img.ndim == 2: img = np.stack([img] * 3, -1)
    img = img[..., :3].astype(np.uint8); H, W = img.shape[:2]
    gt = imread(jpg[:-4] + '_mask.tif').astype(np.int64)
    if kind == 'unet':
        m_pt, fl, _ = model.eval(img, channels=[0, 0], diameter=30.0, flow_threshold=0.4, cellprob_threshold=0.0, min_size=30, normalize=True)
    else:
        m_pt, fl, _ = model.eval(img, diameter=None, flow_threshold=0.4, cellprob_threshold=0.0, min_size=30, tile_overlap=0.25, normalize=True)
    dP0 = fl[1].astype(np.float32); cp0 = fl[2].astype(np.float32)
    rec = {'uid': uid, 'PT': {'pq_vs_gt': round(pq(gt, m_pt), 4)}}
    for name, d in sources.items():
        a = np.fromfile(os.path.join(d, uid + '.f32'), np.float32).reshape(3, H, W)
        mk = masks_from(a[:2], a[2])
        mag0 = np.linalg.norm(dP0, axis=0); mag = np.linalg.norm(a[:2], axis=0)
        cos = (dP0 * a[:2]).sum(0) / (mag0 * mag + 1e-6); fg = cp0 > 0
        rec[name] = {'pq_vs_gt': round(pq(gt, mk), 4), 'pq_vs_pt': round(pq(m_pt, mk), 4),
                     'flow_cos_fg_vs_pt': round(float(cos[fg].mean()) if fg.any() else float('nan'), 4),
                     'cellprob_max_abs_vs_pt': round(float(np.abs(cp0 - a[2]).max()), 4)}
    rows.append(rec); print(json.dumps(rec), flush=True)
names = ['PT'] + list(sources)
summary = {n: {k: round(float(np.mean([r[n][k] for r in rows])), 4) for k in rows[0][n]} for n in names}
print('SUMMARY', json.dumps(summary))
json.dump({'rows': rows, 'summary': summary}, open(out, 'w'), indent=1)
