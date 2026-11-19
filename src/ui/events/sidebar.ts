/** Left panel & landing page events: sites, photos, the guide, landing workflow tabs, batch buttons and analysis settings. */
import type { PhotoRecord, SiteRecord } from '../../modules/projectStorage.js';
import { parseParamInput } from '../savedSettings.js';
import { defaultAnalysisParams, type EditorToolMode } from '../state.js';
import { isIsoDate } from '../../modules/surveyDate.js';
import { placeName, surveysOfSamePlace } from '../../modules/sitePlaces.js';
import { isWorkflowStepId, nextWorkflowStepForKey } from '../panels/landing.js';
import { workingScaleFactorFor } from '../panels/sidebar.js';
import { visiblePhotos, type PhotoFilter } from '../photoList.js';
import { getActivePhoto, getActiveSite } from '../workspaceActions.js';
import { confirmDiscardEdits, isInput, isSelect, type ActionHandler, type ControlLike, type ElementLike, type EventContext } from './context.js';

export const sidebarActions: Record<string, ActionHandler> = {
  'add-photos': (_el, ctx) => ctx.ui.openPhotoPicker(),
  'import-archive': (_el, ctx) => ctx.ui.openArchivePicker(),
  'enter-workspace': (el, ctx) => {
    const tool = el.dataset['launchTool'] as EditorToolMode | undefined;
    if (ctx.ui.enterWorkspace) {
      ctx.ui.enterWorkspace(tool);
    } else {
      ctx.store.setState({
        showLanding: false,
        ...(tool ? { activeTool: tool } : {}),
      });
    }
  },
  'show-landing': (_el, ctx) => {
    if (ctx.ui.showLanding) {
      ctx.ui.showLanding();
    } else {
      ctx.store.setState({ showLanding: true });
    }
  },
  'workflow-step': (el, ctx) => {
    const step = el.dataset['step'];
    if (step && isWorkflowStepId(step)) {
      ctx.store.setState({ landingStep: step });
      ctx.ui.focusWorkflowTab?.(step);
    }
  },
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
  'new-survey': (_el, ctx) => {
    const state = ctx.store.getState();
    const site = getActiveSite(state);
    const place = placeName(site?.place);
    if (!site || place === null) return;
    const n = surveysOfSamePlace(state.sites, site.siteId).length + 1;
    const name = ctx.ui.askSiteName(`Name for the new survey of ${place}:`, `${place} – survey ${n}`);
    if (name === null) return;
    const newSite: SiteRecord = {
      siteId: ctx.makeId('site'),
      name,
      place,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // Same statistics settings, so the surveys are comparable.
      options: site.options,
      photoOrder: [],
    };
    void ctx.storage.saveSite(newSite).then(async () => {
      const sites = await ctx.storage.listSites();
      ctx.store.setState({
        sites,
        statusMessage: `New survey of ${place}: add its photos, then set its survey date (or it is taken from the photos).`,
      });
      await ctx.actions.loadSiteData(newSite.siteId);
    });
  },
  'compare-place': (_el, ctx) => {
    const state = ctx.store.getState();
    const site = getActiveSite(state);
    if (!site) return;
    ctx.store.setState({
      compareSiteIds: surveysOfSamePlace(state.sites, site.siteId),
      dashboardScope: 'compare',
      compareByDate: true,
    });
    void ctx.actions.refreshComparison();
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
  'apply-update': (_el, ctx) => {
    if (ctx.ui.applyUpdate?.()) ctx.store.setState({ statusMessage: 'Updating webGrainy…' });
    else ctx.store.setState({ statusMessage: 'The update will be available when the current analysis finishes.' });
  },
  'run-active': (_el, ctx) => {
    const id = ctx.store.getState().activePhotoId;
    if (id && confirmDiscardEdits(ctx, [id])) void ctx.actions.runBatch([id]);
  },
  'analyse-all-sites': (_el, ctx) => void ctx.actions.runAllSites(),
  'photo-filter': (el, ctx) => {
    const f = el.dataset['filter'] as PhotoFilter | undefined;
    if (f) ctx.store.setState({ photoFilter: f });
  },
  'photo-select-mode': (_el, ctx) => {
    const on = !ctx.store.getState().photoSelectMode;
    ctx.store.setState({ photoSelectMode: on, selectedPhotoIds: new Set(), scaleCopySourceId: null });
  },
  'photo-select-all': (_el, ctx) => {
    const st = ctx.store.getState();
    const shown = visiblePhotos(st).map((p) => p.photoId);
    const all = st.selectedPhotoIds.size > 0 && st.selectedPhotoIds.size === shown.length;
    ctx.store.setState({ selectedPhotoIds: new Set(all ? [] : shown) });
  },
  'photo-bulk': (el, ctx) => {
    const st = ctx.store.getState();
    const ids = st.photos.filter((p) => st.selectedPhotoIds.has(p.photoId)).map((p) => p.photoId);
    if (ids.length === 0 || st.batchRunning || st.enhancing) return;
    const what = el.dataset['bulk'];
    const n = `${ids.length} photo${ids.length === 1 ? '' : 's'}`;
    if (what === 'include' || what === 'exclude') {
      void ctx.actions.setPhotosIncluded(ids, what === 'include');
    } else if (what === 'reanalyse') {
      if (confirmDiscardEdits(ctx, ids)) void ctx.actions.runBatch(ids);
    } else if (what === 'delete') {
      if (!ctx.ui.confirm(`Delete ${n} and their results from this site? This cannot be undone (unless you have a backup).`)) return;
      void ctx.actions.deletePhotos(ids).then(() => ctx.store.setState({ photoSelectMode: false }));
    }
  },
  'delete-photo': (el, ctx) => {
    const id = el.dataset['photoId'];
    if (!id) return;
    const ph = ctx.store.getState().photos.find((p) => p.photoId === id);
    const label = ph?.label ?? 'this photo';
    if (!ctx.ui.confirm(`Remove "${label}" and its results from this site? This cannot be undone (unless you have a backup).`)) return;
    void ctx.actions.deletePhotos([id]);
  },
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
      ctx.store.setState({
        activePhotoId: pid,
        selectedGrainIds: new Set(),
        inspectedGrainId: null,
        pendingCalibrationPoints: [],
        pendingRectifyPoints: [],
      });
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
  if (isInput(target) && target.dataset['sitePlace'] !== undefined) {
    const st = ctx.store.getState();
    const site = getActiveSite(st);
    if (!site) return true;
    const { place: _old, ...rest } = site;
    const place = placeName(target.value);
    // Reuse an existing place's spelling, so "rakaia reach 3" joins "Rakaia reach 3".
    const existing = st.sites.map((s) => placeName(s.place)).find((p) => p !== null && place !== null && p.toLowerCase() === place.toLowerCase());
    const updated: SiteRecord = place !== null ? { ...rest, place: existing ?? place, updatedAt: Date.now() } : { ...rest, updatedAt: Date.now() };
    void ctx.storage.saveSite(updated).then(async () => {
      ctx.store.setState({ sites: await ctx.storage.listSites(), statusMessage: updated.place ? `Place set to ${updated.place}.` : 'Place cleared.' });
      if (ctx.store.getState().dashboardScope === 'compare') void ctx.actions.refreshComparison();
    });
    return true;
  }
  if (isInput(target) && target.dataset['siteDate'] !== undefined) {
    const st = ctx.store.getState();
    const site = getActiveSite(st);
    if (!site) return true;
    const { surveyDate: _old, ...rest } = site;
    const updated: SiteRecord = isIsoDate(target.value) ? { ...rest, surveyDate: target.value, updatedAt: Date.now() } : { ...rest, updatedAt: Date.now() };
    void ctx.storage.saveSite(updated).then(async () => {
      ctx.store.setState({ sites: await ctx.storage.listSites(), statusMessage: updated.surveyDate ? `Survey date set to ${updated.surveyDate}.` : 'Survey date cleared.' });
      if (ctx.store.getState().dashboardScope === 'compare') void ctx.actions.refreshComparison();
    });
    return true;
  }
  if (isInput(target) && target.dataset['selectPhoto']) {
    const next = new Set(ctx.store.getState().selectedPhotoIds);
    if (target.checked) next.add(target.dataset['selectPhoto']);
    else next.delete(target.dataset['selectPhoto']);
    ctx.store.setState({ selectedPhotoIds: next });
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
  if (isInput(target) && target.dataset['landingSkip'] !== undefined) {
    ctx.prefs.setSkipLanding?.(target.checked === true);
    return true;
  }
  if (isInput(target) && target.dataset['minSizeMm2'] !== undefined) {
    const mm2 = Number(target.value);
    const st = ctx.store.getState();
    const activePhoto = getActivePhoto(st);
    const mmPerPx = activePhoto?.calibration?.mmPerPx;
    if (activePhoto && mmPerPx && Number.isFinite(mmPerPx) && mmPerPx > 0 && Number.isFinite(mm2) && mm2 > 0) {
      const wScale = workingScaleFactorFor(activePhoto.width, activePhoto.height, st.analysisParams.scaleMode);
      const mmPerWorkPx = mmPerPx / wScale;
      const px2 = Math.max(4, Math.min(500, Math.round(mm2 / (mmPerWorkPx * mmPerWorkPx))));
      ctx.store.setState({ analysisParams: { ...st.analysisParams, minSize: px2 } });
    }
    return true;
  }
  const paramKey = target.dataset['param'];
  if (paramKey) {
    const st = ctx.store.getState();
    const next = { ...st.analysisParams } as Record<string, unknown>;
    if (isInput(target) && target.type === 'checkbox') next[paramKey] = target.checked;
    else if (isInput(target) && target.type === 'number') {
      const parsed = parseParamInput(paramKey, target.value);
      if ('error' in parsed) {
        // Keep the previous value (the re-render puts it back in the field).
        ctx.store.setState({
          analysisParams: { ...st.analysisParams },
          statusMessage: `${parsed.error}; the setting was not changed (still ${String(next[paramKey])}).`,
        });
        return true;
      }
      next[paramKey] = parsed.value;
    } else if (isSelect(target)) next[paramKey] = target.value;
    ctx.store.setState({ analysisParams: next as unknown as typeof st.analysisParams });
    if (paramKey === 'excludeBorder' && isInput(target)) {
      // Border exclusion only filters statistics, so apply it to analysed photos now and persist.
      const checked = target.checked === true;
      for (const [photoId, sess] of st.sessions.entries()) {
        sess.setExcludeBorder(checked);
        void ctx.actions.persistActiveSession(photoId, sess).catch(() => undefined);
      }
      ctx.actions.recomputeReports();
      void ctx.ui.syncViewport(false);
    }
    return true;
  }
  return false;
}

/** Keyboard navigation on the landing page (workflow tabs and dropzone activation). */
export function handleLandingKey(target: ElementLike | null, e: { key: string; preventDefault(): void }, ctx: EventContext): void {
  const dropzone = target?.closest('#landing-dropzone');
  if (dropzone && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    ctx.ui.openPhotoPicker();
    return;
  }
  const tab = target?.closest('[role="tab"][data-step]');
  if (!tab) return;
  const current = tab.dataset['step'] ?? '';
  if (!isWorkflowStepId(current)) return;
  const next = nextWorkflowStepForKey(current, e.key);
  if (next === null) return;
  e.preventDefault();
  ctx.store.setState({ landingStep: next });
  ctx.ui.focusWorkflowTab?.(next);
}

