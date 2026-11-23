/**
 * What the Compare sites view shows, worked out once from the compared sites: the table order,
 * which sites can be plotted together, pairwise tests, change over time, like-for-like checks
 * and the chart series. Used by the panel (panels/compare.ts) and the printable comparison
 * report (compareReport.ts), so both always show the same thing.
 */
import { sizeHistogramFromWentworth, type SizeHistogram } from '../modules/histograms.js';
import {
  comparePercentile,
  comparisonWarnings,
  settingsMismatches,
  surveyChanges,
  type ComparedPercentile,
  type ComparedSite,
  type D50Comparison,
  type SurveyChange,
} from '../modules/siteComparison.js';
import type { SiteAnalysisReport } from '../modules/siteAnalysis.js';
import { orderByDate } from '../modules/surveyDate.js';
import type { TimeSeriesPoint } from './charts.js';

export type SiteWithReport = ComparedSite & { report: SiteAnalysisReport };

export const COMPARED_KEYS: readonly ComparedPercentile[] = ['D16', 'D50', 'D84'];

export interface ComparisonPair {
  a: string;
  b: string;
  aId: string;
  bId: string;
  /** The test for each percentile (undefined when that percentile could not be compared). */
  byKey: Partial<Record<ComparedPercentile, D50Comparison>>;
}

export interface ComparisonView {
  /** Sites in table order (by survey date when `byDate`). */
  ordered: ComparedSite[];
  withReport: SiteWithReport[];
  /** Calibrated and uncalibrated sites together: only the mm sites are plotted and tested. */
  mixedUnits: boolean;
  plotted: SiteWithReport[];
  unit: 'mm' | 'px';
  /** Confidence level header ("95%", or "per-site" when the sites differ). */
  ciHeader: string;
  /** Sites without results, or in px among mm sites. */
  problems: ComparedSite[];
  pairs: ComparisonPair[];
  changes: SurveyChange[];
  dated: SiteWithReport[];
  undated: SiteWithReport[];
  timePoints: TimeSeriesPoint[];
  /** Dated surveys with no place (shown as separate points). */
  ungroupedDated: number;
  testWarnings: string[];
  mismatches: string[];
  /** Common size cutoff applied to every site (mm), when the sites were harmonised. */
  commonCutoffMm: number | null;
  psdSeries: Array<{ name: string; color: string; psd: SiteAnalysisReport['psd']; ciLower: SiteAnalysisReport['bootstrapCi']['lower']; ciUpper: SiteAnalysisReport['bootstrapCi']['upper'] }>;
  histSeries: Array<{ name: string; color: string; hist: SizeHistogram }>;
  compSeries: Array<{ name: string; color: string; w: NonNullable<SiteAnalysisReport['wentworth']> }>;
  shapeSeries: Array<{ name: string; color: string; counts: readonly number[] }>;
  roses: SiteWithReport[];
}

/** Everything the Compare sites view and report show, from the compared sites. */
export function buildComparisonView(sites: readonly ComparedSite[], byDate: boolean, histogramStepPhi: 0.5 | 1): ComparisonView {
  const ordered = byDate ? (() => { const o = orderByDate(sites); return [...o.dated, ...o.undated]; })() : [...sites];
  const withReport = ordered.filter((s): s is SiteWithReport => s.report !== null);
  const units = new Set(withReport.map((s) => s.report.unit));
  const mixedUnits = units.size > 1;
  const plotted = mixedUnits ? withReport.filter((s) => s.report.unit === 'mm') : withReport;
  const unit = (plotted[0]?.report.unit ?? 'mm') as 'mm' | 'px';
  const levels = new Set(withReport.map((s) => Math.round(s.report.bootstrapCi.confidenceLevel * 100)));
  const ciHeader = levels.size === 1 ? `${[...levels][0]}%` : 'per-site';
  const problems = sites.filter((s) => s.report === null || (mixedUnits && s.report.unit !== 'mm'));

  // Pairwise tests: one row per pair of sites, matched by site id across D16 / D50 / D84.
  const pairs: ComparisonPair[] = [];
  const byIds = new Map<string, ComparisonPair>();
  for (const k of COMPARED_KEYS) {
    for (const c of comparePercentile(plotted, k)) {
      const id = `${c.aId}\u0000${c.bId}`;
      let row = byIds.get(id);
      if (!row) {
        row = { a: c.a, b: c.b, aId: c.aId, bId: c.bId, byKey: {} };
        byIds.set(id, row);
        pairs.push(row);
      }
      row.byKey[k] = c;
    }
  }
  // Order rows by the sites' order in the table.
  const pos = new Map(plotted.map((s, i) => [s.siteId, i]));
  pairs.sort((x, y) => (pos.get(x.aId)! - pos.get(y.aId)!) || (pos.get(x.bId)! - pos.get(y.bId)!));

  // Over time: one line per place; surveys without a place stand alone.
  const timeOrder = orderByDate(plotted);
  const placeColor = new Map<string, string>();
  for (const s of timeOrder.dated) if (s.place && !placeColor.has(s.place)) placeColor.set(s.place, s.color);
  const timePoints: TimeSeriesPoint[] = timeOrder.dated.map((s) => {
    const r = s.report;
    const ci = (k: ComparedPercentile): [number, number] => [r.bootstrapCi.lower[k], r.bootstrapCi.upper[k]];
    return {
      date: s.date!, name: s.name, color: s.color, D16: r.psd.D16, D50: r.psd.D50, D84: r.psd.D84,
      ci: { D16: ci('D16'), D50: ci('D50'), D84: ci('D84') },
      ...(s.place ? { group: s.place, groupColor: placeColor.get(s.place)! } : {}),
    };
  });

  const cutoffs = new Set(plotted.map((s) => s.report.dCutoffCommonMm).filter((c): c is number => c !== null && c > 0).map((c) => c.toFixed(3)));
  const commonCutoffMm = unit === 'mm' && plotted.length > 1 && cutoffs.size === 1 ? Number([...cutoffs][0]) : null;

  return {
    ordered,
    withReport,
    mixedUnits,
    plotted,
    unit,
    ciHeader,
    problems,
    pairs,
    changes: surveyChanges(plotted),
    dated: timeOrder.dated,
    undated: timeOrder.undated,
    timePoints,
    ungroupedDated: timeOrder.dated.filter((s) => !s.place).length,
    testWarnings: comparisonWarnings(plotted),
    mismatches: settingsMismatches(plotted),
    commonCutoffMm,
    psdSeries: plotted.map((s) => ({ name: s.name, color: s.color, psd: s.report.psd, ciLower: s.report.bootstrapCi.lower, ciUpper: s.report.bootstrapCi.upper })),
    histSeries: plotted.map((s) => ({
      name: s.name,
      color: s.color,
      hist: sizeHistogramFromWentworth((histogramStepPhi === 0.5 ? s.report.wentworthHistogram05Phi : s.report.wentworthHistogram10Phi) ?? [], histogramStepPhi),
    })),
    compSeries: plotted.filter((s) => s.report.wentworth !== null).map((s) => ({ name: s.name, color: s.color, w: s.report.wentworth! })),
    shapeSeries: plotted.filter((s) => s.report.shape.n > 0).map((s) => ({ name: s.name, color: s.color, counts: s.report.shape.aspectRatioCounts })),
    roses: plotted.filter((s) => s.report.fabricRose.grainCount > 0),
  };
}

/** Ratio text for a comparison (plain text, for the report and CSV-like uses). */
export function fmtPValue(p: number): string {
  return !Number.isFinite(p) ? '—' : p < 0.001 ? '< 0.001' : `= ${p.toFixed(3)}`;
}
