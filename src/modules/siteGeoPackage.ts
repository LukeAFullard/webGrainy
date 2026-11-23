/**
 * The whole site as one GeoPackage: every analysed photo's grain outlines in one layer
 * (`grain_outlines`, with the photo and whether each grain counts in the statistics), and each
 * photo's footprint with its D16 / D50 / D84 (`photo_footprints`). A layer has one coordinate
 * system, so: the photos' shared map CRS when they all have the same one, else WGS84
 * longitude / latitude. Photos without a georeference cannot be placed and are left out (listed
 * in the layer description); a site without any GeoTIFF photo gets its outlines in photo pixels.
 */
import type { SizeMetric } from '../types/index.js';
import { geoJsonToLonLat, geoJsonToMap, gpkgMapSrs, photoGeoreference } from './georef.js';
import { buildGeoPackage, PIXEL_SRS, WGS84_SRS, type GpkgFeature, type GpkgLayer, type GpkgSrs } from './geopackage.js';
import type { SiteAnalysisOptions, SiteAnalysisReport, SitePhotoInput } from './siteAnalysis.js';
import type { PhotoGeoreference } from './siteTypes.js';
import { photoCutoffs } from './siteWorkspace.js';

export type SiteGpkgCoords = 'map' | 'lonlat' | 'pixels';

export interface SiteGpkgPlan {
  coords: SiteGpkgCoords;
  srs: GpkgSrs;
  /** Photos written, with their georeference (null in photo pixels). */
  placed: Array<{ input: SitePhotoInput; georef: PhotoGeoreference | null }>;
  /** Photos left out, and why. */
  skipped: Array<{ label: string; reason: string }>;
}

const georefOf = (i: SitePhotoInput): PhotoGeoreference | null =>
  photoGeoreference({ width: i.session.workingImage.originalWidth, height: i.session.workingImage.originalHeight, ...(i.metadata ? { metadata: i.metadata } : {}) }).georef;

/** Which photos go into the site GeoPackage, and in which coordinates. */
export function siteGeoPackagePlan(inputs: readonly SitePhotoInput[]): SiteGpkgPlan {
  const all = inputs.map((input) => ({ input, georef: georefOf(input) }));
  const geo = all.filter((p) => p.georef !== null);
  if (geo.length === 0) {
    return { coords: 'pixels', srs: PIXEL_SRS, placed: all.map((p) => ({ input: p.input, georef: null })), skipped: [] };
  }
  const skipped = all.filter((p) => p.georef === null).map((p) => ({ label: p.input.label, reason: 'no georeference (not a GeoTIFF, or rectified)' }));
  const codes = new Set(geo.map((p) => p.georef!.epsg));
  const shared = codes.size === 1 ? gpkgMapSrs(geo[0]!.georef!) : null;
  if (shared) return { coords: 'map', srs: shared, placed: geo, skipped };
  // Different (or undefinable) CRSs: longitude / latitude for every photo that can be converted.
  const ll = geo.filter((p) => geoJsonToLonLat(JSON.stringify({ type: 'FeatureCollection', features: [] }), p.georef!) !== null);
  for (const p of geo) if (!ll.includes(p)) skipped.push({ label: p.input.label, reason: `its CRS (${p.georef!.epsg === null ? 'user-defined' : `EPSG:${p.georef!.epsg}`}) cannot be converted to longitude / latitude` });
  return { coords: 'lonlat', srs: WGS84_SRS, placed: ll, skipped };
}

type Fc = { type: 'FeatureCollection'; features: GpkgFeature[] };

export interface SiteGeoPackageInput {
  siteName: string;
  inputs: readonly SitePhotoInput[];
  report: SiteAnalysisReport | null;
  siteOptions?: Partial<SiteAnalysisOptions>;
  sizeMetric?: SizeMetric;
  /** Only the grains counted in the statistics (as the photo exports' option). */
  countedOnly?: boolean;
  /** Provenance written as the layers' description. */
  metadata: Record<string, unknown>;
  now?: Date;
}

/** The site GeoPackage, or null when no photo is analysed. */
export function buildSiteGeoPackage(o: SiteGeoPackageInput): { bytes: Uint8Array; plan: SiteGpkgPlan } | null {
  const plan = siteGeoPackagePlan(o.inputs);
  if (plan.placed.length === 0) return null;
  const metric = o.sizeMetric ?? 'bAxis';
  const toCoords = (fc: Fc, g: PhotoGeoreference | null): Fc =>
    plan.coords === 'pixels' || g === null
      ? fc
      : (JSON.parse(plan.coords === 'map' ? geoJsonToMap(JSON.stringify(fc), g) : geoJsonToLonLat(JSON.stringify(fc), g)!) as Fc);

  const grains: GpkgFeature[] = [];
  const footprints: GpkgFeature[] = [];
  const perPhoto = new Map((o.report?.perPhoto ?? []).map((p) => [p.photoId, p]));
  const unit = o.report?.unit ?? 'px';
  for (const { input, georef } of plan.placed) {
    const s = input.session;
    const counted = s.countedGrainIds(metric, o.siteOptions ? photoCutoffs(o.siteOptions, o.report, input.photoId) : undefined);
    const fc = JSON.parse(s.exportGeoJson(undefined, o.countedOnly ? counted : undefined)) as Fc;
    for (const f of toCoords(fc, georef).features) {
      const id = f.properties?.['grainId'];
      f.properties = {
        photoId: input.photoId,
        photoLabel: input.label,
        includedInSite: input.included,
        includedInStats: typeof id === 'number' && counted.has(id),
        ...f.properties,
      };
      grains.push(f);
    }
    if (plan.coords !== 'pixels') {
      const w = s.workingImage.originalWidth;
      const h = s.workingImage.originalHeight;
      // Edges densified so a longitude / latitude footprint follows the projection's curvature.
      const edge = (x0: number, y0: number, x1: number, y1: number): number[][] =>
        Array.from({ length: 8 }, (_, k) => [x0 + ((x1 - x0) * k) / 8, y0 + ((y1 - y0) * k) / 8]);
      const ring = [...edge(0, 0, w, 0), ...edge(w, 0, w, h), ...edge(w, h, 0, h), ...edge(0, h, 0, 0), [0, 0]];
      const p = perPhoto.get(input.photoId);
      const fp: Fc = {
        type: 'FeatureCollection',
        features: [{
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: {
            photoId: input.photoId,
            photoLabel: input.label,
            includedInSite: input.included,
            sourceCrs: georef?.epsg != null ? `EPSG:${georef.epsg}` : 'user-defined',
            widthPx: w,
            heightPx: h,
            mmPerPx: p?.mmPerPx ?? s.getCalibration()?.mmPerPx ?? null,
            grainsDetected: s.getResult().grainCount,
            grainsCounted: counted.size,
            [`d16_${unit}`]: p && Number.isFinite(p.D16) ? p.D16 : null,
            [`d50_${unit}`]: p && Number.isFinite(p.D50) ? p.D50 : null,
            [`d84_${unit}`]: p && Number.isFinite(p.D84) ? p.D84 : null,
            sitePercentWeight: p ? p.weightContributionPct : null,
          },
        }],
      };
      footprints.push(...toCoords(fp, georef).features);
    }
  }
  const description = JSON.stringify({
    ...o.metadata,
    siteGeoPackage: {
      coordinates:
        plan.coords === 'map'
          ? `map coordinates of the photos' shared CRS, EPSG:${plan.srs.id}`
          : plan.coords === 'lonlat'
            ? 'WGS84 longitude / latitude (the photos have different CRSs), converted without a datum shift (within about a metre)'
            : 'photo pixels (x right, y down) of each photo: no photo is georeferenced, so photos overlap; filter by photo_id',
      grains: o.countedOnly ? 'only the grains counted in the statistics' : 'every detected grain; included_in_stats marks the ones counted in the statistics',
      photosLeftOut: plan.skipped.map((s) => `${s.label}: ${s.reason}`),
    },
  });
  const layers: GpkgLayer[] = [{ table: 'grain_outlines', identifier: `${o.siteName} grain outlines`, description, features: grains }];
  if (footprints.length > 0) layers.push({ table: 'photo_footprints', identifier: `${o.siteName} photo footprints`, description, features: footprints });
  return { bytes: buildGeoPackage(layers, plan.srs, o.now), plan };
}
