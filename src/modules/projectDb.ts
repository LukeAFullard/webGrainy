/**
 * Browser storage of sites, photos and analysis results (IndexedDB): the record types and
 * the basic save / get / list / delete operations. Archives are in projectArchive.ts and the
 * batch runner in siteBatch.ts; projectStorage.ts re-exports all three.
 */
import type { AnalysisConfig, CalibrationResult, SerializedAnalysisSession } from '../types/index.js';
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

/**
 * The photo as it was before its first perspective rectification (image, scale, ROI, metadata
 * and its own enhancement backup), so "Undo rectify" restores it exactly.
 */
export interface PhotoRectifyBackup extends PhotoOriginalBackup {
  originalBackup?: PhotoOriginalBackup;
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
  /** The photo before perspective rectification, enabling "Undo rectify". */
  rectifyBackup?: PhotoRectifyBackup;
}

export type PhotoProcessStatus = 'pending' | 'running' | 'done' | 'error';

export interface PhotoResultRecord {
  photoId: string;
  status: PhotoProcessStatus;
  errorMessage?: string;
  serializedSession?: SerializedAnalysisSession;
  updatedAt: number;
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
