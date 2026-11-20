/** A worker from another build (a newer version took over in another tab) is refused. */
import { describe, expect, it } from 'vitest';
import { BUILD_ID, buildMismatchError } from '../src/modules/buildId.js';
import { OrtWorkerHost, type WorkerLike } from '../src/modules/ortWorkerSession.js';
import { getPhotoResult, runSiteBatch, savePhoto, saveSite } from '../src/modules/projectStorage.js';
import { createProjectMockIDB } from './helpers/projectMockIdb.js';

describe('build mismatch between page and workers', () => {
  it('buildMismatchError: only a different, stated build is a mismatch', () => {
    expect(buildMismatchError(BUILD_ID)).toBeNull();
    expect(buildMismatchError(undefined)).toBeNull();
    expect(buildMismatchError('abc@2026-01-01')?.name).toBe('BuildMismatchError');
  });

  it('the inference worker host refuses replies from another build', async () => {
    const listeners: Array<(ev: MessageEvent) => void> = [];
    const w: WorkerLike = {
      postMessage(msg: unknown) {
        const id = (msg as { id: number }).id;
        setTimeout(() => listeners.forEach((l) => l({ data: { type: 'created', id, build: 'newer@2099' } } as MessageEvent)), 0);
      },
      addEventListener(type, cb) {
        if (type === 'message') listeners.push(cb as (ev: MessageEvent) => void);
      },
      terminate() {},
    };
    const host = new OrtWorkerHost(() => w);
    await expect(host.createSession(new Uint8Array(4).buffer, { wasmPaths: './', simd: true })).rejects.toMatchObject({ name: 'BuildMismatchError' });
  });

  it('a batch stops on a build mismatch and leaves the photo pending', async () => {
    const opts = { indexedDB: createProjectMockIDB() };
    await saveSite({ siteId: 'S', name: 'S', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p1', 'p2'] }, opts);
    for (const id of ['p1', 'p2']) {
      await savePhoto({ photoId: id, siteId: 'S', label: id, imageBlob: new Blob([new Uint8Array(4)]), width: 8, height: 8, addedAt: 0, included: true }, opts);
    }
    const started: string[] = [];
    const engine = { analyzeImage: async () => { throw buildMismatchError('newer@2099')!; } };
    await expect(
      runSiteBatch({ ...opts, siteId: 'S', engine: engine as never, decodeImage: async () => ({ data: new Uint8ClampedArray(256), width: 8, height: 8 }), onPhotoStart: (p) => started.push(p.photoId) }),
    ).rejects.toMatchObject({ name: 'BuildMismatchError' });
    expect(started).toEqual(['p1']);
    expect((await getPhotoResult('p1', opts))?.status).toBe('pending');
  });
});
