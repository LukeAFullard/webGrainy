// Writes an example GeoTIFF from a sample photo, for the GIS tutorial: the photo's pixels
// (decoded by ffmpeg) in an uncompressed RGB TIFF, placed on an invented spot in
// NZTM2000 (EPSG:2193) at a given ground size per pixel. The location is made up.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { PHOTO_SIZE, photo } from './lib.mjs';

/**
 * @param {string} file sample photo name
 * @param {{ out: string, metresPerPx: number, x0: number, y0: number }} o top-left corner
 *   (x0 easting, y0 northing) of the photo in metres
 */
export async function makeGeoTiff(file, { out, metresPerPx, x0, y0 }) {
  if (existsSync(out)) return out;
  const { width: w, height: h } = PHOTO_SIZE[file];
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', await photo(file), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (rgb.length !== w * h * 3) throw new Error(`decoded ${rgb.length} bytes, expected ${w * h * 3}`);

  const SHORT = 3, LONG = 4, DOUBLE = 12;
  const size = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8 };
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 2193];
  const tags = [
    [256, LONG, [w]], [257, LONG, [h]], [258, SHORT, [8, 8, 8]], [259, SHORT, [1]], [262, SHORT, [2]],
    [273, LONG, [0]], [277, SHORT, [3]], [278, LONG, [h]], [279, LONG, [rgb.length]], [284, SHORT, [1]],
    [33550, DOUBLE, [metresPerPx, metresPerPx, 0]], [33922, DOUBLE, [0, 0, 0, x0, y0, 0]], [34735, SHORT, geoKeys],
  ];
  const ifdOff = 8;
  const ifdLen = 2 + tags.length * 12 + 4;
  let extra = ifdOff + ifdLen;
  const extras = [];
  for (const t of tags) {
    const bytes = size[t[1]] * t[2].length;
    if (bytes > 4) {
      t.push(extra);
      extras.push(t);
      extra += bytes + (bytes % 2);
    }
  }
  const dataOff = extra;
  tags.find((t) => t[0] === 273)[2] = [dataOff];
  const buf = Buffer.alloc(dataOff + rgb.length);
  buf.write('II', 0, 'ascii');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOff, 4);
  buf.writeUInt16LE(tags.length, ifdOff);
  const put = (type, vals, at) => vals.forEach((v, i) => {
    if (type === SHORT) buf.writeUInt16LE(v, at + 2 * i);
    else if (type === LONG) buf.writeUInt32LE(v, at + 4 * i);
    else buf.writeDoubleLE(v, at + 8 * i);
  });
  tags.forEach(([tag, type, vals, off], i) => {
    const e = ifdOff + 2 + i * 12;
    buf.writeUInt16LE(tag, e);
    buf.writeUInt16LE(type, e + 2);
    buf.writeUInt32LE(vals.length, e + 4);
    if (off !== undefined) buf.writeUInt32LE(off, e + 8);
    else put(type, vals, e + 8);
  });
  buf.writeUInt32LE(0, ifdOff + 2 + tags.length * 12);
  for (const [, type, vals, off] of extras) put(type, vals, off);
  rgb.copy(buf, dataOff);
  writeFileSync(out, buf);
  return out;
}
