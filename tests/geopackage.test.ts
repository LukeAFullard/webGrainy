/** GeoPackage outline exports, opened with SQLite (node:sqlite) and checked against the GeoJSON. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildExport, type ExportContext } from '../src/modules/exports.js';
import { geoJsonToLonLat, geoJsonToMap } from '../src/modules/georef.js';
import { geoJsonToGeoPackage, gpkgMultiPolygonBlob, PIXEL_SRS, snakeCase } from '../src/modules/geopackage.js';
import { crsWkt } from '../src/modules/projToLonLat.js';
import type { PhotoRecord } from '../src/modules/projectStorage.js';
import type { PhotoGeoreference } from '../src/modules/siteTypes.js';
import { squareGrainSession } from './helpers/squareSession.js';

const { DatabaseSync } = await import('node:sqlite');
type Db = InstanceType<typeof DatabaseSync>;

const dir = mkdtempSync(join(tmpdir(), 'gpkg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
async function openBlob(blob: Blob): Promise<Db> {
  const path = join(dir, `t${n++}.gpkg`);
  writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
  return new DatabaseSync(path, { readOnly: true });
}

/** Decodes a GeoPackage geometry blob (header + little-endian WKB MultiPolygon). */
function decodeGeom(b: Uint8Array): { srsId: number; envelope: number[]; polygons: number[][][][] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect([b[0], b[1], b[2]]).toEqual([0x47, 0x50, 0]);
  const flags = b[3]!;
  expect(flags & 1).toBe(1); // little-endian header
  expect((flags >> 1) & 7).toBe(1); // envelope [minx, maxx, miny, maxy]
  const srsId = dv.getInt32(4, true);
  const envelope = [0, 1, 2, 3].map((i) => dv.getFloat64(8 + i * 8, true));
  let o = 40;
  expect(b[o]).toBe(1);
  expect(dv.getUint32(o + 1, true)).toBe(6); // MultiPolygon
  const np = dv.getUint32(o + 5, true);
  o += 9;
  const polygons: number[][][][] = [];
  for (let p = 0; p < np; p++) {
    expect(dv.getUint32(o + 1, true)).toBe(3);
    const nr = dv.getUint32(o + 5, true);
    o += 9;
    const rings: number[][][] = [];
    for (let r = 0; r < nr; r++) {
      const nPts = dv.getUint32(o, true);
      o += 4;
      const ring: number[][] = [];
      for (let i = 0; i < nPts; i++, o += 16) ring.push([dv.getFloat64(o, true), dv.getFloat64(o + 8, true)]);
      rings.push(ring);
    }
    polygons.push(rings);
  }
  expect(o).toBe(b.length);
  return { srsId, envelope, polygons };
}

/** The GeoPackage rules a reader relies on (a subset of the OGC conformance tests). */
function checkGeoPackage(db: Db, srsId: number): Array<Record<string, unknown>> {
  expect((db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check)).toEqual(['ok']);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0x47504b47 });
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10400 });
  const srs = db.prepare('SELECT srs_id, organization, organization_coordsys_id, definition FROM gpkg_spatial_ref_sys ORDER BY srs_id').all() as Array<{ srs_id: number; definition: string }>;
  expect(srs.map((s) => s.srs_id)).toEqual(expect.arrayContaining([-1, 0, 4326, srsId]));
  const contents = db.prepare('SELECT * FROM gpkg_contents').all() as Array<Record<string, unknown>>;
  expect(contents).toHaveLength(1);
  expect(contents[0]).toMatchObject({ table_name: 'grain_outlines', data_type: 'features', srs_id: srsId });
  expect(String(contents[0]!['last_change'])).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(db.prepare('SELECT * FROM gpkg_geometry_columns').all()).toEqual([
    { table_name: 'grain_outlines', column_name: 'geom', geometry_type_name: 'MULTIPOLYGON', srs_id: srsId, z: 0, m: 0 },
  ]);
  const info = db.prepare('PRAGMA table_info(grain_outlines)').all() as Array<{ name: string; type: string; pk: number }>;
  expect(info[0]).toMatchObject({ name: 'fid', type: 'INTEGER', pk: 1 });
  expect(info[1]).toMatchObject({ name: 'geom', type: 'MULTIPOLYGON' });
  return db.prepare('SELECT * FROM grain_outlines ORDER BY fid').all() as Array<Record<string, unknown>>;
}

describe('GeoPackage export', () => {
  const session = squareGrainSession([20, 24, 28, 32], { w: 200, h: 120, mmPerPx: 0.5 });
  const g: PhotoGeoreference = { transform: [1793110.34, 0.02, 0, 5495817.62, 0, -0.02], epsg: 2193, kind: 'projected', width: 200, height: 120 };
  const photo: PhotoRecord = {
    photoId: 'p1', siteId: 's', label: 'IMG_1.tif', imageBlob: new Blob(['x']), width: 200, height: 120, addedAt: 0, included: true,
    metadata: { georef: g },
  };
  const ctx: ExportContext = { site: null, photo, session, siteReport: null, siteInputs: [], psdXAxis: 'mm' };

  it('map coordinates: valid GeoPackage, same outlines and fields as the map GeoJSON, CRS EPSG:2193', async () => {
    const f = (await buildExport('photo-gpkg-map', ctx))!;
    expect(f.filename).toBe('IMG_1_tif_outlines_EPSG2193.gpkg');
    const db = await openBlob(f.blob);
    const rows = checkGeoPackage(db, 2193);
    const geo = JSON.parse(geoJsonToMap(session.exportGeoJson(), g)) as { features: Array<{ geometry: { type: string; coordinates: number[][][] }; properties: Record<string, unknown> }> };
    expect(rows).toHaveLength(geo.features.length);
    rows.forEach((r, i) => {
      const feat = geo.features[i]!;
      const geom = decodeGeom(r['geom'] as Uint8Array);
      expect(geom.srsId).toBe(2193);
      expect(geom.polygons).toEqual(feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates);
      const xs = geom.polygons.flat(2).map((p) => p[0]!);
      const ys = geom.polygons.flat(2).map((p) => p[1]!);
      expect(geom.envelope).toEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]);
      for (const [k, v] of Object.entries(feat.properties)) {
        expect(r[snakeCase(k)], k).toEqual(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
    });
    expect(rows[0]).toHaveProperty('grain_id');
    expect(rows[0]).toHaveProperty('b_axis_mm');
    const def = (db.prepare('SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id = 2193').get() as { definition: string }).definition;
    expect(def).toMatch(/^PROJCS\[.*PROJECTION\["Transverse_Mercator"\].*PARAMETER\["central_meridian",173\].*PARAMETER\["scale_factor",0\.9996\].*PARAMETER\["false_easting",1600000\].*PARAMETER\["false_northing",10000000\].*AUTHORITY\["EPSG","2193"\]\]$/);
    const contents = db.prepare('SELECT description, min_x, max_y FROM gpkg_contents').get() as { description: string; min_x: number; max_y: number };
    expect(JSON.parse(contents.description)).toHaveProperty('appVersion'); // provenance
    expect(contents.min_x).toBeGreaterThan(1793110);
    expect(contents.max_y).toBeLessThan(5495817.63);
    db.close();
  });

  it('longitude / latitude and photo-pixel versions', async () => {
    const ll = (await buildExport('photo-gpkg-lonlat', ctx))!;
    expect(ll.filename).toBe('IMG_1_tif_outlines_lonlat.gpkg');
    const dbl = await openBlob(ll.blob);
    const rowsL = checkGeoPackage(dbl, 4326);
    const geoL = JSON.parse(geoJsonToLonLat(session.exportGeoJson(), g)!) as { features: Array<{ geometry: { coordinates: number[][][] } }> };
    expect(decodeGeom(rowsL[0]!['geom'] as Uint8Array).polygons[0]).toEqual(geoL.features[0]!.geometry.coordinates);
    dbl.close();
    const px = (await buildExport('photo-gpkg', { ...ctx, photo: { ...photo, metadata: {} } }))!;
    const dbp = await openBlob(px.blob);
    expect(checkGeoPackage(dbp, -1)).toHaveLength(4);
    dbp.close();
  });

  it('only counted grains when asked, and no map version for a CRS it cannot define', async () => {
    const counted = (await buildExport('photo-gpkg-map', { ...ctx, countedGrainsOnly: true, siteOptions: { minBaxisPx: 25 } }))!;
    const db = await openBlob(counted.blob);
    // b-axis of a square grain = 1.155 x its side: the 20 px square (23.1 px) is below 25 px.
    expect(checkGeoPackage(db, 2193).map((r) => r['grain_id'])).toEqual([2, 3, 4]);
    db.close();
    const custom = { ...photo, metadata: { georef: { ...g, epsg: null } } };
    expect(await buildExport('photo-gpkg-map', { ...ctx, photo: custom })).toBeNull();
  });

  it('a GeoPackage with no grains is still valid; large outlines use overflow pages', async () => {
    const empty = await openBlob(new Blob([geoJsonToGeoPackage(JSON.stringify({ type: 'FeatureCollection', features: [] }), PIXEL_SRS, 'none').slice().buffer]));
    expect(checkGeoPackage(empty, -1)).toEqual([]);
    empty.close();
    // One grain with a 20,000-point outline (about 320 kB of WKB).
    const ring = Array.from({ length: 20000 }, (_, i) => [Math.cos((i / 20000) * 2 * Math.PI) * 100, Math.sin((i / 20000) * 2 * Math.PI) * 100]);
    ring.push(ring[0]!);
    const big = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { grainId: 1 } }] });
    const db = await openBlob(new Blob([geoJsonToGeoPackage(big, PIXEL_SRS, 'big').slice().buffer]));
    const rows = checkGeoPackage(db, -1);
    expect(decodeGeom(rows[0]!['geom'] as Uint8Array).polygons[0]![0]).toEqual(ring);
    db.close();
  });

  it('geometry blob, WKT and column names', () => {
    expect(snakeCase('grainId')).toBe('grain_id');
    expect(snakeCase('aAxisMm')).toBe('a_axis_mm');
    expect(snakeCase('centroidMapX')).toBe('centroid_map_x');
    expect(snakeCase('dEqPx')).toBe('d_eq_px');
    expect(gpkgMultiPolygonBlob([], -1)[3]).toBe(0b10001); // empty geometry: no envelope, empty bit
    expect(crsWkt(32759)).toContain('DATUM["WGS_1984"');
    expect(crsWkt(2227)).toContain('UNIT["US survey foot"');
    expect(crsWkt(2227)).toMatch(/PARAMETER\["false_easting",6561666\.66[67]/); // EPSG: 6,561,666.667 US ft
    expect(crsWkt(27200)).toBeNull(); // not in the table: no map GeoPackage
  });
});
