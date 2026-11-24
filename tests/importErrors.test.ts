/**
 * Import errors a user can act on (production readiness review m3): a photo the browser cannot
 * decode, and TIFFs that crash the TIFF library, are reported in words instead of raw errors.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeTiffBuffer } from '../src/modules/tiffDecode.js';
import { isHeicFile, undecodableImageError } from '../src/ui/importErrors.js';

/** A fixture as its own ArrayBuffer. */
const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

// Small TIFFs with a few damaged bytes, found by fuzzing the decoder: inside UTIF the first
// failed with "TypeError: Cannot read properties of undefined (reading '0')", the second
// threw the number 1. Both reached the user as-is before.
describe('damaged TIFFs that crash the TIFF library', () => {
  it('a TypeError inside UTIF is reported as a damaged TIFF, keeping the cause', () => {
    let err: unknown;
    try {
      decodeTiffBuffer(fixture('damaged_tiff_utif_typeerror.tif'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('This TIFF file is damaged or not a valid TIFF (its image data could not be read), so it was not opened.');
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it('a non-Error value thrown inside UTIF is reported the same way', () => {
    let err: unknown;
    try {
      decodeTiffBuffer(fixture('damaged_tiff_utif_throws_number.tif'));
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/^This TIFF file is damaged or not a valid TIFF \(its image data could not be read\)/);
    expect((err as Error).cause).toBe(1);
  });

  it('the decoder’s own explanations are kept unchanged', () => {
    expect(() => decodeTiffBuffer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toThrow('File does not have a valid TIFF header.');
  });
});

describe('photos the browser cannot decode', () => {
  it('recognises HEIC / HEIF by name or type', () => {
    expect(isHeicFile({ name: 'IMG_1.HEIC' })).toBe(true);
    expect(isHeicFile({ name: 'a.heif' })).toBe(true);
    expect(isHeicFile({ name: 'photo', type: 'image/heic' })).toBe(true);
    expect(isHeicFile({ name: 'photo', type: 'image/heif-sequence' })).toBe(true);
    expect(isHeicFile({ name: 'heic.jpg', type: 'image/jpeg' })).toBe(false);
  });

  it('explains empty, HEIC and damaged files, keeping the browser error as the cause', () => {
    const cause = new Error('The source image could not be decoded.');
    expect(undecodableImageError({ name: 'e.png', size: 0 }, cause).message).toBe('the file is empty (0 bytes).');
    expect(undecodableImageError({ name: 'IMG.HEIC', size: 10 }, cause).message).toMatch(/^HEIC\/HEIF photos cannot be opened in this browser\. Save or share the photo as JPEG/);
    const damaged = undecodableImageError({ name: 'x.jpg', type: 'image/jpeg', size: 10 }, cause);
    expect(damaged.message).toBe('the file is damaged, or not an image this browser can read. Use JPEG, PNG, WebP or TIFF.');
    expect(damaged.cause).toBe(cause);
  });
});
