import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToolbarHtml } from '../src/ui/panels/toolbar.js';
import type { SiteRecord } from '../src/modules/projectStorage.js';
import { AppStore, createInitialState, defaultAnalysisParams } from '../src/ui/state.js';
import type { ControlLike, ElementLike, EventContext } from '../src/ui/events/context.js';
import { ACTIONS, routeChange, routeClick } from '../src/ui/events/router.js';
import { handleDashboardKey, nextTabForKey } from '../src/ui/events/dashboard.js';
import { handleLandingKey } from '../src/ui/events/sidebar.js';
import { handleShortcutKey } from '../src/ui/events/shortcuts.js';

/** Minimal element: attributes, a parent, and `closest` for the selectors the handlers use. */
interface FakeEl extends ControlLike {
  attrs: Record<string, string>;
  parent: FakeEl | null;
}

function camel(attr: string): string {
  return attr.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function matches(e: FakeEl, selector: string): boolean {
  const sel = selector.trim();
  if (sel.startsWith('#')) return e.id === sel.slice(1);
  const parts = [...sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
  return parts.length > 0 && parts.every(([, name, value]) => name! in e.attrs && (value === undefined || e.attrs[name!] === value));
}

function el(attrs: Record<string, string> = {}, opts: Partial<Pick<FakeEl, 'id' | 'tagName' | 'type' | 'value' | 'checked' | 'parent'>> = {}): FakeEl {
  const dataset: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[camel(k)] = v;
  const e: FakeEl = {
    attrs,
    dataset,
    parent: opts.parent ?? null,
    tagName: opts.tagName ?? 'BUTTON',
    value: opts.value ?? '',
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    ...(opts.checked !== undefined ? { checked: opts.checked } : {}),
    closest(selector: string): ElementLike | null {
      for (let cur: FakeEl | null = e; cur; cur = cur.parent) {
        if (selector.split(',').some((s) => matches(cur!, s))) return cur;
      }
      return null;
    },
  };
  return e;
}

const site = { siteId: 's1', name: 'Reach 1', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: [] } as unknown as SiteRecord;

function setup() {
  const store = new AppStore({ ...createInitialState(), sites: [site], activeSiteId: 's1' });
  const actions = {
    runBatch: vi.fn(async () => {}),
    runAllSites: vi.fn(async () => {}),
    cancelBatch: vi.fn(),
    loadSiteData: vi.fn(async () => {}),
    refreshComparison: vi.fn(async () => {}),
    recomputeReports: vi.fn(),
    savePhoto: vi.fn(async () => {}),
    persistActiveSession: vi.fn(async () => {}),
    setFineGrainUpscale: vi.fn(async () => {}),
    clearStoredSiteInputs: vi.fn(),
    refreshCapabilities: vi.fn(async () => {}),
    applyCalibrationToActive: vi.fn(async () => {}),
    updateActiveRoi: vi.fn(),
    tidyOutlines: vi.fn(async () => {}),
  };
  const ui = {
    renderSidebar: vi.fn(),
    syncViewport: vi.fn(async () => {}),
    viewport: () => null,
    openPhotoPicker: vi.fn(),
    openArchivePicker: vi.fn(),
    askSiteName: vi.fn((_m: string, current: string) => `${current} renamed`),
    scrollSidebarToTop: vi.fn(),
    downloadChart: vi.fn(async () => {}),
    download: vi.fn(),
    runExport: vi.fn(),
    setFieldValue: vi.fn(),
    focusTab: vi.fn(),
    focusWorkflowTab: vi.fn(),
    enterWorkspace: vi.fn(),
    showLanding: vi.fn(),
    isTyping: vi.fn(() => false),
  };
  const prefs = {
    setGuideHidden: vi.fn(),
    setSkipLanding: vi.fn(),
    noteExportOpened: vi.fn(),
    setNotifyWhenDone: vi.fn(),
    requestNotifyPermission: vi.fn(async () => true),
    saveCpuThreads: vi.fn(),
  };
  const storage = { saveSite: vi.fn(async () => {}), listSites: vi.fn(async () => [site]) };
  const ctx = { store, actions, ui, prefs, storage, makeId: (p: string) => `${p}_new` } as unknown as EventContext;
  return { store, actions, ui, prefs, storage, ctx };
}

const click = (target: FakeEl, ctx: EventContext) => {
  const preventDefault = vi.fn();
  routeClick(target, preventDefault, ctx);
  return preventDefault;
};

describe('event routing', () => {
  it('every data-action in the UI has a handler', () => {
    const files = ['src/ui/main.ts', 'src/ui/modals.ts', 'src/ui/onboarding.ts', 'src/ui/progress.ts', ...readdirSync('src/ui/panels').map((f) => `src/ui/panels/${f}`)];
    const used = new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(20);
    for (const act of used) if (act !== 'close-modal') expect(ACTIONS, act).toHaveProperty(act);
  });

  it('help buttons open the help topic and do not toggle their label', () => {
    const { ctx, store } = setup();
    const label = el({}, { tagName: 'LABEL' });
    const prevent = click(el({ 'data-help': 'flowThreshold' }, { parent: label }), ctx);
    expect(prevent).toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ activeModal: 'help', helpTopic: 'flowThreshold' });
    click(el({ 'data-help': 'not-a-topic' }), ctx);
    expect(store.getState().helpTopic).toBeNull();
  });

  it('opens and closes dialogs; opening Export marks the guide step', () => {
    const { ctx, store, prefs } = setup();
    click(el({ 'data-open-modal': 'export' }), ctx);
    expect(store.getState().activeModal).toBe('export');
    expect(prefs.noteExportOpened).toHaveBeenCalledTimes(1);
    click(el({ 'data-action': 'close-modal' }), ctx);
    expect(store.getState().activeModal).toBeNull();
  });

  it('dispatches data-action from a nested element, and ignores unknown actions', () => {
    const { ctx, store, actions } = setup();
    const btn = el({ 'data-action': 'run-active' });
    click(el({}, { tagName: 'SPAN', parent: btn }), ctx);
    expect(actions.runBatch).not.toHaveBeenCalled(); // no photo open
    store.setState({ activePhotoId: 'p1' });
    click(btn, ctx);
    expect(actions.runBatch).toHaveBeenCalledWith(['p1']);
    click(el({ 'data-action': 'no-such-thing' }), ctx);
    click(el({ 'data-action': 'analyse-all-sites' }), ctx);
    expect(actions.runAllSites).toHaveBeenCalledTimes(1);
  });

  it('renames and creates sites through the storage', async () => {
    const { ctx, storage, actions } = setup();
    click(el({ 'data-action': 'rename-site' }), ctx);
    expect(storage.saveSite).toHaveBeenCalledWith(expect.objectContaining({ siteId: 's1', name: 'Reach 1 renamed' }));
    click(el({ 'data-action': 'new-site' }), ctx);
    await vi.waitFor(() => expect(actions.loadSiteData).toHaveBeenCalledWith('site_new'));
  });

  it('exports, tools, scope and tabs', () => {
    const { ctx, store, ui, actions } = setup();
    click(el({ 'data-export': 'site-archive' }), ctx);
    expect(ui.runExport).toHaveBeenCalledWith('site-archive');
    store.setState({ selectedGrainIds: new Set([3]) });
    click(el({ 'data-tool': 'calibrate' }), ctx);
    expect(store.getState().activeTool).toBe('calibrate');
    expect(store.getState().selectedGrainIds.size).toBe(0);
    click(el({ 'data-scope': 'compare' }), ctx);
    expect(store.getState().dashboardScope).toBe('compare');
    expect(actions.refreshComparison).toHaveBeenCalled();
    click(el({ 'data-tab': 'fabric' }), ctx);
    expect(store.getState().dashboardTab).toBe('fabric');
    click(el({ 'data-chart-dl': 'psd', 'data-fmt': 'png' }), ctx);
    expect(ui.downloadChart).toHaveBeenCalledWith('psd', 'png');
    click(el({ 'data-phi-step': '1' }), ctx);
    expect(store.getState().histogramStepPhi).toBe(1);
  });

  it('landing page actions: enter-workspace, show-landing, workflow-step and keyboard navigation', () => {
    const { ctx, store, ui } = setup();
    click(el({ 'data-action': 'enter-workspace', 'data-launch-tool': 'calibrate' }), ctx);
    expect(ui.enterWorkspace).toHaveBeenCalledWith('calibrate');
    click(el({ 'data-action': 'show-landing' }), ctx);
    expect(ui.showLanding).toHaveBeenCalledTimes(1);
    click(el({ 'data-action': 'workflow-step', 'data-step': 'edit' }), ctx);
    expect(store.getState().landingStep).toBe('edit');

    const preventTab = vi.fn();
    handleLandingKey(
      el({ role: 'tab', 'data-step': 'edit' }),
      { key: 'ArrowRight', preventDefault: preventTab },
      ctx,
    );
    expect(preventTab).toHaveBeenCalled();
    expect(store.getState().landingStep).toBe('export');
    expect(ui.focusWorkflowTab).toHaveBeenCalledWith('export');

    const preventDrop = vi.fn();
    handleLandingKey(
      el({ 'data-action': 'add-photos' }, { id: 'landing-dropzone' }),
      { key: 'Enter', preventDefault: preventDrop },
      ctx,
    );
    expect(preventDrop).toHaveBeenCalled();
    expect(ui.openPhotoPicker).toHaveBeenCalledTimes(1);
  });

  it('selects a photo from its row, but not when its checkbox is clicked', () => {
    const { ctx, store, ui } = setup();
    const row = el({ 'data-photo-id': 'p2' });
    click(el({ 'data-toggle-include': 'p2' }, { tagName: 'INPUT', parent: row }), ctx);
    expect(store.getState().activePhotoId).toBeNull();
    click(el({}, { tagName: 'SPAN', parent: row }), ctx);
    expect(store.getState().activePhotoId).toBe('p2');
    expect(ui.syncViewport).toHaveBeenCalledWith(true);
  });

  it('keyboard: arrows move between result tabs; Ctrl+Z undoes', () => {
    expect(nextTabForKey('psd', 'ArrowLeft')).toBe('fabric');
    expect(nextTabForKey('fabric', 'ArrowRight')).toBe('psd');
    expect(nextTabForKey('shape', 'Home')).toBe('psd');
    expect(nextTabForKey('psd', 'x')).toBeNull();
    const { ctx, store, ui, actions } = setup();
    const prevent = vi.fn();
    handleDashboardKey(el({ role: 'tab', 'data-tab': 'psd' }), { key: 'End', preventDefault: prevent }, ctx);
    expect(store.getState().dashboardTab).toBe('fabric');
    expect(ui.focusTab).toHaveBeenCalledWith('fabric');

    const sess = { undo: vi.fn(() => true), redo: vi.fn(() => false) };
    store.setState({ photos: [{ photoId: 'p1' } as never], activePhotoId: 'p1', sessions: new Map([['p1', sess as never]]) });
    const e = { key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, preventDefault: vi.fn() };
    handleShortcutKey(e, ctx);
    expect(sess.undo).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(actions.persistActiveSession).toHaveBeenCalledWith('p1', sess);
    const r = { key: 'y', ctrlKey: true, metaKey: false, shiftKey: false, preventDefault: vi.fn() };
    handleShortcutKey(r, ctx);
    expect(r.preventDefault).not.toHaveBeenCalled(); // nothing to redo
  });
});

describe('form changes', () => {
  it('analysis settings: numbers, checkboxes and selects', () => {
    const { ctx, store } = setup();
    routeChange(el({ 'data-param': 'flowThreshold' }, { tagName: 'INPUT', type: 'number', value: '0.6' }), ctx);
    routeChange(el({ 'data-param': 'skipTilesOutsideRoi' }, { tagName: 'INPUT', type: 'checkbox', checked: false }), ctx);
    routeChange(el({ 'data-param': 'model' }, { tagName: 'SELECT', value: 'cpsam' }), ctx);
    expect(store.getState().analysisParams).toEqual({ ...defaultAnalysisParams(), flowThreshold: 0.6, skipTilesOutsideRoi: false, model: 'cpsam' });
  });

  it('site statistics options are saved with the site', () => {
    const { ctx, store, storage, actions } = setup();
    routeChange(el({ 'data-site-opt': 'confidenceLevel', 'data-numeric': 'true' }, { tagName: 'SELECT', value: '0.9' }), ctx);
    expect(store.getState().siteOptions.confidenceLevel).toBe(0.9);
    expect(storage.saveSite).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ confidenceLevel: 0.9 }) }));
    routeChange(el({ 'data-site-opt': 'maxExcludedFraction' }, { tagName: 'INPUT', type: 'number', value: '0.2' }), ctx);
    expect(actions.clearStoredSiteInputs).toHaveBeenCalled();
  });

  it('compare checkboxes, site switch, CPU threads, notifications, Display menu, calibration preset, skip landing', async () => {
    const { ctx, store, actions, prefs, ui } = setup();
    store.setState({ sites: [site, { ...site, siteId: 's2', name: 'Reach 2' }] });
    routeChange(el({ 'data-compare-site': 's1' }, { tagName: 'INPUT', type: 'checkbox', checked: false }), ctx);
    expect(store.getState().compareSiteIds).toEqual(['s2']);
    routeChange(el({}, { tagName: 'SELECT', id: 'site-select', value: 's2' }), ctx);
    expect(actions.loadSiteData).toHaveBeenCalledWith('s2');
    routeChange(el({ 'data-cpu-threads': '' }, { tagName: 'SELECT', value: '4' }), ctx);
    expect(prefs.saveCpuThreads).toHaveBeenCalledWith('4');
    const box = el({ 'data-notify-done': '' }, { tagName: 'INPUT', type: 'checkbox', checked: true });
    routeChange(box, ctx);
    await vi.waitFor(() => expect(prefs.setNotifyWhenDone).toHaveBeenCalledWith(true));
    routeChange(el({ 'data-ov': 'opacity' }, { tagName: 'INPUT', type: 'range', value: '0.3' }), ctx);
    expect(store.getState().overlays.opacity).toBe(0.3);
    routeChange(el({}, { tagName: 'SELECT', id: 'cal-preset', value: '300|mm' }), ctx);
    expect(ui.setFieldValue).toHaveBeenCalledWith('cal-length', '300');
    expect(ui.setFieldValue).toHaveBeenCalledWith('cal-unit', 'mm');
    routeChange(el({ 'data-landing-skip': '' }, { tagName: 'INPUT', type: 'checkbox', checked: true }), ctx);
    expect(prefs.setSkipLanding).toHaveBeenCalledWith(true);
  });

  it('preserves calibration preset/length/unit and rectify dimensions in state and toolbar re-renders', () => {
    const { ctx, store } = setup();
    store.setState({ activeTool: 'calibrate' });

    // Select 500 mm Quadrat preset -> stored in state and rendered as selected
    routeChange(el({}, { tagName: 'SELECT', id: 'cal-preset', value: '500|mm' }), ctx);
    expect(store.getState().calibrationPreset).toBe('500|mm');
    expect(store.getState().calibrationLength).toBe(500);
    expect(store.getState().calibrationUnit).toBe('mm');

    // Type custom length 35 and switch unit to cm -> switches preset to custom and survives re-render
    routeChange(el({}, { tagName: 'INPUT', id: 'cal-length', type: 'number', value: '35' }), ctx);
    routeChange(el({}, { tagName: 'SELECT', id: 'cal-unit', value: 'cm' }), ctx);
    expect(store.getState().calibrationPreset).toBe('custom');
    expect(store.getState().calibrationLength).toBe(35);
    expect(store.getState().calibrationUnit).toBe('cm');

    // Simulate point-1 click re-render (must NOT reset to 100 mm Ruler!)
    store.setState({ pendingCalibrationPoints: [{ x: 10, y: 20 }] });
    const calHtml = renderToolbarHtml(store.getState()).subToolbar;
    expect(calHtml).toContain('value="35"');
    expect(calHtml).toContain('<option value="cm" selected>');
    expect(calHtml).toContain('<option value="custom" selected>');

    // Rectify width/height also survive re-render after point-1 click
    store.setState({ activeTool: 'rectify' });
    routeChange(el({}, { tagName: 'INPUT', id: 'rect-w', type: 'number', value: '300' }), ctx);
    routeChange(el({}, { tagName: 'INPUT', id: 'rect-h', type: 'number', value: '200' }), ctx);
    store.setState({ pendingRectifyPoints: [{ x: 1, y: 1 }] });
    const rectHtml = renderToolbarHtml(store.getState()).subToolbar;
    expect(rectHtml).toContain('id="rect-w" type="number" value="300"');
    expect(rectHtml).toContain('id="rect-h" type="number" value="200"');
  });

  it('syncs modified siteOptions into state.sites and ignores NaN numeric inputs', () => {
    const { ctx, store } = setup();
    routeChange(el({ 'data-site-opt': 'confidenceLevel', 'data-numeric': 'true' }, { tagName: 'SELECT', value: '0.9' }), ctx);
    expect(store.getState().siteOptions.confidenceLevel).toBe(0.9);
    expect(store.getState().sites.find((s) => s.siteId === 's1')?.options.confidenceLevel).toBe(0.9);

    routeChange(el({ 'data-site-opt': 'maxExcludedFraction' }, { tagName: 'INPUT', type: 'number', value: '' }), ctx);
    expect(Number.isFinite(store.getState().siteOptions.maxExcludedFraction)).toBe(true);
  });

  it('refuses cleared and out-of-range site statistics inputs (audit B15)', () => {
    const { ctx, store, actions } = setup();
    const before = store.getState().siteOptions;
    const num = (key: string, value: string) =>
      routeChange(el({ 'data-site-opt': key }, { tagName: 'INPUT', type: 'number', value }), ctx);
    num('minBaxisPx', ''); // Number('') would be 0: the resolution floor silently off
    num('minBaxisPx', '   ');
    num('minBaxisPx', '-50');
    num('maxExcludedFraction', '5');
    num('bootstrapReplicates', '9999999');
    num('bootstrapSeed', '1.5');
    expect(store.getState().siteOptions).toEqual(before);
    expect(actions.recomputeReports).not.toHaveBeenCalled();
    expect(store.getState().statusMessage).toMatch(/Not changed/);
    // Valid values still apply (replicates rounded like an imported project).
    num('minBaxisPx', '20');
    num('bootstrapReplicates', '1234.4');
    expect(store.getState().siteOptions.minBaxisPx).toBe(20);
    expect(store.getState().siteOptions.bootstrapReplicates).toBe(1234);
  });

  it('clears pending calibration and rectify points when switching photos via keyboard shortcut', () => {
    const { ctx, store } = setup();
    store.setState({
      photos: [{ photoId: 'p1' } as never, { photoId: 'p2' } as never],
      activePhotoId: 'p1',
      pendingCalibrationPoints: [{ x: 10, y: 20 }],
      pendingRectifyPoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    });
    const ev = { key: ']', ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn() };
    handleShortcutKey(ev, ctx);
    expect(store.getState().activePhotoId).toBe('p2');
    expect(store.getState().pendingCalibrationPoints).toEqual([]);
    expect(store.getState().pendingRectifyPoints).toEqual([]);
  });

  it('re-applies calibration immediately when preset, length, or unit changes on an already-calibrated photo', () => {
    const { ctx, store, actions, ui } = setup();
    const ptA = { x: 10, y: 20 };
    const ptB = { x: 110, y: 20 };
    store.setState({
      activeTool: 'calibrate',
      activePhotoId: 'p1',
      photos: [
        {
          photoId: 'p1',
          siteId: 's1',
          label: 'p1.jpg',
          width: 400,
          height: 300,
          addedAt: 0,
          included: true,
          imageBlob: new Blob(['x']),
          calibration: { pointA: ptA, pointB: ptB, physicalLengthMm: 100, pixelDistance: 100, mmPerPx: 1 },
        },
      ],
    });

    // Changing preset to 500 mm Quadrat re-applies calibration with existing points
    routeChange(el({}, { tagName: 'SELECT', id: 'cal-preset', value: '500|mm' }), ctx);
    expect(actions.applyCalibrationToActive).toHaveBeenLastCalledWith(ptA, ptB, 500, 'mm');

    // Changing custom length updates cal-preset DOM to 'custom' and re-applies calibration
    routeChange(el({}, { tagName: 'INPUT', id: 'cal-length', type: 'number', value: '35' }), ctx);
    expect(ui.setFieldValue).toHaveBeenCalledWith('cal-preset', 'custom');
    expect(actions.applyCalibrationToActive).toHaveBeenLastCalledWith(ptA, ptB, 35, 'mm');

    // Changing unit to cm re-applies calibration
    routeChange(el({}, { tagName: 'SELECT', id: 'cal-unit', value: 'cm' }), ctx);
    expect(actions.applyCalibrationToActive).toHaveBeenLastCalledWith(ptA, ptB, 35, 'cm');

    // Mid-click (1 pending point) should NOT overwrite the existing calibration prematurely
    actions.applyCalibrationToActive.mockClear();
    store.setState({ pendingCalibrationPoints: [{ x: 50, y: 50 }] });
    routeChange(el({}, { tagName: 'INPUT', id: 'cal-length', type: 'number', value: '200' }), ctx);
    expect(actions.applyCalibrationToActive).not.toHaveBeenCalled();
  });

  it('does not overwrite a GeoTIFF, rectified or copied scale when the preset/length changes', () => {
    for (const source of ['geotiff', 'rectification', 'copied'] as const) {
      const { ctx, store, actions } = setup();
      store.setState({
        activeTool: 'calibrate',
        activePhotoId: 'p1',
        photos: [
          {
            photoId: 'p1',
            siteId: 's1',
            label: 'p1.tif',
            width: 400,
            height: 300,
            addedAt: 0,
            included: true,
            imageBlob: new Blob(['x']),
            calibration: {
              pointA: { x: 0, y: 0 },
              pointB: { x: 100, y: 0 },
              physicalLengthMm: 200,
              pixelDistance: 100,
              mmPerPx: 2,
              source,
            },
          },
        ],
      });
      routeChange(el({}, { tagName: 'SELECT', id: 'cal-preset', value: '25|mm' }), ctx);
      routeChange(el({}, { tagName: 'INPUT', id: 'cal-length', type: 'number', value: '35' }), ctx);
      routeChange(el({}, { tagName: 'SELECT', id: 'cal-unit', value: 'cm' }), ctx);
      expect(actions.applyCalibrationToActive).not.toHaveBeenCalled();
      // The toolbar still records the chosen length for the next two-point calibration.
      expect(store.getState().calibrationLength).toBe(35);
      expect(store.getState().calibrationUnit).toBe('cm');
    }
  });
});

describe('clear-areas action', () => {
  it('removes the ROI and every exclusion, keeping other ROI settings', () => {
    const { ctx, actions } = setup();
    routeClick(el({ 'data-action': 'clear-areas' }), () => undefined, ctx);
    expect(actions.updateActiveRoi).toHaveBeenCalledTimes(1);
    const update = actions.updateActiveRoi.mock.calls[0]![0] as (prev: unknown) => unknown;
    const next = update({
      roiPolygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
      exclusionPolygons: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]],
      exclusionStrokes: [{ points: [{ x: 0, y: 0 }], radiusPx: 3 }],
      unresolvedFinesFraction: 0.2,
    });
    expect(next).toEqual({ exclusionPolygons: [], exclusionStrokes: [], unresolvedFinesFraction: 0.2 });
  });
});

describe('Tidy outlines actions', () => {
  it('the toolbar button tidies the photo shown; the photo-list action the selected photos', () => {
    const { ctx, store, actions } = setup();
    store.setState({ activePhotoId: 'p1', photos: [{ photoId: 'p1' } as never, { photoId: 'p2' } as never, { photoId: 'p3' } as never] });
    routeClick(el({ 'data-action': 'tidy-outlines' }), () => undefined, ctx);
    expect(actions.tidyOutlines).toHaveBeenLastCalledWith(['p1']);
    store.setState({ selectedPhotoIds: new Set(['p2', 'p3']) });
    routeClick(el({ 'data-action': 'photo-bulk', 'data-bulk': 'tidy' }), () => undefined, ctx);
    expect(actions.tidyOutlines).toHaveBeenLastCalledWith(['p2', 'p3']);
  });
});

