"""Audit: generate a synthetic 'gravel' photo with known ellipse grains (ground truth JSON).
Usage: python3 -I audit/make_synthetic_gravel.py OUT_PNG OUT_JSON [seed]"""
import sys, json, numpy as np
from skimage.draw import ellipse
from skimage.io import imsave
from skimage.filters import gaussian
out_png, out_json = sys.argv[1], sys.argv[2]
rng = np.random.default_rng(int(sys.argv[3]) if len(sys.argv) > 3 else 1)
H, W = 768, 1024
img = np.full((H, W), 0.25) + rng.normal(0, 0.03, (H, W))
lab = np.zeros((H, W), np.int32); gt = []
k = 0
for _ in range(4000):
    a = rng.uniform(12, 45); b = a * rng.uniform(0.5, 0.95)
    cy, cx = rng.uniform(a, H - a), rng.uniform(a, W - a); th = rng.uniform(-np.pi, np.pi)
    rr, cc = ellipse(cy, cx, a, b, (H, W), rotation=th)
    if (lab[rr, cc] > 0).any(): continue
    k += 1; lab[rr, cc] = k
    yy, xx = rr - cy, cc - cx
    shade = rng.uniform(0.55, 0.9)
    img[rr, cc] = shade - 0.25 * np.sqrt((yy / a) ** 2 + (xx / a) ** 2)
    gt.append(dict(id=k, a_semi=a, b_semi=b, area=int(len(rr))))
img = gaussian(img, 1.0)
rgb = (np.clip(np.stack([img, img * 0.95, img * 0.85], -1), 0, 1) * 255).astype(np.uint8)
imsave(out_png, rgb)
json.dump(dict(width=W, height=H, n=k, grains=gt), open(out_json, 'w'))
print('grains', k)
