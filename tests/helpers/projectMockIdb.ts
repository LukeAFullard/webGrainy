// Minimal in-memory IndexedDB mock for projectStorage tests (shared helper).
interface StoreEntry {
  keyPath: string;
  data: Map<string, unknown>;
}

export function createProjectMockIDB(options?: {
  /** Make `put` fail (as a full disk would) when this returns true. */
  failPut?: (storeName: string, value: Record<string, unknown>) => boolean;
}): IDBFactory {
  const stores = new Map<string, StoreEntry>();

  const makeReq = <T>(exec: () => T, onUpgrade?: (req: IDBOpenDBRequest) => void) => {
    const req: Record<string, unknown> = {
      result: undefined as unknown as T,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      try {
        if (onUpgrade) {
          onUpgrade(req as unknown as IDBOpenDBRequest);
          if (typeof req['onupgradeneeded'] === 'function') {
            (req['onupgradeneeded'] as (ev: unknown) => void)({ target: req });
          }
        }
        req['result'] = exec();
        if (typeof req['onsuccess'] === 'function') {
          (req['onsuccess'] as (ev: unknown) => void)({ target: req });
        }
      } catch (err) {
        req['error'] = err instanceof Error ? err : new Error(String(err));
        if (typeof req['onerror'] === 'function') {
          (req['onerror'] as (ev: unknown) => void)({ target: req });
        }
      }
    });
    return req;
  };

  const makeTx = () => {
    const tx: Record<string, unknown> = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore(name: string) {
        const entry = stores.get(name);
        if (!entry) {
          throw new Error(`Object store "${name}" not found`);
        }
        const wrapReq = <T>(fn: () => T) => {
          const r = makeReq(fn);
          const origSuccess = () => {
            queueMicrotask(() => {
              if (typeof tx['oncomplete'] === 'function') {
                (tx['oncomplete'] as () => void)();
              }
            });
          };
          queueMicrotask(origSuccess);
          return r as unknown as IDBRequest<T>;
        };
        return {
          get: (key: string) => wrapReq(() => entry.data.get(key)),
          getAll: () => wrapReq(() => Array.from(entry.data.values())),
          put: (val: Record<string, unknown>) =>
            wrapReq(() => {
              if (options?.failPut?.(name, val)) throw new Error(`QuotaExceededError: mock put failure in "${name}"`);
              const k = String(val[entry.keyPath]);
              entry.data.set(k, val);
              return k;
            }),
          delete: (key: string) =>
            wrapReq(() => {
              entry.data.delete(key);
              return undefined;
            }),
          index: (idxName: string) => ({
            getAll: (query: string) =>
              wrapReq(() =>
                Array.from(entry.data.values()).filter(
                  (v) => (v as Record<string, unknown>)[idxName] === query,
                ),
              ),
          }),
        };
      },
    };
    return tx as unknown as IDBTransaction;
  };

  const db = {
    objectStoreNames: {
      contains: (name: string) => stores.has(name),
    },
    createObjectStore: (name: string, opts?: IDBObjectStoreParameters) => {
      const keyPath = typeof opts?.keyPath === 'string' ? opts.keyPath : 'id';
      if (!stores.has(name)) {
        stores.set(name, { keyPath, data: new Map() });
      }
      return { createIndex: () => ({}) };
    },
    transaction: () => makeTx(),
    close: () => undefined,
  } as unknown as IDBDatabase;

  return {
    open: () =>
      makeReq(
        () => db,
        (req) => {
          (req as unknown as { result: IDBDatabase }).result = db;
        },
      ) as unknown as IDBOpenDBRequest,
  } as unknown as IDBFactory;
}
