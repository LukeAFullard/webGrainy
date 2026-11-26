import type { CalibrationResult, GrainMorphometrics, Point2D } from '../types/index.js';

/**
 * Two-point spatial scale calibrator converting pixel coordinates + known
 * physical length (`mm` or `cm`) into `mmPerPx` and calibrated morphometrics.
 */
export class ScaleCalibrator {
  static calibrate(
    pointA: Point2D,
    pointB: Point2D,
    physicalLength: number,
    unit: 'mm' | 'cm' = 'mm',
  ): CalibrationResult {
    const pixelDistance = Math.hypot(pointB.x - pointA.x, pointB.y - pointA.y);
    if (!Number.isFinite(pixelDistance) || pixelDistance <= 0) {
      throw new Error('Reference points must have a positive pixel distance.');
    }
    if (!Number.isFinite(physicalLength) || physicalLength <= 0) {
      throw new Error('Physical length must be a positive finite number.');
    }

    const physicalLengthMm = unit === 'cm' ? physicalLength * 10 : physicalLength;
    const mmPerPx = physicalLengthMm / pixelDistance;

    return {
      mmPerPx,
      pointA: { x: pointA.x, y: pointA.y },
      pointB: { x: pointB.x, y: pointB.y },
      physicalLengthMm,
      pixelDistance,
    };
  }

  /**
   * A scale typed in by the user (e.g. a known mm/px from the camera set-up or survey report).
   * `mmPerPx` is per pixel of the photo as it is now. The two points are a synthetic span (as for
   * GeoTIFF scales) so the record has the same shape as a measured one.
   */
  static fromKnownScale(mmPerPx: number, photoWidthPx: number): CalibrationResult {
    if (!Number.isFinite(mmPerPx) || mmPerPx <= 0) {
      throw new Error('The scale must be a positive number.');
    }
    const spanPx = Math.min(100, Math.max(10, Math.round((Number.isFinite(photoWidthPx) ? photoWidthPx : 400) / 4)));
    return {
      mmPerPx,
      pointA: { x: 0, y: 0 },
      pointB: { x: spanPx, y: 0 },
      pixelDistance: spanPx,
      physicalLengthMm: spanPx * mmPerPx,
      source: 'entered',
    };
  }

  static scaleMorphometrics(
    grain: GrainMorphometrics,
    calibration: CalibrationResult | number,
  ): GrainMorphometrics {
    const mmPerPx = typeof calibration === 'number' ? calibration : calibration.mmPerPx;
    if (!Number.isFinite(mmPerPx) || mmPerPx <= 0) {
      throw new Error('Calibration mmPerPx must be a positive finite number.');
    }

    return {
      ...grain,
      bbox: [grain.bbox[0], grain.bbox[1], grain.bbox[2], grain.bbox[3]],
      areaMm2: grain.areaPx * mmPerPx * mmPerPx,
      aAxisMm: grain.aAxisPx * mmPerPx,
      bAxisMm: grain.bAxisPx * mmPerPx,
      dEqMm: grain.dEqPx * mmPerPx,
      ...(grain.minFeretPx !== undefined ? { minFeretMm: grain.minFeretPx * mmPerPx } : {}),
      ...(grain.maxFeretPx !== undefined ? { maxFeretMm: grain.maxFeretPx * mmPerPx } : {}),
    };
  }

  static scaleAllMorphometrics(
    grains: readonly GrainMorphometrics[],
    calibration: CalibrationResult | number,
  ): GrainMorphometrics[] {
    return grains.map((g) => ScaleCalibrator.scaleMorphometrics(g, calibration));
  }

  calibrate(
    pointA: Point2D,
    pointB: Point2D,
    physicalLength: number,
    unit: 'mm' | 'cm' = 'mm',
  ): CalibrationResult {
    return ScaleCalibrator.calibrate(pointA, pointB, physicalLength, unit);
  }

  scaleMorphometrics(
    grain: GrainMorphometrics,
    calibration: CalibrationResult | number,
  ): GrainMorphometrics {
    return ScaleCalibrator.scaleMorphometrics(grain, calibration);
  }

  scaleAllMorphometrics(
    grains: readonly GrainMorphometrics[],
    calibration: CalibrationResult | number,
  ): GrainMorphometrics[] {
    return ScaleCalibrator.scaleAllMorphometrics(grains, calibration);
  }
}
