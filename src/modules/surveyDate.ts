/**
 * Survey dates for sites (comparing sites over time). A site's date is the one the user set,
 * or else the earliest photo date from the photos' EXIF data.
 */

/** "YYYY-MM-DD" with a real calendar date. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** EXIF "YYYY:MM:DD HH:MM:SS" (or an ISO date-time) to "YYYY-MM-DD"; null if unreadable. */
export function photoDate(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(timestamp.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDate(iso) && iso !== '0000-00-00' ? iso : null;
}

/** Earliest photo date among the given EXIF timestamps. */
export function earliestPhotoDate(timestamps: ReadonlyArray<string | undefined>): string | null {
  const dates = timestamps.map(photoDate).filter((d): d is string => d !== null).sort();
  return dates[0] ?? null;
}

export interface SiteDate {
  date: string | null;
  /** 'set' = entered by the user; 'photos' = earliest photo date. */
  source: 'set' | 'photos' | null;
}

export function siteSurveyDate(surveyDate: string | undefined, photoTimestamps: ReadonlyArray<string | undefined>): SiteDate {
  if (isIsoDate(surveyDate)) return { date: surveyDate, source: 'set' };
  const fromPhotos = earliestPhotoDate(photoTimestamps);
  return fromPhotos ? { date: fromPhotos, source: 'photos' } : { date: null, source: null };
}

/** Splits items into those with a date (sorted, oldest first; ties by name) and those without. */
export function orderByDate<T extends { date: string | null; name: string }>(items: readonly T[]): { dated: T[]; undated: T[] } {
  const dated = items.filter((i) => i.date !== null).sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : a.name.localeCompare(b.name)));
  return { dated, undated: items.filter((i) => i.date === null) };
}
