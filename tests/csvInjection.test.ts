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

/** Splits one CSV line on `delim`, honouring double quotes (as spreadsheets do). */
function cells(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ''; } else cur += ch;
  }
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

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function expectNoFormulaCells(text: string, what: string): void {
  for (const rec of records(text)) {
    if (rec.startsWith('#')) {
      // Comment lines: no delimiter at all, so the whole line stays in its first cell.
      expect(/[,;\t]/.test(rec), `${what}: delimiter in comment line ${JSON.stringify(rec)}`).toBe(false);
      continue;
    }
    for (const delim of [',', ';', '\t']) {
      for (const c of cells(rec, delim)) {
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
    expect(csvCell('name -2+3')).toBe('name -2+3');
  });
});
