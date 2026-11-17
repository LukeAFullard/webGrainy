/**
 * Analysis progress model for the activity bar: turns engine progress events into a
 * stage, a fraction and a time-left estimate. Pure (no DOM), so it is unit-tested.
 */

export type ActivityStage = 'starting' | 'download' | 'model-load' | 'preprocess' | 'inference' | 'postprocess' | 'saving';

export interface ActivityState {
  photoIndex: number; // 1-based
  photoTotal: number;
  photoLabel: string;
  stage: ActivityStage;
  tilesDone: number;
  tilesTotal: number;
  dlLoaded: number;
  dlTotal: number;
  modelId: string;
  /** When the current tile run (first tile request) started. */
  tilesStartedAt: number | null;
  lastTileAt: number | null;
  /** Mean ms per tile, measured over this batch (carried to the next photo). */
  msPerTile: number | null;
  tileSamples: number;
  postPercent: number;
}

export function newActivity(photoTotal: number): ActivityState {
  return {
    photoIndex: 0,
    photoTotal,
    photoLabel: '',
    stage: 'starting',
    tilesDone: 0,
    tilesTotal: 0,
    dlLoaded: 0,
    dlTotal: 0,
    modelId: '',
    tilesStartedAt: null,
    lastTileAt: null,
    msPerTile: null,
    tileSamples: 0,
    postPercent: 0,
  };
}

/** A new photo starts (index is 1-based). */
export function startPhoto(s: ActivityState, index: number, label: string): ActivityState {
  return {
    ...s,
    photoIndex: index,
    photoLabel: label,
    stage: 'preprocess',
    tilesDone: 0,
    tilesTotal: 0,
    tilesStartedAt: null,
    lastTileAt: null,
    postPercent: 0,
  };
}

type Detail = Record<string, unknown> | undefined;
const num = (d: Detail, k: string): number | undefined =>
  typeof d?.[k] === 'number' && Number.isFinite(d[k] as number) ? (d[k] as number) : undefined;

/** Applies one engine progress event. */
export function applyEvent(s: ActivityState, stage: string, detail: unknown, now: number): ActivityState {
  const d = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : undefined;
  switch (stage) {
    case 'download':
      return { ...s, stage: 'download', dlLoaded: num(d, 'loadedBytes') ?? s.dlLoaded, dlTotal: num(d, 'totalBytes') ?? s.dlTotal, modelId: String(d?.['modelId'] ?? s.modelId) };
    case 'model-load':
      return d?.['phase'] === 'create-session' ? { ...s, stage: 'model-load', modelId: String(d?.['modelId'] ?? s.modelId) } : s;
    case 'preprocess':
      return { ...s, stage: 'preprocess' };
    case 'inference': {
      const done = num(d, 'completedTiles');
      const total = num(d, 'totalTiles');
      if (done === undefined || total === undefined) {
        // Start of inference for this photo (session may still need loading).
        return { ...s, stage: s.stage === 'download' || s.stage === 'model-load' ? s.stage : 'inference', modelId: String(d?.['modelId'] ?? s.modelId) };
      }
      let { msPerTile, tileSamples } = s;
      const ref = s.lastTileAt ?? s.tilesStartedAt;
      if (ref !== null && done > s.tilesDone) {
        const per = (now - ref) / (done - s.tilesDone);
        // The first tile of a photo includes warm-up; weight it like any other sample.
        msPerTile = msPerTile === null ? per : (msPerTile * tileSamples + per * (done - s.tilesDone)) / (tileSamples + (done - s.tilesDone));
        tileSamples += done - s.tilesDone;
      }
      return { ...s, stage: 'inference', tilesDone: done, tilesTotal: total, lastTileAt: now, msPerTile, tileSamples, tilesStartedAt: s.tilesStartedAt ?? now };
    }
    case 'postprocess':
      return { ...s, stage: 'postprocess', postPercent: num(d, 'percent') ?? s.postPercent };
    case 'done':
    case 'stats':
      return { ...s, stage: 'saving' };
    default:
      return s;
  }
}

/** Marks the moment tile requests begin (so the first tile can be timed). */
export function markTilesStarting(s: ActivityState, now: number): ActivityState {
  return s.tilesStartedAt === null ? { ...s, tilesStartedAt: now } : s;
}

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (m < 60) return r === 0 ? `${m} min` : `${m} min ${r} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const mb = (b: number): string => `${(b / 1e6).toFixed(0)} MB`;

export interface ActivityView {
  title: string;
  detail: string;
  /** 0–1 for a determinate bar, null for indeterminate. */
  fraction: number | null;
  /** Overall batch fraction 0–1. */
  batchFraction: number;
}

export function describeActivity(s: ActivityState): ActivityView {
  const multi = s.photoTotal > 1;
  const title = `${multi ? `Photo ${Math.max(1, s.photoIndex)} of ${s.photoTotal}` : 'Analysing'}${s.photoLabel ? ` · ${s.photoLabel}` : ''}`;
  let detail = '';
  let fraction: number | null = null;
  let within = 0; // progress within the current photo, for the batch bar
  switch (s.stage) {
    case 'starting':
    case 'preprocess':
      detail = 'Preparing the photo…';
      break;
    case 'download':
      fraction = s.dlTotal > 0 ? s.dlLoaded / s.dlTotal : null;
      detail = `Downloading the model (first time only): ${mb(s.dlLoaded)}${s.dlTotal > 0 ? ` of ${mb(s.dlTotal)}` : ''}`;
      break;
    case 'model-load':
      detail = 'Loading the model into memory…';
      break;
    case 'inference': {
      if (s.tilesTotal > 0) {
        fraction = s.tilesDone / s.tilesTotal;
        within = fraction * 0.95;
        const left = s.msPerTile !== null ? (s.tilesTotal - s.tilesDone) * s.msPerTile : null;
        detail = `Finding grains: tile ${s.tilesDone} of ${s.tilesTotal}${left !== null && s.tilesDone < s.tilesTotal ? ` · about ${formatDuration(left)} left` : ''}`;
      } else {
        detail = 'Finding grains…';
      }
      break;
    }
    case 'postprocess':
      fraction = s.postPercent > 0 ? s.postPercent / 100 : null;
      within = 0.95 + 0.05 * (fraction ?? 0);
      detail = 'Tracing grain outlines…';
      break;
    case 'saving':
      within = 1;
      detail = 'Saving results…';
      break;
  }
  const batchFraction = s.photoTotal > 0 ? Math.min(1, (Math.max(0, s.photoIndex - 1) + within) / s.photoTotal) : 0;
  return { title, detail, fraction, batchFraction };
}

/** The activity bar's inner HTML (status text, step and batch progress bars, Cancel). */
export function renderActivityHtml(s: ActivityState): string {
  const esc = (t: string): string =>
    t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const v = describeActivity(s);
  const pct = v.fraction !== null ? Math.round(v.fraction * 100) : null;
  return `
    <div class="activity-text">
      <div class="activity-title">${esc(v.title)}</div>
      <div class="activity-detail">${esc(v.detail)}</div>
    </div>
    <div class="activity-bars">
      ${
        pct !== null
          ? `<progress class="native-progress" value="${pct}" max="100" aria-label="Current step progress"></progress>`
          : `<progress class="native-progress" aria-label="Current step in progress"></progress>`
      }
      ${s.photoTotal > 1 ? `<progress class="native-progress batch" value="${Math.round(v.batchFraction * 100)}" max="100" aria-label="All photos progress"></progress>` : ''}
    </div>
    <button type="button" class="btn btn-sm btn-danger" data-action="cancel-batch">Cancel</button>
  `;
}
