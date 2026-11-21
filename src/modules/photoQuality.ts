/**
 * Pure, zero-DOM photo-quality checks and effective detection-limit helpers.
 *
 * - `computeBlurScoreFromRgba`: variance of the 4-neighbor discrete Laplacian on luminance.
 * - `getPhotoQualityWarnings`: flags action cameras, ultra-wide lenses, and soft/blurred frames.
 * - `computeEffectiveDetectionLimit`: translates working-resolution `minSize` (and optional
 *   `minBaxisPx`) into the physical minimum resolvable grain diameter in mm or px.
 */
import type { PsdPercentiles } from '../types/index.js';
import { detectionLimitPx } from './grainSize.js';
import type { SitePhotoMetadata } from './siteTypes.js';

/** Conservative Laplacian-variance floor below which a gravel photo is likely out-of-focus or motion-blurred. */
export const BLUR_WARNING_THRESHOLD = 60;

/** 35 mm-equivalent focal length below which barrel distortion is typically significant without undistortion. */
export const WIDE_ANGLE_FOCAL_LENGTH_35MM = 20;

const ACTION_CAMERA_RE = /\b(gopro|hero\s*\d+|osmo\s*action|insta360|sjcam|akaso)\b/i;

export interface PhotoQualityWarning {
  kind: 'blur' | 'wide-angle';
  shortLabel: string;
  message: string;
}

/**
 * Computes the variance of the 4-neighbor discrete Laplacian over grayscale luminance
 * (`0..255`). Sharp gravel textures typically score 300–3000+; heavily blurred or
 * out-of-focus frames typically score well below 60.
 */
export function computeBlurScoreFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3 || rgba.length < width * height * 4) return 0;

  const n = width * height;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = 0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!;
  }

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      const lap =
        4 * gray[idx]! -
        gray[idx - 1]! -
        gray[idx + 1]! -
        gray[idx - width]! -
        gray[idx + width]!;
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

/** Returns user-facing photo-quality warnings derived from EXIF and local blur check. */
export function getPhotoQualityWarnings(meta?: SitePhotoMetadata): PhotoQualityWarning[] {
  if (!meta) return [];
  const warnings: PhotoQualityWarning[] = [];

  const cameraLabel = [meta.cameraMake, meta.cameraModel].filter(Boolean).join(' ').trim();
  const isActionCam = cameraLabel.length > 0 && ACTION_CAMERA_RE.test(cameraLabel);
  const isUltraWide =
    typeof meta.focalLength35mm === 'number' &&
    Number.isFinite(meta.focalLength35mm) &&
    meta.focalLength35mm > 0 &&
    meta.focalLength35mm < WIDE_ANGLE_FOCAL_LENGTH_35MM;

  if (isActionCam || isUltraWide) {
    const detail = isActionCam
      ? cameraLabel
      : `${Math.round(meta.focalLength35mm!)} mm equiv. lens`;
    warnings.push({
      kind: 'wide-angle',
      shortLabel: 'wide lens',
      message: `Wide-angle or action camera detected (${detail}) — lens distortion can bias grain sizes; pre-undistort before analysing if possible.`,
    });
  }

  if (
    typeof meta.blurScore === 'number' &&
    Number.isFinite(meta.blurScore) &&
    meta.blurScore < BLUR_WARNING_THRESHOLD
  ) {
    warnings.push({
      kind: 'blur',
      shortLabel: 'soft/blur',
      message: `Photo looks soft or motion-blurred (sharpness score ${Math.round(meta.blurScore)}) — inspect grain outlines carefully.`,
    });
  }

  return warnings;
}

export interface DetectionLimitInput {
  /** Minimum grain area in working-resolution pixels (default 30). */
  minSizeWorkingPx?: number;
  /** Working-image scale factor (`workingWidth / originalWidth`, default 1). */
  effectiveScaleFactor?: number;
  /** Optional minimum b-axis filter in original pixels. */
  minBaxisPx?: number;
  /** Calibration scale in mm/px (omit for uncalibrated pixel units). */
  mmPerPx?: number;
}

export interface DetectionLimitResult {
  value: number;
  unit: 'mm' | 'px';
  nearD5: boolean;
  nearD16: boolean;
}

/**
 * Estimates the minimum resolvable grain diameter from the segmentation area floor
 * (`minSizeWorkingPx`, converted via equal-area diameter and `effectiveScaleFactor`)
 * and optional `minBaxisPx`, in `mm` when calibrated or `px` otherwise.
 */
export function computeEffectiveDetectionLimit(
  input: DetectionLimitInput,
  psd?: PsdPercentiles,
): DetectionLimitResult | null {
  const minArea = input.minSizeWorkingPx ?? 30;
  const scale = input.effectiveScaleFactor ?? 1;
  if (!Number.isFinite(minArea) || minArea <= 0 || !Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const minPx = detectionLimitPx(minArea, scale, input.minBaxisPx ?? 0);

  const hasScale = typeof input.mmPerPx === 'number' && Number.isFinite(input.mmPerPx) && input.mmPerPx > 0;
  const value = hasScale ? minPx * input.mmPerPx! : minPx;
  const unit: 'mm' | 'px' = hasScale ? 'mm' : 'px';

  const nearD5 = psd !== undefined && Number.isFinite(psd.D5) && psd.D5 > 0 && psd.D5 <= value * 1.25;
  const nearD16 = psd !== undefined && Number.isFinite(psd.D16) && psd.D16 > 0 && psd.D16 <= value * 1.5;

  return { value, unit, nearD5, nearD16 };
}
