// In-app, plain-language help for every user-facing setting and tool.
// Mirrors docs/SETTINGS_GUIDE.md; keep the two in sync.

export interface HelpTopic {
  /** Setting name as shown in the UI. */
  title: string;
  /** Group heading in the "Settings help" dialog. */
  group: HelpGroup;
  /** What the setting does, in one or two plain sentences. */
  what: string;
  /** Default value, as shown to the user. */
  default: string;
  /** When it is reasonable to change it, and in which direction. */
  when: string;
}

export type HelpGroup =
  | 'Analysis'
  | 'Advanced analysis'
  | 'Site statistics'
  | 'Photo'
  | 'Tools';

export const HELP_GROUP_ORDER: readonly HelpGroup[] = [
  'Analysis',
  'Advanced analysis',
  'Site statistics',
  'Photo',
  'Tools',
];

export const HELP_TOPICS = {
  model: {
    title: 'Model',
    group: 'Analysis',
    what: 'Which neural network finds the grains. CP-SAM is more accurate but a large download (about 617 MB) and needs a modern graphics card for good speed. U-Net is small and fast and works almost anywhere, but is less accurate. Auto picks one for you based on the photo and your hardware.',
    default: 'Auto',
    when: 'Use CP-SAM for results you will report or publish (median D50 error about 3% in testing, vs about 15% for U-Net). Use U-Net for a quick look or on a phone. Use the same model for all photos you compare.',
  },
  scaleMode: {
    title: 'Scale mode',
    group: 'Analysis',
    what: 'The resolution the model works at. Results are always converted back to the original photo pixels and to mm.',
    default: 'Auto (longest side shrunk to at most 1024 px)',
    when: 'Choose "1.0x Full" for large photos with many small grains (slower, more memory). Choose 0.5x or 0.25x for close-up photos of big cobbles or boulders. Shrinking the photo raises the smallest grain that can be detected.',
  },
  flowThreshold: {
    title: 'Flow threshold',
    group: 'Analysis',
    what: 'A quality check on each candidate grain. Higher values accept more (including doubtful) outlines; lower values keep only clean, convincing ones.',
    default: '0.45',
    when: 'Raise it (e.g. 0.6) if obvious grains are missing. Lower it (e.g. 0.3) if you see many ragged or nonsensical outlines. Change in small steps and check the outlines.',
  },
  cellprobThreshold: {
    title: 'Cellprob threshold',
    group: 'Analysis',
    what: 'How sure the model must be that a pixel is part of a grain. Lower values make outlines larger and include fainter stones; higher values are stricter.',
    default: '0',
    when: 'Lower it (e.g. −1) if outlines are too small or dark stones are missed. Raise it (e.g. +1) if outlines bleed into sand or shadow between grains.',
  },
  minSize: {
    title: 'Min size (px²)',
    group: 'Analysis',
    what: 'Objects smaller than this area (in working-resolution pixels) are discarded. It sets the smallest grain the app can report.',
    default: '30 px² (about 6 px across)',
    when: 'Lower it (e.g. 15) for sharp close-up photos where fine grains matter. Raise it if noisy photos produce many tiny false grains. Fine grains near this limit are always under-counted.',
  },
  maxGrainAreaFraction: {
    title: 'Max area fraction',
    group: 'Analysis',
    what: 'A safety limit: no single grain may cover more than this fraction of the photo. It stops a sand patch, water or a big shadow being treated as one giant "grain".',
    default: '0.40 (40% of the photo)',
    when: 'Raise to 1.0 if one real boulder covers more than 40% of the photo and is being left out. Lower it (e.g. 0.15) if huge false grains appear over sand or water; this also drops any real stones above that size.',
  },
  applyClahe: {
    title: 'Apply CLAHE',
    group: 'Analysis',
    what: 'Boosts local contrast before analysis, which can help in harsh light.',
    default: 'Off',
    when: 'Turn on for photos with strong shadows, glare, or very flat lighting where grains are missed. Leave off for normal, evenly lit photos (it was not part of the accuracy testing).',
  },
  claheClipLimit: {
    title: 'CLAHE clip',
    group: 'Analysis',
    what: 'How strong the CLAHE contrast boost is (only used when CLAHE is on).',
    default: '2.0',
    when: 'Increase to 3–4 for stronger enhancement in very difficult lighting. Too high exaggerates noise and texture.',
  },
  excludeBorder: {
    title: 'Exclude border grains',
    group: 'Analysis',
    what: 'Leaves out grains that touch the edge of the photo. They are cut off by the frame, so they look smaller than they are.',
    default: 'On',
    when: 'Keep on for normal use. Turn off only if the photo edge coincides with a real boundary of the sampled area and you accept the cut-off grains. Applies immediately to analysed photos.',
  },
  excludeBorderMargin: {
    title: 'Border margin (px)',
    group: 'Analysis',
    what: 'How close to the photo edge (in working-resolution pixels) a grain must come to count as "touching the border".',
    default: '2 px',
    when: 'Increase (e.g. 5–10) if the photo edges are blurred, vignetted or distorted. Takes effect the next time photos are analysed.',
  },
  niter: {
    title: 'Flow steps',
    group: 'Advanced analysis',
    what: 'How many steps the post-processing takes when tracing each pixel to the centre of its grain.',
    default: '250',
    when: 'Rarely needed. Increase (e.g. 400) if very large or elongated grains are split into several pieces. Higher values are slower. The default is the tested value.',
  },
  minSeedDensity: {
    title: 'Seed density',
    group: 'Advanced analysis',
    what: 'How many pixels must end up at the same point before a new grain is started.',
    default: '2',
    when: 'Rarely needed. Increase (e.g. 4–6) if noise creates many tiny fragment grains. Decrease to 1 only for very small grains. The default is the tested value.',
  },
  poolingMode: {
    title: 'Pooling mode',
    group: 'Site statistics',
    what: 'How grains from all photos are combined into one size distribution. "Physical area-weighted" counts each grain by its visible area, the photo equivalent of a grid (Wolman) pebble count. "Number-weighted" counts every grain once and gives much finer results that are not comparable with pebble counts or sieving.',
    default: 'Physical area-weighted',
    when: 'Keep the default for most work. Use "Equal-photo" if photos cover very different areas and each location should count the same. Use "Virtual Wolman grid" to mimic a field pebble count. Use "Facies-weighted" with per-photo facies weights for stratified sampling. Use "Number-weighted" only if you specifically need a by-count distribution.',
  },
  sizeMetric: {
    title: 'Size metric',
    group: 'Site statistics',
    what: 'Which grain size is used. "b-axis" is the short axis of an ellipse fitted to the outline (standard for photo-sieving). "min-Feret" is the narrowest caliper width of the outline (closest to a hand-measured b-axis). "d_eq" is the diameter of a circle with the same area.',
    default: 'b-axis (ellipse minor)',
    when: 'Keep b-axis for comparison with published photo-sieving. Use min-Feret when comparing with caliper measurements (typically 3–4% larger than b-axis). Always report which one you used.',
  },
  harmonizePhysicalCutoff: {
    title: 'Harmonize cutoff',
    group: 'Site statistics',
    what: 'Photos at different scales can resolve different smallest sizes. When on, the largest of those cutoffs (in mm) is applied to every photo, so all photos describe the same size range.',
    default: 'On',
    when: 'Keep on when combining photos taken at different heights or zooms. Turning it off adds more fine grains from the sharper photos, but mixes size ranges.',
  },
  minBaxisPx: {
    title: 'Min b-axis (px)',
    group: 'Site statistics',
    what: 'Grains smaller than this (in original photo pixels) are left out of the site statistics because they are too small to measure reliably.',
    default: '15 px',
    when: 'Lower it (e.g. 10) for very sharp high-resolution photos. Raise it if small grains look unreliable.',
  },
  minSizeMm: {
    title: 'Field-count cutoff (mm)',
    group: 'Site statistics',
    what: 'Leaves out all grains smaller than this size (mm), so results cover the same size range as a field pebble count.',
    default: '0 (off)',
    when: 'Set it to the smallest stone your field method records (typically 8–16 mm) whenever you compare with a pebble count. Without it the photo D50 can look much finer (about 40% at the K1 test site; with a matching 13 mm cutoff the photo and field D50 agreed within about 3–4%).',
  },
  confidenceLevel: {
    title: 'Confidence level',
    group: 'Site statistics',
    what: 'The width of the uncertainty ranges reported for D16, D50, D84 and other statistics.',
    default: '95%',
    when: 'Use 90% only if your reporting standard asks for it. 95% is the usual choice.',
  },
  bootstrapReplicates: {
    title: 'Bootstrap repeats',
    group: 'Site statistics',
    what: 'How many times photos are resampled to estimate the site uncertainty. More repeats give more stable uncertainty ranges but take longer.',
    default: '500',
    when: 'Increase to 1000–2000 for final reported results. Decrease (e.g. 200) for faster updates while editing.',
  },
  bootstrapSeed: {
    title: 'Bootstrap seed',
    group: 'Site statistics',
    what: 'A fixed starting number for the random resampling, so the same data always give the same uncertainty ranges.',
    default: '42',
    when: 'Normally leave it. Changing it shows how much the uncertainty ranges vary by chance; they should change only slightly.',
  },
  bootstrapTwoStage: {
    title: 'Two-stage bootstrap',
    group: 'Site statistics',
    what: 'Also resamples grains within each photo, as well as photos within the site. This gives wider, more conservative uncertainty ranges.',
    default: 'Off',
    when: 'Turn on when you have only a few photos, or photos with few grains each, and want to account for both sources of variation.',
  },
  wolmanPointsPerPhoto: {
    title: 'Virtual Wolman points',
    group: 'Site statistics',
    what: 'Number of grid points laid over each photo in "Virtual Wolman grid" pooling (only used in that mode).',
    default: '100 per photo',
    when: 'Use about the number of stones you would count in the field per photo area. More points use more of the information in each photo.',
  },
  faciesWeight: {
    title: 'Facies weight',
    group: 'Photo',
    what: 'How much this photo counts in "Facies-weighted" pooling, e.g. the share of the reach covered by its surface type.',
    default: '1 (equal weight)',
    when: 'Set when sampling a reach with distinct surface patches (e.g. 0.6 for a bar head photo representing 60% of the area). Only used in Facies-weighted pooling.',
  },
  calibrate: {
    title: 'Calibrate',
    group: 'Tools',
    what: 'Sets the photo scale by clicking both ends of a known length (ruler, coin or quadrat). Without it, all sizes are in pixels.',
    default: 'Not calibrated',
    when: 'Always calibrate before reporting sizes. Use the longest reference available, lying flat on the gravel near the middle of the photo.',
  },
  rectify: {
    title: '4-point rectify',
    group: 'Tools',
    what: 'Straightens a photo taken at an angle, using four points that form a rectangle on the ground (e.g. quadrat corners).',
    default: 'Not applied',
    when: 'Use whenever the camera was noticeably tilted. Re-analyse the photo afterwards.',
  },
  exclusion: {
    title: 'Exclusion tools',
    group: 'Tools',
    what: 'Draw polygons or paint areas (rulers, boots, vegetation, water, deep shadow) to leave them out. Grains with more than 10% of their area inside an excluded region are dropped from the statistics.',
    default: 'Nothing excluded',
    when: 'Use on any non-gravel object or area in the photo.',
  },
  editing: {
    title: 'Editing tools',
    group: 'Tools',
    what: 'Split (draw a line across stones that were joined), Merge (select pieces of one stone), Delete (remove non-grains), + Polygon (draw a missed grain). All edits can be undone.',
    default: '—',
    when: 'Always check the outlines and fix obvious mistakes before reporting results.',
  },
} as const satisfies Record<string, HelpTopic>;

export type HelpKey = keyof typeof HELP_TOPICS;

export function isHelpKey(key: string): key is HelpKey {
  return Object.prototype.hasOwnProperty.call(HELP_TOPICS, key);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Small "?" button placed next to a setting; opens the help dialog on that topic. */
export function helpButton(key: HelpKey): string {
  const t: HelpTopic = HELP_TOPICS[key];
  return `<button type="button" class="help-btn" data-help="${key}" title="${esc(t.what)}" aria-label="Help: ${esc(t.title)}">?</button>`;
}

function topicHtml(key: HelpKey, open: boolean): string {
  const t: HelpTopic = HELP_TOPICS[key];
  return `
    <details class="help-topic" id="help-${key}" ${open ? 'open' : ''}>
      <summary>${esc(t.title)}</summary>
      <dl class="help-dl">
        <dt>What it does</dt><dd>${esc(t.what)}</dd>
        <dt>Default</dt><dd>${esc(t.default)}</dd>
        <dt>When to change it</dt><dd>${esc(t.when)}</dd>
      </dl>
    </details>`;
}

/**
 * Help dialog. With a `focus` key the chosen topic is expanded and shown first;
 * all other topics stay listed (collapsed) so users can browse.
 */
export function renderHelpModalHtml(focus: HelpKey | null): string {
  const keys = Object.keys(HELP_TOPICS) as HelpKey[];
  const groups = HELP_GROUP_ORDER.map((g) => {
    const inGroup = keys.filter((k) => HELP_TOPICS[k].group === g && k !== focus);
    if (inGroup.length === 0) return '';
    return `<h3 class="help-group">${esc(g)}</h3>${inGroup.map((k) => topicHtml(k, false)).join('')}`;
  }).join('');
  return `
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="dialog-title" class="modal-title">${focus ? `Help: ${esc(HELP_TOPICS[focus].title)}` : 'Settings help'}</h2>
        <button type="button" class="btn btn-sm" data-action="close-modal" autofocus>Close</button>
      </div>
      <div class="modal-body">
        <p class="help-intro">The defaults are the settings that were tested. For most photos: calibrate the scale, check the outlines, and set the field-count cutoff if you compare with a pebble count. Change other settings only for the reasons below, and note what you changed (exports record all settings).</p>
        ${focus ? topicHtml(focus, true) : ''}
        ${focus ? '<h3 class="help-group">All settings</h3>' : ''}
        ${groups}
      </div>
    </div>`;
}
