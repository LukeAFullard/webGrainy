/**
 * Places and their surveys. A "site" record is one survey (photos taken on one occasion);
 * repeat surveys of the same place share a place name, so they can be listed together and
 * followed over time.
 */
import { siteSurveyDate } from './surveyDate.js';

export interface PlaceSurvey {
  siteId: string;
  name: string;
  /** Survey date (entered, else the earliest photo date), or null. */
  date: string | null;
}

export interface PlaceGroup {
  /** Place name, or null for surveys without a place. */
  place: string | null;
  /** Surveys, oldest first (undated last, by name). */
  surveys: PlaceSurvey[];
}

/** Normalised place name ("" / whitespace -> null). */
export function placeName(place: string | undefined | null): string | null {
  const p = (place ?? '').trim().replace(/\s+/g, ' ');
  return p.length > 0 ? p : null;
}

/**
 * Sites grouped by place (case-insensitive, first spelling kept), places A-Z, surveys oldest
 * first; sites without a place come last as their own group.
 */
export function groupSitesByPlace(
  sites: ReadonlyArray<{ siteId: string; name: string; place?: string; surveyDate?: string }>,
  photoDates: (siteId: string) => ReadonlyArray<string | undefined> = () => [],
): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup>();
  const loose: PlaceSurvey[] = [];
  for (const s of sites) {
    const survey: PlaceSurvey = { siteId: s.siteId, name: s.name, date: siteSurveyDate(s.surveyDate, photoDates(s.siteId)).date };
    const place = placeName(s.place);
    if (place === null) {
      loose.push(survey);
      continue;
    }
    const key = place.toLowerCase();
    const g = groups.get(key) ?? { place, surveys: [] };
    g.surveys.push(survey);
    groups.set(key, g);
  }
  const byDate = (a: PlaceSurvey, b: PlaceSurvey): number => {
    if (a.date !== null && b.date !== null && a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.date === null && b.date !== null) return 1;
    if (a.date !== null && b.date === null) return -1;
    return a.name.localeCompare(b.name);
  };
  const out = [...groups.values()].sort((a, b) => a.place!.localeCompare(b.place!));
  for (const g of out) g.surveys.sort(byDate);
  if (loose.length > 0) out.push({ place: null, surveys: loose.sort((a, b) => a.name.localeCompare(b.name)) });
  return out;
}

/** Site ids of all surveys of the same place as `siteId` (just itself without a place). */
export function surveysOfSamePlace(
  sites: ReadonlyArray<{ siteId: string; place?: string }>,
  siteId: string,
): string[] {
  const me = sites.find((s) => s.siteId === siteId);
  const place = placeName(me?.place);
  if (!me || place === null) return me ? [me.siteId] : [];
  return sites.filter((s) => placeName(s.place)?.toLowerCase() === place.toLowerCase()).map((s) => s.siteId);
}
