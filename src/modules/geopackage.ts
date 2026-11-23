/**
 * OGC GeoPackage (1.4) of grain outlines, for GIS that prefer it to GeoJSON (e.g. ArcGIS Pro,
 * which reads a GeoPackage directly with its coordinate system and one geometry type per layer).
 * Built from the app's GeoJSON exports: one feature table `grain_outlines` (MULTIPOLYGON, one row
 * per grain, the grain properties as columns named like the grains.csv columns), the required
 * gpkg_spatial_ref_sys / gpkg_contents / gpkg_geometry_columns tables, and the export's provenance
 * as the layer description. Written with sqliteWriter.ts (no SQLite library needed).
 */
import { buildSqliteDatabase, type SqlTableSpec, type SqlValue } from './sqliteWriter.js';
import { WGS84_WKT } from './projToLonLat.js';

/** The coordinate system written into the GeoPackage. */
export interface GpkgSrs {
  /** srs_id: the EPSG code, or -1 for undefined Cartesian coordinates (photo pixels). */
  id: number;
  name: string;
  organization: string;
  organizationId: number;
  definition: string;
  description?: string;
}

/** Photo-pixel coordinates (x right, y down): GeoPackage's "undefined Cartesian SRS". */
export const PIXEL_SRS: GpkgSrs = {
  id: -1,
  name: 'Undefined cartesian SRS',
  organization: 'NONE',
  organizationId: -1,
  definition: 'undefined',
  description: 'Photo pixel coordinates (x right, y down), not map coordinates',
};

export const WGS84_SRS: GpkgSrs = {
  id: 4326,
  name: 'WGS 84 geodetic',
  organization: 'EPSG',
  organizationId: 4326,
  definition: WGS84_WKT,
  description: 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid',
};

const GPKG_APPLICATION_ID = 0x47504b47; // "GPKG"
const GPKG_USER_VERSION = 10400; // GeoPackage 1.4
const TABLE = 'grain_outlines';

/** Columns stored as INTEGER; other numbers are DOUBLE, booleans BOOLEAN, anything else TEXT. */
const INTEGER_PROPERTIES = new Set(['grainId', 'areaPx', 'widthPx', 'heightPx', 'grainsDetected', 'grainsCounted']);

/** grainId -> grain_id, aAxisMm -> a_axis_mm (the grains.csv column names). */
export function snakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toLowerCase();
}

type Ring = number[][];
export type GpkgFeature = { geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> };

/** GeoPackage geometry blob: header (magic, flags, srs_id, XY envelope) + little-endian WKB MultiPolygon. */
export function gpkgMultiPolygonBlob(polygons: readonly Ring[][], srsId: number): Uint8Array {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let points = 0;
  for (const poly of polygons) for (const ring of poly) for (const [x, y] of ring) {
    minX = Math.min(minX, x!); maxX = Math.max(maxX, x!);
    minY = Math.min(minY, y!); maxY = Math.max(maxY, y!);
    points++;
  }
  const empty = points === 0;
  const rings = polygons.reduce((s, p) => s + p.length, 0);
  const wkbSize = 9 + polygons.length * 9 + rings * 4 + points * 16;
  const headerSize = 8 + (empty ? 0 : 32);
  const out = new Uint8Array(headerSize + wkbSize);
  const dv = new DataView(out.buffer);
  out[0] = 0x47; // 'G'
  out[1] = 0x50; // 'P'
  out[2] = 0; // version 1
  // Flags: little-endian header values; envelope [minx, maxx, miny, maxy] (code 1), or none and
  // the empty-geometry bit for an empty geometry.
  out[3] = empty ? 0b10001 : 0b00011;
  dv.setInt32(4, srsId, true);
  let o = 8;
  if (!empty) {
    for (const v of [minX, maxX, minY, maxY]) { dv.setFloat64(o, v, true); o += 8; }
  }
  out[o] = 1; dv.setUint32(o + 1, 6, true); dv.setUint32(o + 5, polygons.length, true); o += 9; // MultiPolygon
  for (const poly of polygons) {
    out[o] = 1; dv.setUint32(o + 1, 3, true); dv.setUint32(o + 5, poly.length, true); o += 9; // Polygon
    for (const ring of poly) {
      dv.setUint32(o, ring.length, true); o += 4;
      for (const [x, y] of ring) { dv.setFloat64(o, x!, true); dv.setFloat64(o + 8, y!, true); o += 16; }
    }
  }
  return out;
}

/** One feature table (polygon layer) of a GeoPackage. */
export interface GpkgLayer {
  /** SQL table name (letters, digits, underscores). */
  table: string;
  /** Layer name shown in GIS. */
  identifier: string;
  /** Layer description (e.g. provenance JSON). */
  description: string;
  /** GeoJSON features (Polygon / MultiPolygon) with flat properties. */
  features: GpkgFeature[];
}

/**
 * A GeoPackage of the features of a GeoJSON FeatureCollection (polygons / multipolygons, as the
 * app's outline exports) in coordinate system `srs`. `identifier` names the layer in GIS;
 * the collection's `metadata` member (provenance) becomes the layer description.
 */
export function geoJsonToGeoPackage(geoJson: string, srs: GpkgSrs, identifier: string, now = new Date()): Uint8Array {
  const fc = JSON.parse(geoJson) as { metadata?: unknown; features: GpkgFeature[] };
  return buildGeoPackage(
    [{ table: TABLE, identifier, description: fc.metadata !== undefined ? JSON.stringify(fc.metadata) : '', features: fc.features }],
    srs,
    now,
  );
}

/** A feature table's columns and rows (geometry blob + properties). */
function layerTable(layer: GpkgLayer, srs: GpkgSrs): { spec: SqlTableSpec; bbox: SqlValue[] } {
  const features = layer.features;
  // Columns: every property key, in first-seen order.
  const keys: string[] = [];
  for (const f of features) for (const k of Object.keys(f.properties ?? {})) if (!keys.includes(k)) keys.push(k);
  const typeOf = (k: string): string => {
    const vals = features.map((f) => f.properties?.[k]).filter((v) => v !== undefined && v !== null);
    if (vals.length > 0 && vals.every((v) => typeof v === 'boolean')) return 'BOOLEAN';
    if (vals.every((v) => typeof v === 'number')) return INTEGER_PROPERTIES.has(k) && vals.every((v) => Number.isSafeInteger(v)) ? 'INTEGER' : 'DOUBLE';
    return 'TEXT';
  };
  const cols = keys.map((k) => ({ key: k, name: snakeCase(k), type: typeOf(k) }));
  // A property named like the key or geometry column, or two keys mapping to one name, get a suffix.
  const used = new Set(['fid', 'geom']);
  for (const c of cols) {
    let name = c.name || 'field';
    for (let i = 2; used.has(name); i++) name = `${c.name}_${i}`;
    c.name = name;
    used.add(name);
  }
  const cell = (type: string, v: unknown): SqlValue => {
    if (v === undefined || v === null) return null;
    if (type === 'BOOLEAN') return v ? 1 : 0;
    if (type === 'INTEGER') return v as number;
    if (type === 'DOUBLE') return Number.isFinite(v) ? { real: v as number } : null;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const rows = features.map((f, i) => {
    const g = f.geometry;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) as Ring[][];
    for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) {
      minX = Math.min(minX, x!); maxX = Math.max(maxX, x!);
      minY = Math.min(minY, y!); maxY = Math.max(maxY, y!);
    }
    return {
      rowid: i + 1,
      values: [null, gpkgMultiPolygonBlob(polys, srs.id), ...cols.map((c) => cell(c.type, f.properties?.[c.key]))] as SqlValue[],
    };
  });
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return {
    spec: {
      name: layer.table,
      sql: `CREATE TABLE ${q(layer.table)} (fid INTEGER PRIMARY KEY, geom MULTIPOLYGON${cols.map((c) => `, ${q(c.name)} ${c.type}`).join('')})`,
      rows,
    },
    bbox: Number.isFinite(minX) ? [minX, minY, maxX, maxY].map((v) => ({ real: v })) : [null, null, null, null],
  };
}

/** A GeoPackage with one MULTIPOLYGON feature table per layer, all in coordinate system `srs`. */
export function buildGeoPackage(layers: readonly GpkgLayer[], srs: GpkgSrs, now = new Date()): Uint8Array {
  if (new Set(layers.map((l) => l.table)).size !== layers.length || new Set(layers.map((l) => l.identifier)).size !== layers.length) {
    throw new Error('GeoPackage layer tables and names must be unique.');
  }
  const srsRows: GpkgSrs[] = [
    PIXEL_SRS,
    { id: 0, name: 'Undefined geographic SRS', organization: 'NONE', organizationId: 0, definition: 'undefined', description: 'undefined geographic coordinate reference system' },
    WGS84_SRS,
  ];
  if (!srsRows.some((s) => s.id === srs.id)) srsRows.push(srs);
  const built = layers.map((l) => ({ layer: l, ...layerTable(l, srs) }));

  const tables: SqlTableSpec[] = [
    {
      name: 'gpkg_spatial_ref_sys',
      sql:
        'CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL, ' +
        'organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT)',
      rows: srsRows.map((s) => ({ rowid: s.id, values: [s.name, null, s.organization, s.organizationId, s.definition, s.description ?? null] })),
    },
    {
      name: 'gpkg_contents',
      sql:
        "CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', " +
        "last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, " +
        'CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))',
      rows: built.map((b, i) => ({
        rowid: i + 1,
        values: [b.layer.table, 'features', b.layer.identifier, b.layer.description, now.toISOString(), ...b.bbox, srs.id],
      })),
      indexes: [
        { name: 'sqlite_autoindex_gpkg_contents_1', columns: [0], sql: null },
        { name: 'sqlite_autoindex_gpkg_contents_2', columns: [2], sql: null },
      ],
    },
    {
      name: 'gpkg_geometry_columns',
      sql:
        'CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, ' +
        'srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), ' +
        'CONSTRAINT uk_gc_table_name UNIQUE (table_name), CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), ' +
        'CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id))',
      rows: built.map((b, i) => ({ rowid: i + 1, values: [b.layer.table, 'geom', 'MULTIPOLYGON', srs.id, 0, 0] })),
      indexes: [
        { name: 'sqlite_autoindex_gpkg_geometry_columns_1', columns: [0, 1], sql: null },
        { name: 'sqlite_autoindex_gpkg_geometry_columns_2', columns: [0], sql: null },
      ],
    },
    ...built.map((b) => b.spec),
  ];
  return buildSqliteDatabase(tables, { applicationId: GPKG_APPLICATION_ID, userVersion: GPKG_USER_VERSION });
}
