/**
 * Backup reminders. Projects live only in this browser (IndexedDB), so a cleared browser or
 * another computer means lost work. We remember, per site, when its data last changed and
 * when it was last exported as a project file, and remind the user when changes are not
 * backed up. Stored in localStorage (per browser), never sent anywhere.
 */

export const BACKUP_KEY = 'webgrainy-backup-v1';

export interface SiteBackupInfo {
  /** Last time the site's photos, results, scale or ROI changed (ms since epoch). */
  changedAt?: number;
  /** Last time the site was exported as a .webgrainy project (ms since epoch). */
  backedUpAt?: number;
}

export type BackupRecords = Record<string, SiteBackupInfo>;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function readBackupRecords(store: KeyValueStore | null = storage()): BackupRecords {
  try {
    const raw = store?.getItem(BACKUP_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: BackupRecords = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const r = v as Record<string, unknown>;
      out[id] = {
        ...(typeof r['changedAt'] === 'number' ? { changedAt: r['changedAt'] } : {}),
        ...(typeof r['backedUpAt'] === 'number' ? { backedUpAt: r['backedUpAt'] } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function write(records: BackupRecords, store: KeyValueStore | null): void {
  try {
    store?.setItem(BACKUP_KEY, JSON.stringify(records));
  } catch {
    /* storage blocked or full: reminders are best-effort */
  }
}

export function markSiteChanged(siteId: string, now = Date.now(), store: KeyValueStore | null = storage()): void {
  const r = readBackupRecords(store);
  r[siteId] = { ...r[siteId], changedAt: now };
  write(r, store);
}

export function markSiteBackedUp(siteId: string, now = Date.now(), store: KeyValueStore | null = storage()): void {
  const r = readBackupRecords(store);
  r[siteId] = { ...r[siteId], backedUpAt: now };
  write(r, store);
}

export interface BackupStatus {
  backedUpAt: number | null;
  /** True when the site has changes after its last backup (or was never backed up). */
  needsBackup: boolean;
  /** e.g. "never", "just now", "3 hours ago", "2 days ago". */
  ago: string;
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Backup status of a site that has `hasResults` (no reminder for an empty site). */
export function backupStatus(info: SiteBackupInfo | undefined, hasResults: boolean, now = Date.now()): BackupStatus {
  const backedUpAt = info?.backedUpAt ?? null;
  const changedAt = info?.changedAt ?? null;
  const needsBackup = hasResults && (backedUpAt === null || (changedAt !== null && changedAt > backedUpAt));
  return { backedUpAt, needsBackup, ago: backedUpAt === null ? 'never' : formatAgo(now - backedUpAt) };
}
