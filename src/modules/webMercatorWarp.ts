/**
 * Reprojection of a georeferenced photo (or its label mask) onto a north-up Web Mercator
 * (EPSG:3857) grid, the grid web maps draw in.
 *
 * Why: a projected GeoTIFF's pixel rows run along grid east, which is rotated from true east by
 * the grid convergence (about 1.5 degrees for NZTM at 175 E). A web viewer that places such a
 * raster north-up inside its corner coordinates, without that rotation, misaligns it with
 * correctly converted vector outlines. A raster already on the Web Mercator grid needs no
 * rotation, so it lines up with the longitude / latitude outlines in any viewer.
 *
 * Each output pixel centre is taken back to the source photo exactly (Web Mercator ->
 * longitude / latitude -> the GeoTIFF's CRS -> photo pixel) and sampled: nearest neighbour for
 * label masks (ids are kept), bilinear for photos. Pixels outside the photo are transparent
 * (alpha 0) or background (id 0). No datum shift (see projToLonLat.ts).
 */
import { toMap } from './georef.js';
import { lonLatProjector, projectedFromLonLat, webMercatorForward } from './projToLonLat.js';
import type { PhotoGeoreference } from './siteTypes.js';

const R = 6378137;
const D = Math.PI / 180;

/** Largest output raster (pixels) produced. */
export const MAX_WARP_PIXELS = 120_000_000;

export interface WebMercatorGrid {
  /** Corner-based transform (EPSG:3857 metres): X = a + b*u, Y = d + f*v (c = e = 0). */
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
}

/** Whether the photo's CRS can be warped (the same CRSs as the longitude / latitude GeoJSON). */
export function canWarpToWebMercator(g: PhotoGeoreference): boolean {
  return lonLatProjector(g.epsg, g.kind) !== null && projectedFromLonLat(g.epsg, g.kind) !== null;
}

/**
 * The output grid: the photo's footprint in Web Mercator, with square pixels the size of the
 * photo's smallest pixel side there (so no detail is lost). Null when the CRS is not covered.
 */
export function webMercatorGrid(g: PhotoGeoreference): WebMercatorGrid | null {
  const toLonLat = lonLatProjector(g.epsg, g.kind);
  if (!toLonLat) return null;
  const merc = (u: number, v: number): [number, number] => {
    const [x, y] = toMap(g, u, v);
    const [lon, lat] = toLonLat(x, y);
    return webMercatorForward(lon, lat);
  };
  // Footprint from points along the edges (the edges curve slightly in Web Mercator).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    for (const [u, v] of [[t * g.width, 0], [t * g.width, g.height], [0, t * g.height], [g.width, t * g.height]] as Array<[number, number]>) {
      const [X, Y] = merc(u, v);
      minX = Math.min(minX, X); maxX = Math.max(maxX, X);
      minY = Math.min(minY, Y); maxY = Math.max(maxY, Y);
    }
  }
  // Pixel size: the shorter side of one photo pixel at the centre, in Web Mercator metres.
  const cu = g.width / 2, cv = g.height / 2;
  const [x0, y0] = merc(cu, cv);
  const [x1, y1] = merc(cu + 1, cv);
  const [x2, y2] = merc(cu, cv + 1);
  let res = Math.min(Math.hypot(x1 - x0, y1 - y0), Math.hypot(x2 - x0, y2 - y0));
  if (!(res > 0) || !Number.isFinite(minX + maxX + minY + maxY)) return null;
  let width = Math.ceil((maxX - minX) / res);
  let height = Math.ceil((maxY - minY) / res);
  if (width * height > MAX_WARP_PIXELS) {
    res *= Math.sqrt((width * height) / MAX_WARP_PIXELS);
    width = Math.ceil((maxX - minX) / res);
    height = Math.ceil((maxY - minY) / res);
  }
  return { transform: [minX, res, 0, maxY, 0, -res], width, height };
}

/** The georeference of a warped raster (EPSG:3857, north-up). */
export function webMercatorGeoref(grid: WebMercatorGrid): PhotoGeoreference {
  return { transform: grid.transform, epsg: 3857, kind: 'projected', width: grid.width, height: grid.height };
}

/**
 * For each output pixel centre, the source photo position (pixel-corner coordinates u, v), or
 * NaN outside the CRS's domain. Calls `visit(index, u, v)` row by row.
 */
function mapPixels(g: PhotoGeoreference, grid: WebMercatorGrid, visit: (i: number, u: number, v: number) => void): void {
  const toMapXY = projectedFromLonLat(g.epsg, g.kind);
  if (!toMapXY) throw new Error('This coordinate system cannot be reprojected here.');
  const [a, b, c, d, e, f] = g.transform;
  const det = b * f - c * e;
  const [X0, res, , Y0] = grid.transform;
  for (let j = 0; j < grid.height; j++) {
    const Y = Y0 - (j + 0.5) * res;
    const lat = (2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) / D;
    for (let i = 0; i < grid.width; i++) {
      const lon = (X0 + (i + 0.5) * res) / R / D;
      const [x, y] = toMapXY(lon, lat);
      // Invert X = a + b u + c v, Y = d + e u + f v.
      const dx = x - a, dy = y - d;
      visit(j * grid.width + i, (f * dx - c * dy) / det, (b * dy - e * dx) / det);
    }
  }
}

/** Label mask (grain ids, photo size) warped to Web Mercator: nearest neighbour, 0 outside. */
export function warpLabelsToWebMercator(masks: Int32Array, g: PhotoGeoreference, grid: WebMercatorGrid): Int32Array {
  const out = new Int32Array(grid.width * grid.height);
  mapPixels(g, grid, (k, u, v) => {
    const px = Math.floor(u), py = Math.floor(v);
    if (px >= 0 && py >= 0 && px < g.width && py < g.height) out[k] = masks[py * g.width + px]!;
  });
  return out;
}

/** RGBA photo (photo size) warped to Web Mercator: bilinear, transparent outside. */
export function warpRgbaToWebMercator(rgba: Uint8Array | Uint8ClampedArray, g: PhotoGeoreference, grid: WebMercatorGrid): Uint8Array {
  const W = g.width, H = g.height;
  const out = new Uint8Array(grid.width * grid.height * 4);
  mapPixels(g, grid, (k, u, v) => {
    if (!(u >= 0 && v >= 0 && u <= W && v <= H)) return;
    // Bilinear between pixel centres (clamped at the edges).
    const sx = Math.min(Math.max(u - 0.5, 0), W - 1), sy = Math.min(Math.max(v - 0.5, 0), H - 1);
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
    const fx = sx - x0, fy = sy - y0;
    const o = k * 4;
    for (let ch = 0; ch < 3; ch++) {
      const p00 = rgba[(y0 * W + x0) * 4 + ch]!, p10 = rgba[(y0 * W + x1) * 4 + ch]!;
      const p01 = rgba[(y1 * W + x0) * 4 + ch]!, p11 = rgba[(y1 * W + x1) * 4 + ch]!;
      out[o + ch] = Math.round((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy);
    }
    out[o + 3] = 255;
  });
  return out;
}
