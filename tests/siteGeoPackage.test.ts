/** The whole site as one GeoPackage, opened with SQLite (node:sqlite). */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildExport, type ExportContext } from '../src/modules/exports.js';
import { geoJsonToLonLat, geoJsonToMap, toMap } from '../src/modules/georef.js';
import { resultsBundleEntries } from '../src/modules/resultsBundle.js';
import { analyzeSite, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { siteGeoPackagePlan } from '../src/modules/siteGeoPackage.js';
import type { PhotoGeoreference } from '../src/modules/siteTypes.js';
import { photoCutoffs } from '../src/modules/siteWorkspace.js';
import { squareGrainSession } from './helpers/squareSession.js';

const { DatabaseSync } = await import('node:sqlite');
type Db = InstanceType<typeof DatabaseSync>;
const dir = mkdtempSync(join(tmpdir(), 'sitegpkg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
async function open(blob: Blob): Promise<Db> {
  const path = join(dir, `s${n++}.gpkg`);
  writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
  return new DatabaseSync(path, { readOnly: true });
}

/** MultiPolygon rings of a GeoPackage geometry blob (header with XY envelope + little-endian WKB). */
function rings(b: Uint8Array): number[][][][] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 40 + 5;
  const np = dv.getUint32(o, true);
  o += 4;
  const out: number[][][][] = [];
  for (let p = 0; p < np; p++) {
    const nr = dv.getUint32(o + 5, true);
    o += 9;
    const poly: number[][][] = [];
    for (let r = 0; r < nr; r++) {
      const k = dv.getUint32(o, true);
      o += 4;
      const ring: number[][] = [];
      for (let i = 0; i < k; i++, o += 16) ring.push([dv.getFloat64(o, true), dv.getFloat64(o + 8, true)]);
      poly.push(ring);
    }
    out.push(poly);
  }
  return out;
}

function valid(db: Db, srsId: number, tables: string[]): void {
  expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0x47504b47 });
  const contents = db.prepare('SELECT table_name, data_type, srs_id FROM gpkg_contents ORDER BY table_name').all();
  expect(contents).toEqual(tables.sort().map((t) => ({ table_name: t, data_type: 'features', srs_id: srsId })));
  expect(db.prepare('SELECT table_name, geometry_type_name, srs_id FROM gpkg_geometry_columns ORDER BY table_name').all()).toEqual(
    tables.map((t) => ({ table_name: t, geometry_type_name: 'MULTIPOLYGON', srs_id: srsId })),
  );
}

const W = 200, H = 120;
const nztm = (x0: number, y0: number): PhotoGeoreference => ({ transform: [x0, 0.02, 0, y0, 0, -0.02], epsg: 2193, kind: 'projected', width: W, height: H });
const photo = (id: string, georef: PhotoGeoreference | null, sides = [20, 24, 28, 32]): SitePhotoInput => ({
  photoId: id,
  label: `${id}.tif`,
  included: true,
  session: squareGrainSession(sides, { w: W, h: H, mmPerPx: 0.5 }),
  ...(georef ? { metadata: { georef } } : {}),
});
const opts = { poolingMode: 'physical-area' as const, minBaxisPx: 25, bootstrapReplicates: 20 };
const ctxFor = (inputs: SitePhotoInput[]): ExportContext => ({
  site: { siteId: 's', name: 'Rakaia bar', createdAt: 0, updatedAt: 0, options: opts, photoOrder: inputs.map((i) => i.photoId) },
  photo: null, session: null, siteReport: analyzeSite(inputs, opts), siteInputs: inputs, psdXAxis: 'mm', siteOptions: opts,
});

describe('site GeoPackage', () => {
  it('photos sharing a CRS: one layer of every grain in that CRS, plus photo footprints with D50', async () => {
    const inputs = [photo('a', nztm(1793110, 5495817)), photo('b', nztm(1793114, 5495817), [36, 40])];
    const ctx = ctxFor(inputs);
    const f = (await buildExport('site-gpkg', ctx))!;
    expect(f.filename).toBe('Rakaia_bar_site_outlines_EPSG2193.gpkg');
    const db = await open(f.blob);
    valid(db, 2193, ['grain_outlines', 'photo_footprints']);
    const rows = db.prepare('SELECT photo_id, grain_id, included_in_stats, b_axis_mm, geom FROM grain_outlines ORDER BY fid').all() as Array<{ photo_id: string; grain_id: number; included_in_stats: number; b_axis_mm: number; geom: Uint8Array }>;
    for (const input of inputs) {
      const mine = rows.filter((r) => r.photo_id === input.photoId);
      const geo = JSON.parse(geoJsonToMap(input.session.exportGeoJson(), input.metadata!.georef!)) as { features: Array<{ geometry: { type: string; coordinates: number[][][] } }> };
      expect(mine).toHaveLength(geo.features.length);
      mine.forEach((r, i) => expect(rings(r.geom)).toEqual([geo.features[i]!.geometry.coordinates]));
      // included_in_stats: the same grains as the site statistics (b-axis of a 20 px square is 23.1 px < 25 px).
      const counted = input.session.countedGrainIds('bAxis', photoCutoffs(opts, ctx.siteReport, input.photoId));
      expect(mine.map((r) => r.included_in_stats === 1)).toEqual(mine.map((r) => counted.has(r.grain_id)));
    }
    expect(rows.some((r) => r.included_in_stats === 0)).toBe(true);
    const fps = db.prepare('SELECT photo_id, d50_mm, grains_counted, mm_per_px, geom FROM photo_footprints ORDER BY fid').all() as Array<{ photo_id: string; d50_mm: number; grains_counted: number; mm_per_px: number; geom: Uint8Array }>;
    expect(fps.map((f) => f.photo_id)).toEqual(['a', 'b']);
    fps.forEach((fp, i) => {
      const g = inputs[i]!.metadata!.georef!;
      const ring = rings(fp.geom)[0]![0]!;
      for (const [u, v] of [[0, 0], [W, 0], [W, H], [0, H]] as const) expect(ring).toContainEqual(toMap(g, u, v));
      expect(fp.d50_mm).toBeCloseTo(ctx.siteReport!.perPhoto[i]!.D50, 9);
      expect(fp.mm_per_px).toBe(0.5);
    });
    db.close();
  });

  it('photos in different CRSs: longitude / latitude', async () => {
    const utm: PhotoGeoreference = { transform: [500000, 0.02, 0, 5000000, 0, -0.02], epsg: 32759, kind: 'projected', width: W, height: H };
    const inputs = [photo('a', nztm(1793110, 5495817)), photo('b', utm)];
    const f = (await buildExport('site-gpkg', ctxFor(inputs)))!;
    expect(f.filename).toBe('Rakaia_bar_site_outlines_lonlat.gpkg');
    const db = await open(f.blob);
    valid(db, 4326, ['grain_outlines', 'photo_footprints']);
    const first = db.prepare("SELECT geom FROM grain_outlines WHERE photo_id = 'b' ORDER BY fid LIMIT 1").get() as { geom: Uint8Array };
    const ll = JSON.parse(geoJsonToLonLat(inputs[1]!.session.exportGeoJson(), utm)!) as { features: Array<{ geometry: { coordinates: number[][][] } }> };
    expect(rings(first.geom)).toEqual([ll.features[0]!.geometry.coordinates]);
    db.close();
  });

  it('leaves out photos it cannot place, and uses photo pixels for a site without GeoTIFFs', async () => {
    const plan = siteGeoPackagePlan([photo('a', nztm(1793110, 5495817)), photo('jpg', null)]);
    expect(plan.coords).toBe('map');
    expect(plan.placed.map((p) => p.input.photoId)).toEqual(['a']);
    expect(plan.skipped).toEqual([{ label: 'jpg.tif', reason: 'no georeference (not a GeoTIFF, or rectified)' }]);
    const f = (await buildExport('site-gpkg', ctxFor([photo('x', null), photo('y', null)])))!;
    expect(f.filename).toBe('Rakaia_bar_site_outlines_pixels.gpkg');
    const db = await open(f.blob);
    valid(db, -1, ['grain_outlines']); // no footprints: photos overlap in pixel coordinates
    expect(db.prepare('SELECT photo_id, count(*) n FROM grain_outlines GROUP BY photo_id').all()).toEqual([{ photo_id: 'x', n: 4 }, { photo_id: 'y', n: 4 }]);
    const desc = JSON.parse((db.prepare('SELECT description FROM gpkg_contents').get() as { description: string }).description);
    expect(desc.siteGeoPackage.coordinates).toMatch(/photo pixels/);
    db.close();
  });

  it('counted grains only, and in the results .zip for GeoTIFF sites', async () => {
    const inputs = [photo('a', nztm(1793110, 5495817))];
    const db = await open((await buildExport('site-gpkg', { ...ctxFor(inputs), countedGrainsOnly: true }))!.blob);
    expect(db.prepare('SELECT min(included_in_stats) m, count(*) n FROM grain_outlines').get()).toEqual({ m: 1, n: 3 });
    db.close();
    const c = ctxFor(inputs);
    const entries = await resultsBundleEntries({
      site: c.site!, photos: [], siteInputs: inputs, siteReport: c.siteReport, siteOptions: opts, sizeMetric: 'bAxis', psdXAxis: 'mm', includeProject: false,
    });
    expect(entries.map((e) => e.name)).toContain('site_outlines_EPSG2193.gpkg');
    expect(entries.find((e) => e.name === 'README.txt')!.data as string).toContain('site_outlines_EPSG2193.gpkg');
  });
  it('F-05: grains of a photo left out of the site are never marked as counted', async () => {
    const inputs = [photo('a', nztm(1793110, 5495817)), { ...photo('b', nztm(1793114, 5495817)), included: false }];
    const all = await open((await buildExport('site-gpkg', ctxFor(inputs)))!.blob);
    expect(all.prepare("SELECT max(included_in_stats) m, count(*) n FROM grain_outlines WHERE photo_id = 'b'").get()).toEqual({ m: 0, n: 4 });
    expect(all.prepare("SELECT grains_counted FROM photo_footprints WHERE photo_id = 'b'").get()).toEqual({ grains_counted: 0 });
    all.close();
    const counted = await open((await buildExport('site-gpkg', { ...ctxFor(inputs), countedGrainsOnly: true }))!.blob);
    expect(counted.prepare("SELECT count(*) n FROM grain_outlines WHERE photo_id = 'b'").get()).toEqual({ n: 0 });
    expect(counted.prepare("SELECT count(*) n FROM grain_outlines WHERE photo_id = 'a'").get()).toEqual({ n: 3 });
    counted.close();
  });
});
