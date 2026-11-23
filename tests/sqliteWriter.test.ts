/** The hand-written SQLite writer, checked by SQLite itself (node:sqlite). */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSqliteDatabase, type SqlTableSpec } from '../src/modules/sqliteWriter.js';

// node:sqlite prints an "experimental" warning once; the module itself is stable for reading files.
const { DatabaseSync } = await import('node:sqlite');

const dir = mkdtempSync(join(tmpdir(), 'sqlw-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function open(bytes: Uint8Array) {
  const path = join(dir, `db${n++}.sqlite`);
  writeFileSync(path, bytes);
  return new DatabaseSync(path, { readOnly: true });
}
const integrity = (db: InstanceType<typeof DatabaseSync>): string =>
  (db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check).join('; ');

describe('SQLite writer', () => {
  it('writes small tables, negative rowids, every value type and automatic indexes', () => {
    const t: SqlTableSpec = {
      name: 'things',
      sql: 'CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, x DOUBLE, n INTEGER, b BLOB)',
      rows: [
        { rowid: -1, values: [null, 'minus one', 0.5, -1, new Uint8Array([1, 2])] },
        { rowid: 0, values: [null, 'zero', { real: 2 }, 0, null] },
        { rowid: 4326, values: [null, 'big', -1e300, 2 ** 40, new Uint8Array(0)] },
        { rowid: 7, values: [null, 'Ōtaki é', null, 1, null] },
      ],
      indexes: [{ name: 'sqlite_autoindex_things_1', columns: [1], sql: null }],
    };
    const db = open(buildSqliteDatabase([t], { applicationId: 0x47504b47, userVersion: 10400 }));
    expect(integrity(db)).toBe('ok');
    expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0x47504b47 });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10400 });
    const rows = db.prepare('SELECT id, name, x, n, typeof(x) tx FROM things ORDER BY id').all();
    expect(rows).toEqual([
      { id: -1, name: 'minus one', x: 0.5, n: -1, tx: 'real' },
      { id: 0, name: 'zero', x: 2, n: 0, tx: 'real' },
      { id: 7, name: 'Ōtaki é', x: null, n: 1, tx: 'null' },
      { id: 4326, name: 'big', x: -1e300, n: 2 ** 40, tx: 'real' },
    ]);
    // The UNIQUE index is used and consistent.
    expect(db.prepare("SELECT id FROM things WHERE name = 'big'").get()).toEqual({ id: 4326 });
    db.close();
  });

  it('writes large tables (interior pages) with large blobs (overflow pages)', () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      rowid: i + 1,
      values: [null, new Uint8Array((i % 7) * 3000 + 1).fill(i % 251), i * 0.25, `grain ${i}`] as Array<null | Uint8Array | number | string>,
    }));
    const t: SqlTableSpec = { name: 'g', sql: 'CREATE TABLE g (fid INTEGER PRIMARY KEY, geom BLOB, v DOUBLE, label TEXT)', rows };
    const db = open(buildSqliteDatabase([t, { name: 'empty', sql: 'CREATE TABLE empty (a TEXT)', rows: [] }]));
    expect(integrity(db)).toBe('ok');
    expect(db.prepare('SELECT count(*) c, sum(length(geom)) s FROM g').get()).toEqual({
      c: 3000,
      s: rows.reduce((s, r) => s + (r.values[1] as Uint8Array).length, 0),
    });
    const r = db.prepare('SELECT geom, v, label FROM g WHERE fid = 2001').get() as { geom: Uint8Array; v: number; label: string };
    expect(r.geom.length).toBe((2000 % 7) * 3000 + 1);
    expect(r.geom.every((b) => b === 2000 % 251)).toBe(true);
    expect([r.v, r.label]).toEqual([500, 'grain 2000']);
    expect(db.prepare('SELECT count(*) c FROM empty').get()).toEqual({ c: 0 });
    db.close();
  });
});
