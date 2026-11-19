import { describe, expect, it } from 'vitest';
import UTIF from 'utif2';
import {
  decodeTiffBuffer,
  isSupportedImageFile,
  isTiffBytes,
  isTiffFile,
} from '../src/modules/tiffDecode.js';

describe('tiffDecode', () => {
  it('detects TIFF and supported image files by MIME type or extension', () => {
    expect(isTiffFile({ name: 'ortho.tif', type: '' })).toBe(true);
    expect(isTiffFile({ name: 'ortho.TIFF', type: '' })).toBe(true);
    expect(isTiffFile({ name: 'scan.bin', type: 'image/tiff' })).toBe(true);
    expect(isTiffFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false);

    expect(isSupportedImageFile({ name: 'ortho.tif', type: '' })).toBe(true);
    expect(isSupportedImageFile({ name: 'photo.png', type: 'image/png' })).toBe(true);
    expect(isSupportedImageFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });

  it('encodes and decodes a real TIFF buffer round-trip', () => {
    const w = 16;
    const h = 12;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        rgba[o] = (x * 15) % 256;
        rgba[o + 1] = (y * 20) % 256;
        rgba[o + 2] = 90;
        rgba[o + 3] = 255;
      }
    }

    const tiffBuf = UTIF.encodeImage(rgba, w, h);
    expect(isTiffBytes(tiffBuf)).toBe(true);

    const decoded = decodeTiffBuffer(tiffBuf);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(decoded.data.length).toBe(w * h * 4);
    expect(Array.from(decoded.data)).toEqual(Array.from(rgba));
  });

  it('rejects non-TIFF buffers cleanly', () => {
    const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer;
    expect(isTiffBytes(junk)).toBe(false);
    expect(() => decodeTiffBuffer(junk)).toThrow(/valid TIFF header/i);
  });
});
