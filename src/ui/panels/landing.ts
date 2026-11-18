/**
 * Landing page & product overview for webGrainy (ImageGrains 2.0 Web).
 *
 * Explains what the application is for, what it measures, and how the 5-step
 * field-to-export workflow operates, with direct entry points into the
 * local browser workspace. Pure (state -> HTML) for unit testing.
 */
import type { HelpKey } from '../help.js';
import type { AppState, EditorToolMode, ModalKind, WorkflowStepId } from '../state.js';
import { esc } from './html.js';

export interface LandingView {
  /** Whether the GPU was reset during this visit and CPU is active until reload. */
  gpuReset: boolean;
  /** Number of WASM SIMD threads configured for CPU execution. */
  cpuThreads: number | undefined;
  /** Whether the user has opted to skip the landing page on future visits. */
  skipLanding: boolean;
}

export interface WorkflowStepSpec {
  id: WorkflowStepId;
  num: number;
  shortTitle: string;
  headline: string;
  summary: string;
  bullets: ReadonlyArray<{ label: string; detail: string }>;
  helpTopic: HelpKey;
  cta: {
    label: string;
    tool?: EditorToolMode;
    modal?: Exclude<ModalKind, null>;
    action?: 'enter-workspace' | 'add-photos';
  };
  svg: string;
}

export const WORKFLOW_STEP_ORDER: ReadonlyArray<WorkflowStepId> = [
  'calibrate',
  'exclude',
  'segment',
  'edit',
  'export',
];

export function isWorkflowStepId(value: string | undefined): value is WorkflowStepId {
  return value !== undefined && (WORKFLOW_STEP_ORDER as readonly string[]).includes(value);
}

export function nextWorkflowStepForKey(current: WorkflowStepId, key: string): WorkflowStepId | null {
  const idx = WORKFLOW_STEP_ORDER.indexOf(current);
  if (idx < 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return WORKFLOW_STEP_ORDER[(idx + 1) % WORKFLOW_STEP_ORDER.length]!;
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return WORKFLOW_STEP_ORDER[(idx - 1 + WORKFLOW_STEP_ORDER.length) % WORKFLOW_STEP_ORDER.length]!;
  }
  if (key === 'Home') return WORKFLOW_STEP_ORDER[0]!;
  if (key === 'End') return WORKFLOW_STEP_ORDER[WORKFLOW_STEP_ORDER.length - 1]!;
  return null;
}

function renderHeroFigureSvg(): string {
  return `
    <svg class="landing-hero-svg" role="img" viewBox="0 0 600 410" aria-labelledby="hero-svg-title">
      <title id="hero-svg-title">Segmented river gravel photo with a millimeter scale bar, fitted grain outlines, and cumulative grain-size distribution curve</title>
      <!-- Riverbed substrate background -->
      <rect x="0" y="0" width="600" height="410" rx="8" fill="#111820" />
      <rect x="14" y="14" width="572" height="278" rx="6" fill="#18222d" stroke="#2c3b4b" stroke-width="1.2" />

      <!-- Subtle quadrat survey boundary -->
      <rect x="28" y="44" width="388" height="234" rx="3" fill="#131b24" stroke="#3b9eff" stroke-width="1.4" stroke-dasharray="6 4" />
      <text x="36" y="60" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="10" font-weight="600">SURVEY AREA · CALIBRATED IN MM</text>

      <!-- Excluded corner area (field boot / stadia base) -->
      <polygon points="344,210 416,210 416,278 326,278" fill="rgba(231, 76, 60, 0.16)" stroke="#e74c3c" stroke-width="1.4" stroke-dasharray="4 3" />
      <text x="345" y="268" fill="#ff8577" font-family="ui-monospace, monospace" font-size="9.5" font-weight="600">EXCLUDED</text>

      <!-- Physical ruler / scale calibration bar at top of frame -->
      <rect x="34" y="20" width="248" height="16" rx="2" fill="#22303f" stroke="#4f6479" stroke-width="1" />
      <line x1="44" y1="28" x2="270" y2="28" stroke="#f5a623" stroke-width="2" />
      <circle cx="44" cy="28" r="3.5" fill="#f5a623" />
      <circle cx="270" cy="28" r="3.5" fill="#f5a623" />
      <text x="157" y="31" text-anchor="middle" fill="#ffd485" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">500 mm RULER SCALE</text>

      <!-- Segmented gravel clasts with fitted ellipses and b-axis lines -->
      <g transform="translate(115, 130) rotate(-18)">
        <ellipse cx="0" cy="0" rx="52" ry="35" fill="rgba(59, 158, 255, 0.28)" stroke="#69b7ff" stroke-width="1.8" />
        <line x1="-52" y1="0" x2="52" y2="0" stroke="#e8eef4" stroke-width="1.2" stroke-dasharray="3 2" />
        <line x1="0" y1="-35" x2="0" y2="35" stroke="#2ecc71" stroke-width="1.8" />
        <text x="-18" y="-6" fill="#ffffff" font-family="ui-monospace, monospace" font-size="10" font-weight="700">68 mm</text>
      </g>

      <g transform="translate(238, 118) rotate(24)">
        <ellipse cx="0" cy="0" rx="44" ry="29" fill="rgba(46, 204, 113, 0.26)" stroke="#2ecc71" stroke-width="1.8" />
        <line x1="-44" y1="0" x2="44" y2="0" stroke="#e8eef4" stroke-width="1.1" stroke-dasharray="3 2" />
        <line x1="0" y1="-29" x2="0" y2="29" stroke="#2ecc71" stroke-width="1.7" />
        <text x="-17" y="4" fill="#ffffff" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">54 mm</text>
      </g>

      <g transform="translate(342, 112) rotate(-12)">
        <ellipse cx="0" cy="0" rx="36" ry="24" fill="rgba(59, 158, 255, 0.24)" stroke="#58a6ff" stroke-width="1.6" />
        <line x1="0" y1="-24" x2="0" y2="24" stroke="#2ecc71" stroke-width="1.5" />
        <text x="-15" y="4" fill="#e8eef4" font-family="ui-monospace, monospace" font-size="9" font-weight="600">44 mm</text>
      </g>

      <g transform="translate(96, 218) rotate(14)">
        <ellipse cx="0" cy="0" rx="39" ry="26" fill="rgba(46, 204, 113, 0.24)" stroke="#2ecc71" stroke-width="1.6" />
        <line x1="0" y1="-26" x2="0" y2="26" stroke="#2ecc71" stroke-width="1.5" />
        <text x="-15" y="4" fill="#e8eef4" font-family="ui-monospace, monospace" font-size="9" font-weight="600">49 mm</text>
      </g>

      <g transform="translate(194, 204) rotate(-28)">
        <ellipse cx="0" cy="0" rx="31" ry="21" fill="rgba(245, 166, 35, 0.25)" stroke="#f5a623" stroke-width="1.5" />
        <line x1="0" y1="-21" x2="0" y2="21" stroke="#ffd485" stroke-width="1.3" />
        <text x="-14" y="3" fill="#ffffff" font-family="ui-monospace, monospace" font-size="8.5" font-weight="600">38 mm</text>
      </g>
      <g transform="translate(274, 198) rotate(9)">
        <ellipse cx="0" cy="0" rx="28" ry="19" fill="rgba(59, 158, 255, 0.24)" stroke="#69b7ff" stroke-width="1.5" />
        <text x="-13" y="3" fill="#e8eef4" font-family="ui-monospace, monospace" font-size="8.5">34 mm</text>
      </g>
      <g transform="translate(168, 252) rotate(6)">
        <ellipse cx="0" cy="0" rx="22" ry="14" fill="rgba(46, 204, 113, 0.22)" stroke="#2ecc71" stroke-width="1.3" />
      </g>
      <g transform="translate(232, 252) rotate(-15)">
        <ellipse cx="0" cy="0" rx="24" ry="15" fill="rgba(245, 166, 35, 0.22)" stroke="#f5a623" stroke-width="1.3" />
      </g>
      <g transform="translate(345, 168) rotate(32)">
        <ellipse cx="0" cy="0" rx="25" ry="16" fill="rgba(46, 204, 113, 0.24)" stroke="#2ecc71" stroke-width="1.4" />
      </g>
      <g transform="translate(52, 168) rotate(-8)">
        <ellipse cx="0" cy="0" rx="19" ry="13" fill="rgba(245, 166, 35, 0.22)" stroke="#f5a623" stroke-width="1.3" />
      </g>
      <g transform="translate(178, 80) rotate(12)">
        <ellipse cx="0" cy="0" rx="23" ry="15" fill="rgba(245, 166, 35, 0.22)" stroke="#f5a623" stroke-width="1.3" />
      </g>
      <g transform="translate(292, 74) rotate(-20)">
        <ellipse cx="0" cy="0" rx="21" ry="14" fill="rgba(46, 204, 113, 0.22)" stroke="#2ecc71" stroke-width="1.3" />
      </g>

      <!-- Right inset: Live Cumulative PSD Curve inside the figure -->
      <rect x="428" y="24" width="146" height="254" rx="5" fill="#121921" stroke="#2c3b4b" stroke-width="1.2" />
      <text x="440" y="42" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="700">Grain-Size Curve</text>
      <text x="440" y="55" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="8.5">Cumulative % finer</text>

      <!-- Mini chart plot box -->
      <rect x="442" y="64" width="120" height="122" fill="#0d1218" stroke="#263340" stroke-width="1" />
      <line x1="442" y1="166" x2="562" y2="166" stroke="#23303d" stroke-width="1" stroke-dasharray="2 2" />
      <line x1="442" y1="125" x2="562" y2="125" stroke="#2a3b4c" stroke-width="1" stroke-dasharray="2 2" />
      <line x1="442" y1="84" x2="562" y2="84" stroke="#23303d" stroke-width="1" stroke-dasharray="2 2" />
      <path d="M 446 182 C 470 176, 488 144, 504 118 C 520 92, 538 72, 558 67 L 558 75 C 538 82, 520 104, 504 132 C 488 156, 470 180, 446 184 Z" fill="rgba(59, 158, 255, 0.24)" />
      <path d="M 446 183 C 470 178, 488 150, 504 125 C 520 98, 538 77, 558 70" fill="none" stroke="#3b9eff" stroke-width="2.2" />
      <circle cx="504" cy="125" r="3.5" fill="#2ecc71" stroke="#0d1218" stroke-width="1.2" />

      <!-- Readout rows under mini chart -->
      <text x="442" y="204" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5">D16: <tspan fill="#e8eef4" font-weight="700">18.4 mm</tspan></text>
      <text x="442" y="222" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5">D50: <tspan fill="#2ecc71" font-weight="700">42.7 mm</tspan></text>
      <text x="442" y="236" fill="#8395a7" font-family="ui-monospace, monospace" font-size="8.2">95% confidence band</text>
      <text x="442" y="254" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5">D84: <tspan fill="#e8eef4" font-weight="700">86.2 mm</tspan></text>
      <text x="442" y="270" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="8.5">n = 342 grains counted</text>

      <!-- Bottom pipeline strip -->
      <rect x="14" y="302" width="572" height="94" rx="6" fill="#161f29" stroke="#2a3642" stroke-width="1.2" />
      <text x="28" y="324" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="10" font-weight="700">RUNS LOCALLY IN YOUR BROWSER · NO EXTERNAL SERVER</text>

      <rect x="28" y="336" width="128" height="46" rx="4" fill="#1c2733" stroke="#2f3e4e" />
      <text x="38" y="354" fill="#69b7ff" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">1. Add &amp; Scale</text>
      <text x="38" y="370" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9.5">Ruler or quadrat (mm)</text>

      <rect x="166" y="336" width="132" height="46" rx="4" fill="#1c2733" stroke="#2f3e4e" />
      <text x="176" y="354" fill="#69b7ff" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">2. Find Grains</text>
      <text x="176" y="370" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9.5">U-Net or Cellpose-SAM</text>

      <rect x="308" y="336" width="132" height="46" rx="4" fill="#1c2733" stroke="#2f3e4e" />
      <text x="318" y="354" fill="#69b7ff" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">3. Check Outlines</text>
      <text x="318" y="370" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9.5">Split, merge &amp; refine</text>

      <rect x="450" y="336" width="122" height="46" rx="4" fill="#1c2733" stroke="#2f3e4e" />
      <text x="460" y="354" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">4. Export Data</text>
      <text x="460" y="370" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9.5">CSV · GeoJSON · Report</text>
    </svg>
  `;
}

export const WORKFLOW_STEPS: ReadonlyArray<WorkflowStepSpec> = [
  {
    id: 'calibrate',
    num: 1,
    shortTitle: 'Add & Calibrate',
    headline: 'Add your gravel photos and set the scale in millimeters',
    summary:
      'Add photos taken straight down with a ruler, coin, or sampling quadrat in view. Mark two points a known distance apart so grain sizes are reported in millimeters rather than pixels.',
    helpTopic: 'calibrate',
    bullets: [
      {
        label: 'Calibrate tool',
        detail:
          'Click both ends of a ruler or quadrat edge and enter the known length in mm or cm (with presets for a 100 mm ruler, 25 mm coin, or 500 mm quadrat). Use "Copy Scale to Site" when all photos share the same camera height.',
      },
      {
        label: 'Rectify tool (4-corner correction)',
        detail:
          'If a quadrat photo was taken at an angle, mark its four corners and enter the real width and height in mm to straighten it before analysis.',
      },
      {
        label: 'Stored in your browser',
        detail:
          'Photos and settings stay in this browser on your device. Use "Back up now" in the Site panel to save a portable .webgrainy.json project file.',
      },
    ],
    cta: {
      label: 'Add Photos & Calibrate',
      action: 'add-photos',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-cal-title">
        <title id="wf-svg-cal-title">Two-point ruler scale calibration and four-point quadrat perspective correction</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <text x="20" y="26" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="10" font-weight="700">A. STRAIGHTEN QUADRAT</text>
        <polygon points="36,54 148,46 168,148 22,156" fill="rgba(59, 158, 255, 0.14)" stroke="#69b7ff" stroke-width="1.5" stroke-dasharray="4 3" />
        <circle cx="36" cy="54" r="4" fill="#3b9eff" />
        <circle cx="148" cy="46" r="4" fill="#3b9eff" />
        <circle cx="168" cy="148" r="4" fill="#3b9eff" />
        <circle cx="22" cy="156" r="4" fill="#3b9eff" />
        <text x="95" y="106" text-anchor="middle" fill="#e8eef4" font-family="ui-monospace, monospace" font-size="9.5">500 × 500 mm</text>
        <text x="95" y="120" text-anchor="middle" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="8.5">4-corner correction</text>

        <text x="212" y="26" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="10" font-weight="700">B. SET RULER SCALE</text>
        <rect x="212" y="44" width="188" height="122" rx="4" fill="#18222d" stroke="#2c3b4b" />
        <rect x="226" y="74" width="160" height="24" rx="2" fill="#243242" stroke="#4f6479" />
        <line x1="236" y1="86" x2="376" y2="86" stroke="#f5a623" stroke-width="2.4" />
        <circle cx="236" cy="86" r="4.5" fill="#f5a623" />
        <circle cx="376" cy="86" r="4.5" fill="#f5a623" />
        <text x="306" y="118" text-anchor="middle" fill="#ffd485" font-family="ui-monospace, monospace" font-size="10" font-weight="700">Known length: 100 mm</text>
        <text x="306" y="136" text-anchor="middle" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="9.5">Sizes reported in mm</text>

        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">Calibrating in mm enables Wentworth size classes and multi-photo pooling</text>
        <text x="32" y="220" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9">Presets for 100 mm ruler, 25 mm coin, 500 mm quadrat, or custom length</text>
      </svg>
    `,
  },
  {
    id: 'exclude',
    num: 2,
    shortTitle: 'Exclude Non-Gravel',
    headline: 'Leave out rulers, boots, water, or vegetation before analysing',
    summary:
      'Use the Exclude Area (polygon) or Brush tools to mark anything that is not gravel so it is ignored during grain detection and left out of the size statistics.',
    helpTopic: 'exclusion',
    bullets: [
      {
        label: 'Exclude Area & Brush tools',
        detail:
          'Draw a polygon or paint over rulers, boots, vegetation, water, or deep shadows so non-gravel objects are not counted as stones.',
      },
      {
        label: 'Skips areas outside the counted region',
        detail:
          'By default, the neural network skips parts of the photo far outside your active region of interest, saving time on cropped survey areas.',
      },
      {
        label: 'Edge grains excluded automatically',
        detail:
          'Grains touching the edge of the photo are cut off by the frame and are excluded from statistics by default.',
      },
    ],
    cta: {
      label: 'Open Workspace with Exclusion Tool',
      action: 'enter-workspace',
      tool: 'excludePoly',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-exc-title">
        <title id="wf-svg-exc-title">Active survey region of interest with excluded non-gravel areas</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <g stroke="#263340" stroke-width="1" fill="#151d26">
          <rect x="24" y="22" width="68" height="50" />
          <rect x="92" y="22" width="68" height="50" />
          <rect x="160" y="22" width="68" height="50" />
          <rect x="228" y="22" width="68" height="50" />
          <rect x="24" y="72" width="68" height="50" fill="#1a2634" />
          <rect x="92" y="72" width="68" height="50" fill="#1a2634" />
          <rect x="160" y="72" width="68" height="50" fill="#1a2634" />
          <rect x="228" y="72" width="68" height="50" />
          <rect x="24" y="122" width="68" height="50" fill="#1a2634" />
          <rect x="92" y="122" width="68" height="50" fill="#1a2634" />
          <rect x="160" y="122" width="68" height="50" fill="#1a2634" />
          <rect x="228" y="122" width="68" height="50" />
        </g>
        <rect x="34" y="64" width="186" height="100" fill="rgba(46, 204, 113, 0.14)" stroke="#2ecc71" stroke-width="2" />
        <text x="44" y="82" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">SAMPLING AREA</text>

        <polygon points="154,116 214,116 214,158 144,158" fill="rgba(231, 76, 60, 0.25)" stroke="#e74c3c" stroke-width="1.6" stroke-dasharray="4 2" />
        <text x="153" y="142" fill="#ff8577" font-family="ui-monospace, monospace" font-size="8.5" font-weight="700">EXCLUDED</text>

        <text x="262" y="50" text-anchor="middle" fill="#8395a7" font-family="ui-monospace, monospace" font-size="8.5">SKIPPED</text>
        <text x="262" y="100" text-anchor="middle" fill="#8395a7" font-family="ui-monospace, monospace" font-size="8.5">SKIPPED</text>
        <text x="262" y="150" text-anchor="middle" fill="#8395a7" font-family="ui-monospace, monospace" font-size="8.5">SKIPPED</text>

        <rect x="308" y="22" width="94" height="150" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="316" y="42" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="9.5" font-weight="700">Legend</text>
        <rect x="316" y="54" width="12" height="12" fill="rgba(46, 204, 113, 0.22)" stroke="#2ecc71" />
        <text x="334" y="64" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9">Counted area</text>
        <rect x="316" y="76" width="12" height="12" fill="rgba(231, 76, 60, 0.25)" stroke="#e74c3c" />
        <text x="334" y="86" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9">Excluded zone</text>
        <rect x="316" y="98" width="12" height="12" fill="#151d26" stroke="#263340" />
        <text x="334" y="108" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9">Outside area</text>

        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">Surveyed area and grain counts adjust automatically for excluded regions</text>
        <text x="32" y="220" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9">Grains cut off by the edge of the photo are also excluded by default</text>
      </svg>
    `,
  },
  {
    id: 'segment',
    num: 3,
    shortTitle: 'Find Grains',
    headline: 'Run the neural network on your device to outline individual grains',
    summary:
      'Press Analyse to detect grains across one photo or all photos in your site. The selected model downloads the first time you run it and is cached in your browser for offline use.',
    helpTopic: 'model',
    bullets: [
      {
        label: 'Auto, U-Net, or CP-SAM',
        detail:
          'Auto chooses a model for your hardware (always U-Net on phones and tablets). Choose U-Net (26 MB) for fast previews or CP-SAM (183–617 MB) on a computer for more detailed outlines.',
      },
      {
        label: 'Graphics card or CPU',
        detail:
          'Uses WebGPU when your graphics card supports it, or runs on the CPU across multiple processor threads.',
      },
      {
        label: 'Live progress & background notification',
        detail:
          'A progress bar at the bottom shows the current stage, tile count, and estimated time remaining, with an optional notification when long batches finish.',
      },
    ],
    cta: {
      label: 'Manage Offline Models',
      modal: 'models',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-seg-title">
        <title id="wf-svg-seg-title">Tiled photo analysis producing grain outlines and size measurements</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <rect x="20" y="34" width="110" height="128" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="75" y="24" text-anchor="middle" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">1. PHOTO TILES</text>
        <rect x="32" y="48" width="54" height="54" fill="rgba(59, 158, 255, 0.18)" stroke="#3b9eff" stroke-width="1.3" />
        <rect x="64" y="68" width="54" height="54" fill="rgba(46, 204, 113, 0.18)" stroke="#2ecc71" stroke-width="1.3" />
        <text x="75" y="144" text-anchor="middle" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="8.5">Overlapping tiles</text>

        <rect x="155" y="34" width="110" height="128" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="210" y="24" text-anchor="middle" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">2. GRAIN DETECTION</text>
        <circle cx="210" cy="92" r="28" fill="rgba(245, 166, 35, 0.15)" stroke="#f5a623" stroke-width="1.2" stroke-dasharray="3 2" />
        <line x1="186" y1="92" x2="202" y2="92" stroke="#ffd485" stroke-width="1.5" />
        <line x1="234" y1="92" x2="218" y2="92" stroke="#ffd485" stroke-width="1.5" />
        <line x1="210" y1="68" x2="210" y2="84" stroke="#ffd485" stroke-width="1.5" />
        <line x1="210" y1="116" x2="210" y2="100" stroke="#ffd485" stroke-width="1.5" />
        <circle cx="210" cy="92" r="3.5" fill="#2ecc71" />
        <text x="210" y="144" text-anchor="middle" fill="#ffd485" font-family="ui-monospace, monospace" font-size="8.5">U-Net or CP-SAM</text>

        <rect x="290" y="34" width="110" height="128" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="345" y="24" text-anchor="middle" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">3. GRAIN OUTLINES</text>
        <ellipse cx="332" cy="82" rx="22" ry="15" transform="rotate(-18 332 82)" fill="rgba(46, 204, 113, 0.28)" stroke="#2ecc71" stroke-width="1.6" />
        <ellipse cx="364" cy="108" rx="18" ry="13" transform="rotate(22 364 108)" fill="rgba(59, 158, 255, 0.28)" stroke="#69b7ff" stroke-width="1.6" />
        <text x="345" y="144" text-anchor="middle" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="8.5">Axes &amp; area fitted</text>

        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">Models download once and are cached in your browser for offline use</text>
        <text x="32" y="220" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9">Pre-download models before field trips from the Models dialog</text>
      </svg>
    `,
  },
  {
    id: 'edit',
    num: 4,
    shortTitle: 'Check & Edit Outlines',
    headline: 'Review outlines and fix merged or missed stones by hand',
    summary:
      'Once a photo has been analysed, the Edit grains tools appear in the toolbar above the photo. Always check the outlines and fix obvious mistakes—especially on wet or shadowy beds.',
    helpTopic: 'editing',
    bullets: [
      {
        label: 'Split, Merge, Delete & Add',
        detail:
          'Draw a line across two joined stones to split them, select pieces of one stone and press Merge, click a false outline to delete it, or draw a missed grain.',
      },
      {
        label: 'Jump to largest or flagged grains',
        detail:
          'In Inspect mode, use the Largest and Flagged buttons (plus the optional magnifier in the Display menu) to review stones that touch the border or look unusually elongated.',
      },
      {
        label: 'Instant Undo & Redo',
        detail:
          'Every edit updates the grain-size curve and percentiles right away, and all edits can be undone with Undo or Ctrl+Z.',
      },
    ],
    cta: {
      label: 'Open Workspace',
      action: 'enter-workspace',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-edit-title">
        <title id="wf-svg-edit-title">Splitting two merged grains and comparing ellipse minor axis with caliper width</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <rect x="20" y="24" width="182" height="146" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="32" y="42" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">SPLIT TOUCHING STONES</text>
        <ellipse cx="86" cy="102" rx="34" ry="25" fill="rgba(59, 158, 255, 0.26)" stroke="#69b7ff" stroke-width="1.6" />
        <ellipse cx="140" cy="104" rx="30" ry="23" fill="rgba(46, 204, 113, 0.26)" stroke="#2ecc71" stroke-width="1.6" />
        <line x1="115" y1="62" x2="113" y2="144" stroke="#f5a623" stroke-width="2.2" stroke-dasharray="4 3" />
        <circle cx="115" cy="62" r="3.5" fill="#f5a623" />
        <circle cx="113" cy="144" r="3.5" fill="#f5a623" />
        <text x="111" y="158" text-anchor="middle" fill="#ffd485" font-family="ui-monospace, monospace" font-size="8.5">Draw line to split</text>

        <rect x="218" y="24" width="182" height="146" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="230" y="42" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">GRAIN AXES &amp; SHAPE</text>
        <g transform="translate(309, 100) rotate(-20)">
          <line x1="-48" y1="-27" x2="48" y2="-27" stroke="#f5a623" stroke-width="1.2" stroke-dasharray="3 2" />
          <line x1="-48" y1="27" x2="48" y2="27" stroke="#f5a623" stroke-width="1.2" stroke-dasharray="3 2" />
          <ellipse cx="0" cy="0" rx="44" ry="25" fill="rgba(59, 158, 255, 0.24)" stroke="#69b7ff" stroke-width="1.7" />
          <line x1="-44" y1="0" x2="44" y2="0" stroke="#e8eef4" stroke-width="1.2" />
          <line x1="0" y1="-25" x2="0" y2="25" stroke="#2ecc71" stroke-width="2" />
        </g>
        <text x="309" y="158" text-anchor="middle" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="8.5"><tspan fill="#2ecc71">Ellipse b</tspan> · <tspan fill="#ffd485">Caliper width</tspan></text>

        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">Every edit updates the grain-size curve and percentiles immediately</text>
        <text x="32" y="220" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9">Shortcuts: S (Split) · M (Merge) · D (Delete) · A (Add) · Ctrl+Z (Undo)</text>
      </svg>
    `,
  },
  {
    id: 'export',
    num: 5,
    shortTitle: 'Results & Export',
    headline: 'Explore grain-size curves, combine site photos, and export your work',
    summary:
      'Switch between This photo, Whole site, and Compare sites in the Results panel on the right. Download tables, vector outlines, charts, printable reports, or a full project backup.',
    helpTopic: 'poolingMode',
    bullets: [
      {
        label: 'Size curves, shape & orientation',
        detail:
          'View cumulative grain-size curves (mm or φ), D16 / D50 / D84 with confidence intervals, sample adequacy and jackknife checks, aspect-ratio histograms, and orientation rose diagrams.',
      },
      {
        label: 'Size metrics & field-count cutoff',
        detail:
          'Report sizes using the ellipse b-axis, caliper width (min-Feret), or equal-area diameter (d_eq), and set a Field-count cutoff (mm) when comparing with hand pebble counts.',
      },
      {
        label: 'Tables, outlines, reports & backups',
        detail:
          'Export per-grain and summary CSV/JSON files, GeoJSON and SVG outlines, 16/32-bit PNG masks, a printable HTML report, or a .webgrainy.json project archive.',
      },
    ],
    cta: {
      label: 'View Export Options',
      modal: 'export',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-exp-title">
        <title id="wf-svg-exp-title">Site grain-size distribution curve with confidence band, orientation rose diagram, and export formats</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <rect x="20" y="24" width="210" height="146" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="32" y="42" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">SITE GRAIN-SIZE CURVE</text>
        <line x1="36" y1="146" x2="214" y2="146" stroke="#2c3b4b" stroke-width="1" />
        <line x1="36" y1="54" x2="36" y2="146" stroke="#2c3b4b" stroke-width="1" />
        <path d="M 42 142 C 78 138, 108 112, 132 88 C 156 66, 182 58, 210 55 L 210 65 C 182 68, 156 78, 132 102 C 108 124, 78 143, 42 145 Z" fill="rgba(59, 158, 255, 0.24)" />
        <path d="M 42 144 C 78 140, 108 118, 132 95 C 156 72, 182 63, 210 59" fill="none" stroke="#3b9eff" stroke-width="2.2" />
        <circle cx="132" cy="95" r="3.5" fill="#2ecc71" />
        <text x="140" y="99" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="9" font-weight="700">D50 = 42.7 mm</text>

        <rect x="244" y="24" width="156" height="146" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="256" y="42" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">ORIENTATION &amp; SHAPE</text>
        <circle cx="322" cy="94" r="36" fill="#111820" stroke="#2c3b4b" stroke-width="1" />
        <circle cx="322" cy="94" r="22" fill="none" stroke="#243242" stroke-width="1" stroke-dasharray="2 2" />
        <polygon points="322,94 348,72 354,82" fill="rgba(59, 158, 255, 0.45)" stroke="#69b7ff" stroke-width="1" />
        <polygon points="322,94 296,116 290,106" fill="rgba(59, 158, 255, 0.45)" stroke="#69b7ff" stroke-width="1" />
        <polygon points="322,94 344,88 342,98" fill="rgba(46, 204, 113, 0.38)" stroke="#2ecc71" stroke-width="1" />
        <polygon points="322,94 300,100 302,90" fill="rgba(46, 204, 113, 0.38)" stroke="#2ecc71" stroke-width="1" />
        <text x="322" y="148" text-anchor="middle" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="8.5">Rose diagram</text>

        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">Exports record the model and settings used so your results are easy to document</text>
        <text x="32" y="220" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9">CSV · Summary JSON · 16-bit PNG · GeoJSON · SVG · Printable Report · .webgrainy.json</text>
      </svg>
    `,
  },
];

function renderWorkflowStepCta(step: WorkflowStepSpec): string {
  const { cta } = step;
  if (cta.modal) {
    return `<button type="button" class="btn btn-primary" data-open-modal="${esc(cta.modal)}">${esc(cta.label)}</button>`;
  }
  const toolAttr = cta.tool ? ` data-launch-tool="${esc(cta.tool)}"` : '';
  const action = cta.action ?? 'enter-workspace';
  return `<button type="button" class="btn btn-primary" data-action="${esc(action)}"${toolAttr}>${esc(cta.label)}</button>`;
}

export function renderWorkflowSectionHtml(activeStep: WorkflowStepId): string {
  const validActive: WorkflowStepId = isWorkflowStepId(activeStep) ? activeStep : 'calibrate';
  return `
    <section id="workflow" class="landing-section" aria-labelledby="workflow-heading">
      <div class="landing-section-header">
        <p class="landing-eyebrow">HOW IT WORKS</p>
        <h2 id="workflow-heading" class="landing-h2">From field photo to grain-size distribution in five steps</h2>
        <p class="landing-section-sub">
          Select any step below (or use your Left and Right arrow keys) to see how webGrainy turns raw gravel photos into calibrated measurements.
        </p>
      </div>

      <div class="workflow-tabs-container" id="workflow-tabs">
        <div class="workflow-tablist" role="tablist" focusgroup="tablist nomemory" aria-label="Five-step field-to-export workflow">
          ${WORKFLOW_STEPS.map((step) => {
            const selected = step.id === validActive;
            return `<button
              type="button"
              role="tab"
              class="workflow-tab"
              id="wf-tab-${esc(step.id)}"
              data-action="workflow-step"
              data-step="${esc(step.id)}"
              aria-selected="${selected ? 'true' : 'false'}"
              tabindex="${selected ? '0' : '-1'}"
              ${selected ? 'focusgroupstart' : ''}
            >
              <span class="wf-step-num" aria-hidden="true">${step.num}</span>
              <span class="wf-step-label">${esc(step.shortTitle)}</span>
            </button>`;
          }).join('')}
        </div>

        <div class="workflow-panels-stage">
          ${WORKFLOW_STEPS.map((step) => {
            const selected = step.id === validActive;
            return `<div
              role="tabpanel"
              id="wf-panel-${esc(step.id)}"
              class="workflow-tabpanel"
              aria-labelledby="wf-tab-${esc(step.id)}"
              data-step-panel="${esc(step.id)}"
              ${selected ? 'tabindex="0"' : 'hidden="until-found"'}
            >
              <div class="workflow-panel-card">
                <div class="workflow-panel-copy">
                  <div class="wf-panel-kicker">Step ${step.num} of ${WORKFLOW_STEPS.length} · ${esc(step.shortTitle)}</div>
                  <h3 class="wf-panel-title">${esc(step.headline)}</h3>
                  <p class="wf-panel-summary">${esc(step.summary)}</p>
                  <ul class="wf-bullet-list" role="list">
                    ${step.bullets
                      .map(
                        (b) => `<li>
                          <strong>${esc(b.label)}:</strong> ${esc(b.detail)}
                        </li>`,
                      )
                      .join('')}
                  </ul>
                  <div class="wf-panel-actions">
                    ${renderWorkflowStepCta(step)}
                    <button type="button" class="btn" data-help="${esc(step.helpTopic)}">Help for this step</button>
                  </div>
                </div>
                <div class="workflow-panel-visual">
                  ${step.svg}
                </div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    </section>
  `;
}

export function renderLandingHtml(state: AppState, view: LandingView): string {
  const caps = state.capabilities;
  const cachedCount = caps?.cachedModels?.length ?? 0;
  const photoCount = state.photos.length;
  const siteCount = state.sites.length;

  const engineLabel = view.gpuReset
    ? 'CPU mode (GPU reset)'
    : caps
      ? caps.hasWebGPU
        ? caps.hasShaderF16 === true
          ? 'WebGPU FP16 Ready'
          : 'WebGPU Ready'
        : `${caps.hasWasmSimd ? 'WASM SIMD' : 'WASM'} · ${view.cpuThreads ?? 1} CPU thread${(view.cpuThreads ?? 1) === 1 ? '' : 's'}`
      : 'Detecting local engine…';

  const swReady = state.swStatus === 'ready';

  return `
    <a href="#landing-heading" class="skip-link visually-hidden">Skip to main content</a>
    <header class="landing-header">
      <div class="landing-header-inner">
        <div class="landing-brand">
          <img src="./icon.svg" alt="" width="26" height="26" class="landing-brand-icon" />
          <span class="landing-brand-name">webGrainy</span>
          <span class="brand-sub">Grain sizes from photos · runs on your device</span>
        </div>

        <nav class="landing-nav" aria-label="Landing page sections">
          <a href="#workflow" class="landing-nav-link">How It Works</a>
          <a href="#capabilities" class="landing-nav-link">Features</a>
          <a href="#models" class="landing-nav-link">Models</a>
          <a href="#validity" class="landing-nav-link">Field Tips &amp; Citations</a>
        </nav>

        <div class="landing-header-actions">
          <span class="status-pill ${caps?.hasWebGPU || caps?.hasWasmSimd ? 'ok' : ''}" title="Local inference runtime detected in this browser">
            <span class="dot" aria-hidden="true"></span>${esc(engineLabel)}
          </span>
          ${
            swReady
              ? `<span class="status-pill ok" title="Application and runtime are cached for offline use"><span class="dot" aria-hidden="true"></span>Offline Ready</span>`
              : ''
          }
          <button type="button" class="btn btn-sm" data-open-modal="models">Models${cachedCount > 0 ? ` (${cachedCount})` : ''}</button>
          <a class="btn btn-sm" href="./gpucheck.html">GPU Check</a>
          <button type="button" class="btn btn-sm" data-open-help="">Help</button>
          <button type="button" class="btn btn-sm btn-primary" data-action="enter-workspace">Launch Workspace</button>
        </div>
      </div>
    </header>

    <main class="landing-main" id="landing-main">
      <!-- Hero Section -->
      <section class="landing-hero" aria-labelledby="landing-heading">
        <div class="landing-hero-copy">
          <p class="landing-eyebrow">RUNS ON YOUR DEVICE · WORKS OFFLINE</p>
          <h1 id="landing-heading" class="landing-title" tabindex="-1">
            Measure gravel and sediment grain sizes from field photos
          </h1>
          <p class="landing-lead">
            <strong>webGrainy</strong> runs the pretrained <strong>ImageGrains 2.0</strong> segmentation models (U-Net and Cellpose-SAM) directly in your browser. Load your photos, set the millimeter scale from a ruler or quadrat, check and edit the grain outlines, and calculate grain-size distributions (D<sub>16</sub>, D<sub>50</sub>, D<sub>84</sub>) with confidence intervals — all locally on your computer or phone, without sending photos to an external server.
          </p>

          <div class="landing-cta-row">
            <button type="button" class="btn btn-primary landing-btn-lg" data-action="add-photos">
              Add Gravel Photos
            </button>
            <button type="button" class="btn landing-btn-lg" data-action="enter-workspace">
              ${
                photoCount > 0
                  ? `Resume Workspace (${photoCount} photo${photoCount === 1 ? '' : 's'})`
                  : 'Open Workspace'
              }
            </button>
            <button type="button" class="btn landing-btn-lg" data-action="import-archive">
              Open .webgrainy.json Project
            </button>
          </div>

          <div class="landing-drop-callout" id="landing-dropzone" data-action="add-photos" role="button" tabindex="0" aria-label="Add or drop gravel photos or a .webgrainy.json project archive to start">
            <strong>Drop gravel photos or a <code>.webgrainy.json</code> project file anywhere on this page</strong>
            <span>Supports JPEG, PNG, and WebP · Stored only in this browser on your device${siteCount > 0 ? ` · ${siteCount} saved site${siteCount === 1 ? '' : 's'} in this browser` : ''}</span>
          </div>

          <div class="landing-pref-row">
            <label class="checkbox-label landing-skip-label" for="landing-skip-checkbox">
              <input
                type="checkbox"
                id="landing-skip-checkbox"
                data-landing-skip=""
                ${view.skipLanding ? 'checked' : ''}
              />
              <span>Skip this overview next time and go straight to the workspace (re-open anytime from <strong>Overview</strong> in the top bar)</span>
            </label>
          </div>
        </div>

        <figure class="landing-hero-figure">
          ${renderHeroFigureSvg()}
          <figcaption class="landing-hero-caption">
            Automated grain outlines with millimeter ruler calibration, excluded non-gravel areas, fitted grain axes, and cumulative grain-size distribution curve.
          </figcaption>
        </figure>
      </section>

      <!-- Key Pillars Strip -->
      <section class="landing-pillars" aria-label="Key highlights">
        <div class="landing-pillar">
          <div class="landing-pillar-value">Runs on Your Device</div>
          <div class="landing-pillar-label">No External Server</div>
          <p class="landing-pillar-desc">You load your own photos into the browser, and all analysis runs on your computer or phone. Your images and results are never uploaded to an external server.</p>
        </div>
        <div class="landing-pillar">
          <div class="landing-pillar-value">Works Offline</div>
          <div class="landing-pillar-label">Field &amp; Lab Ready</div>
          <p class="landing-pillar-desc">After a model downloads the first time, both the app and the model are saved in your browser so you can keep working without an internet connection.</p>
        </div>
        <div class="landing-pillar">
          <div class="landing-pillar-value">Two Model Options</div>
          <div class="landing-pillar-label">Fast Preview or Detailed Outlines</div>
          <p class="landing-pillar-desc">Use the compact U-Net model for quick checks and mobile devices, or Cellpose-SAM on a computer for more detailed outlines when reporting results.</p>
        </div>
        <div class="landing-pillar">
          <div class="landing-pillar-value">Check, Edit &amp; Export</div>
          <div class="landing-pillar-label">Interactive Tools &amp; Reports</div>
          <p class="landing-pillar-desc">Fix merged or missed outlines by hand, combine multiple photos from a site, and save CSV tables, outlines, charts, printable reports, and project backups.</p>
        </div>
      </section>

      <!-- 5-Step Interactive Workflow Section -->
      ${renderWorkflowSectionHtml(state.landingStep)}

      <!-- Capabilities Grid (CSS Subgrid Cards) -->
      <section id="capabilities" class="landing-section landing-cv-section" aria-labelledby="capabilities-heading">
        <div class="landing-section-header">
          <p class="landing-eyebrow">FEATURES</p>
          <h2 id="capabilities-heading" class="landing-h2">What you can measure and export</h2>
          <p class="landing-section-sub">
            Built for river gravel surveys, sedimentology fieldwork, and reproducible lab analysis.
          </p>
        </div>

        <div class="capabilities-grid">
          <article class="capability-card">
            <h3>Grain-Size Curves &amp; Percentiles</h3>
            <p>
              Computes area-weighted and number-weighted cumulative curves, key percentiles (D<sub>5</sub> to D<sub>95</sub>, including D<sub>16</sub>, D<sub>50</sub>, and D<sub>84</sub>), Wentworth size-class histograms, Folk &amp; Ward sorting and skewness, Sauter and geometric means, and Cu/Cc gradation indices.
            </p>
            <footer>D<sub>16</sub> / D<sub>50</sub> / D<sub>84</sub> · Wentworth Classes · Folk &amp; Ward (&phi;)</footer>
          </article>

          <article class="capability-card">
            <h3>Flexible Size Metrics &amp; Cutoffs</h3>
            <p>
              Measure each grain by the short axis of its fitted ellipse (<code>b-axis</code>, standard for photo-sieving), its narrowest caliper width (<code>min-Feret</code>), or its equal-area circle diameter (<code>d_eq</code>). Set a Field-count cutoff (mm) to match your hand pebble-count threshold.
            </p>
            <footer>b-axis · min-Feret · d_eq · Field-Count Cutoff (mm)</footer>
          </article>

          <article class="capability-card">
            <h3>Multi-Photo Site Pooling</h3>
            <p>
              Combine several calibrated photos from the same gravel bar using physical area-weighting (the photo equivalent of a Wolman pebble count), virtual Wolman grid sampling, equal-photo weighting, or facies weights, with 95% confidence intervals and sample adequacy checks.
            </p>
            <footer>Area-Weighted Pooling · 95% Confidence Intervals · Sample Adequacy</footer>
          </article>

          <article class="capability-card">
            <h3>Interactive Outline Editor</h3>
            <p>
              Inspect individual stones with a 2&times;/4&times; magnifier, jump directly to the largest or flagged grains, split touching stones that were joined together, merge pieces of one stone, delete false outlines, or draw missed grains with Undo and Redo.
            </p>
            <footer>Split · Merge · Delete · Add · Largest / Flagged Review</footer>
          </article>

          <article class="capability-card">
            <h3>Shape, Orientation &amp; Site Comparison</h3>
            <p>
              Examine grain elongation (b/a), clast packing vs. exposed matrix, and axial orientation rose diagrams. In Compare sites, overlay grain-size curves from different reaches or plot D<sub>16</sub>, D<sub>50</sub>, and D<sub>84</sub> across survey dates to track changes over time.
            </p>
            <footer>Shape &amp; Packing · Orientation Rose · Compare Sites &amp; Dates</footer>
          </article>

          <article class="capability-card">
            <h3>Tables, Vector Outlines &amp; Project Backups</h3>
            <p>
              Download per-grain and summary CSV/JSON tables, GeoJSON and SVG grain outlines, 16-bit and 32-bit PNG label masks, SVG/PNG charts, a printable one-page HTML report, or a <code>.webgrainy.json</code> project file that saves all photos, scales, and edits.
            </p>
            <footer>CSV · JSON · GeoJSON · SVG · PNG Masks · Printable Report</footer>
          </article>
        </div>
      </section>

      <!-- Models Section -->
      <section id="models" class="landing-section landing-cv-section" aria-labelledby="models-heading">
        <div class="landing-section-header">
          <p class="landing-eyebrow">NEURAL NETWORK OPTIONS</p>
          <h2 id="models-heading" class="landing-h2">Choose the right model for your device and survey</h2>
          <p class="landing-section-sub">
            By default, <strong>Auto</strong> picks a model based on your photo and hardware (always U-Net on phones and tablets). You can also pick a specific model in Analysis settings or pre-download weights in the Models dialog before going offline.
          </p>
        </div>

        <div tabindex="0" role="region" aria-labelledby="models-table-caption" class="landing-table-wrapper">
          <table class="landing-models-table">
            <caption id="models-table-caption">
              ImageGrains 2.0 models available in webGrainy
            </caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Download Size</th>
                <th scope="col">Best For</th>
                <th scope="col">Hardware &amp; Memory</th>
                <th scope="col">Speed &amp; Accuracy Trade-off</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <strong>Cellpose-SAM (FP16)</strong>
                  <span class="table-sub"><code>ig2_cpsam_fp16.onnx</code></span>
                </th>
                <td>617 MB</td>
                <td>Desktop or laptop with a supported graphics card</td>
                <td>Used automatically on a graphics card with WebGPU float16 (<code>shader-f16</code>)</td>
                <td>Original Cellpose-SAM weights; high outline accuracy for results you will report or publish</td>
              </tr>
              <tr>
                <th scope="row">
                  <strong>Cellpose-SAM (INT8)</strong>
                  <span class="table-sub"><code>ig2_cpsam_int8_wo_fp32scale.onnx</code></span>
                </th>
                <td>316 MB</td>
                <td>Desktop or laptop running on the CPU</td>
                <td>Used automatically on the CPU (about 2 GB memory, half of FP16)</td>
                <td>Compressed copy of Cellpose-SAM; gave the same accuracy as FP16 in testing and loads faster on CPU</td>
              </tr>
              <tr>
                <th scope="row">
                  <strong>Cellpose-SAM (FP4)</strong>
                  <span class="table-sub"><code>ig2_cpsam_fp4_e2m1_lut.onnx</code></span>
                </th>
                <td>183 MB</td>
                <td>Slower or metered internet connections</td>
                <td>Smallest CP-SAM download (needs about 3.7 GB memory while running)</td>
                <td>Compressed copy of Cellpose-SAM; gave the same accuracy as FP16 in testing with a smaller download</td>
              </tr>
              <tr>
                <th scope="row">
                  <strong>U-Net (Fast)</strong>
                  <span class="table-sub"><code>ig2_unet_fp32.onnx</code></span>
                </th>
                <td>26 MB</td>
                <td>Phones, tablets, or quick field previews</td>
                <td>Works almost anywhere with low memory use</td>
                <td>Small and fast; ideal for quick checks or mobile use, though less accurate than Cellpose-SAM</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="landing-section-actions">
          <button type="button" class="btn btn-primary" data-open-modal="models">
            Manage &amp; Pre-Download Offline Models
          </button>
          <a class="btn" href="./gpucheck.html">
            Check Graphics Card Compatibility
          </a>
        </div>
      </section>

      <!-- Practical Field Guidelines & Attribution -->
      <section id="validity" class="landing-section landing-cv-section" aria-labelledby="validity-heading">
        <div class="landing-section-header">
          <p class="landing-eyebrow">FIELD TIPS &amp; CITATIONS</p>
          <h2 id="validity-heading" class="landing-h2">Practical tips for reliable grain-size measurements</h2>
          <p class="landing-section-sub">
            Photo-sieving measures the visible 2D outlines of surface stones. A few simple field and analysis habits help keep your results consistent and comparable.
          </p>
        </div>

        <div class="validity-grid">
          <article class="validity-card">
            <h3>1. Taking Good Field Photos</h3>
            <p>
              Take photos straight down with a rigid ruler or quadrat lying flat on the gravel near the middle of the frame. Avoid strong shadows, motion blur, or wide-angle action-camera distortion, and always inspect the outlines on wet or shadowy beds.
            </p>
          </article>

          <article class="validity-card">
            <h3>2. Comparing with Field Pebble Counts</h3>
            <p>
              Photos can resolve much smaller stones than a hand Wolman pebble count, which makes an unfiltered photo D<sub>50</sub> look finer than a field count. Set the <strong>Field-count cutoff (mm)</strong> in the Results panel to the smallest stone size your field method records (typically 8–16 mm).
            </p>
          </article>

          <article class="validity-card">
            <h3>3. Citations &amp; Independent Implementation</h3>
            <p>
              <strong>webGrainy</strong> is an independent, unofficial browser application and is not affiliated with or endorsed by the original ImageGrains or Cellpose authors. When publishing results obtained with these models, please cite <strong>Mair et al. (2026)</strong> (<em>ImageGrains 2.0</em>) and <strong>Pachitariu et al. (2025)</strong> (<em>Cellpose-SAM</em>), and keep the same model and settings across all photos you compare.
            </p>
            <div class="validity-card-actions">
              <button type="button" class="btn btn-sm" data-open-modal="about">About &amp; All 16 Citations</button>
              <button type="button" class="btn btn-sm" data-open-help="">Settings Help</button>
              <button type="button" class="btn btn-sm" data-open-modal="shortcuts">Keyboard Shortcuts</button>
            </div>
          </article>
        </div>
      </section>
    </main>

    <footer class="landing-footer">
      <div class="landing-footer-inner">
        <div class="landing-footer-copy">
          <strong>webGrainy — ImageGrains 2.0 Web</strong>
          <span>Browser-based, offline-capable gravel and sediment grain-size analysis. Your photos stay on your device.</span>
        </div>
        <div class="landing-footer-actions">
          <button type="button" class="btn btn-primary" data-action="add-photos">Add Photos &amp; Start</button>
          <button type="button" class="btn" data-action="enter-workspace">Open Workspace</button>
          <button type="button" class="btn" data-open-modal="about">About &amp; Citations</button>
        </div>
      </div>
    </footer>
  `;
}
