"""U-Net pipeline parity: where does webGrainy's U-Net output diverge from PyTorch?

Reference PT = upstream Cellpose 3.1.1.1 with the IG2 U-Net (IG2_full_set.200525), with the
benchmark settings (channels=[0,0], diameter=30, flow 0.4, cellprob 0, min_size 30).
Cellpose 3 then: grayscale = mean(R,G,B); 1-99 percentile normalisation; rescale by
diam_mean/diameter = 17/30 = 0.567; 224 px tiles, 10% overlap, sigmoid taper; outputs
resized back; dynamics niter = 200/rescale.

Variants (all through the SAME Cellpose 3 dynamics) and scores as in cpsam_parity.py.
Run WITHOUT python -I so PYTHONPATH can point at the cellpose 3 install:
  PYTHONPATH=<cp3 lib> python validation/parity/unet_parity.py <unet_weights> <unet.onnx> <imgdir> <oursdir> <out.json>
"""
import glob, json, os, sys, time
import numpy as np, torch, onnxruntime as ort
from skimage.io import imread
from cellpose import models, dynamics, transforms
sys.path.insert(0, os.path.dirname(__file__))
weights, onnx_path, imgdir, oursdir, out_path = sys.argv[1:6]
torch.set_num_threads(os.cpu_count())
sess = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
IN = sess.get_inputs()[0].name
DIAMETER = 30.0

def onnx_run(x):  # (B,2,H,W) -> (B,3,H,W), H,W multiples of 16
    return np.concatenate([sess.run(None, {IN: x[i:i+1].astype(np.float32)})[0] for i in range(x.shape[0])], 0)

class OnnxNet:
    """Wraps the real Cellpose net: same attributes (nout, diam_mean, ...) but the forward
    pass runs our ONNX model."""
    def __init__(self, base): self._base = base
    def __getattr__(self, name): return getattr(self._base, name)
    dtype = torch.float32
    def eval(self): return self
    def __call__(self, X):
        y = onnx_run(X.float().numpy()); return torch.from_numpy(y), torch.zeros((X.shape[0], 256))

def load_rgb(p):
    a = imread(p)
    if a.ndim == 2: a = np.stack([a] * 3, -1)
    return a[..., :3].astype(np.uint8)

from cpsam_parity_common import pq  # noqa: E402

def norm99(g):
    p1, p99 = np.percentile(g, [1, 99]); return (g - p1) / (p99 - p1 + 1e-8)
def gray_luma(img):  # what webGrainy does
    return np.round(0.299 * img[..., 0] + 0.587 * img[..., 1] + 0.114 * img[..., 2]).astype(np.float32)
def gray_mean(img):  # what Cellpose 3 does for channels=[0,0]
    return img.astype(np.float32).mean(-1)

def run_full(g):  # webGrainy style: whole image, reflect-pad to /16
    H, W = g.shape; ph, pw = (-H) % 16, (-W) % 16
    x = np.zeros((1, 2, H + ph, W + pw), np.float32); x[0, 0] = np.pad(g, ((0, ph), (0, pw)), mode='reflect')
    return onnx_run(x)[0][:, :H, :W]
def resized(fn, g, scale):  # run at a smaller size, resize outputs back (as Cellpose does)
    H, W = g.shape
    gs = transforms.resize_image(g, Ly=int(round(H * scale)), Lx=int(round(W * scale)))
    y = fn(gs)
    return transforms.resize_image(y.transpose(1, 2, 0), Ly=H, Lx=W).transpose(2, 0, 1)

from cellpose import core as cp_core  # noqa: E402
_onnx_net = None
def run_cp_tiles(g):  # Cellpose 3 tiling: 224 px tiles, 10% overlap, sigmoid taper, per-tile style
    x = np.stack([g, np.zeros_like(g)], -1)[None].astype(np.float32)
    y, _ = cp_core.run_net(_onnx_net, x, batch_size=8, augment=False, tile_overlap=0.1, bsize=224)
    return y[0].transpose(2, 0, 1)

SCALE = 17.0 / DIAMETER
VARIANTS = {
    'V0_ours_numpy (luma, full size, whole image)': lambda img: run_full(norm99(gray_luma(img))),
    'V1 mean gray': lambda img: run_full(norm99(gray_mean(img))),
    'V2 resize x0.567': lambda img: resized(run_full, norm99(gray_luma(img)), SCALE),
    'V3 mean gray + resize x0.567': lambda img: resized(run_full, norm99(gray_mean(img)), SCALE),
    'V4 Cellpose tiling (full size)': lambda img: run_cp_tiles(norm99(gray_luma(img))),
    'V5 resize x0.567 + Cellpose tiling': lambda img: resized(run_cp_tiles, norm99(gray_luma(img)), SCALE),
    'V6 mean gray + resize + Cellpose tiling (= upstream)': lambda img: resized(run_cp_tiles, norm99(gray_mean(img)), SCALE),
}

model = models.CellposeModel(gpu=False, pretrained_model=weights)
pt_net = model.net
_onnx_net = OnnxNet(pt_net)
niter = int(200 / SCALE)
def masks_from(dP, cp):
    m = dynamics.compute_masks(dP, cp, niter=niter, cellprob_threshold=0.0, flow_threshold=0.4,
                               min_size=30, max_size_fraction=0.4)
    return m[0] if isinstance(m, tuple) else m

results = []
for jpg in sorted(glob.glob(os.path.join(imgdir, '*.jpg'))):
    uid = os.path.basename(jpg)[:-4]
    gt = imread(jpg[:-4] + '_mask.tif').astype(np.int64)
    img = load_rgb(jpg); H, W = img.shape[:2]
    rec = {'uid': uid, 'shape': [H, W], 'n_gt': int(len(np.unique(gt)) - 1), 'variants': {}}
    outs = {}
    t = time.time(); model.net = pt_net
    m_pt, fl, _ = model.eval(img, channels=[0, 0], diameter=DIAMETER, flow_threshold=0.4,
                             cellprob_threshold=0.0, min_size=30, normalize=True)
    outs['PT'] = (fl[1].astype(np.float32), fl[2].astype(np.float32)); rec['pt_seconds'] = round(time.time() - t, 1)
    model.net = OnnxNet(pt_net)
    _, fl2, _ = model.eval(img, channels=[0, 0], diameter=DIAMETER, flow_threshold=0.4,
                           cellprob_threshold=0.0, min_size=30, normalize=True)
    outs['ONNX@CP (our model in Cellpose pipeline)'] = (fl2[1].astype(np.float32), fl2[2].astype(np.float32))
    model.net = pt_net
    f = os.path.join(oursdir, uid + '.f32')
    if os.path.exists(f):
        a = np.fromfile(f, np.float32).reshape(3, H, W); outs['OURS (webGrainy dist, real)'] = (a[:2], a[2])
    for name, fn in VARIANTS.items():
        y = fn(img); outs[name] = (y[:2], y[2])
    dP0, cp0 = outs['PT']
    for name, (dP, cp) in outs.items():
        mk = m_pt if name == 'PT' else masks_from(dP, cp)
        mag0 = np.linalg.norm(dP0, axis=0); mag = np.linalg.norm(dP, axis=0)
        cos = (dP0 * dP).sum(0) / (mag0 * mag + 1e-6); fg = cp0 > 0
        rec['variants'][name] = {
            'pq_vs_gt': round(pq(gt, mk), 4), 'pq_vs_pt': round(pq(m_pt, mk), 4),
            'n_masks': int(len(np.unique(mk)) - 1),
            'cellprob_corr_vs_pt': round(float(np.corrcoef(cp0.ravel(), cp.ravel())[0, 1]), 4),
            'flow_cos_fg_vs_pt': round(float(cos[fg].mean()) if fg.any() else float('nan'), 4),
        }
    results.append(rec); print(json.dumps(rec), flush=True)
json.dump(results, open(out_path, 'w'), indent=1)
