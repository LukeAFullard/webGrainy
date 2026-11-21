/** Top bar: brand, engine status chip, offline badge and the dialog buttons. */
import type { AppState } from '../state.js';
import { esc } from './html.js';

export interface TopbarView {
  /** The GPU was reset during this visit and the CPU is used until reload. */
  gpuReset: boolean;
  /** CPU threads the runtime uses (undefined = runtime default). */
  cpuThreads: number | undefined;
}

export function renderTopbarHtml(state: AppState, view: TopbarView): string {
  const caps = state.capabilities;
  const gpuLabel = view.gpuReset
    ? 'GPU reset · CPU mode (reload for GPU)'
    : caps
    ? caps.hasWebGPU
      ? caps.hasShaderF16 === true
        ? 'WebGPU FP16'
        : caps.hasShaderF16 === false
          ? 'WebGPU (No FP16)'
          : 'WebGPU Ready'
      : `${caps.hasWasmSimd ? 'WASM SIMD' : 'WASM Basic'} · ${
          view.cpuThreads ?? 1
        } CPU thread${(view.cpuThreads ?? 1) === 1 ? '' : 's'}`
    : 'Initializing…';
  const swLabel =
    state.swStatus === 'ready'
      ? 'SW Offline Ready'
      : state.swStatus === 'registering'
        ? 'SW Registering'
        : 'SW Local/File';

  // One compact engine chip (details on hover/long-press), plus Offline only when offline.
  const engineShort = view.gpuReset
    ? 'CPU (GPU reset)'
    : caps
      ? caps.hasWebGPU && caps.hasShaderF16 !== false
        ? 'GPU'
        : `CPU · ${view.cpuThreads ?? 1} thread${(view.cpuThreads ?? 1) === 1 ? '' : 's'}`
      : 'Starting…';
  const engineTitle = `Engine: ${gpuLabel}. ${swLabel.replace('SW', 'Offline cache:')}. ${state.isOnline ? 'Online' : 'Offline'}.`;
  return `
    <div class="topbar-left">
      <div class="brand">
        ${state.showLanding ? '<span>webGrainy</span>' : '<h1 class="brand-title">webGrainy<span class="sr-only"> workspace</span></h1>'}
        <span class="brand-sub">Grain sizes from photos · runs on your device</span>
      </div>
    </div>
    <div class="topbar-center">
      <span class="status-pill ${caps?.hasWebGPU || caps?.hasWasmSimd ? 'ok' : ''}" title="${esc(engineTitle)}">
        <span class="dot" aria-hidden="true"></span>${esc(engineShort)}<span class="sr-only"> — ${esc(engineTitle)}</span>
      </span>
      ${state.isOnline ? '' : `<span class="status-pill warn" title="Analysis still works with models already downloaded."><span class="dot" aria-hidden="true"></span>Offline</span>`}
    </div>
    <div class="topbar-right">
      <button type="button" class="btn btn-sm" data-action="show-landing">Overview</button>
      <button type="button" class="btn btn-sm" data-open-modal="models">Models</button>
      <button type="button" class="btn btn-sm" data-open-modal="export">Export</button>
      <button type="button" class="btn btn-sm" data-open-help="">Help</button>
      <button type="button" class="btn btn-sm" data-open-modal="about">About</button>
    </div>
  `;
}
