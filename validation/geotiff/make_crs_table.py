#!/usr/bin/env python3
"""Generate src/modules/crsTable.ts from the EPSG database (via pyproj / PROJ).

Projected CRSs using Transverse Mercator or Lambert Conformal Conic (1SP / 2SP) on the GRS 1980 or
WGS 84 ellipsoid with east/north axes, kept when PROJ's transformation of the CRS's own geodetic
coordinates to WGS84 moves the centre of its area of use by at most 1 m (the app applies no datum
shift). Geographic 2D CRSs on the same ellipsoids are listed under the same rule.

Usage: pip install pyproj==3.8.0   (bundles PROJ 9.8.1)
       python3 -I validation/geotiff/make_crs_table.py src/modules/crsTable.ts
The app's conversion is checked against PROJ for every kept CRS by tests/projToLonLat.test.ts
(sample) and by validation/geotiff/check_crs_table.mjs (all; reads crs_reference.json written here).
"""
import json, math, sys
import pyproj
from pyproj.database import query_crs_info
from pyproj.enums import PJType

METHODS = {'Transverse Mercator': 0, 'Lambert Conic Conformal (1SP)': 1, 'Lambert Conic Conformal (2SP)': 2}
ELL = {'GRS 1980': 0, 'WGS 84': 1}
MAX_DATUM_M = 1.0


def centre(c):
    a = c.area_of_use
    if not a:
        return None
    lon = (a.west + a.east) / 2 if a.west <= a.east else ((a.west + a.east + 360) / 2 + 180) % 360 - 180
    return lon, (a.south + a.north) / 2


def metres(lon1, lat1, lon2, lat2):
    dlon = ((lon1 - lon2 + 540) % 360) - 180
    return math.hypot(math.radians(dlon) * math.cos(math.radians(lat2)), math.radians(lat1 - lat2)) * 6371008.8


def r(v):
    return float(f'{v:.12g}')


rows, ref, geo = [], [], []
for info in query_crs_info(auth_name='EPSG', pj_types=[PJType.PROJECTED_CRS]):
    if info.deprecated:
        continue
    try:
        c = pyproj.CRS.from_epsg(int(info.code))
    except Exception:
        continue
    op = c.coordinate_operation
    if not op or op.method_name not in METHODS or c.ellipsoid.name not in ELL:
        continue
    ax = c.axis_info
    units = {a.unit_conversion_factor for a in ax[:2]}
    if len(ax) < 2 or len(units) != 1 or sorted(a.direction for a in ax[:2]) != ['east', 'north']:
        continue
    p = {pp.name: (pp.value, pp.unit_conversion_factor) for pp in op.params}
    ang = lambda n: p[n][0] * p[n][1] * 180 / math.pi
    lin = lambda n: p[n][0] * p[n][1]
    m = METHODS[op.method_name]
    try:
        if m in (0, 1):
            prm = [ang('Latitude of natural origin'), ang('Longitude of natural origin'), p['Scale factor at natural origin'][0], lin('False easting'), lin('False northing')]
        else:
            prm = [ang('Latitude of false origin'), ang('Longitude of false origin'), ang('Latitude of 1st standard parallel'), ang('Latitude of 2nd standard parallel'), lin('Easting at false origin'), lin('Northing at false origin')]
    except KeyError:
        continue
    cc = centre(c)
    if cc is None:
        continue
    try:
        x, y = pyproj.Transformer.from_crs(c.geodetic_crs, c, always_xy=True).transform(*cc)
        lon84, lat84 = pyproj.Transformer.from_crs(c, 'EPSG:4326', always_xy=True).transform(x, y)
    except Exception:
        continue
    if not all(map(math.isfinite, (x, y, lon84, lat84))) or metres(lon84, lat84, *cc) > MAX_DATUM_M:
        continue
    rows.append([int(info.code), m, ELL[c.ellipsoid.name], r(units.pop())] + [r(v) for v in prm])
    ref.append([int(info.code), x, y, cc[0], cc[1]])

for info in query_crs_info(auth_name='EPSG', pj_types=[PJType.GEOGRAPHIC_2D_CRS]):
    if info.deprecated:
        continue
    try:
        c = pyproj.CRS.from_epsg(int(info.code))
    except Exception:
        continue
    ax = c.axis_info
    if c.ellipsoid.name not in ELL or len(ax) != 2 or abs(ax[0].unit_conversion_factor - math.pi / 180) > 1e-12:
        continue
    cc = centre(c)
    if cc is None:
        continue
    try:
        lo, la = pyproj.Transformer.from_crs(c, 'EPSG:4326', always_xy=True).transform(*cc)
    except Exception:
        continue
    if metres(lo, la, *cc) <= MAX_DATUM_M:
        geo.append(int(info.code))

rows.sort()
geo.sort()
body = ',\n'.join(json.dumps(x, separators=(',', ':')) for x in rows)
open(sys.argv[1], 'w').write(f"""/**
 * Projected CRSs that projToLonLat.ts converts to longitude / latitude, generated from the EPSG
 * database (PROJ {pyproj.proj_version_str}, pyproj {pyproj.__version__}) by validation/geotiff/make_crs_table.py:
 * [EPSG code, method (0 Transverse Mercator, 1 LCC 1SP, 2 LCC 2SP), ellipsoid index,
 * metres per CRS unit, ...parameters in degrees and metres]. TM / LCC 1SP: lat0, lon0, k0, FE,
 * FN. LCC 2SP: lat of false origin, lon of false origin, lat1, lat2, FE, FN.
 * Kept only where PROJ moves the centre of the CRS's area of use by at most {MAX_DATUM_M:g} m to WGS84.
 */
/** [semi-major axis (m), inverse flattening]: GRS 1980, WGS 84. */
export const CRS_TABLE_ELLIPSOIDS: ReadonlyArray<readonly [number, number]> = [
  [6378137, 298.257222101],
  [6378137, 298.257223563],
];

export const CRS_TABLE: ReadonlyArray<readonly number[]> = [
{body},
];

/** Geographic (degree) CRSs on GRS 1980 / WGS 84 within {MAX_DATUM_M:g} m of WGS84 (coordinates pass through). */
export const CRS_GEOGRAPHIC_NEAR_WGS84: readonly number[] = {json.dumps(geo, separators=(',', ':'))};
""")
json.dump(ref, open(sys.argv[1].replace('src/modules/crsTable.ts', 'validation/geotiff/crs_reference.json'), 'w'))
print(len(rows), 'projected,', len(geo), 'geographic')
