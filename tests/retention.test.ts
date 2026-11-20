import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_DAYS, parseRetentionDays, siteLastUsed, siteRetention } from '../src/modules/retention.js';
import { forgetSite, markSiteChanged, markSiteUsed, readBackupRecords } from '../src/ui/backup.js';

const DAY = 86_400_000;
const site = (id: string, t: number) => ({ siteId: id, createdAt: t, updatedAt: t });

describe('site retention', () => {
  it('counts from the last use: opened, changed or kept longer', () => {
    expect(siteLastUsed(site('a', 10), undefined)).toBe(10);
    expect(siteLastUsed(site('a', 10), { changedAt: 50, usedAt: 30 })).toBe(50);
    expect(siteLastUsed(site('a', 10), { changedAt: 50, usedAt: 90 })).toBe(90);
  });

  it('lists sites due for removal and those due within 3 days', () => {
    const now = 100 * DAY;
    const sites = [site('old', 60 * DAY), site('soon', 72 * DAY), site('fresh', 95 * DAY), site('kept', 10 * DAY)];
    const { due, soon } = siteRetention(sites, { kept: { usedAt: 99 * DAY } }, 30, now);
    expect(due.map((d) => d.site.siteId)).toEqual(['old']);
    expect(soon.map((d) => [d.site.siteId, d.daysLeft])).toEqual([['soon', 2]]);
  });

  it('keeps everything when retention is "until deleted" (0)', () => {
    expect(siteRetention([site('x', 0)], {}, 0, 1e12)).toEqual({ due: [], soon: [] });
  });

  it('parses the stored choice, falling back to the default', () => {
    expect(parseRetentionDays('14')).toBe(14);
    expect(parseRetentionDays('0')).toBe(0);
    expect(parseRetentionDays('13')).toBe(DEFAULT_RETENTION_DAYS);
    expect(parseRetentionDays(null)).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('records use per site in the browser and forgets deleted sites', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    markSiteChanged('a', 5, store);
    markSiteUsed('a', 9, store);
    expect(readBackupRecords(store)['a']).toEqual({ changedAt: 5, usedAt: 9 });
    forgetSite('a', store);
    expect(readBackupRecords(store)['a']).toBeUndefined();
  });
});
