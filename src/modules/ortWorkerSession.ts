/**
 * An inference session whose `run` executes in a Web Worker (workers/ortWasm.worker.ts).
 *
 * Used for the WASM (CPU) backend so a long `session.run` (seconds per Cellpose-SAM tile)
 * never blocks the page: progress, the Cancel button and the rest of the UI keep working.
 * Tensors are copied to the worker and outputs transferred back; the object exposes the
 * same `run(feeds)` / `release()` shape the inference code uses.
 */
import { buildMismatchError } from './buildId.js';

export interface WireTensor {
  type: string;
  data: Float32Array | Uint16Array | Int32Array | Uint8Array | BigInt64Array | number[];
  dims: number[];
}

export type OrtWorkerRequest =
  | {
      type: 'create';
      id: number;
      sessionId: number;
      model: ArrayBuffer;
      wasmPaths: string;
      simd: boolean;
      numThreads?: number;
    }
  | { type: 'run'; id: number; sessionId: number; feeds: Record<string, WireTensor> }
  | { type: 'release'; id: number; sessionId: number };

export type OrtWorkerResponse =
  | { type: 'created'; id: number; build?: string }
  | { type: 'ran'; id: number; outputs: Record<string, WireTensor>; build?: string }
  | { type: 'released'; id: number; build?: string }
  | { type: 'error'; id: number; message: string; build?: string };

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', cb: (ev: MessageEvent | ErrorEvent) => void): void;
  terminate(): void;
}

interface TensorLike {
  type: string;
  data: unknown;
  dims: readonly number[];
}

/** A worker shared by every WASM session of a page (one ORT runtime, one model at a time). */
export class OrtWorkerHost {
  private worker: WorkerLike | null = null;
  /** Bumped for every new worker: sessions created in an earlier worker no longer exist. */
  private generation = 0;
  private nextId = 1;
  private nextSession = 1;
  private readonly pending = new Map<number, { resolve: (r: OrtWorkerResponse) => void; reject: (e: Error) => void }>();

  constructor(private readonly factory: () => WorkerLike) {}

  private ensure(): WorkerLike {
    if (this.worker !== null) return this.worker;
    const w = this.factory();
    this.generation++;
    w.addEventListener('message', (ev) => {
      const msg = (ev as MessageEvent<OrtWorkerResponse>).data;
      const p = msg ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      // Inference code from another build (newer version activated in another tab).
      const mismatch = buildMismatchError(msg.build);
      if (mismatch !== null) p.reject(mismatch);
      else if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    });
    w.addEventListener('error', (ev) => {
      const message = (ev as ErrorEvent).message || 'Inference worker failed to start or crashed.';
      this.failAll(new Error(message));
    });
    this.worker = w;
    return w;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    try {
      this.worker?.terminate();
    } catch {
      /* ignore */
    }
    this.worker = null;
  }

  private request(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<OrtWorkerResponse> {
    const w = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Creates a session in the worker; `model` is transferred (the caller's copy is detached). */
  async createSession(
    model: ArrayBuffer | Uint8Array,
    opts: { wasmPaths: string; simd: boolean; numThreads?: number },
  ): Promise<WorkerInferenceSession> {
    const buf =
      model instanceof Uint8Array
        ? model.byteOffset === 0 && model.byteLength === model.buffer.byteLength && model.buffer instanceof ArrayBuffer
          ? model.buffer
          : model.slice().buffer
        : model;
    const sessionId = this.nextSession++;
    await this.request(
      {
        type: 'create',
        sessionId,
        model: buf,
        wasmPaths: opts.wasmPaths,
        simd: opts.simd,
        ...(opts.numThreads !== undefined ? { numThreads: opts.numThreads } : {}),
      },
      [buf as ArrayBuffer],
    );
    return new WorkerInferenceSession(this, sessionId, this.generation);
  }

  /** @internal Whether the worker that created a session (by generation) is still running. */
  isLive(generation: number): boolean {
    return this.worker !== null && this.generation === generation;
  }

  /** @internal */
  async run(sessionId: number, feeds: Record<string, TensorLike>): Promise<Record<string, WireTensor>> {
    const wire: Record<string, WireTensor> = {};
    for (const [name, t] of Object.entries(feeds)) {
      const d = t.data as WireTensor['data'];
      // Copy: the caller may reuse its buffers (e.g. the tile array).
      const copy = ArrayBuffer.isView(d) ? (d as Float32Array).slice() : Array.from(d as number[]);
      wire[name] = { type: t.type, data: copy as WireTensor['data'], dims: [...t.dims] };
    }
    const transfer = Object.values(wire)
      .map((w) => (w.data as { buffer?: unknown }).buffer)
      .filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
    const res = await this.request({ type: 'run', sessionId, feeds: wire }, transfer);
    if (res.type !== 'ran') throw new Error('Unexpected inference worker reply.');
    return res.outputs;
  }

  /** @internal */
  async release(sessionId: number): Promise<void> {
    if (this.worker === null) return;
    await this.request({ type: 'release', sessionId }).catch(() => undefined);
  }

  /** Stops the worker (all its sessions); a new one starts on the next request. */
  terminate(): void {
    this.failAll(new Error('Inference worker was stopped.'));
  }
}

/** `run` / `release` like an ORT InferenceSession, executed in the worker. */
export class WorkerInferenceSession {
  constructor(
    private readonly host: OrtWorkerHost,
    readonly sessionId: number,
    private readonly generation = 0,
  ) {}

  /**
   * False once the worker that held this session crashed or was stopped: a new worker does not
   * have it, so callers must create a new session instead of reusing this one.
   */
  get alive(): boolean {
    return this.host.isLive(this.generation);
  }

  run(feeds: Record<string, TensorLike>): Promise<Record<string, WireTensor>> {
    if (!this.alive) {
      return Promise.reject(new Error('The inference worker holding this model stopped; the model must be loaded again.'));
    }
    return this.host.run(this.sessionId, feeds);
  }

  release(): Promise<void> {
    return this.host.release(this.sessionId);
  }
}
