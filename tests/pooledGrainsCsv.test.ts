import { describe, expect, it } from 'vitest';
import { computePsdPercentiles } from '../src/modules/sedimentStats.js';
import { analyzeSite, exportPooledGrainsCsv, type PoolingMode, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { squareGrainSession } from './helpers/squareSession.js';

// 30 small (8-12 px) and 30 larger (20-40 px) grains per photo.
const SIDES = [...Array.from({ length: 30 }, (_, i) => 8 + (i % 5)), ...Array.from({ length: 30 }, (_, i) => 20 + (i % 21))];

async function rows(inputs: SitePhotoInput[], mode: PoolingMode, extra: Record<string, unknown> = {}) {
  const report = analyzeSite(inputs, { poolingMode: mode, bootstrapReplicates: 20, ...extra });
  const text = await exportPooledGrainsCsv(inputs, report).text();
  const lines = text.trim().split('\n').filter((l) => !l.startsWith('#'));
  const header = lines[0]!.split(',');
  const col = (name: string) => header.indexOf(name);
  return {
    report,
    header,
    data: lines.slice(1).map((l) => l.split(',')).map((c) => ({
      included: c[col('included_in_stats')] === 'true',
      reason: c[col('exclusion_reason')],
      bMm: Number(c[col('b_axis_mm')]),
      bPx: Number(c[col('b_axis_px')]),
      areaMm2: Number(c[col('area_mm2')]),
    })),
  };
}

describe('pooled grains CSV marks exactly the grains used in the site statistics', () => {
  const inputs = (): SitePhotoInput[] =>
    [0, 1].map((k) => ({ photoId: `p${k}`, label: `p${k}`, included: true, session: squareGrainSession(SIDES, { mmPerPx: 0.5 }) }));

  for (const mode of ['physical-area', 'number-weighted'] as const) {
    it(`${mode}: included rows reproduce the reported percentiles`, async () => {
      const { report, header, data } = await rows(inputs(), mode);
      expect(header).toContain('included_in_stats');
      expect(data.length).toBe(120);
      const inc = data.filter((d) => d.included);
      expect(inc.length).toBe(report.validGrainCount);
      expect(data.length - inc.length).toBe(report.excludedTruncationCount);
      const psd = computePsdPercentiles(inc.map((d) => d.bMm), inc.map((d) => (mode === 'number-weighted' ? 1 : d.areaMm2)));
      for (const k of ['D16', 'D50', 'D84'] as const) expect(psd[k]).toBeCloseTo(report.psd[k], 9);
    });
  }

  it('gives the reason for each left-out grain (px cutoff vs common mm cutoff)', async () => {
    const { data } = await rows(inputs(), 'physical-area', { minBaxisPx: 10, harmonizeCutoff: false, minSizeMm: 9 });
    for (const d of data.filter((x) => !x.included)) {
      expect(d.reason).toBe(d.bPx < 10 ? 'below_px_cutoff' : 'below_mm_cutoff');
    }
    expect(data.some((d) => d.reason === 'below_mm_cutoff')).toBe(true);
    expect(data.some((d) => d.reason === 'below_px_cutoff')).toBe(true);
  });

  it('leaves the columns empty without a report', async () => {
    const text = await exportPooledGrainsCsv(inputs()).text();
    expect(text.split('\n')[1]!.endsWith(',,')).toBe(true);
  });
});
