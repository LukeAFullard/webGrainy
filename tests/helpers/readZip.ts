import { expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/modules/zip.js';

/** Reads a zip with the central directory (as unzip tools do) and checks every CRC. */
export function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.byteLength - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
    expect(dv.getUint32(off, true)).toBe(0x04034b50);
    const lnl = dv.getUint16(off + 26, true);
    const lextra = dv.getUint16(off + 28, true);
    const data = buf.subarray(off + 30 + lnl + lextra, off + 30 + lnl + lextra + csize);
    const content = method === 8 ? new Uint8Array(inflateRawSync(data)) : data.slice();
    expect(content.byteLength).toBe(size);
    expect(crc32(content)).toBe(crc);
    out.set(name, content);
    p += 46 + nl;
  }
  return out;
}

