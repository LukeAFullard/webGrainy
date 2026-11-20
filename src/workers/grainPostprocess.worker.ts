import { BUILD_ID } from '../modules/buildId.js';
import { flowsToMasksBrowser } from '../modules/postprocessCore.js';
import type { WorkerRequest, WorkerResponse } from '../types/index.js';

interface WorkerScopeLike {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const workerSelf = self as unknown as WorkerScopeLike;

function postResponse(
  message: WorkerResponse,
  transfer?: Transferable[],
): void {
  if (transfer !== undefined && transfer.length > 0) {
    workerSelf.postMessage(message, transfer);
  } else {
    workerSelf.postMessage(message);
  }
}

export function handleWorkerMessage(
  event: MessageEvent<WorkerRequest>,
): void {
  const req = event.data;
  if (!req || req.type !== 'postprocess') {
    return;
  }

  const { requestId, flowY, flowX, cellprob, width, height, options } = req;

  try {
    const result = flowsToMasksBrowser(
      flowY,
      flowX,
      cellprob,
      width,
      height,
      options,
      (stage, percent) => {
        postResponse({
          type: 'progress',
          requestId,
          stage,
          percent,
        });
      },
    );

    postResponse(
      {
        type: 'result',
        requestId,
        result,
        build: BUILD_ID,
      },
      [result.masks.buffer],
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err ?? 'Unknown worker error');
    postResponse({
      type: 'error',
      requestId,
      message,
      build: BUILD_ID,
    });
  }
}

workerSelf.onmessage = handleWorkerMessage;
