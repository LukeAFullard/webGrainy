/**
 * Copying one photo's scale (mm per pixel) to other photos. Pure planning, so the rules are
 * unit-tested: which photos are suggested, what would be overwritten, and the confirmation.
 *
 * A scale copied between photos is only right when the photos share camera, lens, zoom,
 * resolution and height above the bed. Photos that already have their own scale (measured,
 * perspective-rectified, or from a GeoTIFF) are never changed without an explicit confirmation.
 */
import { photoUpscaleFactor, scaleCalibrationAndRoi } from '../modules/imageEnhance.js';
import type { PhotoRecord } from '../modules/projectStorage.js';
import type { CalibrationResult } from '../types/index.js';

export type ScaleSource = NonNullable<CalibrationResult['source']>;

/** Where a photo's current scale came from (undefined = no scale). */
export function scaleSourceOf(photo: Pick<PhotoRecord, 'calibration' | 'metadata'>): ScaleSource | undefined {
  const cal = photo.calibration;
  if (!cal) return undefined;
  if (cal.source) return cal.source;
  const last = photo.metadata?.processingHistory?.at(-1);
  return last?.step === 'rectification' ? 'rectification' : 'manual';
}

/** Photo pixel size before any 2x enhancement (so an upscaled copy still "matches"). */
function nativeSize(p: PhotoRecord): string {
  const f = photoUpscaleFactor(p);
  return `${Math.round(p.width / f)}x${Math.round(p.height / f)}`;
}

/**
 * Photos to pre-select for "Copy scale to photos": same native pixel size as the source and
 * no scale of their own yet (or one copied earlier).
 */
export function suggestScaleTargets(source: PhotoRecord, photos: readonly PhotoRecord[]): Set<string> {
  const size = nativeSize(source);
  const out = new Set<string>();
  for (const p of photos) {
    if (p.photoId === source.photoId) continue;
    const src = scaleSourceOf(p);
    if ((src === undefined || src === 'copied') && nativeSize(p) === size) out.add(p.photoId);
  }
  return out;
}

export interface ScaleCopyPlan {
  /** Updated photo records (calibration set, marked as copied). */
  updates: PhotoRecord[];
  /** Targets that already have their own scale, by source. */
  overwrites: Array<{ photo: PhotoRecord; source: ScaleSource }>;
  /** Targets whose native pixel size differs from the source photo. */
  sizeMismatch: PhotoRecord[];
  /** Confirmation text when something risky would happen, else null. */
  confirmMessage: string | null;
}

const SOURCE_LABEL: Record<ScaleSource, string> = {
  manual: 'measured on the photo',
  rectification: 'from perspective rectification',
  geotiff: 'from GeoTIFF georeferencing',
  copied: 'copied from another photo',
};

/** What copying `source`'s scale to `targetIds` would change. */
export function planScaleCopy(source: PhotoRecord, photos: readonly PhotoRecord[], targetIds: ReadonlySet<string>): ScaleCopyPlan {
  const cal = source.calibration;
  if (!cal) return { updates: [], overwrites: [], sizeMismatch: [], confirmMessage: null };
  const sourceFactor = photoUpscaleFactor(source);
  const size = nativeSize(source);
  const updates: PhotoRecord[] = [];
  const overwrites: ScaleCopyPlan['overwrites'] = [];
  const sizeMismatch: PhotoRecord[] = [];
  for (const p of photos) {
    if (p.photoId === source.photoId || !targetIds.has(p.photoId)) continue;
    const existing = scaleSourceOf(p);
    if (existing !== undefined && existing !== 'copied') overwrites.push({ photo: p, source: existing });
    if (nativeSize(p) !== size) sizeMismatch.push(p);
    // Same physical scale, adjusted for a 2x-upscaled copy of either photo.
    const ratio = photoUpscaleFactor(p) / sourceFactor;
    const scaled = scaleCalibrationAndRoi(cal, undefined, ratio).calibration ?? cal;
    updates.push({ ...p, calibration: { ...scaled, source: 'copied', copiedFrom: source.label } });
  }
  const lines: string[] = [];
  if (overwrites.length > 0) {
    const bySource = new Map<ScaleSource, number>();
    for (const o of overwrites) bySource.set(o.source, (bySource.get(o.source) ?? 0) + 1);
    const parts = [...bySource].map(([s, n]) => `${n} ${SOURCE_LABEL[s]}`);
    lines.push(
      `${overwrites.length} of the selected photos already have their own scale (${parts.join(', ')}). It will be replaced.`,
    );
  }
  if (sizeMismatch.length > 0) {
    lines.push(
      `${sizeMismatch.length} selected photo${sizeMismatch.length === 1 ? ' has' : 's have'} a different pixel size from "${source.label}" (another camera or setting?), so the same mm per pixel is probably wrong for ${sizeMismatch.length === 1 ? 'it' : 'them'}.`,
    );
  }
  const confirmMessage =
    lines.length > 0
      ? `Copy the scale of "${source.label}" (${cal.mmPerPx.toPrecision(4)} mm/px) to ${updates.length} photo${updates.length === 1 ? '' : 's'}?\n\n${lines.join('\n\n')}\n\nThis cannot be undone.`
      : null;
  return { updates, overwrites, sizeMismatch, confirmMessage };
}
