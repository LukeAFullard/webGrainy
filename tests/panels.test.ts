import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import { ScaleCalibrator } from '../src/modules/interactiveEditor.js';
import type { PhotoRecord, SiteRecord } from '../src/modules/projectStorage.js';
import { computeWorkspaceReports } from '../src/modules/siteWorkspace.js';
import { createInitialState, type AppState } from '../src/ui/state.js';
import { renderTopbarHtml } from '../src/ui/panels/topbar.js';
import { renderSidebarHtml, faciesSharePct, backupLineHtml, formatBytes, retentionBannerHtml, type SidebarView } from '../src/ui/panels/sidebar.js';
import { renderToolbarHtml } from '../src/ui/panels/toolbar.js';
import { renderDownloadResultsModalHtml, renderExportModalHtml } from '../src/ui/modals.js';
import { histogramBasis, renderDashboardHtml } from '../src/ui/panels/dashboard.js';
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
    expect(html).toContain('Runs on Your Device');
    expect(html).toContain('No External Server');
    expect(html).toContain('ONNX-converted and quantized');
    expect(html).toContain('Quantized ONNX INT8');
    expect(html).toContain('data-help="calibrate"');
    expect(html).not.toContain('ig2_cpsam_fp16.onnx');
    expect(html).not.toContain('Zero Uploads');
    expect(html).not.toContain('SHA-256 Pinned');
    expect(html).not.toContain('2.87%');
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
    expect(html).toContain('Results downloaded: never');
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
    const line = backupLineHtml(analysedState(), 2, null);
    expect(line).toContain('data-action="open-download-results"');
    expect(line).toMatch(/Stored in this browser until/);
    expect(line).toContain('data-action="keep-site-longer"');
    const empty = backupLineHtml(emptyState(), 0, null);
    expect(empty).toContain('id="retention-days"');
    expect(empty).not.toContain('open-download-results');
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

  it('toolbar: Tidy outlines only once the photo is analysed', () => {
    expect(renderToolbarHtml({ ...analysedState(), sessions: new Map() }).toolbar).not.toContain('data-action="tidy-outlines"');
    const html = renderToolbarHtml(analysedState()).toolbar;
    expect(html).toContain('data-action="tidy-outlines"');
    expect(html).toContain('data-help="tidyOutlines"');
  });

  it('toolbar: Undo rectify only for a rectified photo', () => {
    const st = analysedState();
    expect(renderToolbarHtml(st).toolbar).not.toContain('data-action="rectify-undo"');
    const rectified = {
      ...st,
      photos: st.photos.map((p) => (p.photoId === 'p1' ? { ...p, rectifyBackup: { imageBlob: new Blob(['o']), width: 120, height: 80 } } : p)),
    };
    expect(renderToolbarHtml(rectified).toolbar).toContain('data-action="rectify-undo"');
  });

  it('toolbar: ROI tool, and Clear areas once the photo has an ROI or exclusion', () => {
    const st = analysedState();
    expect(renderToolbarHtml(st).toolbar).toContain('data-tool="roiPoly"');
    const roi = renderToolbarHtml({ ...st, activeTool: 'roiPoly' });
    expect(roi.toolbar).toContain('data-action="finish-shape"');
    expect(roi.toolbar).not.toContain('data-action="clear-areas"');
    const withRoi = {
      ...st,
      activeTool: 'roiPoly' as const,
      photos: st.photos.map((p) => (p.photoId === 'p1' ? { ...p, roiConfig: { roiPolygon: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], exclusionPolygons: [], exclusionStrokes: [] } } : p)),
    };
    expect(renderToolbarHtml(withRoi).toolbar).toContain('data-action="clear-areas"');
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

  it('dashboard: a photo with no counted grains shows dashes, never NaN', () => {
    const base = analysedState();
    const st0 = { ...base, siteOptions: { ...base.siteOptions, minBaxisPx: 1e6 } };
    const st = { ...st0, ...computeWorkspaceReports(st0) };
    for (const scope of ['photo', 'site'] as const) {
      const charts: ChartRegistry = new Map();
      const html = renderDashboardHtml({ ...st, dashboardScope: scope, dashboardTab: 'psd' }, { lightTheme: true, charts });
      expect(html, scope).not.toContain('NaN');
      for (const c of charts.values()) expect(c.render(true), scope).not.toContain('NaN');
    }
  });

  it('photo view: the detection limit shown is the cutoff applied, raised by the site cutoff (audit S1)', () => {
    const base = emptyState();
    const cal = (mmPerPx: number) => ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 100 * mmPerPx, 'mm');
    const s1 = session();
    const s2 = session();
    s1.setCalibration(cal(0.9)); // own limit 15 px x 0.9 = 13.5 mm
    s2.setCalibration(cal(1)); // 15 mm: sets the site's common cutoff
    const st0: AppState = {
      ...base,
      photos: [{ ...photo('p1', 'fine.jpg'), calibration: cal(0.9) }, { ...photo('p2', 'coarse.jpg'), calibration: cal(1) }],
      activePhotoId: 'p1',
      sessions: new Map([['p1', s1], ['p2', s2]]),
      photoStatuses: new Map([['p1', 'done'], ['p2', 'done']] as const),
    };
    const st = { ...st0, ...computeWorkspaceReports(st0) };
    const html = renderDashboardHtml({ ...st, dashboardScope: 'photo', dashboardTab: 'psd' }, { lightTheme: true, charts: new Map() });
    expect(html).toMatch(/Smallest grain kept \(detection limit\): <strong>~15\.0 mm<\/strong>/);
    expect(html).toContain('this photo alone resolves ~13.5 mm');
    expect(html).toContain('common cutoff');
  });

  it('dashboard labels follow the data shown (audit S7)', () => {
    const px = analysedState(); // uncalibrated: sizes in px
    const psd = renderDashboardHtml({ ...px, dashboardScope: 'photo', dashboardTab: 'psd' }, { lightTheme: true, charts: new Map() });
    expect(psd).not.toContain('data-psd-x="phi"'); // no φ axis without mm
    expect(psd).toContain('pooling applies to Whole site');
    const cal = ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 100, 'mm');
    const s1 = session();
    const s2 = session();
    s1.setCalibration(cal);
    s2.setCalibration(cal);
    const st0: AppState = {
      ...px,
      photos: px.photos.map((p) => ({ ...p, calibration: cal })),
      sessions: new Map([['p1', s1], ['p2', s2]]),
    };
    const st = { ...st0, ...computeWorkspaceReports(st0) };
    expect(st.siteReportError).toBeNull();
    expect(renderDashboardHtml({ ...st, dashboardScope: 'photo', dashboardTab: 'psd' }, { lightTheme: true, charts: new Map() })).toContain('data-psd-x="phi"');
    const shape = renderDashboardHtml({ ...st, dashboardScope: 'site', dashboardTab: 'shape' }, { lightTheme: true, charts: new Map() });
    expect(shape).toContain(`n = ${st.siteReport!.shape.n}`);
    const adequacy = renderDashboardHtml({ ...st, dashboardScope: 'photo', dashboardTab: 'adequacy' }, { lightTheme: true, charts: new Map() });
    expect(adequacy).toContain('property of the whole site');
    expect(histogramBasis('number-weighted')).toBe('% by grain count');
    expect(histogramBasis('virtual-wolman-grid')).toBe('% of grid points');
    expect(histogramBasis('physical-area')).toBe('area-weighted %');
  });

  it('compare view: loading, error and result states', () => {
    const st = { ...analysedState(), dashboardScope: 'compare' as const };
    expect(renderCompareHtml({ ...st, comparison: { loading: true, sites: [], error: null } }, true, new Map())).toMatch(/Loading|loading/);
    expect(renderCompareHtml({ ...st, comparison: { loading: false, sites: [], error: 'disk full' } }, true, new Map())).toContain('disk full');
    const html = renderCompareHtml({ ...st, comparison: null }, true, new Map());
    expect(html).toContain('Rakaia &lt;reach&gt; 3');
  });

  it('shows mm/px (px/mm) scale readout, Wentworth/cutoff legends, Min Size mm², and export disabled reason', () => {
    const base = analysedState();
    const cal = { pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 50, pixelDistance: 100, mmPerPx: 0.5 };
    const st = {
      ...base,
      photos: base.photos.map((p, i) => (i === 0 ? { ...p, calibration: cal } : p)),
    };
    const tb = renderToolbarHtml(st);
    expect(tb.subToolbar).toContain('0.500 mm/px');
    expect(tb.subToolbar).toContain('2.00 px/mm');
    expect(tb.subToolbar).toContain('Touches photo edge');
    expect(tb.subToolbar).toContain('Below size cutoff');
    expect(tb.subToolbar).toContain('Cobble 64–256');

    const sb = renderSidebarHtml(st, {
      guideHtml: '',
      settingsOpen: true,
      cpuThreadPref: 'auto',
      cpuThreads: 4,
      crossOriginIsolated: false,
      canNotify: false,
      notifyWhenDone: false,
      storageInfo: null,
    });
    expect(sb).toContain('data-min-size-mm2');
    expect(sb).toContain('Min Size (mm²)');

    const expErr = renderExportModalHtml({ ...st, siteReport: null, siteReportError: 'Mixed calibration across photos' });
    expect(expErr).toContain('Site exports unavailable: Mixed calibration across photos');
  });
});

describe('browser storage notices', () => {
  const DAY = 86_400_000;
  const mk = (siteId: string, name: string, t: number): SiteRecord => ({ siteId, name, createdAt: t, updatedAt: t, options: { poolingMode: 'physical-area' }, photoOrder: [] });
  it('explains storage, reports removals, and warns about sites due within 3 days', () => {
    const now = Date.now();
    const st: AppState = {
      ...createInitialState(),
      retentionDays: 30,
      activeSiteId: 'a',
      sites: [mk('a', 'Open site', now - 28 * DAY), mk('b', 'Other site', now - 29 * DAY), mk('c', 'Fresh', now)],
      retentionNotice: 'Removed from this browser after 30 days without use: Old (results never downloaded).',
    };
    const html = retentionBannerHtml(st, now, 0);
    expect(html).toContain('kept in this browser for up to 30 days');
    expect(html).toContain('Removed from this browser after 30 days');
    expect(html).toMatch(/Open site: .*\(in 2 days\)/);
    expect(html).toMatch(/Other site: .*\(within a day\)/);
    expect(html).not.toContain('Fresh');
    expect(html).toContain('data-action="keep-site-longer"'); // for the open site
    expect(html).toContain('data-action="open-site" data-site-id="b"'); // other sites: open them first
  });

  it('retention banner: expired sites with un-downloaded work are listed to open or remove', () => {
    const mk = (siteId: string, name: string): SiteRecord => ({ siteId, name, createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: [] });
    const st: AppState = { ...createInitialState(), retentionDays: 30, sites: [mk('k', 'Kept <reach>'), mk('x', 'Other')], retentionHeld: ['k'] };
    const html = retentionBannerHtml(st, Date.now(), Date.now());
    expect(html).toContain('results were never downloaded');
    expect(html).toContain('Kept &lt;reach&gt;');
    expect(html).toContain('data-action="open-site" data-site-id="k"');
    expect(html).toContain('data-action="remove-held-site" data-site-id="k"');
    expect(html).not.toContain('data-site-id="x"');
  });

  it('download dialog: project file off by default, with a warning either way', () => {
    const base = analysedState();
    const off = renderDownloadResultsModalHtml(base);
    expect(off).toMatch(/id="download-include-project"(?![^>]*checked)/);
    expect(off).toContain('cannot be reopened in webGrainy');
    const on = renderDownloadResultsModalHtml({ ...base, downloadIncludeProject: true });
    expect(on).toMatch(/id="download-include-project"[^>]*checked/);
    expect(on).toContain('GPS locations');
  });
});

describe('facies weights', () => {
  it("each photo's share is its weight over the included photos' total (audit S4)", () => {
    const riffle = [0, 1, 2, 3].map((i) => ({ photoId: `r${i}`, included: true, faciesWeight: 0.7 }));
    const pool = { photoId: 'p', included: true, faciesWeight: 0.3 };
    // Every riffle photo at 0.7, as the old help suggested: the pool is only ~10% of the site.
    expect(faciesSharePct([...riffle, pool], pool)).toBeCloseTo(9.68, 1);
    // Riffle share divided among its 4 photos: the pool is 30%.
    const riffle2 = riffle.map((r) => ({ ...r, faciesWeight: 0.175 }));
    expect(faciesSharePct([...riffle2, pool], pool)).toBeCloseTo(30, 6);
    expect(faciesSharePct([...riffle2, { ...pool, included: false }], { ...pool, included: false })).toBeNull();
    expect(faciesSharePct([{ photoId: 'a', included: true }, { photoId: 'b', included: true }], { photoId: 'a', included: true })).toBe(50);
  });
});

describe('accessibility', () => {
  it('the workspace has one level-one heading; the landing page keeps its own (audit N11)', () => {
    const work = renderTopbarHtml({ ...createInitialState(), showLanding: false }, { gpuReset: false, cpuThreads: 4 } as never);
    expect(work.match(/<h1\b/g)?.length).toBe(1);
    const landing = renderTopbarHtml({ ...createInitialState(), showLanding: true }, { gpuReset: false, cpuThreads: 4 } as never);
    expect(landing).not.toContain('<h1');
  });
});
