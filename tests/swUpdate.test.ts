/** Regression (re-audit): a new app version never takes over a running page by itself. */
import { describe, expect, it, vi } from 'vitest';
import { manageSwUpdates, type RegistrationLike, type WorkerLike } from '../src/ui/swUpdate.js';

function harness(opts: { waitingAtLoad?: boolean; busy?: boolean; hadController?: boolean } = {}) {
  const posted: Array<{ who: string; msg: unknown }> = [];
  const worker = (who: string): WorkerLike & { fire: () => void; cbs: Array<() => void> } => {
    const w = {
      state: 'installing',
      cbs: [] as Array<() => void>,
      postMessage: (msg: unknown) => posted.push({ who, msg }),
      fire: () => w.cbs.forEach((c) => c()),
    };
    return w;
  };
  let updateFound: () => void = () => {};
  const reg: RegistrationLike & { installing: ReturnType<typeof worker> | null } = {
    waiting: opts.waitingAtLoad ? worker('waiting') : null,
    installing: null,
    addEventListener: (_t, cb) => (updateFound = cb),
  };
  let controllerChange: () => void = () => {};
  let swMessage: (data: unknown) => void = () => {};
  const reload = vi.fn();
  const onUpdateReady = vi.fn();
  const onStale = vi.fn();
  let busy = opts.busy ?? false;
  const ctl = manageSwUpdates(reg, {
    hadController: opts.hadController ?? true,
    hasController: () => true,
    reload,
    onUpdateReady,
    isBusy: () => busy,
    addControllerChangeListener: (cb) => (controllerChange = cb),
    onStateChange: (w, cb) => (w as ReturnType<typeof worker>).cbs.push(cb),
    addMessageListener: (cb) => (swMessage = cb),
    onStale,
  });
  const newVersionInstalls = () => {
    reg.installing = worker('new');
    updateFound();
    reg.installing.state = 'installed';
    reg.installing.fire();
  };
  return {
    ctl, posted, reload, onUpdateReady, onStale, newVersionInstalls,
    controllerChange: () => controllerChange(),
    swMessage: (d: unknown) => swMessage(d),
    setBusy: (b: boolean) => (busy = b),
  };
}

describe('service worker updates', () => {
  it('an update found while the page runs only offers a reload; nothing is activated', () => {
    const h = harness();
    h.newVersionInstalls();
    expect(h.onUpdateReady).toHaveBeenCalledTimes(1);
    expect(h.posted).toEqual([]);
    h.controllerChange(); // e.g. another tab activated it: this page does not reload by itself
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('"Reload to update" activates the waiting version and reloads when it takes control', () => {
    const h = harness();
    h.newVersionInstalls();
    expect(h.ctl.applyUpdate()).toBe(true);
    expect(h.posted).toEqual([{ who: 'new', msg: { type: 'SKIP_WAITING' } }]);
    expect(h.reload).not.toHaveBeenCalled();
    h.controllerChange();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('refuses to update during an analysis', () => {
    const h = harness();
    h.newVersionInstalls();
    h.setBusy(true);
    expect(h.ctl.applyUpdate()).toBe(false);
    expect(h.posted).toEqual([]);
  });

  it('a version already waiting at page load is switched to straight away when this is the only tab', () => {
    const h = harness({ waitingAtLoad: true });
    expect(h.posted).toEqual([{ who: 'waiting', msg: { type: 'SKIP_WAITING_IF_ALONE' } }]);
    h.controllerChange();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.onStale).not.toHaveBeenCalled();
  });

  it('with other tabs open the waiting version declines: the update is offered instead', () => {
    const h = harness({ waitingAtLoad: true });
    h.swMessage({ type: 'SKIP_WAITING_DEFERRED' });
    expect(h.onUpdateReady).toHaveBeenCalledTimes(1);
    // Later the user updates in another tab: this page is taken over, but does not reload
    // by itself; it is reported as out of date.
    h.controllerChange();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.onStale).toHaveBeenCalledTimes(1);
    // Its own "Reload to update" still works.
    expect(h.ctl.applyUpdate()).toBe(true);
    expect(h.posted.at(-1)).toEqual({ who: 'waiting', msg: { type: 'SKIP_WAITING' } });
  });

  it('a page taken over by another tab\'s update is reported out of date', () => {
    const h = harness();
    h.newVersionInstalls();
    h.controllerChange();
    expect(h.onStale).toHaveBeenCalledTimes(1);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('the first take-over of a page that loaded uncontrolled (first install) is not stale; a later one is', () => {
    const h = harness({ hadController: false });
    h.controllerChange();
    expect(h.onStale).not.toHaveBeenCalled();
    h.controllerChange();
    expect(h.onStale).toHaveBeenCalledTimes(1);
  });

  it('an analysis started before the requested switch completed is never reloaded away', () => {
    const h = harness({ waitingAtLoad: true });
    h.setBusy(true);
    h.controllerChange();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.onStale).toHaveBeenCalledTimes(1);
  });

  it('with nothing to update, applyUpdate does nothing', () => {
    expect(harness().ctl.applyUpdate()).toBe(false);
  });
});
