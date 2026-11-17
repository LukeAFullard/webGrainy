/**
 * Grain orientation conventions (one place, so the overlay and the measurements agree).
 *
 * `orientationRad` follows skimage `regionprops.orientation`: the angle between the image's
 * row axis (y, pointing down) and the major axis, in [-π/2, π/2]. The major-axis direction
 * in image coordinates (x right, y down) is therefore (dx, dy) = (sin θ, cos θ).
 */

/** Orientation from central second moments (variance of x, variance of y, covariance). */
export function orientationFromMoments(varX: number, varY: number, covXY: number): number {
  if (varY === varX) {
    if (covXY === 0) return 0;
    return covXY > 0 ? Math.PI / 4 : -Math.PI / 4;
  }
  return 0.5 * Math.atan2(2 * covXY, varY - varX);
}

/** Unit vector (x right, y down) along the major axis. */
export function majorAxisDirection(orientationRad: number): { dx: number; dy: number } {
  return { dx: Math.sin(orientationRad), dy: Math.cos(orientationRad) };
}

/**
 * SVG `rotate()` angle (degrees, clockwise on screen because y points down) for an
 * `<ellipse>` whose `rx` is the semi-major axis. rotate(φ) maps the x axis to
 * (cos φ, sin φ), which must equal (sin θ, cos θ), so φ = 90° − θ.
 */
export function ellipseRotationDeg(orientationRad: number): number {
  return 90 - (orientationRad * 180) / Math.PI;
}
