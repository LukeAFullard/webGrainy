/**
 * Service-worker updates without version skew.
 *
 * Problem: activating a new service worker while an old page is open (skipWaiting) deletes
 * the old caches; the old page then lazily loads its post-processing / inference workers
 * and ONNX Runtime files from the NEW build, so mismatched code can break analysis.
 *
 * Rule: a new version waits until the user chooses to reload. The page shows "Reload to
 * update"; only then is the waiting worker activated, and the page reloads as soon as it
 * takes control. On a page that has just loaded with nothing to lose (no analysis running),
 * a waiting worker found at start-up is activated and the page reloaded once.
 */

export interface WorkerLike {
  postMessage(message: unknown): void;
  state?: string;
}

export interface RegistrationLike {
  waiting: WorkerLike | null;
  installing: WorkerLike | null;
  addEventListener(type: 'updatefound', cb: () => void): void;
}

export interface SwUpdateDeps {
  /** True when the page was controlled by a service worker when it loaded. */
  hadController: boolean;
  hasController: () => boolean;
  reload: () => void;
  /** Tell the UI a new version is waiting (show the "Reload to update" button). */
  onUpdateReady: () => void;
  /** Whether a reload now would interrupt work (analysis running). */
  isBusy: () => boolean;
  addControllerChangeListener: (cb: () => void) => void;
  onStateChange: (worker: WorkerLike, cb: () => void) => void;
}

export interface SwUpdateController {
  /** User chose to update: activate the waiting worker; the page reloads when it takes over. */
  applyUpdate(): boolean;
}

export function manageSwUpdates(reg: RegistrationLike, deps: SwUpdateDeps): SwUpdateController {
  let waiting: WorkerLike | null = null;
  let reloadRequested = false;

  const markWaiting = (w: WorkerLike): void => {
    waiting = w;
    deps.onUpdateReady();
  };

  // A worker already waiting when this page loaded: nothing has started yet, so switch now.
  if (reg.waiting && deps.hadController) {
    if (!deps.isBusy()) {
      reloadRequested = true;
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      markWaiting(reg.waiting);
    }
  }

  reg.addEventListener('updatefound', () => {
    const installing = reg.installing;
    if (!installing) return;
    deps.onStateChange(installing, () => {
      // Installed while this page is controlled: an update. Never activate it behind the
      // page's back; offer a reload instead.
      if (installing.state === 'installed' && deps.hasController()) markWaiting(installing);
    });
  });

  deps.addControllerChangeListener(() => {
    if (reloadRequested) deps.reload();
  });

  return {
    applyUpdate(): boolean {
      if (!waiting || deps.isBusy()) return false;
      reloadRequested = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
      return true;
    },
  };
}
