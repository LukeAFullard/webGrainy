export interface SyntheticImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface AnalyticalEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  angleRad?: number;
}

export interface SyntheticFlowField {
  flowY: Float32Array;
  flowX: Float32Array;
  cellprob: Float32Array;
  width: number;
  height: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createUniformGravelImage(
  width: number,
  height: number,
  seed = 42
): SyntheticImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const rand = mulberry32(seed);
  // Uniform fine gravel: small periodic grains ~8px diameter with mild intensity variation
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const pattern = Math.sin(x * 0.45) * Math.cos(y * 0.45);
      const base = 128 + Math.round(pattern * 25 + (rand() - 0.5) * 16);
      const v = Math.max(0, Math.min(255, base));
      data[idx] = v;
      data[idx + 1] = Math.max(0, Math.min(255, v - 4));
      data[idx + 2] = Math.max(0, Math.min(255, v - 8));
      data[idx + 3] = 255;
    }
  }
  return { data, width, height };
}

export function createCoarseBoulderImage(width: number, height: number): SyntheticImage {
  const data = new Uint8ClampedArray(width * height * 4);
  // High heterogeneity: large sharp-edged boulders + fine interstitial matrix
  data.fill(40);
  const boulders = [
    { cx: width * 0.28, cy: height * 0.3, r: Math.min(width, height) * 0.22, lum: 235 },
    { cx: width * 0.72, cy: height * 0.35, r: Math.min(width, height) * 0.18, lum: 205 },
    { cx: width * 0.48, cy: height * 0.75, r: Math.min(width, height) * 0.2, lum: 225 },
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      let lum = 30 + ((x * 13 + y * 7) % 25);
      for (const b of boulders) {
        const d = Math.hypot(x - b.cx, y - b.cy);
        if (d <= b.r) {
          lum = b.lum - Math.round((d / b.r) * 40);
          break;
        }
      }
      data[idx] = lum;
      data[idx + 1] = Math.max(0, lum - 5);
      data[idx + 2] = Math.max(0, lum - 10);
      data[idx + 3] = 255;
    }
  }
  return { data, width, height };
}

export function createHarshShadowGlareImage(width: number, height: number): SyntheticImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const inShadow = x < width / 2;
      const localRipple = Math.round(Math.sin(x * 0.5) * Math.cos(y * 0.5) * 10);
      const lum = inShadow
        ? Math.max(2, Math.min(40, 15 + localRipple))
        : Math.max(210, Math.min(254, 240 + localRipple));
      data[idx] = lum;
      data[idx + 1] = lum;
      data[idx + 2] = lum;
      data[idx + 3] = 255;
    }
  }
  return { data, width, height };
}

export function createFlatImage(width: number, height: number, value = 128): SyntheticImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    data[idx] = value;
    data[idx + 1] = value;
    data[idx + 2] = value;
    data[idx + 3] = 255;
  }
  return { data, width, height };
}

export function createEmptyFlowField(width: number, height: number): SyntheticFlowField {
  const n = width * height;
  return {
    flowY: new Float32Array(n),
    flowX: new Float32Array(n),
    cellprob: new Float32Array(n).fill(-5.0),
    width,
    height,
  };
}

export function createIsolatedEllipsesFlowField(
  width: number,
  height: number,
  ellipses: readonly AnalyticalEllipse[]
): SyntheticFlowField {
  const n = width * height;
  const flowY = new Float32Array(n);
  const flowX = new Float32Array(n);
  const cellprob = new Float32Array(n).fill(-4.0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      for (const e of ellipses) {
        const theta = e.angleRad ?? 0;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const dx = x - e.cx;
        const dy = y - e.cy;
        const xr = dx * cos + dy * sin;
        const yr = -dx * sin + dy * cos;
        const normSq = (xr * xr) / (e.rx * e.rx) + (yr * yr) / (e.ry * e.ry);
        if (normSq <= 1.0) {
          const dist = Math.hypot(e.cx - x, e.cy - y);
          if (dist > 1e-6) {
            flowY[idx] = (e.cy - y) / dist;
            flowX[idx] = (e.cx - x) / dist;
          }
          cellprob[idx] = 4.0;
          break;
        }
      }
    }
  }
  return { flowY, flowX, cellprob, width, height };
}

/**
 * Two overlapping disks with a narrow neck whose flow points weakly/tangentially
 * so the combined mask fails flowThreshold (0.45) and triggers F3_SplitOnFailure
 * into two valid pebble masks.
 */
export function createTouchingDumbbellFlowField(
  width: number,
  height: number
): SyntheticFlowField {
  const n = width * height;
  const flowY = new Float32Array(n);
  const flowX = new Float32Array(n);
  const cellprob = new Float32Array(n).fill(-4.0);

  const c1x = Math.floor(width * 0.38);
  const c2x = Math.floor(width * 0.62);
  const cy = Math.floor(height * 0.5);
  const r = Math.max(12, Math.floor(Math.min(width, height) * 0.16));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d1 = Math.hypot(x - c1x, y - cy);
      const d2 = Math.hypot(x - c2x, y - cy);
      const in1 = d1 <= r;
      const in2 = d2 <= r;
      if (in1 || in2) {
        const idx = y * width + x;
        cellprob[idx] = 4.0;
        // Point toward nearer center, but add strong tangential perturbation in outer ring
        // to force combined mask QC failure while preserving two distinct sink peaks
        const tx = d1 <= d2 ? c1x : c2x;
        const ty = cy;
        const dx = tx - x;
        const dy = ty - y;
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-6) {
          flowY[idx] = dy / dist;
          flowX[idx] = dx / dist;
        }
      }
    }
  }
  return { flowY, flowX, cellprob, width, height };
}

export function createBorderTouchingClastFlowField(
  width: number,
  height: number,
  borderOffsetPx: number
): SyntheticFlowField {
  // Places one clast starting at (borderOffsetPx, borderOffsetPx) and one well-inside clast
  const n = width * height;
  const flowY = new Float32Array(n);
  const flowX = new Float32Array(n);
  const cellprob = new Float32Array(n).fill(-4.0);

  const r = 12;
  const bCx = borderOffsetPx + r;
  const bCy = borderOffsetPx + r;
  const iCx = Math.floor(width * 0.72);
  const iCy = Math.floor(height * 0.72);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const db = Math.hypot(x - bCx, y - bCy);
      const di = Math.hypot(x - iCx, y - iCy);
      if (db <= r) {
        cellprob[idx] = 4.0;
        if (db > 1e-6) {
          flowY[idx] = (bCy - y) / db;
          flowX[idx] = (bCx - x) / db;
        }
      } else if (di <= r) {
        cellprob[idx] = 4.0;
        if (di > 1e-6) {
          flowY[idx] = (iCy - y) / di;
          flowX[idx] = (iCx - x) / di;
        }
      }
    }
  }
  return { flowY, flowX, cellprob, width, height };
}

/**
 * Generates a single rectangular/elliptical sand-sheet mask covering `areaFraction`
 * of the image (for 3ca10b7c regression testing around maxGrainAreaFraction = 0.15).
 */
export function createGiantSandSheetOutlierFlowField(
  width: number,
  height: number,
  areaFraction: number
): SyntheticFlowField {
  const n = width * height;
  const flowY = new Float32Array(n);
  const flowX = new Float32Array(n);
  const cellprob = new Float32Array(n).fill(-4.0);

  const targetPixels = Math.round(n * areaFraction);
  const rectW = Math.min(width - 12, Math.max(10, Math.round(Math.sqrt(targetPixels * 1.4))));
  const rectH = Math.min(height - 12, Math.max(10, Math.round(targetPixels / rectW)));
  const x0 = Math.floor((width - rectW) / 2);
  const y0 = Math.floor((height - rectH) / 2);
  const cx = x0 + rectW / 2;
  const cy = y0 + rectH / 2;

  for (let y = y0; y < y0 + rectH; y++) {
    for (let x = x0; x < x0 + rectW; x++) {
      const idx = y * width + x;
      cellprob[idx] = 4.0;
      const dx = cx - x;
      const dy = cy - y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) {
        flowY[idx] = dy / dist;
        flowX[idx] = dx / dist;
      }
    }
  }
  return { flowY, flowX, cellprob, width, height };
}

/**
 * Generates a >15% area giant sand-sheet region with noisy/divergent flow that
 * fails flowThreshold QC, specifically to test the trySplitDumbbell pre-split guard (3ca10b7c).
 */
export function createFailingFlowGiantSandSheetFlowField(
  width: number,
  height: number,
  areaFraction: number
): SyntheticFlowField {
  const n = width * height;
  const flowY = new Float32Array(n);
  const flowX = new Float32Array(n);
  const cellprob = new Float32Array(n).fill(-4.0);

  const targetPixels = Math.round(n * areaFraction);
  const rectW = Math.min(width - 12, Math.max(10, Math.round(Math.sqrt(targetPixels * 1.4))));
  const rectH = Math.min(height - 12, Math.max(10, Math.round(targetPixels / rectW)));
  const x0 = Math.floor((width - rectW) / 2);
  const y0 = Math.floor((height - rectH) / 2);
  const c1x = x0 + rectW * 0.3;
  const c2x = x0 + rectW * 0.7;
  const cy = y0 + rectH * 0.5;

  for (let y = y0; y < y0 + rectH; y++) {
    for (let x = x0; x < x0 + rectW; x++) {
      const idx = y * width + x;
      cellprob[idx] = 4.0;
      const tx = Math.abs(x - c1x) <= Math.abs(x - c2x) ? c1x : c2x;
      const dx = tx - x;
      const dy = cy - y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) {
        // Orthogonal/divergent perturbation so combined mask fails flowThreshold (0.45)
        // and enters trySplitDumbbell, where the >15% pre-split guard must reject it.
        const sign = (x + y) % 2 === 0 ? 1 : -1;
        flowY[idx] = (0.2 * dy + 0.98 * sign * dx) / dist;
        flowX[idx] = (0.2 * dx - 0.98 * sign * dy) / dist;
      }
    }
  }
  return { flowY, flowX, cellprob, width, height };
}

/**
 * Independent reference oracle for eval_core.py weighted_psd_percentiles:
 * cdf = (cumsum(w) - 0.5 * w) / sum(w), np.interp(p / 100.0, cdf, sortedValues)
 */
export function oracleMidpointWeightedPercentiles(
  values: readonly number[],
  weights: readonly number[],
  percentiles: readonly number[]
): number[] {
  if (values.length === 0) {
    return percentiles.map(() => 0);
  }

  const pairs = values
    .map((v, i) => ({ v, w: weights[i] ?? 0 }))
    .sort((a, b) => a.v - b.v);

  const totalW = pairs.reduce((acc, p) => acc + p.w, 0);
  const cdf: number[] = [];
  let running = 0;
  for (const p of pairs) {
    running += p.w;
    cdf.push(totalW > 0 ? (running - 0.5 * p.w) / totalW : 0);
  }

  const firstCdf = cdf[0];
  const lastCdf = cdf[cdf.length - 1];
  const firstPair = pairs[0];
  const lastPair = pairs[pairs.length - 1];
  if (
    firstCdf === undefined ||
    lastCdf === undefined ||
    firstPair === undefined ||
    lastPair === undefined
  ) {
    return percentiles.map(() => 0);
  }

  return percentiles.map((pct) => {
    const target = pct / 100.0;
    if (target <= firstCdf) return firstPair.v;
    if (target >= lastCdf) return lastPair.v;
    for (let i = 0; i < cdf.length - 1; i++) {
      const c0 = cdf[i];
      const c1 = cdf[i + 1];
      const p0 = pairs[i];
      const p1 = pairs[i + 1];
      if (c0 === undefined || c1 === undefined || p0 === undefined || p1 === undefined) {
        continue;
      }
      if (target >= c0 && target <= c1) {
        const span = c1 - c0;
        const t = span > 0 ? (target - c0) / span : 0;
        return p0.v + t * (p1.v - p0.v);
      }
    }
    return lastPair.v;
  });
}

export function oracleFolkAndWardPhi(psdMm: {
  D5: number;
  D16: number;
  D25: number;
  D50: number;
  D75: number;
  D84: number;
  D95: number;
}): {
  meanPhi: number;
  sortingPhi: number;
  skewnessPhi: number;
  kurtosisPhi: number;
} {
  const toPhi = (d: number) => -Math.log2(d);
  const phi5 = toPhi(psdMm.D5);
  const phi16 = toPhi(psdMm.D16);
  const phi25 = toPhi(psdMm.D25);
  const phi50 = toPhi(psdMm.D50);
  const phi75 = toPhi(psdMm.D75);
  const phi84 = toPhi(psdMm.D84);
  const phi95 = toPhi(psdMm.D95);

  const meanPhi = (phi16 + phi50 + phi84) / 3;
  // Since phi = -log2(D_mm), D5 <= D16 <= ... <= D84 <= D95 implies phi5 >= phi16 >= ... >= phi84 >= phi95
  const sortingPhi = (phi16 - phi84) / 4 + (phi5 - phi95) / 6.6;
  const skewDenom1 = 2 * (phi16 - phi84);
  const skewDenom2 = 2 * (phi5 - phi95);
  const skewnessPhi =
    (skewDenom1 !== 0 ? (phi16 + phi84 - 2 * phi50) / skewDenom1 : 0) +
    (skewDenom2 !== 0 ? (phi5 + phi95 - 2 * phi50) / skewDenom2 : 0);
  const kurtDenom = 2.44 * (phi25 - phi75);
  const kurtosisPhi = kurtDenom !== 0 ? (phi5 - phi95) / kurtDenom : 0;

  return { meanPhi, sortingPhi, skewnessPhi, kurtosisPhi };
}
