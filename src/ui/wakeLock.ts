/**
 * Keeps the screen awake while a batch runs, so a phone or laptop does not sleep mid-analysis
 * (which pauses the tab). Counter-based: nested jobs (e.g. "Analyse all sites" running the
 * open site's batch) hold one lock until the outermost job ends. The browser drops the lock
 * when the tab is hidden, so it is re-requested when the tab becomes visible again.
 * Best-effort: does nothing where the Screen Wake Lock API is missing or refused.
 */

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface WakeLockEnv {
  wakeLock?: WakeLockLike | undefined;
  isVisible(): boolean;
  onVisibilityChange(cb: () => void): void;
}

function browserEnv(): WakeLockEnv {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: WakeLockLike }) : undefined;
  return {
    wakeLock: nav?.wakeLock,
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    onVisibilityChange: (cb) => {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', cb);
    },
  };
}

export class ScreenWakeLock {
  private holders = 0;
  private sentinel: WakeLockSentinelLike | null = null;
  private listening = false;

  constructor(private readonly env: WakeLockEnv = browserEnv()) {}

  get supported(): boolean {
    return this.env.wakeLock !== undefined;
  }

  get active(): boolean {
    return this.holders > 0;
  }

  async acquire(): Promise<void> {
    this.holders += 1;
    if (!this.listening) {
      this.listening = true;
      this.env.onVisibilityChange(() => {
        if (this.holders > 0 && this.env.isVisible() && (!this.sentinel || this.sentinel.released)) void this.request();
      });
    }
    if (this.holders === 1) await this.request();
  }

  async release(): Promise<void> {
    if (this.holders === 0) return;
    this.holders -= 1;
    if (this.holders === 0 && this.sentinel) {
      const s = this.sentinel;
      this.sentinel = null;
      try {
        await s.release();
      } catch {
        /* already released */
      }
    }
  }

  private async request(): Promise<void> {
    if (!this.env.wakeLock || !this.env.isVisible()) return;
    try {
      const s = await this.env.wakeLock.request('screen');
      // The job may have ended while the request was pending.
      if (this.holders === 0) await s.release();
      else this.sentinel = s;
    } catch {
      /* refused (battery saver, permissions policy): carry on without it */
    }
  }
}
