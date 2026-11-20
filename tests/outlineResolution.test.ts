import { describe, expect, it } from 'vitest';
import { outlineResolutionWarningHtml, renderDownloadResultsModalHtml } from '../src/ui/modals.js';
import { createInitialState } from '../src/ui/state.js';
import { resultsBundleEntries } from '../src/modules/resultsBundle.js';
import { squareGrainSession } from './helpers/squareSession.js';

describe('outline resolution warnings', () => {
  it('reports the outline step in photo pixels and mm', () => {
    const r = squareGrainSession([20, 30], { scale: 0.25, mmPerPx: 0.5 }).getOutlineResolution();
    expect(r).toMatchObject({ workingWidth: 600, workingHeight: 600, stepPhotoPx: 4, stepMm: 2, coarse: true });
    expect(squareGrainSession([20]).getOutlineResolution().coarse).toBe(false);
  });

  it('warns in the export dialog only when outlines are coarser than the photo', () => {
    const coarse = outlineResolutionWarningHtml(squareGrainSession([20, 30], { scale: 0.25, mmPerPx: 0.5 }) as never);
    expect(coarse).toContain('600 × 600 px working copy of this 2,400 × 2,400 px photo');
    expect(coarse).toContain('each outline step is 4 photo pixels (2 mm)');
    expect(outlineResolutionWarningHtml(squareGrainSession([20]) as never)).toBe('');
  });

  it('warns in the download dialog and README, and says coordinates are photo pixels', async () => {
    const session = squareGrainSession([20, 30], { scale: 0.25 });
    const photo = { photoId: 'p', siteId: 's', label: 'big.tif', imageBlob: new Blob([]), width: 2400, height: 2400, addedAt: 0, included: true };
    const st = { ...createInitialState(), photos: [photo], sessions: new Map([['p', session]]) };
    expect(renderDownloadResultsModalHtml(st as never)).toMatch(/stepped at up to 4 photo pixels/);
    const entries = await resultsBundleEntries({
      site: { siteId: 's', name: 'S', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p'] },
      photos: [photo], siteInputs: [{ photoId: 'p', label: 'big.tif', included: true, session }], siteReport: null,
      siteOptions: {}, sizeMetric: 'bAxis', psdXAxis: 'mm', includeProject: false,
    });
    const readme = entries.find((e) => e.name === 'README.txt')!.data as string;
    expect(readme).toContain('not map coordinates');
    expect(readme).toContain('photos/big/: one outline step = 4.0 photo px');
  });

  it("records the outline step in every export's metadata", () => {
    const meta = squareGrainSession([20], { scale: 0.25 }).getExportMetadata() as { image: Record<string, unknown> };
    expect(meta.image['outlineStepPhotoPx']).toBe(4);
    expect(String(meta.image['coordinateSystem'])).toContain('not georeferenced');
  });
});
