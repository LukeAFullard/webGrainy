import { describe, expect, it } from 'vitest';
import { getPhotoResult, isStorageFullError, runSiteBatch, savePhoto, saveSite, StorageFullError } from '../src/modules/projectStorage.js';
import { createProjectMockIDB } from './helpers/projectMockIdb.js';

async function setup() {
  const opts = { indexedDB: createProjectMockIDB() };
  await saveSite({ siteId: 'S', name: 'S', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p1', 'p2', 'p3'] }, opts);
  for (const id of ['p1', 'p2', 'p3']) {
    await savePhoto({ photoId: id, siteId: 'S', label: id, imageBlob: new Blob([new Uint8Array(4)]), width: 8, height: 8, addedAt: 0, included: true }, opts);
  }
  return opts;
}
const decodeImage = async () => ({ data: new Uint8ClampedArray(256), width: 8, height: 8 });

describe('runSiteBatch error classification', () => {
  it('records an engine failure whose message contains "abort" as an error, not a cancel', async () => {
    const opts = await setup();
    const started: string[] = [];
    const engine = { analyzeImage: async () => { throw new Error('Aborted(). Build with -sASSERTIONS for more info.'); } };
    const res = await runSiteBatch({ ...opts, siteId: 'S', engine: engine as never, decodeImage, onPhotoStart: (p) => started.push(p.photoId) });
    expect(res.aborted).toBe(false);
    expect(res.failed).toBe(3);
    expect(started).toEqual(['p1', 'p2', 'p3']);
    const r = await getPhotoResult('p1', opts);
    expect(r?.status).toBe('error');
    expect(r?.errorMessage).toMatch(/Out of memory/);
    expect(r?.errorMessage).toContain('Aborted()');
  });

  it('still treats an AbortError as a cancel', async () => {
    const opts = await setup();
    const engine = { analyzeImage: async () => { throw new DOMException('Analysis aborted', 'AbortError'); } };
    const res = await runSiteBatch({ ...opts, siteId: 'S', engine: engine as never, decodeImage });
    expect(res.aborted).toBe(true);
    expect(res.failed).toBe(0);
    expect((await getPhotoResult('p1', opts))?.status).toBe('pending');
  });

  it('keeps ordinary error messages unchanged', async () => {
    const opts = await setup();
    const engine = { analyzeImage: async () => { throw new Error('Image could not be decoded'); } };
    await runSiteBatch({ ...opts, siteId: 'S', engine: engine as never, decodeImage });
    expect((await getPhotoResult('p2', opts))?.errorMessage).toBe('Image could not be decoded');
  });
});

describe('runSiteBatch when browser storage is full', () => {
  it('keeps the finished analysis in the page and stops with a clear message', async () => {
    let full = false;
    const opts = { indexedDB: createProjectMockIDB({ failPut: (store, v) => full && store === 'results' && (v as { status?: string }).status === 'done' }) };
    await saveSite({ siteId: 'S', name: 'S', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p1', 'p2', 'p3'] }, opts);
    for (const id of ['p1', 'p2', 'p3']) {
      await savePhoto({ photoId: id, siteId: 'S', label: `${id}.jpg`, imageBlob: new Blob([new Uint8Array(4)]), width: 8, height: 8, addedAt: 0, included: true }, opts);
    }
    const { squareGrainSession } = await import('./helpers/squareSession.js');
    let n = 0;
    const engine = { analyzeImage: async () => { if (++n === 2) full = true; return squareGrainSession([20, 30]); } };
    const completed: string[] = [];
    const err = await runSiteBatch({
      ...opts, siteId: 'S', engine: engine as never,
      decodeImage: async () => ({ data: new Uint8ClampedArray(256), width: 8, height: 8 }),
      onPhotoComplete: (p) => completed.push(p.photoId),
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as Error).message).toMatch(/Browser storage is full: p2\.jpg was analysed but could not be saved/);
    expect(completed).toEqual(['p1', 'p2']); // p2's results stay in the page
    expect((await getPhotoResult('p1', opts))?.status).toBe('done');
    expect((await getPhotoResult('p2', opts))?.status).toBe('running'); // re-analysed next time
    expect(await getPhotoResult('p3', opts)).toBeUndefined();
  });

  it('recognises the browser storage-full errors', () => {
    expect(isStorageFullError(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))).toBe(true);
    expect(isStorageFullError(new Error('QuotaExceededError: mock put failure'))).toBe(true);
    expect(isStorageFullError(new Error('Image could not be decoded'))).toBe(false);
  });
});
