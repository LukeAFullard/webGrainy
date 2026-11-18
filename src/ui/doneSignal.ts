/**
 * Tells the user when a long job finishes while they are in another tab: progress in the tab
 * title ("(3/12) webGrainy"), "✓ Done" at the end, and (opt-in) a system notification.
 * The title returns to normal when the tab is shown again.
 */

export const NOTIFY_PREF_KEY = 'webgrainy-notify-when-done';
/** Jobs shorter than this do not raise a notification (the user is probably still here). */
export const NOTIFY_MIN_MS = 60_000;

/** Tab title while a job runs or after it ends; null = the normal title. */
export function jobTitle(
  baseTitle: string,
  job: { completed: number; total: number } | null,
  finished: 'done' | 'cancelled' | null,
  hidden: boolean,
): string | null {
  if (!hidden) return null;
  if (finished === 'done') return `✓ Done · ${baseTitle}`;
  if (finished === 'cancelled') return `Stopped · ${baseTitle}`;
  if (job && job.total > 0) return `(${Math.min(job.completed, job.total)}/${job.total}) ${baseTitle}`;
  return null;
}

export function shouldNotify(enabled: boolean, durationMs: number, hidden: boolean, permission: string): boolean {
  return enabled && hidden && durationMs >= NOTIFY_MIN_MS && permission === 'granted';
}

export class DoneSignal {
  private readonly baseTitle: string;
  private job: { completed: number; total: number } | null = null;
  private finished: 'done' | 'cancelled' | null = null;
  private startedAt = 0;

  constructor() {
    this.baseTitle = typeof document !== 'undefined' ? document.title : 'webGrainy';
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.finished = null;
        this.apply();
      });
    }
  }

  start(total: number): void {
    this.job = { completed: 0, total };
    this.finished = null;
    this.startedAt = Date.now();
    this.apply();
  }

  progress(completed: number, total: number): void {
    if (!this.job) return;
    this.job = { completed, total };
    this.apply();
  }

  /** Ends the job; `body` is the notification text (e.g. "12 photos analysed"). */
  finish(cancelled: boolean, body: string, notifyEnabled: boolean): void {
    if (!this.job) return;
    this.job = null;
    const hidden = typeof document !== 'undefined' && document.hidden;
    this.finished = hidden ? (cancelled ? 'cancelled' : 'done') : null;
    this.apply();
    const permission = typeof Notification !== 'undefined' ? Notification.permission : 'denied';
    if (!cancelled && shouldNotify(notifyEnabled, Date.now() - this.startedAt, hidden, permission)) {
      try {
        new Notification('webGrainy: analysis finished', { body, tag: 'webgrainy-done' });
      } catch {
        /* some mobile browsers only allow notifications from a service worker */
      }
    }
  }

  private apply(): void {
    if (typeof document === 'undefined') return;
    document.title = jobTitle(this.baseTitle, this.job, this.finished, document.hidden) ?? this.baseTitle;
  }
}

/** Asks for notification permission; resolves to whether notifications can be shown. */
export async function requestNotifyPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
