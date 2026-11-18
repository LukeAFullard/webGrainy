import { describe, expect, it } from 'vitest';
import { backupStatus, formatAgo, markSiteBackedUp, markSiteChanged, readBackupRecords, type KeyValueStore } from '../src/ui/backup.js';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('backup reminders', () => {
  it('asks for a backup when results exist and changed after the last backup', () => {
    const s = memory();
    expect(backupStatus(readBackupRecords(s)['a'], false).needsBackup).toBe(false); // empty site: no nagging
    markSiteChanged('a', 1000, s);
    expect(backupStatus(readBackupRecords(s)['a'], true, 2000)).toMatchObject({ needsBackup: true, ago: 'never' });
    markSiteBackedUp('a', 3000, s);
    expect(backupStatus(readBackupRecords(s)['a'], true, 3000 + 2 * 3600e3)).toMatchObject({ needsBackup: false, ago: '2 hours ago' });
    markSiteChanged('a', 5000, s);
    expect(backupStatus(readBackupRecords(s)['a'], true, 6000).needsBackup).toBe(true);
    expect(readBackupRecords(s)['b']).toBeUndefined();
  });

  it('ignores corrupted stored data', () => {
    const s = memory();
    s.data.set('webgrainy-backup-v1', '{not json');
    expect(readBackupRecords(s)).toEqual({});
    s.data.set('webgrainy-backup-v1', JSON.stringify({ a: { changedAt: 'x', backedUpAt: 5 } }));
    expect(readBackupRecords(s)).toEqual({ a: { backedUpAt: 5 } });
  });

  it('formats ages', () => {
    expect(formatAgo(10_000)).toBe('just now');
    expect(formatAgo(60_000)).toBe('1 minute ago');
    expect(formatAgo(3 * 86400e3)).toBe('3 days ago');
  });
});
