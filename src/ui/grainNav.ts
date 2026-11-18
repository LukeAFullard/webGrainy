/**
 * Grain inspector navigation: previous / next grain, the largest grain, and the next
 * "flagged" grain worth checking (touches the photo edge, outside the ROI or in an excluded
 * area, or very elongated — often two stones merged or a stone cut by a shadow).
 */
import type { AnalysisSession } from '../modules/analysisSession.js';

export type GrainNavMode = 'prev' | 'next' | 'largest' | 'flagged';

export interface NavGrain {
  id: number;
  areaPx: number;
  touchesBorder: boolean;
  /** b/a of the grain (1 = round). */
  aspectRatio?: number;
  /** Outside the ROI or inside an excluded area. */
  excluded?: boolean;
}

/** Grains with b/a below this are flagged as unusually elongated. */
export const ELONGATED_ASPECT = 0.35;

/** Why a grain is worth checking (empty when it is not flagged). */
export function grainFlags(g: NavGrain): string[] {
  const out: string[] = [];
  if (g.touchesBorder) out.push('touches the photo edge');
  if (g.excluded) out.push('outside the ROI or in an excluded area');
  if (g.aspectRatio !== undefined && g.aspectRatio < ELONGATED_ASPECT) out.push(`very elongated (b/a ${g.aspectRatio.toFixed(2)})`);
  return out;
}

/**
 * The grain to show next, or null when there is none. Grains are visited in id order and the
 * order wraps around; with no current grain, "next" starts at the first and "prev" at the last.
 */
export function navigateGrains(grains: readonly NavGrain[], currentId: number | null, mode: GrainNavMode): NavGrain | null {
  if (grains.length === 0) return null;
  const sorted = [...grains].sort((a, b) => a.id - b.id);
  if (mode === 'largest') return sorted.reduce((best, g) => (g.areaPx > best.areaPx ? g : best), sorted[0]!);
  const idx = currentId === null ? -1 : sorted.findIndex((g) => g.id === currentId);
  const n = sorted.length;
  if (mode === 'prev') return sorted[idx === -1 ? n - 1 : (idx - 1 + n) % n]!;
  if (mode === 'next') return sorted[(idx + 1) % n]!;
  for (let k = 1; k <= n; k++) {
    const g = sorted[(idx + k + n) % n]!;
    if (grainFlags(g).length > 0) return g;
  }
  return null;
}

export function countFlagged(grains: readonly NavGrain[]): number {
  return grains.filter((g) => grainFlags(g).length > 0).length;
}

/** Navigation data for every grain of an analysed photo. */
export function navGrainsFor(session: Pick<AnalysisSession, 'getResult' | 'getExtendedGrains' | 'getRoiFilterResult'>): NavGrain[] {
  const aspect = new Map(session.getExtendedGrains().map((e) => [e.id, e.aspectRatio]));
  const excluded = session.getRoiFilterResult()?.excludedGrainIds;
  return session.getResult().grains.map((g) => ({
    id: g.id,
    areaPx: g.areaPx,
    touchesBorder: g.touchesBorder,
    ...(aspect.has(g.id) ? { aspectRatio: aspect.get(g.id)! } : {}),
    excluded: excluded?.has(g.id) ?? false,
  }));
}
