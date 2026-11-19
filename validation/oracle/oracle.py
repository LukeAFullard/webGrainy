"""Audit: independent numpy/skimage oracle checks against validation/oracle/ts_dump.json.
Usage: python3 -I validation/oracle/oracle.py validation/oracle/ts_dump.json"""
import sys, json, math, numpy as np
from skimage.measure import regionprops, label
from scipy.spatial import ConvexHull
d = json.load(open(sys.argv[1]))
P = [5, 10, 16, 25, 50, 75, 84, 90, 95]
# 1. percentiles: np.interp in log2(size) on the midpoint CDF (shipped rule since commit 48d64bc)
worst = 0.0
for c in d['percentiles']:
    v, w = np.array(c['v'], float), np.array(c['w'], float)
    o = np.argsort(v, kind='stable'); v, w = v[o], w[o]
    cdf = (np.cumsum(w) - 0.5 * w) / w.sum()
    for p in P:
        ref = 2 ** np.interp(p / 100, cdf, np.log2(v)); got = c['r'][f'D{p}']
        worst = max(worst, abs(ref - got) / max(1e-12, abs(ref)))
print(f'[percentiles] {len(d["percentiles"])} cases, worst rel err vs log2 np.interp = {worst:.2e}')
# 2. Folk & Ward from scratch
fw, psd = d['folkward']['fw'], d['folkward']['psd']
phi = {p: -math.log2(psd[f'D{100-p}']) for p in [5, 16, 25, 50, 75, 84, 95]}
M = (phi[16] + phi[50] + phi[84]) / 3
S = (phi[84] - phi[16]) / 4 + (phi[95] - phi[5]) / 6.6
Sk = (phi[16] + phi[84] - 2 * phi[50]) / (2 * (phi[84] - phi[16])) + (phi[5] + phi[95] - 2 * phi[50]) / (2 * (phi[95] - phi[5]))
K = (phi[95] - phi[5]) / (2.44 * (phi[75] - phi[25]))
print(f'[folk-ward] ours M={M:.6f} S={S:.6f} Sk={Sk:.6f} K={K:.6f} | ts M={fw["meanPhi"]:.6f} S={fw["sortingPhi"]:.6f} Sk={fw["skewnessPhi"]:.6f} K={fw["kurtosisPhi"]:.6f} | label={fw["skewnessLabel"]}')
vals = np.array(d['folkward']['v']); print(f'[folk-ward] sample: mean-median in mm = {vals.mean()-np.median(vals):+.3f} (tail toward coarse => phi skew should be negative/coarse)')
# 3. morphometrics vs skimage + min Feret
W, H = d['morph']['W'], d['morph']['H']
def min_feret(mask):
    ys, xs = np.nonzero(mask)
    pts = np.concatenate([np.stack([xs + dx, ys + dy], 1) for dx in (-.5, .5) for dy in (-.5, .5)])
    hull = pts[ConvexHull(pts).vertices]; best = 1e9; maxf = 0
    for i in range(len(hull)):
        e = hull[(i + 1) % len(hull)] - hull[i]; n = np.array([-e[1], e[0]]) / np.linalg.norm(e)
        proj = hull @ n; best = min(best, proj.max() - proj.min())
    for a in np.linspace(0, np.pi, 720, endpoint=False):
        proj = hull @ np.array([np.cos(a), np.sin(a)]); maxf = max(maxf, proj.max() - proj.min())
    return best, maxf
print('[morph] shape | ts b (moment) | skimage minor | minFeret | b/minFeret | ts a | maxFeret')
for name, r in d['morph']['res'].items():
    m = np.array(r['mask']).reshape(H, W)
    rp = regionprops(label(m))[0]
    mf, Mf = min_feret(m)
    print(f'  {name:20s} {r["b"]:8.2f} {rp.axis_minor_length:8.2f} {mf:8.2f} {r["b"]/mf:6.3f} {r["a"]:8.2f} {Mf:8.2f}  orient ts={r["orient"]:.4f} sk={rp.orientation:.4f}')
# 4. fp16 RNE
x = np.array([np.nan if s == 'NaN' else np.inf if s == 'Inf' else -np.inf if s == '-Inf' else s for s in d['fp16']['x']], np.float32)
ref = x.astype(np.float16).view(np.uint16).astype(np.int64)
got = np.array(d['fp16']['h'], np.int64)
nan = np.isnan(x); bad = (ref != got) & ~nan
nan_ok = np.all(((got[nan] & 0x7c00) == 0x7c00) & ((got[nan] & 0x3ff) != 0))
print(f'[fp16] {len(x)} values, mismatches vs numpy float16 (non-NaN) = {int(bad.sum())}, NaN encoded as NaN: {bool(nan_ok)}')
for i in np.nonzero(bad)[0][:8]: print(f'    x={x[i]!r} ts=0x{got[i]:04x} np=0x{ref[i]:04x}')
# 5. tiling coverage + reflect
for t in d['tiling']['r']:
    L, st = t['L'], t['starts']; cov = np.zeros(max(L, 256), int)
    for s in st: cov[s:s + 256] += 1
    ok = cov[:L].min() > 0 and (st[-1] + 256 >= L if L >= 256 else True) and all(s >= 0 for s in st)
    print(f'  [tiles] L={L:5d} starts={st if len(st) < 8 else str(st[:3])+"..."+str(st[-2:])} covered={ok} last_end={st[-1]+256}')
print(f'[hann] min window weight = {d["tiling"]["winMin"]:.2e}; np.clip(np.hanning(256),1e-3,1) match = {np.allclose(np.clip(np.hanning(256),1e-3,1), d["tiling"]["win0"], atol=1e-6) or np.allclose(np.outer(np.clip(np.hanning(256),1e-3,1),np.clip(np.hanning(256),1e-3,1))[0], d["tiling"]["win0"], atol=1e-6)}')
refl_ref = [int(np.pad(np.arange(5), 12, mode="reflect")[i + 12]) for i in range(-12, 25 - 12)]
print(f'[reflect] matches np.pad reflect over [-12,13): {d["tiling"]["refl"][:25] == refl_ref}')
# 6. homography
for c in d['homography']:
    err = max(math.hypot(m['x'] - t['x'], m['y'] - t['y']) for m, t in zip(c['mapped'], c['dst']))
    import numpy.linalg as la
    A = []
    for s, t in zip(c['src'], c['dst']):
        X, Y, u, v = s['x'], s['y'], t['x'], t['y']
        A += [[X, Y, 1, 0, 0, 0, -u * X, -u * Y, -u], [0, 0, 0, X, Y, 1, -v * X, -v * Y, -v]]
    h = la.svd(np.array(A))[2][-1]; h = h / h[-1]
    print(f'[homography] max reprojection err = {err:.2e} px; |H_ts - H_svd|max = {np.abs(np.array(c["h"]) - h).max():.2e}; collinear input -> {c["degenerate"][:80]}')
# 7. Feret (added after F-06 fix): TS rotating calipers vs oracle
if 'feret' in d:
    print('[feret] shape | ts minFeret | oracle | ts maxFeret | oracle')
    for name, r in d['morph']['res'].items():
        m = np.array(r['mask']).reshape(H, W); mf, Mf = min_feret(m); f = d['feret'][name]
        print(f'  {name:20s} {f["minFeret"]:8.3f} {mf:8.3f} {f["maxFeret"]:8.3f} {Mf:8.3f}')
