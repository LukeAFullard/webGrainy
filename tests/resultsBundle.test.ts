import { afterEach, describe, expect, it } from 'vitest';
import { buildResultsBundle } from '../src/modules/resultsBundle.js';
import { buildExport } from '../src/modules/exports.js';
import { analyzeSite, type SitePhotoInput } from '../src/modules/siteAnalysis.js';
import { importProjectArchive, listSites, savePhoto, savePhotoResult, saveSite, type PhotoRecord, type SiteRecord } from '../src/modules/projectStorage.js';
import { squareGrainSession } from './helpers/squareSession.js';
import { createProjectMockIDB } from './helpers/projectMockIdb.js';
import { readZip } from './helpers/readZip.js';

const site: SiteRecord = { siteId: 'S', name: 'Reach 3, spring', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: ['a', 'b', 'c'], place: 'Rakaia' };
const photo = (id: string, label: string): PhotoRecord => ({ photoId: id, siteId: 'S', label, imageBlob: new Blob([new Uint8Array(16)], { type: 'image/png' }), width: 600, height: 600, addedAt: 0, included: true });
const photos = [photo('a', 'IMG_1.jpg'), photo('b', 'IMG_1.jpg'), photo('c', 'not analysed.jpg')];
const inputs = (): SitePhotoInput[] =>
  ['a', 'b'].map((id) => ({ photoId: id, label: 'IMG_1.jpg', included: true, session: squareGrainSession([20, 24, 28, 32, 36, 40], { mmPerPx: 0.5 }) }));
const realIdb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
afterEach(() => { (globalThis as { indexedDB?: IDBFactory }).indexedDB = realIdb; });

describe('Download results (.zip)', () => {
  it('contains the site and per-photo files, identical to the single exports, and a README', async () => {
    const siteInputs = inputs();
    const report = analyzeSite(siteInputs, { poolingMode: 'physical-area', bootstrapReplicates: 20, minBaxisPx: 0 });
    const common = { site, photos, siteInputs, siteReport: report, siteOptions: { poolingMode: 'physical-area' as const, minBaxisPx: 0 }, sizeMetric: 'bAxis' as const, psdXAxis: 'mm' as const, now: new Date('2026-11-20T10:00:00Z') };
    const { blob, filename } = await buildResultsBundle({ ...common, includeProject: false, reportHtml: '<html>report</html>' });
    expect(filename).toBe('Reach_3_spring_results_2026-11-20.zip');
    const files = readZip(new Uint8Array(await blob.arrayBuffer()));
    expect([...files.keys()].sort()).toEqual([
      'README.txt', 'photos/IMG_1/grains.csv', 'photos/IMG_1/mask16.png', 'photos/IMG_1/outlines.geojson', 'photos/IMG_1/summary.csv',
      'photos/IMG_1_b/grains.csv', 'photos/IMG_1_b/mask16.png', 'photos/IMG_1_b/outlines.geojson', 'photos/IMG_1_b/summary.csv',
      'site_pooled_grains.csv', 'site_report.html', 'site_summary.csv', 'site_summary.json',
    ]);
    const readme = new TextDecoder().decode(files.get('README.txt'));
    expect(readme).toContain('webGrainy results: Reach 3, spring');
    expect(readme).toContain('cannot be reopened in webGrainy');
    // Same bytes as the single-file export (exportedAt aside, summary rows are deterministic).
    const pooled = await (await buildExport('site-grains-csv', { site, photo: null, session: null, siteReport: report, siteInputs, psdXAxis: 'mm', siteOptions: common.siteOptions }))!.blob.text();
    const strip = (t: string) => t.split('\n').filter((l) => !l.includes('exportedAt')).join('\n');
    expect(strip(new TextDecoder().decode(files.get('site_pooled_grains.csv')))).toBe(strip(pooled));
  });

  it('with the checkbox, adds a project file that reopens the site', async () => {
    const idb = createProjectMockIDB();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = idb;
    await saveSite(site);
    for (const p of photos) await savePhoto(p);
    const siteInputs = inputs();
    for (const i of siteInputs) await savePhotoResult({ photoId: i.photoId, status: 'done', serializedSession: i.session.toSerialized(), updatedAt: 0 });
    const { blob } = await buildResultsBundle({ site, photos, siteInputs, siteReport: null, siteOptions: {}, sizeMetric: 'bAxis', psdXAxis: 'mm', includeProject: true });
    const files = readZip(new Uint8Array(await blob.arrayBuffer()));
    const project = files.get('Reach_3_spring.webgrainy');
    expect(project).toBeDefined();
    expect(new TextDecoder().decode(files.get('README.txt'))).toContain('reopens this site');
    const target = createProjectMockIDB();
    const id = await importProjectArchive(new Blob([project!.slice().buffer]), { indexedDB: target });
    expect((await listSites({ indexedDB: target })).map((s) => s.siteId)).toEqual([id]);
  });

  it('never gives two photos the same folder, even when a label matches a generated folder (audit S10)', async () => {
    // 'IMG_1_b' comes first, so the suffix generated for the second IMG_1 (photo id 'b') is taken.
    const labels: Array<[string, string]> = [['c', 'IMG_1_b.jpg'], ['a', 'IMG_1.jpg'], ['b', 'IMG_1.png'], ['d', 'IMG_1.tif']];
    const ph = labels.map(([id, label]) => photo(id, label));
    const siteInputs: SitePhotoInput[] = labels.map(([id, label]) => ({ photoId: id, label, included: true, session: squareGrainSession([20, 24], { mmPerPx: 0.5 }) }));
    const { blob } = await buildResultsBundle({ site, photos: ph, siteInputs, siteReport: null, siteOptions: {}, sizeMetric: 'bAxis', psdXAxis: 'mm', includeProject: false });
    const files = readZip(new Uint8Array(await blob.arrayBuffer())); // a duplicate name would throw
    const dirs = new Set([...files.keys()].filter((k) => k.endsWith('/grains.csv')));
    expect(dirs.size).toBe(4);
    const readme = new TextDecoder().decode(files.get('README.txt'));
    expect(readme).toContain('%7C');
  });
});
