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

// ---- Regression: GeoTIFF auto-calibration must give ground distance, not map distance ----
describe('tiffDecode GeoTIFF calibration (regression: Web Mercator scale)', () => {
  // UTIF only writes tags whose type it knows.
  const types = (UTIF as unknown as { _types: { basic: { main: Record<number, number> } } })._types.basic.main;
  types[33550] = 12; // ModelPixelScaleTag, DOUBLE
  types[33922] = 12; // ModelTiepointTag, DOUBLE
  types[34735] = 3; // GeoKeyDirectoryTag, SHORT

  const R = 6378137;
  const northingOf = (latDeg: number): number => R * Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));

  function geoTiff(opts: { epsg: number; units?: number; scaleM: number; tieNorthing?: number; h?: number }): ArrayBuffer {
    const w = 8;
    const h = opts.h ?? 8;
    const keys = [1024, 0, 1, 1, 3072, 0, 1, opts.epsg, ...(opts.units !== undefined ? [3076, 0, 1, opts.units] : [])];
    const tags: Record<string, unknown> = {
      t33550: [opts.scaleM, opts.scaleM, 0],
      t34735: [1, 1, 0, keys.length / 4, ...keys],
    };
    if (opts.tieNorthing !== undefined) tags['t33922'] = [0, 0, 0, 1000, opts.tieNorthing, 0];
    return UTIF.encodeImage(new Uint8Array(w * h * 4).fill(128), w, h, tags as never);
  }

  it('keeps UTM calibration (pixel scale in metres = ground metres)', () => {
    const dec = decodeTiffBuffer(geoTiff({ epsg: 32759, units: 9001, scaleM: 0.01 }));
    expect(dec.calibration?.mmPerPx).toBeCloseTo(10, 9);
  });

  it('converts EPSG:3857 pixel size to ground size with cos(latitude) at the image centre', () => {
    for (const lat of [0, 30, 45, -41.3]) {
      const dec = decodeTiffBuffer(geoTiff({ epsg: 3857, units: 9001, scaleM: 0.01, tieNorthing: northingOf(lat) }));
      // 8 rows of 1 cm: the centre is 4 cm south of the tie point; latitude change is negligible.
      expect(dec.calibration?.mmPerPx).toBeCloseTo(10 * Math.cos((lat * Math.PI) / 180), 4);
    }
  });

  it('also corrects EPSG:3857 without an explicit linear-units key', () => {
    const dec = decodeTiffBuffer(geoTiff({ epsg: 3857, scaleM: 0.01, tieNorthing: northingOf(45) }));
    expect(dec.calibration?.mmPerPx).toBeCloseTo(10 * Math.SQRT1_2, 4);
  });

  it('gives no calibration for EPSG:3857 without a tie point (latitude unknown)', () => {
    expect(decodeTiffBuffer(geoTiff({ epsg: 3857, units: 9001, scaleM: 0.01 })).calibration).toBeUndefined();
  });

  it('gives no calibration when the Mercator scale varies too much across the image', () => {
    // 60 000 rows of 2.5 m (map) at 70°N span ~0.5° of latitude: the ground scale changes by ~2.3%.
    const tall = geoTiff({ epsg: 3857, units: 9001, scaleM: 2.5, tieNorthing: northingOf(70), h: 60000 });
    expect(decodeTiffBuffer(tall).calibration).toBeUndefined();
    // The same pixel size over 8 rows is accepted (and within the 1 m/px sanity range).
    const short = geoTiff({ epsg: 3857, units: 9001, scaleM: 2.5, tieNorthing: northingOf(70) });
    expect(decodeTiffBuffer(short).calibration?.mmPerPx).toBeCloseTo(2500 * Math.cos((70 * Math.PI) / 180), 0);
  });

  it('gives no calibration for uncorrected distorted projections (World Mercator, Plate Carrée)', () => {
    for (const epsg of [3395, 32662]) {
      expect(decodeTiffBuffer(geoTiff({ epsg, units: 9001, scaleM: 0.01, tieNorthing: 5e6 })).calibration).toBeUndefined();
    }
  });
});
