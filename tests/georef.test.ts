import { describe, expect, it } from 'vitest';
import UTIF from 'utif2';
import { extractGeoReference, geoJsonToMap, photoGeoreference, toMap, worldFile } from '../src/modules/georef.js';
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
    expect(photoGeoreference({ ...photo, width: 240, height: 240 }).reason).toMatch(/enhanced/);
    expect(photoGeoreference({ ...photo, metadata: { georef, processingHistory: [{ step: 'rectification' } as never] } }).reason).toMatch(/rectified/);
    const ctx = { site: null, session, siteReport: null, siteInputs: [], psdXAxis: 'mm' as const };
    expect(await buildExport('photo-geojson-map', { ...ctx, photo: photo as never })).not.toBeNull();
    expect(await buildExport('photo-geojson-map', { ...ctx, photo: { ...photo, metadata: {} } as never })).toBeNull();
  });

  it('Download results adds map outlines and the mask world file for GeoTIFF photos', async () => {
    const entries = await resultsBundleEntries({
      site: { siteId: 's', name: 'S', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p'] },
      photos: [photo as never], siteInputs: [{ photoId: 'p', label: 'ortho.tif', included: true, session }], siteReport: null,
      siteOptions: {}, sizeMetric: 'bAxis', psdXAxis: 'mm', includeProject: false,
    });
    const names = entries.map((e) => e.name);
    expect(names).toContain('photos/ortho/outlines_map.geojson');
    expect(names).toContain('photos/ortho/mask16.pgw');
    expect(entries.find((e) => e.name === 'README.txt')!.data as string).toContain('outlines_map.geojson (map coordinates');
  });
});

describe('Export dialog', () => {
  it('offers map-coordinate exports only for a georeferenced photo, and says why not otherwise', async () => {
    const { renderExportModalHtml } = await import('../src/ui/modals.js');
    const { createInitialState } = await import('../src/ui/state.js');
    const session = squareGrainSession([10], { w: 60, h: 60, scale: 0.5 });
    const georef: PhotoGeoreference = { transform: [1000, 0.01, 0, 5000, 0, -0.01], epsg: 2193, kind: 'projected', width: 120, height: 120 };
    const base = { photoId: 'p', siteId: 's', label: 'ortho.tif', imageBlob: new Blob([]), width: 120, height: 120, addedAt: 0, included: true };
    const state = (photo: object) => ({ ...createInitialState(), activePhotoId: 'p', photos: [photo], sessions: new Map([['p', session]]) }) as never;
    const geo = renderExportModalHtml(state({ ...base, metadata: { georef } }));
    expect(geo).toContain('data-export="photo-geojson-map"');
    expect(geo).toContain('EPSG:2193');
    const plain = renderExportModalHtml(state(base));
    expect(plain).not.toContain('photo-geojson-map');
    expect(plain).toContain('not map coordinates');
    const rectified = renderExportModalHtml(state({ ...base, metadata: { georef, processingHistory: [{ step: 'rectification' }] } }));
    expect(rectified).toContain('was rectified');
  });
});
