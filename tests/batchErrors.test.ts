import { describe, expect, it } from 'vitest';
import { getPhotoResult, runSiteBatch, savePhoto, saveSite } from '../src/modules/projectStorage.js';
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
