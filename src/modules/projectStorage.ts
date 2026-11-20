import type {
  AnalysisConfig,
  CalibrationResult,
  SerializedAnalysisSession,
} from '../types/index.js';
import { placeName } from './sitePlaces.js';
import { isIsoDate } from './surveyDate.js';
import type { ImageBufferLike } from './imagePreprocess.js';
import type { AnalysisSession, ImageGrainsEngine } from './pipelineController.js';
import type { RoiExclusionConfig } from './roiAndRectify.js';
import type { SiteAnalysisOptions, SitePhotoMetadata } from './siteAnalysis.js';

export const PROJECT_DB_NAME = 'imagegrains-projects-v1';
export const PROJECT_DB_VERSION = 1;
export const SITE_STORE_NAME = 'sites';
export const PHOTO_STORE_NAME = 'photos';
export const RESULT_STORE_NAME = 'results';

export interface ProjectStorageOptions {
  indexedDB?: IDBFactory;
}

export interface SiteRecord {
  siteId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  options: SiteAnalysisOptions;
  photoOrder: string[];
  /** Survey date (YYYY-MM-DD) set by the user; otherwise the earliest photo date is used. */
  surveyDate?: string;
  /**
   * Place (location) this survey belongs to. Repeat surveys of the same place share it, so
   * they are grouped in the site list and shown as one series over time.
   */
  place?: string;
}

export interface PhotoOriginalBackup {
  imageBlob: Blob;
  width: number;
  height: number;
  calibration?: CalibrationResult;
  roiConfig?: RoiExclusionConfig;
  metadata?: SitePhotoMetadata;
}

export interface PhotoRecord {
  photoId: string;
  siteId: string;
  label: string;
  imageBlob: Blob;
  width: number;
  height: number;
  addedAt: number;
  included: boolean;
  faciesWeight?: number;
  calibration?: CalibrationResult;
  roiConfig?: RoiExclusionConfig;
  analysisConfig?: Omit<AnalysisConfig, 'signal' | 'onProgress' | 'calibration'>;
  metadata?: SitePhotoMetadata;
  /** Preserved original photo before optional AI enhancement, enabling 1-click revert. */
  originalBackup?: PhotoOriginalBackup;
}

export type PhotoProcessStatus = 'pending' | 'running' | 'done' | 'error';

export interface PhotoResultRecord {
  photoId: string;
  status: PhotoProcessStatus;
  errorMessage?: string;
  serializedSession?: SerializedAnalysisSession;
  updatedAt: number;
}

interface ArchivedPhotoBackup extends Omit<PhotoOriginalBackup, 'imageBlob'> {
  imageBase64?: string;
  imageRef?: ArchiveRef;
  imageMimeType: string;
}

/** Byte range in a v2 archive's binary payload (after the header). */
interface ArchiveRef {
  offset: number;
  length: number;
}

interface ArchivedPhotoRecord extends Omit<PhotoRecord, 'imageBlob' | 'originalBackup'> {
  /** v1: image bytes as base64. v2: `imageRef` into the binary payload instead. */
  imageBase64?: string;
  imageRef?: ArchiveRef;
  imageMimeType: string;
  /** The photo before enhancement (so "Revert" still works after an export/import). */
  originalBackup?: ArchivedPhotoBackup;
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

function getIdbFactory(options?: ProjectStorageOptions): IDBFactory {
  const idb = options?.indexedDB ?? globalThis.indexedDB;
  if (idb === undefined) {
    throw new Error('IndexedDB is not available in this environment.');
  }
  return idb;
}

function openProjectDatabase(options?: ProjectStorageOptions): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = getIdbFactory(options);
    const request = idb.open(PROJECT_DB_NAME, PROJECT_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SITE_STORE_NAME)) {
        db.createObjectStore(SITE_STORE_NAME, { keyPath: 'siteId' });
      }
      if (!db.objectStoreNames.contains(PHOTO_STORE_NAME)) {
        const photoStore = db.createObjectStore(PHOTO_STORE_NAME, {
          keyPath: 'photoId',
        });
        if (typeof photoStore.createIndex === 'function') {
          photoStore.createIndex('siteId', 'siteId', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(RESULT_STORE_NAME)) {
        db.createObjectStore(RESULT_STORE_NAME, { keyPath: 'photoId' });
      }
    };

    request.onerror = () => {
      reject(
        request.error ??
          new Error(`Failed to open IndexedDB database "${PROJECT_DB_NAME}".`),
      );
    };

    request.onblocked = () => {
      reject(
        new Error(
          `IndexedDB open request for "${PROJECT_DB_NAME}" was blocked.`,
        ),
      );
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab is upgrading the schema: release our connection instead of
      // blocking it forever (the next operation reopens at the new version).
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
  });
}

async function runStoreRequest<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  options?: ProjectStorageOptions,
): Promise<T> {
  const db = await openProjectDatabase(options);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = fn(store);

      let settled = false;
      let hasResult = false;
      let resultValue: T;

      req.onsuccess = () => {
        resultValue = req.result;
        hasResult = true;
      };

      req.onerror = () => {
        if (settled) return;
        settled = true;
        reject(req.error ?? new Error(`IndexedDB error in store "${storeName}".`));
      };

      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(hasResult ? resultValue : (undefined as unknown as T));
      };

      tx.onerror = () => {
        if (settled) return;
        settled = true;
        reject(tx.error ?? new Error(`IndexedDB transaction error in "${storeName}".`));
      };

      tx.onabort = () => {
        if (settled) return;
        settled = true;
        reject(tx.error ?? new Error(`IndexedDB transaction aborted in "${storeName}".`));
      };
    });
  } finally {
    db.close();
  }
}

export async function saveSite(
  site: SiteRecord,
  options?: ProjectStorageOptions,
): Promise<void> {
  await runStoreRequest(
    SITE_STORE_NAME,
    'readwrite',
    (store) => store.put(site),
    options,
  );
}

export async function getSite(
  siteId: string,
  options?: ProjectStorageOptions,
): Promise<SiteRecord | undefined> {
  return runStoreRequest(
    SITE_STORE_NAME,
    'readonly',
    (store) => store.get(siteId) as IDBRequest<SiteRecord | undefined>,
    options,
  );
}

export async function listSites(
  options?: ProjectStorageOptions,
): Promise<SiteRecord[]> {
  const sites = await runStoreRequest(
    SITE_STORE_NAME,
    'readonly',
    (store) => store.getAll() as IDBRequest<SiteRecord[]>,
    options,
  );
  return [...sites].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function savePhoto(
  photo: PhotoRecord,
  options?: ProjectStorageOptions,
): Promise<void> {
  await runStoreRequest(
    PHOTO_STORE_NAME,
    'readwrite',
    (store) => store.put(photo),
    options,
  );
}

export async function getPhoto(
  photoId: string,
  options?: ProjectStorageOptions,
): Promise<PhotoRecord | undefined> {
  return runStoreRequest(
    PHOTO_STORE_NAME,
    'readonly',
    (store) => store.get(photoId) as IDBRequest<PhotoRecord | undefined>,
    options,
  );
}

export async function listSitePhotos(
  siteId: string,
  options?: ProjectStorageOptions,
): Promise<PhotoRecord[]> {
  const db = await openProjectDatabase(options);
  try {
    return await new Promise<PhotoRecord[]>((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE_NAME, 'readonly');
      const store = tx.objectStore(PHOTO_STORE_NAME);
      let req: IDBRequest<PhotoRecord[]>;
      let usedIndex = false;

      if (typeof store.index === 'function') {
        try {
          const idx = store.index('siteId');
          req = idx.getAll(siteId) as IDBRequest<PhotoRecord[]>;
          usedIndex = true;
        } catch {
          req = store.getAll() as IDBRequest<PhotoRecord[]>;
        }
      } else {
        req = store.getAll() as IDBRequest<PhotoRecord[]>;
      }

      let settled = false;
      let result: PhotoRecord[] = [];

      req.onsuccess = () => {
        const all = req.result ?? [];
        result = usedIndex ? all : all.filter((p) => p.siteId === siteId);
      };

      req.onerror = () => {
        if (settled) return;
        settled = true;
        reject(req.error ?? new Error('Failed to list site photos.'));
      };

      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      tx.onerror = () => {
        if (settled) return;
        settled = true;
        reject(tx.error ?? new Error('Transaction failed listing site photos.'));
      };
    });
  } finally {
    db.close();
  }
}

export async function savePhotoResult(
  result: PhotoResultRecord,
  options?: ProjectStorageOptions,
): Promise<void> {
  await runStoreRequest(
    RESULT_STORE_NAME,
    'readwrite',
    (store) => store.put(result),
    options,
  );
}

export async function getPhotoResult(
  photoId: string,
  options?: ProjectStorageOptions,
): Promise<PhotoResultRecord | undefined> {
  return runStoreRequest(
    RESULT_STORE_NAME,
    'readonly',
    (store) => store.get(photoId) as IDBRequest<PhotoResultRecord | undefined>,
    options,
  );
}

export async function deletePhoto(
  photoId: string,
  options?: ProjectStorageOptions,
): Promise<void> {
  await runStoreRequest(
    PHOTO_STORE_NAME,
    'readwrite',
    (store) => store.delete(photoId),
    options,
  );
  await runStoreRequest(
    RESULT_STORE_NAME,
    'readwrite',
    (store) => store.delete(photoId),
    options,
  );
}

export async function deleteSite(
  siteId: string,
  options?: ProjectStorageOptions,
): Promise<void> {
  const photos = await listSitePhotos(siteId, options);
  for (const photo of photos) {
    await deletePhoto(photo.photoId, options);
  }
  await runStoreRequest(
    SITE_STORE_NAME,
    'readwrite',
    (store) => store.delete(siteId),
    options,
  );
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

  const { dataBase64: _ignored, dataRef: _ignoredRef, ...restImg } = archived.workingImage;

  return {
    version: archived.version,
    workingMasks,
    workingImage: {
      ...restImg,
      data: workingImageData,
    },
    recommendation: archived.recommendation,
    ...(archived.calibration !== undefined
      ? { calibration: archived.calibration }
      : {}),
    excludeBorder: archived.excludeBorder,
    borderMargin: archived.borderMargin,
    ...(archived.provenance !== undefined ? { provenance: archived.provenance } : {}),
    ...(typeof archived.manualEdits === 'number' && Number.isFinite(archived.manualEdits) && archived.manualEdits >= 0
      ? { manualEdits: Math.floor(archived.manualEdits) }
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
    const { imageBlob, originalBackup, ...restPhoto } = photo;
    let archivedBackup: ArchivedPhotoBackup | undefined;
    if (originalBackup !== undefined) {
      const { imageBlob: backupBlob, ...restBackup } = originalBackup;
      archivedBackup = {
        ...restBackup,
        imageRef: addPart(backupBlob),
        imageMimeType: backupBlob.type || 'application/octet-stream',
      };
    }
    archivedPhotos.push({
      ...restPhoto,
      imageRef: addPart(imageBlob),
      imageMimeType: imageBlob.type || 'application/octet-stream',
      ...(archivedBackup !== undefined ? { originalBackup: archivedBackup } : {}),
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
    const { imageBase64: _b64, imageRef, imageMimeType, originalBackup: archivedBackup, ...restPhoto } = ap;
    const imageBlob =
      payload !== null
        ? refSlice(imageRef, ctx, archiveMime(imageMimeType))
        : new Blob([base64ToUint8(ap.imageBase64!).slice().buffer], { type: archiveMime(imageMimeType) });
    let originalBackup: PhotoOriginalBackup | undefined;
    if (archivedBackup !== undefined && archivedBackup !== null) {
      const bctx = `${ctx}.originalBackup`;
      if (typeof archivedBackup !== 'object' || (payload === null ? typeof archivedBackup.imageBase64 !== 'string' : archivedBackup.imageRef === undefined)) {
        throw new ArchiveValidationError(`${bctx}: missing image data.`);
      }
      if (!isDim(archivedBackup.width) || !isDim(archivedBackup.height)) {
        throw new ArchiveValidationError(`${bctx}: width/height must be integers in [1, ${MAX_ARCHIVE_DIMENSION}].`);
      }
      validateCalibration(archivedBackup.calibration, bctx);
      validateRoi(archivedBackup.roiConfig, bctx);
      const { imageBase64: backupB64, imageRef: backupRef, imageMimeType: backupMime, ...restBackup } = archivedBackup;
      originalBackup = {
        ...restBackup,
        imageBlob:
          payload !== null
            ? refSlice(backupRef, bctx, archiveMime(backupMime))
            : new Blob([base64ToUint8(backupB64!).slice().buffer], { type: archiveMime(backupMime) }),
      };
    }
    decodedPhotos.push({
      ...restPhoto,
      included: ap.included !== false,
      imageBlob,
      ...(originalBackup !== undefined ? { originalBackup } : {}),
    });
  }

  const decodedResults: PhotoResultRecord[] = [];
  for (const [i, ar] of arch.results.entries()) {
    const ctx = `results[${i}]`;
    if (!ar || !isId(ar.photoId)) {
      throw new Error('Invalid archive: corrupt result record.');
    }
    if (!['pending', 'running', 'done', 'error'].includes(ar.status as string)) {
      throw new ArchiveValidationError(`${ctx}.status is invalid.`);
    }
    const { serializedSession, ...restRes } = ar;
    let bytes: { masks: Uint8Array; image: Uint8Array } | undefined;
    if (payload !== null && serializedSession !== undefined) {
      const ss = serializedSession as unknown as Record<string, unknown>;
      const wi = isObj(ss['workingImage']) ? ss['workingImage'] : {};
      const masks = new Uint8Array(await refSlice(ss['workingMasksRef'], `${ctx}.workingMasksRef`).arrayBuffer());
      if (masks.byteLength % 4 !== 0) throw new ArchiveValidationError(`${ctx}: corrupt mask bytes.`);
      bytes = {
        masks: littleEndianBytesToInt32Bytes(masks),
        image: wi['dataRef'] !== undefined ? new Uint8Array(await refSlice(wi['dataRef'], `${ctx}.dataRef`).arrayBuffer()) : new Uint8Array(0),
      };
    }
    decodedResults.push({
      ...restRes,
      ...(serializedSession !== undefined
        ? { serializedSession: validateArchivedSession(serializedSession, ctx, bytes) }
        : {}),
    });
  }

  // ---- Phase 2: resolve id collisions (never overwrite existing data) -----------
  let site: SiteRecord = { ...arch.site };
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

export interface BatchRunOptions extends ProjectStorageOptions {
  siteId: string;
  engine: ImageGrainsEngine;
  photoIds?: readonly string[];
  analysisConfig?: Omit<AnalysisConfig, 'signal' | 'onProgress' | 'calibration'>;
  signal?: AbortSignal;
  decodeImage?: (
    blob: Blob,
    photo: PhotoRecord,
  ) => Promise<ImageBitmap | ImageData | ImageBufferLike>;
  onProgress?: (progress: {
    completed: number;
    total: number;
    currentPhotoId: string;
    currentLabel: string;
  }) => void;
  onPhotoStart?: (photo: PhotoRecord) => void;
  onPhotoComplete?: (photo: PhotoRecord, session: AnalysisSession) => void;
  onPhotoError?: (photo: PhotoRecord, error: Error) => void;
}

export interface BatchRunResult {
  siteId: string;
  total: number;
  completed: number;
  failed: number;
  aborted: boolean;
  completedPhotoIds: string[];
  failedPhotoIds: string[];
}

/**
 * A cancellation, not a failure: only an AbortError counts. Engine errors whose message merely
 * contains "abort" (e.g. onnxruntime-web's Emscripten "Aborted(...)" on out of memory) are
 * real failures and must be recorded as such.
 */
function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Sequentially processes pending photos in a site using a single `ImageGrainsEngine`
 * instance, releasing decoded `ImageBitmap` buffers in `finally` blocks after each photo.
 */
/**
 * Largest image (pixels) decoded for analysis. iOS Safari refuses canvases over 16.7 MP
 * (recent iPhones take 24-48 MP photos) and full-size decodes of large photos cost hundreds
 * of MB. Larger photos are decoded smaller; the engine reports results in the photo's own
 * pixels (`originalSize`). With Auto image scale the network input is unchanged (at most
 * 1024 px either way).
 */
export const MAX_DECODE_PIXELS = 16_777_216;

/** Decodes `blob`, shrinking it (aspect kept) when it exceeds MAX_DECODE_PIXELS. */
export async function decodeWithinPixelLimit(
  blob: Blob,
  createBitmap: (b: Blob, opts?: ImageBitmapOptions) => Promise<ImageBitmap>,
  maxPixels = MAX_DECODE_PIXELS,
): Promise<ImageBitmap> {
  const bmp = await createBitmap(blob);
  const px = bmp.width * bmp.height;
  if (px <= maxPixels) return bmp;
  const k = Math.sqrt(maxPixels / px);
  const resizeWidth = Math.max(1, Math.floor(bmp.width * k));
  const resizeHeight = Math.max(1, Math.floor(bmp.height * k));
  bmp.close();
  return createBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high' });
}

/**
 * The engine error as recorded for the photo. onnxruntime-web reports running out of memory
 * as an Emscripten abort ("Aborted(...)", or a bad_alloc / allocation failure); say so in words.
 */
export function describeEngineError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (/^(RuntimeError: )?Aborted\(|bad_alloc|out of memory|allocation failed/i.test(e.message)) {
    return new Error(
      `Out of memory during analysis (${e.message}). Try U-Net, a smaller image scale, or the INT8 Cellpose-SAM weights.`,
    );
  }
  return e;
}

export async function runSiteBatch(
  opts: BatchRunOptions,
): Promise<BatchRunResult> {
  const site = await getSite(opts.siteId, opts);
  if (!site) {
    throw new Error(`Site "${opts.siteId}" not found.`);
  }

  const allPhotos = await listSitePhotos(opts.siteId, opts);
  const photoMap = new Map(allPhotos.map((p) => [p.photoId, p]));

  const orderedPhotos: PhotoRecord[] = [];
  const seen = new Set<string>();
  for (const id of site.photoOrder) {
    const p = photoMap.get(id);
    if (p) {
      orderedPhotos.push(p);
      seen.add(id);
    }
  }
  for (const p of allPhotos) {
    if (!seen.has(p.photoId)) {
      orderedPhotos.push(p);
    }
  }

  const targetIds = opts.photoIds ? new Set(opts.photoIds) : null;
  const queue: PhotoRecord[] = [];
  for (const p of orderedPhotos) {
    if (targetIds !== null) {
      if (targetIds.has(p.photoId)) queue.push(p);
      continue;
    }
    const existing = await getPhotoResult(p.photoId, opts);
    // 'running' at the start of a batch is stale: the page that was analysing it closed or
    // crashed (e.g. out of memory) before finishing, so analyse it again.
    if (!existing || existing.status === 'pending' || existing.status === 'error' || existing.status === 'running') {
      queue.push(p);
    }
  }

  const decode =
    opts.decodeImage ??
    (async (blob: Blob): Promise<ImageBitmap> => {
      if (typeof globalThis.createImageBitmap !== 'function') {
        throw new Error(
          'createImageBitmap is not available in this environment; provide decodeImage option.',
        );
      }
      return decodeWithinPixelLimit(blob, globalThis.createImageBitmap.bind(globalThis));
    });

  const completedPhotoIds: string[] = [];
  const failedPhotoIds: string[] = [];
  let aborted = false;

  for (let i = 0; i < queue.length; i++) {
    const photo = queue[i];
    if (photo === undefined) continue;

    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }

    opts.onPhotoStart?.(photo);
    opts.onProgress?.({
      completed: completedPhotoIds.length,
      total: queue.length,
      currentPhotoId: photo.photoId,
      currentLabel: photo.label,
    });

    await savePhotoResult(
      {
        photoId: photo.photoId,
        status: 'running',
        updatedAt: Date.now(),
      },
      opts,
    );

    let decoded: ImageBitmap | ImageData | ImageBufferLike | null = null;
    try {
      decoded = await decode(photo.imageBlob, photo);
      if (opts.signal?.aborted) {
        aborted = true;
        await savePhotoResult(
          {
            photoId: photo.photoId,
            status: 'pending',
            updatedAt: Date.now(),
          },
          opts,
        );
        break;
      }

      const mergedConfig: AnalysisConfig = {
        ...opts.analysisConfig,
        ...photo.analysisConfig,
        // Results in the photo's own pixels even if it was decoded smaller.
        originalSize: { width: photo.width, height: photo.height },
        // Skip inference tiles outside this photo's ROI / exclusions (default on).
        ...(opts.analysisConfig?.skipTilesOutsideRoi !== false && photo.roiConfig !== undefined
          ? { inferenceRoi: photo.roiConfig }
          : {}),
        ...(photo.calibration !== undefined
          ? { calibration: photo.calibration }
          : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      };

      const session = await opts.engine.analyzeImage(decoded, mergedConfig);
      await savePhotoResult(
        {
          photoId: photo.photoId,
          status: 'done',
          serializedSession: session.toSerialized(),
          updatedAt: Date.now(),
        },
        opts,
      );

      completedPhotoIds.push(photo.photoId);
      opts.onPhotoComplete?.(photo, session);
    } catch (err) {
      if (err instanceof Error && err.name === 'BuildMismatchError') {
        // A newer version took over in another tab: nothing is wrong with the photo. Leave it
        // pending and stop; the message tells the user to reload.
        await savePhotoResult({ photoId: photo.photoId, status: 'pending', updatedAt: Date.now() }, opts);
        throw err;
      }
      if (opts.signal?.aborted || isAbortError(err)) {
        aborted = true;
        await savePhotoResult(
          {
            photoId: photo.photoId,
            status: 'pending',
            updatedAt: Date.now(),
          },
          opts,
        );
        break;
      }
      const errorObj = describeEngineError(err);
      failedPhotoIds.push(photo.photoId);
      await savePhotoResult(
        {
          photoId: photo.photoId,
          status: 'error',
          errorMessage: errorObj.message,
          updatedAt: Date.now(),
        },
        opts,
      );
      opts.onPhotoError?.(photo, errorObj);
    } finally {
      if (
        decoded !== null &&
        typeof decoded === 'object' &&
        'close' in decoded &&
        typeof decoded.close === 'function'
      ) {
        decoded.close();
      }
    }
  }

  return {
    siteId: opts.siteId,
    total: queue.length,
    completed: completedPhotoIds.length,
    failed: failedPhotoIds.length,
    aborted,
    completedPhotoIds,
    failedPhotoIds,
  };
}
