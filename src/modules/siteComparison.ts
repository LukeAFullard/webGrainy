/**
 * Comparing two or more sites: load each site's saved photos and analyses, compute their
 * site reports with the same settings, and summarise the differences.
 *
 * The pairwise D50 test is approximate: each site's bootstrap confidence interval for D50
 * is converted to a standard error on the log scale (assuming a roughly log-normal sampling
 * distribution), and the log-ratio of the two D50s is compared with a z-test. It is a
 * screening tool in the spirit of Eaton et al. (2019, GSDtools), not a replacement for a
 * full two-sample bootstrap.
 */
import { siteSurveyDate } from './surveyDate.js';
import { AnalysisSession } from './analysisSession.js';
import { getPhotoResult, listSitePhotos, type ProjectStorageOptions } from './projectStorage.js';
import { csvCell } from './provenance.js';
import { analyzeSite, type SiteAnalysisOptions, type SiteAnalysisReport, type SitePhotoInput } from './siteAnalysis.js';
import { buildSiteInputs } from './siteWorkspace.js';
import { photoProcessingHistory } from './siteTypes.js';

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

/** What differs between photos' analyses, in words, for the like-for-like check. */
function analysisSettingsOf(inputs: readonly SitePhotoInput[]): Record<string, string> {
  const values = new Map<string, Set<string>>();
  const add = (k: string, v: unknown): void => {
    const set = values.get(k) ?? new Set<string>();
    set.add(v === undefined || v === null ? 'none' : typeof v === 'string' ? v : JSON.stringify(v));
    values.set(k, set);
  };
  for (const p of inputs) {
    if (!p.included) continue;
    const prov = p.session.getProvenance();
    add('model weights', prov?.modelId ?? 'unknown');
    add('inference pipeline', prov?.inferencePipeline ?? 'unknown');
    add('image scale', prov?.scaleMode ?? 'unknown');
    add('CLAHE', prov?.applyClahe ? `on (clip ${prov.claheClipLimit ?? 2})` : 'off');
    add('fine-grain enlargement', prov?.fineGrainUpscale ?? 'off');
    add('post-processing', prov?.postProcess ?? 'unknown');
    const steps = photoProcessingHistory(p.metadata).map((x) => (x.step === 'enhancement' ? x.modelId : 'rectification'));
    add('image enhancement / rectification', steps.length > 0 ? steps.join(' + ') : 'none');
  }
  const out: Record<string, string> = {};
  for (const [k, set] of values) out[k] = [...set].sort().join(' | ');
  return out;
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
  const run = (opts: SiteAnalysisOptions): ComparedSite[] =>
    sites.map((s, i) => {
      const color = s.color ?? COMPARE_COLORS[i % COMPARE_COLORS.length]!;
      const { date, source: dateSource } = siteSurveyDate(s.surveyDate, s.inputs.map((p) => p.metadata?.timestamp));
      const place = s.place?.trim() ? s.place.trim() : null;
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
  /** Two-sided p-value of the approximate log-ratio z-test. */
  p: number;
}

type WithReport = ComparedSite & { report: SiteAnalysisReport };

/** Log-scale standard error of a percentile from its bootstrap CI. */
function logSe(r: SiteAnalysisReport, key: ComparedPercentile): number {
  const lo = r.bootstrapCi.lower[key];
  const hi = r.bootstrapCi.upper[key];
  return lo > 0 && hi > lo ? (Math.log(hi) - Math.log(lo)) / (2 * zFor(r.bootstrapCi.confidenceLevel)) : Number.NaN;
}

function comparePair(A: WithReport, B: WithReport, key: ComparedPercentile): D50Comparison {
  const lr = Math.log(A.report.psd[key] / B.report.psd[key]);
  const s = Math.hypot(logSe(A.report, key), logSe(B.report, key));
  const z95 = zFor(0.95);
  return {
    a: A.name,
    b: B.name,
    key,
    ratio: Math.exp(lr),
    ratioLo: Math.exp(lr - z95 * s),
    ratioHi: Math.exp(lr + z95 * s),
    p: Number.isFinite(s) && s > 0 ? 2 * (1 - normalCdf(Math.abs(lr / s))) : Number.NaN,
  };
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
  return out;
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
      lines.push(`${sec},${pair},ratio_ci95_lo,${c.ratioLo},ratio`);
      lines.push(`${sec},${pair},ratio_ci95_hi,${c.ratioHi},ratio`);
      lines.push(`${sec},${pair},p_value_approx,${Number.isFinite(c.p) ? c.p : ''},p`);
    }
  }
  for (const ch of surveyChanges(sites)) {
    const label = csvCell(`${ch.place}: ${ch.fromDate} -> ${ch.toDate}`);
    for (const key of ['D16', 'D50', 'D84'] as const) {
      const c = ch.changes[key];
      lines.push(`survey_change,${label},${key}_ratio_later_over_earlier,${c.ratio},ratio`);
      lines.push(`survey_change,${label},${key}_ratio_ci95_lo,${c.ratioLo},ratio`);
      lines.push(`survey_change,${label},${key}_ratio_ci95_hi,${c.ratioHi},ratio`);
      lines.push(`survey_change,${label},${key}_p_value_approx,${Number.isFinite(c.p) ? c.p : ''},p`);
    }
  }
  settingsMismatches(sites).forEach((w, i) => lines.push(`warning,${i + 1},${csvCell(w)},text`));
  return lines.join('\n');
}
