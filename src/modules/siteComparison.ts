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
}

/** Site reports for each site, computed with the same options. */
export function computeComparedSites(sites: readonly SiteForComparison[], options: SiteAnalysisOptions): ComparedSite[] {
  return sites.map((s, i) => {
    const color = s.color ?? COMPARE_COLORS[i % COMPARE_COLORS.length]!;
    const { date, source: dateSource } = siteSurveyDate(s.surveyDate, s.inputs.map((p) => p.metadata?.timestamp));
    const base = { siteId: s.siteId, name: s.name, color, date, dateSource };
    if (!s.inputs.some((p) => p.included)) {
      return { ...base, report: null, error: 'No analysed photos' };
    }
    try {
      return { ...base, report: analyzeSite(s.inputs, options), error: null };
    } catch (err) {
      return { ...base, report: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

const zFor = (level: number): number => (level >= 0.95 ? 1.959963984540054 : 1.6448536269514722);

export interface D50Comparison {
  a: string;
  b: string;
  /** D50 of a divided by D50 of b. */
  ratio: number;
  ratioLo: number;
  ratioHi: number;
  /** Two-sided p-value of the approximate log-ratio z-test. */
  p: number;
}

/**
 * Approximate pairwise D50 ratios (95% CI) and p-values between sites with reports. Only
 * like-for-like pairs are compared: a site reported in px is never divided by one in mm
 * (or measured with another size metric).
 */
export function compareD50(sites: readonly ComparedSite[]): D50Comparison[] {
  const ok = sites.filter((s) => s.report !== null && s.report.psd.D50 > 0) as Array<ComparedSite & { report: SiteAnalysisReport }>;
  const se = (r: SiteAnalysisReport): number => {
    const lo = r.bootstrapCi.lower.D50;
    const hi = r.bootstrapCi.upper.D50;
    return lo > 0 && hi > lo ? (Math.log(hi) - Math.log(lo)) / (2 * zFor(r.bootstrapCi.confidenceLevel)) : Number.NaN;
  };
  const out: D50Comparison[] = [];
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      const A = ok[i]!;
      const B = ok[j]!;
      if (A.report.unit !== B.report.unit || A.report.sizeMetric !== B.report.sizeMetric) continue;
      const lr = Math.log(A.report.psd.D50 / B.report.psd.D50);
      const s = Math.hypot(se(A.report), se(B.report));
      const z95 = zFor(0.95);
      out.push({
        a: A.name,
        b: B.name,
        ratio: Math.exp(lr),
        ratioLo: Math.exp(lr - z95 * s),
        ratioHi: Math.exp(lr + z95 * s),
        p: Number.isFinite(s) && s > 0 ? 2 * (1 - normalCdf(Math.abs(lr / s))) : Number.NaN,
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
      ['D16', r.psd.D16, u],
      ['D50', r.psd.D50, u],
      ['D50_ci_lo', r.bootstrapCi.lower.D50, u],
      ['D50_ci_hi', r.bootstrapCi.upper.D50, u],
      ['D84', r.psd.D84, u],
      ['geometric_mean_Dg', r.extra?.geometricMean, u],
      ['geometric_sd_sigma_g', r.extra?.geometricSd, 'ratio'],
      ['sauter_mean_D32', r.extra?.sauterMeanD32, u],
      ['folk_ward_sorting', r.folkWard?.sortingPhi, 'phi'],
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
  for (const c of compareD50(sites)) {
    const pair = csvCell(`${c.a} vs ${c.b}`);
    lines.push(`d50_ratio,${pair},ratio,${c.ratio},ratio`);
    lines.push(`d50_ratio,${pair},ratio_ci95_lo,${c.ratioLo},ratio`);
    lines.push(`d50_ratio,${pair},ratio_ci95_hi,${c.ratioHi},ratio`);
    lines.push(`d50_ratio,${pair},p_value_approx,${Number.isFinite(c.p) ? c.p : ''},p`);
  }
  return lines.join('\n');
}
