/**
 * Projected -> longitude/latitude conversion against PROJ 9.8.1 (pyproj 3.8.0) reference points
 * (validation/geotiff/crs_reference.json; validation/geotiff/check_crs_table.mjs checks all of them).
 */
import { describe, expect, it } from 'vitest';
import { lonLatProjector } from '../src/modules/projToLonLat.js';
import { geoJsonToLonLat } from '../src/modules/georef.js';
import type { PhotoGeoreference } from '../src/modules/siteTypes.js';
import { squareGrainSession } from './helpers/squareSession.js';

const D = Math.PI / 180;
const metres = (a: number[], b: number[]): number =>
  Math.hypot(((((a[0]! - b[0]! + 540) % 360) - 180) * D) * Math.cos(b[1]! * D), (a[1]! - b[1]!) * D) * 6371008.8;

describe('projected map coordinates to longitude / latitude', () => {
  // [EPSG, easting, northing, PROJ longitude, PROJ latitude]: TM (NZTM, UTM N/S, MGA, Irish grid),
  // LCC 2SP (US State Plane in US feet, Lambert 93), LCC 1SP, a zone crossing the date line.
  const REF: Array<[number, number, number, number, number]> = [
    [3448, 718248.2181634707, 662200.6066681766, -77.30000000000001, 18.11],
    [2193, 1557768.5448432215, 5492759.65743377, 172.5, -40.715],
    [32760, 500000.00000000215, 5572242.781261626, 177.0, -40.0],
    [32633, 500000.00000000134, 4649776.224819178, 15.0, 42.0],
    [26910, 500310.46883742523, 6225000.400311399, -122.995, 56.17],
    [25832, 500276.6127925036, 6681481.103924277, 9.004999999999999, 60.27],
    [7855, 500481.9480697148, 6674566.120553608, 147.005, -30.060000000000002],
    [28355, 500481.9480697148, 6674566.120553608, 147.005, -30.060000000000002],
    [2157, 603324.3765559805, 739986.4340746693, -7.95, 53.41],
    [2229, 6631142.589076952, 1926178.466198221, -117.77000000000001, 34.285],
    [3034, 3664622.8977630353, 3098904.2726719077, 4.625, 54.665000000000006],
    [2154, 489353.58775158133, 6587552.204045072, 0.2600000000000007, 46.355000000000004],
    [6093, 27534478.79709157, 5498054.395528933, -180.0, 72.005],
    [2107, 382010.7027528192, 839880.1135822588, 177.68, -38.265],
  ];
  for (const [code, x, y, lon, lat] of REF) {
    it(`EPSG:${code} matches PROJ within 1 mm`, () => {
      expect(metres(lonLatProjector(code, 'projected')!(x, y), [lon, lat])).toBeLessThan(0.001);
    });
  }

  it('Web Mercator and near-WGS84 geographic CRSs; unknown or far-off CRSs give null', () => {
    const [lon, lat] = lonLatProjector(3857, 'projected')!(19461950.0, -5467000.0);
    expect(lon).toBeCloseTo(174.83, 2);
    expect(lat).toBeCloseTo(-44.0, 1);
    expect(lonLatProjector(4326, 'geographic')!(172.5, -43.5)).toEqual([172.5, -43.5]);
    expect(lonLatProjector(4167, 'geographic')!(172.5, -43.5)).toEqual([172.5, -43.5]); // NZGD2000
    expect(lonLatProjector(27200, 'projected')).toBeNull(); // NZ Map Grid (NZGD49, ~200 m datum shift)
    expect(lonLatProjector(null, 'projected')).toBeNull();
  });
});

describe('GeoJSON in longitude / latitude (RFC 7946, for web maps)', () => {
  // The reported file: NZTM 2000, 2 cm pixels; photo 120 x 120 px analysed at 60 x 60.
  const g: PhotoGeoreference = { transform: [1793110.34, 0.02, 0, 5495817.62, 0, -0.02], epsg: 2193, kind: 'projected', width: 120, height: 120 };
  const session = squareGrainSession([10], { w: 60, h: 60, scale: 0.5 });

  it('places the outlines in New Zealand, right-hand rule, no crs member', () => {
    const fc = JSON.parse(geoJsonToLonLat(session.exportGeoJson(), g)!) as {
      crs?: unknown;
      features: Array<{ geometry: { type: string; coordinates: number[][][] }; properties: Record<string, number> }>;
    };
    expect(fc.crs).toBeUndefined();
    const ring = fc.features[0]!.geometry.coordinates[0]!;
    // Inside the photo's footprint: NZTM corner (1793110.34, 5495817.62) = 175.2845683 E, 40.6659267 S (PROJ).
    for (const [lon, lat] of ring) {
      expect(lon).toBeGreaterThan(175.28456);
      expect(lon).toBeLessThan(175.2846);
      expect(lat).toBeGreaterThan(-40.66605);
      expect(lat).toBeLessThan(-40.66592);
    }
    // Exterior ring counter-clockwise (positive signed area).
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j]![0]! - ring[i]![0]!) * (ring[j]![1]! + ring[i]![1]!);
    expect(area).toBeGreaterThan(0);
    // Centroid at photo px (30, 30) = NZTM (+0.6 m, -0.6 m) = 175.28457555745717, -40.66593200053314 (PROJ).
    const p = fc.features[0]!.properties;
    expect(metres([p['centroidLon']!, p['centroidLat']!], [175.28457555745717, -40.66593200053314])).toBeLessThan(0.001);
  });

  it('is not offered for a CRS it cannot convert', () => {
    expect(geoJsonToLonLat(session.exportGeoJson(), { ...g, epsg: 27200 })).toBeNull();
    expect(geoJsonToLonLat(session.exportGeoJson(), { ...g, epsg: null })).toBeNull();
  });
});
