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
 * a waiting worker found at start-up is activated and the page reloaded once, but only when
 * no other tab of the app is open (the worker checks, `SKIP_WAITING_IF_ALONE`): otherwise
 * those tabs would be taken over and load the new build's workers under their old code.
 *
 * A page taken over without asking (the user updated in another tab) is out of date: it is
 * reported through `onStale` so the UI can stop new analyses until it is reloaded. (Workers
 * also refuse to serve a page of another build; see modules/buildId.ts.)
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
  /** Messages from service workers (e.g. `SKIP_WAITING_DEFERRED`). */
  addMessageListener?: (cb: (data: unknown) => void) => void;
  /** This page was taken over by another version without asking: it is out of date. */
  onStale?: () => void;
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

  // A worker already waiting when this page loaded: nothing has started yet, so switch now,
  // unless other tabs are open (the worker then declines and the update is offered instead).
  if (reg.waiting && deps.hadController) {
    const atLoad = reg.waiting;
    if (!deps.isBusy()) {
      reloadRequested = true;
      deps.addMessageListener?.((data) => {
        if ((data as { type?: unknown } | null)?.type === 'SKIP_WAITING_DEFERRED') {
          reloadRequested = false;
          markWaiting(atLoad);
        }
      });
      atLoad.postMessage({ type: 'SKIP_WAITING_IF_ALONE' });
    } else {
      markWaiting(atLoad);
    }
  }

  const watched = new Set<WorkerLike>();
  const watchInstalling = (installing: WorkerLike | null): void => {
    if (!installing || watched.has(installing)) return;
    watched.add(installing);
    deps.onStateChange(installing, () => {
      // Installed while this page is controlled: an update. Never activate it behind the
      // page's back; offer a reload instead.
      if (installing.state === 'installed' && deps.hasController()) markWaiting(installing);
    });
  };
  reg.addEventListener('updatefound', () => watchInstalling(reg.installing));
  // An update that started installing before registration resolved fired 'updatefound' before
  // this listener existed: watch it too.
  watchInstalling(reg.installing);

  let controllerChanges = 0;
  deps.addControllerChangeListener(() => {
    controllerChanges++;
    if (reloadRequested && !deps.isBusy()) {
      deps.reload();
      return;
    }
    // The first take-over of a page that loaded uncontrolled is the same build installing
    // itself; any other unrequested take-over is a newer version from another tab.
    if (reloadRequested || deps.hadController || controllerChanges > 1) deps.onStale?.();
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
