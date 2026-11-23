/**
 * Georeferencing of GeoTIFF photos, so grain outlines can be exported in map coordinates
 * (GeoJSON) and the label mask placed on the map (world file). The transform is read from the
 * GeoTIFF tags at import and kept with the photo; it applies only while the photo is still the
 * raster it came from (same size, not rectified).
 */
import { photoProcessingHistory, type PhotoGeoreference, type SitePhotoMetadata } from './siteTypes.js';
import { lonLatProjector } from './projToLonLat.js';
import { rightHandRings } from './exportFormats.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

/** Reads the georeference from a decoded TIFF IFD (UTIF `t<tag>` keys), or undefined. */
export function extractGeoReference(ifd: Record<string, unknown>, width: number, height: number): PhotoGeoreference | undefined {
  const geoDir = ifd['t34735'];
  let modelType: number | undefined;
  let rasterType = 1;
  let projected: number | undefined;
  let geographic: number | undefined;
  if (Array.isArray(geoDir) && geoDir.length >= 4) {
    const n = num(geoDir[3]) || 0;
    for (let i = 0; i < n; i++) {
      const b = 4 + i * 4;
      if (b + 3 >= geoDir.length) break;
      if (num(geoDir[b + 1]) !== 0) continue; // value stored elsewhere (not a SHORT)
      const key = num(geoDir[b]);
      const value = num(geoDir[b + 3]);
      if (key === 1024) modelType = value;
      else if (key === 1025) rasterType = value;
      else if (key === 3072) projected = value;
      else if (key === 2048) geographic = value;
    }
  }
  let a: number, b: number, c: number, d: number, e: number, f: number;
  const m = ifd['t34264'];
  const tie = ifd['t33922'];
  const scale = ifd['t33550'];
  if (Array.isArray(m) && m.length >= 16) {
    // ModelTransformationTag: X = m0 I + m1 J + m3, Y = m4 I + m5 J + m7.
    [b, c, a, e, f, d] = [num(m[0]), num(m[1]), num(m[3]), num(m[4]), num(m[5]), num(m[7])];
  } else if (Array.isArray(tie) && tie.length >= 6 && Array.isArray(scale) && scale.length >= 2) {
    // ModelTiepointTag (I, J, K, X, Y, Z) + ModelPixelScaleTag (sx, sy): rows go towards -Y.
    const [I, J, X, Y, sx, sy] = [num(tie[0]), num(tie[1]), num(tie[3]), num(tie[4]), num(scale[0]), num(scale[1])];
    [a, b, c, d, e, f] = [X - I * sx, sx, 0, Y + J * sy, 0, -sy];
  } else {
    return undefined;
  }
  if (rasterType === 2) {
    // PixelIsPoint: raster coordinates name pixel centres; move the origin to pixel corners.
    a -= 0.5 * (b + c);
    d -= 0.5 * (e + f);
  }
  const t: PhotoGeoreference['transform'] = [a, b, c, d, e, f];
  if (!t.every(Number.isFinite) || Math.abs(b * f - c * e) < 1e-30) return undefined;
  // A projected model's CRS is ProjectedCSTypeGeoKey (3072) only; GeographicTypeGeoKey (2048)
  // then names just its base datum (e.g. 4326 under a user-defined projection) and must not be
  // mistaken for the raster's CRS, which would read eastings/northings as degrees.
  const code = modelType === 1 ? projected : modelType === 2 ? geographic : (projected ?? geographic);
  const geoKeys = rawGeoKeys(ifd);
  return {
    transform: t,
    epsg: code !== undefined && code > 0 && code !== 32767 ? code : null,
    kind: modelType === 1 ? 'projected' : modelType === 2 ? 'geographic' : 'unknown',
    width,
    height,
    ...(geoKeys ? { geoKeys } : {}),
  };
}

/** Largest GeoKey directory / parameter lists kept (real files use a few dozen values). */
export const MAX_GEOKEY_VALUES = 1024;
export const MAX_GEOKEY_ASCII = 4096;

/** Checked copy of GeoKeys (from a TIFF or a project file), or undefined if malformed. */
export function cleanGeoKeys(
  dir: unknown,
  doubles: unknown,
  ascii: unknown,
  /** TIFF import: replace non-printable / non-ASCII text characters instead of rejecting the keys. */
  options: { replaceNonAscii?: boolean } = {},
): PhotoGeoreference['geoKeys'] {
  if (!Array.isArray(dir) || dir.length < 4 || dir.length > MAX_GEOKEY_VALUES) return undefined;
  const d = dir.map(num);
  if (!d.every((v) => Number.isInteger(v) && v >= 0 && v <= 65535)) return undefined;
  if (d.length !== 4 + 4 * d[3]!) return undefined;
  const out: NonNullable<PhotoGeoreference['geoKeys']> = { directory: d };
  if (Array.isArray(doubles) && doubles.length > 0) {
    const p = doubles.map(num);
    if (p.length > MAX_GEOKEY_VALUES || !p.every(Number.isFinite)) return undefined;
    out.doubles = p;
  }
  if (typeof ascii === 'string' && ascii.length > 0) {
    if (ascii.length > MAX_GEOKEY_ASCII) return undefined;
    if (options.replaceNonAscii) {
      // CRS names in real GeoTIFFs may hold non-ASCII bytes (e.g. "Réseau", "°") or line breaks.
      // Replace each such character one-for-one, so the GeoKeys' offsets into the text stay valid,
      // rather than dropping every CRS key of the file.
      out.ascii = ascii.replace(/[^\x20-\x7e|]/g, '?');
    } else {
      if (/[^\x20-\x7e|]/.test(ascii)) return undefined;
      out.ascii = ascii;
    }
  }
  return out;
}

function rawGeoKeys(ifd: Record<string, unknown>): PhotoGeoreference['geoKeys'] {
  // UTIF gives an ASCII tag as an array of its NUL-separated strings; GeoAsciiParams is one
  // '|'-separated string that the key offsets index into.
  const a = ifd['t34737'];
  const ascii = Array.isArray(a) ? a.join('') : typeof a === 'string' ? a : undefined;
  return cleanGeoKeys(ifd['t34735'], ifd['t34736'], ascii, { replaceNonAscii: true });
}

/**
 * The photo's georeference if it still applies: the photo has the size the GeoTIFF had and was
 * not rectified (rectification warps it; 2x enhancement changes its size). Otherwise null and why.
 */
export function photoGeoreference(photo: {
  width: number;
  height: number;
  metadata?: SitePhotoMetadata;
}): { georef: PhotoGeoreference | null; reason: string | null } {
  const g = photo.metadata?.georef;
  // Archives carry metadata as given: use only a well-formed transform.
  if (
    !g ||
    !Array.isArray(g.transform) ||
    g.transform.length !== 6 ||
    !g.transform.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
    !(g.epsg === null || (typeof g.epsg === 'number' && Number.isInteger(g.epsg)))
  ) {
    return { georef: null, reason: null };
  }
  if (photoProcessingHistory(photo.metadata).some((s) => s.step === 'rectification')) {
    return { georef: null, reason: 'The photo was rectified, so its original map position no longer applies.' };
  }
  if (photo.width === g.width && photo.height === g.height) return { georef: g, reason: null };
  // A 2x upscale only resamples the same ground onto a finer pixel grid: the map position still
  // applies, with the pixel size divided by the factor.
  const k = photo.width / g.width;
  const upscaled = photoProcessingHistory(photo.metadata).some((s) => s.step === 'enhancement' && s.kind === 'upscale-2x');
  if (upscaled && Number.isInteger(k) && k > 1 && photo.height === g.height * k) {
    const [a, b, c, d, e, f] = g.transform;
    return { georef: { ...g, transform: [a, b / k, c / k, d, e / k, f / k], width: photo.width, height: photo.height }, reason: null };
  }
  return { georef: null, reason: 'The photo no longer has its GeoTIFF size, so its map position no longer applies.' };
}

/** Map coordinates of a photo point given in pixel-CORNER coordinates. */
export function toMap(g: PhotoGeoreference, u: number, v: number): [number, number] {
  const [a, b, c, d, e, f] = g.transform;
  return [a + b * u + c * v, d + e * u + f * v];
}

function mapCoords(value: unknown, g: PhotoGeoreference): unknown {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return toMap(g, value[0], value[1]);
  }
  return Array.isArray(value) ? value.map((v) => mapCoords(v, g)) : value;
}

/**
 * GeoJSON in map coordinates from the pixel GeoJSON export (outlines in pixel-corner
 * coordinates). Adds the CRS as a `crs` member (read by GDAL / QGIS) and each grain's centroid
 * in map coordinates (`centroidMapX/Y`; the pixel centroid is a pixel-index coordinate).
 */
export function geoJsonToMap(pixelGeoJson: string, g: PhotoGeoreference): string {
  const fc = JSON.parse(pixelGeoJson) as { type: string; metadata?: Record<string, unknown>; features: Array<{ geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }> };
  // Right-hand rule in map coordinates whatever the raster's orientation (north-up, south-up,
  // mirrored or rotated): the pixel-to-map transform may flip the rings.
  const polygon = (rings: number[][][]): number[][][] => rightHandRings(mapCoords(rings, g) as number[][][]);
  for (const feat of fc.features) {
    const geom = feat.geometry;
    geom.coordinates =
      geom.type === 'Polygon' ? polygon(geom.coordinates as number[][][])
      : geom.type === 'MultiPolygon' ? (geom.coordinates as number[][][][]).map(polygon)
      : mapCoords(geom.coordinates, g);
    const cx = feat.properties['centroidX'];
    const cy = feat.properties['centroidY'];
    if (typeof cx === 'number' && typeof cy === 'number') {
      const [X, Y] = toMap(g, cx + 0.5, cy + 0.5);
      feat.properties['centroidMapX'] = X;
      feat.properties['centroidMapY'] = Y;
    }
  }
  // A user-defined CRS has no name to give: `null` (GeoJSON 2008: no CRS can be assumed) rather
  // than nothing, which readers take as WGS84.
  const crs = { crs: g.epsg !== null ? { type: 'name', properties: { name: `urn:ogc:def:crs:EPSG::${g.epsg}` } } : null };
  return JSON.stringify({
    type: 'FeatureCollection',
    ...crs,
    metadata: {
      ...(fc.metadata ?? {}),
      mapCoordinates: {
        crs: g.epsg !== null ? `EPSG:${g.epsg}` : 'user-defined CRS of the source GeoTIFF (not recorded): assign it in your GIS',
        transform: { a: g.transform[0], b: g.transform[1], c: g.transform[2], d: g.transform[3], e: g.transform[4], f: g.transform[5] },
        note: 'Outline coordinates are map coordinates from the source GeoTIFF: X = a + b*u + c*v, Y = d + e*u + f*v, with (u, v) pixel-corner coordinates. Sizes and areas in the properties are still in photo pixels and mm.',
      },
    },
    features: fc.features,
  });
}

/**
 * GDAL PAM sidecar (`<image>.aux.xml`) naming the CRS, for an image placed by a world file (which
 * holds no CRS): QGIS and other GDAL-based GIS then put it in the right place. Null without an
 * EPSG code (a user-defined CRS has no short name; use the GeoTIFF mask instead).
 */
export function pamAuxXml(g: PhotoGeoreference): string | null {
  return g.epsg !== null ? `<PAMDataset>\n  <SRS>EPSG:${g.epsg}</SRS>\n</PAMDataset>\n` : null;
}

/**
 * File name of the map-coordinate GeoJSON. It names the CRS (e.g. outlines_EPSG2193.geojson),
 * because RFC 7946 readers (web maps, ArcGIS Online) take any .geojson as longitude / latitude and
 * ignore its `crs` member: the name tells users this one is for GDAL-based GIS only.
 */
export function mapGeoJsonName(g: PhotoGeoreference): string {
  return g.epsg !== null ? `outlines_EPSG${g.epsg}.geojson` : 'outlines_customCRS.geojson';
}

/** Whether the photo's CRS can be converted to longitude / latitude (see geoJsonToLonLat). */
export function canExportLonLat(g: PhotoGeoreference): boolean {
  return lonLatProjector(g.epsg, g.kind) !== null;
}


/**
 * RFC 7946 GeoJSON (WGS84 longitude / latitude, no `crs` member) from the pixel GeoJSON export,
 * for web maps and other tools that read GeoJSON only as longitude / latitude. Null when the
 * CRS is not one projToLonLat converts. Exterior rings counter-clockwise, holes clockwise
 * (right-hand rule); coordinates to 1e-9 degree (about 0.1 mm). No datum shift is applied:
 * the CRSs converted are within about a metre of WGS84.
 */
export function geoJsonToLonLat(pixelGeoJson: string, g: PhotoGeoreference): string | null {
  const project = lonLatProjector(g.epsg, g.kind);
  if (!project) return null;
  const ll = (u: number, v: number): [number, number] => {
    const [x, y] = toMap(g, u, v);
    const [lon, lat] = project(x, y);
    return [Math.round(lon * 1e9) / 1e9, Math.round(lat * 1e9) / 1e9];
  };
  const polygon = (rings: number[][][]): number[][][] => rightHandRings(rings.map((r) => r.map((p) => ll(p[0]!, p[1]!))));
  const fc = JSON.parse(pixelGeoJson) as { metadata?: Record<string, unknown>; features: Array<{ geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }> };
  for (const feat of fc.features) {
    const geom = feat.geometry;
    geom.coordinates = geom.type === 'Polygon' ? polygon(geom.coordinates as number[][][]) : (geom.coordinates as number[][][][]).map(polygon);
    const cx = feat.properties['centroidX'];
    const cy = feat.properties['centroidY'];
    if (typeof cx === 'number' && typeof cy === 'number') {
      const [lon, lat] = ll(cx + 0.5, cy + 0.5);
      feat.properties['centroidLon'] = lon;
      feat.properties['centroidLat'] = lat;
    }
  }
  return JSON.stringify({
    type: 'FeatureCollection',
    metadata: {
      ...(fc.metadata ?? {}),
      lonLatCoordinates: {
        crs: 'WGS 84 longitude / latitude (RFC 7946)',
        sourceCrs: `EPSG:${g.epsg}`,
        note: `Converted from the source GeoTIFF's EPSG:${g.epsg} map coordinates without a datum shift (that datum is within about a metre of WGS84). For survey-grade positions use ${mapGeoJsonName(g)} (EPSG:${g.epsg} map coordinates). Sizes and areas in the properties are in photo pixels and mm.`,
      },
    },
    features: fc.features,
  });
}

/** World file (.pgw / .tfw) for an image of the photo's size: six lines, top-left pixel centre. */
export function worldFile(g: PhotoGeoreference): string {
  const [a, b, c, d, e, f] = g.transform;
  const [x0, y0] = [a + 0.5 * b + 0.5 * c, d + 0.5 * e + 0.5 * f];
  return [b, e, c, f, x0, y0].map((v) => String(v)).join('\n') + '\n';
}
