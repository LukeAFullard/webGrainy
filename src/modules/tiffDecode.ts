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
import type { CalibrationResult } from '../types/index.js';
import type { SitePhotoMetadata } from './siteTypes.js';
import { extractGeoReference } from './georef.js';

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
  const geoDir = ifd['t34735'];
  if (!Array.isArray(scaleTag) || scaleTag.length < 2) return undefined;
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
  let mmPerUnit: number | undefined;
  if (linearUnits === 9001) {
    mmPerUnit = 1000; // Meter
  } else if (linearUnits === 9002) {
    mmPerUnit = 304.8; // International foot
  } else if (linearUnits === 9003) {
    mmPerUnit = 1200000 / 3937; // US survey foot (304.8006096... mm)
  } else if (linearUnits === undefined && (isWebMercator || isKnownMetricProjectedCrs(projectedCrs))) {
    mmPerUnit = 1000;
  }
  if (mmPerUnit === undefined) return undefined;

  const sx = Number(scaleTag[0]);
  const sy = Number(scaleTag[1]);
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
export function decodeTiffBuffer(buf: ArrayBuffer): DecodedTiffImage {
  if (!isTiffBytes(buf)) {
    throw new Error('File does not have a valid TIFF header.');
  }
  const ifds = UTIF.decode(buf);
  if (!ifds || ifds.length === 0) {
    throw new Error('TIFF file contains no image frames.');
  }

  // Pick the highest-resolution frame (skipping thumbnails/overviews in pyramid GeoTIFFs).
  let best = ifds[0]!;
  let bestPixels = (best.width ?? 0) * (best.height ?? 0);
  for (const cand of ifds) {
    const px = (cand.width ?? 0) * (cand.height ?? 0);
    if (px > bestPixels) {
      best = cand;
      bestPixels = px;
    }
  }

  UTIF.decodeImage(buf, best);
  const rgbaRaw = UTIF.toRGBA8(best);
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
    cameraMake || cameraModel || timestamp || georef
      ? {
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
