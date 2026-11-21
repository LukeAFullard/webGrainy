/**
 * Comparing two or more sites: load each site's saved photos and analyses, compute their
 * site reports with the same settings, and summarise the differences.
 *
 * The pairwise D16/D50/D84 test is approximate: each site's standard error of ln(Dx) is the one
 * behind its reported interval (larger of the photo-level bootstrap SE x sqrt(n/(n-1)) and the
 * leave-one-photo-out jackknife SE), and the log-ratio of two sites is compared with a Welch
 * t-test (n-1 degrees of freedom per site). One-photo sites get no test. With several pairs (or
 * surveys), Holm-adjusted p-values control the chance of any false "significant" result. It is
 * a screening tool in the spirit of Eaton et al. (2019, GSDtools), not a replacement for a full
 * two-sample bootstrap.
 */
import { placeName } from './sitePlaces.js';
import { siteSurveyDate } from './surveyDate.js';
import { AnalysisSession } from './analysisSession.js';
import { getPhotoResult, listSitePhotos, type ProjectStorageOptions } from './projectStorage.js';
import { csvCell } from './provenance.js';
import { tTwoSidedP, tTwoSidedQuantile } from './studentT.js';
import { analyzeSite, type SiteAnalysisOptions, type SiteAnalysisReport, type SitePhotoInput } from './siteAnalysis.js';
import { buildSiteInputs } from './siteWorkspace.js';
import { analysisSettingsOf } from './siteProvenance.js';

/** Okabe–Ito colour-blind-safe palette (blue, orange, green, vermillion, purple, sky, yellow, black). */
export const COMPARE_COLORS = ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#C9A600', '#444444'] as const;

/** Site-analysis inputs for a site stored in IndexedDB (calibration and ROI applied). */
export async function loadStoredSiteInputs(
  siteId: string,
  siteOptions: Pick<SiteAnalysisOptions, 'maxExcludedFraction'>,
  storage?: ProjectStorageOptions,
): Promise<SitePhotoInput[]> {
  const photos = await listSitePhotos(siteId, storage);
  const sessions = new Map<string, AnalysisSession>();
  for (const p of photos) {
    const res = await getPhotoResult(p.photoId, storage);
    if (!res?.serializedSession || res.status !== 'done') continue;
    try {
      const sess = AnalysisSession.fromSerialized(res.serializedSession);
      if (p.calibration) sess.setCalibration(p.calibration);
      sessions.set(p.photoId, sess);
    } catch {
      /* unreadable result: treat as not analysed */
    }
  }
  const inputs = buildSiteInputs({ photos, sessions, siteOptions });
  for (const i of inputs) if (i.roiConfig) i.session.setRoiConfig(i.roiConfig);
  return inputs;
}

export interface SiteForComparison {
  siteId: string;
  name: string;
  inputs: readonly SitePhotoInput[];
  /** Fixed colour for this site (so it keeps its colour when others are added or removed). */
  color?: string;
  /** Survey date the user set (YYYY-MM-DD); otherwise the earliest photo date is used. */
  surveyDate?: string;
  /** Place this survey belongs to (repeat surveys of one place share it). */
  place?: string;
}

export interface ComparedSite {
  siteId: string;
  name: string;
  color: string;
  report: SiteAnalysisReport | null;
  /** Why the site has no report (no analysed photos, uncalibrated, …). */
  error: string | null;
  /** Survey date (YYYY-MM-DD), set by the user or taken from the photos; null if unknown. */
  date: string | null;
  dateSource: 'set' | 'photos' | null;
  /** Place of the survey (null when not set). */
  place: string | null;
  /**
   * The analysis settings of the site's photos that change results (model, image scale,
   * pipeline, CLAHE, fine-grain upscale, post-processing, image steps): each setting's
   * value, or the distinct values joined by " | " when the photos differ.
   */
  analysisSettings: Record<string, string>;
}

/**
 * Settings that differ between the compared sites (or within one), as warnings. Differences
 * in model, image scale or processing can change grain sizes on their own, so a "change"
 * between such surveys may not be real.
 */
export function settingsMismatches(sites: readonly ComparedSite[]): string[] {
  const withReport = sites.filter((s) => s.report !== null);
  const keys = new Set(withReport.flatMap((s) => Object.keys(s.analysisSettings)));
  const out: string[] = [];
  for (const k of keys) {
    const vals = new Set(withReport.map((s) => s.analysisSettings[k] ?? 'unknown'));
    const mixedWithin = withReport.filter((s) => (s.analysisSettings[k] ?? '').includes(' | '));
    if (vals.size > 1 || mixedWithin.length > 0) {
      const detail = withReport.map((s) => `${s.name}: ${s.analysisSettings[k] ?? 'unknown'}`).join('; ');
      out.push(`Different ${k} (${detail}). Differences may come from the analysis, not the bed: re-analyse the photos with the same settings.`);
    }
  }
  return out;
}

/**
 * Site reports for each site, computed with the same options. When the sites are in mm, they
 * are compared over the same size range: the largest harmonised cutoff of any site (a site
 * photographed from higher up or at lower resolution cannot see small grains) is applied to
 * all of them, so differences are not just different truncation.
 */
export function computeComparedSites(sites: readonly SiteForComparison[], options: SiteAnalysisOptions): ComparedSite[] {
  // One spelling per place (case and spacing ignored, first spelling kept), as in the site
  // list, so "Reach A" and "reach  a" are followed over time as one place.
  const spelling = new Map<string, string>();
  const canonicalPlace = (raw: string | undefined): string | null => {
    const p = placeName(raw);
    if (p === null) return null;
    const key = p.toLowerCase();
    if (!spelling.has(key)) spelling.set(key, p);
    return spelling.get(key)!;
  };
  const places = sites.map((s) => canonicalPlace(s.place));
  const run = (opts: SiteAnalysisOptions): ComparedSite[] =>
    sites.map((s, i) => {
      const color = s.color ?? COMPARE_COLORS[i % COMPARE_COLORS.length]!;
      const { date, source: dateSource } = siteSurveyDate(s.surveyDate, s.inputs.filter((p) => p.included).map((p) => p.metadata?.timestamp));
      const place = places[i]!;
      const base = { siteId: s.siteId, name: s.name, color, date, dateSource, place, analysisSettings: analysisSettingsOf(s.inputs) };
      if (!s.inputs.some((p) => p.included)) {
        return { ...base, report: null, error: 'No analysed photos' };
      }
      try {
        return { ...base, report: analyzeSite(s.inputs, opts), error: null };
      } catch (err) {
        return { ...base, report: null, error: err instanceof Error ? err.message : String(err) };
      }
    });
  const first = run(options);
  const mm = first.filter((s) => s.report?.unit === 'mm');
  if (mm.length < 2) return first;
  const cutoffs = mm.map((s) => s.report!.dCutoffCommonMm ?? 0);
  const common = Math.max(...cutoffs);
  if (!(common > 0) || cutoffs.every((c) => Math.abs(c - common) < 1e-9)) return first;
  return run({ ...options, minSizeMm: Math.max(options.minSizeMm ?? 0, common) });
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

const zFor = (level: number): number => (level >= 0.95 ? 1.959963984540054 : 1.6448536269514722);

export type ComparedPercentile = 'D16' | 'D50' | 'D84';

export interface D50Comparison {
  a: string;
  b: string;
  /** Percentile compared (D50 unless stated). */
  key: ComparedPercentile;
  /** Value of a divided by value of b. */
  ratio: number;
  ratioLo: number;
  ratioHi: number;
  /** Two-sided p-value of the approximate log-ratio t-test (NaN when not computed). */
  p: number;
  /**
   * Holm-adjusted p-value over all comparisons of this percentile in the same table (all site
   * pairs, or all consecutive surveys). Use it when reading many comparisons at once: at
   * p < 0.05 the chance of any false "significant" result is then at most 5%.
   */
  pAdjusted: number;
  /**
   * How far the interval and p-value can be trusted: 'photos' when both sites have at least
   * MIN_PHOTOS_FOR_TEST photos; 'few-photos' when either has fewer (approximate); 'single-photo'
   * when either has one photo. Its bootstrap only resamples grains within the photo, so it
   * misses patch-to-patch variation of the bed; the interval and p-value are then not given.
   */
  basis: ComparisonBasis;
  /** Welch degrees of freedom of the t-test (NaN when not computed). */
  df: number;
}

export type ComparisonBasis = 'photos' | 'few-photos' | 'single-photo';

/** Photos per site from which the between-site test is treated as reliable. */
export const MIN_PHOTOS_FOR_TEST = 5;

/** Test basis of a pair of site reports (see `D50Comparison.basis`). */
export function comparisonBasis(a: SiteAnalysisReport, b: SiteAnalysisReport): ComparisonBasis {
  const single = (r: SiteAnalysisReport): boolean => r.bootstrapMode === 'single-photo-grain-fallback' || r.includedPhotoCount < 2;
  if (single(a) || single(b)) return 'single-photo';
  return Math.min(a.includedPhotoCount, b.includedPhotoCount) < MIN_PHOTOS_FOR_TEST ? 'few-photos' : 'photos';
}

type WithReport = ComparedSite & { report: SiteAnalysisReport };

/**
 * Standard error of ln(Dx) of a site, already corrected for its number of photos: the one behind
 * the site's reported interval (`ciLogSe`: larger of the bootstrap SE x sqrt(n/(n-1)) and the
 * jackknife SE). Reports without it fall back to the bootstrap interval x sqrt(n/(n-1)).
 */
function siteLogSe(r: SiteAnalysisReport, key: ComparedPercentile): number {
  const se = r.ciLogSe?.[key];
  if (se !== undefined) return se > 0 ? se : Number.NaN;
  const ci = r.bootstrapPercentileCi ?? r.bootstrapCi;
  const lo = ci.lower[key];
  const hi = ci.upper[key];
  const n = r.includedPhotoCount;
  return lo > 0 && hi > lo && n > 1 ? ((Math.log(hi) - Math.log(lo)) / (2 * zFor(ci.confidenceLevel))) * Math.sqrt(n / (n - 1)) : Number.NaN;
}

/**
 * Small-sample test of the log-ratio of a percentile between two sites (Welch t-test), with
 * each site's photo-corrected log-scale standard error (`siteLogSe`) and Welch-Satterthwaite
 * degrees of freedom from n-1 per site. On simulated unchanged beds (3-20 photos, moderate and
 * strong patch-to-patch variation) it gave p < 0.05 in about 2-7% of comparisons
 * (validation/comparison/). `pAdjusted` is filled by the callers (Holm).
 */
function comparePair(A: WithReport, B: WithReport, key: ComparedPercentile): D50Comparison {
  const lr = Math.log(A.report.psd[key] / B.report.psd[key]);
  const basis = comparisonBasis(A.report, B.report);
  // Single-photo sites: their grain-only bootstrap interval cannot see patch-to-patch
  // variation (about 30% false "significant" changes in simulation): no interval or p-value.
  if (basis === 'single-photo') {
    return { a: A.name, b: B.name, key, ratio: Math.exp(lr), ratioLo: Number.NaN, ratioHi: Number.NaN, p: Number.NaN, pAdjusted: Number.NaN, basis, df: Number.NaN };
  }
  const nA = A.report.includedPhotoCount;
  const nB = B.report.includedPhotoCount;
  const seA = siteLogSe(A.report, key);
  const seB = siteLogSe(B.report, key);
  const s = Math.hypot(seA, seB);
  const df = (seA * seA + seB * seB) ** 2 / (seA ** 4 / (nA - 1) + seB ** 4 / (nB - 1));
  const ok = Number.isFinite(s) && s > 0 && Number.isFinite(df) && df > 0;
  const q = ok ? tTwoSidedQuantile(0.95, df) : Number.NaN;
  return {
    a: A.name,
    b: B.name,
    key,
    ratio: Math.exp(lr),
    ratioLo: ok ? Math.exp(lr - q * s) : Number.NaN,
    ratioHi: ok ? Math.exp(lr + q * s) : Number.NaN,
    p: ok ? tTwoSidedP(lr / s, df) : Number.NaN,
    pAdjusted: Number.NaN,
    basis,
    df: ok ? df : Number.NaN,
  };
}

/**
 * Holm (1979) step-down adjusted p-values (NaN entries are skipped and stay NaN). Controls the
 * family-wise error rate: with 8 identical sites (28 pairs) unadjusted p < 0.05 flagged at least
 * one pair in 59% of simulated studies.
 */
export function holmAdjust(p: readonly number[]): number[] {
  const idx = p.map((v, i) => [v, i] as const).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const out = p.map(() => Number.NaN);
  const m = idx.length;
  let running = 0;
  idx.forEach(([v, i], k) => {
    running = Math.max(running, Math.min(1, (m - k) * v));
    out[i] = running;
  });
  return out;
}

function withHolm(list: D50Comparison[]): D50Comparison[] {
  const adj = holmAdjust(list.map((c) => c.p));
  return list.map((c, i) => ({ ...c, pAdjusted: adj[i]! }));
}

/** Sites that can be compared with each other: a report, and the same unit and size metric as the first. */
function comparable(sites: readonly ComparedSite[], key: ComparedPercentile): WithReport[] {
  return sites.filter((s) => s.report !== null && s.report.psd[key] > 0) as WithReport[];
}

/**
 * Approximate pairwise ratios (95% CI) and p-values of a percentile between sites with
 * reports. Only like-for-like pairs are compared: a site reported in px is never divided by
 * one in mm (or measured with another size metric).
 */
export function comparePercentile(sites: readonly ComparedSite[], key: ComparedPercentile): D50Comparison[] {
  const ok = comparable(sites, key);
  const out: D50Comparison[] = [];
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      const A = ok[i]!;
      const B = ok[j]!;
      if (A.report.unit !== B.report.unit || A.report.sizeMetric !== B.report.sizeMetric) continue;
      out.push(comparePair(A, B, key));
    }
  }
  return withHolm(out);
}

/** Pairwise D50 comparisons (see comparePercentile). */
export function compareD50(sites: readonly ComparedSite[]): D50Comparison[] {
  return comparePercentile(sites, 'D50');
}

export interface SurveyChange {
  place: string;
  /** Earlier and later survey (site names) and dates. */
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  /** Later / earlier, per percentile (ratio > 1 = coarser). */
  changes: Record<ComparedPercentile, D50Comparison>;
}

/**
 * Change between consecutive dated surveys of each place (later / earlier), for D16, D50 and
 * D84, with approximate 95% CIs and p-values. Surveys without a date or a place, or in
 * another unit / size metric than the place's earlier survey, are left out.
 */
export function surveyChanges(sites: readonly ComparedSite[]): SurveyChange[] {
  const byPlace = new Map<string, WithReport[]>();
  for (const s of sites) {
    if (s.place === null || s.date === null || s.report === null) continue;
    const list = byPlace.get(s.place) ?? [];
    list.push(s as WithReport);
    byPlace.set(s.place, list);
  }
  const out: SurveyChange[] = [];
  for (const [place, list] of [...byPlace].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : a.name.localeCompare(b.name)));
    for (let i = 1; i < list.length; i++) {
      const A = list[i - 1]!;
      const B = list[i]!;
      if (A.report.unit !== B.report.unit || A.report.sizeMetric !== B.report.sizeMetric) continue;
      out.push({
        place,
        from: A.name,
        to: B.name,
        fromDate: A.date!,
        toDate: B.date!,
        changes: {
          D16: comparePair(B, A, 'D16'),
          D50: comparePair(B, A, 'D50'),
          D84: comparePair(B, A, 'D84'),
        },
      });
    }
  }
  for (const key of ['D16', 'D50', 'D84'] as const) {
    const adjusted = withHolm(out.map((c) => c.changes[key]));
    out.forEach((c, i) => {
      c.changes[key] = adjusted[i]!;
    });
  }
  return out;
}

const num = (v: number): string => (Number.isFinite(v) ? String(v) : '');

/** Warnings about how far the between-site tests can be trusted (few or single photos). */
export function comparisonWarnings(sites: readonly ComparedSite[]): string[] {
  const withReport = sites.filter((s) => s.report !== null) as WithReport[];
  const single = withReport.filter((s) => s.report.bootstrapMode === 'single-photo-grain-fallback' || s.report.includedPhotoCount < 2);
  const few = withReport.filter((s) => !single.includes(s) && s.report.includedPhotoCount < MIN_PHOTOS_FOR_TEST);
  const out: string[] = [];
  if (single.length > 0) {
    out.push(
      `${single.map((s) => s.name).join(', ')}: one photo only, so no interval or p-value is given for comparisons with ${single.length === 1 ? 'this site' : 'these sites'}. One photo cannot show how much the bed varies from patch to patch; take several photos per survey.`,
    );
  }
  if (few.length > 0) {
    out.push(
      `${few.map((s) => `${s.name} (${s.report.includedPhotoCount} photos)`).join(', ')}: fewer than ${MIN_PHOTOS_FOR_TEST} photos, so intervals involving ${few.length === 1 ? 'this site' : 'these sites'} are wide and only large differences can be detected.`,
    );
  }
  return out;
}

/** Comparison table and pairwise tests as `section,site,metric,value,unit` CSV. */
export function comparisonCsv(sites: readonly ComparedSite[], metadata: Record<string, unknown>): string {
  const lines = ['section,site,metric,value,unit'];
  for (const [k, v] of Object.entries(metadata)) lines.push(`metadata,,${csvCell(k)},${csvCell(typeof v === 'string' ? v : JSON.stringify(v))},meta`);
  for (const s of sites) {
    const name = csvCell(s.name);
    const r = s.report;
    if (s.place) lines.push(`site,${name},place,${csvCell(s.place)},text`);
    if (s.date) lines.push(`site,${name},survey_date,${s.date},${s.dateSource === 'set' ? 'date (entered)' : 'date (earliest photo)'}`);
    if (!r) {
      lines.push(`site,${name},status,${csvCell(s.error ?? 'no report')},text`);
      continue;
    }
    const u = r.unit;
    const rows: Array<[string, number | string | null | undefined, string]> = [
      ['photos', r.includedPhotoCount, 'count'],
      ['grains', r.validGrainCount, 'count'],
      ['pooling_mode', r.poolingMode, 'mode'],
      ['bootstrap_mode', r.bootstrapMode, 'mode'],
      ['ci_status', r.ciStatus, 'label'],
      ['size_metric', r.sizeMetric, 'metric'],
      ['size_cutoff', r.dCutoffCommonMm, 'mm'],
      ['D16', r.psd.D16, u],
      ['D16_ci_lo', r.bootstrapCi.lower.D16, u],
      ['D16_ci_hi', r.bootstrapCi.upper.D16, u],
      ['D50', r.psd.D50, u],
      ['D50_ci_lo', r.bootstrapCi.lower.D50, u],
      ['D50_ci_hi', r.bootstrapCi.upper.D50, u],
      ['D84', r.psd.D84, u],
      ['D84_ci_lo', r.bootstrapCi.lower.D84, u],
      ['D84_ci_hi', r.bootstrapCi.upper.D84, u],
      ['geometric_mean_Dg', r.extra?.geometricMean, u],
      ['geometric_sd_sigma_g', r.extra?.geometricSd, 'ratio'],
      ['sauter_mean_D32', r.extra?.sauterMeanD32, u],
      ['folk_ward_mean', r.folkWard?.meanPhi, 'phi'],
      ['folk_ward_sorting', r.folkWard?.sortingPhi, 'phi'],
      ['folk_ward_skewness', r.folkWard?.skewnessPhi, 'phi'],
      ['folk_ward_kurtosis', r.folkWard?.kurtosisPhi, 'phi'],
      ['effective_grain_count', r.adequacy.effectiveGrainCount, 'count'],
      ['median_aspect_ratio_b_over_a', r.shape.medianAspectRatio, 'ratio'],
      ['fabric_mean_orientation', r.fabricRose.meanAxialDeg, 'deg (0 = image vertical)'],
      ['fabric_resultant_length_R', r.fabricRose.resultantLength, 'ratio'],
      ['fabric_rayleigh_p', r.fabricRose.rayleighP ?? undefined, 'p'],
      ['sand_pct', r.wentworth?.sandPct, '%'],
      ['gravel_pct', r.wentworth?.gravelPct, '%'],
      ['cobble_pct', r.wentworth?.cobblePct, '%'],
      ['boulder_pct', r.wentworth?.boulderPct, '%'],
      ['adequacy', r.adequacy.rating, 'label'],
    ];
    for (const [m, v, unit] of rows) {
      if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) continue;
      lines.push(`site,${name},${m},${csvCell(v)},${unit}`);
    }
  }
  for (const key of ['D16', 'D50', 'D84'] as const) {
    for (const c of comparePercentile(sites, key)) {
      const pair = csvCell(`${c.a} vs ${c.b}`);
      const sec = `${key.toLowerCase()}_ratio`;
      lines.push(`${sec},${pair},ratio,${c.ratio},ratio`);
      lines.push(`${sec},${pair},ratio_ci95_lo,${num(c.ratioLo)},ratio`);
      lines.push(`${sec},${pair},ratio_ci95_hi,${num(c.ratioHi)},ratio`);
      lines.push(`${sec},${pair},p_value_approx,${num(c.p)},p`);
      lines.push(`${sec},${pair},p_value_holm,${num(c.pAdjusted)},p`);
      lines.push(`${sec},${pair},t_test_df,${num(c.df)},df`);
      lines.push(`${sec},${pair},test_basis,${c.basis},label`);
    }
  }
  for (const ch of surveyChanges(sites)) {
    const label = csvCell(`${ch.place}: ${ch.fromDate} -> ${ch.toDate}`);
    for (const key of ['D16', 'D50', 'D84'] as const) {
      const c = ch.changes[key];
      lines.push(`survey_change,${label},${key}_ratio_later_over_earlier,${c.ratio},ratio`);
      lines.push(`survey_change,${label},${key}_ratio_ci95_lo,${num(c.ratioLo)},ratio`);
      lines.push(`survey_change,${label},${key}_ratio_ci95_hi,${num(c.ratioHi)},ratio`);
      lines.push(`survey_change,${label},${key}_p_value_approx,${num(c.p)},p`);
      lines.push(`survey_change,${label},${key}_p_value_holm,${num(c.pAdjusted)},p`);
      lines.push(`survey_change,${label},${key}_t_test_df,${num(c.df)},df`);
      lines.push(`survey_change,${label},${key}_test_basis,${c.basis},label`);
    }
  }
  [...settingsMismatches(sites), ...comparisonWarnings(sites)].forEach((w, i) => lines.push(`warning,,${i + 1},${csvCell(w)},text`));
  return lines.join('\n');
}
