/** CPU thread preference shared by the app and the GPU check page (saved per browser). */
import { wasmThreadsFor } from '../modules/onnxInference.js';

export const CPU_THREADS_KEY = 'webgrainy-cpu-threads';

/** 'auto' (cores − 1, max 8) or a saved explicit count. */
export function readCpuThreadPref(): 'auto' | number {
  try {
    const v = localStorage.getItem(CPU_THREADS_KEY);
    const n = v === null ? NaN : Number(v);
    return Number.isInteger(n) && n >= 1 ? n : 'auto';
  } catch {
    return 'auto';
  }
}

/** Threads to give ONNX Runtime for the saved preference (undefined = single-threaded page). */
export function preferredCpuThreads(): number | undefined {
  return wasmThreadsFor(readCpuThreadPref());
}
