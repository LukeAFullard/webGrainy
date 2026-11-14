import type {
  CachedModelInfo,
  DownloadProgress,
  ModelDownloadOptions,
  ModelId,
  StorageQuotaInfo,
} from '../types/index.js';

export const DB_NAME = 'imagegrains-onnx-cache-v1';
export const DB_VERSION = 1;
export const STORE_NAME = 'models';
export const DEFAULT_HF_BASE_URL =
  'https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/main/';

export const MODEL_FILES: Record<ModelId, string> = {
  ig2_unet_fp32: 'ig2_unet_fp32.onnx',
  ig2_cpsam_fp16: 'ig2_cpsam_fp16.onnx',
};

interface CachedModelRecord {
  modelId: ModelId;
  fileName: string;
  sizeBytes: number;
  cachedAt: number;
  data: ArrayBuffer;
}

function getIndexedDB(): IDBFactory {
  if (typeof globalThis.indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment.');
  }
  return globalThis.indexedDB;
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error(
    typeof reason === 'string' && reason.length > 0
      ? reason
      : 'The operation was aborted.',
  );
  err.name = 'AbortError';
  return err;
}

function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const maybeErr = err as { name?: string; code?: number };
  return (
    maybeErr.name === 'QuotaExceededError' ||
    maybeErr.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    maybeErr.code === 22
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = getIndexedDB();
    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'modelId' });
      }
    };

    request.onerror = () => {
      reject(
        request.error ??
          new Error(`Failed to open IndexedDB database "${DB_NAME}".`),
      );
    };

    request.onblocked = () => {
      reject(
        new Error(
          `IndexedDB open request for "${DB_NAME}" was blocked by another connection.`,
        ),
      );
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  contextLabel: string,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const request = fn(store);

      let settled = false;
      let resultValue: T;
      let hasResult = false;

      request.onsuccess = () => {
        resultValue = request.result;
        hasResult = true;
      };

      request.onerror = () => {
        if (settled) return;
        settled = true;
        const err = request.error;
        if (isQuotaExceededError(err)) {
          const quotaErr = new Error(
            `QuotaExceededError: Insufficient storage quota while ${contextLabel}.`,
          );
          quotaErr.name = 'QuotaExceededError';
          reject(quotaErr);
        } else {
          reject(err ?? new Error(`IndexedDB request failed while ${contextLabel}.`));
        }
      };

      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(hasResult ? resultValue : (undefined as T));
      };

      tx.onerror = () => {
        if (settled) return;
        settled = true;
        const err = tx.error;
        if (isQuotaExceededError(err)) {
          const quotaErr = new Error(
            `QuotaExceededError: Insufficient storage quota while ${contextLabel}.`,
          );
          quotaErr.name = 'QuotaExceededError';
          reject(quotaErr);
        } else {
          reject(err ?? new Error(`IndexedDB transaction failed while ${contextLabel}.`));
        }
      };

      tx.onabort = () => {
        if (settled) return;
        settled = true;
        const err = tx.error;
        if (isQuotaExceededError(err)) {
          const quotaErr = new Error(
            `QuotaExceededError: Insufficient storage quota while ${contextLabel}.`,
          );
          quotaErr.name = 'QuotaExceededError';
          reject(quotaErr);
        } else {
          reject(err ?? new Error(`IndexedDB transaction aborted while ${contextLabel}.`));
        }
      };
    });
  } finally {
    db.close();
  }
}

async function readCachedRecord(
  modelId: ModelId,
): Promise<CachedModelRecord | undefined> {
  return withStore<CachedModelRecord | undefined>(
    'readonly',
    (store) => store.get(modelId) as IDBRequest<CachedModelRecord | undefined>,
    `reading cached model "${modelId}"`,
  );
}

async function writeCachedRecord(record: CachedModelRecord): Promise<void> {
  await withStore<IDBValidKey>(
    'readwrite',
    (store) => store.put(record),
    `storing model "${record.modelId}" (${record.sizeBytes} bytes)`,
  );
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): ArrayBuffer {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function getModelFileName(modelId: ModelId): string {
  if (
    typeof modelId !== 'string' ||
    !Object.prototype.hasOwnProperty.call(MODEL_FILES, modelId)
  ) {
    throw new RangeError(`Invalid modelId "${String(modelId)}".`);
  }
  return MODEL_FILES[modelId];
}

/**
 * Stream-downloads a model `.onnx` file from Hugging Face (or custom `baseUrl`),
 * emits `DownloadProgress` updates, persists the buffer in IndexedDB, and returns it.
 */
export async function downloadModel(
  modelId: ModelId,
  options: ModelDownloadOptions = {},
): Promise<ArrayBuffer> {
  const fileName = getModelFileName(modelId);
  const { onProgress, signal, baseUrl = DEFAULT_HF_BASE_URL } = options;

  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }

  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${normalizedBase}${fileName}`;

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `Failed to download model "${modelId}" from ${url}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const contentLengthHeader = response.headers.get('Content-Length');
  const parsedLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
  const totalBytes =
    Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : 0;

  const contentEncoding = response.headers.get('Content-Encoding');
  const isCompressed = Boolean(
    contentEncoding &&
      contentEncoding.trim().length > 0 &&
      contentEncoding.trim().toLowerCase() !== 'identity',
  );

  const startTimeMs = performance.now();
  let modelBuffer: ArrayBuffer;

  if (!response.body) {
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }
    modelBuffer = await response.arrayBuffer();
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }
    if (!isCompressed && totalBytes > 0 && modelBuffer.byteLength !== totalBytes) {
      throw new Error(
        `Truncated download for "${modelId}": expected ${totalBytes} bytes, received ${modelBuffer.byteLength} bytes.`,
      );
    }
    if (onProgress) {
      const elapsedSec = Math.max((performance.now() - startTimeMs) / 1000, 0.001);
      const loadedBytes = modelBuffer.byteLength;
      const effectiveTotal = totalBytes > 0 ? totalBytes : loadedBytes;
      const progress: DownloadProgress = {
        loadedBytes,
        totalBytes: effectiveTotal,
        percent: effectiveTotal > 0 ? Math.min(100, (loadedBytes / effectiveTotal) * 100) : 100,
        speedMBps: loadedBytes / (1024 * 1024) / elapsedSec,
      };
      onProgress(progress);
    }
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;

    const onAbort = () => {
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          throw createAbortError(signal.reason);
        }

        const { done, value } = await reader.read();
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          throw createAbortError(signal.reason);
        }

        if (done) {
          break;
        }

        if (value && value.byteLength > 0) {
          chunks.push(value);
          loadedBytes += value.byteLength;

          if (onProgress) {
            const elapsedSec = Math.max(
              (performance.now() - startTimeMs) / 1000,
              0.001,
            );
            const percent =
              totalBytes > 0
                ? Math.min(100, (loadedBytes / totalBytes) * 100)
                : 0;
            const speedMBps = loadedBytes / (1024 * 1024) / elapsedSec;
            onProgress({
              loadedBytes,
              totalBytes,
              percent,
              speedMBps,
            });
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }

    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }

    if (!isCompressed && totalBytes > 0 && loadedBytes !== totalBytes) {
      throw new Error(
        `Truncated download for "${modelId}": expected ${totalBytes} bytes, received ${loadedBytes} bytes.`,
      );
    }

    modelBuffer = concatChunks(chunks, loadedBytes);
  }

  const record: CachedModelRecord = {
    modelId,
    fileName,
    sizeBytes: modelBuffer.byteLength,
    cachedAt: Date.now(),
    data: modelBuffer,
  };

  await writeCachedRecord(record);
  return modelBuffer;
}

/**
 * Returns the model `ArrayBuffer` from IndexedDB if cached (unless `forceRefresh: true`),
 * otherwise downloads, caches, and returns it.
 */
export async function getModel(
  modelId: ModelId,
  options: ModelDownloadOptions = {},
): Promise<ArrayBuffer> {
  getModelFileName(modelId);
  if (options.signal?.aborted) {
    throw createAbortError(options.signal.reason);
  }

  if (!options.forceRefresh) {
    const cached = await readCachedRecord(modelId);
    if (
      cached &&
      cached.data instanceof ArrayBuffer &&
      cached.data.byteLength > 0
    ) {
      return cached.data;
    }
  }

  return downloadModel(modelId, options);
}

/**
 * Lists metadata for all models currently persisted in IndexedDB.
 */
export async function getCachedModels(): Promise<CachedModelInfo[]> {
  const records = await withStore<CachedModelRecord[]>(
    'readonly',
    (store) => store.getAll() as IDBRequest<CachedModelRecord[]>,
    'listing cached models',
  );

  return (records ?? []).map((record) => ({
    modelId: record.modelId,
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    cachedAt: record.cachedAt,
  }));
}

/**
 * Deletes a single cached model from IndexedDB by `modelId`.
 */
export async function deleteCachedModel(modelId: ModelId): Promise<void> {
  await withStore<undefined>(
    'readwrite',
    (store) => store.delete(modelId) as IDBRequest<undefined>,
    `deleting cached model "${modelId}"`,
  );
}

/**
 * Clears all cached models from IndexedDB.
 */
export async function clearModelCache(): Promise<void> {
  await withStore<undefined>(
    'readwrite',
    (store) => store.clear() as IDBRequest<undefined>,
    'clearing model cache',
  );
}

/**
 * Queries browser storage quota via `navigator.storage.estimate()`.
 * Returns zeros if the Storage API is unavailable.
 */
export async function checkStorageQuota(): Promise<StorageQuotaInfo> {
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.estimate !== 'function') {
    return {
      usageBytes: 0,
      quotaBytes: 0,
      availableBytes: 0,
    };
  }

  const estimate = await storage.estimate();
  const usageBytes = estimate.usage ?? 0;
  const quotaBytes = estimate.quota ?? 0;
  const availableBytes = Math.max(0, quotaBytes - usageBytes);

  return {
    usageBytes,
    quotaBytes,
    availableBytes,
  };
}
