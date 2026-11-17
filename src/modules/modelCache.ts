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
/**
 * Hugging Face commit the app is validated against. Weights are fetched from this
 * immutable revision (never the moving `main` branch) and verified by SHA-256.
 */
export const MODEL_REVISION = '98e76b1374dc22cfff8193aca71c308f2b4dd3b3';
export const DEFAULT_HF_BASE_URL = `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REVISION}/`;

export interface ModelIntegrity {
  sha256: string;
  sizeBytes: number;
}

/** Expected SHA-256 (Hugging Face LFS oid) and byte size for each pinned model. */
export const MODEL_INTEGRITY: Record<ModelId, ModelIntegrity> = {
  ig2_unet_fp32: {
    sha256: '5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c',
    sizeBytes: 26489665,
  },
  ig2_cpsam_fp16: {
    sha256: '944a114a0cb1a3a215c11affefe7211caac6da2b74895c496d5a7b5a23b6230d',
    sizeBytes: 617364567,
  },
  ig2_cpsam_int8_wo_fp32scale: {
    sha256: '2cda0be5b81f1d0c0ac36998beb9f741e11833aacd089c4f5cee92488bab6f43',
    sizeBytes: 316272029,
  },
  ig2_cpsam_fp4_e2m1_lut: {
    sha256: 'd49d8f0779af3956b45b506719702bc3f9b7e0044a2d2a0a6842751544320c99',
    sizeBytes: 183292650,
  },
};

let integrityEnforced = true;

/**
 * Enables/disables SHA-256 + size verification of model weights (default: enabled).
 * Only intended for unit tests that use synthetic payloads.
 */
export function setModelIntegrityEnforcement(enabled: boolean): void {
  integrityEnforced = enabled;
}

export function isModelIntegrityEnforced(): boolean {
  return integrityEnforced;
}

/** Lower-case hex SHA-256 of `data` via WebCrypto. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto (crypto.subtle) is unavailable; cannot verify model integrity. Serve the app over HTTPS.');
  }
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await subtle.digest('SHA-256', view as Uint8Array<ArrayBuffer>);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function verifyModelIntegrity(
  modelId: ModelId,
  buffer: ArrayBuffer,
): Promise<string | undefined> {
  if (!integrityEnforced) {
    return undefined;
  }
  const expected = MODEL_INTEGRITY[modelId];
  if (buffer.byteLength !== expected.sizeBytes) {
    throw new Error(
      `Integrity check failed for "${modelId}": expected ${expected.sizeBytes} bytes, got ${buffer.byteLength}.`,
    );
  }
  const actual = await sha256Hex(buffer);
  if (actual !== expected.sha256) {
    throw new Error(
      `Integrity check failed for "${modelId}": SHA-256 ${actual} does not match pinned ${expected.sha256}.`,
    );
  }
  return actual;
}

export const MODEL_FILES: Record<ModelId, string> = {
  ig2_unet_fp32: 'ig2_unet_fp32.onnx',
  ig2_cpsam_fp16: 'ig2_cpsam_fp16.onnx',
  ig2_cpsam_int8_wo_fp32scale: 'ig2_cpsam_int8_wo_fp32scale.onnx',
  ig2_cpsam_fp4_e2m1_lut: 'ig2_cpsam_fp4_e2m1_lut.onnx',
};

/** The model family (and so the inference pipeline) a weight file belongs to. */
export function modelKindOf(modelId: ModelId): 'unet' | 'cpsam' {
  return modelId === 'ig2_unet_fp32' ? 'unet' : 'cpsam';
}

export const CPSAM_MODEL_IDS: Record<Exclude<import('../types/index.js').CpsamWeights, 'auto'>, ModelId> = {
  fp16: 'ig2_cpsam_fp16',
  int8: 'ig2_cpsam_int8_wo_fp32scale',
  fp4: 'ig2_cpsam_fp4_e2m1_lut',
};

/**
 * Picks the weight file. Cellpose-SAM 'auto' uses FP16 when it will run on a WebGPU GPU
 * with shader-f16 (native float16 kernels; checked on real hardware with the GPU check
 * page), and INT8 otherwise: on the CPU it is 2.2x faster and needs about half the memory
 * (2.1 GB vs 3.8 GB) with the same benchmark accuracy.
 */
export function resolveModelId(
  kind: 'unet' | 'cpsam',
  weights: import('../types/index.js').CpsamWeights = 'auto',
  fp16GpuUsable = false,
): ModelId {
  if (kind === 'unet') return 'ig2_unet_fp32';
  if (weights !== 'auto') return CPSAM_MODEL_IDS[weights];
  return fp16GpuUsable ? 'ig2_cpsam_fp16' : 'ig2_cpsam_int8_wo_fp32scale';
}

interface CachedModelRecord {
  modelId: ModelId;
  fileName: string;
  sizeBytes: number;
  cachedAt: number;
  /** SHA-256 verified at download time (absent for legacy / unverified records). */
  sha256?: string;
  /** Hugging Face revision the record was downloaded from. */
  revision?: string;
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
    // Stream straight into a preallocated buffer when the size is known, avoiding a
    // transient 2x copy (~1.2 GB peak for the 617 MB CP-SAM model).
    let prealloc: Uint8Array<ArrayBuffer> | null =
      !isCompressed && totalBytes > 0 ? new Uint8Array(totalBytes) : null;

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
          if (prealloc !== null && loadedBytes + value.byteLength <= prealloc.byteLength) {
            prealloc.set(value, loadedBytes);
          } else {
            if (prealloc !== null) {
              // Server sent more than Content-Length: fall back to chunk list.
              chunks.push(prealloc.subarray(0, loadedBytes));
              prealloc = null;
            }
            chunks.push(value);
          }
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

    modelBuffer =
      prealloc !== null && loadedBytes === prealloc.byteLength
        ? prealloc.buffer
        : concatChunks(chunks, loadedBytes);
  }

  const verifiedSha256 = await verifyModelIntegrity(modelId, modelBuffer);

  const record: CachedModelRecord = {
    modelId,
    fileName,
    sizeBytes: modelBuffer.byteLength,
    cachedAt: Date.now(),
    ...(verifiedSha256 !== undefined
      ? { sha256: verifiedSha256, revision: MODEL_REVISION }
      : {}),
    data: modelBuffer,
  };

  await writeCachedRecord(record);
  return modelBuffer;
}

function isCachedRecordValid(modelId: ModelId, record: CachedModelRecord): boolean {
  if (!integrityEnforced) {
    return true;
  }
  const expected = MODEL_INTEGRITY[modelId];
  // Records written before integrity pinning (no sha256) or from another revision
  // are treated as stale and transparently re-downloaded.
  return (
    record.sha256 === expected.sha256 &&
    record.data.byteLength === expected.sizeBytes
  );
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
      cached.data.byteLength > 0 &&
      isCachedRecordValid(modelId, cached)
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
    ...(record.sha256 !== undefined ? { sha256: record.sha256 } : {}),
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
