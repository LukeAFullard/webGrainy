/**
 * "Getting started" checklist. Steps tick themselves off from the app state, so the
 * guide always shows the next useful action. Pure (no DOM access) for unit tests.
 */

export interface GuideInput {
  photoCount: number;
  calibratedCount: number;
  exclusionCount: number;
  analysedCount: number;
  exported: boolean;
  isMobile: boolean;
  batchRunning: boolean;
}

export interface GuideStep {
  id: 'photos' | 'scale' | 'exclude' | 'analyse' | 'review';
  title: string;
  text: string;
  done: boolean;
  optional: boolean;
  /** Button: data attribute and label. */
  action?: { attr: string; label: string };
}

export const GUIDE_HIDDEN_KEY = 'webgrainy-guide-hidden';

export function guideSteps(s: GuideInput): GuideStep[] {
  const hasPhoto = s.photoCount > 0;
  return [
    {
      id: 'photos',
      title: 'Add gravel photos',
      text: 'Photos taken straight down, with a ruler or quadrat in view. They stay on your device.',
      done: hasPhoto,
      optional: false,
      action: { attr: 'data-action="add-photos"', label: 'Add photos' },
    },
    {
      id: 'scale',
      title: 'Set the scale',
      text: 'Mark two points a known distance apart (e.g. ruler ends) so sizes are in mm. Recommended.',
      done: s.calibratedCount > 0,
      optional: true,
      ...(hasPhoto ? { action: { attr: 'data-tool="calibrate"', label: 'Calibrate' } } : {}),
    },
    {
      id: 'exclude',
      title: 'Leave out rulers, boots or water',
      text: 'Draw around anything that is not gravel. Optional; do it before analysing to save time.',
      done: s.exclusionCount > 0,
      optional: true,
      ...(hasPhoto ? { action: { attr: 'data-tool="excludePoly"', label: 'Exclude area' } } : {}),
    },
    {
      id: 'analyse',
      title: 'Analyse',
      text: s.isMobile
        ? 'On phones the fast U-Net model is used (26 MB download the first time, then it works offline).'
        : 'The model downloads the first time (U-Net 26 MB; the more accurate CP-SAM 183–617 MB), then works offline. A progress bar shows the time left.',
      done: s.analysedCount > 0,
      optional: false,
      ...(hasPhoto && !s.batchRunning ? { action: { attr: 'data-action="run-batch"', label: 'Analyse' } } : {}),
    },
    {
      id: 'review',
      title: 'Check the outlines, then export',
      text: 'Fix wrong outlines with the Edit grains tools. Results are on the right; Export saves tables and the project.',
      done: s.exported,
      optional: false,
      ...(s.analysedCount > 0 ? { action: { attr: 'data-open-modal="export"', label: 'Export' } } : {}),
    },
  ];
}

const esc = (t: string): string =>
  t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderGuideHtml(steps: GuideStep[]): string {
  const next = steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  return `
    <section class="guide" aria-label="Getting started">
      <div class="row-between">
        <span class="panel-title">Getting started <span class="summary-note">${doneCount} of ${steps.length}</span></span>
        <button type="button" class="btn btn-sm" data-action="hide-guide" title="You can show it again from Help">Hide</button>
      </div>
      <ol class="guide-steps">
        ${steps
          .map(
            (s) => `<li class="guide-step ${s.done ? 'done' : ''} ${s === next ? 'next' : ''}">
              <span class="guide-check" aria-hidden="true">${s.done ? '✓' : ''}</span>
              <span class="guide-body">
                <span class="guide-title">${esc(s.title)}${s.optional ? ' <span class="summary-note">optional</span>' : ''}${s.done ? '<span class="sr-only"> (done)</span>' : ''}</span>
                ${s === next ? `<span class="guide-text">${esc(s.text)}</span>` : ''}
                ${s === next && s.action ? `<button type="button" class="btn btn-sm btn-primary guide-action" ${s.action.attr}>${esc(s.action.label)}</button>` : ''}
              </span>
            </li>`,
          )
          .join('')}
      </ol>
    </section>`;
}

/** The guide's inputs from the app's photos and status (photos need roiConfig/calibration). */
export function guideInputFrom(state: {
  photos: ReadonlyArray<{
    photoId: string;
    calibration?: unknown;
    roiConfig?: { roiPolygon?: unknown; exclusionPolygons: unknown[]; exclusionStrokes: unknown[] };
  }>;
  photoStatuses: ReadonlyMap<string, string>;
  capabilities: { isMobile?: boolean } | null;
  batchRunning: boolean;
}, exported: boolean): GuideInput {
  const hasExclusions = (ph: (typeof state.photos)[number]): boolean =>
    ph.roiConfig !== undefined &&
    (ph.roiConfig.roiPolygon !== undefined || ph.roiConfig.exclusionPolygons.length > 0 || ph.roiConfig.exclusionStrokes.length > 0);
  return {
    photoCount: state.photos.length,
    calibratedCount: state.photos.filter((ph) => ph.calibration !== undefined).length,
    exclusionCount: state.photos.filter(hasExclusions).length,
    analysedCount: state.photos.filter((ph) => state.photoStatuses.get(ph.photoId) === 'done').length,
    exported,
    isMobile: state.capabilities?.isMobile === true,
    batchRunning: state.batchRunning,
  };
}
