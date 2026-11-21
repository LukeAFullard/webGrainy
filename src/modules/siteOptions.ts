/**
 * Validation of site statistics settings that come from outside the running app: a saved site
 * in browser storage or an imported .webgrainy project. Such options are untrusted: an
 * unbounded repeat count or grid size would freeze the page each time the site opens (the site
 * report is computed when a site is opened), and an unknown value would silently change the
 * statistics. Every field is checked against the values the app itself can set; anything else
 * is dropped, so the documented default applies.
 */
import type { SizeMetric } from '../types/index.js';
import type { PoolingMode, SiteAnalysisOptions } from './siteTypes.js';

const POOLING_MODES: readonly PoolingMode[] = ['physical-area', 'equal-photo', 'virtual-wolman-grid', 'number-weighted', 'facies-weighted'];
const SIZE_METRICS: readonly SizeMetric[] = ['bAxis', 'dEq', 'minFeret'];

/** Ranges accepted for numeric site options (the app's own inputs stay well inside them). */
export const SITE_OPTION_LIMITS = {
  minBaxisPx: [0, 1000],
  minSizeMm: [0, 10_000],
  maxExcludedFraction: [0, 1],
  bootstrapReplicates: [50, 5000],
  wolmanPointsPerPhoto: [1, 10_000],
  wolmanGridSpacingMm: [0.01, 100_000],
} as const satisfies Record<string, readonly [number, number]>;

const inRange = (v: unknown, [lo, hi]: readonly [number, number]): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Site options with every field validated: known enum values, booleans, and numbers in
 * `SITE_OPTION_LIMITS` (replicates and grid points rounded to whole numbers). Invalid or unknown
 * fields are removed. `poolingMode` falls back to 'physical-area'.
 */
export function sanitizeSiteOptions(raw: unknown): SiteAnalysisOptions {
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: SiteAnalysisOptions = {
    poolingMode: POOLING_MODES.includes(o['poolingMode'] as PoolingMode) ? (o['poolingMode'] as PoolingMode) : 'physical-area',
  };
  if (o['unit'] === 'mm' || o['unit'] === 'px') out.unit = o['unit'];
  if (SIZE_METRICS.includes(o['sizeMetric'] as SizeMetric)) out.sizeMetric = o['sizeMetric'] as SizeMetric;
  if (o['confidenceLevel'] === 0.9 || o['confidenceLevel'] === 0.95) out.confidenceLevel = o['confidenceLevel'];
  for (const k of ['allowEqualPhotoFallback', 'harmonizeCutoff', 'harmonizePhysicalCutoff', 'bootstrapTwoStage'] as const) {
    if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  }
  if (inRange(o['minBaxisPx'], SITE_OPTION_LIMITS.minBaxisPx)) out.minBaxisPx = o['minBaxisPx'];
  if (inRange(o['minSizeMm'], SITE_OPTION_LIMITS.minSizeMm)) out.minSizeMm = o['minSizeMm'];
  if (inRange(o['maxExcludedFraction'], SITE_OPTION_LIMITS.maxExcludedFraction)) out.maxExcludedFraction = o['maxExcludedFraction'];
  if (inRange(o['bootstrapReplicates'], SITE_OPTION_LIMITS.bootstrapReplicates)) out.bootstrapReplicates = Math.round(o['bootstrapReplicates']);
  if (inRange(o['wolmanPointsPerPhoto'], SITE_OPTION_LIMITS.wolmanPointsPerPhoto)) out.wolmanPointsPerPhoto = Math.round(o['wolmanPointsPerPhoto']);
  if (inRange(o['wolmanGridSpacingMm'], SITE_OPTION_LIMITS.wolmanGridSpacingMm)) out.wolmanGridSpacingMm = o['wolmanGridSpacingMm'];
  const seed = o['bootstrapSeed'];
  if (typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) out.bootstrapSeed = seed;
  return out;
}

/** A record time from outside the app, kept within [0, now] (a future date would pin the site first and keep it forever). */
export function clampRecordTime(t: unknown, now = Date.now()): number {
  return typeof t === 'number' && Number.isFinite(t) ? Math.min(now, Math.max(0, t)) : now;
}
