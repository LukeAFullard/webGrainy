/** Small per-browser on/off preferences (localStorage; silently ignored if storage is blocked). */

export const EXPORTED_ONCE_KEY = 'webgrainy-exported-once';
export const SKIP_LANDING_KEY = 'webgrainy-skip-landing';

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* storage blocked */
  }
}
