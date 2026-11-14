import { vi } from 'vitest';
import type * as ort from 'onnxruntime-web';

export interface MockIDBOptions {
  quotaExceeded?: boolean;
  backingStore?: Map<string, Map<string, unknown>>;
}

interface MockIDBRequest<T = unknown> {
  result: T;
  error: Error | null;
  onsuccess: ((ev: { target: MockIDBRequest<T> }) => void) | null;
  onerror: ((ev: { target: MockIDBRequest<T> }) => void) | null;
  onupgradeneeded?: ((ev: { target: MockIDBRequest<T> }) => void) | null;
  onblocked?: ((ev: { target: MockIDBRequest<T> }) => void) | null;
}

function makeRequest<T>(
  executor: () => T,
  onUpgrade?: (req: MockIDBRequest<T>) => void,
  tx?: MockIDBTransaction
): MockIDBRequest<T> {
  const req: MockIDBRequest<T> = {
    result: undefined as unknown as T,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
  };
  tx?.registerRequest();
  queueMicrotask(() => {
    try {
      if (onUpgrade && req.onupgradeneeded) {
        onUpgrade(req);
      }
      req.result = executor();
      req.onsuccess?.({ target: req });
      tx?.completeRequest();
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      req.error = errorObj;
      req.onerror?.({ target: req });
      tx?.failRequest(errorObj);
    }
  });
  return req;
}

export class MockIDBObjectStore {
  private readonly store: Map<string, unknown>;
  private readonly quotaExceeded: boolean;
  private readonly tx?: MockIDBTransaction;

  constructor(store: Map<string, unknown>, quotaExceeded: boolean, tx?: MockIDBTransaction) {
    this.store = store;
    this.quotaExceeded = quotaExceeded;
    this.tx = tx;
  }

  get(key: string): MockIDBRequest<unknown> {
    return makeRequest(() => this.store.get(key), undefined, this.tx);
  }

  put(value: unknown, key?: string): MockIDBRequest<string> {
    return makeRequest(
      () => {
        if (this.quotaExceeded) {
          const err = new Error('QuotaExceededError: IndexedDB storage quota exceeded');
          err.name = 'QuotaExceededError';
          throw err;
        }
        const record = value as Record<string, unknown> | null;
        const resolvedKey =
          key ??
          (record && typeof record === 'object' && typeof record['modelId'] === 'string'
            ? record['modelId']
            : record && typeof record === 'object' && typeof record['id'] === 'string'
              ? record['id']
              : String(this.store.size));
        this.store.set(resolvedKey, value);
        return resolvedKey;
      },
      undefined,
      this.tx
    );
  }

  delete(key: string): MockIDBRequest<undefined> {
    return makeRequest(
      () => {
        this.store.delete(key);
        return undefined;
      },
      undefined,
      this.tx
    );
  }

  clear(): MockIDBRequest<undefined> {
    return makeRequest(
      () => {
        this.store.clear();
        return undefined;
      },
      undefined,
      this.tx
    );
  }

  getAll(): MockIDBRequest<unknown[]> {
    return makeRequest(() => Array.from(this.store.values()), undefined, this.tx);
  }

  getAllKeys(): MockIDBRequest<string[]> {
    return makeRequest(() => Array.from(this.store.keys()), undefined, this.tx);
  }
}

export class MockIDBTransaction {
  private readonly db: MockIDBDatabase;
  private pendingRequests = 0;
  private failed = false;
  public error: Error | null = null;
  public oncomplete: (() => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public onabort: ((ev: unknown) => void) | null = null;

  constructor(db: MockIDBDatabase) {
    this.db = db;
    // If no requests are queued synchronously after transaction creation, complete on next microtask.
    queueMicrotask(() => {
      if (this.pendingRequests === 0 && !this.failed) {
        this.oncomplete?.();
      }
    });
  }

  registerRequest(): void {
    this.pendingRequests += 1;
  }

  completeRequest(): void {
    this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    if (this.pendingRequests === 0 && !this.failed) {
      queueMicrotask(() => {
        if (this.pendingRequests === 0 && !this.failed) {
          this.oncomplete?.();
        }
      });
    }
  }

  failRequest(err: Error): void {
    this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    if (!this.failed) {
      this.failed = true;
      this.error = err;
      this.onerror?.({ target: this });
    }
  }

  objectStore(name: string): MockIDBObjectStore {
    return this.db.getOrCreateStore(name, this);
  }
}

export class MockIDBDatabase {
  public readonly name: string;
  public readonly version: number;
  public readonly objectStoreNames: {
    readonly length: number;
    item: (index: number) => string | null;
    contains: (name: string) => boolean;
  };
  private readonly stores: Map<string, Map<string, unknown>>;
  private readonly quotaExceeded: boolean;

  constructor(
    name: string,
    version: number,
    stores: Map<string, Map<string, unknown>>,
    quotaExceeded: boolean
  ) {
    this.name = name;
    this.version = version;
    this.stores = stores;
    this.quotaExceeded = quotaExceeded;
    this.objectStoreNames = {
      get length() {
        return stores.size;
      },
      item: (index: number) => Array.from(this.stores.keys())[index] ?? null,
      contains: (storeName: string) => this.stores.has(storeName),
    };
  }

  createObjectStore(name: string, _options?: IDBObjectStoreParameters): MockIDBObjectStore {
    return this.getOrCreateStore(name);
  }

  getOrCreateStore(name: string, tx?: MockIDBTransaction): MockIDBObjectStore {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map<string, unknown>();
      this.stores.set(name, store);
    }
    return new MockIDBObjectStore(store, this.quotaExceeded, tx);
  }

  transaction(_storeNames: string | string[], _mode?: 'readonly' | 'readwrite'): MockIDBTransaction {
    return new MockIDBTransaction(this);
  }

  close(): void {
    // no-op
  }
}

export class MockIDBFactory {
  public readonly backingStore: Map<string, Map<string, unknown>>;
  public quotaExceeded: boolean;

  constructor(options: MockIDBOptions = {}) {
    this.backingStore = options.backingStore ?? new Map<string, Map<string, unknown>>();
    this.quotaExceeded = options.quotaExceeded ?? false;
  }

  open(name: string, version = 1): MockIDBRequest<MockIDBDatabase> {
    const db = new MockIDBDatabase(name, version, this.backingStore, this.quotaExceeded);
    return makeRequest(
      () => db,
      (req) => {
        req.result = db;
        req.onupgradeneeded?.({ target: req });
      }
    );
  }

  deleteDatabase(name: string): MockIDBRequest<undefined> {
    return makeRequest(() => {
      if (name === 'imagegrains-onnx-cache-v1') {
        this.backingStore.clear();
      }
      return undefined;
    });
  }
}

export interface MockFetchOptions {
  payloadBytes?: Uint8Array;
  chunkSize?: number;
  status?: number;
  omitContentLength?: boolean;
  failAfterChunks?: number;
  networkError?: boolean;
}

export function createMockFetch(options: MockFetchOptions = {}): typeof fetch {
  const payload = options.payloadBytes ?? new Uint8Array(64 * 1024).fill(0x2a);
  const chunkSize = options.chunkSize ?? 16 * 1024;
  const status = options.status ?? 200;

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (options.networkError) {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    }

    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes('imagegrains-2.0-onnx') && !url.endsWith('.onnx')) {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }

    if (status >= 400) {
      return new Response(null, { status, statusText: 'Mock HTTP Error' });
    }

    let offset = 0;
    let chunkIndex = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        if (options.failAfterChunks !== undefined && chunkIndex >= options.failAfterChunks) {
          controller.error(new Error('Simulated mid-stream network failure'));
          return;
        }
        if (offset >= payload.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, payload.byteLength);
        controller.enqueue(payload.slice(offset, end));
        offset = end;
        chunkIndex += 1;
      },
    });

    const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
    if (!options.omitContentLength) {
      headers.set('Content-Length', String(payload.byteLength));
    }

    return new Response(stream, { status, headers });
  }) as unknown as typeof fetch;
}

export interface MockNavigatorOptions {
  hasWebGPU?: boolean;
  deviceMemoryGB?: number | undefined;
  usageBytes?: number;
  quotaBytes?: number;
}

export function createMockNavigator(options: MockNavigatorOptions = {}): Record<string, unknown> {
  const hasWebGPU = options.hasWebGPU ?? true;
  const usage = options.usageBytes ?? 1024 * 1024;
  const quota = options.quotaBytes ?? 2 * 1024 * 1024 * 1024;

  const nav: Record<string, unknown> = {
    storage: {
      estimate: vi.fn(async () => ({ usage, quota })),
    },
    hardwareConcurrency: 8,
  };

  if (options.deviceMemoryGB !== undefined) {
    nav['deviceMemory'] = options.deviceMemoryGB;
  }

  if (hasWebGPU) {
    nav['gpu'] = {
      requestAdapter: vi.fn(async () => ({
        name: 'MockWebGPUAdapter',
        requestDevice: vi.fn(async () => ({})),
      })),
    };
  }

  return nav;
}

export interface MockTensor {
  dims: readonly number[];
  type: string;
  data: Float32Array | Uint16Array;
}

export interface MockOnnxSessionOptions {
  mode: 'unet' | 'cpsam';
  customFlowGenerator?: (
    width: number,
    height: number
  ) => { flowY: Float32Array; flowX: Float32Array; cellprob: Float32Array };
}

export interface CapturedOnnxInput {
  dims: readonly number[];
  type: string;
  data: Float32Array | Uint16Array;
}

export interface MockOnnxSession extends ort.InferenceSession {
  observedInputShapes: Array<readonly number[]>;
  observedInputTypes: string[];
  capturedInputs: CapturedOnnxInput[];
}

export function createMockOnnxSession(options: MockOnnxSessionOptions): MockOnnxSession {
  const observedInputShapes: Array<readonly number[]> = [];
  const observedInputTypes: string[] = [];
  const capturedInputs: CapturedOnnxInput[] = [];

  return {
    inputNames: ['image'],
    outputNames: ['flows_cellprob'],
    inputMetadata: [] as unknown as ort.InferenceSession['inputMetadata'],
    outputMetadata: [] as unknown as ort.InferenceSession['outputMetadata'],
    observedInputShapes,
    observedInputTypes,
    capturedInputs,
    startProfiling(): void {
      // no-op
    },
    endProfiling(): void {
      // no-op
    },
    async run(
      feeds: ort.InferenceSession.FeedsType
    ): Promise<ort.InferenceSession.ReturnType> {
      const firstKey = Object.keys(feeds)[0] ?? 'image';
      const input = feeds[firstKey] as unknown as MockTensor | undefined;
      if (!input) {
        throw new Error('Missing input tensor in ONNX session.run');
      }

      observedInputShapes.push([...input.dims]);
      observedInputTypes.push(input.type);
      capturedInputs.push({
        dims: [...input.dims],
        type: input.type,
        data: input.data.slice(),
      });

      if (options.mode === 'unet') {
        const batch = input.dims[0] ?? 0;
        const channels = input.dims[1] ?? 0;
        const h = input.dims[2] ?? 0;
        const w = input.dims[3] ?? 0;
        if (batch !== 1 || channels !== 2 || h <= 0 || w <= 0 || h % 16 !== 0 || w % 16 !== 0) {
          throw new Error(
            `Invalid U-Net input shape [${input.dims.join(', ')}]; expected [1, 2, mult16, mult16]`
          );
        }
        const hw = h * w;
        // Verify channel 1 is all zeros per infer_unet.py contract
        const ch1 = input.data.subarray(hw, 2 * hw);
        for (let i = 0; i < ch1.length; i++) {
          if ((ch1[i] ?? 0) !== 0) {
            throw new Error(`U-Net channel 1 must be all zeros, found non-zero at index ${i}`);
          }
        }

        const out = new Float32Array(3 * hw);
        if (options.customFlowGenerator) {
          const gen = options.customFlowGenerator(w, h);
          out.set(gen.flowY.subarray(0, hw), 0);
          out.set(gen.flowX.subarray(0, hw), hw);
          out.set(gen.cellprob.subarray(0, hw), 2 * hw);
        } else {
          // Synthesize 4 clean circular grains inside the padded frame
          const centers: ReadonlyArray<readonly [number, number]> = [
            [Math.floor(w * 0.25), Math.floor(h * 0.25)],
            [Math.floor(w * 0.75), Math.floor(h * 0.25)],
            [Math.floor(w * 0.25), Math.floor(h * 0.75)],
            [Math.floor(w * 0.75), Math.floor(h * 0.75)],
          ];
          const radius = Math.max(6, Math.min(20, Math.floor(Math.min(w, h) * 0.14)));
          out.fill(-4.0, 2 * hw, 3 * hw);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const idx = y * w + x;
              for (const [cx, cy] of centers) {
                const dy = cy - y;
                const dx = cx - x;
                const dist = Math.hypot(dx, dy);
                if (dist <= radius) {
                  const inv = dist > 1e-6 ? 1 / dist : 0;
                  out[idx] = dy * inv;
                  out[hw + idx] = dx * inv;
                  out[2 * hw + idx] = 4.0;
                  break;
                }
              }
            }
          }
        }
        return {
          flows_cellprob: {
            dims: [1, 3, h, w],
            type: 'float32',
            data: out,
          } as unknown as ort.Tensor,
        };
      }

      // CP-SAM mode: [batch, 3, 256, 256]
      const batch = input.dims[0] ?? 0;
      const channels = input.dims[1] ?? 0;
      const h = input.dims[2] ?? 0;
      const w = input.dims[3] ?? 0;
      if (batch <= 0 || channels !== 3 || h !== 256 || w !== 256) {
        throw new Error(
          `Invalid CP-SAM input shape [${input.dims.join(', ')}]; expected [B, 3, 256, 256]`
        );
      }
      const hw = 256 * 256;
      const isFloat16 = input.type === 'float16';
      const outData = isFloat16 ? new Uint16Array(batch * 3 * hw) : new Float32Array(batch * 3 * hw);

      for (let b = 0; b < batch; b++) {
        const base = b * 3 * hw;
        const tileFlow = options.customFlowGenerator
          ? options.customFlowGenerator(256, 256)
          : (() => {
              const flowY = new Float32Array(hw);
              const flowX = new Float32Array(hw);
              const cellprob = new Float32Array(hw).fill(-4.0);
              const cx = 128;
              const cy = 128;
              const r = 65;
              for (let y = 0; y < 256; y++) {
                for (let x = 0; x < 256; x++) {
                  const dy = cy - y;
                  const dx = cx - x;
                  const d = Math.hypot(dx, dy);
                  if (d <= r) {
                    const idx = y * 256 + x;
                    flowY[idx] = d > 1e-6 ? dy / d : 0;
                    flowX[idx] = d > 1e-6 ? dx / d : 0;
                    cellprob[idx] = 4.0;
                  }
                }
              }
              return { flowY, flowX, cellprob };
            })();

        if (outData instanceof Uint16Array) {
          for (let i = 0; i < hw; i++) {
            outData[base + i] = float32ToFloat16Bits(tileFlow.flowY[i] ?? 0);
            outData[base + hw + i] = float32ToFloat16Bits(tileFlow.flowX[i] ?? 0);
            outData[base + 2 * hw + i] = float32ToFloat16Bits(tileFlow.cellprob[i] ?? 0);
          }
        } else {
          outData.set(tileFlow.flowY, base);
          outData.set(tileFlow.flowX, base + hw);
          outData.set(tileFlow.cellprob, base + 2 * hw);
        }
      }

      return {
        flows_cellprob: {
          dims: [batch, 3, 256, 256],
          type: isFloat16 ? 'float16' : 'float32',
          data: outData,
        } as unknown as ort.Tensor,
      };
    },
    async release(): Promise<void> {
      // no-op
    },
  };
}

export function float32ToFloat16Bits(val: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const x = u32[0] ?? 0;
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = (x >>> 13) & 0x03ff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = ((x & 0x007fffff) | 0x00800000) >>> (14 - exp);
    return sign | mant;
  }
  if (exp >= 31) {
    return sign | 0x7c00;
  }
  return sign | (exp << 10) | mant;
}

export class MockWorker {
  public static defaultHandler: ((data: unknown, transfer?: Transferable[]) => unknown) | null = null;
  public readonly scriptURL: string | URL;
  public readonly postedMessages: Array<{ data: unknown; transfer?: Transferable[] }> = [];
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public onerror: ((ev: ErrorEvent) => void) | null = null;
  public terminated = false;
  private readonly listeners = new Map<string, Set<(ev: Event) => void>>();
  private readonly handler: ((data: unknown, transfer?: Transferable[]) => unknown) | null;

  constructor(
    scriptURL: string | URL,
    options?: WorkerOptions & {
      handler?: (data: unknown, transfer?: Transferable[]) => unknown;
    }
  ) {
    this.scriptURL = scriptURL;
    this.handler = options?.handler ?? MockWorker.defaultHandler;
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.terminated) {
      throw new Error('Cannot postMessage on a terminated Worker.');
    }
    this.postedMessages.push({ data: message, transfer });

    if (this.handler) {
      queueMicrotask(() => {
        if (this.terminated) return;
        try {
          const response = this.handler!(message, transfer);
          if (response !== undefined) {
            const event = { data: response } as MessageEvent;
            this.onmessage?.(event);
            const msgListeners = this.listeners.get('message');
            if (msgListeners) {
              for (const fn of msgListeners) {
                fn(event);
              }
            }
          }
        } catch (err) {
          const errEvent = {
            message: err instanceof Error ? err.message : String(err),
            error: err,
          } as ErrorEvent;
          this.onerror?.(errEvent);
        }
      });
    }
  }

  addEventListener(type: string, listener: (ev: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }
}

export interface BrowserMockHandle {
  idb: MockIDBFactory;
  fetchMock: typeof fetch;
  navigatorMock: Record<string, unknown>;
}

export function setupBrowserMocks(options?: {
  idb?: MockIDBOptions;
  fetch?: MockFetchOptions;
  navigator?: MockNavigatorOptions;
}): BrowserMockHandle {
  const idb = new MockIDBFactory(options?.idb);
  const fetchMock = createMockFetch(options?.fetch);
  const navigatorMock = createMockNavigator(options?.navigator);

  vi.stubGlobal('indexedDB', idb);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', navigatorMock);

  if (typeof globalThis.ImageData === 'undefined') {
    class PolyfillImageData {
      public readonly data: Uint8ClampedArray;
      public readonly width: number;
      public readonly height: number;
      constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
        if (typeof dataOrWidth === 'number') {
          this.width = dataOrWidth;
          this.height = widthOrHeight;
          this.data = new Uint8ClampedArray(this.width * this.height * 4);
        } else {
          this.data = dataOrWidth;
          this.width = widthOrHeight;
          this.height = height ?? dataOrWidth.length / (4 * widthOrHeight);
        }
      }
    }
    vi.stubGlobal('ImageData', PolyfillImageData);
  }

  if (typeof globalThis.Worker === 'undefined') {
    vi.stubGlobal('Worker', MockWorker);
  }

  return { idb, fetchMock, navigatorMock };
}

export function teardownBrowserMocks(): void {
  MockWorker.defaultHandler = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}
