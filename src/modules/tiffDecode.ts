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
 * `mmPerPx` calibration automatically.
 */
import UTIF from 'utif2';
import type { CalibrationResult } from '../types/index.js';
import type { SitePhotoMetadata } from './siteTypes.js';

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

/**
 * Extracts `mmPerPx` from a projected GeoTIFF's `ModelPixelScaleTag` (33550) when
 * `GeoKeyDirectoryTag` (34735) indicates a projected meter coordinate system.
 */
function extractGeoTiffCalibration(
  ifd: Record<string, unknown>,
  width: number,
): CalibrationResult | undefined {
  const scaleTag = ifd['t33550'];
  const geoDir = ifd['t34735'];
  if (!Array.isArray(scaleTag) || scaleTag.length < 2) return undefined;
  if (!Array.isArray(geoDir) || geoDir.length < 4) return undefined;

  const numKeys = Number(geoDir[3]) || 0;
  let modelType: number | undefined;
  let linearUnits: number | undefined;
  for (let i = 0; i < numKeys; i++) {
    const base = 4 + i * 4;
    if (base + 3 >= geoDir.length) break;
    const keyId = Number(geoDir[base]);
    const tiffTagLocation = Number(geoDir[base + 1]);
    const valueOffset = Number(geoDir[base + 3]);
    if (tiffTagLocation === 0) {
      if (keyId === 1024) modelType = valueOffset; // GTModelTypeGeoKey: 1 = Projected
      if (keyId === 3076) linearUnits = valueOffset; // ProjLinearUnitsGeoKey: 9001 = meter
    }
  }
  // Only trust scale when explicitly Projected (1) and in meters (9001 or default unset).
  if (modelType !== 1) return undefined;
  if (linearUnits !== undefined && linearUnits !== 9001) return undefined;

  const sx = Number(scaleTag[0]);
  const sy = Number(scaleTag[1]);
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return undefined;
  // Require near-square pixels (within 5%).
  if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.05) return undefined;

  const mmPerPx = ((sx + sy) / 2) * 1000;
  // Sanity range: 0.01 mm/px (macro) to 1000 mm/px (1 m/px).
  if (mmPerPx < 0.01 || mmPerPx > 1000) return undefined;

  const spanPx = Math.min(100, Math.max(10, Math.round(width / 4)));
  return {
    mmPerPx,
    pointA: { x: 0, y: 0 },
    pointB: { x: spanPx, y: 0 },
    pixelDistance: spanPx,
    physicalLengthMm: spanPx * mmPerPx,
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
  const metadata: SitePhotoMetadata | undefined =
    cameraMake || cameraModel || timestamp
      ? {
          ...(timestamp ? { timestamp } : {}),
          ...(cameraMake ? { cameraMake } : {}),
          ...(cameraModel ? { cameraModel } : {}),
        }
      : undefined;

  const calibration = extractGeoTiffCalibration(rawIfd, width);

  return {
    data: new Uint8ClampedArray(rgbaRaw.buffer, rgbaRaw.byteOffset, width * height * 4),
    width,
    height,
    ...(metadata ? { metadata } : {}),
    ...(calibration ? { calibration } : {}),
  };
}
