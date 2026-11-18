/**
 * Landing page & product overview for webGrainy (ImageGrains 2.0 Web).
 *
 * Explains what the application is for, what it measures, and how the 5-step
 * field-to-export workflow operates, with direct entry points into the
 * local browser workspace. Pure (state -> HTML) for unit testing.
 */
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
      <title id="hero-svg-title">Segmented river gravel quadrat with physical millimeter scale bar, fitted grain ellipses, and cumulative particle-size distribution readout</title>
      <!-- Riverbed substrate background -->
      <rect x="0" y="0" width="600" height="410" rx="8" fill="#111820" />
      <rect x="14" y="14" width="572" height="278" rx="6" fill="#18222d" stroke="#2c3b4b" stroke-width="1.2" />

      <!-- Subtle quadrat survey boundary -->
      <rect x="28" y="44" width="388" height="234" rx="3" fill="#131b24" stroke="#3b9eff" stroke-width="1.4" stroke-dasharray="6 4" />
      <text x="36" y="60" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="10" font-weight="600">ROI QUADRAT · 0.42 mm/px</text>

      <!-- Excluded corner area (field boot / stadia base) -->
      <polygon points="344,210 416,210 416,278 326,278" fill="rgba(231, 76, 60, 0.16)" stroke="#e74c3c" stroke-width="1.4" stroke-dasharray="4 3" />
      <text x="345" y="268" fill="#ff8577" font-family="ui-monospace, monospace" font-size="9.5" font-weight="600">EXCLUDED</text>

      <!-- Physical ruler / scale calibration bar at top of frame -->
      <rect x="34" y="20" width="248" height="16" rx="2" fill="#22303f" stroke="#4f6479" stroke-width="1" />
      <line x1="44" y1="28" x2="270" y2="28" stroke="#f5a623" stroke-width="2" />
      <circle cx="44" cy="28" r="3.5" fill="#f5a623" />
      <circle cx="270" cy="28" r="3.5" fill="#f5a623" />
      <text x="157" y="31" text-anchor="middle" fill="#ffd485" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">500.0 mm SCALE</text>

      <!-- Segmented gravel clasts with Wentworth colors + moment ellipses + b-axis vectors -->
      <!-- Large cobble #1 -->
      <g transform="translate(115, 130) rotate(-18)">
        <ellipse cx="0" cy="0" rx="52" ry="35" fill="rgba(59, 158, 255, 0.28)" stroke="#69b7ff" stroke-width="1.8" />
        <line x1="-52" y1="0" x2="52" y2="0" stroke="#e8eef4" stroke-width="1.2" stroke-dasharray="3 2" />
        <line x1="0" y1="-35" x2="0" y2="35" stroke="#2ecc71" stroke-width="1.8" />
        <text x="-18" y="-6" fill="#ffffff" font-family="ui-monospace, monospace" font-size="10" font-weight="700">b=68mm</text>
      </g>

      <!-- Medium cobble #2 -->
      <g transform="translate(238, 118) rotate(24)">
        <ellipse cx="0" cy="0" rx="44" ry="29" fill="rgba(46, 204, 113, 0.26)" stroke="#2ecc71" stroke-width="1.8" />
        <line x1="-44" y1="0" x2="44" y2="0" stroke="#e8eef4" stroke-width="1.1" stroke-dasharray="3 2" />
        <line x1="0" y1="-29" x2="0" y2="29" stroke="#2ecc71" stroke-width="1.7" />
        <text x="-17" y="4" fill="#ffffff" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">b=54mm</text>
      </g>

      <!-- Coarse gravel #3 -->
      <g transform="translate(342, 112) rotate(-12)">
        <ellipse cx="0" cy="0" rx="36" ry="24" fill="rgba(59, 158, 255, 0.24)" stroke="#58a6ff" stroke-width="1.6" />
        <line x1="0" y1="-24" x2="0" y2="24" stroke="#2ecc71" stroke-width="1.5" />
        <text x="-15" y="4" fill="#e8eef4" font-family="ui-monospace, monospace" font-size="9" font-weight="600">44mm</text>
      </g>

      <!-- Coarse gravel #4 -->
      <g transform="translate(96, 218) rotate(14)">
        <ellipse cx="0" cy="0" rx="39" ry="26" fill="rgba(46, 204, 113, 0.24)" stroke="#2ecc71" stroke-width="1.6" />
        <line x1="0" y1="-26" x2="0" y2="26" stroke="#2ecc71" stroke-width="1.5" />
        <text x="-15" y="4" fill="#e8eef4" font-family="ui-monospace, monospace" font-size="9" font-weight="600">49mm</text>
      </g>

      <!-- Medium gravel cluster -->
      <g transform="translate(194, 204) rotate(-28)">
        <ellipse cx="0" cy="0" rx="31" ry="21" fill="rgba(245, 166, 35, 0.25)" stroke="#f5a623" stroke-width="1.5" />
        <line x1="0" y1="-21" x2="0" y2="21" stroke="#ffd485" stroke-width="1.3" />
        <text x="-14" y="3" fill="#ffffff" font-family="ui-monospace, monospace" font-size="8.5" font-weight="600">38mm</text>
      </g>
      <g transform="translate(274, 198) rotate(9)">
        <ellipse cx="0" cy="0" rx="28" ry="19" fill="rgba(59, 158, 255, 0.24)" stroke="#69b7ff" stroke-width="1.5" />
        <text x="-13" y="3" fill="#e8eef4" font-family="ui-monospace, monospace" font-size="8.5">34mm</text>
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
      <text x="440" y="42" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="700">Cumulative PSD</text>
      <text x="440" y="55" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="8.5">Area-weighted · 95% CI</text>

      <!-- Mini chart plot box -->
      <rect x="442" y="64" width="120" height="122" fill="#0d1218" stroke="#263340" stroke-width="1" />
      <!-- Horizontal grid lines (D16, D50, D84) -->
      <line x1="442" y1="166" x2="562" y2="166" stroke="#23303d" stroke-width="1" stroke-dasharray="2 2" />
      <line x1="442" y1="125" x2="562" y2="125" stroke="#2a3b4c" stroke-width="1" stroke-dasharray="2 2" />
      <line x1="442" y1="84" x2="562" y2="84" stroke="#23303d" stroke-width="1" stroke-dasharray="2 2" />
      <!-- 95% bootstrap confidence band -->
      <path d="M 446 182 C 470 176, 488 144, 504 118 C 520 92, 538 72, 558 67 L 558 75 C 538 82, 520 104, 504 132 C 488 156, 470 180, 446 184 Z" fill="rgba(59, 158, 255, 0.24)" />
      <!-- Main PSD sigmoid curve -->
      <path d="M 446 183 C 470 178, 488 150, 504 125 C 520 98, 538 77, 558 70" fill="none" stroke="#3b9eff" stroke-width="2.2" />
      <!-- D50 marker point -->
      <circle cx="504" cy="125" r="3.5" fill="#2ecc71" stroke="#0d1218" stroke-width="1.2" />

      <!-- Readout rows under mini chart -->
      <text x="442" y="204" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5">D16: <tspan fill="#e8eef4" font-weight="700">18.4 mm</tspan></text>
      <text x="442" y="222" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5">D50: <tspan fill="#2ecc71" font-weight="700">42.7 mm</tspan></text>
      <text x="442" y="236" fill="#8395a7" font-family="ui-monospace, monospace" font-size="8.2">95% CI [39.8, 45.9]</text>
      <text x="442" y="254" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5">D84: <tspan fill="#e8eef4" font-weight="700">86.2 mm</tspan></text>
      <text x="442" y="270" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="8.5">n = 342 interior clasts</text>

      <!-- Bottom pipeline telemetry strip -->
      <rect x="14" y="302" width="572" height="94" rx="6" fill="#161f29" stroke="#2a3642" stroke-width="1.2" />
      <text x="28" y="324" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="10" font-weight="700">ON-DEVICE EXECUTION PIPELINE · ZERO SERVER UPLOADS</text>

      <rect x="28" y="336" width="128" height="46" rx="4" fill="#1c2733" stroke="#2f3e4e" />
      <text x="38" y="354" fill="#69b7ff" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">1. Calibrate &amp; ROI</text>
      <text x="38" y="370" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9.5">2-pt scale · 4-pt rectify</text>

      <rect x="166" y="336" width="132" height="46" rx="4" fill="#1c2733" stroke="#2f3e4e" />
      <text x="176" y="354" fill="#69b7ff" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">2. ONNX Inference</text>
      <text x="176" y="370" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9.5">WebGPU FP16 / WASM</text>

      <rect x="308" y="336" width="132" height="46" rx="4" fill="#1c2733" stroke="#2f3e4e" />
      <text x="318" y="354" fill="#69b7ff" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">3. Multigrid PDE</text>
      <text x="318" y="370" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9.5">Flow QC &amp; mask edit</text>

      <rect x="450" y="336" width="122" height="46" rx="4" fill="#1c2733" stroke="#2f3e4e" />
      <text x="460" y="354" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">4. Site PSD &amp; CI</text>
      <text x="460" y="370" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9.5">CSV · GeoJSON · PNG</text>
    </svg>
  `;
}

export const WORKFLOW_STEPS: ReadonlyArray<WorkflowStepSpec> = [
  {
    id: 'calibrate',
    num: 1,
    shortTitle: 'Capture & Calibrate',
    headline: 'Add field photos, rectify perspective, and set physical millimeter scale',
    summary:
      'Import nadir gravel-bar photos with a ruler, stadia rod, or sampling quadrat in view. If a photo was taken at an oblique angle, apply 4-point homography rectification first, then mark two points a known distance apart to establish the millimeter-per-pixel scale (mmPerPx).',
    bullets: [
      {
        label: 'Two-point scale calibration',
        detail:
          'Click both ends of a ruler or quadrat edge and enter the known length in mm or cm. Required for pooling multiple photos at different camera heights into one site report.',
      },
      {
        label: 'Four-point perspective rectification',
        detail:
          'Project oblique quadrat photos onto an orthographic plane with known physical width and height before segmentation.',
      },
      {
        label: 'EXIF survey date & metadata',
        detail:
          'Capture dates are parsed locally in your browser for temporal site comparisons; photos are stored in IndexedDB and never leave your device.',
      },
    ],
    cta: {
      label: 'Add Photos & Calibrate in Workspace',
      action: 'add-photos',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-cal-title">
        <title id="wf-svg-cal-title">Two-point ruler calibration and four-point perspective homography rectification</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <!-- Left: 4-point oblique trapezoid -> rectified square -->
        <text x="20" y="26" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="10" font-weight="700">A. 4-POINT RECTIFICATION</text>
        <polygon points="36,54 148,46 168,148 22,156" fill="rgba(59, 158, 255, 0.14)" stroke="#69b7ff" stroke-width="1.5" stroke-dasharray="4 3" />
        <circle cx="36" cy="54" r="4" fill="#3b9eff" />
        <circle cx="148" cy="46" r="4" fill="#3b9eff" />
        <circle cx="168" cy="148" r="4" fill="#3b9eff" />
        <circle cx="22" cy="156" r="4" fill="#3b9eff" />
        <text x="95" y="106" text-anchor="middle" fill="#e8eef4" font-family="ui-monospace, monospace" font-size="9.5">500 × 500 mm</text>
        <text x="95" y="120" text-anchor="middle" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="8.5">Homography warp</text>

        <!-- Right: 2-point ruler scale -->
        <text x="212" y="26" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="10" font-weight="700">B. 2-POINT SCALE (mm/px)</text>
        <rect x="212" y="44" width="188" height="122" rx="4" fill="#18222d" stroke="#2c3b4b" />
        <rect x="226" y="74" width="160" height="24" rx="2" fill="#243242" stroke="#4f6479" />
        <line x1="236" y1="86" x2="376" y2="86" stroke="#f5a623" stroke-width="2.4" />
        <circle cx="236" cy="86" r="4.5" fill="#f5a623" />
        <circle cx="376" cy="86" r="4.5" fill="#f5a623" />
        <text x="306" y="118" text-anchor="middle" fill="#ffd485" font-family="ui-monospace, monospace" font-size="10" font-weight="700">P1 → P2 = 300.0 mm</text>
        <text x="306" y="136" text-anchor="middle" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="9.5">Scale: 0.384 mm/px</text>

        <!-- Bottom note -->
        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">Physical calibration unlocks millimeter pooling &amp; Wentworth classes</text>
        <text x="32" y="220" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9">Quick presets: 100 mm · 300 mm · 500 mm · 1000 mm quadrat</text>
      </svg>
    `,
  },
  {
    id: 'exclude',
    num: 2,
    shortTitle: 'ROI & Exclusions',
    headline: 'Mask out rulers, boots, water, or vegetation and skip outside inference tiles',
    summary:
      'Before running segmentation, draw a Region of Interest (ROI) polygon or paint exclusion zones over anything that is not gravel. Excluded regions are omitted from grain counts and automatically skipped during tiled neural inference.',
    bullets: [
      {
        label: 'Polygon & brush exclusion tools',
        detail:
          'Outline stadia rods, field boots, vegetation patches, or deep shadows with the Exclusion Polygon or Exclusion Brush tools so non-sediment objects never skew D84 or D95.',
      },
      {
        label: 'ROI tile skipping',
        detail:
          'When "Skip inference tiles outside ROI" is enabled (default), 256×256 tiles falling completely outside the active region are bypassed, accelerating Cellpose-SAM runs.',
      },
      {
        label: 'Non-destructive & adjustable',
        detail:
          'Exclusion masks can be updated after analysis to immediately recompute statistics; if an ROI is expanded into un-analyzed tiles, the dashboard warns you to re-run.',
      },
    ],
    cta: {
      label: 'Launch Workspace with Exclusion Tool',
      action: 'enter-workspace',
      tool: 'excludePoly',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-exc-title">
        <title id="wf-svg-exc-title">Region of interest polygon, exclusion mask, and skipped 256x256 inference tiles</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <!-- 4x3 tile grid -->
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
        <!-- Active ROI polygon -->
        <rect x="34" y="64" width="186" height="100" fill="rgba(46, 204, 113, 0.14)" stroke="#2ecc71" stroke-width="2" />
        <text x="44" y="82" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">ACTIVE ROI</text>

        <!-- Excluded object inside frame -->
        <polygon points="154,116 214,116 214,158 144,158" fill="rgba(231, 76, 60, 0.25)" stroke="#e74c3c" stroke-width="1.6" stroke-dasharray="4 2" />
        <text x="153" y="142" fill="#ff8577" font-family="ui-monospace, monospace" font-size="8.5" font-weight="700">EXCLUDED</text>

        <!-- Skipped tile labels -->
        <text x="262" y="50" text-anchor="middle" fill="#8395a7" font-family="ui-monospace, monospace" font-size="8.5">SKIPPED</text>
        <text x="262" y="100" text-anchor="middle" fill="#8395a7" font-family="ui-monospace, monospace" font-size="8.5">SKIPPED</text>
        <text x="262" y="150" text-anchor="middle" fill="#8395a7" font-family="ui-monospace, monospace" font-size="8.5">SKIPPED</text>

        <!-- Legend box on right -->
        <rect x="308" y="22" width="94" height="150" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="316" y="42" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="9.5" font-weight="700">Tile Legend</text>
        <rect x="316" y="54" width="12" height="12" fill="rgba(46, 204, 113, 0.22)" stroke="#2ecc71" />
        <text x="334" y="64" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9">Analyzed ROI</text>
        <rect x="316" y="76" width="12" height="12" fill="rgba(231, 76, 60, 0.25)" stroke="#e74c3c" />
        <text x="334" y="86" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9">Excluded mask</text>
        <rect x="316" y="98" width="12" height="12" fill="#151d26" stroke="#263340" />
        <text x="334" y="108" fill="#9fb0c0" font-family="system-ui, sans-serif" font-size="9">Tile skipped</text>

        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">Effective surveyed area (m²) adjusts automatically for excluded pixels</text>
        <text x="32" y="220" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9">Border-touching grains (2 px margin) are flagged &amp; excluded by default</text>
      </svg>
    `,
  },
  {
    id: 'segment',
    num: 3,
    shortTitle: 'Neural Segmentation',
    headline: 'Run ImageGrains 2.0 U-Net or Cellpose-SAM locally via WebGPU or WASM SIMD',
    summary:
      'Execute pretrained ImageGrains 2.0 ONNX models directly in your browser. Pinned weights are streamed once from Hugging Face, verified with WebCrypto SHA-256, and cached in IndexedDB for offline field or lab use.',
    bullets: [
      {
        label: 'Fast U-Net vs. High-Accuracy Cellpose-SAM',
        detail:
          'U-Net (25.3 MiB FP32) runs rapidly on mobile and CPU; Cellpose-SAM (FP16 on WebGPU / INT8 on CPU) achieves 2.87% median D50 error on held-out test images.',
      },
      {
        label: 'Adaptive scaling & optional CLAHE',
        detail:
          'Automatically scales high-resolution images so large boulders (>350 px) fit within 256×256 receptive tiles, then rescales all morphometrics back to original pixels and mm.',
      },
      {
        label: 'Multigrid PDE & flow integration worker',
        detail:
          'Offloads 250-step bilinear Euler gradient flow integration, 4-level coarse-to-fine Jacobi PDE smoothing, and dumbbell split recovery to a dedicated Web Worker.',
      },
    ],
    cta: {
      label: 'Manage Offline ONNX Models',
      modal: 'models',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-seg-title">
        <title id="wf-svg-seg-title">Tiled ONNX neural inference producing gradient flow fields and instance segmentation masks</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <!-- Stage 1: Overlapping 256x256 tiles -->
        <rect x="20" y="34" width="110" height="128" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="75" y="24" text-anchor="middle" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">1. TILED INPUT</text>
        <rect x="32" y="48" width="54" height="54" fill="rgba(59, 158, 255, 0.18)" stroke="#3b9eff" stroke-width="1.3" />
        <rect x="64" y="68" width="54" height="54" fill="rgba(46, 204, 113, 0.18)" stroke="#2ecc71" stroke-width="1.3" />
        <text x="75" y="144" text-anchor="middle" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="8.5">256×256 · Hanning</text>

        <!-- Stage 2: Gradient flow field (dPx, dPy, cellprob) -->
        <rect x="155" y="34" width="110" height="128" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="210" y="24" text-anchor="middle" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">2. GRADIENT FLOWS</text>
        <circle cx="210" cy="92" r="28" fill="rgba(245, 166, 35, 0.15)" stroke="#f5a623" stroke-width="1.2" stroke-dasharray="3 2" />
        <line x1="186" y1="92" x2="202" y2="92" stroke="#ffd485" stroke-width="1.5" />
        <line x1="234" y1="92" x2="218" y2="92" stroke="#ffd485" stroke-width="1.5" />
        <line x1="210" y1="68" x2="210" y2="84" stroke="#ffd485" stroke-width="1.5" />
        <line x1="210" y1="116" x2="210" y2="100" stroke="#ffd485" stroke-width="1.5" />
        <circle cx="210" cy="92" r="3.5" fill="#2ecc71" />
        <text x="210" y="144" text-anchor="middle" fill="#ffd485" font-family="ui-monospace, monospace" font-size="8.5">250-step Euler + PDE</text>

        <!-- Stage 3: Instance masks & moments -->
        <rect x="290" y="34" width="110" height="128" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="345" y="24" text-anchor="middle" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">3. INSTANCE MASKS</text>
        <ellipse cx="332" cy="82" rx="22" ry="15" transform="rotate(-18 332 82)" fill="rgba(46, 204, 113, 0.28)" stroke="#2ecc71" stroke-width="1.6" />
        <ellipse cx="364" cy="108" rx="18" ry="13" transform="rotate(22 364 108)" fill="rgba(59, 158, 255, 0.28)" stroke="#69b7ff" stroke-width="1.6" />
        <text x="345" y="144" text-anchor="middle" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="8.5">Moments &amp; Calipers</text>

        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">SHA-256 verified weights cached in IndexedDB (imagegrains-onnx-cache-v1)</text>
        <text x="32" y="220" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9">Pinned commit: inYourOwnBrowser/imagegrains-2.0-onnx@98e76b13</text>
      </svg>
    `,
  },
  {
    id: 'edit',
    num: 4,
    shortTitle: 'Inspect & Edit Masks',
    headline: 'Review flagged grains and refine outlines with deterministic split, merge, and polygon tools',
    summary:
      'Automated segmentation can under-split touching cobbles or over-split fractured clasts under harsh lighting. Use the interactive canvas editor and magnifying loupe to inspect and correct masks with instant Undo/Redo.',
    bullets: [
      {
        label: 'Split, Merge, Delete & Draw Polygon',
        detail:
          'Draw a line across a merged dumbbell grain to split it, select multiple fragments to merge them into one clast, delete false positives, or trace missing boulders.',
      },
      {
        label: 'Flagged-grain navigation & 2×/4× loupe',
        detail:
          'Step directly through the largest clasts or grains flagged for extreme elongation or border proximity, updating PSD curves and D50 in real time.',
      },
      {
        label: 'Moment ellipse vs. rotating-calipers Feret axes',
        detail:
          'Inspect each grain’s moment-equivalent ellipse axes (a, b), equal-area diameter (dEq), minimum/maximum Feret caliper widths, circularity, and solidity.',
      },
    ],
    cta: {
      label: 'Open Workspace Mask Editor',
      action: 'enter-workspace',
      tool: 'split',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-edit-title">
        <title id="wf-svg-edit-title">Interactive split-line gesture separating merged grains and comparing moment ellipse b-axis with minimum Feret caliper width</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <!-- Left panel: Split line across dumbbell grain -->
        <rect x="20" y="24" width="182" height="146" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="32" y="42" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">SPLIT DUMBBELL CLAST</text>
        <ellipse cx="86" cy="102" rx="34" ry="25" fill="rgba(59, 158, 255, 0.26)" stroke="#69b7ff" stroke-width="1.6" />
        <ellipse cx="140" cy="104" rx="30" ry="23" fill="rgba(46, 204, 113, 0.26)" stroke="#2ecc71" stroke-width="1.6" />
        <line x1="115" y1="62" x2="113" y2="144" stroke="#f5a623" stroke-width="2.2" stroke-dasharray="4 3" />
        <circle cx="115" cy="62" r="3.5" fill="#f5a623" />
        <circle cx="113" cy="144" r="3.5" fill="#f5a623" />
        <text x="111" y="158" text-anchor="middle" fill="#ffd485" font-family="ui-monospace, monospace" font-size="8.5">Split line → 2 grains</text>

        <!-- Right panel: bAxis vs minFeret -->
        <rect x="218" y="24" width="182" height="146" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="230" y="42" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">SIZE METRIC GEOMETRY</text>
        <g transform="translate(309, 100) rotate(-20)">
          <!-- Parallel caliper lines for minFeret -->
          <line x1="-48" y1="-27" x2="48" y2="-27" stroke="#f5a623" stroke-width="1.2" stroke-dasharray="3 2" />
          <line x1="-48" y1="27" x2="48" y2="27" stroke="#f5a623" stroke-width="1.2" stroke-dasharray="3 2" />
          <ellipse cx="0" cy="0" rx="44" ry="25" fill="rgba(59, 158, 255, 0.24)" stroke="#69b7ff" stroke-width="1.7" />
          <line x1="-44" y1="0" x2="44" y2="0" stroke="#e8eef4" stroke-width="1.2" />
          <line x1="0" y1="-25" x2="0" y2="25" stroke="#2ecc71" stroke-width="2" />
        </g>
        <text x="309" y="158" text-anchor="middle" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="8.5"><tspan fill="#2ecc71">bAxis</tspan> · <tspan fill="#ffd485">minFeret</tspan> · <tspan fill="#69b7ff">dEq</tspan></text>

        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">Bounding-box diff Undo/Redo stack (~1 ms per edit step on desktop)</text>
        <text x="32" y="220" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9">Keyboard shortcuts: S (Split) · M (Merge) · D (Delete) · A (Add) · Ctrl+Z</text>
      </svg>
    `,
  },
  {
    id: 'export',
    num: 5,
    shortTitle: 'Statistics & Export',
    headline: 'Compute pooled site distributions, uncertainty intervals, and provenance-stamped exports',
    summary:
      'Analyze single photos or pool an entire site using physical-area weighting or virtual Wolman sampling. Inspect cumulative PSD curves, Folk & Ward phi statistics, Wentworth histograms, and axial orientation rose diagrams, then export.',
    bullets: [
      {
        label: 'Uncertainty & sample adequacy diagnostics',
        detail:
          'Reports photo-cluster bootstrap 95% confidence intervals, Eaton et al. (2019) binomial percentile CIs, leave-one-photo-out jackknife stability, and largest-clast area warnings.',
      },
      {
        label: 'Compare multiple sites or repeat survey dates',
        detail:
          'Overlay PSD curves across river reaches or track temporal D16, D50, and D84 changes across flood events.',
      },
      {
        label: 'Publication-ready tables, vectors & archives',
        detail:
          'Download per-grain and summary CSV/JSON, 16-bit PNG masks, GeoJSON/SVG contours, printable HTML reports, and .webgrainy.json site archives with full SHA-256 provenance.',
      },
    ],
    cta: {
      label: 'Preview Export Formats',
      modal: 'export',
    },
    svg: `
      <svg class="wf-diagram-svg" role="img" viewBox="0 0 420 250" aria-labelledby="wf-svg-exp-title">
        <title id="wf-svg-exp-title">Pooled site cumulative PSD curve with bootstrap confidence interval, axial orientation rose diagram, and provenance export formats</title>
        <rect x="0" y="0" width="420" height="250" rx="6" fill="#111820" />
        <!-- Left: PSD curve with CI band -->
        <rect x="20" y="24" width="210" height="146" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="32" y="42" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">POOLED SITE PSD (95% CI)</text>
        <line x1="36" y1="146" x2="214" y2="146" stroke="#2c3b4b" stroke-width="1" />
        <line x1="36" y1="54" x2="36" y2="146" stroke="#2c3b4b" stroke-width="1" />
        <path d="M 42 142 C 78 138, 108 112, 132 88 C 156 66, 182 58, 210 55 L 210 65 C 182 68, 156 78, 132 102 C 108 124, 78 143, 42 145 Z" fill="rgba(59, 158, 255, 0.24)" />
        <path d="M 42 144 C 78 140, 108 118, 132 95 C 156 72, 182 63, 210 59" fill="none" stroke="#3b9eff" stroke-width="2.2" />
        <circle cx="132" cy="95" r="3.5" fill="#2ecc71" />
        <text x="140" y="99" fill="#2ecc71" font-family="ui-monospace, monospace" font-size="9" font-weight="700">D50 = 42.7 mm</text>

        <!-- Right: Fabric Rose Diagram & Export chips -->
        <rect x="244" y="24" width="156" height="146" rx="4" fill="#17212b" stroke="#2c3b4b" />
        <text x="256" y="42" fill="#9fb0c0" font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">CLAST FABRIC &amp; EXPORTS</text>
        <circle cx="322" cy="94" r="36" fill="#111820" stroke="#2c3b4b" stroke-width="1" />
        <circle cx="322" cy="94" r="22" fill="none" stroke="#243242" stroke-width="1" stroke-dasharray="2 2" />
        <polygon points="322,94 348,72 354,82" fill="rgba(59, 158, 255, 0.45)" stroke="#69b7ff" stroke-width="1" />
        <polygon points="322,94 296,116 290,106" fill="rgba(59, 158, 255, 0.45)" stroke="#69b7ff" stroke-width="1" />
        <polygon points="322,94 344,88 342,98" fill="rgba(46, 204, 113, 0.38)" stroke="#2ecc71" stroke-width="1" />
        <polygon points="322,94 300,100 302,90" fill="rgba(46, 204, 113, 0.38)" stroke="#2ecc71" stroke-width="1" />
        <text x="322" y="148" text-anchor="middle" fill="#89b8e8" font-family="ui-monospace, monospace" font-size="8.5">Axial Rose · Curray R</text>

        <rect x="20" y="184" width="380" height="48" rx="4" fill="#17212b" stroke="#2a3642" />
        <text x="32" y="204" fill="#e8eef4" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600">Every export embeds model SHA-256, ORT version, scale, and metric definition</text>
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
        <p class="landing-eyebrow">INTERACTIVE PIPELINE WALKTHROUGH</p>
        <h2 id="workflow-heading" class="landing-h2">From field photo to publication-ready grain-size distribution in five steps</h2>
        <p class="landing-section-sub">
          Select any stage below (or use your Left and Right arrow keys) to see how webGrainy processes raw imagery into calibrated sedimentological statistics. All five stages remain searchable via your browser’s Find in Page.
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
                    <button type="button" class="btn" data-open-help="">View Settings Reference</button>
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
          <span class="badge">ImageGrains 2.0 Web</span>
        </div>

        <nav class="landing-nav" aria-label="Landing page sections">
          <a href="#workflow" class="landing-nav-link">5-Step Workflow</a>
          <a href="#capabilities" class="landing-nav-link">Capabilities</a>
          <a href="#models" class="landing-nav-link">Models &amp; Benchmarks</a>
          <a href="#validity" class="landing-nav-link">Scientific Scope</a>
        </nav>

        <div class="landing-header-actions">
          <span class="status-pill ${caps?.hasWebGPU || caps?.hasWasmSimd ? 'ok' : ''}" title="Local inference runtime detected in this browser">
            <span class="dot" aria-hidden="true"></span>${esc(engineLabel)}
          </span>
          ${
            swReady
              ? `<span class="status-pill ok" title="Service Worker active: application shell and ONNX runtime are cached for offline use"><span class="dot" aria-hidden="true"></span>Offline Ready</span>`
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
          <p class="landing-eyebrow">100% BROWSER-NATIVE · PRIVACY-FIRST · OFFLINE-CAPABLE</p>
          <h1 id="landing-heading" class="landing-title" tabindex="-1">
            Measure gravel and sediment grain sizes directly from field photos
          </h1>
          <p class="landing-lead">
            <strong>webGrainy</strong> runs the pretrained <strong>ImageGrains 2.0</strong> segmentation models (U-Net and Cellpose-SAM) entirely on your device via WebGPU or multi-threaded WebAssembly. Calibrate physical millimeter scale, exclude non-gravel objects, refine grain outlines interactively, and compute pooled particle-size distributions (D<sub>16</sub>, D<sub>50</sub>, D<sub>84</sub>) with 95% confidence intervals and cryptographic provenance — without uploading a single photo to a server.
          </p>

          <div class="landing-cta-row">
            <button type="button" class="btn btn-primary landing-btn-lg" data-action="add-photos">
              Add Gravel Photos
            </button>
            <button type="button" class="btn landing-btn-lg" data-action="enter-workspace">
              ${
                photoCount > 0
                  ? `Resume Workspace (${photoCount} photo${photoCount === 1 ? '' : 's'})`
                  : 'Launch Empty Workspace'
              }
            </button>
            <button type="button" class="btn landing-btn-lg" data-action="import-archive">
              Open .webgrainy.json Project
            </button>
          </div>

          <div class="landing-drop-callout" id="landing-dropzone" data-action="add-photos" role="button" tabindex="0" aria-label="Add or drop gravel photos or a .webgrainy.json project archive to start">
            <strong>Drop field photos or a <code>.webgrainy.json</code> archive anywhere on this page</strong>
            <span>Supports JPEG, PNG, and WebP · All processing stays in local browser memory and IndexedDB${siteCount > 0 ? ` · ${siteCount} saved site${siteCount === 1 ? '' : 's'} on this device` : ''}</span>
          </div>

          <div class="landing-pref-row">
            <label class="checkbox-label landing-skip-label" for="landing-skip-checkbox">
              <input
                type="checkbox"
                id="landing-skip-checkbox"
                data-landing-skip=""
                ${view.skipLanding ? 'checked' : ''}
              />
              <span>Skip this overview on future visits and open straight into the workspace (re-open anytime via <strong>Overview</strong> in the top bar)</span>
            </label>
          </div>
        </div>

        <figure class="landing-hero-figure">
          ${renderHeroFigureSvg()}
          <figcaption class="landing-hero-caption">
            Automated grain segmentation with 2-point millimeter calibration, ROI exclusions, fitted moment ellipses (a, b), and pooled cumulative particle-size distribution with 95% bootstrap confidence bounds.
          </figcaption>
        </figure>
      </section>

      <!-- Key Pillars Strip -->
      <section class="landing-pillars" aria-label="Core architecture highlights">
        <div class="landing-pillar">
          <div class="landing-pillar-value">Zero Uploads</div>
          <div class="landing-pillar-label">100% Client-Side Privacy</div>
          <p class="landing-pillar-desc">No imagery, scale measurements, or site metadata ever leave your machine. Ideal for embargoed research and remote field laptops.</p>
        </div>
        <div class="landing-pillar">
          <div class="landing-pillar-value">2.87% Median</div>
          <div class="landing-pillar-label">Cellpose-SAM D<sub>50</sub> Error</div>
          <p class="landing-pillar-desc">Benchmarked on the held-out within-site ImageGrains 2.0 test split (n = 40 across 13 sites) against hand-digitized 2D masks (PQ = 0.652).</p>
        </div>
        <div class="landing-pillar">
          <div class="landing-pillar-value">3 Size Metrics</div>
          <div class="landing-pillar-label">bAxis · minFeret · dEq</div>
          <p class="landing-pillar-desc">Switch seamlessly between moment-ellipse minor axis, rotating-calipers minimum Feret width, and equal-area circle diameter with field-count cutoffs.</p>
        </div>
        <div class="landing-pillar">
          <div class="landing-pillar-value">SHA-256 Pinned</div>
          <div class="landing-pillar-label">Offline &amp; Reproducible</div>
          <p class="landing-pillar-desc">Weights are verified via WebCrypto before caching in IndexedDB, and every CSV, JSON, SVG, and GeoJSON export carries full provenance metadata.</p>
        </div>
      </section>

      <!-- 5-Step Interactive Workflow Section -->
      ${renderWorkflowSectionHtml(state.landingStep)}

      <!-- Capabilities Grid (CSS Subgrid Cards) -->
      <section id="capabilities" class="landing-section landing-cv-section" aria-labelledby="capabilities-heading">
        <div class="landing-section-header">
          <p class="landing-eyebrow">WHAT WEBGRAINY CAN DO</p>
          <h2 id="capabilities-heading" class="landing-h2">Built for quantitative fluvial geomorphology and sedimentology</h2>
          <p class="landing-section-sub">
            Every stage from raw pixel preprocessing to site-level statistical inference is implemented in deterministic TypeScript with zero external runtime CDNs.
          </p>
        </div>

        <div class="capabilities-grid">
          <article class="capability-card">
            <h3>Selectable 2D Size Metrics &amp; Truncation Cutoffs</h3>
            <p>
              Report grain distributions using the moment-equivalent ellipse minor axis (<code>bAxis</code>, default), rotating-calipers minimum Feret width (<code>minFeret</code>, closest 2D analogue to physical caliper b-axes), or equal-area circle diameter (<code>dEq</code>). Set a physical millimeter cutoff (<code>minSizeMm</code>) to harmonize photo truncation with field Wolman pebble counts.
            </p>
            <footer>bAxis · minFeret · dEq · Field-count cutoff (mm)</footer>
          </article>

          <article class="capability-card">
            <h3>Multi-Photo Site Pooling &amp; Uncertainty Bounds</h3>
            <p>
              Pool multiple calibrated photos across a gravel bar using physical-area weighting (Kellerhals &amp; Bray 1971 grid-by-number equivalence), virtual Wolman grid sampling, equal-photo weighting, or custom facies weights. Quantify uncertainty with photo-cluster bootstrap 95% CIs, Eaton et al. (2019) binomial CIs, and leave-one-photo-out jackknife stability.
            </p>
            <footer>Cluster Bootstrap · Binomial CIs · Jackknife · Adequacy</footer>
          </article>

          <article class="capability-card">
            <h3>Sedimentological Indices, Shape &amp; Clast Fabric</h3>
            <p>
              Automatically computes area- and number-weighted percentiles (D<sub>5</sub> to D<sub>95</sub>), Folk &amp; Ward (1957) logarithmic &phi; graphic mean (M<sub>z</sub>), sorting (&sigma;<sub>I</sub>), skewness (Sk<sub>I</sub>), kurtosis (K<sub>G</sub>), Trask &amp; geotechnical Cu/Cc coefficients, Wentworth class histograms, aspect ratio (b/a), circularity, solidity, and Curray (1956) axial orientation rose diagrams.
            </p>
            <footer>Folk &amp; Ward (&phi;) · Wentworth Scale · Axial Rose Diagrams</footer>
          </article>

          <article class="capability-card">
            <h3>Multi-Site &amp; Temporal Survey Comparison</h3>
            <p>
              Compare grain-size distributions across multiple river reaches or repeat surveys ordered by ISO survey date. Inspect overlaid cumulative PSD curves with confidence envelopes, pairwise D<sub>50</sub> differences, and temporal D<sub>16</sub> / D<sub>50</sub> / D<sub>84</sub> evolution charts to track bed coarsening or fining.
            </p>
            <footer>Multi-Reach Overlay · Temporal Tracking · Comparison CSV</footer>
          </article>

          <article class="capability-card">
            <h3>Adaptive Preprocessing &amp; Complexity Router</h3>
            <p>
              Optional pure-TypedArray CLAHE luminance normalization mitigates harsh cobble shadows and wet-stone glare. Adaptive downscaling (<code>auto</code>, <code>1.0x</code>, <code>0.5x</code>, <code>0.25x</code>) prevents large boulders (&gt;350 px) from exceeding 256&times;256 inference tiles, while the complexity router recommends U-Net vs. Cellpose-SAM based on image gradients and device capabilities.
            </p>
            <footer>CLAHE · Adaptive Input Scaling · WebGPU / WASM Router</footer>
          </article>

          <article class="capability-card">
            <h3>Provenance-Stamped Scientific Exports</h3>
            <p>
              Download per-grain morphometric CSVs, site summary JSON/CSV tables, 16/32-bit PNG instance label masks, Marching-Squares GeoJSON and SVG vector polygons in original image coordinates, printable HTML site reports, and <code>.webgrainy.json</code> project archives. Every export embeds the pinned model SHA-256 and full parameter provenance.
            </p>
            <footer>CSV · JSON · 16-bit PNG · GeoJSON · SVG · HTML Report</footer>
          </article>
        </div>
      </section>

      <!-- Models & Benchmark Accuracy Section -->
      <section id="models" class="landing-section landing-cv-section" aria-labelledby="models-heading">
        <div class="landing-section-header">
          <p class="landing-eyebrow">HOSTED ONNX WEIGHTS &amp; HELD-OUT BENCHMARKS</p>
          <h2 id="models-heading" class="landing-h2">Model options and held-out within-site test accuracy</h2>
          <p class="landing-section-sub">
            All weights are streamed from pinned Hugging Face revision <code>inYourOwnBrowser/imagegrains-2.0-onnx@98e76b13</code>, verified with WebCrypto SHA-256, and stored in IndexedDB. Evaluated on the held-out within-site test split (<code>IG2_data.zip</code>, <code>official_split == 'test'</code>, n = 40 images across 13 sites) against hand-digitized 2D pixel masks.
          </p>
        </div>

        <div tabindex="0" role="region" aria-labelledby="models-table-caption" class="landing-table-wrapper">
          <table class="landing-models-table">
            <caption id="models-table-caption">
              Comparison of ImageGrains 2.0 ONNX models available in webGrainy (default Cellpose pipeline, maxGrainAreaFraction = 0.40)
            </caption>
            <thead>
              <tr>
                <th scope="col">Model &amp; Weight File</th>
                <th scope="col">Download Size</th>
                <th scope="col">Recommended Runtime</th>
                <th scope="col">D<sub>50</sub> Median APE [95% CI]</th>
                <th scope="col">D<sub>50</sub> Mean APE [95% CI]</th>
                <th scope="col">Panoptic Quality (PQ)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <strong>Cellpose-SAM FP16</strong>
                  <span class="table-sub"><code>ig2_cpsam_fp16.onnx</code></span>
                </th>
                <td>617 MB</td>
                <td>Desktop WebGPU with <code>shader-f16</code> (automatic GPU default)</td>
                <td><strong>2.87%</strong> [2.02, 4.93]</td>
                <td>8.91% [4.00, 15.60]</td>
                <td><strong>0.652</strong> (PyTorch: 0.642)</td>
              </tr>
              <tr>
                <th scope="row">
                  <strong>Cellpose-SAM INT8</strong>
                  <span class="table-sub"><code>ig2_cpsam_int8_wo_fp32scale.onnx</code></span>
                </th>
                <td>316 MB</td>
                <td>Desktop CPU WASM SIMD (automatic CPU default; ~2 GB RAM)</td>
                <td><strong>2.87%</strong> (matches FP16)</td>
                <td>8.91% (matches FP16)</td>
                <td><strong>0.652</strong></td>
              </tr>
              <tr>
                <th scope="row">
                  <strong>Cellpose-SAM FP4</strong>
                  <span class="table-sub"><code>ig2_cpsam_fp4_e2m1_lut.onnx</code></span>
                </th>
                <td>183 MB</td>
                <td>Low-bandwidth connections (~3.7 GB runtime memory)</td>
                <td><strong>2.87%</strong> (matches FP16)</td>
                <td>8.91% (matches FP16)</td>
                <td><strong>0.652</strong></td>
              </tr>
              <tr>
                <th scope="row">
                  <strong>U-Net (Fast FP32)</strong>
                  <span class="table-sub"><code>ig2_unet_fp32.onnx</code></span>
                </th>
                <td>25.3 MiB (26.5 MB)</td>
                <td>Mobile devices, laptops without FP16 GPU, or rapid field previews</td>
                <td><strong>9.44%</strong> [5.32, 14.86]</td>
                <td>24.39% [13.69, 39.21]</td>
                <td><strong>0.539</strong> (PyTorch: 0.528)</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="landing-section-actions">
          <button type="button" class="btn btn-primary" data-open-modal="models">
            Pre-Download &amp; Cache Models for Offline Use
          </button>
          <a class="btn" href="./gpucheck.html">
            Run WebGPU vs. CPU Precision Check
          </a>
        </div>
      </section>

      <!-- Scientific Validity, Field Guidelines & Attribution -->
      <section id="validity" class="landing-section landing-cv-section" aria-labelledby="validity-heading">
        <div class="landing-section-header">
          <p class="landing-eyebrow">SCIENTIFIC SCOPE, FIELD PROTOCOL &amp; ATTRIBUTION</p>
          <h2 id="validity-heading" class="landing-h2">Best practices for defensible photo-sieving measurements</h2>
          <p class="landing-section-sub">
            Photo-sieving measures the 2D visible projection of surface clasts. Understanding how 2D image metrics relate to physical sieve and Wolman pebble counts ensures accurate reporting in publications.
          </p>
        </div>

        <div class="validity-grid">
          <article class="validity-card">
            <h3>1. Comparing 2D Photo Outlines with Wolman Pebble Counts</h3>
            <p>
              Reported <code>bAxis</code> values are the minor axes of moment-equivalent ellipses fitted to visible 2D outlines (<code>minFeret</code> measures the rotating-calipers width). Because field pebble counts typically truncate fines below 8–16 mm while photos resolve grains down to ~30 working pixels, raw photo D<sub>50</sub> can read finer than a field count. Set <strong>Field-count cutoff (mm)</strong> in the dashboard to your field protocol’s minimum clast size (e.g. 13 mm on the K1 benchmark site matches physical Wolman D<sub>50</sub> within +3–4%).
            </p>
          </article>

          <article class="validity-card">
            <h3>2. Camera Geometry, Scale &amp; Sample Adequacy</h3>
            <p>
              Capture photos straight down (nadir) with a rigid ruler or quadrat in the plane of the gravel bed. Standard smartphone and moderate drone lenses introduce &lt;1–3.3% radial distortion bias on center-bar D<sub>50</sub>, whereas wide-angle action cameras (GoPro) must be pre-undistorted before upload. Always inspect and edit masks on wet, shadowed, or matrix-rich beds, and aim for at least <strong>n &ge; 100 interior grains</strong> per site.
            </p>
          </article>

          <article class="validity-card">
            <h3>3. Independent Implementation &amp; Scientific Citations</h3>
            <p>
              <strong>webGrainy</strong> is an independent, unofficial browser implementation and is not affiliated with or endorsed by the original ImageGrains or Cellpose authors. Its browser post-processing (<code>F5_MagWeightedQC</code> + <code>F3_SplitOnFailure</code>) is tailored for client-side execution. When publishing results obtained with these models or methods, please cite <strong>Mair et al. (2026)</strong> (<em>Earth Surface Dynamics</em>, 14, 527–551) and <strong>Pachitariu et al. (2025)</strong> (<em>Cellpose-SAM</em>), and report your sample size <code>n</code> and the pinned model SHA-256 hash included in every export.
            </p>
            <div class="validity-card-actions">
              <button type="button" class="btn btn-sm" data-open-modal="about">View All 16 Scientific Citations</button>
              <button type="button" class="btn btn-sm" data-open-help="">Open Full Settings Guide</button>
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
          <span>100% client-side, privacy-first, offline-first gravel and sediment grain-sizing engine.</span>
        </div>
        <div class="landing-footer-actions">
          <button type="button" class="btn btn-primary" data-action="add-photos">Add Photos &amp; Start</button>
          <button type="button" class="btn" data-action="enter-workspace">Launch Workspace</button>
          <button type="button" class="btn" data-open-modal="about">Citations &amp; License</button>
        </div>
      </div>
    </footer>
  `;
}
