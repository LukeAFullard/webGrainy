/** Repeat surveys of a place over time, and like-for-like site comparison. */
import { describe, expect, it } from 'vitest';
import { AnalysisSession } from '../src/modules/analysisSession.js';
import { computeGrainMorphometrics } from '../src/modules/postprocessCore.js';
import {
  comparePercentile,
  comparisonCsv,
  computeComparedSites,
  settingsMismatches,
  surveyChanges,
  type SiteForComparison,
} from '../src/modules/siteComparison.js';
import { groupSitesByPlace, placeName, surveysOfSamePlace } from '../src/modules/sitePlaces.js';
import type { SitePhotoInput } from '../src/modules/siteAnalysis.js';

/** A photo of square grains of side ~`size` px; optional mm scale and model id. */
function photo(id: string, size: number, opts: { mmPerPx?: number; modelId?: 'ig2_unet_fp32' | 'ig2_cpsam_fp16'; count?: number } = {}): SitePhotoInput {
  const count = opts.count ?? 40;
  const per = Math.ceil(Math.sqrt(count));
  const w = per * (size + 6) + 10, h = w;
  const masks = new Int32Array(w * h);
  let g = 0;
  for (let gy = 0; gy < per; gy++) for (let gx = 0; gx < per && g < count; gx++) {
    g++;
    const s = size + ((gx + gy) % 5) - 2;
    // Rectangles 2:1 so the shape summary is not trivial.
    for (let y = 5 + gy * (size + 6); y < 5 + gy * (size + 6) + Math.max(4, Math.round(s / 2)); y++)
      for (let x = 5 + gx * (size + 6); x < 5 + gx * (size + 6) + s; x++) masks[y * w + x] = g;
  }
  const session = new AnalysisSession({
    workingImage: { data: new Uint8ClampedArray(0), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: '1.0x' },
    recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
    masks,
    workingGrains: computeGrainMorphometrics(masks, w, h, 2),
    provenance: { appVersion: 't', ortVersion: 't', analyzedAt: 'x', modelId: opts.modelId ?? 'ig2_unet_fp32', modelFile: 'f', modelRevision: 'r', modelSha256: 's', scaleMode: 'auto', inferencePipeline: 'cellpose' },
    ...(opts.mmPerPx ? { calibration: { mmPerPx: opts.mmPerPx, pointA: { x: 0, y: 0 }, pointB: { x: 1, y: 0 }, physicalLengthMm: opts.mmPerPx, pixelDistance: 1 } } : {}),
  });
  return { photoId: id, label: id, included: true, session };
}

const opts = { poolingMode: 'physical-area' as const, bootstrapReplicates: 200, bootstrapSeed: 1, minBaxisPx: 0 };

describe('places', () => {
  const sites = [
    { siteId: 's1', name: 'Reach 3 spring', place: 'Rakaia reach 3', surveyDate: '2025-10-01' },
    { siteId: 's2', name: 'Reach 3 autumn', place: 'rakaia  reach 3 ', surveyDate: '2025-04-01' },
    { siteId: 's3', name: 'Bar A', place: 'Ashley bar' },
    { siteId: 's4', name: 'Loose', surveyDate: '2024-01-01' },
  ];

  it('groups surveys by place (case and spacing ignored), oldest first, places A-Z, ungrouped last', () => {
    const g = groupSitesByPlace(sites);
    expect(g.map((x) => x.place)).toEqual(['Ashley bar', 'Rakaia reach 3', null]);
    expect(g[1]!.surveys.map((s) => s.siteId)).toEqual(['s2', 's1']);
    expect(placeName('  a   b ')).toBe('a b');
    expect(placeName('   ')).toBeNull();
  });

  it('finds all surveys of the same place', () => {
    expect(surveysOfSamePlace(sites, 's1').sort()).toEqual(['s1', 's2']);
    expect(surveysOfSamePlace(sites, 's4')).toEqual(['s4']);
  });
});

describe('comparison over time and between sites', () => {
  const entry = (siteId: string, name: string, inputs: SitePhotoInput[], extra: Partial<SiteForComparison> = {}): SiteForComparison => ({ siteId, name, inputs, ...extra });

  it('lists the change between consecutive surveys of each place (later / earlier), D16-D84', () => {
    const cmp = computeComparedSites(
      [
        // Five photos per survey: enough for an interval and p-value.
        entry('a2', 'R3 2025', [0, 1, 2, 3, 4].map((k) => photo(`a2p${k}`, 23 + k % 3, { mmPerPx: 1 })), { place: 'R3', surveyDate: '2025-05-01' }),
        entry('a1', 'R3 2024', [0, 1, 2, 3, 4].map((k) => photo(`a1p${k}`, 39 + k % 3, { mmPerPx: 1 })), { place: 'R3', surveyDate: '2024-05-01' }),
        entry('b1', 'Other', [photo('b1p', 30, { mmPerPx: 1 })], { place: 'Elsewhere', surveyDate: '2024-06-01' }),
        entry('c1', 'Undated R3', [photo('c1p', 30, { mmPerPx: 1 })], { place: 'R3' }),
      ],
      opts,
    );
    const ch = surveyChanges(cmp);
    expect(ch).toHaveLength(1); // one consecutive pair; other place and undated survey left out
    expect(ch[0]).toMatchObject({ place: 'R3', fromDate: '2024-05-01', toDate: '2025-05-01', from: 'R3 2024', to: 'R3 2025' });
    expect(ch[0]!.changes.D50.ratio).toBeLessThan(0.75); // finer in 2025
    expect(ch[0]!.changes.D50.p).toBeLessThan(0.05);
    expect(ch[0]!.changes.D50.basis).toBe('photos');
    expect(ch[0]!.changes.D16.key).toBe('D16');
    expect(ch[0]!.changes.D84.ratioLo).toBeLessThan(ch[0]!.changes.D84.ratio);
    const csv = comparisonCsv(cmp, {});
    expect(csv).toContain('survey_change,R3: 2024-05-01 -> 2025-05-01,D50_ratio_later_over_earlier,');
    expect(csv).toContain('site,R3 2025,place,R3,text');
  });

  it('gives no interval or p-value for one-photo surveys, and flags surveys with few photos', () => {
    const cmp = computeComparedSites(
      [
        entry('x1', 'One 2024', [photo('x1p', 40, { mmPerPx: 1 })], { place: 'P', surveyDate: '2024-05-01' }),
        entry('x2', 'One 2025', [photo('x2p', 24, { mmPerPx: 1 })], { place: 'P', surveyDate: '2025-05-01' }),
        entry('y1', 'Three', [0, 1, 2].map((k) => photo(`y1p${k}`, 30 + k, { mmPerPx: 1 })), { place: 'Q', surveyDate: '2024-05-01' }),
        entry('y2', 'Three later', [0, 1, 2].map((k) => photo(`y2p${k}`, 26 + k, { mmPerPx: 1 })), { place: 'Q', surveyDate: '2025-05-01' }),
      ],
      opts,
    );
    const [p, q] = surveyChanges(cmp);
    expect(p!.changes.D50.basis).toBe('single-photo');
    expect(p!.changes.D50.ratio).toBeLessThan(0.75);
    expect(Number.isNaN(p!.changes.D50.p)).toBe(true);
    expect(Number.isNaN(p!.changes.D50.ratioLo)).toBe(true);
    expect(q!.changes.D50.basis).toBe('few-photos');
    expect(Number.isFinite(q!.changes.D50.p)).toBe(true);
    const csv = comparisonCsv(cmp, {});
    expect(csv).toContain('survey_change,P: 2024-05-01 -> 2025-05-01,D50_p_value_approx,,p');
    expect(csv).toContain('survey_change,P: 2024-05-01 -> 2025-05-01,D50_test_basis,single-photo,label');
    expect(csv).not.toContain('NaN');
    expect(csv).toMatch(/warning,\d+,"?One 2024, One 2025: one photo only/);
    expect(csv).toMatch(/Three \(3 photos\), Three later \(3 photos\): fewer than 5 photos/);
    expect(csv).toContain('site,One 2024,bootstrap_mode,single-photo-grain-fallback,mode');
  });

  it('follows a place over time whatever its case or spacing', () => {
    const five = (id: string, size: number) => [0, 1, 2, 3, 4].map((k) => photo(`${id}${k}`, size + (k % 3), { mmPerPx: 1 }));
    const cmp = computeComparedSites(
      [
        entry('r1', 'Survey 1', five('r1p', 40), { place: 'Reach A', surveyDate: '2024-05-01' }),
        entry('r2', 'Survey 2', five('r2p', 30), { place: '  reach   a ', surveyDate: '2025-05-01' }),
      ],
      opts,
    );
    expect(cmp.map((s) => s.place)).toEqual(['Reach A', 'Reach A']);
    const ch = surveyChanges(cmp);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ place: 'Reach A', from: 'Survey 1', to: 'Survey 2' });
  });

  it('tests D16 and D84 as well as D50 between sites', () => {
    const cmp = computeComparedSites([entry('a', 'Fine', [photo('f', 20, { mmPerPx: 1 })]), entry('b', 'Coarse', [photo('c', 44, { mmPerPx: 1 })])], opts);
    for (const k of ['D16', 'D50', 'D84'] as const) {
      const [pair] = comparePercentile(cmp, k);
      expect(pair!.key).toBe(k);
      expect(pair!.ratio).toBeLessThan(0.7);
    }
    expect(comparisonCsv(cmp, {})).toContain('d84_ratio,Fine vs Coarse,ratio,');
  });

  it('compares calibrated sites over the same size range (the largest cutoff of any site)', () => {
    // Close-up site resolves 15 px x 0.2 mm = 3 mm; the distant one 15 px x 1 mm = 15 mm.
    const cmp = computeComparedSites(
      [entry('near', 'Near', [photo('n', 40, { mmPerPx: 0.2 })]), entry('far', 'Far', [photo('f', 40, { mmPerPx: 1 })])],
      { ...opts, minBaxisPx: 15 },
    );
    expect(cmp.map((s) => s.report!.dCutoffCommonMm)).toEqual([15, 15]);
    // Alone, the close-up site keeps its own (smaller) cutoff.
    const alone = computeComparedSites([entry('near', 'Near', [photo('n', 40, { mmPerPx: 0.2 })])], { ...opts, minBaxisPx: 15 });
    expect(alone[0]!.report!.dCutoffCommonMm).toBeCloseTo(3, 9);
  });

  it('warns when the compared surveys were analysed differently', () => {
    const cmp = computeComparedSites(
      [entry('a', 'U-Net survey', [photo('a', 30, { mmPerPx: 1 })]), entry('b', 'SAM survey', [photo('b', 30, { mmPerPx: 1, modelId: 'ig2_cpsam_fp16' })])],
      opts,
    );
    const w = settingsMismatches(cmp);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Different model weights .*U-Net survey: ig2_unet_fp32; SAM survey: ig2_cpsam_fp16/);
    expect(comparisonCsv(cmp, {})).toMatch(/warning,1,"?Different model weights/);
    const same = computeComparedSites([entry('a', 'A', [photo('a', 30, { mmPerPx: 1 })]), entry('b', 'B', [photo('b', 34, { mmPerPx: 1 })])], opts);
    expect(settingsMismatches(same)).toEqual([]);
  });

  it('site reports carry a shape summary (b/a of every grain once)', () => {
    const [s] = computeComparedSites([entry('a', 'A', [photo('a', 30, { mmPerPx: 1 })])], opts);
    expect(s!.report!.shape.n).toBe(s!.report!.validGrainCount);
    expect(s!.report!.shape.aspectRatioCounts.reduce((x, y) => x + y, 0)).toBe(s!.report!.shape.n);
    expect(s!.report!.shape.medianAspectRatio).toBeGreaterThan(0.4);
    expect(s!.report!.shape.medianAspectRatio).toBeLessThan(0.6); // 2:1 rectangles
  });
});

describe('compare view and site panel (UI)', () => {
  it('shows places, change table, composition / shape / fabric charts, all-percentile tests and warnings', async () => {
    const { renderCompareHtml } = await import('../src/ui/panels/compare.js');
    const { createInitialState } = await import('../src/ui/state.js');
    const e = (siteId: string, name: string, inputs: SitePhotoInput[], extra: Partial<SiteForComparison> = {}): SiteForComparison => ({ siteId, name, inputs, ...extra });
    const sites = computeComparedSites(
      [
        e('a1', 'R3 2024', [photo('a1p', 40, { mmPerPx: 1 })], { place: 'R3', surveyDate: '2024-05-01' }),
        e('a2', 'R3 2025', [photo('a2p', 24, { mmPerPx: 1, modelId: 'ig2_cpsam_fp16' })], { place: 'R3', surveyDate: '2025-05-01' }),
      ],
      opts,
    );
    const st = {
      ...createInitialState(),
      dashboardScope: 'compare' as const,
      compareByDate: true,
      sites: [
        { siteId: 'a1', name: 'R3 2024', place: 'R3', surveyDate: '2024-05-01', photoOrder: ['x'] },
        { siteId: 'a2', name: 'R3 2025', place: 'R3', surveyDate: '2025-05-01', photoOrder: ['y'] },
      ] as never,
      comparison: { loading: false, error: null, sites },
    };
    const charts = new Map();
    const html = renderCompareHtml(st as never, true, charts);
    expect(html).toContain('data-action="compare-select-place" data-place="R3"');
    expect(html).toContain('Change between consecutive surveys of each place');
    expect(html).toContain('2024-05-01 → 2025-05-01');
    expect(html).toContain('Not analysed the same way');
    for (const id of ['compare-time', 'compare-psd', 'compare-size', 'compare-composition', 'compare-shape', 'compare-rose-0', 'compare-rose-1']) {
      expect(html, id).toContain(`data-chart-dl="${id}"`);
    }
    expect(html).toContain('<th>D16</th><th>D50</th><th>D84</th>');
    expect(html).toContain('More statistics');
  });

  it('place events: set (reusing an existing spelling), new survey of the place, compare its surveys', async () => {
    const { ACTIONS, routeChange } = await import('../src/ui/events/router.js');
    const { AppStore, createInitialState } = await import('../src/ui/state.js');
    const saved: Array<Record<string, unknown>> = [];
    const store = new AppStore({
      ...createInitialState(),
      activeSiteId: 'b',
      sites: [
        { siteId: 'a', name: 'Spring', place: 'Rakaia reach 3', createdAt: 0, updatedAt: 0, options: { poolingMode: 'equal-photo' }, photoOrder: [] },
        { siteId: 'b', name: 'Autumn', createdAt: 0, updatedAt: 0, options: { poolingMode: 'equal-photo' }, photoOrder: [] },
      ] as never,
    });
    const storage = {
      saveSite: async (s: Record<string, unknown>) => {
        saved.push(s);
        store.setState({ sites: store.getState().sites.map((x) => (x.siteId === s['siteId'] ? (s as never) : x)).concat(store.getState().sites.some((x) => x.siteId === s['siteId']) ? [] : [s as never]) });
      },
      listSites: async () => store.getState().sites,
    };
    const refreshComparison = async () => {};
    const ctx = {
      store, storage, makeId: () => 'site_new',
      actions: { loadSiteData: async () => {}, refreshComparison },
      ui: { askSiteName: (_m: string, d: string) => d },
    } as never;
    routeChange({ tagName: 'INPUT', type: 'text', value: '  rakaia REACH 3 ', dataset: { sitePlace: '' }, closest: () => null } as never, ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(saved[0]).toMatchObject({ siteId: 'b', place: 'Rakaia reach 3' });

    ACTIONS['new-survey']!({ dataset: {}, closest: () => null } as never, ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(saved[1]).toMatchObject({ siteId: 'site_new', place: 'Rakaia reach 3', name: 'Rakaia reach 3 – survey 3', options: { poolingMode: 'equal-photo' } });

    ACTIONS['compare-place']!({ dataset: {}, closest: () => null } as never, ctx);
    expect(store.getState().dashboardScope).toBe('compare');
    expect(store.getState().compareByDate).toBe(true);
    expect([...(store.getState().compareSiteIds ?? [])].sort()).toEqual(['a', 'b', 'site_new']);
  });

  it('the place survives a project archive; an invalid place is dropped', async () => {
    const { exportProjectArchive, importProjectArchive, getSite, saveSite } = await import('../src/modules/projectStorage.js');
    const { createProjectMockIDB } = await import('./helpers/projectMockIdb.js');
    const a = { indexedDB: createProjectMockIDB() };
    await saveSite({ siteId: 'S', name: 'S', place: 'R3', createdAt: 0, updatedAt: 0, options: { poolingMode: 'physical-area' }, photoOrder: [] }, a);
    const b = { indexedDB: createProjectMockIDB() };
    await importProjectArchive(await exportProjectArchive('S', a), b);
    expect((await getSite('S', b))?.place).toBe('R3');
    const v1 = { format: 'webgrainy-project', version: 1, site: { siteId: 'T', name: 'T', place: 42, photoOrder: [], options: {} }, photos: [], results: [] };
    const c = { indexedDB: createProjectMockIDB() };
    await importProjectArchive(JSON.stringify(v1), c);
    expect((await getSite('T', c))?.place).toBeUndefined();
  });
});

describe('site panel (UI)', () => {
  it('groups the site picker by place and offers new survey / compare over time', async () => {
    const { siteOptionsHtml, placeHtml } = await import('../src/ui/panels/sidebar.js');
    const { createInitialState } = await import('../src/ui/state.js');
    const st = {
      ...createInitialState(),
      activeSiteId: 'a',
      sites: [
        { siteId: 'a', name: 'Spring', place: 'R3', surveyDate: '2025-10-01', photoOrder: [] },
        { siteId: 'b', name: 'Autumn', place: 'R3', surveyDate: '2025-04-01', photoOrder: ['p'] },
        { siteId: 'c', name: 'Loose', photoOrder: [] },
      ] as never,
    };
    const opts = siteOptionsHtml(st as never);
    expect(opts).toMatch(/<optgroup label="R3">.*2025-04-01 · Autumn.*2025-10-01 · Spring.*<\/optgroup><optgroup label="Other sites">.*Loose/s);
    const place = placeHtml(st as never);
    expect(place).toContain('data-site-place');
    expect(place).toContain('data-action="new-survey"');
    expect(place).toContain('Compare 2 surveys over time');
  });
});
