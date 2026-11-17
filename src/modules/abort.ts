/** Abort helpers shared by the download, inference and analysis code. */

/** An AbortError from a signal's reason (keeps an Error reason as is). */
export function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error(typeof reason === 'string' && reason.length > 0 ? reason : 'The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** The AbortError thrown when an analysis is cancelled (a DOMException where available). */
export function createAnalysisAbortError(message = 'Analysis aborted'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}
