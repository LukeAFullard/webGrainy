import { describe, expect, it } from 'vitest';
import { ScreenWakeLock, type WakeLockEnv } from '../src/ui/wakeLock.js';
import { jobTitle, shouldNotify } from '../src/ui/doneSignal.js';
import { loadAnalysisParams, sanitizeAnalysisParams, saveAnalysisParams, SETTINGS_KEY } from '../src/ui/savedSettings.js';
import { defaultAnalysisParams } from '../src/ui/state.js';

function fakeEnv() {
  let visible = true;
  let onVis: (() => void) | null = null;
  const log: string[] = [];
  const env: WakeLockEnv = {
    wakeLock: {
      request: async () => {
        log.push('request');
        const s = { released: false, release: async () => { s.released = true; log.push('release'); } };
        return s;
      },
    },
    isVisible: () => visible,
    onVisibilityChange: (cb) => { onVis = cb; },
  };
  return { env, log, setVisible: (v: boolean) => { visible = v; onVis?.(); } };
}

describe('screen wake lock', () => {
  it('holds one lock across nested jobs and releases at the end', async () => {
    const f = fakeEnv();
    const lock = new ScreenWakeLock(f.env);
    await lock.acquire();
    await lock.acquire();
    await lock.release();
    expect(f.log).toEqual(['request']);
    await lock.release();
    expect(f.log).toEqual(['request', 'release']);
    await lock.release(); // extra release is harmless
    expect(lock.active).toBe(false);
  });

  it('re-requests the lock when the tab becomes visible again', async () => {
    const f = fakeEnv();
    const lock = new ScreenWakeLock(f.env);
    await lock.acquire();
    // Browser drops the lock on hide; simulate by marking it released.
    f.setVisible(false);
    (lock as unknown as { sentinel: { released: boolean } }).sentinel.released = true;
    f.setVisible(true);
    await Promise.resolve();
    expect(f.log.filter((l) => l === 'request')).toHaveLength(2);
  });

  it('does nothing without the API', async () => {
    const lock = new ScreenWakeLock({ isVisible: () => true, onVisibilityChange: () => {} });
    expect(lock.supported).toBe(false);
    await lock.acquire();
    await lock.release();
  });
});

describe('done signal', () => {
  it('shows progress and completion in the title only while hidden', () => {
    expect(jobTitle('webGrainy', { completed: 3, total: 12 }, null, true)).toBe('(3/12) webGrainy');
    expect(jobTitle('webGrainy', { completed: 3, total: 12 }, null, false)).toBeNull();
    expect(jobTitle('webGrainy', null, 'done', true)).toBe('✓ Done · webGrainy');
    expect(jobTitle('webGrainy', null, 'cancelled', true)).toBe('Stopped · webGrainy');
    expect(jobTitle('webGrainy', null, null, true)).toBeNull();
  });

  it('notifies only for long, hidden, permitted, opted-in jobs', () => {
    expect(shouldNotify(true, 120_000, true, 'granted')).toBe(true);
    expect(shouldNotify(false, 120_000, true, 'granted')).toBe(false);
    expect(shouldNotify(true, 10_000, true, 'granted')).toBe(false);
    expect(shouldNotify(true, 120_000, false, 'granted')).toBe(false);
    expect(shouldNotify(true, 120_000, true, 'default')).toBe(false);
  });
});

describe('remembered analysis settings', () => {
  function mem() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  }

  it('round-trips changed settings and stores nothing for the defaults', () => {
    const s = mem();
    saveAnalysisParams(defaultAnalysisParams(), s);
    expect(s.data.has(SETTINGS_KEY)).toBe(false);
    const changed = { ...defaultAnalysisParams(), model: 'unet' as const, flowThreshold: 0.6 };
    saveAnalysisParams(changed, s);
    expect(loadAnalysisParams(s)).toEqual(changed);
  });

  it('falls back to defaults for corrupt, old or out-of-range values', () => {
    const d = defaultAnalysisParams();
    expect(sanitizeAnalysisParams(null)).toEqual(d);
    expect(sanitizeAnalysisParams([1, 2])).toEqual(d);
    const r = sanitizeAnalysisParams({
      model: 'resnet', // unknown option
      cpsamWeights: 'int8',
      flowThreshold: 'high', // wrong type
      minSize: -5, // out of range
      maxGrainAreaFraction: Number.NaN,
      excludeBorder: false,
      retired: 1, // unknown field
    });
    expect(r).toEqual({ ...d, cpsamWeights: 'int8', excludeBorder: false });
    const s = mem();
    s.data.set(SETTINGS_KEY, '{oops');
    expect(loadAnalysisParams(s)).toEqual(d);
  });
});
