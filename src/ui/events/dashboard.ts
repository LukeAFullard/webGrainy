/** Results panel events: scope, tabs, chart options and downloads, site statistics settings, compare. */
import { baseExportMetadata } from '../../modules/provenance.js';
import { effectiveRoi } from '../../modules/siteWorkspace.js';
import { sanitizeSiteOptions, SITE_OPTION_LIMITS } from '../../modules/siteOptions.js';
import { comparisonCsv } from '../../modules/siteComparison.js';
import { comparisonStatistics } from '../compareReport.js';
import { buildComparisonView } from '../comparisonView.js';
import { placeName } from '../../modules/sitePlaces.js';
import type { DashboardTab } from '../state.js';
import { getActivePhoto, getActiveSite } from '../workspaceActions.js';
import { confirmDiscardEdits, isInput, isSelect, type ActionHandler, type ControlLike, type ElementLike, type EventContext } from './context.js';

export const DASHBOARD_TABS: DashboardTab[] = ['psd', 'adequacy', 'shape', 'fabric'];

export const dashboardActions: Record<string, ActionHandler> = {
  'fine-grain-rerun': (_el, ctx) => {
    const state = ctx.store.getState();
    const photo = getActivePhoto(state);
    if (photo && !state.batchRunning && confirmDiscardEdits(ctx, [photo.photoId])) void ctx.actions.setFineGrainUpscale(photo, 1.5);
  },
  'fine-grain-undo': (_el, ctx) => {
    const state = ctx.store.getState();
    const photo = getActivePhoto(state);
    if (photo && !state.batchRunning && confirmDiscardEdits(ctx, [photo.photoId])) void ctx.actions.setFineGrainUpscale(photo, undefined);
  },
  'open-site': (el, ctx) => {
    const id = el.dataset['siteId'];
    if (!id) return;
    ctx.store.setState({ dashboardScope: 'photo' });
    void ctx.actions.loadSiteData(id);
  },
  'compare-select-place': (el, ctx) => {
    const place = placeName(el.dataset['place']);
    if (place === null) return;
    const ids = ctx.store.getState().sites.filter((s) => placeName(s.place)?.toLowerCase() === place.toLowerCase()).map((s) => s.siteId);
    ctx.store.setState({ compareSiteIds: ids, compareByDate: true });
    void ctx.actions.refreshComparison();
  },
  'toggle-compare-px': (el, ctx) => {
    ctx.store.setState({ compareInPixels: (el as ControlLike).checked === true });
    void ctx.actions.refreshComparison();
  },
  'toggle-compare-date': (el, ctx) => {
    ctx.store.setState({ compareByDate: (el as ControlLike).checked === true });
  },
  'compare-report': (_el, ctx) => ctx.ui.openCompareReport(),
  'export-comparison': (_el, ctx) => {
    const state = ctx.store.getState();
    const cmp = state.comparison;
    if (!cmp || cmp.sites.length === 0) return;
    const csv = comparisonCsv(cmp.sites, {
      ...baseExportMetadata(),
      poolingMode: state.siteOptions.poolingMode,
      sizeMetric: state.siteOptions.sizeMetric ?? 'bAxis',
      // The comparison settings, as in the printable comparison report.
      comparisonSettings: Object.fromEntries(comparisonStatistics(state.siteOptions, buildComparisonView(cmp.sites, state.compareByDate, 1), state.compareInPixels)),
      sites: cmp.sites.map((s) => s.name).join('; '),
    });
    ctx.ui.download(new Blob([csv], { type: 'text/csv' }), 'site_comparison.csv');
  },
};

/** Scope and tab buttons, PSD axis, histogram step and chart downloads; returns true when handled. */
export function handleDashboardClick(target: ElementLike, ctx: EventContext): boolean {
  const tabBtn = target.closest('[data-tab]');
  if (tabBtn) {
    ctx.store.setState({ dashboardTab: tabBtn.dataset['tab'] as DashboardTab });
    return true;
  }
  const scopeBtn = target.closest('[data-scope]');
  if (scopeBtn) {
    const scope = scopeBtn.dataset['scope'] as 'site' | 'photo' | 'compare';
    ctx.store.setState({ dashboardScope: scope });
    if (scope === 'compare') void ctx.actions.refreshComparison();
    return true;
  }
  const psdXBtn = target.closest('[data-psd-x]');
  if (psdXBtn) {
    ctx.store.setState({ psdXAxis: psdXBtn.dataset['psdX'] as 'mm' | 'phi' });
    return true;
  }
  const chartDl = target.closest('[data-chart-dl]');
  if (chartDl) {
    void ctx.ui.downloadChart(chartDl.dataset['chartDl'] ?? '', chartDl.dataset['fmt'] === 'png' ? 'png' : 'svg');
    return true;
  }
  const phiBtn = target.closest('[data-phi-step]');
  if (phiBtn) {
    ctx.store.setState({ histogramStepPhi: Number(phiBtn.dataset['phiStep']) === 1 ? 1.0 : 0.5 });
    return true;
  }
  return false;
}

/** Arrow keys, Home and End move between the result tabs (WAI-ARIA tabs pattern). */
export function nextTabForKey(current: string, key: string): DashboardTab | null {
  const idx = DASHBOARD_TABS.indexOf(current as DashboardTab);
  if (idx === -1) return null;
  const n = DASHBOARD_TABS.length;
  const next =
    key === 'ArrowRight' ? (idx + 1) % n : key === 'ArrowLeft' ? (idx - 1 + n) % n : key === 'Home' ? 0 : key === 'End' ? n - 1 : null;
  return next === null ? null : DASHBOARD_TABS[next]!;
}

export function handleDashboardKey(target: ElementLike | null, e: { key: string; preventDefault(): void }, ctx: EventContext): void {
  const tab = target?.closest('[role="tab"][data-tab]');
  if (!tab) return;
  const next = nextTabForKey(tab.dataset['tab'] ?? '', e.key);
  if (next === null) return;
  e.preventDefault();
  ctx.store.setState({ dashboardTab: next });
  ctx.ui.focusTab(next);
}

/** Compare-site checkboxes and site statistics settings; returns true when handled. */
export function handleDashboardChange(target: ControlLike, ctx: EventContext): boolean {
  const compareSite = isInput(target) ? target.dataset['compareSite'] : undefined;
  if (compareSite !== undefined) {
    const st = ctx.store.getState();
    const current = new Set(st.compareSiteIds ?? st.sites.map((s) => s.siteId));
    if (target.checked) current.add(compareSite);
    else current.delete(compareSite);
    ctx.store.setState({ compareSiteIds: st.sites.map((s) => s.siteId).filter((id) => current.has(id)) });
    void ctx.actions.refreshComparison();
    return true;
  }
  const siteOptKey = target.dataset['siteOpt'];
  if (!siteOptKey) return false;
  const st = ctx.store.getState();
  const nextOpts = { ...st.siteOptions } as Record<string, unknown>;
  if (isInput(target) && target.type === 'checkbox') nextOpts[siteOptKey] = target.checked;
  else if (isInput(target) && target.type === 'number') {
    // Same checks as a saved or imported site (siteOptions.ts): a cleared field (Number('') is 0)
    // or an out-of-range value is refused and the field shows the current value again.
    const raw = target.value.trim();
    const v = raw === '' ? Number.NaN : Number(raw);
    const checked = Number.isFinite(v)
      ? (sanitizeSiteOptions({ poolingMode: 'physical-area', [siteOptKey]: v }) as unknown as Record<string, unknown>)[siteOptKey]
      : undefined;
    const known = siteOptKey in SITE_OPTION_LIMITS || siteOptKey === 'bootstrapSeed';
    if (typeof checked !== 'number' && (known || !Number.isFinite(v))) {
      const lim = (SITE_OPTION_LIMITS as Record<string, readonly [number, number]>)[siteOptKey];
      const range = lim ? `a number from ${lim[0]} to ${lim[1]}` : siteOptKey === 'bootstrapSeed' ? 'a whole number from 0 to 4294967295' : 'a number';
      ctx.store.setState({ siteOptions: { ...st.siteOptions }, statusMessage: `Not changed: this setting needs ${range}.` });
      return true;
    }
    nextOpts[siteOptKey] = typeof checked === 'number' ? checked : v;
  } else if (isSelect(target)) {
    if (target.dataset['numeric'] === 'true') {
      const v = Number(target.value);
      if (!Number.isFinite(v)) return true;
      nextOpts[siteOptKey] = v;
    } else {
      nextOpts[siteOptKey] = target.value;
    }
  }
  const opts = nextOpts as unknown as typeof st.siteOptions;
  const activeSite = getActiveSite(st);
  if (activeSite) {
    const updatedSite = { ...activeSite, options: opts, updatedAt: Date.now() };
    void ctx.storage.saveSite(updatedSite);
    ctx.store.setState({
      siteOptions: opts,
      sites: st.sites.map((s) => (s.siteId === activeSite.siteId ? updatedSite : s)),
    });
  } else {
    ctx.store.setState({ siteOptions: opts });
  }
  if (siteOptKey === 'maxExcludedFraction') {
    ctx.actions.clearStoredSiteInputs(); // other sites' ROIs use the tolerance too
    for (const ph of st.photos) {
      if (ph.roiConfig) st.sessions.get(ph.photoId)?.setRoiConfig(effectiveRoi(ph, opts));
    }
  }
  ctx.actions.recomputeReports();
  void ctx.ui.syncViewport(false);
  return true;
}
