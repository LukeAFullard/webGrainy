import type {
  FolkWardStats,
  GrainMorphometrics,
  PsdPercentiles,
  SedimentStatsReport,
  WentworthProportions,
} from '../types/index.js';

const DEFAULT_PERCENTILES = [5, 10, 16, 25, 50, 75, 84, 90, 95] as const;

/**
 * Filters out border-touching grains when `excludeBorder` is `true` (default).
 */
export function filterBorderGrains(
  grains: readonly GrainMorphometrics[],
  excludeBorder = true,
): GrainMorphometrics[] {
  if (!excludeBorder) {
    return [...grains];
  }
  return grains.filter((g) => !g.touchesBorder);
}

/**
 * Computes weighted particle-size distribution percentiles with exact parity
 * to `eval_core.py` / `np.interp(p / 100.0, cdf, v)` using midpoint cumulative
 * weights `cdf = (cumsum(w) - 0.5 * w) / sum(w)`.
 */
export function weightedPsdPercentiles(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
  percentiles: readonly number[] = DEFAULT_PERCENTILES,
): Record<string, number> {
  const n = Math.min(values.length, weights.length);
  const pairs: Array<{ v: number; w: number }> = [];

  for (let i = 0; i < n; i++) {
    const v = values[i];
    const w = weights[i];
    if (
      v !== undefined &&
      w !== undefined &&
      Number.isFinite(v) &&
      Number.isFinite(w) &&
      v > 0 &&
      w > 0
    ) {
      pairs.push({ v, w });
    }
  }

  const out: Record<string, number> = {};
  if (pairs.length === 0) {
    for (const p of percentiles) {
      out[`D${p}`] = Number.NaN;
    }
    return out;
  }

  pairs.sort((a, b) => a.v - b.v);

  let totalWeight = 0;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (pair !== undefined) {
      totalWeight += pair.w;
    }
  }

  const count = pairs.length;
  const cdf = new Float64Array(count);
  const sortedV = new Float64Array(count);
  let cumSum = 0;

  for (let i = 0; i < count; i++) {
    const pair = pairs[i];
    if (pair === undefined) continue;
    cumSum += pair.w;
    cdf[i] = (cumSum - 0.5 * pair.w) / totalWeight;
    sortedV[i] = pair.v;
  }

  const firstCdf = cdf[0] ?? 0;
  const lastCdf = cdf[count - 1] ?? 1;
  const firstV = sortedV[0] ?? Number.NaN;
  const lastV = sortedV[count - 1] ?? Number.NaN;

  for (const p of percentiles) {
    const key = `D${p}`;
    const target = p / 100;

    if (target <= firstCdf) {
      out[key] = firstV;
      continue;
    }
    if (target >= lastCdf) {
      out[key] = lastV;
      continue;
    }

    // Binary search for largest idx where cdf[idx] <= target
    let lo = 0;
    let hi = count - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      const midVal = cdf[mid] ?? 0;
      if (midVal <= target) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    const c0 = cdf[lo] ?? 0;
    const c1 = cdf[hi] ?? 1;
    const v0 = sortedV[lo] ?? 0;
    const v1 = sortedV[hi] ?? 0;

    if (c1 === c0) {
      out[key] = v1;
    } else {
      const t = (target - c0) / (c1 - c0);
      out[key] = v0 + t * (v1 - v0);
    }
  }

  return out;
}

/**
 * Typed wrapper returning the standard `PsdPercentiles` (`D5`..`D95`).
 */
export function computePsdPercentiles(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
): PsdPercentiles {
  const raw = weightedPsdPercentiles(values, weights, DEFAULT_PERCENTILES);
  return {
    D5: raw['D5'] ?? Number.NaN,
    D10: raw['D10'] ?? Number.NaN,
    D16: raw['D16'] ?? Number.NaN,
    D25: raw['D25'] ?? Number.NaN,
    D50: raw['D50'] ?? Number.NaN,
    D75: raw['D75'] ?? Number.NaN,
    D84: raw['D84'] ?? Number.NaN,
    D90: raw['D90'] ?? Number.NaN,
    D95: raw['D95'] ?? Number.NaN,
  };
}

function classifySorting(sortingPhi: number): string {
  if (sortingPhi < 0.35) return 'Very Well Sorted';
  if (sortingPhi < 0.5) return 'Well Sorted';
  if (sortingPhi < 0.7) return 'Moderately Well Sorted';
  if (sortingPhi < 1.0) return 'Moderately Sorted';
  if (sortingPhi < 2.0) return 'Poorly Sorted';
  if (sortingPhi < 4.0) return 'Very Poorly Sorted';
  return 'Extremely Poorly Sorted';
}

function classifySkewness(skewnessPhi: number): string {
  if (skewnessPhi >= 0.3) return 'Very Fine Skewed';
  if (skewnessPhi >= 0.1) return 'Fine Skewed';
  if (skewnessPhi > -0.1) return 'Near Symmetrical';
  if (skewnessPhi > -0.3) return 'Coarse Skewed';
  return 'Very Coarse Skewed';
}

function classifyKurtosis(kurtosisPhi: number): string {
  if (kurtosisPhi < 0.67) return 'Very Platykurtic';
  if (kurtosisPhi < 0.9) return 'Platykurtic';
  if (kurtosisPhi < 1.11) return 'Mesokurtic';
  if (kurtosisPhi < 1.5) return 'Leptokurtic';
  if (kurtosisPhi < 3.0) return 'Very Leptokurtic';
  return 'Extremely Leptokurtic';
}

/**
 * Computes Folk & Ward (1957) graphic statistics in phi units (`phi = -log2(D_mm)`)
 * with proper coarse-to-fine percentile mapping (`phi5 = -log2(D95)`, etc.).
 */
export function computeFolkWardStats(
  psdMm: PsdPercentiles,
): FolkWardStats | null {
  const required = [
    psdMm.D5,
    psdMm.D16,
    psdMm.D25,
    psdMm.D50,
    psdMm.D75,
    psdMm.D84,
    psdMm.D95,
  ];
  for (const val of required) {
    if (!Number.isFinite(val) || val <= 0) {
      return null;
    }
  }

  const phi5 = -Math.log2(psdMm.D95);
  const phi16 = -Math.log2(psdMm.D84);
  const phi25 = -Math.log2(psdMm.D75);
  const phi50 = -Math.log2(psdMm.D50);
  const phi75 = -Math.log2(psdMm.D25);
  const phi84 = -Math.log2(psdMm.D16);
  const phi95 = -Math.log2(psdMm.D5);

  const meanPhi = (phi16 + phi50 + phi84) / 3;
  const sortingPhi = (phi84 - phi16) / 4 + (phi95 - phi5) / 6.6;

  const denom1 = 2 * (phi84 - phi16);
  const denom2 = 2 * (phi95 - phi5);
  const term1 = denom1 !== 0 ? (phi16 + phi84 - 2 * phi50) / denom1 : 0;
  const term2 = denom2 !== 0 ? (phi5 + phi95 - 2 * phi50) / denom2 : 0;
  const skewnessPhi = term1 + term2;

  const kurtDenom = 2.44 * (phi75 - phi25);
  const kurtosisPhi = kurtDenom !== 0 ? (phi95 - phi5) / kurtDenom : 1;

  const meanMm = 2 ** -meanPhi;

  return {
    meanPhi,
    sortingPhi,
    skewnessPhi,
    kurtosisPhi,
    meanMm,
    sortingLabel: classifySorting(sortingPhi),
    skewnessLabel: classifySkewness(skewnessPhi),
    kurtosisLabel: classifyKurtosis(kurtosisPhi),
  };
}

/**
 * Computes area-weighted (`areaPx`) Wentworth size class proportions on `bAxisMm`:
 * Sand (`< 2 mm`), Gravel (`2 <= d < 64`), Cobble (`64 <= d < 256`), Boulder (`>= 256`).
 */
export function computeWentworthProportions(
  grains: readonly GrainMorphometrics[],
): WentworthProportions | null {
  if (grains.length === 0) {
    return null;
  }

  let sandArea = 0;
  let gravelArea = 0;
  let cobbleArea = 0;
  let boulderArea = 0;
  let totalArea = 0;

  for (const g of grains) {
    if (typeof g.bAxisMm !== 'number' || !Number.isFinite(g.bAxisMm)) {
      return null;
    }
    if (!Number.isFinite(g.areaPx) || g.areaPx <= 0) {
      continue;
    }
    const d = g.bAxisMm;
    const area = g.areaPx;
    totalArea += area;

    if (d < 2) {
      sandArea += area;
    } else if (d < 64) {
      gravelArea += area;
    } else if (d < 256) {
      cobbleArea += area;
    } else {
      boulderArea += area;
    }
  }

  if (totalArea <= 0) {
    return null;
  }

  return {
    sandPct: (sandArea / totalArea) * 100,
    gravelPct: (gravelArea / totalArea) * 100,
    cobblePct: (cobbleArea / totalArea) * 100,
    boulderPct: (boulderArea / totalArea) * 100,
  };
}

/**
 * Computes the complete sediment statistics report (area-weighted & number-weighted
 * PSDs on `bAxis` and `dEq`, plus Folk & Ward and Wentworth when calibrated in `mm`).
 */
export function computeSedimentStats(
  grains: readonly GrainMorphometrics[],
  options?: { excludeBorder?: boolean; minAreaPx?: number },
): SedimentStatsReport {
  const excludeBorder = options?.excludeBorder ?? true;
  const minAreaPx = options?.minAreaPx ?? 0;

  const areaFiltered =
    minAreaPx > 0 ? grains.filter((g) => g.areaPx >= minAreaPx) : grains;
  const included = filterBorderGrains(areaFiltered, excludeBorder);
  const excludedBorderGrains = areaFiltered.length - included.length;

  const isCalibrated =
    included.length > 0 &&
    included.every(
      (g) =>
        typeof g.bAxisMm === 'number' &&
        Number.isFinite(g.bAxisMm) &&
        typeof g.dEqMm === 'number' &&
        Number.isFinite(g.dEqMm),
    );

  const unit: 'px' | 'mm' = isCalibrated ? 'mm' : 'px';

  const n = included.length;
  const bVals = new Float64Array(n);
  const dEqVals = new Float64Array(n);
  const areaWeights = new Float64Array(n);
  const numberWeights = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const g = included[i];
    if (g === undefined) continue;
    bVals[i] = unit === 'mm' ? (g.bAxisMm ?? g.bAxisPx) : g.bAxisPx;
    dEqVals[i] = unit === 'mm' ? (g.dEqMm ?? g.dEqPx) : g.dEqPx;
    areaWeights[i] = g.areaPx;
    numberWeights[i] = 1;
  }

  const areaWeightedB = computePsdPercentiles(bVals, areaWeights);
  const numberWeightedB = computePsdPercentiles(bVals, numberWeights);
  const areaWeightedDEq = computePsdPercentiles(dEqVals, areaWeights);
  const numberWeightedDEq = computePsdPercentiles(dEqVals, numberWeights);

  const folkWard =
    unit === 'mm' ? computeFolkWardStats(areaWeightedB) : null;
  const wentworth =
    unit === 'mm' ? computeWentworthProportions(included) : null;

  return {
    totalGrains: grains.length,
    includedGrains: included.length,
    excludedBorderGrains,
    unit,
    areaWeightedB,
    numberWeightedB,
    areaWeightedDEq,
    numberWeightedDEq,
    folkWard,
    wentworth,
  };
}

/**
 * Exports per-grain morphometrics as a CSV Blob.
 */
export function exportGrainsCsv(grains: readonly GrainMorphometrics[]): Blob {
  const header =
    'grain_id,centroid_x,centroid_y,area_px,a_axis_px,b_axis_px,d_eq_px,a_axis_mm,b_axis_mm,d_eq_mm,touches_border';
  const lines: string[] = [header];

  for (const g of grains) {
    const row = [
      g.id,
      g.centroidX,
      g.centroidY,
      g.areaPx,
      g.aAxisPx,
      g.bAxisPx,
      g.dEqPx,
      g.aAxisMm !== undefined ? g.aAxisMm : '',
      g.bAxisMm !== undefined ? g.bAxisMm : '',
      g.dEqMm !== undefined ? g.dEqMm : '',
      g.touchesBorder,
    ].join(',');
    lines.push(row);
  }

  return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

/**
 * Exports the `SedimentStatsReport` as a JSON Blob.
 */
export function exportSummaryJson(report: SedimentStatsReport): Blob {
  return new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
}

/**
 * Exports the `SedimentStatsReport` as a structured summary CSV Blob.
 */
export function exportSummaryCsv(report: SedimentStatsReport): Blob {
  const lines: string[] = ['section,metric,value,unit'];

  lines.push(`summary,total_grains,${report.totalGrains},count`);
  lines.push(`summary,included_grains,${report.includedGrains},count`);
  lines.push(
    `summary,excluded_border_grains,${report.excludedBorderGrains},count`,
  );
  lines.push(`summary,unit,${report.unit},unit`);

  const distributions: Array<[string, PsdPercentiles]> = [
    ['area_weighted_b', report.areaWeightedB],
    ['number_weighted_b', report.numberWeightedB],
    ['area_weighted_d_eq', report.areaWeightedDEq],
    ['number_weighted_d_eq', report.numberWeightedDEq],
  ];

  for (const [section, psd] of distributions) {
    for (const p of DEFAULT_PERCENTILES) {
      const key = `D${p}` as keyof PsdPercentiles;
      lines.push(`${section},${key},${psd[key]},${report.unit}`);
    }
  }

  if (report.folkWard !== null) {
    const fw = report.folkWard;
    lines.push(`folk_ward,mean_phi,${fw.meanPhi},phi`);
    lines.push(`folk_ward,sorting_phi,${fw.sortingPhi},phi`);
    lines.push(`folk_ward,skewness_phi,${fw.skewnessPhi},phi`);
    lines.push(`folk_ward,kurtosis_phi,${fw.kurtosisPhi},phi`);
    lines.push(`folk_ward,mean_mm,${fw.meanMm},mm`);
    lines.push(`folk_ward,sorting_label,"${fw.sortingLabel}",label`);
    lines.push(`folk_ward,skewness_label,"${fw.skewnessLabel}",label`);
    lines.push(`folk_ward,kurtosis_label,"${fw.kurtosisLabel}",label`);
  }

  if (report.wentworth !== null) {
    const w = report.wentworth;
    lines.push(`wentworth,sand_pct,${w.sandPct},%`);
    lines.push(`wentworth,gravel_pct,${w.gravelPct},%`);
    lines.push(`wentworth,cobble_pct,${w.cobblePct},%`);
    lines.push(`wentworth,boulder_pct,${w.boulderPct},%`);
  }

  return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

// ============================================================================
// Pure-JS PNG Encoder (16-bit Grayscale & 32-bit RGBA, Uncompressed DEFLATE)
// ============================================================================

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0;
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD_ADLER = 65521;
  for (let i = 0; i < data.length; i++) {
    a = (a + (data[i] ?? 0)) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeUint32BE(chunk, 0, data.length);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  writeUint32BE(chunk, 8 + data.length, crc);
  return chunk;
}

function deflateStoredZlib(raw: Uint8Array): Uint8Array {
  const maxBlock = 65535;
  const numBlocks = Math.max(1, Math.ceil(raw.length / maxBlock));
  const totalLen = 2 + numBlocks * 5 + raw.length + 4;
  const out = new Uint8Array(totalLen);

  // Zlib header: CMF=0x78 (deflate, 32K window), FLG=0x01 (no dict, fastest)
  out[0] = 0x78;
  out[1] = 0x01;

  let outPos = 2;
  let inPos = 0;

  for (let b = 0; b < numBlocks; b++) {
    const remaining = raw.length - inPos;
    const blockLen = Math.min(maxBlock, remaining);
    const isFinal = b === numBlocks - 1 ? 1 : 0;
    const nlen = ~blockLen & 0xffff;

    out[outPos++] = isFinal;
    out[outPos++] = blockLen & 0xff;
    out[outPos++] = (blockLen >>> 8) & 0xff;
    out[outPos++] = nlen & 0xff;
    out[outPos++] = (nlen >>> 8) & 0xff;

    if (blockLen > 0) {
      out.set(raw.subarray(inPos, inPos + blockLen), outPos);
      outPos += blockLen;
      inPos += blockLen;
    }
  }

  const adler = adler32(raw);
  writeUint32BE(out, outPos, adler);
  return out;
}

/**
 * Exports an instance mask (`Int32Array`) as a lossless PNG Blob:
 * - `bitDepth = 16`: 16-bit grayscale (`colorType = 0`, big-endian uint16, clamped `0..65535`).
 * - `bitDepth = 32`: 32-bit RGBA (`colorType = 6, bitDepth = 8`, encoding 32-bit grain IDs).
 */
export function exportInstanceMaskPng(
  masks: Int32Array,
  width: number,
  height: number,
  bitDepth: 16 | 32 = 16,
): Blob {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions for PNG export.');
  }

  const bytesPerPixel = bitDepth === 16 ? 2 : 4;
  const rowBytes = 1 + width * bytesPerPixel;
  const raw = new Uint8Array(rowBytes * height);

  if (bitDepth === 16) {
    for (let y = 0; y < height; y++) {
      const rawRow = y * rowBytes;
      raw[rawRow] = 0; // filter type 0
      const maskRow = y * width;
      for (let x = 0; x < width; x++) {
        const id = masks[maskRow + x] ?? 0;
        const clamped = id <= 0 ? 0 : id > 65535 ? 65535 : id;
        const pos = rawRow + 1 + x * 2;
        raw[pos] = (clamped >>> 8) & 0xff;
        raw[pos + 1] = clamped & 0xff;
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const rawRow = y * rowBytes;
      raw[rawRow] = 0; // filter type 0
      const maskRow = y * width;
      for (let x = 0; x < width; x++) {
        const id = (masks[maskRow + x] ?? 0) >>> 0;
        const pos = rawRow + 1 + x * 4;
        raw[pos] = (id >>> 24) & 0xff;
        raw[pos + 1] = (id >>> 16) & 0xff;
        raw[pos + 2] = (id >>> 8) & 0xff;
        raw[pos + 3] = id & 0xff;
      }
    }
  }

  const ihdrData = new Uint8Array(13);
  writeUint32BE(ihdrData, 0, width);
  writeUint32BE(ihdrData, 4, height);
  ihdrData[8] = bitDepth === 16 ? 16 : 8; // bitDepth
  ihdrData[9] = bitDepth === 16 ? 0 : 6; // colorType: 0=grayscale, 6=RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makePngChunk('IHDR', ihdrData);
  const idatChunk = makePngChunk('IDAT', deflateStoredZlib(raw));
  const iendChunk = makePngChunk('IEND', new Uint8Array(0));

  const pngBytes = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let offset = 0;
  pngBytes.set(signature, offset);
  offset += signature.length;
  pngBytes.set(ihdrChunk, offset);
  offset += ihdrChunk.length;
  pngBytes.set(idatChunk, offset);
  offset += idatChunk.length;
  pngBytes.set(iendChunk, offset);

  return new Blob([pngBytes], { type: 'image/png' });
}

// ============================================================================
// Marching Squares Contour Tracer (GeoJSON & SVG)
// ============================================================================

type ContourRing = Array<[number, number]>;

function traceGrainContours(
  masks: Int32Array,
  width: number,
  height: number,
  grainId: number,
  bbox: [number, number, number, number],
): { outers: ContourRing[]; holes: ContourRing[] } {
  const minX = Math.max(0, bbox[0]);
  const minY = Math.max(0, bbox[1]);
  const maxX = Math.min(width - 1, bbox[2]);
  const maxY = Math.min(height - 1, bbox[3]);

  const isInside = (x: number, y: number): number => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return masks[y * width + x] === grainId ? 1 : 0;
  };

  // Edge midpoints in doubled integer coordinates (2*x, 2*y)
  const strideX = (width + 2) * 2;
  const toKey = (x2: number, y2: number): number => (y2 + 2) * strideX + (x2 + 2);

  const adj = new Map<number, number[]>();
  const addSegment = (
    ax2: number,
    ay2: number,
    bx2: number,
    by2: number,
  ): void => {
    const kA = toKey(ax2, ay2);
    const kB = toKey(bx2, by2);
    let list = adj.get(kA);
    if (list === undefined) {
      list = [kB];
      adj.set(kA, list);
    } else {
      list.push(kB);
    }
  };

  for (let cy = minY - 1; cy <= maxY; cy++) {
    for (let cx = minX - 1; cx <= maxX; cx++) {
      const tl = isInside(cx, cy);
      const tr = isInside(cx + 1, cy);
      const br = isInside(cx + 1, cy + 1);
      const bl = isInside(cx, cy + 1);
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      // Doubled coords of cell edge midpoints:
      // Top: (2*cx + 2, 2*cy + 1)
      // Right: (2*cx + 3, 2*cy + 2)
      // Bottom: (2*cx + 2, 2*cy + 3)
      // Left: (2*cx + 1, 2*cy + 2)
      const tx = 2 * cx + 2;
      const ty = 2 * cy + 1;
      const rx = 2 * cx + 3;
      const ry = 2 * cy + 2;
      const bx = 2 * cx + 2;
      const by = 2 * cy + 3;
      const lx = 2 * cx + 1;
      const ly = 2 * cy + 2;

      switch (code) {
        case 1:
          addSegment(bx, by, lx, ly);
          break;
        case 2:
          addSegment(rx, ry, bx, by);
          break;
        case 3:
          addSegment(rx, ry, lx, ly);
          break;
        case 4:
          addSegment(tx, ty, rx, ry);
          break;
        case 5:
          // Saddle (TR=1, BL=1): separate foreground components
          addSegment(tx, ty, rx, ry);
          addSegment(bx, by, lx, ly);
          break;
        case 6:
          addSegment(tx, ty, bx, by);
          break;
        case 7:
          addSegment(tx, ty, lx, ly);
          break;
        case 8:
          addSegment(lx, ly, tx, ty);
          break;
        case 9:
          addSegment(bx, by, tx, ty);
          break;
        case 10:
          // Saddle (TL=1, BR=1): separate foreground components
          addSegment(lx, ly, tx, ty);
          addSegment(rx, ry, bx, by);
          break;
        case 11:
          addSegment(rx, ry, tx, ty);
          break;
        case 12:
          addSegment(lx, ly, rx, ry);
          break;
        case 13:
          addSegment(bx, by, rx, ry);
          break;
        case 14:
          addSegment(lx, ly, bx, by);
          break;
      }
    }
  }

  const decodePoint = (key: number): [number, number] => {
    const y2 = Math.floor(key / strideX) - 2;
    const x2 = (key % strideX) - 2;
    return [x2 * 0.5, y2 * 0.5];
  };

  const outersWithArea: Array<{ ring: ContourRing; absArea2: number }> = [];
  const holes: ContourRing[] = [];

  for (const [startKey, startNeighbors] of adj.entries()) {
    while (startNeighbors.length > 0) {
      const ring: ContourRing = [decodePoint(startKey)];
      const firstNext = startNeighbors.pop();
      if (firstNext === undefined) break;

      let curr = firstNext;
      while (curr !== startKey) {
        ring.push(decodePoint(curr));
        const neighbors = adj.get(curr);
        if (neighbors === undefined || neighbors.length === 0) {
          break;
        }
        const next = neighbors.pop();
        if (next === undefined) break;
        curr = next;
      }

      const firstPt = ring[0];
      if (firstPt !== undefined) {
        ring.push([firstPt[0], firstPt[1]]);
      }

      if (ring.length < 4) continue;

      // Shoelace signed area (in screen coords y-down: < 0 is outer ring, > 0 is hole)
      let signedArea2 = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const p0 = ring[i];
        const p1 = ring[i + 1];
        if (p0 === undefined || p1 === undefined) continue;
        signedArea2 += p0[0] * p1[1] - p1[0] * p0[1];
      }

      if (signedArea2 <= 0) {
        outersWithArea.push({ ring, absArea2: Math.abs(signedArea2) });
      } else {
        holes.push(ring);
      }
    }
  }

  outersWithArea.sort((a, b) => b.absArea2 - a.absArea2);
  const outers = outersWithArea.map((entry) => entry.ring);
  return { outers, holes };
}

function pointInRing(pt: [number, number], ring: ContourRing): boolean {
  const px = pt[0];
  const py = pt[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (pi === undefined || pj === undefined) continue;
    const xi = pi[0];
    const yi = pi[1];
    const xj = pj[0];
    const yj = pj[1];
    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Exports grain contours as a GeoJSON `FeatureCollection` Blob using
 * Marching Squares contour tracing.
 */
export function exportGeoJsonContours(
  masks: Int32Array,
  grains: readonly GrainMorphometrics[],
  width: number,
  height: number,
): Blob {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions for GeoJSON export.');
  }

  const features: Array<{
    type: 'Feature';
    geometry:
      | { type: 'Polygon'; coordinates: ContourRing[] }
      | { type: 'MultiPolygon'; coordinates: ContourRing[][] };
    properties: Record<string, unknown>;
  }> = [];

  for (const g of grains) {
    const { outers, holes } = traceGrainContours(
      masks,
      width,
      height,
      g.id,
      g.bbox,
    );
    if (outers.length === 0) continue;

    let geometry:
      | { type: 'Polygon'; coordinates: ContourRing[] }
      | { type: 'MultiPolygon'; coordinates: ContourRing[][] };

    if (outers.length === 1) {
      geometry = {
        type: 'Polygon' as const,
        coordinates: [outers[0]!, ...holes],
      };
    } else {
      const polygons: ContourRing[][] = outers.map((outer) => [outer]);
      for (const hole of holes) {
        const testPt = hole[0];
        let targetIdx = 0;
        if (testPt !== undefined) {
          // outers are sorted largest-first; pick the innermost (last) containing outer
          for (let i = outers.length - 1; i >= 0; i--) {
            const outer = outers[i];
            if (outer !== undefined && pointInRing(testPt, outer)) {
              targetIdx = i;
              break;
            }
          }
        }
        polygons[targetIdx]!.push(hole);
      }
      geometry = {
        type: 'MultiPolygon' as const,
        coordinates: polygons,
      };
    }

    const properties: Record<string, unknown> = {
      grainId: g.id,
      areaPx: g.areaPx,
      centroidX: g.centroidX,
      centroidY: g.centroidY,
      aAxisPx: g.aAxisPx,
      bAxisPx: g.bAxisPx,
      dEqPx: g.dEqPx,
      orientationRad: g.orientationRad,
      touchesBorder: g.touchesBorder,
    };

    if (g.areaMm2 !== undefined) properties['areaMm2'] = g.areaMm2;
    if (g.aAxisMm !== undefined) properties['aAxisMm'] = g.aAxisMm;
    if (g.bAxisMm !== undefined) properties['bAxisMm'] = g.bAxisMm;
    if (g.dEqMm !== undefined) properties['dEqMm'] = g.dEqMm;

    features.push({
      type: 'Feature',
      geometry,
      properties,
    });
  }

  const collection = {
    type: 'FeatureCollection',
    features,
  };

  return new Blob([JSON.stringify(collection)], {
    type: 'application/geo+json',
  });
}

/**
 * Exports grain contours as an SVG Blob with `<path fill-rule="evenodd">` elements.
 */
export function exportSvgContours(
  masks: Int32Array,
  grains: readonly GrainMorphometrics[],
  width: number,
  height: number,
): Blob {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions for SVG export.');
  }

  const paths: string[] = [];

  for (const g of grains) {
    const { outers, holes } = traceGrainContours(
      masks,
      width,
      height,
      g.id,
      g.bbox,
    );
    if (outers.length === 0) continue;

    const allRings = [...outers, ...holes];
    const dParts: string[] = [];

    for (const ring of allRings) {
      if (ring.length < 3) continue;
      const first = ring[0];
      if (first === undefined) continue;
      let d = `M ${first[0]} ${first[1]}`;
      for (let i = 1; i < ring.length - 1; i++) {
        const pt = ring[i];
        if (pt !== undefined) {
          d += ` L ${pt[0]} ${pt[1]}`;
        }
      }
      d += ' Z';
      dParts.push(d);
    }

    if (dParts.length > 0) {
      paths.push(
        `  <path data-grain-id="${g.id}" fill="rgba(56, 189, 248, 0.25)" stroke="#0284c7" stroke-width="1" fill-rule="evenodd" d="${dParts.join(' ')}" />`,
      );
    }
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    ...paths,
    '</svg>',
  ].join('\n');

  return new Blob([svg], { type: 'image/svg+xml' });
}
