/**
 * GeoTIFF of a photo's label mask, in the map position and coordinate system of the photo's
 * source GeoTIFF. Unlike a PNG + world file (which carries no CRS), every GIS reads its CRS.
 *
 * Single-band unsigned integer (16-bit, or 32-bit when a grain id exceeds 65535), one strip,
 * deflate-compressed when the platform has CompressionStream, background 0 declared as nodata
 * (GDAL_NODATA tag) so it is transparent over the photo. The georeference is written as
 * ModelPixelScale + ModelTiepoint (or ModelTransformation when the transform is rotated) with
 * RasterType PixelIsArea, matching the corner-based transform of PhotoGeoreference.
 */
import type { PhotoGeoreference } from './siteTypes.js';
import { APP_VERSION, BUILD_COMMIT } from './provenance.js';

/** GeoKey directory (+ double / ASCII parameters) for a georeference. */
export function geoKeysFor(g: PhotoGeoreference): { directory: number[]; doubles: number[]; ascii: string } {
  // The source file's own keys (any CRS, also user-defined ones), with RasterType forced to
  // PixelIsArea: the transform written below is corner-based.
  const src = g.geoKeys;
  if (src && src.directory.length >= 4) {
    const dir = src.directory.slice();
    const n = dir[3]!;
    let hasRasterType = false;
    for (let i = 0; i < n; i++) {
      const b = 4 + i * 4;
      if (dir[b] === 1025) {
        dir[b + 1] = 0;
        dir[b + 2] = 1;
        dir[b + 3] = 1;
        hasRasterType = true;
      }
    }
    const keys = hasRasterType ? dir : insertKey(dir, [1025, 0, 1, 1]);
    return { directory: keys, doubles: src.doubles ?? [], ascii: src.ascii ?? '' };
  }
  // Older photos (keys not kept): rebuild them from the EPSG code.
  const entries: number[][] = [];
  const model = g.kind === 'geographic' ? 2 : g.kind === 'projected' ? 1 : g.epsg !== null ? 1 : 0;
  if (model > 0) entries.push([1024, 0, 1, model]);
  entries.push([1025, 0, 1, 1]);
  if (g.epsg !== null) entries.push([model === 2 ? 2048 : 3072, 0, 1, g.epsg]);
  return { directory: [1, 1, 0, entries.length, ...entries.flat()], doubles: [], ascii: '' };
}

function insertKey(dir: number[], key: number[]): number[] {
  const n = dir[3]!;
  const entries: number[][] = [];
  for (let i = 0; i < n; i++) entries.push(dir.slice(4 + i * 4, 8 + i * 4));
  entries.push(key);
  entries.sort((x, y) => x[0]! - y[0]!);
  return [dir[0]!, dir[1]!, dir[2]!, entries.length, ...entries.flat()];
}

async function deflate(raw: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> })
    .CompressionStream;
  if (typeof CS !== 'function' || typeof Response !== 'function' || typeof Blob !== 'function') return null;
  try {
    const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CS('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

type Tag = { tag: number; type: 2 | 3 | 4 | 12; values: number[] | string };

/** Options for GeoTIFF exports. */
export interface GeoTiffWriteOptions {
  compress?: boolean;
  /** Provenance text (e.g. JSON) for ImageDescription (270); non-ASCII is \u-escaped. */
  description?: string;
}

/** TIFF ASCII tags are 7-bit: escape anything else as \uXXXX (still valid inside JSON strings). */
function asciiOnly(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Encodes `masks` (grain ids, photo size `width` x `height`) as a GeoTIFF placed by `g`. */
export async function encodeLabelGeoTiff(
  masks: Int32Array,
  width: number,
  height: number,
  g: PhotoGeoreference,
  options: GeoTiffWriteOptions = {},
): Promise<Uint8Array> {
  if (masks.length !== width * height) throw new Error('Label mask size does not match the photo.');
  let max = 0;
  for (let i = 0; i < masks.length; i++) if (masks[i]! > max) max = masks[i]!;
  const bps = max > 65535 ? 32 : 16;
  const raw = new Uint8Array(width * height * (bps / 8));
  const dv = new DataView(raw.buffer);
  for (let i = 0; i < masks.length; i++) {
    const v = Math.max(0, masks[i]!);
    if (bps === 16) dv.setUint16(i * 2, v, true);
    else dv.setUint32(i * 4, v, true);
  }
  return encodeGeoTiff({ raw, width, height, bitsPerSample: bps, samples: 1, nodata: '0' }, g, options);
}

/**
 * GeoTIFF of an image placed by `g`: 1 band (grey / labels) or 4 bands (RGBA, unassociated
 * alpha), unsigned integers, little-endian sample bytes in `raw`.
 */
export async function encodeGeoTiff(
  img: { raw: Uint8Array; width: number; height: number; bitsPerSample: 8 | 16 | 32; samples: 1 | 4; nodata?: string },
  g: PhotoGeoreference,
  options: GeoTiffWriteOptions = {},
): Promise<Uint8Array> {
  const { raw, width, height, samples } = img;
  const bps = img.bitsPerSample;
  if (raw.length !== width * height * samples * (bps / 8)) throw new Error('Image data size does not match.');
  const packed = options.compress === false ? null : await deflate(raw);
  const data = packed ?? raw;

  const [a, b, c, d, e, f] = g.transform;
  const keys = geoKeysFor(g);
  const tags: Tag[] = [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 258, type: 3, values: Array(samples).fill(bps) },
    { tag: 259, type: 3, values: [packed ? 8 : 1] },
    { tag: 262, type: 3, values: [samples === 4 ? 2 : 1] },
    { tag: 273, type: 4, values: [0] }, // strip offset, filled in below
    { tag: 277, type: 3, values: [samples] },
    { tag: 278, type: 4, values: [height] },
    { tag: 279, type: 4, values: [data.length] },
    { tag: 284, type: 3, values: [1] },
    { tag: 339, type: 3, values: Array(samples).fill(1) },
  ];
  if (samples === 4) tags.push({ tag: 338, type: 3, values: [2] }); // ExtraSamples: unassociated alpha
  // Provenance, as in the other exports: which app and build wrote the file, and how.
  tags.push({ tag: 305, type: 2, values: asciiOnly(`webGrainy ${APP_VERSION} (${BUILD_COMMIT})`) }); // Software
  if (options.description) tags.push({ tag: 270, type: 2, values: asciiOnly(options.description) }); // ImageDescription
  // Tie point + pixel scale only describe north-up rasters (columns go east, rows go south): a
  // negative ScaleX/ScaleY is invalid and GDAL silently flips it. Anything else (south-up,
  // mirrored, rotated) is written as a full ModelTransformationTag.
  if (c === 0 && e === 0 && b > 0 && f < 0) {
    tags.push({ tag: 33550, type: 12, values: [b, -f, 0] });
    tags.push({ tag: 33922, type: 12, values: [0, 0, 0, a, d, 0] });
  } else {
    tags.push({ tag: 34264, type: 12, values: [b, c, 0, a, e, f, 0, d, 0, 0, 0, 0, 0, 0, 0, 1] });
  }
  tags.push({ tag: 34735, type: 3, values: keys.directory });
  if (keys.doubles.length > 0) tags.push({ tag: 34736, type: 12, values: keys.doubles });
  if (keys.ascii.length > 0) tags.push({ tag: 34737, type: 2, values: keys.ascii });
  if (img.nodata !== undefined) tags.push({ tag: 42113, type: 2, values: img.nodata }); // GDAL_NODATA
  tags.sort((x, y) => x.tag - y.tag);

  // Layout: header (8) | IFD | out-of-line tag values | strip.
  const size = (t: Tag): number => (t.type === 2 ? (t.values as string).length + 1 : (t.values as number[]).length * (t.type === 3 ? 2 : t.type === 4 ? 4 : 8));
  const ifdSize = 2 + tags.length * 12 + 4;
  let extra = 8 + ifdSize;
  const offsets = new Map<number, number>();
  for (const t of tags) {
    if (size(t) > 4) {
      offsets.set(t.tag, extra);
      extra += size(t) + (size(t) % 2);
    }
  }
  const stripOffset = extra;
  (tags.find((t) => t.tag === 273)!.values as number[])[0] = stripOffset;
  const out = new Uint8Array(stripOffset + data.length);
  const o = new DataView(out.buffer);
  o.setUint16(0, 0x4949, true);
  o.setUint16(2, 42, true);
  o.setUint32(4, 8, true);
  o.setUint16(8, tags.length, true);
  const write = (t: Tag, at: number): void => {
    if (t.type === 2) {
      const s = t.values as string;
      for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i) & 0xff;
      out[at + s.length] = 0;
      return;
    }
    (t.values as number[]).forEach((v, i) => {
      if (t.type === 3) o.setUint16(at + i * 2, v, true);
      else if (t.type === 4) o.setUint32(at + i * 4, v, true);
      else o.setFloat64(at + i * 8, v, true);
    });
  };
  tags.forEach((t, i) => {
    const p = 10 + i * 12;
    o.setUint16(p, t.tag, true);
    o.setUint16(p + 2, t.type, true);
    o.setUint32(p + 4, t.type === 2 ? (t.values as string).length + 1 : (t.values as number[]).length, true);
    if (size(t) > 4) {
      o.setUint32(p + 8, offsets.get(t.tag)!, true);
      write(t, offsets.get(t.tag)!);
    } else {
      write(t, p + 8);
    }
  });
  o.setUint32(10 + tags.length * 12, 0, true);
  out.set(data, stripOffset);
  return out;
}
