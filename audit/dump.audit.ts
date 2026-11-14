// Audit: dump outputs of the real TS implementations for independent Python oracle comparison (audit/oracle.py).
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { weightedPsdPercentiles, computeFolkWardStats, computePsdPercentiles } from '../src/modules/sedimentStats';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore';
import { float32ToFloat16, tileStarts, makeBlendWindow, reflectIndex } from '../src/modules/onnxInference';
import { solveHomography, applyHomographyPoint } from '../src/modules/roiAndRectify';
import { mulberry32 } from '../src/modules/siteAnalysis';

const out: Record<string, unknown> = {};
const rnd = mulberry32(12345);

it('percentiles', () => {
  const cases: unknown[] = [];
  const P = [5, 10, 16, 25, 50, 75, 84, 90, 95];
  const mk = (v: number[], w: number[]) => cases.push({ v, w, r: weightedPsdPercentiles(v, w, P) });
  mk([7], [3]); mk([3, 9], [1, 1]); mk([3, 9], [1, 9]); mk([5, 5, 5, 8], [1, 2, 3, 4]);
  for (let k = 0; k < 200; k++) {
    const n = 1 + Math.floor(rnd() * 60);
    const v = Array.from({ length: n }, () => Math.round(Math.exp(rnd() * 5) * 10) / 10); // ties likely
    const w = Array.from({ length: n }, () => (rnd() < 0.5 ? 1 : rnd() * 100));
    mk(v, w);
  }
  out.percentiles = cases;
});

it('folkward', () => {
  // log-normal-ish skewed sample: area weights, b in mm
  const v: number[] = []; const w: number[] = [];
  for (let i = 0; i < 500; i++) { const d = 2 ** (3 + 2 * rnd() ** 2.5); v.push(d); w.push(1); }
  const psd = computePsdPercentiles(v, w);
  out.folkward = { v, psd, fw: computeFolkWardStats(psd) };
});

it('morphometrics', () => {
  const W = 200, H = 200;
  const shapes: Record<string, (x: number, y: number) => boolean> = {
    rect_80x20_rot30: (x, y) => { const c = Math.cos(0.5236), s = Math.sin(0.5236); const u = (x - 100) * c + (y - 100) * s, v = -(x - 100) * s + (y - 100) * c; return Math.abs(u) <= 40 && Math.abs(v) <= 10; },
    ellipse_60x30: (x, y) => ((x - 100) / 60) ** 2 + ((y - 100) / 30) ** 2 <= 1,
    triangle: (x, y) => y >= 40 && y <= 160 && Math.abs(x - 100) <= (y - 40) * 0.5,
    L_shape: (x, y) => (x >= 40 && x <= 70 && y >= 40 && y <= 160) || (x >= 40 && x <= 160 && y >= 130 && y <= 160),
    half_disk_occluded: (x, y) => (x - 100) ** 2 + (y - 100) ** 2 <= 60 ** 2 && y >= 100,
    square_60: (x, y) => Math.abs(x - 100) <= 30 && Math.abs(y - 100) <= 30,
  };
  const res: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(shapes)) {
    const m = new Int32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (f(x, y)) m[y * W + x] = 1;
    const g = computeGrainMorphometrics(m, W, H, 0)[0]!;
    res[name] = { mask: Array.from(m), a: g.aAxisPx, b: g.bAxisPx, area: g.areaPx, orient: g.orientationRad };
  }
  out.morph = { W, H, res };
});

it('fp16', () => {
  const xs: number[] = [0, -0, 1, -1, 65504, 65520, 65519.99, 1e6, -1e6, Infinity, -Infinity, NaN,
    6.103515625e-5, 6.0975552e-5, 5.960464477539063e-8, 2.98023223876953125e-8, 2.9802323e-8, 1e-8, 1e-10,
    1.00048828125, 1.000732421875, 1.0009765625, 1.00146484375, 2049, 2051, 0.1, 0.2, 0.3, 3.14159];
  for (let i = 0; i < 20000; i++) { const e = (rnd() - 0.5) * 60; xs.push((rnd() < 0.5 ? -1 : 1) * rnd() * 2 ** e); }
  const f32 = Array.from(new Float32Array(xs)); // compare after f32 rounding like the real tensor path
  out.fp16 = { x: f32.map((v) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Inf' : v === -Infinity ? '-Inf' : v)), h: f32.map((v) => float32ToFloat16(v)) };
});

it('tiling', () => {
  const r: unknown[] = [];
  for (const L of [1, 100, 255, 256, 257, 300, 448, 449, 640, 1000, 1023, 4000]) r.push({ L, starts: tileStarts(L, 256, 192) });
  const win = makeBlendWindow(256);
  let mn = Infinity; for (const v of win) mn = Math.min(mn, v);
  const refl: number[] = []; for (let i = -12; i < 25; i++) refl.push(reflectIndex(i, 5));
  out.tiling = { r, winMin: mn, win0: Array.from(win.slice(0, 256)), refl };
});

it('homography', () => {
  const cases: unknown[] = [];
  const src = [{ x: 512.3, y: 380.1 }, { x: 3600.7, y: 450.2 }, { x: 3900.4, y: 2950.8 }, { x: 300.2, y: 2800.6 }];
  const dst = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }, { x: 0, y: 800 }];
  const h = solveHomography(src as never, dst as never);
  const mapped = src.map((p) => applyHomographyPoint(h, p));
  let degenerate = 'no-throw';
  try { solveHomography([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] as never, dst as never); } catch (e) { degenerate = String(e); }
  cases.push({ src, dst, h: Array.from(h), mapped, degenerate });
  out.homography = cases;
});

it('write', () => { writeFileSync('audit/out/ts_dump.json', JSON.stringify(out)); });
