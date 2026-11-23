/**
 * Minimal writer for SQLite database files (file format 3, schema format 4), enough to export a
 * GeoPackage without shipping SQLite itself: rowid tables with B-tree leaf/interior pages and
 * overflow chains, and the automatic indexes SQLite builds for PRIMARY KEY / UNIQUE constraints.
 * Write-once: no free pages, no WAL, no autovacuum. The output passes SQLite's
 * `PRAGMA integrity_check` (tests/sqliteWriter.test.ts checks it with Python's sqlite3).
 *
 * Format reference: https://www.sqlite.org/fileformat2.html
 */

/** A column value: NULL, integer, real (a non-integer number or `{ real }`), UTF-8 text or blob. */
export type SqlValue = null | number | bigint | string | Uint8Array | { real: number };

export interface SqlIndexSpec {
  /** e.g. `sqlite_autoindex_gpkg_contents_1` for a PRIMARY KEY / UNIQUE constraint. */
  name: string;
  /** Positions of the indexed columns in the table's rows. */
  columns: number[];
  /** CREATE INDEX statement, or null for an automatic index. */
  sql: string | null;
}

export interface SqlTableSpec {
  name: string;
  /** The CREATE TABLE statement exactly as SQLite should store it. */
  sql: string;
  /** Rows in column order. For an INTEGER PRIMARY KEY (rowid alias) column store null there. */
  rows: Array<{ rowid: number; values: SqlValue[] }>;
  indexes?: SqlIndexSpec[];
}

export interface SqliteHeaderOptions {
  applicationId?: number;
  userVersion?: number;
}

const PAGE = 4096;
const U = PAGE; // usable size (no reserved bytes)
const enc = new TextEncoder();

function varint(v: bigint | number): number[] {
  let x = BigInt.asUintN(64, BigInt(v));
  if (x > 0x00ffffffffffffffn) {
    // 9 bytes: 8 groups of 7 bits, then the last byte holds 8 bits.
    const out: number[] = [Number(x & 0xffn)];
    x >>= 8n;
    for (let i = 0; i < 8; i++) {
      out.unshift(Number(x & 0x7fn) | 0x80);
      x >>= 7n;
    }
    return out;
  }
  const out: number[] = [Number(x & 0x7fn)];
  x >>= 7n;
  while (x > 0n) {
    out.unshift(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  return out;
}

/** Serial type and body bytes of one value (schema format 4: 0 and 1 have their own types). */
function encodeValue(v: SqlValue): { type: number; body: Uint8Array } {
  if (v === null) return { type: 0, body: new Uint8Array(0) };
  if (typeof v === 'string') {
    const b = enc.encode(v);
    return { type: b.length * 2 + 13, body: b };
  }
  if (v instanceof Uint8Array) return { type: v.length * 2 + 12, body: v };
  if (typeof v === 'object' || (typeof v === 'number' && !Number.isSafeInteger(v))) {
    const r = typeof v === 'object' ? v.real : v;
    const body = new Uint8Array(8);
    new DataView(body.buffer).setFloat64(0, r, false);
    return { type: 7, body };
  }
  const n = BigInt(v);
  if (n === 0n) return { type: 8, body: new Uint8Array(0) };
  if (n === 1n) return { type: 9, body: new Uint8Array(0) };
  const widths: Array<[number, number]> = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 6], [6, 8]];
  for (const [type, bytes] of widths) {
    const lim = 1n << BigInt(bytes * 8 - 1);
    if (n >= -lim && n < lim) {
      const body = new Uint8Array(bytes);
      let x = BigInt.asUintN(bytes * 8, n);
      for (let i = bytes - 1; i >= 0; i--) {
        body[i] = Number(x & 0xffn);
        x >>= 8n;
      }
      return { type, body };
    }
  }
  throw new RangeError(`Integer out of range: ${v}`);
}

/** A record (row payload): header of serial types, then the values. */
export function encodeRecord(values: readonly SqlValue[]): Uint8Array {
  const cols = values.map(encodeValue);
  const types = cols.flatMap((c) => varint(c.type));
  let hdr = types.length + 1;
  while (varint(hdr).length + types.length !== hdr) hdr = varint(hdr).length + types.length;
  const out = new Uint8Array(hdr + cols.reduce((s, c) => s + c.body.length, 0));
  out.set(varint(hdr), 0);
  out.set(types, varint(hdr).length);
  let o = hdr;
  for (const c of cols) {
    out.set(c.body, o);
    o += c.body.length;
  }
  return out;
}

/** Bytes of a payload kept on the B-tree page (the rest goes to overflow pages). */
function localSize(p: number, index: boolean): number {
  const X = index ? Math.floor(((U - 12) * 64) / 255) - 23 : U - 35;
  if (p <= X) return p;
  const M = Math.floor(((U - 12) * 32) / 255) - 23;
  const K = M + ((p - M) % (U - 4));
  return K <= X ? K : M;
}

/** Compares two index records' key values (BINARY collation; NULL < numbers < text < blob). */
function compareValues(a: SqlValue, b: SqlValue): number {
  const rank = (v: SqlValue): number => (v === null ? 0 : typeof v === 'string' ? 2 : v instanceof Uint8Array ? 3 : 1);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) {
    const x = typeof a === 'object' ? (a as { real: number }).real : Number(a);
    const y = typeof b === 'object' ? (b as { real: number }).real : Number(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = ra === 2 ? enc.encode(a as string) : (a as Uint8Array);
  const y = ra === 2 ? enc.encode(b as string) : (b as Uint8Array);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

class PageFile {
  readonly pages: Uint8Array[] = [new Uint8Array(PAGE)]; // page 1 is the schema root

  alloc(): number {
    this.pages.push(new Uint8Array(PAGE));
    return this.pages.length; // 1-based page number
  }

  page(n: number): Uint8Array {
    return this.pages[n - 1]!;
  }

  /** Stores `payload` as a cell's local part + overflow chain; returns the cell's payload bytes. */
  cellPayload(payload: Uint8Array, index: boolean): Uint8Array {
    const local = localSize(payload.length, index);
    if (local === payload.length) return payload;
    let rest = payload.subarray(local);
    const first = this.alloc();
    let pg = first;
    while (rest.length > 0) {
      const chunk = rest.subarray(0, U - 4);
      rest = rest.subarray(chunk.length);
      const next = rest.length > 0 ? this.alloc() : 0;
      const p = this.page(pg);
      new DataView(p.buffer).setUint32(0, next, false);
      p.set(chunk, 4);
      pg = next;
    }
    const out = new Uint8Array(local + 4);
    out.set(payload.subarray(0, local), 0);
    new DataView(out.buffer).setUint32(local, first, false);
    return out;
  }

  /** Writes one B-tree page: `type` 0x0D leaf table, 0x05 interior table, 0x0A leaf index. */
  writeBtreePage(n: number, type: number, cells: Uint8Array[], rightChild = 0): void {
    const p = this.page(n);
    const dv = new DataView(p.buffer);
    const base = n === 1 ? 100 : 0;
    const hdr = type === 0x05 ? 12 : 8;
    let content = PAGE;
    cells.forEach((c, i) => {
      content -= c.length;
      p.set(c, content);
      dv.setUint16(base + hdr + i * 2, content, false);
    });
    if (base + hdr + cells.length * 2 > content) throw new Error('B-tree page overflow');
    p[base] = type;
    dv.setUint16(base + 1, 0, false);
    dv.setUint16(base + 3, cells.length, false);
    dv.setUint16(base + 5, content === 65536 ? 0 : content, false);
    p[base + 7] = 0;
    if (type === 0x05) dv.setUint32(base + 8, rightChild, false);
  }

  /** Space for cells on a page (after its header). */
  static room(n: number, type: number): number {
    return PAGE - (n === 1 ? 100 : 0) - (type === 0x05 ? 12 : 8);
  }
}

/** Builds a table B-tree from rows sorted by rowid; returns its root page. */
function writeTable(f: PageFile, rows: SqlTableSpec['rows'], rootPage?: number): number {
  const sorted = [...rows].sort((a, b) => a.rowid - b.rowid);
  const cells = sorted.map((r) => {
    const payload = encodeRecord(r.values);
    const stored = f.cellPayload(payload, false);
    const head = [...varint(payload.length), ...varint(r.rowid)];
    const cell = new Uint8Array(head.length + stored.length);
    cell.set(head, 0);
    cell.set(stored, head.length);
    return { cell, rowid: r.rowid };
  });
  // Leaves: pack cells in rowid order.
  let level: Array<{ page: number; maxRowid: number }> = [];
  const leafRoom = PageFile.room(2, 0x0d);
  let batch: typeof cells = [];
  let used = 0;
  const flushLeaf = (page?: number): void => {
    const n = page ?? f.alloc();
    f.writeBtreePage(n, 0x0d, batch.map((c) => c.cell));
    level.push({ page: n, maxRowid: batch.length ? batch[batch.length - 1]!.rowid : 0 });
    batch = [];
    used = 0;
  };
  const room = rootPage === 1 ? PageFile.room(1, 0x0d) : leafRoom;
  for (const c of cells) {
    if (used + c.cell.length + 2 > room && batch.length > 0) {
      if (rootPage === 1) throw new Error('Schema does not fit on page 1');
      flushLeaf();
    }
    batch.push(c);
    used += c.cell.length + 2;
  }
  if (level.length === 0) {
    flushLeaf(rootPage);
    return level[0]!.page;
  }
  flushLeaf();
  // Interior levels until one root remains.
  while (level.length > 1) {
    const next: typeof level = [];
    const room2 = PageFile.room(2, 0x05);
    let i = 0;
    while (i < level.length) {
      const group: typeof level = [];
      let sz = 0;
      while (i < level.length) {
        const cellLen = 4 + varint(level[i]!.maxRowid).length + 2;
        if (group.length > 0 && sz + cellLen > room2) break;
        group.push(level[i]!);
        sz += cellLen;
        i++;
      }
      // The last child of the group is the right-most pointer; the others become cells.
      const right = group.pop()!;
      const n = f.alloc();
      f.writeBtreePage(
        n,
        0x05,
        group.map((g) => {
          const v = varint(g.maxRowid);
          const c = new Uint8Array(4 + v.length);
          new DataView(c.buffer).setUint32(0, g.page, false);
          c.set(v, 4);
          return c;
        }),
        right.page,
      );
      next.push({ page: n, maxRowid: right.maxRowid });
    }
    level = next;
  }
  return level[0]!.page;
}

/** Writes an index B-tree (one leaf page; the GeoPackage metadata indexes are tiny). */
function writeIndex(f: PageFile, rows: SqlTableSpec['rows'], columns: number[]): number {
  const keys = rows
    .map((r) => [...columns.map((c) => r.values[c] ?? null), r.rowid] as SqlValue[])
    .sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        const d = compareValues(a[i]!, b[i]!);
        if (d !== 0) return d;
      }
      return 0;
    });
  const cells = keys.map((k) => {
    const payload = encodeRecord(k);
    const stored = f.cellPayload(payload, true);
    const head = varint(payload.length);
    const cell = new Uint8Array(head.length + stored.length);
    cell.set(head, 0);
    cell.set(stored, head.length);
    return cell;
  });
  if (cells.reduce((s, c) => s + c.length + 2, 0) > PageFile.room(2, 0x0a)) throw new Error('Index too large for one page');
  const n = f.alloc();
  f.writeBtreePage(n, 0x0a, cells);
  return n;
}

/** A complete SQLite database file holding `tables` (and their indexes). */
export function buildSqliteDatabase(tables: readonly SqlTableSpec[], header: SqliteHeaderOptions = {}): Uint8Array {
  const f = new PageFile();
  const schema: SqlTableSpec['rows'] = [];
  let rowid = 1;
  for (const t of tables) {
    const root = writeTable(f, t.rows);
    schema.push({ rowid: rowid++, values: ['table', t.name, t.name, root, t.sql] });
    for (const ix of t.indexes ?? []) {
      const iroot = writeIndex(f, t.rows, ix.columns);
      schema.push({ rowid: rowid++, values: ['index', ix.name, t.name, iroot, ix.sql] });
    }
  }
  writeTable(f, schema, 1);

  const out = new Uint8Array(f.pages.length * PAGE);
  f.pages.forEach((p, i) => out.set(p, i * PAGE));
  const dv = new DataView(out.buffer);
  out.set(enc.encode('SQLite format 3\0'), 0);
  dv.setUint16(16, PAGE, false);
  out[18] = 1; // legacy (rollback journal) write / read versions
  out[19] = 1;
  out[20] = 0; // reserved bytes per page
  out[21] = 64;
  out[22] = 32;
  out[23] = 32;
  dv.setUint32(24, 1, false); // file change counter
  dv.setUint32(28, f.pages.length, false); // database size in pages
  dv.setUint32(32, 0, false); // no free pages
  dv.setUint32(36, 0, false);
  dv.setUint32(40, 1, false); // schema cookie
  dv.setUint32(44, 4, false); // schema format
  dv.setUint32(48, 0, false);
  dv.setUint32(52, 0, false); // no autovacuum
  dv.setUint32(56, 1, false); // UTF-8
  dv.setUint32(60, header.userVersion ?? 0, false);
  dv.setUint32(64, 0, false);
  dv.setUint32(68, header.applicationId ?? 0, false);
  dv.setUint32(92, 1, false); // version-valid-for = change counter
  dv.setUint32(96, 3045000, false); // SQLITE_VERSION_NUMBER of the format written (3.45.0)
  return out;
}
