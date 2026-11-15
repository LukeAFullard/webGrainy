"""K1 investigation: why is photo D50 ~40% finer than the field count?

Compares the n = 251 field b-axes (dmair1989/imagegrains demo_data/K1_field_measurement.csv,
values in cm) with webGrainy grains from K1_C2_385 + K1_C3_0449 at 0.39 mm/px, under
several sampling / weighting schemes, including the upstream ImageGrains demo recipe
(centroid edge filter 21 %, b > 8 px, 18 px Wolman grid, unique grains, by number).

Usage: python3 -I audit/k1/analyze_k1.py <field.csv> <prefix> [<prefix> ...]
  where <prefix>_grains.json and <prefix>_masks.i32 come from run_engine_k1.mjs.
"""
import json, sys
import numpy as np

MM_PER_PX = 0.39
field_mm = np.loadtxt(sys.argv[1], skiprows=1) * 10.0  # cm -> mm
P = [16, 50, 84]

def pct(v, w=None):
    v = np.asarray(v, float)
    if w is None:
        return np.percentile(v, P)
    o = np.argsort(v); v, w = v[o], np.asarray(w, float)[o]
    cdf = (np.cumsum(w) - 0.5 * w) / w.sum()
    return np.interp(np.array(P) / 100, cdf, v)

def boot_ci(v, w=None, n=2000, seed=0):
    rng = np.random.default_rng(seed); v = np.asarray(v); res = []
    for _ in range(n):
        i = rng.integers(0, len(v), len(v))
        res.append(pct(v[i], None if w is None else np.asarray(w)[i])[1])
    return np.percentile(res, [2.5, 97.5])

def load(prefix):
    g = json.load(open(f'{prefix}_grains.json'))
    m = np.fromfile(f'{prefix}_masks.i32', dtype=np.int32).reshape(g['H'], g['W'])
    return g, m

def wolman_hits(masks, grid, edge, unique):
    h, w = masks.shape
    ys = np.round(np.arange(h * edge, h - h * edge, grid)).astype(int)
    xs = np.round(np.arange(w * edge, w - w * edge, grid)).astype(int)
    labels = masks[np.ix_(ys, xs)].ravel()
    labels = labels[labels > 0]
    return (np.unique(labels) if unique else labels), len(ys) * len(xs)

rows = []
def add(name, v_px, w=None, note=''):
    v = np.asarray(v_px, float) * MM_PER_PX
    d = pct(v, w); lo, hi = boot_ci(v, w)
    rows.append((name, len(v), d, (lo, hi), note))

fd = pct(field_mm); flo, fhi = boot_ci(field_mm)
print(f'field (n={len(field_mm)}): D16/D50/D84 = {fd[0]:.1f}/{fd[1]:.1f}/{fd[2]:.1f} mm  (D50 95% CI {flo:.1f}-{fhi:.1f}); min {field_mm.min():.0f} mm')

for kind in sorted({p.split('/')[-1].split('_')[0] for p in sys.argv[2:]}):
    prefixes = [p for p in sys.argv[2:] if p.split('/')[-1].startswith(kind + '_')]
    G, b_all, a_all, area_all, mf_all, border = [], [], [], [], [], []
    grid_unique, grid_dup, grid_dup_byimg = [], [], []
    for p in prefixes:
        g, m = load(p)
        gr = g['grains']; byid = {x['id']: x for x in gr}
        b_all += [x['b'] for x in gr]; area_all += [x['area'] for x in gr]
        mf_all += [x['minFeret'] for x in gr]; border += [x['border'] for x in gr]
        H, W = g['H'], g['W']
        # upstream recipe: centroid edge filter 0.21, b > 8 px, then 18 px Wolman grid over the
        # same edge-trimmed window, unique grains, percentiles by number.
        keep = {x['id'] for x in gr if H * .21 < x['cy'] < H * .79 and W * .21 < x['cx'] < W * .79 and x['b'] > 8}
        m2 = np.where(np.isin(m, list(keep)), m, 0)
        u, nodes = wolman_hits(m2, 18, .21, unique=True)
        grid_unique += [byid[i]['b'] for i in u]
        d, _ = wolman_hits(np.where(np.isin(m, [x['id'] for x in gr if not x['border']]), m, 0), 18, .0, unique=False)
        grid_dup += [byid[i]['b'] for i in d]
    b = np.array(b_all); area = np.array(area_all); mf = np.array(mf_all); interior = ~np.array(border)
    trunc_px = field_mm.min() / MM_PER_PX
    print(f'\n=== {kind}: {len(b)} grains ({interior.sum()} interior); field minimum {field_mm.min():.0f} mm = {trunc_px:.0f} px ===')
    add('app default: interior, area-weighted b', b[interior], area[interior])
    add('interior, by number (all grains)', b[interior])
    add('true grid-by-number (18 px grid, repeats counted)', grid_dup)
    add('upstream demo recipe (edge .21, b>8px, 18 px grid, unique, by number)', grid_unique)
    t = interior & (b * MM_PER_PX >= field_mm.min())
    add(f'truncated at field min (b >= {field_mm.min():.0f} mm), by number', b[t])
    add(f'truncated at field min, area-weighted', b[t], area[t])
    add('truncated at field min, by number, minFeret', mf[interior & (mf * MM_PER_PX >= field_mm.min())])
    for name, n, d, (lo, hi), note in rows:
        print(f'  {name:72s} n={n:5d}  D16/D50/D84 = {d[0]:5.1f}/{d[1]:5.1f}/{d[2]:5.1f} mm  D50 CI [{lo:4.1f},{hi:4.1f}]  D50 vs field {100*(d[1]/fd[1]-1):+6.1f}%')
    rows.clear()

# ---- Sensitivity: truncation threshold sweep (area-weighted = grid-by-number) ----------
print('\n=== truncation sweep (interior grains, area-weighted b; equivalent to a grid count that skips grains below the cutoff) ===')
for kind in sorted({p.split('/')[-1].split('_')[0] for p in sys.argv[2:]}):
    prefixes = [p for p in sys.argv[2:] if p.split('/')[-1].startswith(kind + '_')]
    gr = [x for p in prefixes for x in load(p)[0]['grains'] if not x['border']]
    b = np.array([x['b'] for x in gr]) * MM_PER_PX; area = np.array([x['area'] for x in gr], float)
    for cut in [0, 8, 10, 11, 12, 13, 14, 15, 16, 18, 20]:
        t = b >= cut
        d = pct(b[t], area[t]); share = 100 * area[~t].sum() / area.sum()
        print(f'  {kind:5s} cutoff {cut:2d} mm: bed area below cutoff {share:5.1f}%  D16/D50/D84 = {d[0]:5.1f}/{d[1]:5.1f}/{d[2]:5.1f}  vs field {100*(d[0]/fd[0]-1):+6.1f}% / {100*(d[1]/fd[1]-1):+6.1f}% / {100*(d[2]/fd[2]-1):+6.1f}%')
