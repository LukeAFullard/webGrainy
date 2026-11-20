/** Two tabs on one project: saves merge field by field instead of reverting each other. */
import { describe, expect, it } from 'vitest';
import * as storage from '../src/modules/projectStorage.js';
import { createSyncedRecords, sameValue, threeWayMerge, type NoticeChannel, type RecordChangeNotice } from '../src/modules/recordSync.js';
import { createProjectMockIDB } from './helpers/projectMockIdb.js';

describe('threeWayMerge', () => {
  it('applies only what this tab changed onto the stored record', () => {
    const base = { a: 1, b: 2, c: { x: 1 } as { x: number } | undefined };
    const mine = { a: 1, b: 3, c: { x: 1 } };
    const theirs = { a: 9, b: 2, c: { x: 5 } };
    expect(threeWayMerge(base, mine, theirs)).toEqual({ a: 9, b: 3, c: { x: 5 } });
  });
  it('removals made here are kept; removals made elsewhere are kept', () => {
    expect(threeWayMerge({ a: 1, b: 2 } as Record<string, number>, { a: 1 }, { a: 1, b: 2, c: 3 })).toEqual({ a: 1, c: 3 });
    expect(threeWayMerge({ a: 1, b: 2 } as Record<string, number>, { a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
  });
  it('without a base or a stored record, saves as given', () => {
    expect(threeWayMerge(undefined, { a: 1 }, { a: 2 })).toEqual({ a: 1 });
    expect(threeWayMerge({ a: 0 }, { a: 1 }, undefined)).toEqual({ a: 1 });
  });
  it('compares Blobs by identity', () => {
    const blob = new Blob(['x']);
    expect(sameValue(blob, blob)).toBe(true);
    expect(sameValue(blob, new Blob(['x']))).toBe(false);
  });
});

function bus(): { channel: () => NoticeChannel; sent: RecordChangeNotice[] } {
  const listeners: Array<(m: RecordChangeNotice) => void> = [];
  const sent: RecordChangeNotice[] = [];
  return {
    sent,
    channel: () => ({
      post: (m) => { sent.push(m); listeners.forEach((l) => l(m)); },
      onMessage: (cb) => listeners.push(cb),
    }),
  };
}

describe('two tabs on one project', () => {
  async function setup() {
    const opts = { indexedDB: createProjectMockIDB() };
    const s = {
      listSites: () => storage.listSites(opts),
      getSite: (id: string) => storage.getSite(id, opts),
      saveSite: (x: storage.SiteRecord) => storage.saveSite(x, opts),
      listSitePhotos: (id: string) => storage.listSitePhotos(id, opts),
      getPhoto: (id: string) => storage.getPhoto(id, opts),
      savePhoto: (x: storage.PhotoRecord) => storage.savePhoto(x, opts),
      deletePhoto: (id: string) => storage.deletePhoto(id, opts),
    };
    await s.saveSite({ siteId: 'S', name: 'Reach', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['p'] });
    await s.savePhoto({ photoId: 'p', siteId: 'S', label: 'p', imageBlob: new Blob([new Uint8Array(4)]), width: 10, height: 10, addedAt: 0, included: true });
    const b = bus();
    const merged: unknown[] = [];
    const tabA = createSyncedRecords(s, { tabId: 'A', channel: b.channel() });
    const tabB = createSyncedRecords(s, { tabId: 'B', channel: b.channel(), hooks: { onMerged: (_k, r) => merged.push(r) } });
    return { s, tabA, tabB, b, merged };
  }

  it('ticking "include" in a tab with an older copy keeps the scale saved in the other tab', async () => {
    const { s, tabA, tabB, b, merged } = await setup();
    const [photoA] = await tabA.listSitePhotos('S');
    const [photoB] = await tabB.listSitePhotos('S'); // tab B's copy: no scale yet
    const calibration = { mmPerPx: 0.4, pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, physicalLengthMm: 40, pixelDistance: 100 };
    await tabA.savePhoto({ ...photoA!, calibration });
    await tabB.savePhoto({ ...photoB!, included: false });
    const stored = await s.getPhoto('p');
    expect(stored?.calibration).toEqual(calibration);
    expect(stored?.included).toBe(false);
    expect(merged).toHaveLength(1); // tab B told to replace its copy
    expect(b.sent.map((m) => [m.from, m.photoIds])).toEqual([['A', ['p']], ['B', ['p']]]);
  });

  it('site settings changed in two tabs are both kept', async () => {
    const { s, tabA, tabB } = await setup();
    const [siteA] = await tabA.listSites();
    const [siteB] = await tabB.listSites();
    await tabA.saveSite({ ...siteA!, surveyDate: '2025-03-01' });
    await tabB.saveSite({ ...siteB!, name: 'Reach renamed' });
    expect(await s.getSite('S')).toMatchObject({ surveyDate: '2025-03-01', name: 'Reach renamed' });
  });
});
