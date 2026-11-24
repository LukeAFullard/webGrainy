import type { SitePhotoMetadata } from '../modules/siteAnalysis.js';

/** ASCII text of a tag: at most 256 characters, control characters dropped (camera tags are untrusted). */
function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  const end = Math.min(view.byteLength, offset + Math.min(length, 256));
  for (let i = offset; i < end; i++) {
    const code = view.getUint8(i);
    if (code === 0) break;
    if (code >= 0x20 && code !== 0x7f) out += String.fromCharCode(code);
  }
  return out;
}

function readRational(view: DataView, offset: number, littleEndian: boolean): number | null {
  if (offset + 8 > view.byteLength) return null;
  const num = view.getUint32(offset, littleEndian);
  const den = view.getUint32(offset + 4, littleEndian);
  if (den === 0) return null;
  return num / den;
}

function parseGpsCoordinate(
  view: DataView,
  valueOffset: number,
  littleEndian: boolean,
  ref: string,
): number | null {
  const deg = readRational(view, valueOffset, littleEndian);
  const min = readRational(view, valueOffset + 8, littleEndian);
  const sec = readRational(view, valueOffset + 16, littleEndian);
  if (deg === null || min === null || sec === null) return null;
  let dec = deg + min / 60 + sec / 3600;
  if (ref === 'S' || ref === 'W') dec = -dec;
  return Number.isFinite(dec) ? dec : null;
}

/**
 * Lightweight, zero-dependency local JPEG EXIF parser (`APP1` `0xFFE1`).
 * Extracts optional `DateTimeOriginal`/`DateTime` and GPS `lat`/`lon`
 * entirely in-browser without any external library.
 */
export async function parseJpegExifMetadata(
  blob: Blob,
): Promise<SitePhotoMetadata | undefined> {
  const sliceLen = Math.min(blob.size, 131072);
  if (sliceLen < 12) return undefined;

  const buf = await blob.slice(0, sliceLen).arrayBuffer();
  const view = new DataView(buf);

  // Check JPEG SOI marker 0xFFD8
  if (view.getUint16(0, false) !== 0xffd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset, false);
    offset += 2;
    if ((marker & 0xff00) !== 0xff00) break;
    if (marker === 0xffda || marker === 0xffd9) break; // SOS or EOI

    const segLen = view.getUint16(offset, false);
    if (segLen < 2 || offset + segLen > view.byteLength) break;

    if (marker === 0xffe1 && segLen >= 8) {
      const header = readAscii(view, offset + 2, 6);
      if (header === 'Exif') {
        const tiffStart = offset + 8;
        if (tiffStart + 8 > view.byteLength) return undefined;
        const endianTag = view.getUint16(tiffStart, false);
        const littleEndian = endianTag === 0x4949;
        if (!littleEndian && endianTag !== 0x4d4d) return undefined;

        const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
        const meta: SitePhotoMetadata = {};

        let exifIfdOffset: number | null = null;
        let gpsIfdOffset: number | null = null;

        const parseIfd = (
          ifdRelOffset: number,
          cb: (tag: number, type: number, count: number, valueOrOffset: number, entryOffset: number) => void,
        ): void => {
          const abs = tiffStart + ifdRelOffset;
          if (abs + 2 > view.byteLength) return;
          const count = view.getUint16(abs, littleEndian);
          for (let i = 0; i < count; i++) {
            const entry = abs + 2 + i * 12;
            if (entry + 12 > view.byteLength) break;
            const tag = view.getUint16(entry, littleEndian);
            const type = view.getUint16(entry + 2, littleEndian);
            const valCount = view.getUint32(entry + 4, littleEndian);
            const valOrOff = view.getUint32(entry + 8, littleEndian);
            cb(tag, type, valCount, valOrOff, entry);
          }
        };

        parseIfd(ifd0Offset, (tag, _type, count, valOrOff, entry) => {
          if (tag === 0x010f && count > 0) {
            const off = count <= 4 ? entry + 8 : tiffStart + valOrOff;
            const str = readAscii(view, off, count).trim();
            if (str) meta.cameraMake = str;
          } else if (tag === 0x0110 && count > 0) {
            const off = count <= 4 ? entry + 8 : tiffStart + valOrOff;
            const str = readAscii(view, off, count).trim();
            if (str) meta.cameraModel = str;
          } else if (tag === 0x0132 && count > 4 && !meta.timestamp) {
            const str = readAscii(view, tiffStart + valOrOff, count).trim();
            if (str) meta.timestamp = str;
          } else if (tag === 0x8769) {
            exifIfdOffset = valOrOff;
          } else if (tag === 0x8825) {
            gpsIfdOffset = valOrOff;
          }
        });

        let captureDateFound = false;
        if (exifIfdOffset !== null) {
          parseIfd(exifIfdOffset, (tag, type, count, valOrOff, entry) => {
            // Capture date: DateTimeOriginal, else DateTimeDigitized. Both replace IFD0's DateTime
            // (0x0132), which editing software rewrites to the date the file was last changed.
            if ((tag === 0x9003 || tag === 0x9004) && count > 4) {
              const str = readAscii(view, tiffStart + valOrOff, count).trim();
              if (str && (tag === 0x9003 || !captureDateFound)) meta.timestamp = str;
              if (str) captureDateFound = true;
            } else if (tag === 0xa405 && type === 3 && count >= 1) {
              const fl35 = view.getUint16(entry + 8, littleEndian);
              if (fl35 > 0) meta.focalLength35mm = fl35;
            }
          });
        }

        if (gpsIfdOffset !== null) {
          let latRef = 'N';
          let lonRef = 'E';
          let latOff: number | null = null;
          let lonOff: number | null = null;
          parseIfd(gpsIfdOffset, (tag, _type, _count, valOrOff, entry) => {
            if (tag === 0x0001) {
              latRef = readAscii(view, entry + 8, 2) || 'N';
            } else if (tag === 0x0002) {
              latOff = tiffStart + valOrOff;
            } else if (tag === 0x0003) {
              lonRef = readAscii(view, entry + 8, 2) || 'E';
            } else if (tag === 0x0004) {
              lonOff = tiffStart + valOrOff;
            }
          });
          if (latOff !== null && lonOff !== null) {
            const lat = parseGpsCoordinate(view, latOff, littleEndian, latRef);
            const lon = parseGpsCoordinate(view, lonOff, littleEndian, lonRef);
            if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
              meta.gps = { lat, lon };
            }
          }
        }

        return meta.timestamp !== undefined ||
          meta.gps !== undefined ||
          meta.cameraMake !== undefined ||
          meta.cameraModel !== undefined ||
          meta.focalLength35mm !== undefined
          ? meta
          : undefined;
      }
    }

    offset += segLen;
  }

  return undefined;
}
