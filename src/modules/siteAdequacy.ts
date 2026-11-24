/**
 * Sample adequacy rating, largest-clast check, per-photo breakdown and outlier photos.
 * Split out of siteAnalysis.ts, which re-exports the public parts.
 */
import { computePsdPercentiles } from './sedimentStats.js';
import { type PreparedPhoto, median, buildPooledArrays } from './sitePooling.js';
import type { PoolingMode, SampleAdequacyRating, PerPhotoSiteBreakdown } from './siteTypes.js';

const RATING_ORDER: readonly SampleAdequacyRating[] = ['Insufficient', 'Minimal', 'Adequate', 'High Precision'];

/** Best rating a site of `nPhotos` photos can get: 1 photo Minimal, 2-4 Adequate, 5+ any. */
export function maxRatingForPhotos(nPhotos: number): SampleAdequacyRating {
  if (nPhotos <= 1) return 'Minimal';
  if (nPhotos < 5) return 'Adequate';
  return 'High Precision';
}

/**
 * Note shown next to a rating that the photo count capped (1 photo: at most Minimal; 2-4: at most
 * Adequate), so a high grain count is not read as enough data. Empty when not capped.
 */
export function adequacyCapNote(limitedByPhotoCount: boolean, nPhotos: number): string {
  if (!limitedByPhotoCount) return '';
  return `capped: ${nPhotos} photo${nPhotos === 1 ? '' : 's'} (5 or more needed for a higher rating)`;
}

/** Sample adequacy rating and the largest-clast check (adds a warning when it is large). */
export function assessSampleAdequacy(
  preparedPhotos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  warnings: string[],
  pooledWeights?: readonly number[],
): {
  validGrainCount: number;
  effectiveGrainCount: number;
  rating: SampleAdequacyRating;
  limitedByPhotoCount: boolean;
  largestClastAreaRatio: number;
  largestClastWarning: 'none' | 'moderate' | 'critical';
} {
  const validGrainCount = preparedPhotos.reduce((s, p) => s + p.validGrains.length, 0);
  const totalGridHits = preparedPhotos.reduce((s, p) => s + p.gridGrainHits, 0);
  let effectiveGrainCount: number;
  if (poolingMode === 'virtual-wolman-grid') {
    effectiveGrainCount = totalGridHits;
  } else if (poolingMode === 'number-weighted') {
    effectiveGrainCount = validGrainCount;
  } else {
    const weights = pooledWeights ?? buildPooledArrays(preparedPhotos, poolingMode).weights;
    let sumW = 0;
    let sumW2 = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      if (w !== undefined && Number.isFinite(w) && w > 0) {
        sumW += w;
        sumW2 += w * w;
      }
    }
    effectiveGrainCount =
      sumW > 0 && sumW2 > 0 ? Math.max(1, Math.round((sumW * sumW) / sumW2)) : 0;
  }

  const byGrains: SampleAdequacyRating =
    effectiveGrainCount < 100
      ? 'Insufficient'
      : effectiveGrainCount < 200
        ? 'Minimal'
        : effectiveGrainCount < 400
          ? 'Adequate'
          : 'High Precision';
  // Many grains from few photos still say little about patch-to-patch variation of the bed
  // (2 photos x 1000 grains rated "High Precision" while their 95% intervals covered the truth
  // about half the time in simulation). Cap the rating by the number of photos.
  const cap = maxRatingForPhotos(preparedPhotos.length);
  const limitedByPhotoCount = RATING_ORDER.indexOf(byGrains) > RATING_ORDER.indexOf(cap);
  const rating: SampleAdequacyRating = limitedByPhotoCount ? cap : byGrains;

  let maxArea = 0;
  let sumArea = 0;
  for (const p of preparedPhotos) {
    for (const vg of p.validGrains) {
      if (vg.areaVal > maxArea) maxArea = vg.areaVal;
      sumArea += vg.areaVal;
    }
  }
  const largestClastAreaRatio = sumArea > 0 ? maxArea / sumArea : 0;
  const largestClastWarning: 'none' | 'moderate' | 'critical' =
    largestClastAreaRatio > 0.1
      ? 'critical'
      : largestClastAreaRatio > 0.05
        ? 'moderate'
        : 'none';

  if (largestClastWarning === 'critical') {
    warnings.push(
      `Largest clast accounts for ${(largestClastAreaRatio * 100).toFixed(1)}% (> 10%) of total grain area.`,
    );
  } else if (largestClastWarning === 'moderate') {
    warnings.push(
      `Largest clast accounts for ${(largestClastAreaRatio * 100).toFixed(1)}% (> 5%) of total grain area.`,
    );
  }

  return { validGrainCount, effectiveGrainCount, rating, limitedByPhotoCount, largestClastAreaRatio, largestClastWarning };
}

/** Per-photo breakdown (counts, packing, D16/D50/D84, weight) and outlier photo flags. */
export function buildPerPhotoBreakdown(
  preparedPhotos: readonly PreparedPhoto[],
  poolingMode: PoolingMode,
  d50WithoutMap: ReadonlyMap<string, number>,
  photoWeightsPct: readonly number[],
): {
  outlierPhotos: Array<{ photoId: string; label: string; reasons: string[] }>;
  perPhoto: PerPhotoSiteBreakdown[];
} {
  const mmPerPxList = preparedPhotos
    .map((p) => p.mmPerPx)
    .filter((v): v is number => v !== undefined && v > 0);
  const medianMmPerPx = median(mmPerPxList);

  const outlierPhotos: Array<{
    photoId: string;
    label: string;
    reasons: string[];
  }> = [];
  const perPhoto: PerPhotoSiteBreakdown[] = [];

  for (let i = 0; i < preparedPhotos.length; i++) {
    const p = preparedPhotos[i];
    if (p === undefined) continue;
    const pPool = buildPooledArrays([p], poolingMode);
    const pPsd = computePsdPercentiles(pPool.values, pPool.weights);

    const reasons: string[] = [];
    if (p.validGrains.length < 15) {
      reasons.push(`Low grain count (${p.validGrains.length} < 15)`);
    }
    const d50Without = d50WithoutMap.get(p.input.photoId);
    if (
      d50Without !== undefined &&
      d50Without > 0 &&
      pPsd.D50 > 0 &&
      Math.abs(Math.log2(pPsd.D50 / d50Without)) > 1.0
    ) {
      reasons.push('D50 deviates > 1.0 phi (2x) from rest of site');
    }
    if (
      p.mmPerPx !== undefined &&
      Number.isFinite(medianMmPerPx) &&
      medianMmPerPx > 0 &&
      (p.mmPerPx > 3 * medianMmPerPx || p.mmPerPx < medianMmPerPx / 3)
    ) {
      reasons.push('Scale mmPerPx deviates > 3x from site median');
    }

    if (reasons.length > 0) {
      outlierPhotos.push({
        photoId: p.input.photoId,
        label: p.input.label,
        reasons,
      });
    }

    perPhoto.push({
      photoId: p.input.photoId,
      label: p.input.label,
      included: true,
      ...(p.mmPerPx !== undefined ? { mmPerPx: p.mmPerPx } : {}),
      rawGrainCount: p.rawGrainCount,
      validGrainCount: p.validGrains.length,
      excludedTruncationCount: p.excludedTruncationCount,
      sampledBedAreaPx: p.sampledBedAreaPx,
      ...(p.sampledBedAreaMm2 !== undefined
        ? { sampledBedAreaMm2: p.sampledBedAreaMm2 }
        : {}),
      clastPackingPct: p.clastPackingPct,
      exposedMatrixPct: p.exposedMatrixPct,
      gridGrainHits: p.gridGrainHits,
      gridMatrixHits: p.gridMatrixHits,
      gridSubCutoffHits: p.gridSubCutoffHits,
      D16: pPsd.D16,
      D50: pPsd.D50,
      D84: pPsd.D84,
      weightContributionPct: photoWeightsPct[i] ?? 0,
      detectionLimitPx: p.detectionLimitPx,
      outlierReasons: reasons,
    });
  }

  return { outlierPhotos, perPhoto };
}
