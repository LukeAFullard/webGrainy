import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkStorageQuota,
  clearModelCache,
  DB_NAME,
  DB_VERSION,
  DEFAULT_HF_BASE_URL,
  MODEL_REVISION,
  MODEL_INTEGRITY,
  setModelIntegrityEnforcement,
  sha256Hex,
  deleteCachedModel,
  downloadModel,
  getCachedModels,
  getModel,
  getLastCacheWriteError,
  MODEL_FILES,
  STORE_NAME,
} from '../src/modules/modelCache.js';
import type { DownloadProgress } from '../src/types/index.js';

interface MockStoreData {
  keyPath: string;
  records: Map<string, unknown>;
}

function createMockIndexedDB(options?: {
  simulateQuotaExceededOnPut?: boolean;
  simulateOpenError?: boolean;
  simulateBlocked?: boolean;
}) {
  const databases = new Map<string, { version: number; stores: Map<string, MockStoreData> }>();

  const makeRequest = <T>(): {
    result: T;
    error: DOMException | null;
    onsuccess: ((ev: Event) => void) | null;
    onerror: ((ev: Event) => void) | null;
    onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null;
    onblocked: ((ev: Event) => void) | null;
  } => ({
    result: undefined as unknown as T,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
  });

  const factory = {
    open(name: string, version = 1) {
      const req = makeRequest<IDBDatabase>();

      queueMicrotask(() => {
        if (options?.simulateBlocked) {
          req.onblocked?.(new Event('blocked'));
          return;
        }
        if (options?.simulateOpenError) {
          req.error = new DOMException('Open failed', 'UnknownError');
          req.onerror?.(new Event('error'));
          return;
        }

        let dbEntry = databases.get(name);
        const needsUpgrade = !dbEntry || dbEntry.version < version;
        if (!dbEntry) {
          dbEntry = { version, stores: new Map() };
          databases.set(name, dbEntry);
        } else if (version > dbEntry.version) {
          dbEntry.version = version;
        }

        const storeNames = dbEntry.stores;
        const db = {
          name,
          version: dbEntry.version,
          objectStoreNames: {
            contains(storeName: string) {
              return storeNames.has(storeName);
            },
          },
          createObjectStore(storeName: string, storeOpts?: { keyPath?: string }) {
            const storeData: MockStoreData = {
              keyPath: storeOpts?.keyPath ?? 'id',
              records: new Map(),
            };
            storeNames.set(storeName, storeData);
            return {} as IDBObjectStore;
          },
          transaction(storeName: string, _mode: IDBTransactionMode) {
            const storeData = storeNames.get(storeName);
            if (!storeData) {
              throw new Error(`Object store "${storeName}" not found`);
            }

            const tx = {
              error: null as DOMException | null,
              oncomplete: null as ((ev: Event) => void) | null,
              onerror: null as ((ev: Event) => void) | null,
              onabort: null as ((ev: Event) => void) | null,
              objectStore(_name: string) {
                return {
                  get(key: string) {
                    const opReq = makeRequest<unknown>();
                    queueMicrotask(() => {
                      opReq.result = storeData.records.get(key);
                      opReq.onsuccess?.(new Event('success'));
                      queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                    });
                    return opReq as unknown as IDBRequest;
                  },
                  put(value: Record<string, unknown>) {
                    const opReq = makeRequest<IDBValidKey>();
                    queueMicrotask(() => {
                      if (options?.simulateQuotaExceededOnPut) {
                        const err = new DOMException(
                          'Quota exceeded',
                          'QuotaExceededError',
                        );
                        opReq.error = err;
                        tx.error = err;
                        opReq.onerror?.(new Event('error'));
                        return;
                      }
                      const key = String(value[storeData.keyPath]);
                      storeData.records.set(key, value);
                      opReq.result = key;
                      opReq.onsuccess?.(new Event('success'));
                      queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                    });
                    return opReq as unknown as IDBRequest<IDBValidKey>;
                  },
                  getAll() {
                    const opReq = makeRequest<unknown[]>();
                    queueMicrotask(() => {
                      opReq.result = Array.from(storeData.records.values());
                      opReq.onsuccess?.(new Event('success'));
                      queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                    });
                    return opReq as unknown as IDBRequest<unknown[]>;
                  },
                  delete(key: string) {
                    const opReq = makeRequest<undefined>();
                    queueMicrotask(() => {
                      storeData.records.delete(key);
                      opReq.result = undefined;
                      opReq.onsuccess?.(new Event('success'));
                      queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                    });
                    return opReq as unknown as IDBRequest<undefined>;
                  },
                  clear() {
                    const opReq = makeRequest<undefined>();
                    queueMicrotask(() => {
                      storeData.records.clear();
                      opReq.result = undefined;
                      opReq.onsuccess?.(new Event('success'));
                      queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                    });
                    return opReq as unknown as IDBRequest<undefined>;
                  },
                } as unknown as IDBObjectStore;
              },
            };

            return tx as unknown as IDBTransaction;
          },
          close() {
            // no-op
          },
        } as unknown as IDBDatabase;

        req.result = db;
        if (needsUpgrade) {
          req.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
        }
        req.onsuccess?.(new Event('success'));
      });

      return req as unknown as IDBOpenDBRequest;
    },
  };

  return { factory: factory as unknown as IDBFactory, databases };
}

function createChunkedResponse(
  chunks: Uint8Array[],
  init?: {
    status?: number;
    statusText?: string;
    contentLength?: number | string | null;
  },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const headers = new Headers();
  if (init?.contentLength !== null && init?.contentLength !== undefined) {
    headers.set('Content-Length', String(init.contentLength));
  }

  return new Response(stream, {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers,
  });
}

describe('modelCache', () => {
  const originalIndexedDB = globalThis.indexedDB;
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;

  let mockDb: ReturnType<typeof createMockIndexedDB>;

  beforeEach(() => {
    mockDb = createMockIndexedDB();
    Object.defineProperty(globalThis, 'indexedDB', {
      value: mockDb.factory,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'indexedDB', {
      value: originalIndexedDB,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  it('exports expected constants and model file mappings', () => {
    expect(DB_NAME).toBe('imagegrains-onnx-cache-v1');
    expect(DB_VERSION).toBe(1);
    expect(STORE_NAME).toBe('models');
    expect(DEFAULT_HF_BASE_URL).toBe(
      `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/resolve/${MODEL_REVISION}/`,
    );
    expect(MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(DEFAULT_HF_BASE_URL).not.toContain('/resolve/main/');
    expect(MODEL_FILES.ig2_unet_fp32).toBe('ig2_unet_fp32.onnx');
    expect(MODEL_FILES.ig2_cpsam_fp16).toBe('ig2_cpsam_fp16.onnx');
  });

  it('streams multi-chunk download with known Content-Length and emits progress', async () => {
    const chunk1 = new Uint8Array([1, 2, 3, 4]);
    const chunk2 = new Uint8Array([5, 6, 7, 8, 9, 10]);
    const totalLength = chunk1.byteLength + chunk2.byteLength;

    const fetchMock = vi.fn().mockResolvedValue(
      createChunkedResponse([chunk1, chunk2], { contentLength: totalLength }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const progressEvents: DownloadProgress[] = [];
    const buffer = await downloadModel('ig2_unet_fp32', {
      onProgress: (p) => progressEvents.push(p),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_HF_BASE_URL}ig2_unet_fp32.onnx`,
      expect.objectContaining({ signal: undefined }),
    );

    expect(new Uint8Array(buffer)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    );
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0]?.loadedBytes).toBe(4);
    expect(progressEvents[0]?.totalBytes).toBe(10);
    expect(progressEvents[0]?.percent).toBeCloseTo(40, 5);
    expect(progressEvents[0]?.speedMBps).toBeGreaterThanOrEqual(0);
    expect(progressEvents[1]?.loadedBytes).toBe(10);
    expect(progressEvents[1]?.totalBytes).toBe(10);
    expect(progressEvents[1]?.percent).toBeCloseTo(100, 5);
  });

  it('handles missing Content-Length gracefully (totalBytes: 0, percent: 0)', async () => {
    const chunk1 = new Uint8Array([10, 20, 30]);
    const chunk2 = new Uint8Array([40, 50]);

    globalThis.fetch = vi.fn().mockResolvedValue(
      createChunkedResponse([chunk1, chunk2], { contentLength: null }),
    ) as unknown as typeof fetch;

    const progressEvents: DownloadProgress[] = [];
    const buffer = await downloadModel('ig2_cpsam_fp16', {
      baseUrl: 'https://example.com/models',
      onProgress: (p) => progressEvents.push(p),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/models/ig2_cpsam_fp16.onnx',
      expect.anything(),
    );
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0]?.totalBytes).toBe(0);
    expect(progressEvents[0]?.percent).toBe(0);
    expect(progressEvents[1]?.loadedBytes).toBe(5);
    expect(progressEvents[1]?.totalBytes).toBe(0);
    expect(progressEvents[1]?.percent).toBe(0);
  });

  it('normalizes Content-Length: 0 and invalid Content-Length to totalBytes: 0, percent: 0 during stream', async () => {
    for (const contentLength of [0, 'not-a-number', '-10']) {
      const chunk1 = new Uint8Array([1, 2, 3]);
      const chunk2 = new Uint8Array([4, 5]);

      globalThis.fetch = vi.fn().mockResolvedValue(
        createChunkedResponse([chunk1, chunk2], { contentLength }),
      ) as unknown as typeof fetch;

      const progressEvents: DownloadProgress[] = [];
      const buffer = await downloadModel('ig2_unet_fp32', {
        onProgress: (p) => progressEvents.push(p),
      });

      expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      expect(progressEvents).toHaveLength(2);
      for (const ev of progressEvents) {
        expect(ev.totalBytes).toBe(0);
        expect(ev.percent).toBe(0);
      }
    }
  });

  it('falls back cleanly when response.body is null', async () => {
    const payload = new Uint8Array([11, 22, 33, 44]);
    const resp = new Response(payload, {
      status: 200,
      headers: { 'Content-Length': String(payload.byteLength) },
    });
    Object.defineProperty(resp, 'body', { value: null });

    globalThis.fetch = vi.fn().mockResolvedValue(resp) as unknown as typeof fetch;

    const progressEvents: DownloadProgress[] = [];
    const buffer = await downloadModel('ig2_unet_fp32', {
      onProgress: (p) => progressEvents.push(p),
    });

    expect(new Uint8Array(buffer)).toEqual(payload);
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.percent).toBe(100);
  });

  it('throws descriptive error on HTTP 404 or 500 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    ) as unknown as typeof fetch;

    await expect(downloadModel('ig2_unet_fp32')).rejects.toThrow(/HTTP 404/);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    ) as unknown as typeof fetch;

    await expect(downloadModel('ig2_unet_fp32')).rejects.toThrow(/HTTP 500/);
  });

  it('aborts immediately when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled by user', 'AbortError'));

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      getModel('ig2_unet_fp32', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts mid-stream when AbortSignal fires between chunks', async () => {
    const controller = new AbortController();
    let readCount = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        readCount++;
        if (readCount === 1) {
          ctrl.enqueue(new Uint8Array([1, 2, 3]));
        } else {
          // Wait until abort fires
          return new Promise(() => {});
        }
      },
    });

    const resp = new Response(stream, {
      status: 200,
      headers: { 'Content-Length': '100' },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(resp) as unknown as typeof fetch;

    const promise = downloadModel('ig2_unet_fp32', {
      signal: controller.signal,
      onProgress: () => {
        // Abort after first chunk is processed
        controller.abort();
      },
    });

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with AbortError and does not persist partial data when AbortSignal fires while reader.read() is pending', async () => {
    const controller = new AbortController();
    let readCount = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        readCount++;
        if (readCount === 1) {
          ctrl.enqueue(new Uint8Array([1, 2, 3, 4]));
          // Schedule abort asynchronously while the second reader.read() is pending
          setTimeout(() => controller.abort(), 15);
        } else {
          // Keep the second read pending until reader.cancel() resolves it with { done: true }
          return new Promise(() => {});
        }
      },
    });

    const resp = new Response(stream, {
      status: 200,
      headers: { 'Content-Length': '100' },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(resp) as unknown as typeof fetch;

    await expect(
      downloadModel('ig2_unet_fp32', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const cached = await getCachedModels();
    expect(cached).toEqual([]);
  });

  it('returns cached model on second getModel without calling fetch, and supports forceRefresh', async () => {
    const payloadV1 = new Uint8Array([1, 2, 3, 4]);
    const payloadV2 = new Uint8Array([9, 8, 7, 6, 5]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createChunkedResponse([payloadV1], { contentLength: payloadV1.byteLength }),
      )
      .mockResolvedValueOnce(
        createChunkedResponse([payloadV2], { contentLength: payloadV2.byteLength }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await getModel('ig2_unet_fp32');
    expect(new Uint8Array(first)).toEqual(payloadV1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call should hit IndexedDB cache and NOT call fetch
    const second = await getModel('ig2_unet_fp32');
    expect(new Uint8Array(second)).toEqual(payloadV1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // forceRefresh: true should bypass cache and fetch v2
    const refreshed = await getModel('ig2_unet_fp32', { forceRefresh: true });
    expect(new Uint8Array(refreshed)).toEqual(payloadV2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Subsequent getModel should return updated cached v2
    const afterRefresh = await getModel('ig2_unet_fp32');
    expect(new Uint8Array(afterRefresh)).toEqual(payloadV2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lists, deletes, and clears cached models', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        createChunkedResponse([new Uint8Array([1, 2])], { contentLength: 2 }),
      )
      .mockResolvedValueOnce(
        createChunkedResponse([new Uint8Array([3, 4, 5])], { contentLength: 3 }),
      ) as unknown as typeof fetch;

    await getModel('ig2_unet_fp32');
    await getModel('ig2_cpsam_fp16');

    const cached = await getCachedModels();
    expect(cached).toHaveLength(2);
    expect(cached.map((c) => c.modelId).sort()).toEqual([
      'ig2_cpsam_fp16',
      'ig2_unet_fp32',
    ]);
    const unetMeta = cached.find((c) => c.modelId === 'ig2_unet_fp32');
    expect(unetMeta?.fileName).toBe('ig2_unet_fp32.onnx');
    expect(unetMeta?.sizeBytes).toBe(2);
    expect(typeof unetMeta?.cachedAt).toBe('number');
    for (const meta of cached) {
      expect('data' in meta).toBe(false);
    }

    await deleteCachedModel('ig2_unet_fp32');
    const afterDelete = await getCachedModels();
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]?.modelId).toBe('ig2_cpsam_fp16');

    await clearModelCache();
    const afterClear = await getCachedModels();
    expect(afterClear).toHaveLength(0);
  });

  it('succeeds without throwing when deleting a non-existent key or clearing an empty store', async () => {
    await expect(deleteCachedModel('ig2_unet_fp32')).resolves.toBeUndefined();
    await expect(clearModelCache()).resolves.toBeUndefined();
    await expect(getCachedModels()).resolves.toEqual([]);
  });

  it('surfaces QuotaExceededError clearly when IndexedDB storage is full', async () => {
    const quotaDb = createMockIndexedDB({ simulateQuotaExceededOnPut: true });
    Object.defineProperty(globalThis, 'indexedDB', {
      value: quotaDb.factory,
      configurable: true,
      writable: true,
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      createChunkedResponse([new Uint8Array([1, 2, 3])], { contentLength: 3 }),
    ) as unknown as typeof fetch;

    // Explicit "download for offline use": the failure is reported.
    await expect(downloadModel('ig2_unet_fp32', { requireCache: true })).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    // During an analysis: the model is still returned, and the failure is recorded.
    globalThis.fetch = vi.fn().mockResolvedValue(
      createChunkedResponse([new Uint8Array([1, 2, 3])], { contentLength: 3 }),
    ) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const buf = await downloadModel('ig2_unet_fp32');
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
    expect(getLastCacheWriteError()).toMatch(/QuotaExceeded|quota/i);
    warn.mockRestore();
  });

  it('stores models as Blobs (Chromium rejects single IndexedDB values over ~127 MB) and reads them back', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createChunkedResponse([new Uint8Array([7, 8, 9, 10])], { contentLength: 4 }),
    ) as unknown as typeof fetch;
    await downloadModel('ig2_unet_fp32');
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const again = await getModel('ig2_unet_fp32');
    expect(new Uint8Array(again)).toEqual(new Uint8Array([7, 8, 9, 10]));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('checks storage quota via navigator.storage.estimate() and falls back to zeros when unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          estimate: vi.fn().mockResolvedValue({
            usage: 100_000,
            quota: 1_000_000,
          }),
        },
      },
      configurable: true,
      writable: true,
    });

    const quota = await checkStorageQuota();
    expect(quota).toEqual({
      usageBytes: 100_000,
      quotaBytes: 1_000_000,
      availableBytes: 900_000,
    });

    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });

    const fallbackQuota = await checkStorageQuota();
    expect(fallbackQuota).toEqual({
      usageBytes: 0,
      quotaBytes: 0,
      availableBytes: 0,
    });
  });

  describe('integrity pinning (SHA-256 + size)', () => {
    const original = { ...MODEL_INTEGRITY.ig2_unet_fp32 };
    afterEach(() => {
      MODEL_INTEGRITY.ig2_unet_fp32 = { ...original };
      setModelIntegrityEnforcement(false);
    });

    it('sha256Hex matches the known digest of "abc"', async () => {
      expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });

    it('accepts a payload whose SHA-256 and size match, and records the hash', async () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      MODEL_INTEGRITY.ig2_unet_fp32 = { sha256: await sha256Hex(payload), sizeBytes: payload.byteLength };
      setModelIntegrityEnforcement(true);
      globalThis.fetch = vi.fn().mockResolvedValue(
        createChunkedResponse([payload], { contentLength: payload.byteLength }),
      ) as unknown as typeof fetch;
      const buf = await downloadModel('ig2_unet_fp32');
      expect(new Uint8Array(buf)).toEqual(payload);
      const meta = (await getCachedModels()).find((m) => m.modelId === 'ig2_unet_fp32');
      expect(meta?.sha256).toBe(MODEL_INTEGRITY.ig2_unet_fp32.sha256);
    });

    it('rejects a tampered payload of the right size and does not cache it', async () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      MODEL_INTEGRITY.ig2_unet_fp32 = { sha256: await sha256Hex(payload), sizeBytes: 5 };
      setModelIntegrityEnforcement(true);
      globalThis.fetch = vi.fn().mockResolvedValue(
        createChunkedResponse([new Uint8Array([9, 9, 9, 9, 9])], { contentLength: 5 }),
      ) as unknown as typeof fetch;
      await expect(downloadModel('ig2_unet_fp32')).rejects.toThrow(/Integrity check failed.*SHA-256/);
      expect((await getCachedModels()).some((m) => m.modelId === 'ig2_unet_fp32')).toBe(false);
    });

    it('rejects a payload with the wrong size', async () => {
      MODEL_INTEGRITY.ig2_unet_fp32 = { sha256: '0'.repeat(64), sizeBytes: 999 };
      setModelIntegrityEnforcement(true);
      globalThis.fetch = vi.fn().mockResolvedValue(
        createChunkedResponse([new Uint8Array([1, 2])], { contentLength: 2 }),
      ) as unknown as typeof fetch;
      await expect(downloadModel('ig2_unet_fp32')).rejects.toThrow(/expected 999 bytes/);
    });

    it('treats a legacy unverified cache record as stale and re-downloads', async () => {
      const payload = new Uint8Array([7, 7, 7]);
      setModelIntegrityEnforcement(false);
      globalThis.fetch = vi.fn().mockResolvedValue(
        createChunkedResponse([payload], { contentLength: 3 }),
      ) as unknown as typeof fetch;
      await downloadModel('ig2_unet_fp32'); // cached without sha256
      MODEL_INTEGRITY.ig2_unet_fp32 = { sha256: await sha256Hex(payload), sizeBytes: 3 };
      setModelIntegrityEnforcement(true);
      const fetchMock = vi.fn().mockResolvedValue(
        createChunkedResponse([payload], { contentLength: 3 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      await getModel('ig2_unet_fp32');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await getModel('ig2_unet_fp32'); // now verified record -> cache hit
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
