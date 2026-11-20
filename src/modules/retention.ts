/**
 * How long sites stay in this browser. The browser is a working space, not an archive: a
 * site is removed (photos and results) after a chosen number of days without use, and users
 * download their results to keep them. The clock restarts whenever the site is opened,
 * changed or "kept longer". Removal only happens while the app is open (a page cannot run
 * when closed), and browsers may clear storage sooner on their own.
 */

/** Choices offered (days); 0 = keep until deleted. */
export const RETENTION_CHOICES = [7, 14, 30, 90, 0] as const;
export const DEFAULT_RETENTION_DAYS = 30;
/** Warn this many days before a site is removed. */
export const WARN_DAYS_BEFORE = 3;
const DAY_MS = 86_400_000;

export interface SiteUseInfo {
  changedAt?: number;
  usedAt?: number;
}

/**
 * Last time the site was used: opened, changed or kept longer (falls back to its record
 * dates). Never before `since`, when this browser first ran the retention feature, so sites
 * that existed before it get the full period (and the warning) instead of vanishing at once.
 */
export function siteLastUsed(site: { createdAt: number; updatedAt: number }, info: SiteUseInfo | undefined, since = 0): number {
  return Math.max(site.createdAt || 0, site.updatedAt || 0, info?.changedAt ?? 0, info?.usedAt ?? 0, since);
}

/** When the site will be removed (ms since epoch), or null when sites are kept. */
export function siteExpiry(lastUsed: number, retentionDays: number): number | null {
  return retentionDays > 0 ? lastUsed + retentionDays * DAY_MS : null;
}

export interface SiteRetention<S> {
  site: S;
  expiresAt: number;
  /** Whole days left (0 = due now). */
  daysLeft: number;
}

/** Sites past their date (due for removal) and those due within `WARN_DAYS_BEFORE` days. */
export function siteRetention<S extends { siteId: string; createdAt: number; updatedAt: number }>(
  sites: readonly S[],
  info: Readonly<Record<string, SiteUseInfo | undefined>>,
  retentionDays: number,
  now = Date.now(),
  since = 0,
): { due: Array<SiteRetention<S>>; soon: Array<SiteRetention<S>> } {
  const due: Array<SiteRetention<S>> = [];
  const soon: Array<SiteRetention<S>> = [];
  for (const site of sites) {
    const expiresAt = siteExpiry(siteLastUsed(site, info[site.siteId], since), retentionDays);
    if (expiresAt === null) continue;
    const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
    if (expiresAt <= now) due.push({ site, expiresAt, daysLeft: 0 });
    else if (expiresAt - now <= WARN_DAYS_BEFORE * DAY_MS) soon.push({ site, expiresAt, daysLeft });
  }
  return { due, soon };
}

/** Parses the stored retention choice (invalid -> default). */
export function parseRetentionDays(raw: string | null): number {
  const n = raw === null ? Number.NaN : Number(raw);
  return (RETENTION_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_RETENTION_DAYS;
}
