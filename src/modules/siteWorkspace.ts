/**
 * Turns the app's photos, analysis sessions and site options into the inputs and reports
 * shown on the dashboard. No UI code: the UI calls these and renders the results.
 */
import type { SedimentStatsReport, SizeMetric } from '../types/index.js';
import type { AnalysisSession } from './pipelineController.js';
import type { PhotoRecord } from './projectStorage.js';
import type { RoiExclusionConfig } from './roiAndRectify.js';
import {
  analyzeSite,
  withExclusionTolerance,
  type SiteAnalysisOptions,
  type SiteAnalysisReport,
  type SitePhotoInput,
} from './siteAnalysis.js';

/** A photo's ROI config with the site-wide exclusion overlap tolerance applied. */
export function effectiveRoi(
  photo: Pick<PhotoRecord, 'roiConfig'> | undefined,
  siteOptions: Pick<SiteAnalysisOptions, 'maxExcludedFraction'>,
): RoiExclusionConfig | undefined {
  return photo?.roiConfig !== undefined
    ? withExclusionTolerance(photo.roiConfig, siteOptions.maxExcludedFraction)
    : undefined;
}

/** One site-analysis input per analysed photo (with its effective ROI, facies weight, metadata). */
export function buildSiteInputs(workspace: {
  photos: readonly PhotoRecord[];
  sessions: ReadonlyMap<string, AnalysisSession>;
  siteOptions: Pick<SiteAnalysisOptions, 'maxExcludedFraction'>;
}): SitePhotoInput[] {
  const inputs: SitePhotoInput[] = [];
  for (const photo of workspace.photos) {
    const session = workspace.sessions.get(photo.photoId);
    if (!session) continue;
    inputs.push({
      photoId: photo.photoId,
      label: photo.label,
      included: photo.included,
      session,
      ...(photo.roiConfig !== undefined ? { roiConfig: effectiveRoi(photo, workspace.siteOptions)! } : {}),
      ...(photo.faciesWeight !== undefined ? { faciesWeight: photo.faciesWeight } : {}),
      ...(photo.metadata !== undefined ? { metadata: photo.metadata } : {}),
    });
  }
  return inputs;
}

/**
 * Size cutoffs for one photo's statistics, grain table and charts. Inside a site, a photo that
 * counts in the site report uses the site's common mm cutoff (the coarsest photo's detection
 * limit, or the field-count cutoff if larger), so the photo's own D-values, its
 * `included_in_stats` column and the site's per-photo breakdown always describe the same grains.
 * Without a site report (or for a photo left out of it) the photo-level cutoffs apply.
 */
export function photoCutoffs(
  siteOptions: Pick<SiteAnalysisOptions, 'minBaxisPx' | 'minSizeMm'> | undefined,
  siteReport: Pick<SiteAnalysisReport, 'dCutoffCommonMm' | 'perPhoto'> | null | undefined,
  photoId: string | null | undefined,
): { minBaxisPx: number; minSizeMm: number } {
  const minBaxisPx = siteOptions?.minBaxisPx ?? 15;
  let minSizeMm = siteOptions?.minSizeMm ?? 0;
  if (
    siteReport &&
    siteReport.dCutoffCommonMm !== null &&
    photoId &&
    siteReport.perPhoto.some((p) => p.photoId === photoId)
  ) {
    minSizeMm = Math.max(minSizeMm, siteReport.dCutoffCommonMm);
  }
  return { minBaxisPx, minSizeMm };
}

export interface WorkspaceReports {
  singlePhotoStats: SedimentStatsReport | null;
  siteReport: SiteAnalysisReport | null;
  /** Why the site report could not be computed (e.g. mixed calibration), if so. */
  siteReportError: string | null;
}

/** Statistics for the active photo and the pooled site report. */
export function computeWorkspaceReports(workspace: {
  photos: readonly PhotoRecord[];
  sessions: ReadonlyMap<string, AnalysisSession>;
  activePhotoId: string | null;
  siteOptions: SiteAnalysisOptions;
}): WorkspaceReports {
  const activeSession = workspace.activePhotoId !== null ? workspace.sessions.get(workspace.activePhotoId) ?? null : null;
  const metric: SizeMetric = workspace.siteOptions.sizeMetric ?? 'bAxis';
  const siteInputs = buildSiteInputs(workspace);
  let siteReport: SiteAnalysisReport | null = null;
  let siteReportError: string | null = null;
  if (siteInputs.some((p) => p.included)) {
    try {
      siteReport = analyzeSite(siteInputs, workspace.siteOptions);
    } catch (err) {
      siteReportError = err instanceof Error ? err.message : String(err);
    }
  }
  const singlePhotoStats = activeSession
    ? activeSession.getStats(metric, photoCutoffs(workspace.siteOptions, siteReport, workspace.activePhotoId))
    : null;
  return { singlePhotoStats, siteReport, siteReportError };
}
