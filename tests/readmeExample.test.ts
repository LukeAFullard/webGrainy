/**
 * The README "Library use" example gives the numbers the app shows (pre-publication audit B3f:
 * the old example applied only the 15 px cutoff, so photos the app analyses below 0.41x scale
 * got different n and D16 than the dashboard).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeSite, computeWorkspaceReports, DEFAULT_SITE_OPTIONS, photoCutoffs } from '../src/index.js';
import { squareGrainSession } from './helpers/squareSession.js';

describe('README library example', () => {
  it('uses photoCutoffs (the app\'s cutoffs), not a bare 15 px cutoff', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const block = readme.slice(readme.indexOf('### Library use'), readme.indexOf('## Citations'));
    expect(block).toContain('photoCutoffs(DEFAULT_SITE_OPTIONS, site,');
    expect(block).not.toMatch(/getStats\('bAxis', \{ minBaxisPx: 15 \}\)/);
  });

  for (const scale of [1, 0.25]) {
    it(`matches the dashboard for a calibrated photo analysed at ${scale}x`, () => {
      const session = squareGrainSession(Array.from({ length: 300 }, (_, i) => 4 + (i % 11)), { w: 600, h: 600, mmPerPx: 0.25, scale });
      // The README recipe:
      const site = analyzeSite([{ photoId: 'p1', label: 'photo1.jpg', included: true, session }], DEFAULT_SITE_OPTIONS);
      const stats = session.getStats('bAxis', photoCutoffs(DEFAULT_SITE_OPTIONS, site, 'p1'));
      // What the app shows:
      const app = computeWorkspaceReports({
        photos: [{ photoId: 'p1', label: 'photo1.jpg', included: true } as never],
        sessions: new Map([['p1', session]]),
        activePhotoId: 'p1',
        siteOptions: { ...DEFAULT_SITE_OPTIONS },
      });
      expect(stats.includedGrains).toBe(app.singlePhotoStats!.includedGrains);
      for (const k of ['D16', 'D50', 'D84'] as const) expect(stats.areaWeightedB[k]).toBe(app.singlePhotoStats!.areaWeightedB[k]);
      expect(site.psd.D50).toBe(app.siteReport!.psd.D50);
    });
  }
});
