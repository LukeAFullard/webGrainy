/**
 * Regression tests for the 2026-11 production-readiness review findings.
 */
import { describe, expect, it } from 'vitest';
import { computeFabricRoseStats } from '../src/modules/morphometricsExt.js';
import { majorAxisDirection, orientationFromMoments } from '../src/modules/orientationGeometry.js';
import { renderCompositionBarsSvg, renderConvergenceChartSvg, renderFabricRoseSvg, renderPrintablePsdSvg } from '../src/ui/charts.js';
import type { GrainMorphometrics } from '../src/types/index.js';
import { validateSiteCalibration } from '../src/modules/siteCalibration.js';
import type { SitePhotoInput } from '../src/modules/siteTypes.js';
import { comparisonStatistics } from '../src/ui/compareReport.js';
import type { ComparisonView } from '../src/ui/comparisonView.js';
import { createHash } from 'node:crypto';
import { buildValidBedMask } from '../src/modules/roiAndRectify.js';
import { analyzeSite } from '../src/modules/siteAnalysis.js';
import { siteReportProvenance } from '../src/modules/siteProvenance.js';
import { buildSiteReportHtml } from '../src/ui/report.js';
import { squareGrainSession } from './helpers/squareSession.js';
import { readFileSync } from 'node:fs';
import pako from 'pako';
import { decodeTiffBuffer, validateTiffStructure } from '../src/modules/tiffDecode.js';
import { PARAM_RANGES, parseParamInput, sanitizeAnalysisParams } from '../src/ui/savedSettings.js';
import { POSTPROCESS_LIMITS } from '../src/modules/postprocessCore.js';
import { PRINT_SCRIPT_SHA256, PRINT_SCRIPT_SOURCE, REPORT_CSP, reportDocument } from '../src/ui/report.js';

function grainAt(id: number, orientationRad: number): GrainMorphometrics {
  return {
    id,
    areaPx: 100,
    centroidX: 20,
    centroidY: 20,
    aAxisPx: 14,
    bAxisPx: 4,
    dEqPx: 11.28,
    orientationRad,
    touchesBorder: false,
    bbox: [15, 15, 25, 25],
  };
}

function meanLineDirection(svg: string): { dx: number; dy: number } {
  const m = /<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)" stroke="#d98300"/.exec(svg);
  if (!m) throw new Error('no mean-orientation line');
  const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number];
  const len = Math.hypot(x2 - x1, y2 - y1);
  return { dx: (x2 - x1) / len, dy: (y2 - y1) / len };
}

describe('F-01: fabric rose is drawn the same way round as the grains', () => {
  for (const [label, covXY] of [['\\ (top-left to bottom-right)', 1], ['/ (bottom-left to top-right)', -1]] as const) {
    it(`a ${label} grain plots its mean line parallel to the grain's major axis`, () => {
      // Pixels along y = x (covXY > 0) or y = -x (covXY < 0), slightly thickened.
      const theta = orientationFromMoments(10, 10, 9 * covXY);
      const grains = Array.from({ length: 12 }, (_, i) => grainAt(i + 1, theta));
      const rose = computeFabricRoseStats(grains);
      const axis = majorAxisDirection(theta);
      const drawn = meanLineDirection(renderFabricRoseSvg(rose));
      // Axial data: parallel or anti-parallel.
      expect(Math.abs(axis.dx * drawn.dx + axis.dy * drawn.dy)).toBeCloseTo(1, 2);
    });
  }

  it('puts the 90° label on the left, where a counter-clockwise 90° grain points', () => {
    const svg = renderFabricRoseSvg(computeFabricRoseStats([grainAt(1, Math.PI / 2)]));
    const m = /<text x="([\d.]+)" y="[\d.]+" text-anchor="end"[^>]*>90°<\/text>/.exec(svg);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(160);
  });
});

function fakePhoto(id: string, mmPerPx?: number): SitePhotoInput {
  const session = { getCalibration: () => (mmPerPx === undefined ? undefined : { mmPerPx }) };
  return { photoId: id, label: id, included: true, session } as unknown as SitePhotoInput;
}

describe('F-02: "Compare in pixels" is honoured for calibrated sites', () => {
  it('returns px when pixels are requested even though every photo is calibrated', () => {
    const v = validateSiteCalibration([fakePhoto('a', 0.5), fakePhoto('b', 0.4)], { poolingMode: 'physical-area', unit: 'px' });
    expect(v.valid).toBe(true);
    expect(v.unit).toBe('px');
  });

  it('still uses mm by default when every photo is calibrated', () => {
    expect(validateSiteCalibration([fakePhoto('a', 0.5)]).unit).toBe('mm');
  });

  it('labels the report from the unit actually used', () => {
    const mmView = { plotted: [], unit: 'mm', commonCutoffMm: null } as unknown as ComparisonView;
    const row = comparisonStatistics({}, mmView, true).find(([k]) => k === 'Compared in');
    expect(row?.[1]).toBe('mm');
    const pxView = { plotted: [], unit: 'px', commonCutoffMm: null } as unknown as ComparisonView;
    expect(comparisonStatistics({}, pxView, true).find(([k]) => k === 'Compared in')?.[1]).toMatch(/^pixels/);
  });
});

describe('F-06: printable report footer and CSP', () => {
  it('no control character can end the CSS footer string', () => {
    const html = reportDocument('t', 'Reach\f}}body{background:red}/*\u000b\u2028x', '<p>body</p>');
    const footer = /content: "([^"]*)"; font/.exec(html)?.[1] ?? '';
    expect(footer).not.toMatch(/[\u0000-\u001f\u2028]/);
    expect(footer).toContain('}}body{background:red}');
    // Still one @page rule: the injected braces stayed inside the string.
    expect(html.match(/@bottom-left \{ content: "[^"]*"; font/g)).toHaveLength(1);
  });

  it('carries a CSP that blocks the network and allows only the Print script', () => {
    const html = reportDocument('t', 'f', '');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(REPORT_CSP).toMatch(/default-src 'none'/);
    expect(createHash('sha256').update(PRINT_SCRIPT_SOURCE).digest('base64')).toBe(PRINT_SCRIPT_SHA256);
  });
});

describe('F-09: composition chart is well-formed XML', () => {
  it('escapes "<" in the class labels', () => {
    const svg = renderCompositionBarsSvg([{ name: 'A & <B>', color: '#000', w: { sandPct: 30, gravelPct: 40, cobblePct: 20, boulderPct: 10 } }]);
    // A "<" not starting a tag name or closing tag is a fatal XML error (breaks SVG / PNG export).
    expect(svg).not.toMatch(/<(?![a-zA-Z/])/);
    expect(svg).toContain('Sand (&lt; 2 mm)');
  });
});

describe('F-14: settings the UI accepts are settings the analysis accepts', () => {
  it('rejects a seed density below 1', () => {
    expect(parseParamInput('minSeedDensity', '0')).toHaveProperty('error');
    expect(parseParamInput('minSeedDensity', '0.5')).toHaveProperty('error');
    expect(parseParamInput('minSeedDensity', '1')).toEqual({ value: 1 });
    expect(sanitizeAnalysisParams({ minSeedDensity: 0 }).minSeedDensity).not.toBe(0);
  });

  it('every UI range lies inside the post-processing limits', () => {
    for (const [key, range] of Object.entries(PARAM_RANGES)) {
      const lim = (POSTPROCESS_LIMITS as Record<string, readonly [number, number, boolean]>)[key];
      if (!lim || !range) continue;
      expect(range[0], key).toBeGreaterThanOrEqual(lim[0]);
      expect(range[1], key).toBeLessThanOrEqual(lim[1]);
    }
  });
});

/** A little-endian TIFF: one IFD at offset 8 with the given entries, then `extra` bytes. */
function tiff(entries: Array<[tag: number, type: number, num: number, value: number]>, opts: { next?: number; extra?: Uint8Array } = {}): ArrayBuffer {
  const ifdBytes = 2 + entries.length * 12 + 4;
  const extra = opts.extra ?? new Uint8Array(0);
  const buf = new ArrayBuffer(8 + ifdBytes + extra.length);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, num, value], i) => {
    const e = 10 + i * 12;
    dv.setUint16(e, tag, true);
    dv.setUint16(e + 2, type, true);
    dv.setUint32(e + 4, num, true);
    if (type === 3 && num === 1) dv.setUint16(e + 8, value, true);
    else dv.setUint32(e + 8, value, true);
  });
  dv.setUint32(10 + entries.length * 12, opts.next ?? 0, true);
  new Uint8Array(buf).set(extra, 8 + ifdBytes);
  return buf;
}
const dataStart = (nEntries: number): number => 8 + 2 + nEntries * 12 + 4;

describe('F-07: hostile TIFFs are refused instead of hanging the tab', () => {
  it('the 26-byte TIFF whose IFD chain points back to itself', () => {
    const buf = tiff([[256, 3, 1, 1]], { next: 8 });
    expect(buf.byteLength).toBe(26);
    expect(() => decodeTiffBuffer(buf)).toThrow(/damaged or not a valid TIFF/);
  });

  it('sub-IFD lists that point to the same IFD many times', () => {
    // SubIFDs (330) with 4 offsets, all pointing back at the IFD itself.
    const at = dataStart(1);
    const extra = new Uint8Array(16);
    new DataView(extra.buffer).setUint32(0, 8, true);
    for (let i = 0; i < 4; i++) new DataView(extra.buffer).setUint32(i * 4, 8, true);
    expect(() => validateTiffStructure(tiff([[330, 4, 4, at]], { extra }))).toThrow(/referenced twice/);
  });

  it('a tag claiming billions of values', () => {
    expect(() => validateTiffStructure(tiff([[273, 4, 0xffffffff, 8]]))).toThrow(/past the end/);
  });

  it('zero tile sizes', () => {
    const buf = tiff([[256, 3, 1, 4], [257, 3, 1, 4], [258, 3, 1, 8], [277, 3, 1, 1], [322, 3, 1, 0], [323, 3, 1, 0], [324, 4, 1, 8], [325, 4, 1, 1]]);
    expect(() => decodeTiffBuffer(buf)).toThrow(/tile size/);
  });

  it('a DEFLATE strip that expands far beyond the frame', () => {
    const bomb = pako.deflate(new Uint8Array(20_000_000)) as Uint8Array;
    const n = 9;
    const buf = tiff(
      [[256, 3, 1, 10], [257, 3, 1, 10], [258, 3, 1, 8], [259, 3, 1, 8], [262, 3, 1, 1], [273, 4, 1, dataStart(n)], [277, 3, 1, 1], [278, 3, 1, 10], [279, 4, 1, bomb.length]],
      { extra: bomb },
    );
    expect(() => decodeTiffBuffer(buf)).toThrow(/expands far beyond/);
  });

  it('a small valid DEFLATE TIFF still decodes', () => {
    const px = new Uint8Array(100).map((_, i) => i * 2);
    const z = pako.deflate(px) as Uint8Array;
    const n = 9;
    const buf = tiff(
      [[256, 3, 1, 10], [257, 3, 1, 10], [258, 3, 1, 8], [259, 3, 1, 8], [262, 3, 1, 1], [273, 4, 1, dataStart(n)], [277, 3, 1, 1], [278, 3, 1, 10], [279, 4, 1, z.length]],
      { extra: z },
    );
    const img = decodeTiffBuffer(buf);
    expect([img.width, img.height]).toEqual([10, 10]);
    expect(img.data[4 * 7]).toBe(14);
  });
});

describe('F-10: colour tokens work without light-dark()', () => {
  it('the @supports fallback defines every light-dark() token with the same light and dark values', () => {
    const css = readFileSync(new URL('../src/ui/main.css', import.meta.url), 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('@supports not (color: light-dark('));
    const tokens = [...root.matchAll(/^\s*(--[\w-]+):\s*light-dark\((.+)\);\s*$/gm)].map((m) => {
      const args = m[2]!;
      let depth = 0;
      let cut = -1;
      for (let i = 0; i < args.length && cut < 0; i++) {
        if (args[i] === '(') depth++;
        else if (args[i] === ')') depth--;
        else if (args[i] === ',' && depth === 0) cut = i;
      }
      return { name: m[1]!, light: args.slice(0, cut).trim(), dark: args.slice(cut + 1).trim() };
    });
    expect(tokens.length).toBeGreaterThan(20);
    const fallback = css.slice(css.indexOf('@supports not (color: light-dark('));
    const media = fallback.indexOf('@media (prefers-color-scheme: light)');
    const darkPart = fallback.slice(0, media);
    const lightPart = fallback.slice(media);
    for (const t of tokens) {
      expect(darkPart, t.name).toContain(`${t.name}: ${t.dark};`);
      expect(lightPart, t.name).toContain(`${t.name}: ${t.light};`);
    }
    // Outside :root, light-dark() would have no fallback.
    expect(css.slice(css.indexOf('@supports not')).match(/light-dark\(/g)).toHaveLength(1);
  });
});

describe('F-12: switching photos quickly never shows or leaks a stale decode', () => {
  it('a slow decode of an earlier photo is closed, not drawn, when a later photo finished first', async () => {
    const { CanvasViewport } = await import('../src/ui/canvasViewport.js');
    const resolvers = new Map<Blob, (b: ImageBitmap) => void>();
    const closed: string[] = [];
    const g = globalThis as { createImageBitmap?: unknown };
    const saved = g.createImageBitmap;
    g.createImageBitmap = (blob: Blob) => new Promise((res) => resolvers.set(blob, res));
    try {
      const view = { photo: null, session: null, imageBitmap: null as unknown, maskDirty: false, photoLoadSeq: 0, fitToScreen: () => {}, render: () => {} };
      const blobA = new Blob(['a']);
      const blobB = new Blob(['b']);
      const bmp = (name: string) => ({ name, close: () => closed.push(name) }) as unknown as ImageBitmap;
      const call = (photoId: string, imageBlob: Blob) =>
        CanvasViewport.prototype.setPhotoAndSession.call(view as never, { photoId, imageBlob } as never, null);
      const a = call('A', blobA);
      const b = call('B', blobB);
      resolvers.get(blobB)!(bmp('B'));
      await b;
      resolvers.get(blobA)!(bmp('A'));
      await a;
      expect((view.imageBitmap as { name: string }).name).toBe('B');
      expect(closed).toEqual(['A']);
    } finally {
      g.createImageBitmap = saved;
    }
  });
});

describe('F-18: Virtual Wolman Grid mean diameters use every grain once', () => {
  it('D[1,0], D[3,2] and D[4,3] match the number-weighted mode on the same photos', () => {
    const inputs = [
      { photoId: 'a', label: 'a', included: true, session: squareGrainSession([20, 24, 30, 40, 60, 90], { mmPerPx: 0.5 }) },
      { photoId: 'b', label: 'b', included: true, session: squareGrainSession([22, 26, 34, 50, 70, 110], { mmPerPx: 0.5 }) },
    ] as SitePhotoInput[];
    const base = { minBaxisPx: 10, bootstrapReplicates: 20 };
    const grid = analyzeSite(inputs, { ...base, poolingMode: 'virtual-wolman-grid' }).extra!;
    const num = analyzeSite(inputs, { ...base, poolingMode: 'number-weighted' }).extra!;
    expect(grid.arithmeticMeanD10).toBeCloseTo(num.arithmeticMeanD10, 9);
    expect(grid.sauterMeanD32).toBeCloseTo(num.sauterMeanD32, 9);
    expect(grid.deBrouckereMeanD43).toBeCloseTo(num.deBrouckereMeanD43, 9);
    expect(grid.n).toBe(num.n);
  });
});

describe('F-20: reports state the size cutoff actually applied', () => {
  it('a Field-count cutoff above the detection limit is the "not counted" size', () => {
    const inputs = [
      { photoId: 'a', label: 'a', included: true, session: squareGrainSession([20, 30, 40, 60, 80, 100], { mmPerPx: 0.5 }) },
    ] as SitePhotoInput[];
    const opts = { poolingMode: 'physical-area' as const, minBaxisPx: 10, minSizeMm: 16, bootstrapReplicates: 20 };
    const report = analyzeSite(inputs, opts);
    const prov = siteReportProvenance(inputs, report, opts);
    expect(prov.detectionLimit!).toBeLessThan(16);
    expect(prov.sizeCutoff).toBeCloseTo(16, 9);
    const html = buildSiteReportHtml({
      site: { siteId: 's', name: 'S', createdAt: 0, updatedAt: 0, options: opts, photoOrder: ['a'] },
      report, generatedAt: '2026-01-01T00:00:00Z', metadata: {}, settings: [], psdSvg: '', histogramSvg: '', photos: [],
      detectionLimit: prov.detectionLimit!, sizeCutoff: prov.sizeCutoff!,
    });
    expect(html).toContain('grains below ~16.0 mm are not counted');
    expect(html).toContain('grains smaller than ~16.0 mm (the lower size cutoff)');
  });
});

describe('F-21: clast packing is the same in the Photo view and the Site breakdown', () => {
  it('counts every detected grain inside the ROI, including grains at the photo edge and below the cutoffs', async () => {
    const { AnalysisSession } = await import('../src/modules/analysisSession.js');
    const { computeGrainMorphometrics } = await import('../src/modules/postprocessCore.js');
    const w = 200, h = 200;
    const masks = new Int32Array(w * h);
    const square = (id: number, x0: number, y0: number, side: number): void => {
      for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) masks[y * w + x] = id;
    };
    square(1, 20, 20, 40);
    square(2, 80, 80, 50);
    square(3, 150, 100, 8); // below the size cutoff
    square(4, 0, 170, 30); // touches the photo edge
    const session = new AnalysisSession({
      workingImage: { data: new Uint8ClampedArray(0), width: w, height: h, originalWidth: w, originalHeight: h, effectiveScaleFactor: 1, scaleModeApplied: 'full' } as never,
      recommendation: { model: 'unet', confidence: 1, reason: 't', metrics: {} } as never,
      masks,
      workingGrains: computeGrainMorphometrics(masks, w, h, 2),
    });
    const roi = { exclusionPolygons: [[{ x: 150, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 50 }, { x: 150, y: 50 }]], exclusionStrokes: [] };
    session.setRoiConfig(roi);
    const photoView = session.getRoiFilterResult()!.clastPackingPct;
    const report = analyzeSite([{ photoId: 'a', label: 'a', included: true, session, roiConfig: roi }] as SitePhotoInput[], {
      poolingMode: 'number-weighted', unit: 'px', minBaxisPx: 20, bootstrapReplicates: 20,
    });
    expect(report.perPhoto[0]!.clastPackingPct).toBeCloseTo(photoView, 9);
    // 40² + 50² + 8² + 30² px over the 200² photo minus the 50² excluded corner.
    expect(photoView).toBeCloseTo(((1600 + 2500 + 64 + 900) / (40000 - 2500)) * 100, 1);
  });
});

describe('F-22: chart CI labels follow the chosen confidence level', () => {
  it('90% sites are labelled 90% on the PSD and convergence charts', () => {
    const inputs = [
      { photoId: 'a', label: 'a', included: true, session: squareGrainSession([20, 30, 40, 60], { mmPerPx: 0.5 }) },
      { photoId: 'b', label: 'b', included: true, session: squareGrainSession([24, 34, 44, 64], { mmPerPx: 0.5 }) },
    ] as SitePhotoInput[];
    const report = analyzeSite(inputs, { poolingMode: 'physical-area', minBaxisPx: 10, bootstrapReplicates: 20, confidenceLevel: 0.9 });
    const psd = renderPrintablePsdSvg(report, 'S', 'mm');
    expect(psd).toContain('90% CI (bootstrap)');
    expect(psd).not.toContain('95% CI');
    const conv = renderConvergenceChartSvg(report.convergence, true, report.bootstrapCi.confidenceLevel);
    expect(conv).toContain('± 90% CI');
  });
});

describe('F-23: brush exclusions are centred where they are drawn', () => {
  it('a brush dot at a pixel centre excludes a symmetric plus around that pixel', () => {
    const m = buildValidBedMask(21, 21, 1, { exclusionPolygons: [], exclusionStrokes: [{ points: [{ x: 10.5, y: 10.5 }], radiusPx: 1 }] });
    const excluded: string[] = [];
    for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) if (m.valid[y * 21 + x] === 0) excluded.push(`${x},${y}`);
    expect(excluded.sort()).toEqual(['10,10', '10,11', '10,9', '11,10', '9,10'].sort());
  });

  it('a stroke segment and a polygon over the same strip exclude the same pixels', () => {
    const stroke = buildValidBedMask(30, 30, 1, { exclusionPolygons: [], exclusionStrokes: [{ points: [{ x: 5, y: 15 }, { x: 25, y: 15 }], radiusPx: 2 }] });
    // Pixel rows 13..16 have centres within 2 px of y = 15 (13.5, 14.5, 15.5, 16.5).
    const rows = new Set<number>();
    for (let y = 0; y < 30; y++) if (stroke.valid[y * 30 + 15] === 0) rows.add(y);
    expect([...rows].sort((a, b) => a - b)).toEqual([13, 14, 15, 16]);
  });
});
