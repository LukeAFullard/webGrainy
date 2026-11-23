/**
 * .webgrainy project archives: export a site with its photos and results, and import one
 * with every field validated (untrusted input).
 */
import type { SerializedAnalysisSession } from '../types/index.js';
import { clampRecordTime, sanitizeSiteOptions } from './siteOptions.js';
import {
  sanitizeCalibration,
  sanitizePhotoAnalysisConfig,
  sanitizePhotoMetadata,
  sanitizeProvenance,
  sanitizeRecommendation,
  sanitizeRoi,
  workingScaleFromSizes,
} from './archiveSanitize.js';
import { modelKindOf } from './modelCache.js';
import { placeName } from './sitePlaces.js';
import { isIsoDate } from './surveyDate.js';
import { scaleModeLabel } from './imagePreprocess.js';
import {
  getPhoto,
  getPhotoResult,
  getSite,
  listSitePhotos,
  listSites,
  deletePhoto,
  savePhoto,
  savePhotoResult,
  saveSite,
  type PhotoOriginalBackup,
  type PhotoRectifyBackup,
  type PhotoRecord,
  type PhotoResultRecord,
  type ProjectStorageOptions,
  type SiteRecord,
} from './projectDb.js';

interface ArchivedPhotoBackup extends Omit<PhotoOriginalBackup, 'imageBlob'> {
  imageBase64?: string;
  imageRef?: ArchiveRef;
  imageMimeType: string;
}

/** The photo before rectification, with the enhancement backup it had then. */
interface ArchivedRectifyBackup extends ArchivedPhotoBackup {
  originalBackup?: ArchivedPhotoBackup;
}

/** Byte range in a v2 archive's binary payload (after the header). */
interface ArchiveRef {
  offset: number;
  length: number;
}

interface ArchivedPhotoRecord extends Omit<PhotoRecord, 'imageBlob' | 'originalBackup' | 'rectifyBackup'> {
  /** v1: image bytes as base64. v2: `imageRef` into the binary payload instead. */
  imageBase64?: string;
  imageRef?: ArchiveRef;
  imageMimeType: string;
  /** The photo before enhancement (so "Revert" still works after an export/import). */
  originalBackup?: ArchivedPhotoBackup;
  /** The photo before rectification (so "Undo rectify" still works after an export/import). */
  rectifyBackup?: ArchivedRectifyBackup;
}

const ARCHIVE_IMAGE_MIME = /^image\/(jpeg|png|webp|gif|bmp|tiff|avif)$/i;
function archiveMime(m: unknown): string {
  return typeof m === 'string' && ARCHIVE_IMAGE_MIME.test(m) ? m : 'application/octet-stream';
}

interface ArchivedSerializedSession
  extends Omit<SerializedAnalysisSession, 'workingMasks' | 'workingImage'> {
  /** v1 */
  workingMasksBase64?: string;
  /** v2: little-endian Int32 label mask in the binary payload. */
  workingMasksRef?: ArchiveRef;
  workingImage: Omit<SerializedAnalysisSession['workingImage'], 'data'> & {
    /** JSON format (may be empty: sessions do not keep the working pixels). */
    dataBase64?: string;
    dataRef?: ArchiveRef;
  };
}

interface ArchivedResultRecord
  extends Omit<PhotoResultRecord, 'serializedSession'> {
  serializedSession?: ArchivedSerializedSession;
}

export interface ProjectArchiveV1 {
  format: 'webgrainy-project';
  version: 1;
  exportedAt: string;
  site: SiteRecord;
  photos: ArchivedPhotoRecord[];
  results: ArchivedResultRecord[];
}


function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function deserializeSessionFromArchive(
  archived: ArchivedSerializedSession,
  bytes?: { masks: Uint8Array; image: Uint8Array },
): SerializedAnalysisSession {
  const maskBytes = bytes?.masks ?? base64ToUint8(archived.workingMasksBase64 ?? '');
  if (maskBytes.byteLength % 4 !== 0) {
    throw new Error('Corrupt archived workingMasks buffer length.');
  }
  const workingMasks = new Int32Array(
    maskBytes.buffer,
    maskBytes.byteOffset,
    maskBytes.byteLength / 4,
  ).slice();

  const imgBytes = bytes?.image ?? base64ToUint8(archived.workingImage.dataBase64 ?? '');
  const workingImageData = new Uint8ClampedArray(imgBytes);

  // Only the known working-image fields, with the working scale taken from the image sizes
  // (a stored scale that disagrees would rescale every measurement).
  const wi = archived.workingImage;
  const scale = workingScaleFromSizes(wi);
  if (scale === null) {
    throw new ArchiveValidationError('analysis image sizes are inconsistent (working and photo sizes do not match).');
  }
  const provenance = sanitizeProvenance(archived.provenance, scale);
  const calibration = sanitizeCalibration(archived.calibration);

  return {
    version: archived.version,
    workingMasks,
    workingImage: {
      data: workingImageData,
      width: wi.width,
      height: wi.height,
      originalWidth: wi.originalWidth,
      originalHeight: wi.originalHeight,
      effectiveScaleFactor: scale,
      scaleModeApplied: scaleModeLabel(scale),
    },
    recommendation: sanitizeRecommendation(archived.recommendation, provenance !== undefined ? modelKindOf(provenance.modelId) : 'unet'),
    ...(calibration !== undefined ? { calibration } : {}),
    excludeBorder: archived.excludeBorder,
    borderMargin: archived.borderMargin,
    ...(provenance !== undefined ? { provenance } : {}),
    ...(typeof archived.manualEdits === 'number' && Number.isFinite(archived.manualEdits) && archived.manualEdits >= 0
      ? { manualEdits: Math.min(1e9, Math.floor(archived.manualEdits)) }
      : {}),
  };
}

/** Project archive file names: .webgrainy (binary) or .webgrainy.json / .json (JSON format). */
export function isProjectArchiveFileName(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.webgrainy') || n.endsWith('.json');
}

/** First 8 bytes of a v2 (binary) project archive. */
export const ARCHIVE_V2_MAGIC = 'WGRAINY2';
/** Largest accepted v2 header (JSON metadata only; images and masks are binary). */
export const MAX_ARCHIVE_HEADER_BYTES = 64 * 1024 * 1024;

/**
 * Exports a site as a `.webgrainy` project archive (format version 2):
 *
 *   "WGRAINY2" | uint32 LE header length | UTF-8 JSON header | binary payload
 *
 * The header is the v1 archive JSON with every image and mask replaced by an
 * `{offset, length}` reference into the payload (photos and backups as their original
 * encoded files, label masks as little-endian Int32). The file is assembled from the
 * stored Blobs without building one large string, so there is no size limit from the
 * browser's maximum string length (~512 MB, about 40 photos in the old JSON format), and
 * no base64 overhead.
 */
export async function exportProjectArchive(
  siteId: string,
  options?: ProjectStorageOptions,
): Promise<Blob> {
  const site = await getSite(siteId, options);
  if (!site) {
    throw new Error(`Site "${siteId}" not found in IndexedDB.`);
  }

  const photos = await listSitePhotos(siteId, options);
  const parts: BlobPart[] = [];
  let offset = 0;
  const addPart = (part: Blob | Uint8Array): ArchiveRef => {
    const length = part instanceof Blob ? part.size : part.byteLength;
    parts.push(part as BlobPart);
    const ref = { offset, length };
    offset += length;
    return ref;
  };
  const archivedPhotos: ArchivedPhotoRecord[] = [];
  const archivedResults: ArchivedResultRecord[] = [];

  for (const photo of photos) {
    const { imageBlob, originalBackup, rectifyBackup, ...restPhoto } = photo;
    const archiveBackup = (b: PhotoOriginalBackup): ArchivedPhotoBackup => {
      const { imageBlob: backupBlob, ...restBackup } = b;
      return { ...restBackup, imageRef: addPart(backupBlob), imageMimeType: backupBlob.type || 'application/octet-stream' };
    };
    const archivedBackup = originalBackup !== undefined ? archiveBackup(originalBackup) : undefined;
    let archivedRectify: ArchivedRectifyBackup | undefined;
    if (rectifyBackup !== undefined) {
      const { originalBackup: innerBackup, ...rectifyRest } = rectifyBackup;
      archivedRectify = {
        ...archiveBackup(rectifyRest),
        ...(innerBackup !== undefined ? { originalBackup: archiveBackup(innerBackup) } : {}),
      };
    }
    archivedPhotos.push({
      ...restPhoto,
      imageRef: addPart(imageBlob),
      imageMimeType: imageBlob.type || 'application/octet-stream',
      ...(archivedBackup !== undefined ? { originalBackup: archivedBackup } : {}),
      ...(archivedRectify !== undefined ? { rectifyBackup: archivedRectify } : {}),
    });

    const res = await getPhotoResult(photo.photoId, options);
    if (res !== undefined) {
      const { serializedSession, ...restRes } = res;
      let archivedSession: ArchivedSerializedSession | undefined;
      if (serializedSession !== undefined) {
        const m = serializedSession.workingMasks;
        const img = serializedSession.workingImage.data;
        const { data: _d, ...restImg } = serializedSession.workingImage;
        const { workingMasks: _m, workingImage: _w, ...restSession } = serializedSession;
        archivedSession = {
          ...restSession,
          workingMasksRef: addPart(int32ToLittleEndianBytes(m)),
          workingImage: {
            ...restImg,
            ...(img.length > 0 ? { dataRef: addPart(new Uint8Array(img.buffer, img.byteOffset, img.byteLength)) } : {}),
          },
        };
      }
      archivedResults.push({ ...restRes, ...(archivedSession !== undefined ? { serializedSession: archivedSession } : {}) });
    }
  }

  const header = {
    format: 'webgrainy-project',
    version: 2,
    exportedAt: new Date().toISOString(),
    payloadBytes: offset,
    site,
    photos: archivedPhotos,
    results: archivedResults,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, headerBytes.byteLength, true);
  return new Blob([new TextEncoder().encode(ARCHIVE_V2_MAGIC), lenBytes, headerBytes, ...parts], {
    type: 'application/octet-stream',
  });
}

/** Int32 label mask as little-endian bytes (independent of the platform's byte order). */
function int32ToLittleEndianBytes(a: Int32Array): Uint8Array {
  const out = new Uint8Array(a.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < a.length; i++) dv.setInt32(i * 4, a[i]!, true);
  return out;
}

function littleEndianBytesToInt32Bytes(b: Uint8Array): Uint8Array {
  // Returns bytes in platform order for `new Int32Array(buffer)`.
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Int32Array(b.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt32(i * 4, true);
  return new Uint8Array(out.buffer);
}

export const exportSiteArchive = exportProjectArchive;

/** Maximum accepted archive size (bytes of JSON text). */
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
/** Maximum accepted image / mask dimension in an archive. */
export const MAX_ARCHIVE_DIMENSION = 32768;
/** Most photos (and results) one project file may hold; far above any real survey. */
export const MAX_ARCHIVE_PHOTOS = 10_000;

class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(`Invalid webGrainy project archive: ${message}`);
    this.name = 'ArchiveValidationError';
  }
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Recursively removes prototype-pollution keys from parsed JSON. */
function stripDangerousKeys<T>(value: T, depth = 0): T {
  if (depth > 64 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const v of value) stripDangerousKeys(v, depth + 1);
    return value;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete (value as Record<string, unknown>)[key];
    } else {
      stripDangerousKeys((value as Record<string, unknown>)[key], depth + 1);
    }
  }
  return value;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDim = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MAX_ARCHIVE_DIMENSION;
const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256;

function validatePoint(p: unknown, ctx: string): void {
  if (!isObj(p) || !isFiniteNum(p['x']) || !isFiniteNum(p['y'])) {
    throw new ArchiveValidationError(`${ctx}: expected {x, y} finite numbers.`);
  }
}

function validateCalibration(c: unknown, ctx: string): void {
  if (c === undefined) return;
  if (!isObj(c) || !isFiniteNum(c['mmPerPx']) || (c['mmPerPx'] as number) <= 0) {
    throw new ArchiveValidationError(`${ctx}.calibration.mmPerPx must be a positive finite number.`);
  }
  validatePoint(c['pointA'], `${ctx}.calibration.pointA`);
  validatePoint(c['pointB'], `${ctx}.calibration.pointB`);
}

function validateRoi(r: unknown, ctx: string): void {
  if (r === undefined) return;
  if (!isObj(r)) throw new ArchiveValidationError(`${ctx}.roiConfig must be an object.`);
  const polys = r['exclusionPolygons'];
  const strokes = r['exclusionStrokes'];
  if (!Array.isArray(polys) || !Array.isArray(strokes)) {
    throw new ArchiveValidationError(`${ctx}.roiConfig requires exclusionPolygons and exclusionStrokes arrays.`);
  }
  for (const poly of polys) {
    if (!Array.isArray(poly)) throw new ArchiveValidationError(`${ctx}.roiConfig polygon must be an array.`);
    for (const pt of poly) validatePoint(pt, `${ctx}.roiConfig polygon`);
  }
  for (const st of strokes) {
    if (!isObj(st) || !Array.isArray(st['points']) || !isFiniteNum(st['radiusPx'])) {
      throw new ArchiveValidationError(`${ctx}.roiConfig stroke is malformed.`);
    }
    for (const pt of st['points'] as unknown[]) validatePoint(pt, `${ctx}.roiConfig stroke`);
  }
  if (r['roiPolygon'] !== undefined) {
    if (!Array.isArray(r['roiPolygon'])) throw new ArchiveValidationError(`${ctx}.roiPolygon must be an array.`);
    for (const pt of r['roiPolygon'] as unknown[]) validatePoint(pt, `${ctx}.roiPolygon`);
  }
}

function validateArchivedSession(
  ss: unknown,
  ctx: string,
  bytes?: { masks: Uint8Array; image: Uint8Array },
): SerializedAnalysisSession {
  if (!isObj(ss) || ss['version'] !== 1) {
    throw new ArchiveValidationError(`${ctx}: unsupported serialized session version.`);
  }
  const wi = ss['workingImage'];
  if (!isObj(wi) || !isDim(wi['width']) || !isDim(wi['height'])) {
    throw new ArchiveValidationError(`${ctx}: workingImage width/height must be integers in [1, ${MAX_ARCHIVE_DIMENSION}].`);
  }
  if (!isDim(wi['originalWidth']) || !isDim(wi['originalHeight'])) {
    throw new ArchiveValidationError(`${ctx}: workingImage originalWidth/originalHeight invalid.`);
  }
  const sf = wi['effectiveScaleFactor'];
  if (!isFiniteNum(sf) || sf <= 0 || sf > 4) {
    throw new ArchiveValidationError(`${ctx}: effectiveScaleFactor must be in (0, 4].`);
  }
  if (bytes === undefined && (typeof ss['workingMasksBase64'] !== 'string' || typeof wi['dataBase64'] !== 'string')) {
    throw new ArchiveValidationError(`${ctx}: missing base64 mask or image data.`);
  }
  if (!isObj(ss['recommendation'])) {
    throw new ArchiveValidationError(`${ctx}: missing recommendation.`);
  }
  if (typeof ss['excludeBorder'] !== 'boolean') {
    throw new ArchiveValidationError(`${ctx}: excludeBorder must be boolean.`);
  }
  const bm = ss['borderMargin'];
  // Same limit as the post-processing options (validatePostProcessOptions), so every project
  // the engine can produce can be restored.
  if (typeof bm !== 'number' || !Number.isInteger(bm) || bm < 0 || bm > 1000) {
    throw new ArchiveValidationError(`${ctx}: borderMargin must be an integer in [0, 1000].`);
  }
  validateCalibration(ss['calibration'], ctx);

  const w = wi['width'] as number;
  const h = wi['height'] as number;
  const session = deserializeSessionFromArchive(ss as unknown as ArchivedSerializedSession, bytes);
  if (session.workingMasks.length !== w * h) {
    throw new ArchiveValidationError(`${ctx}: mask length ${session.workingMasks.length} != ${w}x${h}.`);
  }
  // Empty is allowed: sessions do not keep the working-image pixels after analysis.
  if (session.workingImage.data.length !== 0 && session.workingImage.data.length !== w * h * 4) {
    throw new ArchiveValidationError(`${ctx}: RGBA image length ${session.workingImage.data.length} != ${w}x${h}x4.`);
  }
  return session;
}

/**
 * Imports a `.webgrainy` project archive (v2 binary, or a v1 `.webgrainy.json`) into IndexedDB and returns the imported `siteId`.
 *
 * The archive is fully validated and decoded before anything is written, so a
 * malformed file never leaves a partial import. If a site with the same `siteId`
 * already exists, the archive is imported under fresh site/photo ids (with
 * " (imported)" appended to the name) instead of overwriting the existing data.
 */
export async function importProjectArchive(
  archiveInput: Blob | string,
  options?: ProjectStorageOptions,
): Promise<string> {
  const size = typeof archiveInput === 'string' ? archiveInput.length : archiveInput.size;
  // v2 (binary): small JSON header + payload, read lazily with Blob.slice (no size limit
  // from string lengths). v1: one JSON text, limited to MAX_ARCHIVE_BYTES.
  let payload: Blob | null = null;
  let rawText: string;
  if (typeof archiveInput !== 'string' && size >= 12) {
    const head = new Uint8Array(await archiveInput.slice(0, 12).arrayBuffer());
    if (new TextDecoder().decode(head.subarray(0, 8)) === ARCHIVE_V2_MAGIC) {
      const headerLen = new DataView(head.buffer).getUint32(8, true);
      if (headerLen > MAX_ARCHIVE_HEADER_BYTES || 12 + headerLen > size) {
        throw new ArchiveValidationError('archive header is truncated or too large.');
      }
      rawText = await archiveInput.slice(12, 12 + headerLen).text();
      payload = archiveInput.slice(12 + headerLen);
    }
  }
  if (payload === null) {
    if (size > MAX_ARCHIVE_BYTES) {
      throw new ArchiveValidationError(
        `file is ${(size / 1e6).toFixed(0)} MB; maximum is ${(MAX_ARCHIVE_BYTES / 1e6).toFixed(0)} MB.`,
      );
    }
    rawText = typeof archiveInput === 'string' ? archiveInput : await archiveInput.text();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText!);
  } catch (err) {
    throw new Error(
      `Invalid webGrainy project archive: ${err instanceof Error ? err.message : 'JSON parse error'}`,
    );
  }
  /** The payload bytes a v2 reference points to (validated against the payload size). */
  const refSlice = (ref: unknown, ctx: string, type = ''): Blob => {
    if (
      payload === null ||
      !isObj(ref) ||
      typeof ref['offset'] !== 'number' ||
      typeof ref['length'] !== 'number' ||
      !Number.isInteger(ref['offset']) ||
      !Number.isInteger(ref['length']) ||
      ref['offset'] < 0 ||
      ref['length'] < 0 ||
      ref['offset'] + ref['length'] > payload.size
    ) {
      throw new ArchiveValidationError(`${ctx}: invalid byte reference.`);
    }
    return payload.slice(ref['offset'], ref['offset'] + ref['length'], type);
  };

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid webGrainy project archive: expected a JSON header object.');
  }
  stripDangerousKeys(parsed);

  const arch = parsed as Partial<ProjectArchiveV1>;
  const archVersion = (arch as { version?: unknown }).version;
  if (arch.format !== 'webgrainy-project' || !((archVersion === 1 && payload === null) || (archVersion === 2 && payload !== null))) {
    throw new Error(
      `Unsupported archive format or version: format=${String(arch.format)}, version=${String(arch.version)}.`,
    );
  }
  if (!arch.site || !isId(arch.site.siteId)) {
    throw new Error('Invalid archive: missing site.siteId.');
  }
  if (!Array.isArray(arch.photos) || !Array.isArray(arch.results)) {
    throw new Error('Invalid archive: missing photos or results array.');
  }
  if (arch.photos.length > MAX_ARCHIVE_PHOTOS || arch.results.length > MAX_ARCHIVE_PHOTOS) {
    throw new ArchiveValidationError(`a site holds at most ${MAX_ARCHIVE_PHOTOS} photos.`);
  }
  if (typeof arch.site.name !== 'string' || !Array.isArray(arch.site.photoOrder) || !isObj(arch.site.options)) {
    throw new ArchiveValidationError('site requires name, photoOrder[] and options{}.');
  }
  if (arch.site.place !== undefined && (typeof arch.site.place !== 'string' || arch.site.place.length > 256)) {
    delete (arch.site as { place?: unknown }).place; // unreadable place: import as an ungrouped site
  }
  if (arch.site.surveyDate !== undefined && !isIsoDate(arch.site.surveyDate)) {
    delete (arch.site as { surveyDate?: unknown }).surveyDate; // unreadable date: fall back to photo dates
  }

  // ---- Phase 1: validate + decode everything in memory --------------------------
  // Record times from outside the app are kept within [0, now] (a future date pins a site first).
  const importNow = Date.now();
  const decodedPhotos: PhotoRecord[] = [];
  const photoIds = new Set<string>();
  for (const [i, ap] of arch.photos.entries()) {
    const ctx = `photos[${i}]`;
    if (!ap || !isId(ap.photoId) || (payload === null ? typeof ap.imageBase64 !== 'string' : ap.imageRef === undefined)) {
      throw new Error('Invalid archive: corrupt photo record.');
    }
    if (photoIds.has(ap.photoId)) throw new ArchiveValidationError(`${ctx}: duplicate photoId.`);
    photoIds.add(ap.photoId);
    if (typeof ap.label !== 'string' || ap.label.length > 1024) {
      throw new ArchiveValidationError(`${ctx}.label must be a string (<= 1024 chars).`);
    }
    if (!isDim(ap.width) || !isDim(ap.height)) {
      throw new ArchiveValidationError(`${ctx}: width/height must be integers in [1, ${MAX_ARCHIVE_DIMENSION}].`);
    }
    if (ap.faciesWeight !== undefined && (!isFiniteNum(ap.faciesWeight) || ap.faciesWeight < 0)) {
      throw new ArchiveValidationError(`${ctx}.faciesWeight must be a non-negative number.`);
    }
    validateCalibration(ap.calibration, ctx);
    validateRoi(ap.roiConfig, ctx);
    const { imageRef, imageMimeType, originalBackup: archivedBackup, rectifyBackup: archivedRectify } = ap;
    const imageBlob =
      payload !== null
        ? refSlice(imageRef, ctx, archiveMime(imageMimeType))
        : new Blob([base64ToUint8(ap.imageBase64!).slice().buffer], { type: archiveMime(imageMimeType) });
    const decodeBackup = (archived: ArchivedPhotoBackup, bctx: string): PhotoOriginalBackup => {
      if (typeof archived !== 'object' || (payload === null ? typeof archived.imageBase64 !== 'string' : archived.imageRef === undefined)) {
        throw new ArchiveValidationError(`${bctx}: missing image data.`);
      }
      if (!isDim(archived.width) || !isDim(archived.height)) {
        throw new ArchiveValidationError(`${bctx}: width/height must be integers in [1, ${MAX_ARCHIVE_DIMENSION}].`);
      }
      validateCalibration(archived.calibration, bctx);
      validateRoi(archived.roiConfig, bctx);
      const { imageBase64: backupB64, imageRef: backupRef, imageMimeType: backupMime } = archived;
      const backupCal = sanitizeCalibration(archived.calibration);
      const backupRoi = sanitizeRoi(archived.roiConfig);
      const backupMeta = sanitizePhotoMetadata(archived.metadata);
      return {
        width: archived.width,
        height: archived.height,
        ...(backupCal !== undefined ? { calibration: backupCal } : {}),
        ...(backupRoi !== undefined ? { roiConfig: backupRoi } : {}),
        ...(backupMeta !== undefined ? { metadata: backupMeta } : {}),
        imageBlob:
          payload !== null
            ? refSlice(backupRef, bctx, archiveMime(backupMime))
            : new Blob([base64ToUint8(backupB64!).slice().buffer], { type: archiveMime(backupMime) }),
      };
    };
    const originalBackup =
      archivedBackup !== undefined && archivedBackup !== null ? decodeBackup(archivedBackup, `${ctx}.originalBackup`) : undefined;
    let rectifyBackup: PhotoRectifyBackup | undefined;
    if (archivedRectify !== undefined && archivedRectify !== null) {
      const inner = archivedRectify.originalBackup;
      rectifyBackup = {
        ...decodeBackup(archivedRectify, `${ctx}.rectifyBackup`),
        ...(inner !== undefined && inner !== null ? { originalBackup: decodeBackup(inner, `${ctx}.rectifyBackup.originalBackup`) } : {}),
      };
    }
    // Only the fields the app writes, each checked: imported text must never reach the page as
    // markup, and hidden settings must not change later analyses or statistics.
    const calibration = sanitizeCalibration(ap.calibration);
    const roiConfig = sanitizeRoi(ap.roiConfig);
    const analysisConfig = sanitizePhotoAnalysisConfig(ap.analysisConfig);
    const metadata = sanitizePhotoMetadata(ap.metadata);
    decodedPhotos.push({
      photoId: ap.photoId,
      siteId: arch.site.siteId,
      label: ap.label,
      width: ap.width,
      height: ap.height,
      addedAt: clampRecordTime(ap.addedAt, importNow),
      included: ap.included !== false,
      ...(ap.faciesWeight !== undefined ? { faciesWeight: Math.min(ap.faciesWeight, 1e6) } : {}),
      ...(calibration !== undefined ? { calibration } : {}),
      ...(roiConfig !== undefined ? { roiConfig } : {}),
      ...(analysisConfig !== undefined ? { analysisConfig } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      imageBlob,
      ...(originalBackup !== undefined ? { originalBackup } : {}),
      ...(rectifyBackup !== undefined ? { rectifyBackup } : {}),
    });
  }

  const decodedResults: PhotoResultRecord[] = [];
  const maskRefsSeen = new Set<number>();
  for (const [i, ar] of arch.results.entries()) {
    const ctx = `results[${i}]`;
    if (!ar || !isId(ar.photoId)) {
      throw new Error('Invalid archive: corrupt result record.');
    }
    if (!['pending', 'running', 'done', 'error'].includes(ar.status as string)) {
      throw new ArchiveValidationError(`${ctx}.status is invalid.`);
    }
    const { serializedSession } = ar;
    let bytes: { masks: Uint8Array; image: Uint8Array } | undefined;
    if (payload !== null && serializedSession !== undefined) {
      const ss = serializedSession as unknown as Record<string, unknown>;
      const wi = isObj(ss['workingImage']) ? ss['workingImage'] : {};
      // Check the mask's size against its image, and that no two results share one mask, before
      // reading any bytes: a crafted file could otherwise make every result decode one huge part.
      const maskBlob = refSlice(ss['workingMasksRef'], `${ctx}.workingMasksRef`);
      if (!isDim(wi['width']) || !isDim(wi['height']) || maskBlob.size !== wi['width'] * wi['height'] * 4) {
        throw new ArchiveValidationError(`${ctx}: mask size does not match its working image.`);
      }
      const maskOffset = (ss['workingMasksRef'] as ArchiveRef).offset;
      if (maskOffset !== undefined && maskBlob.size > 0) {
        if (maskRefsSeen.has(maskOffset)) throw new ArchiveValidationError(`${ctx}: mask bytes shared with another result.`);
        maskRefsSeen.add(maskOffset);
      }
      const masks = new Uint8Array(await maskBlob.arrayBuffer());
      bytes = {
        masks: littleEndianBytesToInt32Bytes(masks),
        image: wi['dataRef'] !== undefined ? new Uint8Array(await refSlice(wi['dataRef'], `${ctx}.dataRef`).arrayBuffer()) : new Uint8Array(0),
      };
    }
    const errorMessage = typeof ar.errorMessage === 'string' ? ar.errorMessage.slice(0, 2000) : undefined;
    decodedResults.push({
      photoId: ar.photoId,
      status: ar.status,
      updatedAt: clampRecordTime(ar.updatedAt, importNow),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(serializedSession !== undefined
        ? { serializedSession: validateArchivedSession(serializedSession, ctx, bytes) }
        : {}),
    });
  }

  const importedPhotoIds = new Set(decodedPhotos.map((p) => p.photoId));

  // ---- Phase 2: resolve id collisions (never overwrite existing data) -----------
  // Untrusted settings and dates: only values the app can set (an unbounded bootstrap count froze
  // the page on every start-up), and no record times in the future (they pin the site first).
  let site: SiteRecord = {
    siteId: arch.site.siteId,
    name: arch.site.name.slice(0, 1024),
    // Only photos in this file, each once (a dangling or repeated id would list a missing photo).
    photoOrder: [...new Set(arch.site.photoOrder.filter((id): id is string => isId(id) && importedPhotoIds.has(id)))],
    ...(typeof arch.site.place === 'string' ? { place: arch.site.place } : {}),
    ...(typeof arch.site.surveyDate === 'string' ? { surveyDate: arch.site.surveyDate } : {}),
    options: sanitizeSiteOptions(arch.site.options),
    createdAt: clampRecordTime(arch.site.createdAt, importNow),
    updatedAt: clampRecordTime(arch.site.updatedAt, importNow),
  };
  const existing = await getSite(site.siteId, options);
  // A photo id already in storage (e.g. the same archive imported into a renamed site) must
  // never be overwritten either, nor removed by a failed import's rollback.
  let photoClash = false;
  for (const p of decodedPhotos) {
    if ((await getPhoto(p.photoId, options)) !== undefined) {
      photoClash = true;
      break;
    }
  }
  if (existing !== undefined || photoClash) {
    const suffix = `_imp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const idMap = new Map<string, string>();
    for (const p of decodedPhotos) idMap.set(p.photoId, `${p.photoId}${suffix}`);
    const newSiteId = `${site.siteId}${suffix}`;
    site = {
      ...site,
      siteId: newSiteId,
      name: `${site.name} (imported)`,
      photoOrder: site.photoOrder.map((id) => idMap.get(id) ?? id),
    };
    for (const p of decodedPhotos) {
      p.photoId = idMap.get(p.photoId)!;
      p.siteId = newSiteId;
    }
    for (const r of decodedResults) {
      r.photoId = idMap.get(r.photoId) ?? r.photoId;
    }
  }

  // Tidy the place name and reuse an existing place's spelling (case and spacing ignored),
  // as the Site panel does, so an imported survey joins its place's other surveys.
  const importedPlace = placeName(site.place);
  if (importedPlace === null) {
    delete (site as { place?: string }).place;
  } else {
    const existingPlace = (await listSites(options))
      .map((x) => placeName(x.place))
      .find((p) => p !== null && p.toLowerCase() === importedPlace.toLowerCase());
    site = { ...site, place: existingPlace ?? importedPlace };
  }

  // Every imported photo belongs to the imported site (an inconsistent archive would
  // otherwise leave orphaned photos).
  for (const p of decodedPhotos) p.siteId = site.siteId;

  // ---- Phase 3: write (all or nothing) ---------------------------------------------
  // Photos and results first, the site record last, so a partly written import never shows
  // up as a site. On any failure everything written so far is removed again.
  const written: string[] = [];
  try {
    for (const p of decodedPhotos) {
      written.push(p.photoId);
      await savePhoto(p, options);
    }
    // Results only for photos in this archive (orphans could touch other photos' results).
    for (const r of decodedResults) {
      if (!written.includes(r.photoId)) continue;
      await savePhotoResult(r, options);
    }
    await saveSite(site, options);
  } catch (err) {
    for (const id of written) await deletePhoto(id, options).catch(() => undefined);
    throw err;
  }

  return site.siteId;
}

export const importSiteArchive = importProjectArchive;
