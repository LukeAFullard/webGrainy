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
