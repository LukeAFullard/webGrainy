/**
 * File-format writers shared by every export: lossless PNG label masks and grain
 * outlines (marching squares) as GeoJSON and SVG. Pure functions (no DOM), one copy.
 */
import type { GrainMorphometrics } from '../types/index.js';

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

export type ContourRing = Array<[number, number]>;

/**
 * Marching-squares outline of one grain (outer rings sorted largest first, then holes).
 * `scaleInv` maps working-image coordinates back to the original photo (1 = unchanged).
 */
export function traceGrainContours(
  masks: Int32Array,
  width: number,
  height: number,
  grainId: number,
  bbox: [number, number, number, number],
  scaleInv = 1,
): { outers: ContourRing[]; holes: ContourRing[] } {
  const minX = Math.max(0, Math.floor(bbox[0]));
  const minY = Math.max(0, Math.floor(bbox[1]));
  const maxX = Math.min(width - 1, Math.ceil(bbox[2]));
  const maxY = Math.min(height - 1, Math.ceil(bbox[3]));

  const isInside = (x: number, y: number): number => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return masks[y * width + x] === grainId ? 1 : 0;
  };

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
    return [x2 * 0.5 * scaleInv, y2 * 0.5 * scaleInv];
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

export function pointInRing(pt: [number, number], ring: ContourRing): boolean {
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
 * Lossless PNG of an instance mask: 16-bit grayscale (IDs clamped to 0..65535) or
 * 32-bit IDs packed big-endian into 8-bit RGBA.
 */
export function encodeMaskPng(
  masks: Int32Array,
  width: number,
  height: number,
  bitDepth: 16 | 32 = 16,
): Uint8Array {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions for PNG export.');
  }
  const bytesPerPixel = bitDepth === 16 ? 2 : 4;
  const rowBytes = 1 + width * bytesPerPixel;
  const raw = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rawRow = y * rowBytes;
    raw[rawRow] = 0; // filter type 0
    const maskRow = y * width;
    for (let x = 0; x < width; x++) {
      if (bitDepth === 16) {
        const id = masks[maskRow + x] ?? 0;
        const clamped = id <= 0 ? 0 : id > 65535 ? 65535 : id;
        const pos = rawRow + 1 + x * 2;
        raw[pos] = (clamped >>> 8) & 0xff;
        raw[pos + 1] = clamped & 0xff;
      } else {
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
  ihdrData[8] = bitDepth === 16 ? 16 : 8; // bit depth
  ihdrData[9] = bitDepth === 16 ? 0 : 6; // colour type: 0 = grayscale, 6 = RGBA
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    makePngChunk('IHDR', ihdrData),
    makePngChunk('IDAT', deflateStoredZlib(raw)),
    makePngChunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}

type Geometry =
  | { type: 'Polygon'; coordinates: ContourRing[] }
  | { type: 'MultiPolygon'; coordinates: ContourRing[][] };

/** Per-grain GeoJSON properties (px always; mm and Feret when available). */
export function grainGeoJsonProperties(g: GrainMorphometrics): Record<string, unknown> {
  const p: Record<string, unknown> = {
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
  if (g.areaMm2 !== undefined) p['areaMm2'] = g.areaMm2;
  if (g.aAxisMm !== undefined) p['aAxisMm'] = g.aAxisMm;
  if (g.bAxisMm !== undefined) p['bAxisMm'] = g.bAxisMm;
  if (g.dEqMm !== undefined) p['dEqMm'] = g.dEqMm;
  if (g.minFeretPx !== undefined) p['minFeretPx'] = g.minFeretPx;
  if (g.maxFeretPx !== undefined) p['maxFeretPx'] = g.maxFeretPx;
  if (g.minFeretMm !== undefined) p['minFeretMm'] = g.minFeretMm;
  if (g.maxFeretMm !== undefined) p['maxFeretMm'] = g.maxFeretMm;
  return p;
}

export interface ContourExportOptions {
  /** Working-image to output coordinate factor (1 / effectiveScaleFactor). Default 1. */
  scaleInv?: number;
  /** Grain whose measurements go into the properties (e.g. original-image grain); default: the traced grain. */
  propertiesFor?: (traced: GrainMorphometrics) => GrainMorphometrics;
  /** Provenance metadata (RFC 7946 foreign member / SVG <metadata>). */
  metadata?: Record<string, unknown>;
}

/** GeoJSON FeatureCollection of grain outlines (holes kept; multi-part grains as MultiPolygon). */
export function buildContourGeoJson(
  masks: Int32Array,
  grains: readonly GrainMorphometrics[],
  width: number,
  height: number,
  options: ContourExportOptions = {},
): Record<string, unknown> {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions for GeoJSON export.');
  }
  const features: Array<{ type: 'Feature'; geometry: Geometry; properties: Record<string, unknown> }> = [];
  for (const wg of grains) {
    const { outers, holes } = traceGrainContours(masks, width, height, wg.id, wg.bbox, options.scaleInv ?? 1);
    if (outers.length === 0) continue;
    let geometry: Geometry;
    if (outers.length === 1) {
      geometry = { type: 'Polygon', coordinates: [outers[0]!, ...holes] };
    } else {
      const polygons: ContourRing[][] = outers.map((outer) => [outer]);
      for (const hole of holes) {
        const testPt = hole[0];
        let targetIdx = 0;
        if (testPt !== undefined) {
          // Outers are sorted largest first: the innermost (last) containing outer wins.
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
      geometry = { type: 'MultiPolygon', coordinates: polygons };
    }
    const g = options.propertiesFor ? options.propertiesFor(wg) : wg;
    features.push({ type: 'Feature', geometry, properties: grainGeoJsonProperties(g) });
  }
  return {
    type: 'FeatureCollection',
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    features,
  };
}

/** SVG of grain outlines (`<path fill-rule="evenodd">`, one per grain). */
export function buildContourSvg(
  masks: Int32Array,
  grains: readonly GrainMorphometrics[],
  width: number,
  height: number,
  options: ContourExportOptions & { outWidth?: number; outHeight?: number } = {},
): string {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions for SVG export.');
  }
  const paths: string[] = [];
  for (const g of grains) {
    const { outers, holes } = traceGrainContours(masks, width, height, g.id, g.bbox, options.scaleInv ?? 1);
    if (outers.length === 0) continue;
    const dParts: string[] = [];
    for (const ring of [...outers, ...holes]) {
      if (ring.length < 3) continue;
      const first = ring[0];
      if (first === undefined) continue;
      let d = `M ${first[0]} ${first[1]}`;
      for (let i = 1; i < ring.length - 1; i++) {
        const pt = ring[i];
        if (pt !== undefined) d += ` L ${pt[0]} ${pt[1]}`;
      }
      dParts.push(`${d} Z`);
    }
    if (dParts.length > 0) {
      paths.push(
        `  <path data-grain-id="${g.id}" fill="rgba(56, 189, 248, 0.25)" stroke="#0284c7" stroke-width="1" fill-rule="evenodd" d="${dParts.join(' ')}" />`,
      );
    }
  }
  const w = options.outWidth ?? width;
  const h = options.outHeight ?? height;
  const meta =
    options.metadata !== undefined
      ? [
          `  <metadata id="webgrainy-provenance">${JSON.stringify(options.metadata)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')}</metadata>`,
        ]
      : [];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    ...meta,
    ...paths,
    '</svg>',
  ].join('\n');
}
