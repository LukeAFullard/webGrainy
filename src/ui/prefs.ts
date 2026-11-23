/** Small per-browser on/off preferences (localStorage; silently ignored if storage is blocked). */
import { sanitizeReportOptions, type ReportOptions } from './report.js';

export const EXPORTED_ONCE_KEY = 'webgrainy-exported-once';
export const SKIP_LANDING_KEY = 'webgrainy-skip-landing';

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* storage blocked */
  }
}

/** Days sites are kept in this browser after their last use (0 = until deleted). */
export const RETENTION_DAYS_KEY = 'webgrainy-retention-days';
/** Set once the user has dismissed the "how storage works" explanation. */
export const RETENTION_EXPLAINED_KEY = 'webgrainy-retention-explained';

export function readRetentionDaysRaw(): string | null {
  try {
    return localStorage.getItem(RETENTION_DAYS_KEY);
  } catch {
    return null;
  }
}

export function writeRetentionDays(days: number): void {
  try {
    localStorage.setItem(RETENTION_DAYS_KEY, String(days));
  } catch {
    /* storage blocked: the choice lasts for this view only */
  }
}

/** When this browser first ran site retention (ms); set on first read. */
export const RETENTION_SINCE_KEY = 'webgrainy-retention-since';

/**
 * Start of the retention clock for sites that existed before the feature: the first time it
 * is read in this browser. Where storage is blocked, "now" (so nothing is ever removed early).
 */
export function readRetentionSince(now = Date.now()): number {
  try {
    const raw = localStorage.getItem(RETENTION_SINCE_KEY);
    const v = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(v) && v > 0 && v <= now) return v;
    localStorage.setItem(RETENTION_SINCE_KEY, String(now));
  } catch {
    /* storage blocked */
  }
  return now;
}

/** Printable report options (Export → Printable report → Options). */
export const REPORT_OPTIONS_KEY = 'webgrainy-report-options';

export function readReportOptions(): ReportOptions {
  try {
    const raw = localStorage.getItem(REPORT_OPTIONS_KEY);
    return sanitizeReportOptions(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeReportOptions(null);
  }
}

export function writeReportOptions(o: ReportOptions): void {
  try {
    localStorage.setItem(REPORT_OPTIONS_KEY, JSON.stringify(o));
  } catch {
    /* storage blocked: the choice lasts for this view only */
  }
}
