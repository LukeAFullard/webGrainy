/**
 * Projected map coordinates to longitude / latitude, for GeoJSON that web maps can place
 * (RFC 7946 allows only WGS84 longitude / latitude). Offline: the CRS parameters come from a
 * table generated from the EPSG database (crsTable.ts), covering Transverse Mercator (incl. all
 * UTM zones, national grids such as NZTM) and Lambert Conformal Conic (e.g. US State Plane)
 * on the GRS 1980 and WGS 84 ellipsoids, kept only where the datum is within about a metre of
 * WGS84 at the centre of the CRS's area of use (checked with PROJ). No datum shift is applied.
 *
 * Transverse Mercator: Krueger series to n^6 (Karney 2011), sub-millimetre within a zone.
 * Lambert Conformal Conic: Snyder (1987), ellipsoidal, iterated to 1e-12 rad.
 */
import { CRS_GEOGRAPHIC_NEAR_WGS84, CRS_TABLE, CRS_TABLE_ELLIPSOIDS } from './crsTable.js';

type LonLat = [number, number];
const D = Math.PI / 180;

function ellipsoid(idx: number): { a: number; f: number } {
  const [a, invF] = CRS_TABLE_ELLIPSOIDS[idx]!;
  return { a, f: 1 / invF };
}

/** Inverse Transverse Mercator (EPSG method 9807). */
export function tmInverse(
  e0: number,
  n0: number,
  p: { a: number; f: number; lat0: number; lon0: number; k0: number; fe: number; fn: number },
): LonLat {
  const { a, f, k0 } = p;
  const n = f / (2 - f);
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const A = (a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const alpha = [
    n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
    (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
    (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
    (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
    (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
    (212378941 * n6) / 319334400,
  ];
  const beta = [
    n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360 - (81 * n5) / 512 + (96199 * n6) / 604800,
    n2 / 48 + n3 / 15 - (437 * n4) / 1440 + (46 * n5) / 105 - (1118711 * n6) / 3870720,
    (17 * n3) / 480 - (37 * n4) / 840 - (209 * n5) / 4480 + (5569 * n6) / 90720,
    (4397 * n4) / 161280 - (11 * n5) / 504 - (830251 * n6) / 7257600,
    (4583 * n5) / 161280 - (108847 * n6) / 3991680,
    (20648693 * n6) / 638668800,
  ];
  const e = Math.sqrt(f * (2 - f));
  // Conformal latitude tau' from tau = tan(phi).
  const tauPrime = (tau: number): number => {
    const s = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
    return tau * Math.sqrt(1 + s * s) - s * Math.sqrt(1 + tau * tau);
  };
  // Northing of the natural origin (latitude lat0 on the central meridian).
  const chi0 = Math.atan(tauPrime(Math.tan(p.lat0 * D)));
  let xi0 = chi0;
  for (let j = 1; j <= 6; j++) xi0 += alpha[j - 1]! * Math.sin(2 * j * chi0);
  const xi = (n0 - p.fn) / (k0 * A) + xi0;
  const eta = (e0 - p.fe) / (k0 * A);
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 6; j++) {
    xiP -= beta[j - 1]! * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= beta[j - 1]! * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const tP = Math.sin(xiP) / Math.sqrt(Math.sinh(etaP) ** 2 + Math.cos(xiP) ** 2);
  const lambda = Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  // Invert tau'(tau) = tP by Newton's method.
  const e2 = e * e;
  let tau = tP;
  for (let i = 0; i < 8; i++) {
    const ti = tauPrime(tau);
    const d = ((tP - ti) / Math.sqrt(1 + ti * ti)) * ((1 + (1 - e2) * tau * tau) / ((1 - e2) * Math.sqrt(1 + tau * tau)));
    tau += d;
    if (Math.abs(d) < 1e-14) break;
  }
  return [p.lon0 + lambda / D, Math.atan(tau) / D];
}

/** Inverse Lambert Conformal Conic (EPSG 9801 one standard parallel, 9802 two). */
export function lccInverse(
  e0: number,
  n0: number,
  p: { a: number; f: number; lat1: number; lat2: number; latOrigin: number; lon0: number; k0: number; fe: number; fn: number },
): LonLat {
  const e = Math.sqrt(p.f * (2 - p.f));
  const m = (phi: number): number => Math.cos(phi) / Math.sqrt(1 - (e * Math.sin(phi)) ** 2);
  const t = (phi: number): number => Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const p1 = p.lat1 * D, p2 = p.lat2 * D, pO = p.latOrigin * D;
  const n = Math.abs(p1 - p2) < 1e-12 ? Math.sin(p1) : (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * t(p1) ** n);
  const rho0 = p.a * F * p.k0 * t(pO) ** n;
  const x = e0 - p.fe;
  const y = rho0 - (n0 - p.fn);
  const s = Math.sign(n);
  const rho = s * Math.sqrt(x * x + y * y);
  const tt = (rho / (p.a * F * p.k0)) ** (1 / n);
  const theta = Math.atan2(s * x, s * y);
  let phi = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 15; i++) {
    const next = Math.PI / 2 - 2 * Math.atan(tt * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
    if (Math.abs(next - phi) < 1e-12) {
      phi = next;
      break;
    }
    phi = next;
  }
  return [p.lon0 + theta / n / D, phi / D];
}

/** Forward Transverse Mercator (EPSG method 9807): longitude / latitude to easting / northing. */
export function tmForward(
  lon: number,
  lat: number,
  p: { a: number; f: number; lat0: number; lon0: number; k0: number; fe: number; fn: number },
): [number, number] {
  const { a, f, k0 } = p;
  const n = f / (2 - f);
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const A = (a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const alpha = [
    n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
    (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
    (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
    (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
    (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
    (212378941 * n6) / 319334400,
  ];
  const e = Math.sqrt(f * (2 - f));
  const tauPrime = (tau: number): number => {
    const s = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
    return tau * Math.sqrt(1 + s * s) - s * Math.sqrt(1 + tau * tau);
  };
  const series = (xi: number, eta: number): [number, number] => {
    let x = xi;
    let y = eta;
    for (let j = 1; j <= 6; j++) {
      x += alpha[j - 1]! * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      y += alpha[j - 1]! * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    return [x, y];
  };
  let dl = (lon - p.lon0) * D;
  dl = Math.atan2(Math.sin(dl), Math.cos(dl));
  const tp = tauPrime(Math.tan(lat * D));
  const xiP = Math.atan2(tp, Math.cos(dl));
  const etaP = Math.asinh(Math.sin(dl) / Math.sqrt(tp * tp + Math.cos(dl) ** 2));
  const [xi, eta] = series(xiP, etaP);
  const [xi0] = series(Math.atan(tauPrime(Math.tan(p.lat0 * D))), 0);
  return [p.fe + k0 * A * eta, p.fn + k0 * A * (xi - xi0)];
}

/** Forward Lambert Conformal Conic (EPSG 9801 / 9802). */
export function lccForward(
  lon: number,
  lat: number,
  p: { a: number; f: number; lat1: number; lat2: number; latOrigin: number; lon0: number; k0: number; fe: number; fn: number },
): [number, number] {
  const e = Math.sqrt(p.f * (2 - p.f));
  const m = (phi: number): number => Math.cos(phi) / Math.sqrt(1 - (e * Math.sin(phi)) ** 2);
  const t = (phi: number): number => Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const p1 = p.lat1 * D, p2 = p.lat2 * D, pO = p.latOrigin * D;
  const n = Math.abs(p1 - p2) < 1e-12 ? Math.sin(p1) : (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * t(p1) ** n);
  const rho0 = p.a * F * p.k0 * t(pO) ** n;
  const rho = p.a * F * p.k0 * t(lat * D) ** n;
  let dl = (lon - p.lon0) * D;
  dl = Math.atan2(Math.sin(dl), Math.cos(dl));
  const theta = n * dl;
  return [p.fe + rho * Math.sin(theta), p.fn + rho0 - rho * Math.cos(theta)];
}

/** Web Mercator (spherical, EPSG:3857 and aliases) to longitude / latitude. */
function webMercatorInverse(x: number, y: number): LonLat {
  const R = 6378137;
  return [(x / R) / D, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / D];
}

const NEAR_WGS84_GEOGRAPHIC: ReadonlySet<number> = new Set(CRS_GEOGRAPHIC_NEAR_WGS84);
const WEB_MERCATOR: ReadonlySet<number> = new Set([3857, 3785, 900913, 102100, 102113]);

/** Longitude / latitude to Web Mercator (EPSG:3857) metres. */
export function webMercatorForward(lon: number, lat: number): [number, number] {
  const R = 6378137;
  return [R * lon * D, R * Math.log(Math.tan(Math.PI / 4 + (lat * D) / 2))];
}

/** Longitude in [-180, 180). */
const wrap = ([lon, lat]: LonLat): LonLat => [((((lon + 180) % 360) + 360) % 360) - 180, lat];

let index: Map<number, readonly number[]> | null = null;

/**
 * The inverse of lonLatProjector: WGS84 longitude / latitude to this CRS's map coordinates, or
 * null for the same CRSs lonLatProjector does not cover.
 */
export function projectedFromLonLat(epsg: number | null, kind: 'projected' | 'geographic' | 'unknown'): ((lon: number, lat: number) => [number, number]) | null {
  if (epsg === null) return null;
  if (NEAR_WGS84_GEOGRAPHIC.has(epsg)) return kind === 'projected' ? null : (lon, lat) => [lon, lat];
  if (kind === 'geographic') return null;
  if (WEB_MERCATOR.has(epsg)) return webMercatorForward;
  index ??= new Map(CRS_TABLE.map((r) => [r[0]!, r]));
  const r = index.get(epsg);
  if (!r) return null;
  const [, method, ell, unit, ...prm] = r as [number, number, number, number, ...number[]];
  const { a, f } = ellipsoid(ell);
  const toUnits = ([x, y]: [number, number]): [number, number] => [x / unit, y / unit];
  if (method === 0) {
    const [lat0, lon0, k0, fe, fn] = prm as [number, number, number, number, number];
    return (lon, lat) => toUnits(tmForward(lon, lat, { a, f, lat0, lon0, k0, fe, fn }));
  }
  if (method === 1) {
    const [lat0, lon0, k0, fe, fn] = prm as [number, number, number, number, number];
    return (lon, lat) => toUnits(lccForward(lon, lat, { a, f, lat1: lat0, lat2: lat0, latOrigin: lat0, lon0, k0, fe, fn }));
  }
  const [latF, lonF, lat1, lat2, fe, fn] = prm as [number, number, number, number, number, number];
  return (lon, lat) => toUnits(lccForward(lon, lat, { a, f, lat1, lat2, latOrigin: latF, lon0: lonF, k0: 1, fe, fn }));
}

/**
 * A function from this CRS's map coordinates (x = easting, y = northing) to WGS84 longitude /
 * latitude, or null when the CRS is not in the table (then only the map-coordinate GeoJSON).
 */
export function lonLatProjector(epsg: number | null, kind: 'projected' | 'geographic' | 'unknown'): ((x: number, y: number) => LonLat) | null {
  if (epsg === null) return null;
  // A geographic code on a raster tagged as projected is inconsistent: never read metres as degrees.
  if (NEAR_WGS84_GEOGRAPHIC.has(epsg)) return kind === 'projected' ? null : (x, y) => wrap([x, y]);
  if (kind === 'geographic') return null;
  if (WEB_MERCATOR.has(epsg)) return webMercatorInverse;
  index ??= new Map(CRS_TABLE.map((r) => [r[0]!, r]));
  const r = index.get(epsg);
  if (!r) return null;
  const [, method, ell, unit, ...prm] = r as [number, number, number, number, ...number[]];
  const { a, f } = ellipsoid(ell);
  if (method === 0) {
    const [lat0, lon0, k0, fe, fn] = prm as [number, number, number, number, number];
    return (x, y) => wrap(tmInverse(x * unit, y * unit, { a, f, lat0, lon0, k0, fe, fn }));
  }
  if (method === 1) {
    const [lat0, lon0, k0, fe, fn] = prm as [number, number, number, number, number];
    return (x, y) => wrap(lccInverse(x * unit, y * unit, { a, f, lat1: lat0, lat2: lat0, latOrigin: lat0, lon0, k0, fe, fn }));
  }
  const [latF, lonF, lat1, lat2, fe, fn] = prm as [number, number, number, number, number, number];
  return (x, y) => wrap(lccInverse(x * unit, y * unit, { a, f, lat1, lat2, latOrigin: latF, lon0: lonF, k0: 1, fe, fn }));
}
