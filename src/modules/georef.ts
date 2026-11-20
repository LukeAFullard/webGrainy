/**
 * Georeferencing of GeoTIFF photos, so grain outlines can be exported in map coordinates
 * (GeoJSON) and the label mask placed on the map (world file). The transform is read from the
 * GeoTIFF tags at import and kept with the photo; it applies only while the photo is still the
 * raster it came from (same size, not rectified).
 */
import type { PhotoGeoreference, SitePhotoMetadata } from './siteTypes.js';

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
  const code = projected ?? geographic;
  return {
    transform: t,
    epsg: code !== undefined && code > 0 && code !== 32767 ? code : null,
    kind: modelType === 1 ? 'projected' : modelType === 2 ? 'geographic' : 'unknown',
    width,
    height,
  };
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
  if ((photo.metadata?.processingHistory ?? []).some((s) => s.step === 'rectification')) {
    return { georef: null, reason: 'The photo was rectified, so its original map position no longer applies.' };
  }
  if (photo.width !== g.width || photo.height !== g.height) {
    return { georef: null, reason: 'The photo no longer has its GeoTIFF size (it was enhanced), so its map position no longer applies.' };
  }
  return { georef: g, reason: null };
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
  for (const feat of fc.features) {
    feat.geometry.coordinates = mapCoords(feat.geometry.coordinates, g);
    const cx = feat.properties['centroidX'];
    const cy = feat.properties['centroidY'];
    if (typeof cx === 'number' && typeof cy === 'number') {
      const [X, Y] = toMap(g, cx + 0.5, cy + 0.5);
      feat.properties['centroidMapX'] = X;
      feat.properties['centroidMapY'] = Y;
    }
  }
  const crs = g.epsg !== null ? { crs: { type: 'name', properties: { name: `urn:ogc:def:crs:EPSG::${g.epsg}` } } } : {};
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

/** World file (.pgw / .tfw) for an image of the photo's size: six lines, top-left pixel centre. */
export function worldFile(g: PhotoGeoreference): string {
  const [a, b, c, d, e, f] = g.transform;
  const [x0, y0] = [a + 0.5 * b + 0.5 * c, d + 0.5 * e + 0.5 * f];
  return [b, e, c, f, x0, y0].map((v) => String(v)).join('\n') + '\n';
}
