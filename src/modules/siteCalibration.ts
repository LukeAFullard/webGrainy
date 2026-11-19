/**
 * Site calibration checks (can photos be pooled in mm?) and the site-wide ROI exclusion tolerance.
 * Split out of siteAnalysis.ts, which re-exports the public parts.
 */
import type { RoiExclusionConfig } from './roiAndRectify.js';
import type { SitePhotoInput, SiteAnalysisOptions, SiteCalibrationValidation } from './siteTypes.js';

/**
 * Validates calibration consistency across all included photos in a site.
 */
export function validateSiteCalibration(
  photos: readonly SitePhotoInput[],
  options?: Pick<SiteAnalysisOptions, 'poolingMode' | 'unit' | 'allowEqualPhotoFallback'>,
): SiteCalibrationValidation {
  const included = photos.filter((p) => p.included);
  if (included.length === 0) {
    return {
      valid: false,
      unit: 'px',
      calibratedPhotoIds: [],
      uncalibratedPhotoIds: [],
      warnings: ['No included photos available for site analysis.'],
      message: 'No included photos available for site analysis.',
    };
  }

  const calibratedPhotoIds: string[] = [];
  const uncalibratedPhotoIds: string[] = [];

  for (const p of included) {
    const cal = p.session.getCalibration();
    if (cal !== undefined && Number.isFinite(cal.mmPerPx) && cal.mmPerPx > 0) {
      calibratedPhotoIds.push(p.photoId);
    } else {
      uncalibratedPhotoIds.push(p.photoId);
    }
  }

  // Photo names (not internal IDs) for user-facing messages.
  const labelOf = new Map(included.map((p) => [p.photoId, p.label]));
  const names = (ids: readonly string[]): string => {
    const shown = ids.slice(0, 5).map((id) => labelOf.get(id) ?? id);
    return shown.join(', ') + (ids.length > 5 ? ` and ${ids.length - 5} more` : '');
  };
  const howTo =
    'Calibrate each photo with Scale → Calibrate (mark two points a known distance apart, e.g. the ends of a ruler), or, for photos taken with the same camera, zoom and height, calibrate one and use "Copy scale to photos…".';

  const requestedUnit = options?.unit;
  const allowFallback =
    options?.allowEqualPhotoFallback === true &&
    options?.poolingMode === 'equal-photo';

  if (uncalibratedPhotoIds.length === 0) {
    return {
      valid: true,
      unit: 'mm',
      calibratedPhotoIds,
      uncalibratedPhotoIds: [],
      warnings: [],
      message: 'All included photos are calibrated in mm.',
    };
  }

  if (calibratedPhotoIds.length === 0) {
    if (requestedUnit === 'px' || allowFallback) {
      return {
        valid: true,
        unit: 'px',
        calibratedPhotoIds: [],
        uncalibratedPhotoIds,
        warnings: [
          'Photos are uncalibrated; pooling in pixel units (physical mm metrics unavailable).',
        ],
        message: 'Uncalibrated pixel-unit pooling active.',
      };
    }
    return {
      valid: false,
      unit: 'uncalibrated',
      calibratedPhotoIds: [],
      uncalibratedPhotoIds,
      warnings: [],
      message: `No scale yet: ${uncalibratedPhotoIds.length === 1 ? '1 photo is' : `${uncalibratedPhotoIds.length} photos are`} not calibrated (${names(uncalibratedPhotoIds)}), so sizes cannot be given in mm. ${howTo}`,
    };
  }

  // Mixed calibration state
  if (requestedUnit === 'px' || allowFallback) {
    return {
      valid: true,
      unit: 'px',
      calibratedPhotoIds,
      uncalibratedPhotoIds,
      warnings: [
        `Mixed calibration detected (${uncalibratedPhotoIds.join(', ')} uncalibrated): using pixel/normalized fallback; results may be biased if camera heights differ.`,
      ],
      message: 'Mixed calibration bypassed via pixel/equal-photo fallback.',
    };
  }

  return {
    valid: false,
    unit: 'mixed',
    calibratedPhotoIds,
    uncalibratedPhotoIds,
    warnings: [],
    message: `Mixed calibration: ${uncalibratedPhotoIds.length} of ${included.length} photos have no scale yet (${names(uncalibratedPhotoIds)}). ${howTo} Or untick those photos to leave them out of the site results.`,
  };
}

/**
 * Applies a site-wide exclusion overlap tolerance to a photo's ROI config (when given and
 * valid). Returns the config unchanged otherwise.
 */
export function withExclusionTolerance(
  roi: RoiExclusionConfig,
  maxExcludedFraction: number | undefined,
): RoiExclusionConfig {
  if (
    maxExcludedFraction === undefined ||
    !Number.isFinite(maxExcludedFraction) ||
    maxExcludedFraction < 0 ||
    maxExcludedFraction > 1
  ) {
    return roi;
  }
  return { ...roi, maxExcludedFraction };
}
