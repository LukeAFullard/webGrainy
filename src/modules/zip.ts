/**
 * Minimal ZIP writer (no dependencies): DEFLATE via the platform's CompressionStream where
 * available (small text files), STORE otherwise and for large or already compressed files.
 * Large entries are checksummed by streaming and referenced as Blobs, never copied whole into
 * memory. No ZIP64: the whole archive must stay under 4 GB.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crcUpdate(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}

export function crc32(bytes: Uint8Array): number {
  return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

async function blobCrc32(blob: Blob): Promise<number> {
  let c = 0xffffffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    c = crcUpdate(c, value);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes.slice().buffer]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  } catch {
    return null; // 'deflate-raw' not supported
  }
}

export interface ZipEntry {
  /** Path inside the zip ("/" separators). */
  name: string;
  data: Blob | Uint8Array | string;
  /** Try DEFLATE (default: true for entries up to 64 MB that are not PNG/ZIP). */
  compress?: boolean;
}

const MAX_COMPRESS_BYTES = 64 * 1024 * 1024;
const LIMIT = 0xffffffff;

function dosDateTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/** Builds a .zip Blob from the entries (names must be unique). */
export async function buildZip(entries: readonly ZipEntry[], now = new Date()): Promise<Blob> {
  const enc = new TextEncoder();
  const [time, date] = dosDateTime(now);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const names = new Set<string>();
  for (const e of entries) {
    if (names.has(e.name)) throw new Error(`Duplicate file name in zip: ${e.name}`);
    names.add(e.name);
    const name = enc.encode(e.name);
    const raw: Blob | Uint8Array = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const size = raw instanceof Blob ? raw.size : raw.byteLength;
    const compressible =
      e.compress ?? (size <= MAX_COMPRESS_BYTES && !/\.(png|zip|webgrainy|jpe?g)$/i.test(e.name));
    let method = 0;
    let crc: number;
    let body: Blob | Uint8Array = raw;
    if (compressible && size <= MAX_COMPRESS_BYTES) {
      const bytes = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : raw;
      crc = crc32(bytes);
      const deflated = await deflateRaw(bytes);
      if (deflated !== null && deflated.byteLength < bytes.byteLength) {
        method = 8;
        body = deflated;
      } else {
        body = bytes;
      }
    } else {
      crc = raw instanceof Blob ? await blobCrc32(raw) : crc32(raw);
    }
    const csize = body instanceof Blob ? body.size : body.byteLength;
    if (size > LIMIT || csize > LIMIT || offset > LIMIT) throw new Error('The download is larger than 4 GB; leave out the project file or download fewer photos.');
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, csize, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, csize, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    parts.push(local as BlobPart, body as BlobPart);
    offset += local.byteLength + csize;
  }
  const cdSize = central.reduce((n, c) => n + c.byteLength, 0);
  if (offset + cdSize > LIMIT) throw new Error('The download is larger than 4 GB; leave out the project file or download fewer photos.');
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end as BlobPart], { type: 'application/zip' });
}
