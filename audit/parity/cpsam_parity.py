"""Cellpose-SAM pipeline parity: where does webGrainy's output diverge from PyTorch?

For each image, network outputs (flows dY,dX + cellprob) are produced by:
  PT        upstream PyTorch Cellpose-SAM (cellpose 4.1, benchmark settings:
            diameter=None, tile_overlap=0.25, normalize=True, bfloat16 default)
  ONNX@CP   our ONNX model inside Cellpose's own normalisation + tiling + blending
            (net swapped)  -> isolates model/export differences
  OURS      webGrainy's real output (dumped by dump_ours.mjs from dist/)
  V-*       numpy re-implementations of our pipeline with ONE change each
and every variant is turned into masks with the SAME Cellpose dynamics, then scored:
  - agreement with PT outputs (cellprob corr, flow-direction agreement)
  - panoptic quality (PQ) vs hand-digitised GT masks.

Usage (venv with cellpose 4.1, onnxruntime):
  python -I audit/parity/cpsam_parity.py <cp_sam_weights> <cpsam.onnx> <imgdir> <oursdir> <out.json>
"""
import glob, json, os, sys, time
import numpy as np, torch, onnxruntime as ort
from skimage.io import imread
from cellpose import models, dynamics, transforms

weights, onnx_path, imgdir, oursdir, out_path = sys.argv[1:6]
torch.set_num_threads(os.cpu_count())
sess = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
IN = sess.get_inputs()[0].name

def onnx_run(x):  # x: (B,3,256,256) float32 -> (B,3,256,256) float32
    ys = [sess.run(None, {IN: x[i:i+1].astype(np.float16)})[0].astype(np.float32) for i in range(x.shape[0])]
    return np.concatenate(ys, 0)

class OnnxNet:
    """Drop-in for cellpose's net: same call contract as core._forward expects."""
    device = torch.device('cpu'); dtype = torch.float32
    def eval(self): return self
    def __call__(self, X):
        y = onnx_run(X.float().numpy())
        return torch.from_numpy(y), torch.zeros((X.shape[0], 256))

def load_rgb(p):
    a = imread(p)
    if a.ndim == 2: a = np.stack([a] * 3, -1)
    return a[..., :3].astype(np.uint8)

def pq(gt, pred):
    gt_ids = np.unique(gt); gt_ids = gt_ids[gt_ids > 0]
    pr_ids = np.unique(pred); pr_ids = pr_ids[pr_ids > 0]
    if len(gt_ids) == 0 and len(pr_ids) == 0: return 1.0
    m = (gt > 0) | (pred > 0)
    pairs, counts = np.unique(np.stack([gt[m], pred[m]]), axis=1, return_counts=True)
    ga = dict(zip(*np.unique(gt[gt > 0], return_counts=True)))
    pa = dict(zip(*np.unique(pred[pred > 0], return_counts=True)))
    ious = []; matched_g = set(); matched_p = set()
    for (g, p), inter in zip(pairs.T, counts):
        if g == 0 or p == 0: continue
        iou = inter / (ga[g] + pa[p] - inter)
        if iou > 0.5: ious.append(iou); matched_g.add(g); matched_p.add(p)
    tp = len(ious); fp = len(pr_ids) - len(matched_p); fn = len(gt_ids) - len(matched_g)
    return float(sum(ious) / (tp + 0.5 * fp + 0.5 * fn)) if (tp + fp + fn) else 1.0

def masks_from(dP, cp):
    m = dynamics.compute_masks(dP, cp, niter=200, cellprob_threshold=0.0, flow_threshold=0.4,
                               min_size=30, max_size_fraction=0.4)
    return m[0] if isinstance(m, tuple) else m

# ---- numpy re-implementation of webGrainy's pipeline, with switchable choices ----
def norm_joint(img):
    a = img.astype(np.float32); p1, p99 = np.percentile(a, [1, 99]); return (a - p1) / (p99 - p1 + 1e-8)
def norm_perchannel(img):
    return transforms.normalize_img(img.astype(np.float32), normalize=True)  # Cellpose's own per-channel 1-99
def hann_win(t=256):
    w = np.clip(np.hanning(t), 1e-3, 1.0); return np.outer(w, w).astype(np.float32)
def cp_taper(t=256):
    return transforms._taper_mask(ly=t, lx=t).astype(np.float32)
def starts_ours(L, t=256, stride=192):
    if L <= t: return [0]
    s = list(range(0, L - t, stride)); s.append(L - t); return sorted(set(s))
def starts_cp(L, t=256, overlap=0.25):
    if L <= t: return [0]
    n = int(np.ceil((1 + 2 * overlap) * L / t)); return list(np.linspace(0, L - t, n).astype(int))
def run_tiled(nimg, win, starts):
    H, W, _ = nimg.shape
    Hp, Wp = max(H, 256), max(W, 256)
    x = np.pad(nimg, ((0, Hp - H), (0, Wp - W), (0, 0)), mode='reflect').transpose(2, 0, 1)
    acc = np.zeros((3, Hp, Wp), np.float32); wsum = np.zeros((Hp, Wp), np.float32)
    for y0 in starts(Hp):
        for x0 in starts(Wp):
            y = onnx_run(x[None, :, y0:y0+256, x0:x0+256])[0]
            acc[:, y0:y0+256, x0:x0+256] += y * win; wsum[y0:y0+256, x0:x0+256] += win
    out = acc / wsum[None]; return out[:, :H, :W]

VARIANTS = {
    'V0_ours_numpy (joint norm, hann, stride)': (norm_joint, hann_win, starts_ours),
    'V1 per-channel norm':                       (norm_perchannel, hann_win, starts_ours),
    'V2 per-channel + cp taper':                 (norm_perchannel, cp_taper, starts_ours),
    'V3 per-channel + cp taper + cp starts':     (norm_perchannel, cp_taper, starts_cp),
}

model = models.CellposeModel(gpu=False, pretrained_model=weights)
pt_net = model.net
results = []
for jpg in sorted(glob.glob(os.path.join(imgdir, '*.jpg'))):
    uid = os.path.basename(jpg)[:-4]
    gt = imread(jpg[:-4] + '_mask.tif').astype(np.int64)
    img = load_rgb(jpg); H, W = img.shape[:2]
    rec = {'uid': uid, 'shape': [H, W], 'n_gt': int(len(np.unique(gt)) - 1), 'variants': {}}
    outs = {}
    t = time.time(); model.net = pt_net
    m_pt, fl, _ = model.eval(img, diameter=None, flow_threshold=0.4, cellprob_threshold=0.0,
                             min_size=30, tile_overlap=0.25, normalize=True)
    outs['PT'] = (fl[1].astype(np.float32), fl[2].astype(np.float32)); rec['pt_seconds'] = round(time.time() - t, 1)
    model.net = OnnxNet()
    _, fl2, _ = model.eval(img, diameter=None, flow_threshold=0.4, cellprob_threshold=0.0,
                           min_size=30, tile_overlap=0.25, normalize=True)
    outs['ONNX@CP (our model in Cellpose pipeline)'] = (fl2[1].astype(np.float32), fl2[2].astype(np.float32))
    model.net = pt_net
    ours_f = os.path.join(oursdir, uid + '.f32')
    if os.path.exists(ours_f):
        a = np.fromfile(ours_f, np.float32).reshape(3, H, W)
        outs['OURS (webGrainy dist, real)'] = (a[:2], a[2])
    for name, (nf, win, st) in VARIANTS.items():
        y = run_tiled(nf(img), win(), st); outs[name] = (y[:2], y[2])
    dP0, cp0 = outs['PT']
    for name, (dP, cp) in outs.items():
        mk = m_pt if name == 'PT' else masks_from(dP, cp)
        mag0 = np.linalg.norm(dP0, axis=0); mag = np.linalg.norm(dP, axis=0)
        cos = (dP0 * dP).sum(0) / (mag0 * mag + 1e-6); fg = cp0 > 0
        rec['variants'][name] = {
            'pq_vs_gt': round(pq(gt, mk), 4),
            'pq_vs_pt': round(pq(m_pt, mk), 4),
            'n_masks': int(len(np.unique(mk)) - 1),
            'cellprob_corr_vs_pt': round(float(np.corrcoef(cp0.ravel(), cp.ravel())[0, 1]), 4),
            'cellprob_mae_vs_pt': round(float(np.abs(cp0 - cp).mean()), 4),
            'flow_cos_fg_vs_pt': round(float(cos[fg].mean()) if fg.any() else float('nan'), 4),
        }
    results.append(rec)
    print(json.dumps(rec), flush=True)
json.dump(results, open(out_path, 'w'), indent=1)
