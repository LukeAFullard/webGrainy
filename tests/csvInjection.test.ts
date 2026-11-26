import { describe, expect, it } from 'vitest';
import { buildExport } from '../src/modules/exports.js';
import { comparisonCsv, computeComparedSites } from '../src/modules/siteComparison.js';
import { analyzeSite, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { squareGrainSession } from './helpers/squareSession.js';

const NASTY = [
  'a,=HYPERLINK("http://evil.example/x"),.jpg',
  'b;=1+2;.jpg',
  'c\t@SUM(1)\t.jpg',
  'd",=cmd|\' /C calc\'!A0,".jpg',
  '=1+2',
  '+cmd|calc',
  '-2+3',
  'e\n=1+1',
];

/**
 * Splits one CSV line on `delim`, honouring double quotes, strictly per RFC 4180 (like Python's
 * csv.reader(strict=True), DuckDB or Polars): after a closing quote only the delimiter or the end
 * of the line may follow, so `"a,b"_D50` is an error, not the field `a,b_D50`.
 */
function cells(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') { quoted = false; closed = true; } else cur += ch;
    } else if (ch === delim) { out.push(cur); cur = ''; closed = false; }
    else if (closed) {
      // Only the real delimiter is held to RFC 4180; re-splitting on ';' or tab (what a
      // spreadsheet in another locale might do) is just a formula check.
      if (delim === ',') throw new Error(`text after a closing quote in: ${line}`);
      cur += ch;
    }
    else if (ch === '"' && cur === '') quoted = true;
    else cur += ch;
  }
  if (quoted) throw new Error(`unterminated quote in: ${line}`);
  out.push(cur);
  return out;
}

/** CSV records (a quoted field may span lines). */
function records(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quotes = 0;
  for (const line of text.split('\n')) {
    cur = cur === '' ? line : `${cur}\n${line}`;
    quotes += (line.match(/"/g) ?? []).length;
    if (quotes % 2 === 0) { out.push(cur); cur = ''; quotes = 0; }
  }
  if (cur !== '') out.push(cur);
  return out;
}

// A plain number, optionally with a unit made of letters (e.g. -4φ) and closing punctuation: no
// operator, reference or function, so a spreadsheet cannot evaluate it as anything.
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[\p{L}\p{M}%°]*[)\]}.,:;]*\s*$/u;
function expectNoFormulaCells(text: string, what: string): void {
  for (const rec of records(text)) {
    // Comment lines are plain text: a spreadsheet may split them on any delimiter (quotes are not
    // special there), and no resulting cell may be a formula.
    const isComment = rec.startsWith('#');
    for (const delim of [',', ';', '\t', '|']) {
      const parts = isComment ? rec.split(delim) : cells(rec, delim);
      for (const raw of parts) {
        const c = raw.trimStart();
        if (/^[=+\-@]/.test(c) && !NUMERIC.test(c)) {
          throw new Error(`${what}: formula cell ${JSON.stringify(c)} (delimiter ${JSON.stringify(delim)}) in ${JSON.stringify(rec)}`);
        }
      }
    }
  }
}

describe('CSV exports never contain formula cells from user text', () => {
  it('photo grains/summary CSV, site summary/pooled grains CSV and comparison CSV', async () => {
    for (const nasty of NASTY) {
      const sides = [20, 24, 28, 32, 36, 40, 44, 48];
      const inputs: SitePhotoInput[] = [0, 1].map((k) => ({
        photoId: `${nasty}#${k}`,
        label: `${nasty}#${k}`,
        included: true,
        session: squareGrainSession(sides, { mmPerPx: 0.5 }),
      }));
      const report = analyzeSite(inputs, { poolingMode: 'physical-area', bootstrapReplicates: 20, minBaxisPx: 0 });
      const site = { siteId: 's', name: nasty, place: nasty, createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' as const }, photoOrder: [] };
      const photo = { photoId: nasty, siteId: 's', label: nasty, imageBlob: new Blob([]), width: 600, height: 600, addedAt: 0, included: true };
      const ctx = { site, photo, session: inputs[0]!.session, siteReport: report, siteInputs: inputs, psdXAxis: 'mm' as const, siteOptions: { poolingMode: 'physical-area' as const } };
      for (const kind of ['photo-grains-csv', 'photo-summary-csv', 'site-summary-csv', 'site-grains-csv'] as const) {
        const file = await buildExport(kind, ctx as never);
        expectNoFormulaCells(await file!.blob.text(), `${kind} (${JSON.stringify(nasty)})`);
      }
      const compared = computeComparedSites(
        [
          { siteId: 'a', name: nasty, place: nasty, surveyDate: '2024-01-01', inputs },
          { siteId: 'b', name: `${nasty}2`, place: nasty, surveyDate: '2025-01-01', inputs },
        ],
        { poolingMode: 'physical-area', bootstrapReplicates: 20, minBaxisPx: 0 },
      );
      expectNoFormulaCells(comparisonCsv(compared, { siteName: nasty }), `comparison (${JSON.stringify(nasty)})`);
    }
  });
});

describe('csvCell: spaces before a formula character (LibreOffice "Trim spaces" import)', () => {
  it('prefixes a formula character after leading spaces or after a delimiter and spaces', async () => {
    const { csvCell } = await import('../src/modules/provenance.js');
    expect(csvCell(' =1+1')).toBe("' =1+1");
    expect(csvCell('Site, =1+1')).toBe(`"Site, '=1+1"`);
    expect(csvCell('a;  +1+1')).toBe(`"a;  '+1+1"`);
    expect(csvCell('a, @SUM(1)')).toBe(`"a, '@SUM(1)"`);
    // Plain numbers (also with spaces) and ordinary text stay as they are.
    expect(csvCell(' -5')).toBe(' -5');
    expect(csvCell('-1.5e3')).toBe('-1.5e3');
  });

  it('guards pipe- and space-separated imports too (audit N10), keeping ordinary text', async () => {
    const { csvCell, escapeCommentText } = await import('../src/modules/provenance.js');
    // A spreadsheet told to split on spaces would make "-2+3" its own cell, a formula.
    expect(csvCell('name -2+3')).toBe("name '-2+3");
    expect(csvCell('a =1+1')).toBe("a '=1+1");
    expect(csvCell('a|=1+1')).toBe("a|'=1+1");
    expect(csvCell('x +A1')).toBe("x '+A1");
    // Ordinary text and numbers stay as they are.
    expect(csvCell('IMG 1 - copy')).toBe('IMG 1 - copy');
    expect(csvCell('R3: 2024-05-01 -> 2025-05-01')).toBe('R3: 2024-05-01 -> 2025-05-01');
    expect(csvCell('depth -5 m')).toBe('depth -5 m');
    // F-29: formula words that do not start with a letter or digit after the sign.
    expect(csvCell('foo +=1+1')).toBe("foo '+=1+1");
    expect(csvCell('foo +$A$1')).toBe("foo '+$A$1");
    expect(csvCell('foo --1+1')).toBe("foo '--1+1");
    expect(csvCell('foo +@SUM(1 1)')).toBe("foo '+@SUM(1 1)");
    // F-29: any whitespace (e.g. a no-break space) between a delimiter and a formula character.
    expect(csvCell('a|\u00a0=1+1')).toBe("a|\u00a0'=1+1");
    // Comment lines: plain text, formula words and cells guarded.
    expect(escapeCommentText('label: a|b =1+1')).toBe("label: a|b '=1+1");
    expect(escapeCommentText('label: a,=1+1')).toBe("label: a,'=1+1");
    expect(escapeCommentText('cutoffs: [4, -2.5]')).toBe('cutoffs: [4, -2.5]');
  });

  it('keeps negative phi and other number-with-unit words as they are', async () => {
    const { csvCell, escapeCommentText } = await import('../src/modules/provenance.js');
    expect(csvCell('Coarse Gravel (-5φ to -4φ) [16-32 mm]')).toBe('Coarse Gravel (-5φ to -4φ) [16-32 mm]');
    expect(csvCell('depth -5mm, -3°')).toBe('"depth -5mm, -3°"');
    expect(escapeCommentText('range: -2φ to -1φ')).toBe('range: -2φ to -1φ');
    // Not a number with a unit: still guarded.
    expect(csvCell('x -2A1')).toBe("x '-2A1");
    expect(csvCell('x -1+2φ')).toBe("x '-1+2φ");
  });
});
