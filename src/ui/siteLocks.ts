/**
 * Which sites are open in some tab (Web Locks API). A tab holds a shared lock on the site it
 * shows; removing an expired site requires the exclusive lock, so a site open in any tab is
 * never removed. Without the API (old browsers) only the site open in this tab is protected.
 */
type LockManagerLike = {
  request(name: string, options: { mode?: 'shared' | 'exclusive'; ifAvailable?: boolean }, cb: (lock: unknown) => Promise<unknown>): Promise<unknown>;
};

const locks = (): LockManagerLike | null =>
  (typeof navigator !== 'undefined' && (navigator as { locks?: LockManagerLike }).locks) || null;

const lockName = (siteId: string): string => `webgrainy-site-${siteId}`;

let held: { siteId: string; release: () => void } | null = null;

/** Holds the shared lock of the site shown in this tab (releasing the previous one). */
export function holdSiteLock(siteId: string | null): void {
  if (held?.siteId === siteId) return;
  held?.release();
  held = null;
  const lm = locks();
  if (!lm || siteId === null) return;
  let release!: () => void;
  const until = new Promise<void>((r) => (release = r));
  held = { siteId, release };
  void lm.request(lockName(siteId), { mode: 'shared' }, () => until).catch(() => undefined);
}

/**
 * Runs `fn` only if no tab has the site open (exclusive lock available). Returns whether it ran.
 * `openHere` is the site open in this tab (always refused).
 */
export async function ifSiteNotOpen(siteId: string, openHere: string | null, fn: () => Promise<void>): Promise<boolean> {
  if (siteId === openHere) return false;
  const lm = locks();
  if (!lm) {
    await fn();
    return true;
  }
  let ran = false;
  await lm.request(lockName(siteId), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (lock === null) return;
    await fn();
    ran = true;
  });
  return ran;
}
