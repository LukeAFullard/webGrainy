import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import type { PhotoRecord, SiteRecord } from '../src/modules/projectStorage.js';
import { computeWorkspaceReports } from '../src/modules/siteWorkspace.js';
import { createInitialState, type AppState } from '../src/ui/state.js';
import { renderTopbarHtml } from '../src/ui/panels/topbar.js';
import { renderSidebarHtml, backupLineHtml, formatBytes, type SidebarView } from '../src/ui/panels/sidebar.js';
import { renderToolbarHtml } from '../src/ui/panels/toolbar.js';
import { renderDashboardHtml } from '../src/ui/panels/dashboard.js';
import { renderCompareHtml } from '../src/ui/panels/compare.js';
import {
  renderLandingHtml,
  renderWorkflowSectionHtml,
  isWorkflowStepId,
  nextWorkflowStepForKey,
  WORKFLOW_STEP_ORDER,
} from '../src/ui/panels/landing.js';
import { esc, type ChartRegistry } from '../src/ui/panels/html.js';

function session(): AnalysisSession {
  const w = 120, h = 80;
  const masks = new Int32Array(w * h);
  let id = 0;
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 5; gx++) {
    id++;
    for (let y = 8 + gy * 24; y < 26 + gy * 24; y++) for (let x = 6 + gx * 22; x < 26 + gx * 22; x++) masks[y * w + x] = id;
  }
  return new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: 'full' } as never,
    recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
    masks,
    workingGrains: computeGrainMorphometrics(masks, w, h, 2),
    provenance: { appVersion: 't', ortVersion: 't', analyzedAt: '2026-01-01T00:00:00Z', modelId: 'ig2_unet_fp32', modelFile: 'x', modelRevision: 'r', modelSha256: 's' },
  });
}

const site: SiteRecord = { siteId: 's1', name: 'Rakaia <reach> 3', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p1', 'p2'] } as SiteRecord;
const photo = (photoId: string, label: string): PhotoRecord => ({ photoId, siteId: 's1', label, imageBlob: new Blob(['x']), width: 120, height: 80, addedAt: 0, included: true });

const sidebarView: SidebarView = {
  guideHtml: '<div class="guide">GUIDE</div>',
  settingsOpen: false,
  cpuThreadPref: 'auto',
  cpuThreads: 3,
  crossOriginIsolated: true,
  canNotify: true,
  notifyWhenDone: false,
  storageInfo: { usage: 37e6, quota: 4.3e9, persisted: false },
};

function emptyState(): AppState {
  return { ...createInitialState(), sites: [site], activeSiteId: 's1' };
}

function analysedState(): AppState {
  const base = emptyState();
  const st: AppState = {
    ...base,
    photos: [photo('p1', 'IMG_1.jpg'), photo('p2', 'IMG_2.jpg')],
    activePhotoId: 'p1',
    sessions: new Map([['p1', session()], ['p2', session()]]),
    photoStatuses: new Map([['p1', 'done'], ['p2', 'done']] as const),
    thumbUrls: new Map([['p1', 'blob:1'], ['p2', 'blob:2']]),
  };
  return { ...st, ...computeWorkspaceReports(st) };
}

describe('panel renderers', () => {
  it('escapes HTML', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('topbar shows the engine state', () => {
    const st = emptyState();
    expect(renderTopbarHtml(st, { gpuReset: false, cpuThreads: 3 })).toContain('Starting…');
    expect(renderTopbarHtml(st, { gpuReset: false, cpuThreads: 3 })).toContain('data-action="show-landing"');
    const cpu = renderTopbarHtml({ ...st, capabilities: { hasWebGPU: false, hasWasmSimd: true } as never }, { gpuReset: false, cpuThreads: 3 });
    expect(cpu).toContain('CPU · 3 threads');
    expect(renderTopbarHtml({ ...st, capabilities: { hasWebGPU: true, hasShaderF16: true } as never }, { gpuReset: true, cpuThreads: 3 })).toContain('CPU (GPU reset)');
    expect(renderTopbarHtml({ ...st, isOnline: false }, { gpuReset: false, cpuThreads: 1 })).toContain('Offline');
  });

  it('landing page renders workflow tabs, capabilities, models table and runtime status', () => {
    expect(isWorkflowStepId('calibrate')).toBe(true);
    expect(isWorkflowStepId('export')).toBe(true);
    expect(isWorkflowStepId('unknown')).toBe(false);
    expect(isWorkflowStepId(undefined)).toBe(false);

    expect(nextWorkflowStepForKey('calibrate', 'ArrowRight')).toBe('exclude');
    expect(nextWorkflowStepForKey('calibrate', 'ArrowLeft')).toBe('export');
    expect(nextWorkflowStepForKey('segment', 'Home')).toBe('calibrate');
    expect(nextWorkflowStepForKey('segment', 'End')).toBe('export');
    expect(nextWorkflowStepForKey('segment', 'Enter')).toBeNull();

    for (const step of WORKFLOW_STEP_ORDER) {
      const wf = renderWorkflowSectionHtml(step);
      expect(wf).toContain(`id="wf-tab-${step}"`);
      expect(wf).toContain('focusgroup="tablist nomemory"');
      expect(wf).toContain('hidden="until-found"');
    }

    const st = analysedState();
    const html = renderLandingHtml(
      { ...st, landingStep: 'segment', swStatus: 'ready', capabilities: { hasWebGPU: true, hasShaderF16: true, cachedModels: ['ig2_unet_fp32'] } as never },
      { gpuReset: false, cpuThreads: 4, skipLanding: true },
    );
    expect(html).toContain('WebGPU FP16 Ready');
    expect(html).toContain('Offline Ready');
    expect(html).toContain('Resume Workspace (2 photos)');
    expect(html).toContain('Models (1)');
    expect(html).toContain('ig2_cpsam_fp16.onnx');
    expect(html).toContain('data-landing-skip=""');
    expect(html).toContain('checked');
  });

  it('sidebar: empty site', () => {
    const html = renderSidebarHtml(emptyState(), sidebarView);
    expect(html).toContain('GUIDE');
    expect(html).toContain('Rakaia &lt;reach&gt; 3 (2)');
    expect(html).toContain('Photos (0');
    expect(html).not.toMatch(/<button[^>]*data-export="site-archive"/); // nothing to back up yet
    expect(html).toContain('Browser storage: 37 MB used of 4.3 GB');
  });

  it('sidebar: analysing, analysed and errors', () => {
    const analysed = analysedState();
    const html = renderSidebarHtml(analysed, sidebarView);
    expect(html).toContain('2 analysed');
    expect(html).toContain('IMG_1.jpg');
    expect(html).toContain('Last backed up: never');
    const running = renderSidebarHtml({ ...analysed, batchRunning: true, photoStatuses: new Map([['p1', 'running'], ['p2', 'pending']] as const) }, sidebarView);
    expect(running).toMatch(/data-action="cancel-batch"|Cancel/);
    expect(running).toMatch(/data-action="run-active"[^>]*disabled/);
    const failed = renderSidebarHtml({ ...analysed, photoStatuses: new Map([['p1', 'done'], ['p2', 'error']] as const), photoErrors: new Map([['p2', 'out of memory']]) }, sidebarView);
    expect(failed).toContain('out of memory');
    const noThreads = renderSidebarHtml(analysed, { ...sidebarView, crossOriginIsolated: false, canNotify: false });
    expect(noThreads).toContain('Multi-threading is unavailable');
    expect(noThreads).not.toContain('data-notify-done');
  });

  it('backup line and byte formatting', () => {
    expect(formatBytes(1.5e9)).toBe('1.5 GB');
    expect(formatBytes(37e6)).toBe('37 MB');
    expect(formatBytes(2e3)).toBe('2 kB');
    expect(backupLineHtml(analysedState(), 2, null)).toContain('needs-backup');
    expect(backupLineHtml(emptyState(), 0, null)).toBe('');
  });

  it('toolbar: grain-editing tools only once the photo has results', () => {
    const before = renderToolbarHtml({ ...analysedState(), sessions: new Map() });
    expect(before.toolbar).toContain('data-tool="calibrate"');
    expect(before.toolbar).not.toContain('data-tool="split"');
    const after = renderToolbarHtml(analysedState());
    expect(after.toolbar).toContain('data-tool="split"');
    expect(after.subToolbar).toContain('Display');
    const cal = renderToolbarHtml({ ...analysedState(), activeTool: 'calibrate' });
    expect(cal.subToolbar).not.toBe(after.subToolbar);
  });

  it('dashboard: every tab for this photo and the whole site registers its charts', () => {
    const st = analysedState();
    for (const scope of ['photo', 'site'] as const) {
      for (const tab of ['psd', 'adequacy', 'shape', 'fabric'] as const) {
        const charts: ChartRegistry = new Map();
        const html = renderDashboardHtml({ ...st, dashboardScope: scope, dashboardTab: tab }, { lightTheme: true, charts });
        expect(html, `${scope}/${tab}`).toContain(`aria-labelledby="tab-${tab}"`);
        for (const id of charts.keys()) expect(html).toContain(`data-chart-dl="${id}"`);
        if (tab === 'psd') expect(charts.size).toBeGreaterThan(0);
        for (const c of charts.values()) expect(c.render(true)).toMatch(/^<svg/);
      }
    }
    const empty = renderDashboardHtml({ ...emptyState(), dashboardScope: 'site' }, { lightTheme: false, charts: new Map() });
    expect(empty).toContain('Add &amp; analyze photos');
  });

  it('compare view: loading, error and result states', () => {
    const st = { ...analysedState(), dashboardScope: 'compare' as const };
    expect(renderCompareHtml({ ...st, comparison: { loading: true, sites: [], error: null } }, true, new Map())).toMatch(/Loading|loading/);
    expect(renderCompareHtml({ ...st, comparison: { loading: false, sites: [], error: 'disk full' } }, true, new Map())).toContain('disk full');
    const html = renderCompareHtml({ ...st, comparison: null }, true, new Map());
    expect(html).toContain('Rakaia &lt;reach&gt; 3');
  });
});
