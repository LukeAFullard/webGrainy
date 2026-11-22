/**
 * Validation of the records inside an imported .webgrainy project. A project file comes from
 * outside the app (a colleague, an old version, or a crafted file), so every field is checked
 * against what the app itself writes: known keys and enum values, finite numbers in range, and
 * short plain-text strings. Anything else is dropped (or the import is refused when the record
 * cannot be used), so imported text can never become markup or silently change a statistic.
 *
 * Site settings are checked by `sanitizeSiteOptions` (siteOptions.ts).
 */
import type { AnalysisConfig, AnalysisProvenance, CalibrationResult, ModelId, ModelRecommendation, PostProcessOptions } from '../types/index.js';
import { MAX_FINE_GRAIN_UPSCALE } from './imagePreprocess.js';
import { cleanGeoKeys } from './georef.js';
import { MODEL_FILES } from './modelCache.js';
import { POSTPROCESS_LIMITS, isValidPostProcessValue } from './postprocessCore.js';
import type { RoiExclusionConfig } from './roiAndRectify.js';
import type { PhotoEnhancementInfo, PhotoGeoreference, PhotoProcessingStep, SitePhotoMetadata } from './siteTypes.js';


const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => finite(v) && v >= lo && v <= hi;

/** A string of at most `max` characters without control characters, else undefined. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v.length > max) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) ? undefined : v;
}

/** An identifier-like token (versions, commits, hashes, dates): letters, digits and . _ : + - / @. */
function token(v: unknown, max = 128): string | undefined {
  return typeof v === 'string' && v.length <= max && /^[A-Za-z0-9._:+\-/@ ]*$/.test(v) ? v : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

const MODEL_IDS = Object.keys(MODEL_FILES) as ModelId[];

/** True for one of the app's model weight files. */
export function isKnownModelId(v: unknown): v is ModelId {
  return typeof v === 'string' && (MODEL_IDS as string[]).includes(v);
}

/** Post-processing settings: only known options with accepted values. */
export function sanitizePostProcess(raw: unknown): Record<string, number> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const key of Object.keys(POSTPROCESS_LIMITS) as Array<keyof PostProcessOptions>) {
    if (isValidPostProcessValue(key, raw[key])) out[key] = raw[key] as number;
  }
  return out;
}

/**
 * The model recommendation stored with an analysis. The model is 'unet' or 'cpsam' (else the
 * family of the analysis' own model, else 'unet'); numbers must be finite; other keys are dropped.
 */
export function sanitizeRecommendation(raw: unknown, fallbackModel: 'unet' | 'cpsam' = 'unet'): ModelRecommendation {
  const r = isObj(raw) ? raw : {};
  const m = isObj(r['metrics']) ? r['metrics'] : {};
  const num = (v: unknown): number => (finite(v) ? v : 0);
  return {
    model: oneOf(r['model'], ['unet', 'cpsam'] as const) ?? fallbackModel,
    confidence: inRange(r['confidence'], 0, 1) ? r['confidence'] : 0,
    rationale: text(r['rationale'], 500) ?? '',
    metrics: {
      sobelEntropy: num(m['sobelEntropy']),
      multiScaleContrastVar: num(m['multiScaleContrastVar']),
      shadowGlareRange: num(m['shadowGlareRange']),
      hasWebGPU: m['hasWebGPU'] === true,
      ...(typeof m['hasShaderF16'] === 'boolean' ? { hasShaderF16: m['hasShaderF16'] } : {}),
      deviceMemoryGB: finite(m['deviceMemoryGB']) ? m['deviceMemoryGB'] : null,
      elapsedMs: num(m['elapsedMs']),
    },
  };
}

/**
 * The reproducibility record of an analysis. Undefined when it does not name one of the app's
 * model files (the analysis is then shown as "provenance unavailable", as for old results).
 * `effectiveScaleFactor` is the analysis' actual working scale, checked by the caller.
 */
export function sanitizeProvenance(raw: unknown, effectiveScaleFactor: number): AnalysisProvenance | undefined {
  if (!isObj(raw) || !isKnownModelId(raw['modelId'])) return undefined;
  const modelId = raw['modelId'];
  const ts = raw['tileSkipping'];
  const rects =
    isObj(ts) && Array.isArray(ts['analysedRects'])
      ? (ts['analysedRects'] as unknown[]).filter(
          (r): r is [number, number, number, number] => Array.isArray(r) && r.length === 4 && r.every((v) => finite(v) && v >= 0),
        )
      : null;
  const decoded = raw['decodedSize'];
  const postProcess = sanitizePostProcess(raw['postProcess']);
  return {
    appVersion: token(raw['appVersion']) ?? 'unknown',
    ...(token(raw['appCommit']) !== undefined ? { appCommit: token(raw['appCommit'])! } : {}),
    ortVersion: token(raw['ortVersion']) ?? 'unknown',
    analyzedAt: token(raw['analyzedAt']) ?? 'unknown',
    modelId,
    modelFile: MODEL_FILES[modelId],
    modelRevision: token(raw['modelRevision'], 64) ?? 'unknown',
    modelSha256: typeof raw['modelSha256'] === 'string' && /^[0-9a-f]{64}$/.test(raw['modelSha256']) ? raw['modelSha256'] : 'unknown',
    ...(oneOf(raw['executionProvider'], ['webgpu', 'wasm'] as const) ? { executionProvider: raw['executionProvider'] as string } : {}),
    ...(oneOf(raw['inferencePipeline'], ['cellpose', 'legacy'] as const) ? { inferencePipeline: raw['inferencePipeline'] as string } : {}),
    ...(oneOf(raw['scaleMode'], ['auto', '1.0x', '0.5x', '0.25x'] as const) ? { scaleMode: raw['scaleMode'] as string } : {}),
    ...(inRange(raw['fineGrainUpscale'], 1, MAX_FINE_GRAIN_UPSCALE) && raw['fineGrainUpscale'] > 1 ? { fineGrainUpscale: raw['fineGrainUpscale'] } : {}),
    ...(isObj(decoded) && Number.isInteger(decoded['width']) && Number.isInteger(decoded['height']) && (decoded['width'] as number) > 0 && (decoded['height'] as number) > 0
      ? { decodedSize: { width: decoded['width'] as number, height: decoded['height'] as number } }
      : {}),
    effectiveScaleFactor,
    ...(typeof raw['applyClahe'] === 'boolean' ? { applyClahe: raw['applyClahe'] } : {}),
    ...(inRange(raw['claheClipLimit'], 0, 100) ? { claheClipLimit: raw['claheClipLimit'] } : {}),
    ...(postProcess !== undefined ? { postProcess } : {}),
    ...(isObj(ts) && rects !== null && Number.isInteger(ts['tilesRun']) && Number.isInteger(ts['tilesTotal']) && finite(ts['marginPx'])
      ? { tileSkipping: { tilesRun: ts['tilesRun'] as number, tilesTotal: ts['tilesTotal'] as number, marginPx: ts['marginPx'] as number, analysedRects: rects } }
      : {}),
  };
}

/** A photo's own analysis settings: only the fine-grain enlargement is stored per photo. */
export function sanitizePhotoAnalysisConfig(raw: unknown): Omit<AnalysisConfig, 'signal' | 'onProgress' | 'calibration'> | undefined {
  if (!isObj(raw)) return undefined;
  const f = raw['fineGrainUpscale'];
  return inRange(f, 1, MAX_FINE_GRAIN_UPSCALE) && f > 1 ? { fineGrainUpscale: f } : undefined;
}

const point = (p: unknown): { x: number; y: number } | null => (isObj(p) && finite(p['x']) && finite(p['y']) ? { x: p['x'], y: p['y'] } : null);

/** A scale with known fields only (the caller has checked mmPerPx and the two points). */
export function sanitizeCalibration(raw: unknown): CalibrationResult | undefined {
  if (!isObj(raw)) return undefined;
  const a = point(raw['pointA']);
  const b = point(raw['pointB']);
  if (!finite(raw['mmPerPx']) || raw['mmPerPx'] <= 0 || a === null || b === null) return undefined;
  const source = oneOf(raw['source'], ['manual', 'rectification', 'geotiff', 'copied'] as const);
  const copiedFrom = text(raw['copiedFrom'], 1024);
  return {
    mmPerPx: raw['mmPerPx'],
    pointA: a,
    pointB: b,
    physicalLengthMm: finite(raw['physicalLengthMm']) ? raw['physicalLengthMm'] : raw['mmPerPx'] * Math.hypot(b.x - a.x, b.y - a.y),
    pixelDistance: finite(raw['pixelDistance']) ? raw['pixelDistance'] : Math.hypot(b.x - a.x, b.y - a.y),
    ...(source !== undefined ? { source } : {}),
    ...(source === 'copied' && copiedFrom !== undefined ? { copiedFrom } : {}),
  };
}

/** An ROI with known fields only (the caller has checked every point). */
export function sanitizeRoi(raw: unknown): RoiExclusionConfig | undefined {
  if (!isObj(raw)) return undefined;
  const pts = (list: unknown): Array<{ x: number; y: number }> => (Array.isArray(list) ? list.map(point).filter((p): p is { x: number; y: number } => p !== null) : []);
  const strokes = Array.isArray(raw['exclusionStrokes']) ? raw['exclusionStrokes'] : [];
  return {
    ...(Array.isArray(raw['roiPolygon']) ? { roiPolygon: pts(raw['roiPolygon']) } : {}),
    exclusionPolygons: (Array.isArray(raw['exclusionPolygons']) ? raw['exclusionPolygons'] : []).map(pts),
    exclusionStrokes: strokes
      .filter((s): s is Record<string, unknown> => isObj(s) && finite(s['radiusPx']) && s['radiusPx'] >= 0)
      .map((s) => ({ points: pts(s['points']), radiusPx: s['radiusPx'] as number })),
    ...(inRange(raw['maxExcludedFraction'], 0, 1) ? { maxExcludedFraction: raw['maxExcludedFraction'] } : {}),
    ...(inRange(raw['unresolvedFinesFraction'], 0, 1) ? { unresolvedFinesFraction: raw['unresolvedFinesFraction'] } : {}),
    ...(inRange(raw['unresolvedSandFractionPct'], 0, 100) ? { unresolvedSandFractionPct: raw['unresolvedSandFractionPct'] } : {}),
  };
}

function sanitizeEnhancement(raw: unknown): PhotoEnhancementInfo | undefined {
  if (!isObj(raw)) return undefined;
  const kind = oneOf(raw['kind'], ['upscale-2x', 'deblur'] as const);
  const modelId = token(raw['modelId']);
  const modelName = text(raw['modelName'], 200);
  if (kind === undefined || modelId === undefined || modelName === undefined || !inRange(raw['scaleFactor'], 0.01, 16)) return undefined;
  return {
    kind,
    modelId,
    modelName,
    modelSha256: typeof raw['modelSha256'] === 'string' && /^[0-9a-f]{0,64}$/.test(raw['modelSha256']) ? raw['modelSha256'] : '',
    scaleFactor: raw['scaleFactor'],
    appliedAt: token(raw['appliedAt']) ?? '',
  };
}

function sanitizeStep(raw: unknown): PhotoProcessingStep | undefined {
  if (!isObj(raw)) return undefined;
  if (raw['step'] === 'enhancement') {
    const e = sanitizeEnhancement(raw);
    return e !== undefined ? { step: 'enhancement', ...e } : undefined;
  }
  if (raw['step'] === 'rectification') {
    const corners = Array.isArray(raw['corners']) ? raw['corners'].map(point) : [];
    const positive = (k: string): boolean => finite(raw[k]) && (raw[k] as number) > 0;
    if (corners.length !== 4 || corners.some((c) => c === null) || !['physicalWidthMm', 'physicalHeightMm', 'outputWidth', 'outputHeight', 'mmPerPx'].every(positive)) {
      return undefined;
    }
    return {
      step: 'rectification',
      corners: corners as Array<{ x: number; y: number }>,
      physicalWidthMm: raw['physicalWidthMm'] as number,
      physicalHeightMm: raw['physicalHeightMm'] as number,
      outputWidth: raw['outputWidth'] as number,
      outputHeight: raw['outputHeight'] as number,
      mmPerPx: raw['mmPerPx'] as number,
      appliedAt: token(raw['appliedAt']) ?? '',
    };
  }
  return undefined;
}

function sanitizeGeoref(raw: unknown): PhotoGeoreference | undefined {
  if (!isObj(raw) || !Array.isArray(raw['transform']) || raw['transform'].length !== 6 || !raw['transform'].every(finite)) return undefined;
  const epsg = raw['epsg'];
  if (!(epsg === null || (Number.isInteger(epsg) && (epsg as number) > 0))) return undefined;
  if (!Number.isInteger(raw['width']) || !Number.isInteger(raw['height'])) return undefined;
  return {
    transform: [...raw['transform']] as PhotoGeoreference['transform'],
    epsg: epsg as number | null,
    kind: oneOf(raw['kind'], ['projected', 'geographic', 'unknown'] as const) ?? 'unknown',
    width: raw['width'] as number,
    height: raw['height'] as number,
    ...(() => {
      const k = isObj(raw['geoKeys']) ? cleanGeoKeys(raw['geoKeys']['directory'], raw['geoKeys']['doubles'], raw['geoKeys']['ascii']) : undefined;
      return k ? { geoKeys: k } : {};
    })(),
  };
}

/** Photo metadata (camera EXIF, quality score, image steps, georeference) with checked fields only. */
export function sanitizePhotoMetadata(raw: unknown): SitePhotoMetadata | undefined {
  if (!isObj(raw)) return undefined;
  const gps = raw['gps'];
  const enhancement = sanitizeEnhancement(raw['enhancement']);
  const georef = sanitizeGeoref(raw['georef']);
  const history = Array.isArray(raw['processingHistory'])
    ? raw['processingHistory'].map(sanitizeStep).filter((s): s is PhotoProcessingStep => s !== undefined)
    : undefined;
  const out: SitePhotoMetadata = {
    ...(token(raw['timestamp'], 64) !== undefined ? { timestamp: token(raw['timestamp'], 64)! } : {}),
    ...(isObj(gps) && inRange(gps['lat'], -90, 90) && inRange(gps['lon'], -180, 180) ? { gps: { lat: gps['lat'], lon: gps['lon'] } } : {}),
    ...(text(raw['cameraMake'], 128) !== undefined ? { cameraMake: text(raw['cameraMake'], 128)! } : {}),
    ...(text(raw['cameraModel'], 128) !== undefined ? { cameraModel: text(raw['cameraModel'], 128)! } : {}),
    ...(inRange(raw['focalLength35mm'], 0, 10_000) ? { focalLength35mm: raw['focalLength35mm'] } : {}),
    ...(finite(raw['blurScore']) && raw['blurScore'] >= 0 ? { blurScore: raw['blurScore'] } : {}),
    ...(enhancement !== undefined ? { enhancement } : {}),
    ...(history !== undefined ? { processingHistory: history } : {}),
    ...(text(raw['notes'], 4000) !== undefined ? { notes: text(raw['notes'], 4000)! } : {}),
    ...(georef !== undefined ? { georef } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The working scale of an analysis from its image sizes. Every analysis has
 * effectiveScaleFactor = working width / photo width (shrinking, enlarging and reduced-size
 * decoding all keep this), and the heights must agree up to rounding (a few px, or 1% for a
 * photo decoded at reduced size); otherwise null.
 */
export function workingScaleFromSizes(wi: { width: number; height: number; originalWidth: number; originalHeight: number }): number | null {
  const s = wi.width / wi.originalWidth;
  if (!(s > 0) || !Number.isFinite(s)) return null;
  return Math.abs(wi.height - wi.originalHeight * s) <= 3 + 0.01 * wi.height ? s : null;
}
