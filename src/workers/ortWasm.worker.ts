/**
 * Runs onnxruntime-web WASM (CPU) inference sessions off the main thread.
 *
 * WASM inference is synchronous CPU work: on the page's main thread one Cellpose-SAM tile
 * froze the page for 12-18 s (and the Cancel button with it). The engine keeps tiling and
 * blending on the main thread (cheap) and sends each `session.run` here. Protocol: see
 * `OrtWorkerRequest` / `OrtWorkerResponse` in modules/ortWorkerSession.ts.
 */
import * as ort from 'onnxruntime-web';
import { BUILD_ID } from '../modules/buildId.js';
import type { OrtWorkerRequest, OrtWorkerResponse, WireTensor } from '../modules/ortWorkerSession.js';

interface WorkerScopeLike {
  onmessage: ((event: MessageEvent<OrtWorkerRequest>) => void) | null;
  postMessage(message: OrtWorkerResponse, transfer?: Transferable[]): void;
}

const sessions = new Map<number, ort.InferenceSession>();

function toWire(t: { type: string; data: unknown; dims: readonly number[] }): WireTensor {
  return { type: t.type, data: t.data as WireTensor['data'], dims: [...t.dims] };
}

/** Handles one request; exported for unit tests (which pass their own `post`). */
export async function handleOrtWorkerMessage(
  req: OrtWorkerRequest,
  post: (msg: OrtWorkerResponse, transfer?: Transferable[]) => void,
): Promise<void> {
  try {
    if (req.type === 'create') {
      ort.env.wasm.wasmPaths = req.wasmPaths;
      ort.env.wasm.simd = req.simd;
      if (req.numThreads !== undefined) ort.env.wasm.numThreads = req.numThreads;
      const session = await ort.InferenceSession.create(new Uint8Array(req.model), {
        executionProviders: ['wasm'],
      });
      sessions.set(req.sessionId, session);
      post({ type: 'created', id: req.id, build: BUILD_ID });
      return;
    }
    if (req.type === 'run') {
      const session = sessions.get(req.sessionId);
      if (!session) throw new Error('Inference session not found in the worker (it was released).');
      const feeds: Record<string, ort.Tensor> = {};
      for (const [name, t] of Object.entries(req.feeds)) {
        feeds[name] = new ort.Tensor(t.type as ort.Tensor.Type, t.data as never, t.dims);
      }
      const outputs = await session.run(feeds);
      const out: Record<string, WireTensor> = {};
      const transfer: Transferable[] = [];
      for (const [name, t] of Object.entries(outputs)) {
        const w = toWire(t as unknown as { type: string; data: unknown; dims: readonly number[] });
        out[name] = w;
        const buf = (w.data as { buffer?: unknown }).buffer;
        if (buf instanceof ArrayBuffer && !transfer.includes(buf)) transfer.push(buf);
      }
      post({ type: 'ran', id: req.id, outputs: out, build: BUILD_ID }, transfer);
      return;
    }
    if (req.type === 'release') {
      const session = sessions.get(req.sessionId);
      sessions.delete(req.sessionId);
      await session?.release();
      post({ type: 'released', id: req.id, build: BUILD_ID });
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err), build: BUILD_ID });
  }
}

// Wire up only inside a real worker (not when imported by unit tests).
const WGS = (globalThis as { WorkerGlobalScope?: new () => unknown }).WorkerGlobalScope;
if (WGS !== undefined && globalThis instanceof WGS) {
  const scope = globalThis as unknown as WorkerScopeLike;
  scope.onmessage = (event) => {
    void handleOrtWorkerMessage(event.data, (msg, transfer) => scope.postMessage(msg, transfer ?? []));
  };
}
