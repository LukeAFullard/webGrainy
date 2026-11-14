import type {
  AnalysisConfig,
  CalibrationResult,
  SerializedAnalysisSession,
} from '../types/index.js';
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
}

export type PhotoProcessStatus = 'pending' | 'running' | 'done' | 'error';

export interface PhotoResultRecord {
  photoId: string;
  status: PhotoProcessStatus;
  errorMessage?: string;
  serializedSession?: SerializedAnalysisSession;
  updatedAt: number;
}

interface ArchivedPhotoRecord extends Omit<PhotoRecord, 'imageBlob'> {
  imageBase64: string;
  imageMimeType: string;
}

interface ArchivedSerializedSession
  extends Omit<SerializedAnalysisSession, 'workingMasks' | 'workingImage'> {
  workingMasksBase64: string;
  workingImage: Omit<SerializedAnalysisSession['workingImage'], 'data'> & {
    dataBase64: string;
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
      resolve(request.result);
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

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function serializeSessionForArchive(
  session: SerializedAnalysisSession,
): ArchivedSerializedSession {
  const maskBytes = new Uint8Array(
    session.workingMasks.buffer,
    session.workingMasks.byteOffset,
    session.workingMasks.byteLength,
  );
  const imgBytes = new Uint8Array(
    session.workingImage.data.buffer,
    session.workingImage.data.byteOffset,
    session.workingImage.data.byteLength,
  );

  const { data: _ignoredData, ...restWorkingImage } = session.workingImage;

  return {
    version: session.version,
    workingMasksBase64: uint8ToBase64(maskBytes),
    workingImage: {
      ...restWorkingImage,
      dataBase64: uint8ToBase64(imgBytes),
    },
    recommendation: session.recommendation,
    ...(session.calibration !== undefined
      ? { calibration: session.calibration }
      : {}),
    excludeBorder: session.excludeBorder,
    borderMargin: session.borderMargin,
  };
}

function deserializeSessionFromArchive(
  archived: ArchivedSerializedSession,
): SerializedAnalysisSession {
  const maskBytes = base64ToUint8(archived.workingMasksBase64);
  if (maskBytes.byteLength % 4 !== 0) {
    throw new Error('Corrupt archived workingMasks buffer length.');
  }
  const workingMasks = new Int32Array(
    maskBytes.buffer,
    maskBytes.byteOffset,
    maskBytes.byteLength / 4,
  ).slice();

  const imgBytes = base64ToUint8(archived.workingImage.dataBase64);
  const workingImageData = new Uint8ClampedArray(imgBytes);

  const { dataBase64: _ignored, ...restImg } = archived.workingImage;

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
  };
}

/**
 * Exports a site, all its photos, and all analysis results into a portable
 * `.webgrainy.json` archive Blob.
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
  const archivedPhotos: ArchivedPhotoRecord[] = [];
  const archivedResults: ArchivedResultRecord[] = [];

  for (const photo of photos) {
    const buf = await photo.imageBlob.arrayBuffer();
    const { imageBlob, ...restPhoto } = photo;
    archivedPhotos.push({
      ...restPhoto,
      imageBase64: uint8ToBase64(new Uint8Array(buf)),
      imageMimeType: imageBlob.type || 'application/octet-stream',
    });

    const res = await getPhotoResult(photo.photoId, options);
    if (res !== undefined) {
      const { serializedSession, ...restRes } = res;
      archivedResults.push({
        ...restRes,
        ...(serializedSession !== undefined
          ? { serializedSession: serializeSessionForArchive(serializedSession) }
          : {}),
      });
    }
  }

  const archive: ProjectArchiveV1 = {
    format: 'webgrainy-project',
    version: 1,
    exportedAt: new Date().toISOString(),
    site,
    photos: archivedPhotos,
    results: archivedResults,
  };

  return new Blob([JSON.stringify(archive, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
}

export const exportSiteArchive = exportProjectArchive;

/**
 * Validates and imports a `.webgrainy.json` project archive into IndexedDB,
 * returning the imported `siteId`.
 */
export async function importProjectArchive(
  archiveInput: Blob | string,
  options?: ProjectStorageOptions,
): Promise<string> {
  const rawText =
    typeof archiveInput === 'string'
      ? archiveInput
      : await archiveInput.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Invalid .webgrainy.json archive: ${err instanceof Error ? err.message : 'JSON parse error'}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid .webgrainy.json archive: expected JSON object.');
  }

  const arch = parsed as Partial<ProjectArchiveV1>;
  if (arch.format !== 'webgrainy-project' || arch.version !== 1) {
    throw new Error(
      `Unsupported archive format or version: format=${String(arch.format)}, version=${String(arch.version)}.`,
    );
  }
  if (!arch.site || typeof arch.site.siteId !== 'string' || !arch.site.siteId) {
    throw new Error('Invalid archive: missing site.siteId.');
  }
  if (!Array.isArray(arch.photos) || !Array.isArray(arch.results)) {
    throw new Error('Invalid archive: missing photos or results array.');
  }

  await saveSite(arch.site, options);

  for (const ap of arch.photos) {
    if (!ap || typeof ap.photoId !== 'string' || typeof ap.imageBase64 !== 'string') {
      throw new Error('Invalid archive: corrupt photo record.');
    }
    const imgBytes = base64ToUint8(ap.imageBase64);
    const { imageBase64: _b64, imageMimeType, ...restPhoto } = ap;
    const blob = new Blob([imgBytes.slice().buffer], {
      type: imageMimeType || 'application/octet-stream',
    });
    await savePhoto({ ...restPhoto, imageBlob: blob }, options);
  }

  for (const ar of arch.results) {
    if (!ar || typeof ar.photoId !== 'string') {
      throw new Error('Invalid archive: corrupt result record.');
    }
    const { serializedSession, ...restRes } = ar;
    await savePhotoResult(
      {
        ...restRes,
        ...(serializedSession !== undefined
          ? { serializedSession: deserializeSessionFromArchive(serializedSession) }
          : {}),
      },
      options,
    );
  }

  return arch.site.siteId;
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

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
  );
}

/**
 * Sequentially processes pending photos in a site using a single `ImageGrainsEngine`
 * instance, releasing decoded `ImageBitmap` buffers in `finally` blocks after each photo.
 */
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
    if (!existing || existing.status === 'pending' || existing.status === 'error') {
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
      return globalThis.createImageBitmap(blob);
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
      const errorObj = err instanceof Error ? err : new Error(String(err));
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
