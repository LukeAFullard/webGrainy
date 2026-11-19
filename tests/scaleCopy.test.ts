/** Regression (re-audit blocker 4): copying a scale never silently overwrites photos' own scales. */
import { describe, expect, it, vi } from 'vitest';
import type { PhotoRecord } from '../src/modules/projectStorage.js';
import type { CalibrationResult } from '../src/types/index.js';
import { ACTIONS } from '../src/ui/events/router.js';
import type { EventContext } from '../src/ui/events/context.js';
import { planScaleCopy, scaleSourceOf, suggestScaleTargets } from '../src/ui/scaleCopy.js';
import { AppStore, createInitialState } from '../src/ui/state.js';

const cal = (mmPerPx: number, source?: CalibrationResult['source']): CalibrationResult => ({
  mmPerPx, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 100 * mmPerPx, pixelDistance: 100,
  ...(source ? { source } : {}),
});
const photo = (id: string, w: number, h: number, extra: Partial<PhotoRecord> = {}): PhotoRecord => ({
  photoId: id, siteId: 's', label: `${id}.jpg`, imageBlob: new Blob([]), width: w, height: h, addedAt: 0, included: true, ...extra,
});

const src = photo('A', 4000, 3000, { calibration: cal(0.2) });
const photos = [
  src,
  photo('B', 4000, 3000), // same camera, no scale: suggested
  photo('C', 4000, 3000, { calibration: cal(0.25) }), // measured on the photo
  photo('D', 2000, 1500, { calibration: cal(0.5, 'rectification') }), // rectified
  photo('E', 6000, 4000), // other camera
  photo('F', 8000, 6000, { originalBackup: { imageBlob: new Blob([]), width: 4000, height: 3000 }, metadata: { enhancement: { kind: 'upscale-2x', modelId: 'm', modelName: 'm', modelSha256: '', scaleFactor: 2, appliedAt: '' } } }),
  photo('G', 4000, 3000, { calibration: cal(0.3, 'geotiff') }),
];

describe('scale copy planning', () => {
  it('suggests only same-size photos without a scale of their own (2x-upscaled copies count as same size)', () => {
    expect([...suggestScaleTargets(src, photos)].sort()).toEqual(['B', 'F']);
  });

  it('identifies where each scale came from', () => {
    expect(photos.map((p) => scaleSourceOf(p) ?? '-')).toEqual(['manual', '-', 'manual', 'rectification', '-', '-', 'geotiff']);
    const rectifiedLegacy = photo('R', 10, 10, { calibration: cal(1), metadata: { processingHistory: [{ step: 'rectification' } as never] } });
    expect(scaleSourceOf(rectifiedLegacy)).toBe('rectification');
  });

  it('copies without asking when nothing is overwritten, adjusting for 2x upscaling', () => {
    const plan = planScaleCopy(src, photos, new Set(['B', 'F']));
    expect(plan.confirmMessage).toBeNull();
    const byId = new Map(plan.updates.map((p) => [p.photoId, p]));
    expect(byId.get('B')!.calibration).toMatchObject({ mmPerPx: 0.2, source: 'copied', copiedFrom: 'A.jpg' });
    expect(byId.get('F')!.calibration!.mmPerPx).toBeCloseTo(0.1, 12);
  });

  it('asks before replacing measured / rectified / GeoTIFF scales or using a different pixel size', () => {
    const plan = planScaleCopy(src, photos, new Set(['C', 'D', 'E', 'G']));
    expect(plan.overwrites.map((o) => o.source).sort()).toEqual(['geotiff', 'manual', 'rectification']);
    expect(plan.sizeMismatch.map((p) => p.photoId).sort()).toEqual(['D', 'E']);
    expect(plan.confirmMessage).toMatch(/3 of the selected photos already have their own scale/);
    expect(plan.confirmMessage).toMatch(/2 selected photos have a different pixel size/);
  });
});

describe('scale copy actions', () => {
  function ctxFor(confirmAnswer: boolean) {
    const store = new AppStore({ ...createInitialState(), photos, activePhotoId: 'A' });
    const savePhoto = vi.fn(async () => {});
    const confirm = vi.fn(() => confirmAnswer);
    const ctx = {
      store,
      actions: { savePhoto, persistActiveSession: vi.fn(async () => {}), recomputeReports: vi.fn() },
      ui: { confirm, syncViewport: vi.fn(async () => {}), scrollSidebarToTop: vi.fn() },
    } as unknown as EventContext;
    return { store, ctx, savePhoto, confirm };
  }
  const btn = { dataset: {}, closest: () => null } as never;

  it('start: enters photo select mode with the suggested photos selected; nothing changes yet', () => {
    const { store, ctx, savePhoto } = ctxFor(true);
    ACTIONS['copy-scale-start']!(btn, ctx);
    const st = store.getState();
    expect(st.photoSelectMode).toBe(true);
    expect(st.scaleCopySourceId).toBe('A');
    expect([...st.selectedPhotoIds].sort()).toEqual(['B', 'F']);
    expect(st.photos.find((p) => p.photoId === 'C')!.calibration!.mmPerPx).toBe(0.25);
    expect(savePhoto).not.toHaveBeenCalled();
  });

  it('apply: a declined confirmation leaves every photo unchanged', () => {
    const { store, ctx, savePhoto, confirm } = ctxFor(false);
    ACTIONS['copy-scale-start']!(btn, ctx);
    store.setState({ selectedPhotoIds: new Set(['B', 'C']) });
    ACTIONS['copy-scale-apply']!(btn, ctx);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(store.getState().photos.find((p) => p.photoId === 'C')!.calibration!.mmPerPx).toBe(0.25);
    expect(store.getState().photos.find((p) => p.photoId === 'B')!.calibration).toBeUndefined();
    expect(savePhoto).not.toHaveBeenCalled();
  });

  it('apply: copies to the selected photos only, then leaves select mode', async () => {
    const { store, ctx, savePhoto, confirm } = ctxFor(true);
    ACTIONS['copy-scale-start']!(btn, ctx);
    ACTIONS['copy-scale-apply']!(btn, ctx);
    expect(confirm).not.toHaveBeenCalled();
    const st = store.getState();
    expect(st.photos.find((p) => p.photoId === 'B')!.calibration!.source).toBe('copied');
    expect(st.photos.find((p) => p.photoId === 'E')!.calibration).toBeUndefined();
    expect(st.photos.find((p) => p.photoId === 'G')!.calibration!.mmPerPx).toBe(0.3);
    expect(st.photoSelectMode).toBe(false);
    expect(st.scaleCopySourceId).toBeNull();
    await Promise.resolve();
    expect(savePhoto).toHaveBeenCalledTimes(2);
  });

  it('the old one-click "copy to the whole site" action no longer exists', () => {
    expect(ACTIONS['copy-scale-all']).toBeUndefined();
  });
});

describe('2x upscale guard (regression)', () => {
  it('refuses to upscale a photo that Auto image scale would shrink back, with an explanation', () => {
    const enhance = vi.fn(async () => {});
    const store = new AppStore({ ...createInitialState(), photos: [photo('A', 4000, 3000)], activePhotoId: 'A' });
    const ctx = { store, actions: { enhanceActivePhoto: enhance } } as unknown as EventContext;
    ACTIONS['enhance-upscale']!({ dataset: {}, closest: () => null } as never, ctx);
    expect(enhance).not.toHaveBeenCalled();
    expect(store.getState().statusMessage).toMatch(/would not help this photo/);
    store.setState({ photos: [photo('A', 400, 300)] });
    ACTIONS['enhance-upscale']!({ dataset: {}, closest: () => null } as never, ctx);
    expect(enhance).toHaveBeenCalledWith('upscale-2x');
  });
});
