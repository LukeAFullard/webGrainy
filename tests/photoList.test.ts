import { describe, expect, it, vi } from 'vitest';
import type { PhotoRecord } from '../src/modules/projectStorage.js';
import { photoSummary, visiblePhotos } from '../src/ui/photoList.js';
import { AppStore, createInitialState } from '../src/ui/state.js';
import { renderSidebarHtml } from '../src/ui/panels/sidebar.js';
import type { EventContext } from '../src/ui/events/context.js';
import { routeChange, routeClick } from '../src/ui/events/router.js';

const cal = { mmPerPx: 0.5 } as never;
const photo = (photoId: string, extra: Partial<PhotoRecord> = {}): PhotoRecord =>
  ({ photoId, siteId: 's', label: `${photoId}.jpg`, imageBlob: new Blob(), width: 10, height: 10, addedAt: 0, included: true, ...extra }) as PhotoRecord;

function mixedState() {
  return {
    ...createInitialState(),
    sites: [{ siteId: 's', name: 'S', photoOrder: [], options: {} } as never],
    activeSiteId: 's',
    photos: [photo('a', { calibration: cal }), photo('b', { calibration: cal }), photo('c'), photo('d', { calibration: cal, included: false })],
    photoStatuses: new Map([['a', 'done'], ['b', 'done'], ['c', 'error'], ['d', 'pending']] as const),
  };
}

const el = (attrs: Record<string, string>, tagName = 'BUTTON', extra: Record<string, unknown> = {}) => {
  const dataset: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) dataset[k.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  const e = { dataset, tagName, value: '', ...extra, closest: (sel: string) => (sel === '[data-action]' && attrs['data-action'] ? e : null) };
  return e as never;
};

describe('photo list tools', () => {
  it('summarises the photo states and filters the list', () => {
    const st = mixedState();
    expect(photoSummary(st).map((p) => p.label)).toEqual(['4 photos', '2 analysed', '1 not analysed', '1 not calibrated', '1 failed', '1 left out of the site']);
    expect(visiblePhotos({ ...st, photoFilter: 'failed' }).map((p) => p.photoId)).toEqual(['c']);
    expect(visiblePhotos({ ...st, photoFilter: 'uncalibrated' }).map((p) => p.photoId)).toEqual(['c']);
    expect(visiblePhotos({ ...st, photoFilter: 'excluded' }).map((p) => p.photoId)).toEqual(['d']);
    expect(visiblePhotos({ ...st, photoFilter: 'all' })).toHaveLength(4);
  });

  it('renders the summary, the filtered list and the bulk bar', () => {
    const view = { guideHtml: '', settingsOpen: false, cpuThreadPref: 'auto' as const, cpuThreads: 1, crossOriginIsolated: true, canNotify: false, notifyWhenDone: false, storageInfo: null };
    const html = renderSidebarHtml({ ...mixedState(), photoFilter: 'analysed' }, view);
    expect(html).toContain('data-filter="failed"');
    expect(html).toContain('Showing 2');
    expect(html).toContain('a.jpg');
    expect(html).not.toContain('c.jpg');
    const sel = renderSidebarHtml({ ...mixedState(), photoSelectMode: true, selectedPhotoIds: new Set(['a']) }, view);
    expect(sel).toContain('1 selected');
    expect(sel).toContain('data-select-photo="a" checked');
    expect(sel).not.toContain('data-toggle-include');
  });

  it('selects photos and runs bulk actions; delete asks first', () => {
    const store = new AppStore(mixedState());
    const actions = { setPhotosIncluded: vi.fn(async () => {}), runBatch: vi.fn(async () => {}), deletePhotos: vi.fn(async () => {}) };
    const confirm = vi.fn(() => false);
    const ctx = { store, actions, ui: { confirm } } as unknown as EventContext;
    routeClick(el({ 'data-action': 'photo-select-mode' }), () => {}, ctx);
    expect(store.getState().photoSelectMode).toBe(true);
    routeChange(el({ 'data-select-photo': 'b' }, 'INPUT', { checked: true }), ctx);
    routeChange(el({ 'data-select-photo': 'c' }, 'INPUT', { checked: true }), ctx);
    expect([...store.getState().selectedPhotoIds]).toEqual(['b', 'c']);
    routeClick(el({ 'data-action': 'photo-bulk', 'data-bulk': 'exclude' }), () => {}, ctx);
    expect(actions.setPhotosIncluded).toHaveBeenCalledWith(['b', 'c'], false);
    routeClick(el({ 'data-action': 'photo-bulk', 'data-bulk': 'reanalyse' }), () => {}, ctx);
    expect(actions.runBatch).toHaveBeenCalledWith(['b', 'c']);
    routeClick(el({ 'data-action': 'photo-bulk', 'data-bulk': 'delete' }), () => {}, ctx);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Delete 2 photos'));
    expect(actions.deletePhotos).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    routeClick(el({ 'data-action': 'photo-bulk', 'data-bulk': 'delete' }), () => {}, ctx);
    expect(actions.deletePhotos).toHaveBeenCalledWith(['b', 'c']);
    store.setState({ photoFilter: 'failed' });
    routeClick(el({ 'data-action': 'photo-select-all' }), () => {}, ctx);
    expect([...store.getState().selectedPhotoIds]).toEqual(['c']);
  });
});
