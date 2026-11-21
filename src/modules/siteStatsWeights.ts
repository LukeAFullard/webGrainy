/**
 * Each grain's weight in a site report's statistics (photo id -> grain id -> weight), kept
 * outside the report so the JSON export stays small. Pooling the counted grains with these
 * weights (`weightedPsdPercentiles`) reproduces the site percentiles exactly, in every pooling
 * mode; the pooled-grains CSV writes them as `stats_weight`.
 */
import type { SiteAnalysisReport } from './siteTypes.js';

const STATS_WEIGHTS = new WeakMap<SiteAnalysisReport, Map<string, Map<number, number>>>();

export function setStatsWeights(report: SiteAnalysisReport, weights: Map<string, Map<number, number>>): void {
  STATS_WEIGHTS.set(report, weights);
}

/** The weight of one grain in a report's statistics; undefined when it is not counted. */
export function grainStatsWeight(report: SiteAnalysisReport, photoId: string, grainId: number): number | undefined {
  return STATS_WEIGHTS.get(report)?.get(photoId)?.get(grainId);
}
