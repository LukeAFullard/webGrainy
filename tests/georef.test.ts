import { describe, expect, it } from 'vitest';
import UTIF from 'utif2';
import { extractGeoReference, geoJsonToMap, pamAuxXml, photoGeoreference, toMap, worldFile } from '../src/modules/georef.js';
import { encodeLabelGeoTiff, geoKeysFor } from '../src/modules/geotiffWriter.js';
import { buildContourGeoJson, signedRingArea } from '../src/modules/exportFormats.js';
import { computeAllGrainMorphometrics } from '../src/modules/interactiveEditor.js';
import { sanitizePhotoMetadata } from '../src/modules/archiveSanitize.js';
import { decodeTiffBuffer } from '../src/modules/tiffDecode.js';
import { buildExport } from '../src/modules/exports.js';
import { resultsBundleEntries } from '../src/modules/resultsBundle.js';
import type { PhotoGeoreference } from '../src/modules/siteTypes.js';
import { squareGrainSession } from './helpers/squareSession.js';

const keys = (pairs: Array<[number, number]>) => [1, 1, 0, pairs.length, ...pairs.flatMap(([k, v]) => [k, 0, 1, v])];

describe('GeoTIFF georeference', () => {
  it('reads tie point + pixel size (pixel is area)', () => {
    const g = extractGeoReference({ t33922: [0, 0, 0, 500000, 5000000, 0], t33550: [0.01, 0.01, 0], t34735: keys([[1024, 1], [3072, 32759]]) }, 100, 80)!;
    expect(g).toMatchObject({ epsg: 32759, kind: 'projected', width: 100, height: 80 });
    expect(toMap(g, 0, 0)).toEqual([500000, 5000000]); // top-left corner
    expect(toMap(g, 100, 80)[0]).toBeCloseTo(500001, 9);
    expect(toMap(g, 100, 80)[1]).toBeCloseTo(4999999.2, 9);
  });

  it('moves a pixel-is-point tie point from the pixel centre to its corner', () => {
    const g = extractGeoReference({ t33922: [0, 0, 0, 100, 200, 0], t33550: [2, 2, 0], t34735: keys([[1024, 1], [1025, 2], [3072, 2193]]) }, 10, 10)!;
    expect(toMap(g, 0.5, 0.5)).toEqual([100, 200]); // centre of pixel (0,0) = the tie point
  });

  it('reads a full transformation matrix (rotated raster)', () => {
    const m = [0.5, 0.1, 0, 1000, 0.1, -0.5, 0, 2000, 0, 0, 0, 0, 0, 0, 0, 1];
    const g = extractGeoReference({ t34264: m, t34735: keys([[1024, 1], [3072, 32759]]) }, 10, 10)!;
    expect(toMap(g, 2, 4)).toEqual([1000 + 0.5 * 2 + 0.1 * 4, 2000 + 0.1 * 2 - 0.5 * 4]);
  });

  it('keeps a user-defined CRS as epsg null, and nothing without georeferencing tags', () => {
    expect(extractGeoReference({ t33922: [0, 0, 0, 1, 1, 0], t33550: [1, 1, 0], t34735: keys([[1024, 1], [3072, 32767]]) }, 4, 4)?.epsg).toBeNull();
    expect(extractGeoReference({}, 4, 4)).toBeUndefined();
  });

  it('does not take a projected raster\'s base datum (2048) as its CRS when 3072 is missing', () => {
    const tag = { t33922: [0, 0, 0, 1600000, 5200000, 0], t33550: [1, 1, 0] };
    const projected = extractGeoReference({ ...tag, t34735: keys([[1024, 1], [2048, 4326], [3075, 1], [3076, 9001]]) }, 4, 4)!;
    expect(projected).toMatchObject({ epsg: null, kind: 'projected' });
    const geographic = extractGeoReference({ t33922: [0, 0, 0, 172, -43, 0], t33550: [0.001, 0.001, 0], t34735: keys([[1024, 2], [2048, 4326]]) }, 4, 4)!;
    expect(geographic).toMatchObject({ epsg: 4326, kind: 'geographic' });
  });

  it('is stored with the photo when a GeoTIFF is decoded', () => {
    const types = (UTIF as unknown as { _types: { basic: { main: Record<number, number> } } })._types.basic.main;
    types[33550] = 12;
    types[33922] = 12;
    types[34735] = 3;
    const tif = UTIF.encodeImage(new Uint8Array(8 * 8 * 4).fill(100), 8, 8, {
      t33550: [0.02, 0.02, 0], t33922: [0, 0, 0, 1500000, 5200000, 0], t34735: keys([[1024, 1], [3072, 2193], [3076, 9001]]),
    } as never);
    const dec = decodeTiffBuffer(tif);
    expect(dec.metadata?.georef).toMatchObject({ epsg: 2193, width: 8, height: 8, transform: [1500000, 0.02, 0, 5200000, 0, -0.02] });
  });
});

describe('map-coordinate exports', () => {
  // Photo 120 x 120 px (working 60 x 60 at scale 0.5); 1 photo px = 1 cm from (1000, 5000).
  const georef: PhotoGeoreference = { transform: [1000, 0.01, 0, 5000, 0, -0.01], epsg: 2193, kind: 'projected', width: 120, height: 120 };
  const session = squareGrainSession([10], { w: 60, h: 60, scale: 0.5 });
  const photo = { photoId: 'p', siteId: 's', label: 'ortho.tif', imageBlob: new Blob([]), width: 120, height: 120, addedAt: 0, included: true, metadata: { georef } };

  it('GeoJSON outlines and centroids land in map coordinates, with the CRS', () => {
    const fc = JSON.parse(geoJsonToMap(session.exportGeoJson(), georef)) as {
      crs: { properties: { name: string } };
      features: Array<{ geometry: { coordinates: number[][][] }; properties: Record<string, number> }>;
    };
    expect(fc.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::2193');
    const ring = fc.features[0]!.geometry.coordinates[0]!;
    // The grain covers photo pixels 20..39 -> X from 1000.20 to 1000.40, Y from 4999.80 down to 4999.60.
    expect(Math.min(...ring.map((p) => p[0]!))).toBeCloseTo(1000.2, 9);
    expect(Math.max(...ring.map((p) => p[0]!))).toBeCloseTo(1000.4, 9);
    expect(Math.max(...ring.map((p) => p[1]!))).toBeCloseTo(4999.8, 9);
    expect(fc.features[0]!.properties['centroidMapX']).toBeCloseTo(1000.3, 9);
    expect(fc.features[0]!.properties['centroidMapY']).toBeCloseTo(4999.7, 9);
  });

  it('world file places the top-left pixel centre', () => {
    expect(worldFile(georef).trim().split('\n').map(Number)).toEqual([0.01, 0, 0, -0.01, 1000.005, 4999.995]);
  });

  it('is offered only while the photo is still the GeoTIFF raster', async () => {
    expect(photoGeoreference(photo).georef).not.toBeNull();
    expect(photoGeoreference({ ...photo, width: 200, height: 200 }).reason).toMatch(/no longer has its GeoTIFF size/);
    expect(photoGeoreference({ ...photo, metadata: { georef, processingHistory: [{ step: 'rectification' } as never] } }).reason).toMatch(/rectified/);
    const ctx = { site: null, session, siteReport: null, siteInputs: [], psdXAxis: 'mm' as const };
    expect(await buildExport('photo-geojson-map', { ...ctx, photo: photo as never })).not.toBeNull();
    expect(await buildExport('photo-geojson-map', { ...ctx, photo: { ...photo, metadata: {} } as never })).toBeNull();
    // The map-coordinate GeoJSON names its CRS (web maps read any .geojson as longitude/latitude).
    expect((await buildExport('photo-geojson-map', { ...ctx, photo: photo as never }))!.filename).toBe('ortho_tif_outlines_EPSG2193.geojson');
    const custom = { ...photo, metadata: { georef: { ...georef, epsg: null } } };
    expect((await buildExport('photo-geojson-map', { ...ctx, photo: custom as never }))!.filename).toBe('ortho_tif_outlines_customCRS.geojson');
    expect((await buildExport('photo-geojson-lonlat', { ...ctx, photo: photo as never }))!.filename).toBe('ortho_tif_outlines_lonlat.geojson');
  });

  it('Download results adds map outlines and the mask world file for GeoTIFF photos', async () => {
    const entries = await resultsBundleEntries({
      site: { siteId: 's', name: 'S', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p'] },
      photos: [photo as never], siteInputs: [{ photoId: 'p', label: 'ortho.tif', included: true, session }], siteReport: null,
      siteOptions: {}, sizeMetric: 'bAxis', psdXAxis: 'mm', includeProject: false,
    });
    const names = entries.map((e) => e.name);
    expect(names).toContain('photos/ortho/outlines_EPSG2193.geojson');
    expect(names).toContain('photos/ortho/mask16.pgw');
    expect(names).toContain('photos/ortho/mask_map.tif');
    expect(names).toContain('photos/ortho/mask16.png.aux.xml');
    const readme = entries.find((e) => e.name === 'README.txt')!.data as string;
    expect(readme).toContain('mask_map.tif is the label mask as a GeoTIFF, CRS included');
    expect(names).toContain('photos/ortho/outlines_lonlat.geojson');
    expect(readme).toContain('not map coordinates');
  });
});

describe('Export dialog: outlines / mask / photo as choices, not one button per variant', () => {
  const session = squareGrainSession([10], { w: 60, h: 60, scale: 0.5 });
  const georef: PhotoGeoreference = { transform: [1000, 0.01, 0, 5000, 0, -0.01], epsg: 32759, kind: 'projected', width: 120, height: 120 };
  const base = { photoId: 'p', siteId: 's', label: 'ortho.tif', imageBlob: new Blob([]), width: 120, height: 120, addedAt: 0, included: true };

  it('every combination maps to the right export, labelled with the photo\'s own CRS', async () => {
    const { photoExportChoice } = await import('../src/ui/modals.js');
    const geo = { ...base, metadata: { georef } } as never;
    const k = (what: string, format: string, coords: string) => photoExportChoice(geo, { what, format, coords }).kind;
    expect(k('outlines', 'geojson', 'pixels')).toBe('photo-geojson');
    expect(k('outlines', 'geojson', 'lonlat')).toBe('photo-geojson-lonlat');
    expect(k('outlines', 'geojson', 'map')).toBe('photo-geojson-map');
    expect(k('outlines', 'svg', 'lonlat')).toBe('photo-svg'); // SVG is photo pixels only
    expect(k('mask', 'png16', 'map')).toBe('photo-mask-16');
    expect(k('mask', 'png32', 'pixels')).toBe('photo-mask-32');
    expect(k('mask', 'geotiff', 'map')).toBe('photo-mask-geotiff');
    expect(k('mask', 'geotiff', 'webmercator')).toBe('photo-mask-webmercator');
    expect(k('photo', 'geotiff', 'webmercator')).toBe('photo-image-webmercator');
    const c = photoExportChoice(geo, { what: 'outlines', format: 'geojson', coords: 'map' });
    expect(c.coordsList.map(([, t]) => t).join(' | ')).toContain('EPSG:32759');
    expect(JSON.stringify(c)).not.toContain('2193');
    // A user-defined CRS is named as such.
    const custom = photoExportChoice({ ...base, metadata: { georef: { ...georef, epsg: null } } } as never, { what: 'outlines', format: 'geojson', coords: 'map' });
    expect(custom.coordsList.map(([, t]) => t).join(' | ')).toContain('custom CRS');
  });

  it('a photo without a GeoTIFF offers only photo-pixel choices', async () => {
    const { photoExportChoice } = await import('../src/ui/modals.js');
    const c = photoExportChoice(base as never, { what: 'photo', format: 'geotiff', coords: 'lonlat' });
    expect(c.whats.map(([w]) => w)).toEqual(['outlines', 'mask']);
    expect(c.kind).toBe('photo-geojson'); // invalid selection falls back to valid defaults
    expect(c.coordsList).toEqual([['pixels', 'Photo pixels']]);
    expect(photoExportChoice(base as never, { what: 'mask' }).formats.map(([f]) => f)).toEqual(['png16', 'png32']);
  });

  it('the dialog shows selects and one Download button, and says why map exports are unavailable', async () => {
    const { renderExportModalHtml } = await import('../src/ui/modals.js');
    const { createInitialState } = await import('../src/ui/state.js');
    const state = (photo: object) => ({ ...createInitialState(), activePhotoId: 'p', photos: [photo], sessions: new Map([['p', session]]) }) as never;
    const geo = renderExportModalHtml(state({ ...base, metadata: { georef } }));
    expect(geo).toContain('data-export-opt="what"');
    expect(geo).toContain('data-export-opt="coords"');
    expect(geo).toContain('data-export="photo-geojson-lonlat"'); // default: outlines, GeoJSON, lon/lat
    expect((geo.match(/data-export="photo-(geojson|mask|image|svg)/g) ?? []).length).toBe(1);
    const rectified = renderExportModalHtml(state({ ...base, metadata: { georef, processingHistory: [{ step: 'rectification' }] } }));
    expect(rectified).toContain('was rectified');
    expect(rectified).toContain('data-export="photo-geojson"');
  });
});

describe('label mask GeoTIFF (audit: a world file carries no CRS)', () => {
  const decode = (bytes: Uint8Array) => {
    const ifd = UTIF.decode(bytes.slice().buffer)[0]! as unknown as Record<string, unknown> & { width: number; height: number; data: Uint8Array };
    UTIF.decodeImage(bytes.slice().buffer, ifd as never);
    return ifd;
  };
  // A source like the reported file: NZTM 2000, 2 cm pixels, citation in GeoAsciiParams.
  const nztmKeys = { directory: [1, 1, 0, 7, 1024, 0, 1, 1, 1025, 0, 1, 1, 1026, 34737, 48, 0, 2049, 34737, 9, 48, 2054, 0, 1, 9102, 3072, 0, 1, 2193, 3076, 0, 1, 9001], ascii: 'NZGD2000 / New Zealand Transverse Mercator 2000|NZGD2000|' };
  const g: PhotoGeoreference = { transform: [1793110.34, 0.02, 0, 5495817.62, 0, -0.02], epsg: 2193, kind: 'projected', width: 6, height: 4, geoKeys: nztmKeys };
  const masks = Int32Array.from([0, 1, 1, 0, 2, 2, 0, 1, 1, 0, 2, 2, 0, 0, 0, 0, 0, 0, 3, 3, 3, 0, 0, 0]);

  it('round-trips: same transform, same CRS keys and citation, same grain ids, background nodata', async () => {
    for (const compress of [true, false]) {
      const ifd = decode(await encodeLabelGeoTiff(masks, 6, 4, g, { compress }));
      const back = extractGeoReference(ifd, 6, 4)!;
      back.transform.forEach((v, i) => expect(v).toBeCloseTo(g.transform[i]!, 9));
      expect(back.epsg).toBe(2193);
      expect(back.geoKeys!.directory).toEqual(nztmKeys.directory);
      expect(back.geoKeys!.ascii).toBe(nztmKeys.ascii);
      expect(ifd['t42113']).toEqual(['0']);
      const px = new Uint16Array(ifd.data.buffer, ifd.data.byteOffset, 24);
      expect([...px]).toEqual([...masks]);
    }
  });

  it('writes RasterType PixelIsArea (the transform is corner-based), adding it when missing', () => {
    const point = { ...g, geoKeys: { directory: [1, 1, 0, 2, 1024, 0, 1, 1, 1025, 0, 1, 2] } };
    expect(geoKeysFor(point).directory).toEqual([1, 1, 0, 2, 1024, 0, 1, 1, 1025, 0, 1, 1]);
    const none = { ...g, geoKeys: { directory: [1, 1, 0, 1, 3072, 0, 1, 2193] } };
    expect(geoKeysFor(none).directory).toEqual([1, 1, 0, 2, 1025, 0, 1, 1, 3072, 0, 1, 2193]);
  });

  it('rebuilds keys from the EPSG code for photos imported before keys were kept', async () => {
    const { geoKeys: _k, ...old } = g;
    expect(geoKeysFor(old).directory).toEqual([1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 2193]);
    const geo = { ...old, epsg: 4326, kind: 'geographic' as const };
    expect(geoKeysFor(geo).directory).toEqual([1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]);
    const back = extractGeoReference(decode(await encodeLabelGeoTiff(masks, 6, 4, old)), 6, 4)!;
    expect(back.epsg).toBe(2193);
  });

  it('keeps a user-defined CRS through its own keys and parameters', async () => {
    const custom: PhotoGeoreference = { ...g, epsg: null, geoKeys: { directory: [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 32767], doubles: [173, -41, 0.9996] } };
    const ifd = decode(await encodeLabelGeoTiff(masks, 6, 4, custom));
    expect(extractGeoReference(ifd, 6, 4)!.geoKeys!.doubles).toEqual([173, -41, 0.9996]);
  });

  it('writes a rotated transform as ModelTransformation', async () => {
    const rot: PhotoGeoreference = { ...g, transform: [1000, 0.5, 0.1, 2000, 0.1, -0.5] };
    const ifd = decode(await encodeLabelGeoTiff(masks, 6, 4, rot));
    expect(ifd['t33550']).toBeUndefined();
    expect(toMap(extractGeoReference(ifd, 6, 4)!, 2, 3)).toEqual(toMap(rot, 2, 3));
  });

  it('writes south-up and mirrored rasters as ModelTransformation, never a negative pixel scale', async () => {
    for (const transform of [
      [1750000, 0.002, 0, 5430000, 0, 0.002], // south-up (f > 0)
      [1750000, -0.002, 0, 5430000, 0, -0.002], // mirrored east-west (b < 0)
    ] as PhotoGeoreference['transform'][]) {
      const flipped: PhotoGeoreference = { ...g, transform };
      const ifd = decode(await encodeLabelGeoTiff(masks, 6, 4, flipped));
      expect(ifd['t33550']).toBeUndefined();
      expect(ifd['t33922']).toBeUndefined();
      expect(toMap(extractGeoReference(ifd, 6, 4)!, 2, 3)).toEqual(toMap(flipped, 2, 3));
    }
  });

  it('auto-calibrates a south-up GeoTIFF from its ModelTransformation', async () => {
    const southUp: PhotoGeoreference = { ...g, transform: [1750000, 0.002, 0, 5430000, 0, 0.002] };
    const bytes = await encodeLabelGeoTiff(masks, 6, 4, southUp, { compress: false });
    const dec = decodeTiffBuffer(bytes.slice().buffer);
    expect(dec.calibration?.mmPerPx).toBeCloseTo(2, 9);
    expect(dec.calibration?.source).toBe('geotiff');
  });

  it('records provenance in Software and ImageDescription (audit S3), ASCII-safe', async () => {
    const ifd = decode(await encodeLabelGeoTiff(masks, 6, 4, g, { description: JSON.stringify({ appVersion: '9.9', photo: 'Ōtaki é.tif' }) }));
    expect(String((ifd['t305'] as string[])[0])).toMatch(/^webGrainy /);
    const desc = String((ifd['t270'] as string[])[0]);
    expect(/^[\x20-\x7e]*$/.test(desc)).toBe(true);
    expect(JSON.parse(desc)).toEqual({ appVersion: '9.9', photo: 'Ōtaki é.tif' });
  });

  it('a 32-bit file when a grain id exceeds 65535', async () => {
    const big = masks.slice();
    big[1] = 70000;
    const ifd = decode(await encodeLabelGeoTiff(big, 6, 4, g));
    expect(ifd['t258']).toEqual([32]);
    expect(new Uint32Array(ifd.data.buffer, ifd.data.byteOffset, 24)[1]).toBe(70000);
  });

  it('aux.xml names the EPSG CRS for the PNG + world file; none for a user-defined CRS', () => {
    expect(pamAuxXml(g)).toContain('<SRS>EPSG:2193</SRS>');
    expect(pamAuxXml({ ...g, epsg: null })).toBeNull();
  });

  it('a 2x upscaled photo keeps its map position with half the pixel size', () => {
    const up = { width: 12, height: 8, metadata: { georef: g, processingHistory: [{ step: 'enhancement', kind: 'upscale-2x' } as never] } };
    const r = photoGeoreference(up).georef!;
    expect(r.transform).toEqual([1793110.34, 0.01, 0, 5495817.62, 0, -0.01]);
    expect([r.width, r.height]).toEqual([12, 8]);
    expect(toMap(r, 12, 8)).toEqual(toMap(g, 6, 4)); // same ground footprint
    // Not after rectification, and not for a size change without an upscale.
    expect(photoGeoreference({ ...up, metadata: { georef: g } }).georef).toBeNull();
  });

  it('project files keep checked GeoKeys and drop malformed ones', () => {
    const ok = sanitizePhotoMetadata({ georef: { ...g } })!.georef!;
    expect(ok.geoKeys).toEqual(nztmKeys);
    const bad = (geoKeys: unknown) => sanitizePhotoMetadata({ georef: { ...g, geoKeys } })!.georef!.geoKeys;
    expect(bad({ directory: [1, 1, 0, 5, 1024, 0, 1, 1] })).toBeUndefined(); // count does not match
    expect(bad({ directory: nztmKeys.directory, ascii: 'x<script>' + String.fromCharCode(0) })).toBeUndefined();
    expect(bad({ directory: [1, 1, 0, 1, 1024, 0, 1, 70000] })).toBeUndefined();
    expect(bad('nope')).toBeUndefined();
  });
});

describe('GeoJSON ring orientation and CRS marker (audit S4)', () => {
  // One grain with a hole (a 12x12 square ring) and one plain square.
  const w = 40, h = 30;
  const masks = new Int32Array(w * h);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) masks[y * w + x] = 1;
  for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) masks[y * w + x] = 0;
  for (let y = 5; y < 20; y++) for (let x = 22; x < 34; x++) masks[y * w + x] = 2;
  const grains = computeAllGrainMorphometrics(masks, w, h);
  const pixel = JSON.stringify(buildContourGeoJson(masks, grains, w, h));
  type FC = { crs?: unknown; features: Array<{ geometry: { type: string; coordinates: number[][][] } }> };
  const orientations = (json: string): Array<[number, number]> =>
    (JSON.parse(json) as FC).features.flatMap((f) => f.geometry.coordinates.map((r, i) => [i, Math.sign(signedRingArea(r))] as [number, number]));
  const rightHand = (json: string): void => {
    const o = orientations(json);
    expect(o.some(([i]) => i > 0)).toBe(true); // the hole is there
    for (const [i, s] of o) expect(s, `ring ${i}`).toBe(i === 0 ? 1 : -1);
  };

  it('pixel GeoJSON: right-hand rule as the numbers read, and crs null', () => {
    rightHand(pixel);
    expect((JSON.parse(pixel) as FC).crs).toBeNull();
  });

  it('map GeoJSON keeps the right-hand rule for north-up, south-up and mirrored rasters', () => {
    for (const transform of [
      [1000, 0.5, 0, 2000, 0, -0.5],
      [1000, 0.5, 0, 2000, 0, 0.5],
      [1000, -0.5, 0, 2000, 0, -0.5],
    ] as PhotoGeoreference['transform'][]) {
      const g: PhotoGeoreference = { transform, epsg: 2193, kind: 'projected', width: w, height: h };
      rightHand(geoJsonToMap(pixel, g));
    }
    const custom = JSON.parse(geoJsonToMap(pixel, { transform: [0, 1, 0, 0, 0, -1], epsg: null, kind: 'projected', width: w, height: h })) as FC;
    expect(custom.crs).toBeNull();
  });
});
