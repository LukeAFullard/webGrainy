/** Left panel events: sites, photos, the guide, batch buttons and analysis settings. */
import type { PhotoRecord, SiteRecord } from '../../modules/projectStorage.js';
import { defaultAnalysisParams } from '../state.js';
import { getActiveSite } from '../workspaceActions.js';
import { isInput, isSelect, type ActionHandler, type ControlLike, type ElementLike, type EventContext } from './context.js';

export const sidebarActions: Record<string, ActionHandler> = {
  'add-photos': (_el, ctx) => ctx.ui.openPhotoPicker(),
  'import-archive': (_el, ctx) => ctx.ui.openArchivePicker(),
  'hide-guide': (_el, ctx) => {
    ctx.prefs.setGuideHidden(true);
    ctx.ui.renderSidebar();
  },
  'show-guide': (_el, ctx) => {
    ctx.prefs.setGuideHidden(false);
    ctx.store.setState({ activeModal: null });
    ctx.ui.renderSidebar();
    ctx.ui.scrollSidebarToTop();
  },
  'reset-analysis-params': (_el, ctx) => {
    ctx.store.setState({ analysisParams: defaultAnalysisParams(), statusMessage: 'Analysis settings reset to the tested defaults.' });
  },
  'new-site': (_el, ctx) => {
    const state = ctx.store.getState();
    const name = ctx.ui.askSiteName('Name for the new site (e.g. river and reach):', `Field Site ${state.sites.length + 1}`);
    if (name === null) return;
    const newSite: SiteRecord = {
      siteId: ctx.makeId('site'),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      options: state.siteOptions,
      photoOrder: [],
    };
    void ctx.storage.saveSite(newSite).then(async () => {
      const sites = await ctx.storage.listSites();
      ctx.store.setState({ sites });
      await ctx.actions.loadSiteData(newSite.siteId);
    });
  },
  'rename-site': (_el, ctx) => {
    const site = getActiveSite(ctx.store.getState());
    if (!site) return;
    const name = ctx.ui.askSiteName('New name for this site:', site.name);
    if (name === null || name === site.name) return;
    const renamed: SiteRecord = { ...site, name, updatedAt: Date.now() };
    void ctx.storage.saveSite(renamed).then(async () => {
      ctx.store.setState({ sites: await ctx.storage.listSites(), statusMessage: `Site renamed to "${name}".` });
      if (ctx.store.getState().dashboardScope === 'compare') void ctx.actions.refreshComparison();
    });
  },
  'run-batch': (_el, ctx) => void ctx.actions.runBatch(),
  'cancel-batch': (_el, ctx) => ctx.actions.cancelBatch(),
  'run-active': (_el, ctx) => {
    const id = ctx.store.getState().activePhotoId;
    if (id) void ctx.actions.runBatch([id]);
  },
  'analyse-all-sites': (_el, ctx) => void ctx.actions.runAllSites(),
};

/** Clicks outside `data-action` buttons: the drop zone and photo rows. */
export function handleSidebarClick(target: ElementLike, ctx: EventContext): boolean {
  if (target.closest('#photo-dropzone')) {
    ctx.ui.openPhotoPicker();
    return true;
  }
  const photoRow = target.closest('[data-photo-id]');
  if (photoRow && !isInput(target)) {
    const pid = photoRow.dataset['photoId'];
    if (pid && pid !== ctx.store.getState().activePhotoId) {
      ctx.store.setState({ activePhotoId: pid, selectedGrainIds: new Set(), inspectedGrainId: null });
      ctx.actions.recomputeReports();
      void ctx.ui.syncViewport(true);
    }
    return true;
  }
  return false;
}

function updatePhoto(ctx: EventContext, pid: string, change: Partial<PhotoRecord>): void {
  const st = ctx.store.getState();
  const ph = st.photos.find((p) => p.photoId === pid);
  if (!ph) return;
  const updated: PhotoRecord = { ...ph, ...change };
  void ctx.actions.savePhoto(updated);
  ctx.store.setState({ photos: st.photos.map((p) => (p.photoId === pid ? updated : p)) });
  ctx.actions.recomputeReports();
}

/** Form changes in the left panel; returns true when handled. */
export function handleSidebarChange(target: ControlLike, ctx: EventContext): boolean {
  if (target.id === 'site-select') {
    void ctx.actions.loadSiteData(target.value);
    return true;
  }
  if (isInput(target) && target.dataset['photoFacies']) {
    const w = Number(target.value);
    if (Number.isFinite(w) && w >= 0) updatePhoto(ctx, target.dataset['photoFacies'], { faciesWeight: w });
    return true;
  }
  if (isInput(target) && target.dataset['toggleInclude']) {
    updatePhoto(ctx, target.dataset['toggleInclude'], { included: target.checked === true });
    return true;
  }
  if (isInput(target) && target.dataset['notifyDone'] !== undefined) {
    if (!target.checked) {
      ctx.prefs.setNotifyWhenDone(false);
      return true;
    }
    void ctx.prefs.requestNotifyPermission().then((ok) => {
      ctx.prefs.setNotifyWhenDone(ok);
      target.checked = ok;
      ctx.store.setState({
        statusMessage: ok
          ? 'You will be notified when an analysis longer than a minute finishes while this tab is in the background.'
          : 'Notifications are blocked for this site in the browser settings.',
      });
    });
    return true;
  }
  if (isSelect(target) && target.dataset['cpuThreads'] !== undefined) {
    ctx.prefs.saveCpuThreads(target.value);
    ctx.store.setState({ statusMessage: 'CPU threads saved. Reload the page to apply (the CPU runtime fixes its thread count when it starts).' });
    return true;
  }
  const paramKey = target.dataset['param'];
  if (paramKey) {
    const st = ctx.store.getState();
    const next = { ...st.analysisParams } as Record<string, unknown>;
    if (isInput(target) && target.type === 'checkbox') next[paramKey] = target.checked;
    else if (isInput(target) && target.type === 'number') next[paramKey] = Number(target.value);
    else if (isSelect(target)) next[paramKey] = target.value;
    ctx.store.setState({ analysisParams: next as unknown as typeof st.analysisParams });
    if (paramKey === 'excludeBorder' && isInput(target)) {
      // Border exclusion only filters statistics, so apply it to analysed photos now.
      for (const sess of st.sessions.values()) sess.setExcludeBorder(target.checked === true);
      ctx.actions.recomputeReports();
      void ctx.ui.syncViewport(false);
    }
    return true;
  }
  return false;
}
