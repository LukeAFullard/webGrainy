import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { computeAllGrainMorphometrics } from '../src/modules/interactiveEditor.js';
import {
  computeFolkWardStats,
  computePsdPercentiles,
  computeSedimentStats,
  computeWentworthProportions,
  exportGeoJsonContours,
  exportGrainsCsv,
  exportInstanceMaskPng,
  exportSummaryCsv,
  exportSummaryJson,
  exportSvgContours,
  filterBorderGrains,
  weightedPsdPercentiles,
} from '../src/modules/sedimentStats.js';
import type { GrainMorphometrics, PsdPercentiles } from '../src/types/index.js';

function makeGrain(
  id: number,
  overrides: Partial<GrainMorphometrics> = {},
): GrainMorphometrics {
  return {
    id,
    areaPx: 100,
    centroidX: 20,
    centroidY: 20,
    aAxisPx: 14,
    bAxisPx: 10,
    dEqPx: 11.28379,
    orientationRad: 0,
    touchesBorder: false,
    bbox: [15, 15, 25, 25],
    ...overrides,
  };
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

function crc32Ref(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let k = 0; k < 8; k++) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('sedimentStats', () => {
  describe('filterBorderGrains', () => {
    it('excludes border grains by default and includes all when false', () => {
      const grains = [
        makeGrain(1, { touchesBorder: false }),
        makeGrain(2, { touchesBorder: true }),
        makeGrain(3, { touchesBorder: false }),
      ];

      expect(filterBorderGrains(grains).map((g) => g.id)).toEqual([1, 3]);
      expect(filterBorderGrains(grains, false).map((g) => g.id)).toEqual([1, 2, 3]);
    });
  });

  describe('weightedPsdPercentiles', () => {
    it('matches log2 (phi-space) midpoint weighted interpolation to 1e-6', () => {
      // Unsorted values with non-uniform weights + invalid/zero entries filtered out
      const values = [30, 10, 50, -5, 20, 40];
      const weights = [3, 1, 2, 10, 4, 0];

      // Valid sorted pairs:
      // v=[10, 20, 30, 50], w=[1, 4, 3, 2], sum=10
      // cumsum=[1, 5, 8, 10]
      // cdf = [(1-0.5)/10, (5-2)/10, (8-1.5)/10, (10-1)/10] = [0.05, 0.30, 0.65, 0.90]
      // Interpolating linearly in log2(d) (phi space): 2^(log2(v0) + t*(log2(v1) - log2(v0)))
      const logInterp = (v0: number, v1: number, t: number): number =>
        2 ** (Math.log2(v0) + t * (Math.log2(v1) - Math.log2(v0)));
      const psd = weightedPsdPercentiles(values, weights);
      expect(psd['D5']).toBeCloseTo(10, 6);
      expect(psd['D10']).toBeCloseTo(logInterp(10, 20, 0.05 / 0.25), 6);
      expect(psd['D16']).toBeCloseTo(logInterp(10, 20, 0.11 / 0.25), 6);
      expect(psd['D25']).toBeCloseTo(logInterp(10, 20, 0.20 / 0.25), 6);
      expect(psd['D50']).toBeCloseTo(logInterp(20, 30, 0.20 / 0.35), 6);
      expect(psd['D75']).toBeCloseTo(logInterp(30, 50, 0.10 / 0.25), 6);
      expect(psd['D84']).toBeCloseTo(logInterp(30, 50, 0.19 / 0.25), 6);
      expect(psd['D90']).toBeCloseTo(50, 6);
      expect(psd['D95']).toBeCloseTo(50, 6);
    });

    it('handles 1-grain, 0-grain, and duplicate value inputs', () => {
      const empty = computePsdPercentiles([], []);
      expect(Number.isNaN(empty.D50)).toBe(true);

      const single = computePsdPercentiles([12.5], [100]);
      expect(single.D5).toBeCloseTo(12.5, 10);
      expect(single.D50).toBeCloseTo(12.5, 10);
      expect(single.D95).toBeCloseTo(12.5, 10);

      // Geometric midpoint between 8 and 16 in phi space is sqrt(8*16) = 8*sqrt(2) ≈ 11.313708
      const dupes = computePsdPercentiles([8, 8, 16, 16], [1, 1, 1, 1]);
      expect(dupes.D50).toBeCloseTo(Math.sqrt(8 * 16), 6);
    });
  });

  describe('computeFolkWardStats', () => {
    it('computes exact phi statistics and verbal labels', () => {
      // Choose exact powers of 2 in mm so phi values are clean integers:
      // D95=16 (phi5=-4), D84=8 (phi16=-3), D75=4 (phi25=-2),
      // D50=2 (phi50=-1), D25=1 (phi75=0), D16=0.5 (phi84=1), D5=0.25 (phi95=2)
      const psd: PsdPercentiles = {
        D5: 0.25,
        D10: 0.35,
        D16: 0.5,
        D25: 1,
        D50: 2,
        D75: 4,
        D84: 8,
        D90: 12,
        D95: 16,
      };

      const fw = computeFolkWardStats(psd)!;
      expect(fw).not.toBeNull();
      // meanPhi = (-3 + -1 + 1)/3 = -1
      expect(fw.meanPhi).toBeCloseTo(-1, 10);
      expect(fw.meanMm).toBeCloseTo(2, 10);
      // sortingPhi = (1 - (-3))/4 + (2 - (-4))/6.6 = 1 + 6/6.6 = 1.9090909...
      expect(fw.sortingPhi).toBeCloseTo(1 + 6 / 6.6, 10);
      expect(fw.sortingLabel).toBe('Poorly Sorted');
      // skewnessPhi = 0 (symmetric in phi)
      expect(fw.skewnessPhi).toBeCloseTo(0, 10);
      expect(fw.skewnessLabel).toBe('Near Symmetrical');
      // kurtosisPhi = (2 - (-4)) / (2.44 * (0 - (-2))) = 6 / 4.88 = 1.229508...
      expect(fw.kurtosisPhi).toBeCloseTo(6 / 4.88, 10);
      expect(fw.kurtosisLabel).toBe('Leptokurtic');
    });

    it('safely handles uniform grains (zero denominator)', () => {
      const uniform: PsdPercentiles = {
        D5: 4,
        D10: 4,
        D16: 4,
        D25: 4,
        D50: 4,
        D75: 4,
        D84: 4,
        D90: 4,
        D95: 4,
      };
      const fw = computeFolkWardStats(uniform)!;
      expect(fw).not.toBeNull();
      expect(Number.isFinite(fw.meanPhi)).toBe(true);
      expect(Number.isFinite(fw.sortingPhi)).toBe(true);
      // Skewness and kurtosis are undefined for a single size, not 0 / 1 ("Mesokurtic").
      expect(fw.skewnessPhi).toBeNaN();
      expect(fw.kurtosisPhi).toBeNaN();
      expect(fw.skewnessLabel).toBe('Undefined');
      expect(fw.kurtosisLabel).toBe('Undefined');
      expect(fw.sortingPhi).toBe(0);
      expect(fw.sortingLabel).toBe('Very Well Sorted');
    });

    it('kurtosis is undefined when one clast carries the middle of the weight (phi25 = phi75)', () => {
      const fw = computeFolkWardStats({ D5: 2, D10: 3, D16: 40, D25: 40, D50: 40, D75: 40, D84: 40, D90: 41, D95: 45 })!;
      expect(fw.kurtosisPhi).toBeNaN();
      expect(fw.kurtosisLabel).toBe('Undefined');
    });
  });

  describe('computeWentworthProportions & computeSedimentStats', () => {
    it('classifies exact Wentworth boundaries summing to 100%', () => {
      const grains = [
        makeGrain(1, { areaPx: 10, bAxisMm: 1.999, dEqMm: 2 }), // Sand (<2)
        makeGrain(2, { areaPx: 20, bAxisMm: 2.0, dEqMm: 2.2 }), // Gravel (2..64)
        makeGrain(3, { areaPx: 30, bAxisMm: 64.0, dEqMm: 70 }), // Cobble (64..256)
        makeGrain(4, { areaPx: 40, bAxisMm: 256.0, dEqMm: 280 }), // Boulder (>=256)
      ];

      const w = computeWentworthProportions(grains)!;
      expect(w).not.toBeNull();
      expect(w.sandPct).toBeCloseTo(10, 10);
      expect(w.gravelPct).toBeCloseTo(20, 10);
      expect(w.cobblePct).toBeCloseTo(30, 10);
      expect(w.boulderPct).toBeCloseTo(40, 10);
      expect(w.sandPct + w.gravelPct + w.cobblePct + w.boulderPct).toBeCloseTo(100, 10);

      const uncal = [makeGrain(1, { areaPx: 10 })];
      expect(computeWentworthProportions(uncal)).toBeNull();
    });

    it('computes area-weighted & number-weighted PSDs in px and mm', () => {
      const grains = [
        makeGrain(1, { areaPx: 100, bAxisPx: 10, dEqPx: 11, bAxisMm: 5, dEqMm: 5.5 }),
        makeGrain(2, { areaPx: 300, bAxisPx: 20, dEqPx: 22, bAxisMm: 10, dEqMm: 11 }),
        makeGrain(3, { touchesBorder: true, areaPx: 500, bAxisPx: 50, dEqPx: 55, bAxisMm: 25, dEqMm: 27.5 }),
      ];

      const report = computeSedimentStats(grains, { excludeBorder: true });
      expect(report.totalGrains).toBe(3);
      expect(report.includedGrains).toBe(2);
      expect(report.excludedBorderGrains).toBe(1);
      expect(report.unit).toBe('mm');
      expect(report.folkWard).not.toBeNull();
      expect(report.wentworth).not.toBeNull();
      // Area-weighted D50 should be higher than number-weighted D50 because grain 2 has 3x area
      expect(report.areaWeightedB.D50).toBeGreaterThan(report.numberWeightedB.D50);

      const uncalReport = computeSedimentStats([makeGrain(1), makeGrain(2)]);
      expect(uncalReport.unit).toBe('px');
      expect(uncalReport.folkWard).toBeNull();
      expect(uncalReport.wentworth).toBeNull();
    });
  });

  describe('CSV & JSON exports', () => {
    it('exports per-grain CSV with exact header and empty strings for undefined mm', async () => {
      const grains = [
        makeGrain(1, { centroidX: 10.5, centroidY: 20.5, areaPx: 100 }),
        makeGrain(2, {
          centroidX: 30,
          centroidY: 40,
          areaPx: 200,
          aAxisMm: 10,
          bAxisMm: 5,
          dEqMm: 7.5,
          touchesBorder: true,
        }),
      ];

      const blob = exportGrainsCsv(grains);
      expect(blob.type).toContain('text/csv');
      const text = await blob.text();
      const lines = text.split('\n');
      expect(lines[0]).toBe(
        'grain_id,centroid_x,centroid_y,area_px,a_axis_px,b_axis_px,d_eq_px,a_axis_mm,b_axis_mm,d_eq_mm,touches_border',
      );
      expect(lines[1]).toBe('1,10.5,20.5,100,14,10,11.28379,,,,false');
      expect(lines[2]).toBe('2,30,40,200,14,10,11.28379,10,5,7.5,true');
    });

    it('exports summary JSON and CSV', async () => {
      const report = computeSedimentStats([
        makeGrain(1, { bAxisMm: 4, dEqMm: 4.5 }),
        makeGrain(2, { areaPx: 200, bAxisMm: 8, dEqMm: 9 }),
      ]);

      const jsonBlob = exportSummaryJson(report);
      expect(jsonBlob.type).toBe('application/json');
      const parsed = JSON.parse(await jsonBlob.text());
      expect(parsed.includedGrains).toBe(2);
      expect(parsed.unit).toBe('mm');

      const csvBlob = exportSummaryCsv(report);
      expect(csvBlob.type).toContain('text/csv');
      const csvText = await csvBlob.text();
      expect(csvText).toContain('area_weighted_b,D50');
      expect(csvText).toContain('folk_ward,mean_phi');
      expect(csvText).toContain('wentworth,gravel_pct');
    });
  });

  describe('exportInstanceMaskPng', () => {
    it('encodes valid 16-bit and 32-bit PNGs with valid CRC-32 and pixel-exact zlib round-trip', async () => {
      const width = 5;
      const height = 4;
      const masks = new Int32Array([
        0, 1, 1, 0, 0,
        0, 1, 2, 2, 0,
        300, 300, 2, 2, 0,
        0, 0, 0, 65535, 0,
      ]);

      for (const bitDepth of [16, 32] as const) {
        const blob = exportInstanceMaskPng(masks, width, height, bitDepth);
        expect(blob.type).toBe('image/png');
        const bytes = new Uint8Array(await blob.arrayBuffer());

        // Magic signature
        expect(Array.from(bytes.subarray(0, 8))).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);

        // Parse chunks and verify CRC-32 on every chunk
        let pos = 8;
        let ihdrData: Uint8Array | null = null;
        let idatData: Uint8Array | null = null;
        let foundIend = false;

        while (pos < bytes.length) {
          const len = readUint32BE(bytes, pos);
          const type = String.fromCharCode(
            bytes[pos + 4]!,
            bytes[pos + 5]!,
            bytes[pos + 6]!,
            bytes[pos + 7]!,
          );
          const data = bytes.subarray(pos + 8, pos + 8 + len);
          const storedCrc = readUint32BE(bytes, pos + 8 + len);
          const computedCrc = crc32Ref(bytes.subarray(pos + 4, pos + 8 + len));
          expect(storedCrc).toBe(computedCrc);

          if (type === 'IHDR') ihdrData = data;
          if (type === 'IDAT') idatData = data;
          if (type === 'IEND') foundIend = true;
          pos += 12 + len;
        }

        expect(foundIend).toBe(true);
        expect(ihdrData).not.toBeNull();
        expect(readUint32BE(ihdrData!, 0)).toBe(width);
        expect(readUint32BE(ihdrData!, 4)).toBe(height);
        expect(ihdrData![8]).toBe(bitDepth === 16 ? 16 : 8);
        expect(ihdrData![9]).toBe(bitDepth === 16 ? 0 : 6);

        // Decompress IDAT with Node's zlib.inflateSync and verify pixel-exact round-trip
        const raw = zlib.inflateSync(idatData!);
        const bpp = bitDepth === 16 ? 2 : 4;
        const rowBytes = 1 + width * bpp;
        expect(raw.length).toBe(rowBytes * height);

        for (let y = 0; y < height; y++) {
          expect(raw[y * rowBytes]).toBe(0);
          for (let x = 0; x < width; x++) {
            const offset = y * rowBytes + 1 + x * bpp;
            const decoded =
              bitDepth === 16
                ? (raw[offset]! << 8) | raw[offset + 1]!
                : readUint32BE(raw, offset);
            expect(decoded).toBe(masks[y * width + x]);
          }
        }
      }
    });

    it('handles multi-block stored DEFLATE (> 65535 raw scanline bytes) losslessly for 200x200 16-bit PNG', async () => {
      const width = 200;
      const height = 200;
      // raw scanlines = height * (1 + width * 2) = 200 * 401 = 80,200 bytes (> 65535)
      const masks = new Int32Array(width * height);
      for (let i = 0; i < masks.length; i++) {
        masks[i] = (i * 131 + 17) & 0xffff;
      }

      const blob = exportInstanceMaskPng(masks, width, height, 16);
      const bytes = new Uint8Array(await blob.arrayBuffer());

      let pos = 8;
      let idatData: Uint8Array | null = null;
      while (pos < bytes.length) {
        const len = readUint32BE(bytes, pos);
        const type = String.fromCharCode(
          bytes[pos + 4]!,
          bytes[pos + 5]!,
          bytes[pos + 6]!,
          bytes[pos + 7]!,
        );
        const data = bytes.subarray(pos + 8, pos + 8 + len);
        const storedCrc = readUint32BE(bytes, pos + 8 + len);
        const computedCrc = crc32Ref(bytes.subarray(pos + 4, pos + 8 + len));
        expect(storedCrc).toBe(computedCrc);
        if (type === 'IDAT') idatData = data;
        pos += 12 + len;
      }

      expect(idatData).not.toBeNull();
      const raw = zlib.inflateSync(idatData!);
      const rowBytes = 1 + width * 2;
      expect(raw.length).toBe(80200);
      expect(raw.length).toBe(rowBytes * height);

      for (let y = 0; y < height; y++) {
        expect(raw[y * rowBytes]).toBe(0);
        for (let x = 0; x < width; x++) {
          const offset = y * rowBytes + 1 + x * 2;
          const decoded = (raw[offset]! << 8) | raw[offset + 1]!;
          expect(decoded).toBe(masks[y * width + x]);
        }
      }
    });
  });

  describe('exportGeoJsonContours & exportSvgContours', () => {
    const polygonAbsArea = (ring: ReadonlyArray<[number, number]>): number => {
      let sum = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const p0 = ring[i]!;
        const p1 = ring[i + 1]!;
        sum += p0[0] * p1[1] - p1[0] * p0[1];
      }
      return Math.abs(sum) * 0.5;
    };

    it('traces solid grain without holes into 1 Polygon ring and 1 closed SVG path', async () => {
      const width = 10;
      const height = 10;
      const masks = new Int32Array(width * height);
      // 4x4 solid square at [3..6, 3..6]
      for (let y = 3; y <= 6; y++) {
        for (let x = 3; x <= 6; x++) {
          masks[y * width + x] = 1;
        }
      }

      const grains = computeAllGrainMorphometrics(masks, width, height, 1);
      expect(grains).toHaveLength(1);

      const geoBlob = exportGeoJsonContours(masks, grains, width, height);
      const geo = JSON.parse(await geoBlob.text());
      expect(geo.type).toBe('FeatureCollection');
      expect(geo.features).toHaveLength(1);
      const feat = geo.features[0];
      expect(feat.geometry.type).toBe('Polygon');
      expect(feat.geometry.coordinates).toHaveLength(1);
      const outer = feat.geometry.coordinates[0] as Array<[number, number]>;
      expect(outer.length).toBeGreaterThanOrEqual(4);
      expect(outer[0]).toEqual(outer[outer.length - 1]);
      expect(polygonAbsArea(outer)).toBeGreaterThan(10);

      const svgBlob = exportSvgContours(masks, grains, width, height);
      const svgText = await svgBlob.text();
      const pathMatches = svgText.match(/<path\b/g) ?? [];
      expect(pathMatches).toHaveLength(1);
      expect(svgText).toMatch(/d="M [^"]+ Z"/);
    });

    it('traces closed Marching Squares contours for donut grain with outer area strictly larger than hole area', async () => {
      const width = 12;
      const height = 12;
      const masks = new Int32Array(width * height);
      // 4x4 grain at [2..5, 2..5] with a 1-px hole at (3, 3) to test outer+hole
      for (let y = 2; y <= 5; y++) {
        for (let x = 2; x <= 5; x++) {
          if (x === 3 && y === 3) continue;
          masks[y * width + x] = 1;
        }
      }

      const grains = computeAllGrainMorphometrics(masks, width, height, 1);
      expect(grains).toHaveLength(1);

      const geoBlob = exportGeoJsonContours(masks, grains, width, height);
      expect(geoBlob.type).toBe('application/geo+json');
      const geo = JSON.parse(await geoBlob.text());
      expect(geo.type).toBe('FeatureCollection');
      expect(geo.features).toHaveLength(1);
      const feat = geo.features[0];
      expect(feat.properties.grainId).toBe(1);
      expect(feat.geometry.type).toBe('Polygon');
      // Outer ring + 1 hole ring
      expect(feat.geometry.coordinates.length).toBe(2);
      for (const ring of feat.geometry.coordinates) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring[ring.length - 1]);
      }

      const outerArea = polygonAbsArea(feat.geometry.coordinates[0]);
      const holeArea = polygonAbsArea(feat.geometry.coordinates[1]);
      expect(outerArea).toBeGreaterThan(holeArea);

      const svgBlob = exportSvgContours(masks, grains, width, height);
      expect(svgBlob.type).toBe('image/svg+xml');
      const svgText = await svgBlob.text();
      expect(svgText).toContain('<svg ');
      expect(svgText).toContain('viewBox="0 0 12 12"');
      expect(svgText).toContain('<path data-grain-id="1"');
      expect(svgText).toContain('fill-rule="evenodd"');
      expect(svgText).toContain('Z"');
    });

    it('traces saddle-point 2x2 diagonal checkerboard into valid closed GeoJSON and SVG contours', async () => {
      // Test both diagonal orientations: (TL+BR) and (TR+BL)
      for (const mode of ['tl-br', 'tr-bl'] as const) {
        const width = 6;
        const height = 6;
        const masks = new Int32Array(width * height);
        if (mode === 'tl-br') {
          masks[2 * width + 2] = 1;
          masks[3 * width + 3] = 1;
        } else {
          masks[2 * width + 3] = 1;
          masks[3 * width + 2] = 1;
        }

        const grains = computeAllGrainMorphometrics(masks, width, height, 1);
        expect(grains).toHaveLength(1);

        const geoBlob = exportGeoJsonContours(masks, grains, width, height);
        const geo = JSON.parse(await geoBlob.text());
        expect(geo.features).toHaveLength(1);
        const feat = geo.features[0];
        expect(feat.geometry.type).toBe('MultiPolygon');
        expect(feat.geometry.coordinates).toHaveLength(2);
        for (const poly of feat.geometry.coordinates) {
          expect(poly).toHaveLength(1);
          const ring = poly[0] as Array<[number, number]>;
          expect(ring.length).toBeGreaterThanOrEqual(4);
          expect(ring[0]).toEqual(ring[ring.length - 1]);
          expect(polygonAbsArea(ring)).toBeCloseTo(0.5, 6);
        }

        const svgBlob = exportSvgContours(masks, grains, width, height);
        const svgText = await svgBlob.text();
        expect(svgText).toContain('<path data-grain-id="1"');
        const subpaths = svgText.match(/M [^Z]+ Z/g) ?? [];
        expect(subpaths).toHaveLength(2);
      }
    });
  });

  describe('computeSedimentStats with minFeret', () => {
    it('populates areaWeightedMinFeret, numberWeightedMinFeret, and min-Feret Folk & Ward stats + CSV rows', async () => {
      const grains: GrainMorphometrics[] = [
        {
          id: 1,
          centroidX: 10,
          centroidY: 10,
          areaPx: 100,
          aAxisPx: 20,
          bAxisPx: 10,
          dEqPx: 11.28,
          minFeretPx: 12,
          maxFeretPx: 22,
          bAxisMm: 10,
          dEqMm: 11.28,
          aAxisMm: 20,
          minFeretMm: 12,
          maxFeretMm: 22,
          areaMm2: 100,
          orientationRad: 0,
          bbox: [0, 0, 20, 10],
          touchesBorder: false,
        },
        {
          id: 2,
          centroidX: 40,
          centroidY: 10,
          areaPx: 300,
          aAxisPx: 40,
          bAxisPx: 20,
          dEqPx: 19.54,
          minFeretPx: 24,
          maxFeretPx: 44,
          bAxisMm: 20,
          dEqMm: 19.54,
          aAxisMm: 40,
          minFeretMm: 24,
          maxFeretMm: 44,
          areaMm2: 300,
          orientationRad: 0,
          bbox: [20, 0, 60, 20],
          touchesBorder: false,
        },
      ];

      const report = computeSedimentStats(grains, { sizeMetric: 'minFeret' });
      expect(report.areaWeightedMinFeret).toBeDefined();
      expect(report.numberWeightedMinFeret).toBeDefined();
      expect(report.areaWeightedMinFeret!.D50).toBeGreaterThan(report.areaWeightedB.D50);

      const csvText = await exportSummaryCsv(report).text();
      expect(csvText).toContain('area_weighted_min_feret,D50');
      expect(csvText).toContain('number_weighted_min_feret,D50');
    });
  });
});

describe('cutoff explanation (grain card)', () => {
  it('names the rule and the numbers', async () => {
    const { sizeCutoffExplanation } = await import('../src/modules/sedimentStats.js');
    // The reported grain: b-axis 177.93 mm at 20 mm/px = 8.9 px, area 35,200 mm².
    const g = { id: 540, areaPx: 88, centroidX: 0, centroidY: 0, aAxisPx: 12.79, bAxisPx: 8.8965, dEqPx: 10.585, bAxisMm: 177.93, aAxisMm: 255.86, dEqMm: 211.7, areaMm2: 35200, orientationRad: 0, touchesBorder: false, bbox: [0, 0, 1, 1] } as never;
    expect(sizeCutoffExplanation(g, { minBaxisPx: 15 })).toBe('b-axis 8.9 px < 15 px pixel cutoff');
    expect(sizeCutoffExplanation(g, { minBaxisPx: 5, minSizeMm: 200 })).toBe('b-axis 177.9 mm < 200 mm size cutoff');
    expect(sizeCutoffExplanation(g, { minBaxisPx: 5, minSizeMm: 100 })).toBeNull();
    expect(sizeCutoffExplanation(g, { minBaxisPx: 5, sizeMetric: 'dEq', minSizeMm: 250 })).toBe('equivalent diameter 211.7 mm < 250 mm size cutoff');
  });
});
