/**
 * GPU check page (gpucheck.html): compares WebGPU against the CPU (WASM) for the
 * Cellpose inference pipeline on this computer, using the app's own code and the
 * pinned, SHA-256-verified model from the app's cache. No installation needed.
 *
 * Background: ONNX Runtime's CUDA float16 backend diverged on Cellpose-SAM tiles with
 * Cellpose's zero border (Colab benchmark). WebGPU also computes in float16 when the
 * GPU supports `shader-f16`; this page measures whether WebGPU is affected.
 * Same cases and metrics as audit/review/webgpu_vs_wasm.mjs.
 */
import { getModel } from '../modules/modelCache.js';
import {
  createInferenceSession,
  probeWebGpuCapabilities,
  runCpsamCellposeInference,
  runUnetCellposeInference,
} from '../modules/onnxInference.js';
import { flowsToMasksBrowser } from '../modules/postprocessCore.js';
import { APP_VERSION, ORT_VERSION } from '../modules/provenance.js';
import { classifyCase, overallVerdict, type CaseVerdict } from '../modules/gpuCheckVerdict.js';
import type { InferenceOutput, ModelId } from '../types/index.js';

type Kind = 'cpsam' | 'cpsam_int8' | 'cpsam_fp4' | 'unet';
const KIND_MODEL: Record<Kind, ModelId> = {
  cpsam: 'ig2_cpsam_fp16',
  cpsam_int8: 'ig2_cpsam_int8_wo_fp32scale',
  cpsam_fp4: 'ig2_cpsam_fp4_e2m1_lut',
  unet: 'ig2_unet_fp32',
};
const KIND_LABEL: Record<Kind, string> = {
  cpsam: 'Cellpose-SAM (FP16)',
  cpsam_int8: 'Cellpose-SAM (INT8)',
  cpsam_fp4: 'Cellpose-SAM (FP4)',
  unet: 'U-Net',
};
const CASES = ['photo', 'one-tile', 'small-padded', 'all-black', 'photo-black'] as const;
type CaseName = (typeof CASES)[number];
const CASE_LABEL: Record<CaseName, string> = {
  photo: 'Gravel photo (512×384)',
  'one-tile': 'Single tile with zero border (240×240)',
  'small-padded': 'Small image, mostly padding (100×80)',
  'all-black': 'All-black image (256×256)',
  'photo-black': 'Gravel photo with a large black area (768×384)',
};
/** Width of the black area on the right of the 'photo-black' case (contains a whole 256 px tile). */
const PHOTO_BLACK_COLS = 384;
function blankRegion(kind: CaseName, W: number, H: number): Uint8Array | null {
  if (kind !== 'all-black' && kind !== 'photo-black') return null;
  const m = new Uint8Array(W * H);
  const x0 = kind === 'all-black' ? 0 : W - PHOTO_BLACK_COLS;
  for (let y = 0; y < H; y++) for (let x = x0; x < W; x++) m[y * W + x] = 1;
  return m;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const logEl = (): HTMLElement => $('log');
function log(msg: string): void {
  const line = document.createElement('div');
  line.textContent = msg;
  logEl().appendChild(line);
  logEl().scrollTop = logEl().scrollHeight;
}
function setStatus(msg: string): void {
  $('status').textContent = msg;
}

function makeImage(kind: CaseName): ImageData {
  const [W, H] = kind === 'photo-black' ? [768, 384] : kind === 'photo' ? [512, 384] : kind === 'one-tile' ? [240, 240] : kind === 'small-padded' ? [100, 80] : [256, 256];
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  if (kind !== 'all-black') {
    g.fillStyle = '#3a3630';
    g.fillRect(0, 0, W, H);
    let s = 11;
    const r = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
    const n = Math.round((W * H) / 900);
    for (let i = 0; i < n; i++) {
      const rad = 6 + r() * 18;
      const x = r() * W;
      const y = r() * H;
      const grd = g.createRadialGradient(x - rad / 3, y - rad / 3, 1, x, y, rad);
      const v = 140 + Math.floor(r() * 100);
      grd.addColorStop(0, `rgb(${v},${v - 6},${v - 18})`);
      grd.addColorStop(1, `rgb(${v - 70},${v - 75},${v - 85})`);
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(x, y, rad, rad * (0.6 + r() * 0.35), r() * 3.14, 0, 6.29);
      g.fill();
    }
    if (kind === 'photo-black') {
      // Pure black, like a masked-out area, a black frame or padding.
      g.fillStyle = '#000';
      g.fillRect(W - PHOTO_BLACK_COLS, 0, PHOTO_BLACK_COLS, H);
    }
  }
  return g.getImageData(0, 0, W, H);
}

/** Panoptic quality between two label images (IoU > 0.5 matching); 1.0 = identical. */
function pq(a: Int32Array, b: Int32Array): { pq: number; unmatched: number } {
  const areaA = new Map<number, number>();
  const areaB = new Map<number, number>();
  const inter = new Map<string, number>();
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x) areaA.set(x, (areaA.get(x) ?? 0) + 1);
    if (y) areaB.set(y, (areaB.get(y) ?? 0) + 1);
    if (x && y) inter.set(`${x},${y}`, (inter.get(`${x},${y}`) ?? 0) + 1);
  }
  let sum = 0;
  let tp = 0;
  for (const [k, v] of inter) {
    const [x, y] = k.split(',').map(Number) as [number, number];
    const iou = v / (areaA.get(x)! + areaB.get(y)! - v);
    if (iou > 0.5) {
      sum += iou;
      tp++;
    }
  }
  const fp = areaB.size - tp;
  const fn = areaA.size - tp;
  return { pq: tp + fp + fn === 0 ? 1 : sum / (tp + 0.5 * fp + 0.5 * fn), unmatched: fp + fn };
}

interface CaseResult {
  case: CaseName;
  size: string;
  webgpuSeconds?: number;
  wasmSeconds?: number;
  webgpuError?: string;
  wasmError?: string;
  nonFiniteWebgpu?: number;
  maxAbsDiffFlow?: number;
  maxAbsDiffCellprob?: number;
  meanAbsDiffCellprob?: number;
  cellprobSignAgreementPct?: number;
  grainsWebgpu?: number;
  grainsWasm?: number;
  maskPQ?: number;
  unmatchedGrains?: number;
  blankArea?: { pixels: number; signAgreementPct: number; gpuGrainPixels: number; cpuGrainPixels: number; cpuMeanCellprob: number; gpuMeanCellprob: number };
  verdict?: CaseVerdict;
}

async function runAll(kind: Kind): Promise<void> {
  const runBtn = $<HTMLButtonElement>('run');
  runBtn.disabled = true;
  $('results').innerHTML = '';
  logEl().innerHTML = '';
  $('report-actions').hidden = true;
  const report: Record<string, unknown> = {
    tool: 'webGrainy GPU check',
    appVersion: APP_VERSION,
    ortVersion: ORT_VERSION,
    date: new Date().toISOString(),
    model: kind,
    modelId: KIND_MODEL[kind],
    userAgent: navigator.userAgent,
    crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
  try {
    const caps = await probeWebGpuCapabilities();
    let adapterInfo: Record<string, unknown> | null = null;
    const gpu = (navigator as { gpu?: { requestAdapter: () => Promise<{ info?: Record<string, string> } | null> } }).gpu;
    if (gpu) {
      const a = await gpu.requestAdapter();
      if (a?.info) adapterInfo = { vendor: a.info['vendor'], architecture: a.info['architecture'], device: a.info['device'], description: a.info['description'] };
    }
    report['webgpu'] = { adapter: caps.hasAdapter, shaderF16: caps.hasShaderF16, adapterInfo };
    log(`WebGPU adapter: ${caps.hasAdapter ? 'yes' : 'no'}; float16 shaders (shader-f16): ${caps.hasShaderF16 ? 'yes' : 'no'}`);
    if (adapterInfo) log(`GPU: ${[adapterInfo['vendor'], adapterInfo['architecture'], adapterInfo['device'], adapterInfo['description']].filter(Boolean).join(' / ')}`);
    if (!caps.hasAdapter) {
      setStatus('No WebGPU adapter: this browser/computer cannot run the GPU path, so there is nothing to compare. Try Chrome or Edge with hardware acceleration enabled.');
      return;
    }
    if (kind !== 'unet' && !caps.hasShaderF16) {
      log('Note: without shader-f16 the app never uses the GPU for Cellpose-SAM (it uses the CPU). Running anyway to show what would happen.');
    }

    const modelId: ModelId = KIND_MODEL[kind];
    setStatus('Downloading / loading the model (cached after the first time)…');
    const bytes = new Uint8Array(
      await getModel(modelId, {
        onProgress: (p) => setStatus(`Downloading model: ${p.percent.toFixed(0)}% of ${(p.totalBytes / 1e6).toFixed(0)} MB`),
      }),
    );
    log(`Model ${modelId} loaded and SHA-256 verified (${(bytes.byteLength / 1e6).toFixed(0)} MB).`);
    const run = kind === 'unet' ? runUnetCellposeInference : runCpsamCellposeInference;
    const images = CASES.map((c) => [c, makeImage(c)] as const);
    const outputs: Record<'webgpu' | 'wasm', Partial<Record<CaseName, InferenceOutput>>> = { webgpu: {}, wasm: {} };
    const results: CaseResult[] = images.map(([c, img]) => ({ case: c, size: `${img.width}×${img.height}` }));

    // Run each backend in turn (one model copy in memory at a time).
    for (const backend of ['webgpu', 'wasm'] as const) {
      setStatus(`Creating ${backend === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)'} session…`);
      const created = await createInferenceSession(bytes, {
        wasmPaths: './ort/',
        ...(backend === 'wasm' ? { forceWasm: true } : {}),
      });
      if (backend === 'webgpu' && created.executionProvider !== 'webgpu') {
        log('Could not create a WebGPU session for this model; the GPU column below is not a GPU result.');
      }
      report[`${backend}Provider`] = created.executionProvider;
      for (let i = 0; i < images.length; i++) {
        const [c, img] = images[i]!;
        const rec = results[i]!;
        setStatus(`${backend === 'webgpu' ? 'GPU' : 'CPU'}: ${CASE_LABEL[c]}…`);
        const t0 = performance.now();
        try {
          outputs[backend][c] = await run(created.session, img.data, img.width, img.height, {
            onProgress: (p) => setStatus(`${backend === 'webgpu' ? 'GPU' : 'CPU'}: ${CASE_LABEL[c]} – tile ${p.completedTiles}/${p.totalTiles}`),
          });
          const sec = +((performance.now() - t0) / 1000).toFixed(2);
          if (backend === 'webgpu') rec.webgpuSeconds = sec;
          else rec.wasmSeconds = sec;
          log(`${backend === 'webgpu' ? 'GPU' : 'CPU'} ${CASE_LABEL[c]}: ${sec} s`);
        } catch (e) {
          const msg = String(e).slice(0, 400);
          if (backend === 'webgpu') rec.webgpuError = msg;
          else rec.wasmError = msg;
          log(`${backend === 'webgpu' ? 'GPU' : 'CPU'} ${CASE_LABEL[c]}: ERROR ${msg}`);
        }
      }
      await created.session.release?.().catch(() => undefined);
    }

    // Compare.
    for (let i = 0; i < images.length; i++) {
      const [c, img] = images[i]!;
      const rec = results[i]!;
      const g = outputs.webgpu[c];
      const w = outputs.wasm[c];
      if (!g || !w) {
        rec.verdict = 'error';
        continue;
      }
      const n = img.width * img.height;
      let nonFinite = 0;
      let maxFlow = 0;
      let maxCp = 0;
      let sumCp = 0;
      let agree = 0;
      for (let k = 0; k < n; k++) {
        const vals = [g.flowY[k]!, g.flowX[k]!, g.cellprob[k]!];
        if (!vals.every(Number.isFinite)) {
          nonFinite++;
          continue;
        }
        maxFlow = Math.max(maxFlow, Math.abs(g.flowY[k]! - w.flowY[k]!), Math.abs(g.flowX[k]! - w.flowX[k]!));
        const dc = Math.abs(g.cellprob[k]! - w.cellprob[k]!);
        maxCp = Math.max(maxCp, dc);
        sumCp += dc;
        if ((g.cellprob[k]! > 0) === (w.cellprob[k]! > 0)) agree++;
      }
      const mg = flowsToMasksBrowser(g.flowY, g.flowX, g.cellprob, img.width, img.height);
      const mw = flowsToMasksBrowser(w.flowY, w.flowX, w.cellprob, img.width, img.height);
      rec.nonFiniteWebgpu = nonFinite;
      rec.maxAbsDiffFlow = +maxFlow.toPrecision(3);
      rec.maxAbsDiffCellprob = +maxCp.toPrecision(3);
      rec.meanAbsDiffCellprob = +(sumCp / n).toPrecision(3);
      rec.cellprobSignAgreementPct = +((100 * agree) / n).toFixed(2);
      rec.grainsWebgpu = mg.grainCount;
      rec.grainsWasm = mw.grainCount;
      const q = pq(mw.masks, mg.masks);
      rec.maskPQ = +q.pq.toFixed(3);
      rec.unmatchedGrains = q.unmatched;
      const blank = blankRegion(c, img.width, img.height);
      if (blank) {
        let px = 0, agreeB = 0, gpx = 0, cpx = 0, sg = 0, sc = 0;
        for (let k = 0; k < n; k++) {
          if (!blank[k]) continue;
          px++;
          if ((g.cellprob[k]! > 0) === (w.cellprob[k]! > 0)) agreeB++;
          if (mg.masks[k]) gpx++;
          if (mw.masks[k]) cpx++;
          sg += g.cellprob[k]!;
          sc += w.cellprob[k]!;
        }
        rec.blankArea = {
          pixels: px,
          signAgreementPct: +((100 * agreeB) / px).toFixed(2),
          gpuGrainPixels: gpx,
          cpuGrainPixels: cpx,
          cpuMeanCellprob: +(sc / px).toFixed(3),
          gpuMeanCellprob: +(sg / px).toFixed(3),
        };
      }
      rec.verdict = classifyCase({
        nonFiniteWebgpu: nonFinite,
        maskPQ: rec.maskPQ,
        unmatchedGrains: q.unmatched,
        cellprobSignAgreementPct: rec.cellprobSignAgreementPct,
        ...(rec.blankArea ? { blank: { signAgreementPct: rec.blankArea.signAgreementPct, gpuGrainPixels: rec.blankArea.gpuGrainPixels, cpuGrainPixels: rec.blankArea.cpuGrainPixels, pixels: rec.blankArea.pixels } } : {}),
      });
    }
    report['cases'] = results;
    renderResults(results, kind, report);
  } catch (e) {
    report['error'] = String(e);
    setStatus(`Check failed: ${String(e).slice(0, 300)}`);
  } finally {
    runBtn.disabled = false;
    (window as unknown as { __gpuCheckReport?: unknown }).__gpuCheckReport = report;
    const json = JSON.stringify(report, null, 2);
    $<HTMLTextAreaElement>('report-json').value = json;
    $('report-actions').hidden = false;
  }
}

function renderResults(results: CaseResult[], kind: Kind, report: Record<string, unknown>): void {
  const rows = results
    .map((r) => {
      const badge =
        r.verdict === 'ok'
          ? '<span class="ok">✓ matches CPU</span>'
          : r.verdict === 'numeric'
            ? '<span class="warn">⚠ same grains; wrong numbers on black area</span>'
            : r.verdict === 'differs'
              ? '<span class="bad">✗ differs</span>'
              : '<span class="bad">error</span>';
      const err = r.webgpuError ?? r.wasmError;
      return `<tr>
        <td>${CASE_LABEL[r.case]}</td>
        <td>${badge}</td>
        <td>${r.maskPQ ?? '–'}</td>
        <td>${r.grainsWebgpu ?? '–'} / ${r.grainsWasm ?? '–'}</td>
        <td>${r.cellprobSignAgreementPct ?? '–'}%${r.blankArea ? ` (black area: ${r.blankArea.signAgreementPct}%)` : ''}</td>
        <td>${r.nonFiniteWebgpu ?? '–'}</td>
        <td>${r.webgpuSeconds ?? '–'} / ${r.wasmSeconds ?? '–'}</td>
        <td class="err">${err ? escapeHtml(err.slice(0, 160)) : ''}</td>
      </tr>`;
    })
    .join('');
  $('results').innerHTML = `<table>
    <thead><tr><th>Case</th><th>Result</th><th>Mask agreement (1.0 = identical)</th><th>Grains GPU / CPU</th><th>Cell-probability sign agreement</th><th>Invalid GPU values</th><th>Seconds GPU / CPU</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  const verdict = overallVerdict(
    results.map((r) => ({ case: r.case, verdict: r.verdict, hasBlankArea: r.case === 'all-black' || r.case === 'photo-black' })),
    KIND_LABEL[kind],
  );
  report['verdict'] = verdict;
  setStatus(verdict);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function init(): void {
  $('run').addEventListener('click', () => {
    const kind = ($<HTMLSelectElement>('model').value as Kind) ?? 'cpsam';
    void runAll(kind);
  });
  $('download').addEventListener('click', () => {
    const blob = new Blob([$<HTMLTextAreaElement>('report-json').value], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `webgrainy_gpucheck_${$<HTMLSelectElement>('model').value}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('copy').addEventListener('click', () => {
    void navigator.clipboard?.writeText($<HTMLTextAreaElement>('report-json').value).then(
      () => setStatus('Report copied to the clipboard.'),
      () => setStatus('Copy failed: select the text below and copy it manually.'),
    );
  });
  // Use the app's service worker (cross-origin isolation => multi-threaded CPU side).
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    void navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => undefined);
  }
  $('env').textContent = `webGrainy ${APP_VERSION} · ONNX Runtime ${ORT_VERSION} · ${self.crossOriginIsolated ? `${navigator.hardwareConcurrency} CPU threads` : '1 CPU thread (reload the page for multi-threaded CPU)'}`;
}

init();
