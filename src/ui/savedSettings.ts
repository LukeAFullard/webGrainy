/**
 * Remembers the analysis settings between visits (localStorage, this browser only). Stored
 * values are checked field by field against the defaults: unknown fields are dropped, and a
 * field with the wrong type, an unknown option or an out-of-range number falls back to its
 * default, so an old or hand-edited value can never break an analysis.
 */
import { defaultAnalysisParams, type UiAnalysisParams } from './state.js';

export const SETTINGS_KEY = 'webgrainy-analysis-settings-v1';

const OPTIONS: Partial<Record<keyof UiAnalysisParams, readonly string[]>> = {
  model: ['auto', 'unet', 'cpsam'],
  cpsamWeights: ['auto', 'fp16', 'int8', 'fp4'],
  scaleMode: ['auto', '1.0x', '0.5x', '0.25x'],
};

export const PARAM_RANGES: Partial<Record<keyof UiAnalysisParams, [number, number]>> = {
  claheClipLimit: [0.1, 40],
  flowThreshold: [0, 10],
  cellprobThreshold: [-20, 20],
  minSize: [0, 1e7],
  maxGrainAreaFraction: [0, 1],
  excludeBorderMargin: [0, 100],
  niter: [1, 10_000],
  minSeedDensity: [0, 1e6],
};

export function sanitizeAnalysisParams(raw: unknown): UiAnalysisParams {
  const defaults = defaultAnalysisParams();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof UiAnalysisParams>) {
    const v = src[key];
    const d = defaults[key];
    if (typeof v !== typeof d) continue;
    if (typeof v === 'number') {
      const range = PARAM_RANGES[key];
      if (!Number.isFinite(v) || (range && (v < range[0] || v > range[1]))) continue;
    }
    if (typeof v === 'string' && !(OPTIONS[key] ?? []).includes(v)) continue;
    out[key] = v;
  }
  return out as unknown as UiAnalysisParams;
}

/**
 * Checks one number typed into an analysis setting. Returns the number, or an error message
 * (blank, not a number, or outside the allowed range) so the old value can be kept.
 */
export function parseParamInput(key: string, raw: string): { value: number } | { error: string } {
  if (raw.trim() === '') return { error: 'The field is empty' };
  const v = Number(raw);
  if (!Number.isFinite(v)) return { error: `"${raw}" is not a number` };
  const range = PARAM_RANGES[key as keyof UiAnalysisParams];
  if (range && (v < range[0] || v > range[1])) return { error: `${v} is outside the allowed range ${range[0]} to ${range[1]}` };
  if ((key === 'niter' || key === 'minSize' || key === 'excludeBorderMargin') && !Number.isInteger(v)) {
    return { error: `${v} must be a whole number` };
  }
  return { value: v };
}

export function loadAnalysisParams(store: Pick<Storage, 'getItem'> | null = safeStorage()): UiAnalysisParams {
  try {
    const raw = store?.getItem(SETTINGS_KEY);
    return sanitizeAnalysisParams(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultAnalysisParams();
  }
}

/** Saves the settings; settings equal to the defaults are removed instead of stored. */
export function saveAnalysisParams(params: UiAnalysisParams, store: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage()): void {
  try {
    if (JSON.stringify(params) === JSON.stringify(defaultAnalysisParams())) store?.removeItem(SETTINGS_KEY);
    else store?.setItem(SETTINGS_KEY, JSON.stringify(params));
  } catch {
    /* storage blocked or full */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
