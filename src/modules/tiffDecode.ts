/**
 * Client-side TIFF / GeoTIFF decoder powered by UTIF (MIT).
 *
 * Most browsers (Chrome, Firefox, Edge) cannot decode TIFFs natively via
 * `createImageBitmap` or `<img>`. Decoding TIFFs to RGBA on import (and encoding
 * once to a lossless PNG blob) lets every downstream step — viewport, ROI,
 * calibration, AI enhancement, segmentation, exports, and printable reports —
 * work identically across all browsers.
 *
 * Bonus: for projected GeoTIFFs in meters (e.g. UAV orthomosaic tiles from
 * Metashape, Pix4D, or QGIS), reads `ModelPixelScaleTag` (33550) to pre-populate
 * `mmPerPx` calibration automatically. Web Mercator (EPSG:3857) pixel sizes are converted
 * to ground distance with cos(latitude) at the image centre (from `ModelTiepointTag`);
 * other Mercator / equirectangular projections get no automatic calibration.
 */
import UTIF from 'utif2';
import pako from 'pako';
import type { CalibrationResult } from '../types/index.js';
import type { SitePhotoMetadata } from './siteTypes.js';
import { extractGeoReference } from './georef.js';
import { crsUnitMetres } from './projToLonLat.js';

export interface DecodedTiffImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  metadata?: SitePhotoMetadata;
  /** Automatic calibration from projected GeoTIFF `ModelPixelScaleTag`, when present in meters. */
  calibration?: CalibrationResult;
}

/** Returns true if a file looks like a TIFF by MIME type or `.tif`/`.tiff` extension. */
export function isTiffFile(file: { name?: string; type?: string }): boolean {
  const t = (file.type ?? '').toLowerCase();
  if (t === 'image/tiff' || t === 'image/x-tiff') return true;
  return /\.tiff?$/i.test(file.name ?? '');
}

/** Returns true if a file is a supported photo format (standard browser image/* or TIFF). */
export function isSupportedImageFile(file: { name?: string; type?: string }): boolean {
  return (file.type ?? '').toLowerCase().startsWith('image/') || isTiffFile(file);
}

/** Checks standard TIFF (`II*\0`, `MM\0*`) or BigTIFF (`II+\0`, `MM\0+`) magic headers. */
export function isTiffBytes(buf: ArrayBuffer | Uint8Array): boolean {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength < 4) return false;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49 && (bytes[2] === 0x2a || bytes[2] === 0x2b) && bytes[3] === 0x00;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && (bytes[3] === 0x2a || bytes[3] === 0x2b);
  return little || big;
}

function cleanStringTag(val: unknown): string | undefined {
  if (typeof val === 'string') {
    const s = val.replace(/\0+$/, '').trim();
    return s.length > 0 ? s : undefined;
  }
  if (Array.isArray(val) && typeof val[0] === 'string') {
    const s = val[0].replace(/\0+$/, '').trim();
    return s.length > 0 ? s : undefined;
  }
  return undefined;
}

function parseTiffDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function isKnownMetricProjectedCrs(epsg: number | undefined): boolean {
  if (epsg === undefined) return false;
  return (
    (epsg >= 32601 && epsg <= 32660) || // WGS 84 / UTM North
    (epsg >= 32701 && epsg <= 32760) || // WGS 84 / UTM South
    (epsg >= 26901 && epsg <= 26923) || // NAD83 / UTM
    (epsg >= 25828 && epsg <= 25838) || // ETRS89 / UTM
    (epsg >= 28348 && epsg <= 28356) || // GDA94 / MGA
    (epsg >= 7848 && epsg <= 7856) ||   // GDA2020 / MGA
    epsg === 2193 ||                    // NZTM 2000
    epsg === 27700                      // British National Grid
  );
}

/**
 * Spherical (Pseudo-)Mercator CRSs used by web maps. Their map units are metres on the
 * projection, not on the ground: the scale factor is 1/cos(latitude), so a pixel's ground
 * size is `pixelScale * cos(latitude)` (e.g. 29% smaller at 45°).
 */
export const WEB_MERCATOR_EPSG: ReadonlySet<number> = new Set([3857, 3785, 900913, 102100, 102113]);

/**
 * Projected CRSs whose map distance is far from ground distance away from the equator and
 * that are not corrected here (ellipsoidal World Mercator, equirectangular / Plate Carrée).
 * A GeoTIFF in one of these gets no automatic calibration.
 */
export const DISTORTED_SCALE_EPSG: ReadonlySet<number> = new Set([3395, 3832, 3994, 32662, 4087, 4088, 54001, 54004]);

/** Largest change of the Web Mercator ground scale across the image accepted for one mm/px value. */
export const MAX_MERCATOR_SCALE_VARIATION = 0.01;

const WEB_MERCATOR_RADIUS_M = 6378137;

/** Latitude (radians) of a spherical Web Mercator northing (metres). */
export function webMercatorLatitude(northingM: number): number {
  return 2 * Math.atan(Math.exp(northingM / WEB_MERCATOR_RADIUS_M)) - Math.PI / 2;
}

/**
 * Ground-to-map scale (`cos(latitude)`) at the image centre for a Web Mercator GeoTIFF, from
 * `ModelTiepointTag` (33922) and the pixel scale. Undefined when the tie point is missing or
 * the scale changes by more than `MAX_MERCATOR_SCALE_VARIATION` from the top to the bottom row.
 */
function webMercatorGroundScale(
  ifd: Record<string, unknown>,
  sy: number,
  height: number,
): number | undefined {
  const tie = ifd['t33922'];
  if (!Array.isArray(tie) || tie.length < 6) return undefined;
  const j = Number(tie[1]);
  const yTie = Number(tie[4]);
  if (!Number.isFinite(j) || !Number.isFinite(yTie)) return undefined;
  // Raster rows go south as the northing decreases (GeoTIFF default, positive ScaleY).
  const northingAt = (row: number): number => yTie - (row - j) * sy;
  const cosAt = (row: number): number => Math.cos(webMercatorLatitude(northingAt(row)));
  const top = cosAt(0);
  const bottom = cosAt(height);
  const centre = cosAt(height / 2);
  if (!(centre > 0) || !Number.isFinite(centre)) return undefined;
  if (Math.abs(top - bottom) / centre > MAX_MERCATOR_SCALE_VARIATION) return undefined;
  return centre;
}

/**
 * Extracts `mmPerPx` from a projected GeoTIFF's `ModelPixelScaleTag` (33550) when
 * `GeoKeyDirectoryTag` (34735) indicates a projected coordinate system with known linear units.
 */
function extractGeoTiffCalibration(
  ifd: Record<string, unknown>,
  width: number,
  height: number,
): CalibrationResult | undefined {
  const scaleTag = ifd['t33550'];
  const transformTag = ifd['t34264'];
  const geoDir = ifd['t34735'];
  // Pixel size from ModelPixelScaleTag, or from a ModelTransformationTag (south-up, mirrored or
  // rotated rasters) when that maps pixels to the map without skew.
  let pixelSize: [number, number] | undefined;
  let fromTransform = false;
  if (Array.isArray(scaleTag) && scaleTag.length >= 2) {
    pixelSize = [Number(scaleTag[0]), Number(scaleTag[1])];
  } else if (Array.isArray(transformTag) && transformTag.length >= 16) {
    const [m0, m1, m4, m5] = [Number(transformTag[0]), Number(transformTag[1]), Number(transformTag[4]), Number(transformTag[5])];
    const sx = Math.hypot(m0, m4);
    const sy = Math.hypot(m1, m5);
    // Columns and rows must stay perpendicular on the map (within ~3 degrees).
    if (!(sx > 0) || !(sy > 0) || Math.abs(m0 * m1 + m4 * m5) / (sx * sy) > 0.05) return undefined;
    pixelSize = [sx, sy];
    fromTransform = true;
  }
  if (pixelSize === undefined) return undefined;
  if (!Array.isArray(geoDir) || geoDir.length < 4) return undefined;

  const numKeys = Number(geoDir[3]) || 0;
  let modelType: number | undefined;
  let projectedCrs: number | undefined;
  let linearUnits: number | undefined;
  for (let i = 0; i < numKeys; i++) {
    const base = 4 + i * 4;
    if (base + 3 >= geoDir.length) break;
    const keyId = Number(geoDir[base]);
    const tiffTagLocation = Number(geoDir[base + 1]);
    const valueOffset = Number(geoDir[base + 3]);
    if (tiffTagLocation === 0) {
      if (keyId === 1024) modelType = valueOffset; // GTModelTypeGeoKey: 1 = Projected
      if (keyId === 3072) projectedCrs = valueOffset; // ProjectedCSTypeGeoKey
      if (keyId === 3076) linearUnits = valueOffset; // ProjLinearUnitsGeoKey
    }
  }
  // Only trust scale when explicitly Projected (1) and linear units are known.
  if (modelType !== 1) return undefined;
  // Map metres are not ground metres in these projections (see DISTORTED_SCALE_EPSG).
  if (projectedCrs !== undefined && DISTORTED_SCALE_EPSG.has(projectedCrs)) return undefined;
  const isWebMercator = projectedCrs !== undefined && WEB_MERCATOR_EPSG.has(projectedCrs);
  if (isWebMercator && linearUnits !== undefined && linearUnits !== 9001) return undefined;
  // The Web Mercator ground-scale correction assumes a north-up tie point + pixel scale.
  if (isWebMercator && fromTransform) return undefined;
  let mmPerUnit: number | undefined;
  if (linearUnits === 9001) {
    mmPerUnit = 1000; // Meter
  } else if (linearUnits === 9002) {
    mmPerUnit = 304.8; // International foot
  } else if (linearUnits === 9003) {
    mmPerUnit = 1200000 / 3937; // US survey foot (304.8006096... mm)
  } else if (linearUnits === undefined && (isWebMercator || isKnownMetricProjectedCrs(projectedCrs))) {
    mmPerUnit = 1000;
  } else if (linearUnits === undefined && projectedCrs !== undefined) {
    // No ProjLinearUnitsGeoKey: the EPSG definition gives the unit (metres, feet, US survey feet).
    const metres = crsUnitMetres(projectedCrs);
    if (metres !== undefined) mmPerUnit = metres * 1000;
  }
  if (mmPerUnit === undefined) return undefined;

  const [sx, sy] = pixelSize;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return undefined;
  // Require near-square pixels (within 5%).
  if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.05) return undefined;

  let mmPerPx = ((sx + sy) / 2) * mmPerUnit;
  if (isWebMercator) {
    // Convert projected metres to ground metres at the image centre (scale = cos latitude).
    const groundScale = webMercatorGroundScale(ifd, sy, height);
    if (groundScale === undefined) return undefined;
    mmPerPx *= groundScale;
  }
  // Sanity range: 0.01 mm/px (macro) to 1000 mm/px (1 m/px).
  if (mmPerPx < 0.01 || mmPerPx > 1000) return undefined;

  const spanPx = Math.min(100, Math.max(10, Math.round(width / 4)));
  return {
    mmPerPx,
    pointA: { x: 0, y: 0 },
    pointB: { x: spanPx, y: 0 },
    pixelDistance: spanPx,
    physicalLengthMm: spanPx * mmPerPx,
    source: 'geotiff',
  };
}

/**
 * Decodes a TIFF/GeoTIFF `ArrayBuffer` into 8-bit RGBA pixels, picking the
 * highest-resolution page when multiple pages or overview pyramids exist.
 */
interface Utif16Frame {
  width: number;
  height: number;
  data: Uint8Array;
  t258?: number[];
  t262?: number[];
  t277?: number[];
  t284?: number[];
  t338?: number[];
  t339?: number[];
}

/** Share of colour samples clipped at each end of the 16-bit stretch (0.01%; at least one sample). */
export const STRETCH_TAIL_FRACTION = 1e-4;

/**
 * RGBA8 from a decoded 16-bit unsigned-integer TIFF frame (grey or RGB, interleaved; UTIF has
 * already converted samples to little-endian), linearly scaled so the 0.01st percentile of the
 * colour samples maps to 0 and the 99.99th to 255 (darker / brighter samples are clipped) (one range for all colour channels, so colours keep
 * their balance). Returns null for anything else, which UTIF's own conversion handles. The
 * analysis normalises brightness anyway (1st–99th percentile), so a linear stretch does not
 * change results; it only keeps the detail that dropping the low byte destroyed.
 */
export function rgba8From16Bit(f: Utif16Frame): { rgba: Uint8Array; note: string } | null {
  const bps = f.t258?.[0];
  const photometric = f.t262?.[0] ?? 1;
  const spp = f.t277?.[0] ?? f.t258?.length ?? 1;
  const planar = f.t284?.[0] ?? 1;
  const fmt = f.t339?.[0] ?? 1;
  if (bps !== 16 || fmt !== 1 || planar !== 1 || !(photometric === 0 || photometric === 1 || photometric === 2)) return null;
  const w = f.width;
  const h = f.height;
  const colour = photometric === 2 ? 3 : 1;
  if (spp < colour || f.data.length < w * h * spp * 2) return null;
  const extra = f.t338 ?? [];
  const alphaAt = spp > colour && (extra[0] === 1 || extra[0] === 2) ? colour : -1;
  const d = f.data;
  const n = w * h;
  // Range between the 0.01st and 99.99th percentile of all colour samples, not min-max: one hot
  // or saturated pixel at 65535 in 12-bit data would otherwise squeeze the image into a few grey
  // levels. Samples outside the range are clipped.
  // Fully transparent (no-data) pixels are left out, so a no-data border does not set the black point.
  const hist = new Uint32Array(65536);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const base = i * spp * 2;
    if (alphaAt >= 0) {
      const a = base + alphaAt * 2;
      if ((d[a]! | (d[a + 1]! << 8)) === 0) continue;
    }
    for (let c = 0; c < colour; c++) {
      const o = base + c * 2;
      hist[d[o]! | (d[o + 1]! << 8)]!++;
    }
    total += colour;
  }
  const tail = Math.max(1, Math.floor(total * STRETCH_TAIL_FRACTION));
  let lo = 0;
  for (let seen = 0; lo < 65535; lo++) {
    seen += hist[lo]!;
    if (seen > tail) break;
  }
  let hi = 65535;
  for (let seen = 0; hi > 0; hi--) {
    seen += hist[hi]!;
    if (seen > tail) break;
  }
  if (hi < lo) hi = lo;
  const span = hi > lo ? hi - lo : 1;
  const k = 255 / span;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const base = i * spp * 2;
    const q = i * 4;
    for (let c = 0; c < 3; c++) {
      const o = base + (colour === 3 ? c : 0) * 2;
      let v = Math.round((Math.min(hi, Math.max(lo, d[o]! | (d[o + 1]! << 8))) - lo) * k);
      if (photometric === 0) v = 255 - v; // WhiteIsZero
      out[q + c] = v;
    }
    if (alphaAt >= 0) {
      const o = base + alphaAt * 2;
      out[q + 3] = (d[o]! | (d[o + 1]! << 8)) >> 8;
    } else {
      out[q + 3] = 255;
    }
  }
  return { rgba: out, note: `16-bit TIFF converted to 8 bits by its own range (${lo}–${hi}, the 0.01–99.99th percentile, mapped to 0–255).` };
}

/** Largest TIFF frame (pixels) the import decodes; larger files must be tiled or downsampled first. */
export const MAX_TIFF_PIXELS = 100_000_000;

/** Most bytes one decoded frame may take before conversion to RGBA8 (100 MP at 16-bit RGBA). */
export const MAX_TIFF_FRAME_BYTES = MAX_TIFF_PIXELS * 8;

const MAX_TIFF_IFDS = 1024;
const MAX_TIFF_IFD_ENTRIES = 4096;
const MAX_TIFF_IFD_DEPTH = 8;
/** Byte size of each TIFF field type (1 BYTE ... 13 IFD). */
const TIFF_TYPE_BYTES: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
/** Tags whose values are offsets of further IFDs that UTIF reads (SubIFDs, EXIF, GPS, Fuji). */
const SUB_IFD_TAGS: ReadonlySet<number> = new Set([330, 34665, 34853, 61440]);

const malformedTiff = (why: string): Error => new Error(`This TIFF file is damaged or not a valid TIFF (${why}), so it was not opened.`);

/**
 * Walks the IFD structure before UTIF reads it, which UTIF does without any checks: a chain that
 * loops back on itself made it loop forever, sub-IFD lists that point to one IFD many times grew
 * exponentially, and a tag claiming billions of values made it loop billions of times. Throws
 * for an IFD visited twice, too many IFDs or entries, an IFD or tag value outside the file, or
 * nesting deeper than UTIF needs.
 */
export function validateTiffStructure(buf: ArrayBuffer): void {
  const dv = new DataView(buf);
  const size = buf.byteLength;
  if (size < 8) throw malformedTiff('too short');
  const le = dv.getUint8(0) === 0x49;
  const u16 = (o: number): number => dv.getUint16(o, le);
  const u32 = (o: number): number => dv.getUint32(o, le);
  const visited = new Set<number>();

  const readIfd = (offset: number, depth: number): number => {
    if (depth > MAX_TIFF_IFD_DEPTH) throw malformedTiff('IFDs nested too deeply');
    if (offset < 8 || offset + 2 > size) throw malformedTiff('an IFD lies outside the file');
    if (visited.has(offset)) throw malformedTiff('an IFD is referenced twice');
    visited.add(offset);
    if (visited.size > MAX_TIFF_IFDS) throw malformedTiff('too many IFDs');
    const count = u16(offset);
    if (count > MAX_TIFF_IFD_ENTRIES) throw malformedTiff('too many tags in an IFD');
    const end = offset + 2 + count * 12;
    if (end + 4 > size && !(depth > 0 && end <= size)) throw malformedTiff('an IFD runs past the end of the file');
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const num = u32(e + 4);
      const unit = TIFF_TYPE_BYTES[type];
      if (unit === undefined) continue; // UTIF skips unknown types
      const bytes = num * unit;
      const valueAt = bytes <= 4 ? e + 8 : u32(e + 8);
      if (bytes > 4 && valueAt + bytes > size) throw malformedTiff(`tag ${tag} points past the end of the file`);
      if (SUB_IFD_TAGS.has(tag) && (type === 4 || type === 13)) {
        for (let j = 0; j < num; j++) readIfd(u32(valueAt + 4 * j), depth + 1);
      }
    }
    return end;
  };

  let next = u32(4);
  while (next !== 0) {
    const end = readIfd(next, 0);
    next = end + 4 <= size ? u32(end) : 0;
  }
}

/** Throws when the chosen frame's layout would make UTIF loop forever or allocate too much. */
function checkFrameLayout(raw: Record<string, unknown>, width: number, height: number): number {
  const first = (tag: string): number | undefined => {
    const v = raw[tag];
    const n = Array.isArray(v) || ArrayBuffer.isView(v) ? Number((v as ArrayLike<unknown>)[0]) : undefined;
    return n !== undefined && Number.isFinite(n) ? n : undefined;
  };
  const spp = first('t277') ?? 1;
  const bps = first('t258') ?? 1;
  if (!Number.isInteger(spp) || spp < 1 || spp > 16) throw malformedTiff(`${spp} samples per pixel`);
  if (!Number.isInteger(bps) || bps < 1 || bps > 32) throw malformedTiff(`${bps} bits per sample`);
  const rowBytes = Math.ceil((width * bps * spp) / 8);
  const frameBytes = rowBytes * height;
  if (raw['t322'] !== undefined) {
    const tw = first('t322') ?? 0;
    const th = first('t323') ?? 0;
    if (!(tw >= 1 && th >= 1 && tw <= 65536 && th <= 65536)) throw malformedTiff('invalid tile size');
    if (Math.ceil((tw * th * bps * spp) / 8) > MAX_TIFF_FRAME_BYTES) throw malformedTiff('tiles too large');
  }
  if (frameBytes > MAX_TIFF_FRAME_BYTES) {
    throw new Error(`This TIFF frame needs ${Math.round(frameBytes / 1e6)} MB to decode (${spp} samples of ${bps} bits per pixel); webGrainy decodes up to ${MAX_TIFF_FRAME_BYTES / 1e6} MB. Save an 8- or 16-bit RGB copy or a smaller tile.`);
  }
  return frameBytes;
}

/**
 * pako.inflateRaw that refuses to produce more than `limit` bytes. UTIF inflates each DEFLATE
 * strip or tile without a bound, so a small "zip bomb" strip could exhaust memory; UTIF only
 * keeps output that fits the frame anyway.
 */
function boundedInflateRaw(limit: number): (src: Uint8Array) => Uint8Array {
  return (src) => {
    const inf = new pako.Inflate({ raw: true });
    const chunks: Uint8Array[] = [];
    let total = 0;
    inf.onData = (c) => {
      total += c.length;
      if (total > limit) throw malformedTiff('a compressed strip expands far beyond the image size');
      chunks.push(c);
    };
    inf.onEnd = () => {};
    inf.push(src, true);
    if (inf.err) throw malformedTiff(`DEFLATE data: ${inf.msg}`);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
}

export function decodeTiffBuffer(buf: ArrayBuffer): DecodedTiffImage {
  if (!isTiffBytes(buf)) {
    throw new Error('File does not have a valid TIFF header.');
  }
  const magic = new Uint8Array(buf, 0, 4);
  if (magic[2] === 0x2b || magic[3] === 0x2b) {
    throw new Error(
      'This is a BigTIFF, which webGrainy cannot read. Save a standard TIFF copy (e.g. gdal_translate -co BIGTIFF=NO in.tif out.tif, or export a tile of the area to measure), keeping the georeferencing.',
    );
  }
  validateTiffStructure(buf);
  // MakerNotes (camera-private data) are not needed and are parsed without checks.
  const decode = UTIF.decode as (b: ArrayBuffer, prm: { parseMN: boolean; debug: boolean }) => ReturnType<typeof UTIF.decode>;
  const ifds = decode(buf, { parseMN: false, debug: false });
  if (!ifds || ifds.length === 0) {
    throw new Error('TIFF file contains no image frames.');
  }

  // Pick the highest-resolution frame (skipping thumbnails/overviews in pyramid GeoTIFFs). UTIF
  // sets width/height only when it decodes the pixels, so read the size tags (256, 257) too.
  const tagNum = (ifd: Record<string, unknown>, tag: string): number => {
    const v = ifd[tag];
    const n = Array.isArray(v) ? Number(v[0]) : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const framePixels = (f: (typeof ifds)[number]): number => {
    const raw = f as unknown as Record<string, unknown>;
    return (f.width || tagNum(raw, 't256')) * (f.height || tagNum(raw, 't257'));
  };
  let best = ifds[0]!;
  let bestPixels = framePixels(best);
  for (const cand of ifds) {
    const px = framePixels(cand);
    if (px > bestPixels) {
      best = cand;
      bestPixels = px;
    }
  }

  // Decoding allocates several bytes per pixel at full size (and the import then draws the
  // frame on a canvas): refuse very large frames with an actionable message instead of running
  // out of memory or hitting the browser's canvas limit.
  if (bestPixels > MAX_TIFF_PIXELS) {
    throw new Error(
      `This TIFF is ${tagNum(best as unknown as Record<string, unknown>, 't256')} x ${tagNum(best as unknown as Record<string, unknown>, 't257')} px (${Math.round(bestPixels / 1e6)} MP); webGrainy imports TIFFs up to ${MAX_TIFF_PIXELS / 1e6} MP. Export a smaller copy or a tile of the area you want to measure (e.g. with QGIS or gdal_translate), keeping the georeferencing.`,
    );
  }

  // Band-interleaved colour (PlanarConfiguration 2) decodes to a nearly black image in UTIF.
  const bestRaw = best as unknown as Record<string, unknown>;
  if (tagNum(bestRaw, 't284') === 2 && tagNum(bestRaw, 't277') > 1) {
    throw new Error(
      'This TIFF stores each colour band separately (band-interleaved, PlanarConfiguration 2), which webGrainy cannot read. Save a pixel-interleaved copy (e.g. gdal_translate -co INTERLEAVE=PIXEL in.tif out.tif), keeping the georeferencing.',
    );
  }
  const frameBytes = checkFrameLayout(bestRaw, tagNum(bestRaw, 't256'), tagNum(bestRaw, 't257'));
  // UTIF calls pako.inflateRaw on the shared pako module: bound it while this frame decodes.
  const inflateRaw = pako.inflateRaw;
  pako.inflateRaw = boundedInflateRaw(frameBytes + 65536);
  try {
    UTIF.decodeImage(buf, best);
  } finally {
    pako.inflateRaw = inflateRaw;
  }
  // 16-bit images: UTIF keeps only the high byte, so 12-bit data stored in 16 bits (common for
  // scientific and drone cameras) collapsed to 16 grey levels. Scale by the image's own range.
  const sixteen = rgba8From16Bit(best as unknown as Utif16Frame);
  const rgbaRaw = sixteen?.rgba ?? UTIF.toRGBA8(best);
  const width = best.width;
  const height = best.height;
  if (!width || !height || rgbaRaw.byteLength < width * height * 4) {
    throw new Error('Failed to decode TIFF pixel data (unsupported compression or bit depth).');
  }

  const rawIfd = best as unknown as Record<string, unknown>;
  const cameraMake = cleanStringTag(rawIfd['t271']);
  const cameraModel = cleanStringTag(rawIfd['t272']);
  const timestamp = parseTiffDate(cleanStringTag(rawIfd['t306']));
  const georef = extractGeoReference(rawIfd, width, height);
  const metadata: SitePhotoMetadata | undefined =
    cameraMake || cameraModel || timestamp || georef || sixteen
      ? {
          ...(sixteen ? { notes: sixteen.note } : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(cameraMake ? { cameraMake } : {}),
          ...(cameraModel ? { cameraModel } : {}),
          ...(georef ? { georef } : {}),
        }
      : undefined;

  const calibration = extractGeoTiffCalibration(rawIfd, width, height);

  return {
    data: new Uint8ClampedArray(rgbaRaw.buffer, rgbaRaw.byteOffset, width * height * 4),
    width,
    height,
    ...(metadata ? { metadata } : {}),
    ...(calibration ? { calibration } : {}),
  };
}
