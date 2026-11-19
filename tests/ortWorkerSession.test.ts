/** Regression (re-audit blocker 2): CPU inference runs in a worker, not on the main thread. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ort from 'onnxruntime-web';
import { OrtWorkerHost, type OrtWorkerResponse, type WorkerLike } from '../src/modules/ortWorkerSession.js';
import { handleOrtWorkerMessage } from '../src/workers/ortWasm.worker.js';
import { createInferenceSession } from '../src/modules/onnxInference.js';

/** A fake Worker that runs the real worker message handler (asynchronously, like a worker). */
function fakeWorker(log: string[]): WorkerLike {
  const listeners: Array<(ev: MessageEvent) => void> = [];
  return {
    postMessage(msg: unknown) {
      const req = msg as { type: string };
      log.push(`req:${req.type}`);
      setTimeout(() => {
        void handleOrtWorkerMessage(structuredClone(msg) as never, (res: OrtWorkerResponse) => {
          for (const l of listeners) l({ data: res } as MessageEvent);
        });
      }, 0);
    },
    addEventListener(type, cb) {
      if (type === 'message') listeners.push(cb as (ev: MessageEvent) => void);
    },
    terminate() {
      log.push('terminate');
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('OrtWorkerHost / worker inference', () => {
  it('creates a WASM session in the worker and runs tensors through it', async () => {
    const created: unknown[] = [];
    vi.spyOn(ort.InferenceSession, 'create').mockImplementation((async (_bytes: unknown, opts: unknown) => {
      created.push(opts);
      return {
        async run(feeds: Record<string, ort.Tensor>) {
          const x = feeds['image']!;
          const data = Float32Array.from(x.data as Float32Array, (v) => v * 2);
          return { flows_cellprob: new ort.Tensor('float32', data, x.dims) };
        },
        release: async () => undefined,
      } as unknown as ort.InferenceSession;
    }) as never);
    const log: string[] = [];
    const host = new OrtWorkerHost(() => fakeWorker(log));
    const session = await host.createSession(new Uint8Array([1, 2, 3]), { wasmPaths: 'https://x/ort/', simd: true, numThreads: 3 });
    expect(created).toEqual([{ executionProviders: ['wasm'] }]);
    const input = new Float32Array([1, 2, 3, 4]);
    const out = await session.run({ image: { type: 'float32', data: input, dims: [1, 1, 2, 2] } });
    expect(Array.from(out['flows_cellprob']!.data as Float32Array)).toEqual([2, 4, 6, 8]);
    expect(out['flows_cellprob']!.dims).toEqual([1, 1, 2, 2]);
    expect(Array.from(input)).toEqual([1, 2, 3, 4]); // the caller's buffer is not detached
    expect(ort.env.wasm.numThreads).toBe(3);
    await session.release();
    expect(log).toEqual(['req:create', 'req:run', 'req:release']);
  });

  it('reports worker-side errors to the caller', async () => {
    vi.spyOn(ort.InferenceSession, 'create').mockRejectedValue(new Error('bad model'));
    const host = new OrtWorkerHost(() => fakeWorker([]));
    await expect(host.createSession(new Uint8Array([0]), { wasmPaths: '/ort/', simd: true })).rejects.toThrow(/bad model/);
  });

  it('createInferenceSession routes the WASM backend to the worker when one is given', async () => {
    const spy = vi.spyOn(ort.InferenceSession, 'create').mockResolvedValue({
      run: async () => ({}),
      release: async () => undefined,
    } as unknown as ort.InferenceSession);
    const log: string[] = [];
    const host = new OrtWorkerHost(() => fakeWorker(log));
    const res = await createInferenceSession(new Uint8Array([1]), { forceWasm: true, wasmWorker: host, wasmPaths: 'https://h/ort/' });
    expect(res.executionProvider).toBe('wasm');
    expect(log).toEqual(['req:create']);
    expect(spy).toHaveBeenCalledTimes(1); // once, inside the worker handler
    // Without a worker the session is created on the calling thread, as before.
    log.length = 0;
    await createInferenceSession(new Uint8Array([1]), { forceWasm: true, wasmPaths: 'https://h/ort/' });
    expect(log).toEqual([]);
  });

  it('a crashed worker fails pending requests and the next request starts a new worker', async () => {
    let made = 0;
    const errorCbs: Array<(ev: ErrorEvent) => void> = [];
    const host = new OrtWorkerHost(() => {
      made++;
      return {
        postMessage() {
          setTimeout(() => errorCbs.forEach((cb) => cb({ message: 'out of memory' } as ErrorEvent)), 0);
        },
        addEventListener(type: string, cb: (ev: MessageEvent | ErrorEvent) => void) {
          if (type === 'error') errorCbs.push(cb as (ev: ErrorEvent) => void);
        },
        terminate() {},
      };
    });
    await expect(host.createSession(new Uint8Array([0]), { wasmPaths: '/', simd: true })).rejects.toThrow(/out of memory/);
    await expect(host.createSession(new Uint8Array([0]), { wasmPaths: '/', simd: true })).rejects.toThrow();
    expect(made).toBe(2);
  });
});
