// Makes an example oblique photo for the Rectify tutorial: a sample photo with a 1 m square
// quadrat drawn on it (an illustration, aligned with the folding ruler's corner), then warped
// as if taken at an angle. Returns the photo's path and where the quadrat's corners ended up.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { PHOTO_SIZE, photo } from './lib.mjs';

/** Solves the 8×8 system for the homography mapping src[i] to dst[i] (4 point pairs). */
function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  return [...h, 1];
}

const apply = (h, [x, y]) => {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
};

/** Distance from point p to segment ab. */
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * @param {string} file sample photo name
 * @param {{ out: string, corner: [number, number], dir: [number, number], sidePx: number }} o
 *   the quadrat's top-left corner, the direction of its top edge, and its side in pixels
 * @returns {Promise<{ path: string, corners: number[][] }>} corners TL, TR, BR, BL in the output
 */
export async function makeObliquePhoto(file, { out, corner, dir, sidePx }) {
  const { width: w, height: h } = PHOTO_SIZE[file];
  const len = Math.hypot(dir[0], dir[1]);
  const u = [dir[0] / len, dir[1] / len];
  const v = [-u[1], u[0]];
  const tl = corner;
  const tr = [tl[0] + u[0] * sidePx, tl[1] + u[1] * sidePx];
  const bl = [tl[0] + v[0] * sidePx, tl[1] + v[1] * sidePx];
  const br = [tr[0] + v[0] * sidePx, tr[1] + v[1] * sidePx];
  const quad = [tl, tr, br, bl];
  // The camera tilt: the far (top) edge of the photo comes out narrower.
  const frame = [[0, 0], [w, 0], [w, h], [0, h]];
  const tilted = [[w * 0.17, h * 0.07], [w * 0.83, h * 0.07], [w * 0.99, h * 0.99], [w * 0.01, h * 0.99]];
  const fwd = homography(frame, tilted);
  const inv = homography(tilted, frame);
  const corners = quad.map((p) => apply(fwd, p).map((x) => Math.round(x * 10) / 10));
  PHOTO_SIZE[out.split('/').pop()] = { width: w, height: h };
  if (existsSync(out)) return { path: out, corners };

  const src = execFileSync('ffmpeg', ['-v', 'error', '-i', await photo(file), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  // Draw the quadrat: orange bars with a dark edge, 9 px wide.
  const edges = [[tl, tr], [tr, br], [br, bl], [bl, tl]];
  const x0 = Math.floor(Math.min(...quad.map((p) => p[0]))) - 8, x1 = Math.ceil(Math.max(...quad.map((p) => p[0]))) + 8;
  const y0 = Math.floor(Math.min(...quad.map((p) => p[1]))) - 8, y1 = Math.ceil(Math.max(...quad.map((p) => p[1]))) + 8;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const dist = Math.min(...edges.map(([a, b]) => segDist([x, y], a, b)));
      if (dist > 6) continue;
      const i = (y * w + x) * 3;
      const c = dist > 4.5 ? [40, 30, 20] : [255, 122, 26];
      src[i] = c[0]; src[i + 1] = c[1]; src[i + 2] = c[2];
    }
  }
  // Warp: each output pixel samples the source through the inverse homography (bilinear).
  const dst = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = apply(inv, [x + 0.5, y + 0.5]).map((q) => q - 0.5);
      const o = (y * w + x) * 3;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) {
        dst[o] = 32; dst[o + 1] = 36; dst[o + 2] = 42;
        continue;
      }
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      const ix1 = Math.min(w - 1, ix + 1), iy1 = Math.min(h - 1, iy + 1);
      for (let c = 0; c < 3; c++) {
        const a = src[(iy * w + ix) * 3 + c], b = src[(iy * w + ix1) * 3 + c];
        const d = src[(iy1 * w + ix) * 3 + c], e = src[(iy1 * w + ix1) * 3 + c];
        dst[o + c] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy);
      }
    }
  }
  const raw = `${out}.rgb`;
  writeFileSync(raw, dst);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', raw, '-q:v', '2', out]);
  execFileSync('rm', ['-f', raw]);
  return { path: out, corners };
}
