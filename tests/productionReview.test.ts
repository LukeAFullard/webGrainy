/**
 * Regression tests for the 2026-11 production-readiness review findings.
 */
import { describe, expect, it } from 'vitest';
import { computeFabricRoseStats } from '../src/modules/morphometricsExt.js';
import { majorAxisDirection, orientationFromMoments } from '../src/modules/orientationGeometry.js';
import { renderCompositionBarsSvg, renderFabricRoseSvg } from '../src/ui/charts.js';
import type { GrainMorphometrics } from '../src/types/index.js';
import { validateSiteCalibration } from '../src/modules/siteCalibration.js';
import type { SitePhotoInput } from '../src/modules/siteTypes.js';
import { comparisonStatistics } from '../src/ui/compareReport.js';
import type { ComparisonView } from '../src/ui/comparisonView.js';
import { createHash } from 'node:crypto';
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
