"""Capture the exact first tile Cellpose 4 feeds the network for an image and compare it
with webGrainy's first tile (joint 1-99 normalisation, HWC->CHW, no resize).
Usage: python -I audit/parity/cpsam_tile_probe.py <cp_sam_weights> <img.jpg>
"""
import sys, numpy as np, torch
from skimage.io import imread
from cellpose import models
weights, jpg = sys.argv[1:3]
img = imread(jpg)
if img.ndim == 2: img = np.stack([img] * 3, -1)
img = img[..., :3].astype(np.uint8)
captured = {}
model = models.CellposeModel(gpu=False, pretrained_model=weights)
base = model.net
class Spy:
    def __init__(s, b): s._b = b
    def __getattr__(s, n): return getattr(s._b, n)
    def eval(s): return s
    def __call__(s, X):
        if 'X' not in captured: captured['X'] = X.float().numpy().copy()
        return torch.zeros((X.shape[0], 3) + tuple(X.shape[2:])), torch.zeros((X.shape[0], 256))
model.net = Spy(base)
model.eval(img, diameter=None, tile_overlap=0.25, normalize=True, compute_masks=False)
X = captured['X']
print('cellpose batch', X.shape, X.dtype, 'per-channel min/max/mean:',
      [(round(float(X[0, c].min()), 3), round(float(X[0, c].max()), 3), round(float(X[0, c].mean()), 3)) for c in range(X.shape[1])])
a = img.astype(np.float32); p1, p99 = np.percentile(a, [1, 99]); ours = ((a - p1) / (p99 - p1 + 1e-8)).transpose(2, 0, 1)
t = ours[:, :256, :256]
print('ours tile', t.shape, 'per-channel min/max/mean:', [(round(float(t[c].min()), 3), round(float(t[c].max()), 3), round(float(t[c].mean()), 3)) for c in range(3)])
for c in range(3):
    for c2 in range(3):
        cc = np.corrcoef(X[0, c].ravel(), t[c2].ravel())[0, 1]
        if cc > 0.9: print(f'cellpose ch{c} ~ ours ch{c2}: corr={cc:.4f}, max|diff|={np.abs(X[0, c] - t[c2]).max():.4f}')

# ---- where does Cellpose's tile 0 come from? search offsets / transposition --------
best = []
for name, src in [('ours', ours), ('ours transposed (H<->W)', ours.transpose(0, 2, 1))]:
    H, W = src.shape[1:]
    for y0 in range(0, max(1, H - 255), 8):
        for x0 in range(0, max(1, W - 255), 8):
            cc = np.corrcoef(X[0, 0].ravel(), src[0, y0:y0 + 256, x0:x0 + 256].ravel())[0, 1]
            best.append((cc, name, y0, x0))
best.sort(reverse=True)
print('best matches for cellpose tile0 ch0:', [(round(c, 4), n, y, x) for c, n, y, x in best[:3]])
