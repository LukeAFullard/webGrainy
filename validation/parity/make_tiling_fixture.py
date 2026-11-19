"""Generate reference values from Cellpose's own tiling code for tests/cellposeTiling.test.ts.
Run with PYTHONPATH pointing at cellpose 3 (v3) and again with cellpose 4 (v4).
Usage: python validation/parity/make_tiling_fixture.py <v3|v4> <out.json>
"""
import json, sys
import numpy as np
from cellpose import transforms
ver, out = sys.argv[1:3]
rng = np.random.default_rng(0)
fx = {'version': ver, 'taper': {}, 'pad': {}, 'starts': {}, 'resize': [], 'tiled': []}
for ly, lx in [(224, 224), (256, 256), (200, 150), (157, 224)]:
    m = transforms._taper_mask(ly=ly, lx=lx)
    fx['taper'][f'{ly}x{lx}'] = {'sum': float(m.sum()), 'center': float(m[ly // 2, lx // 2]),
                                 'corner': float(m[0, 0]), 'edgeMid': float(m[0, lx // 2]), 'row5': [float(v) for v in m[5, :12]]}
for L in [(512, 512), (269, 400), (256, 256), (156, 231), (400, 600), (100, 37)]:
    fx['pad'][f'{L[0]}x{L[1]}'] = {
        'none': list(map(int, transforms.get_pad_yx(*L))),
        'min256': list(map(int, transforms.get_pad_yx(*L, min_size=(256, 256)))),
    }
for bsize, ov in [(224, 0.1), (256, 0.25)]:
    for L in [100, 224, 256, 300, 512, 528, 616, 1000, 1041]:
        img = np.zeros((1, L, 300), np.float32)
        _, ysub, _, _, _ = transforms.make_tiles(img, bsize=bsize, tile_overlap=ov)
        fx['starts'][f'{bsize}_{ov}_{L}'] = sorted({int(a) for a, _ in ysub})
for (H, W, H2, W2) in [(37, 53, 21, 30), (64, 48, 128, 96), (51, 51, 29, 29)]:
    src = rng.random((H, W)).astype(np.float32)
    dst = transforms.resize_image(src, Ly=H2, Lx=W2)
    fx['resize'].append({'H': H, 'W': W, 'H2': H2, 'W2': W2, 'src': src.ravel().tolist(), 'dst': dst.ravel().tolist()})
json.dump(fx, open(out, 'w'))
print('ok', out)
