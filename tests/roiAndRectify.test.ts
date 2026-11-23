import { describe, expect, it } from 'vitest';
import { computeAllGrainMorphometrics } from '../src/modules/interactiveEditor.js';
import type { ImageBufferLike } from '../src/modules/imagePreprocess.js';
import {
  applyHomographyPoint,
  buildValidBedMask,
  filterGrainsByRoiAndExclusion,
  invert3x3,
  isConvexQuad,
  rectifyPerspective,
  solveHomography,
} from '../src/modules/roiAndRectify.js';
import type { Point2D } from '../src/types/index.js';

function paintRect(
  masks: Int32Array,
  width: number,
  height: number,
  id: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
      masks[y * width + x] = id;
    }
  }
}

describe('roiAndRectify', () => {
  describe('ROI and exclusion filtering', () => {
    it('non-destructively filters grains by ROI, exclusion polygon, and brush stroke', () => {
      const workW = 100;
      const workH = 100;
      const scale = 0.5; // original image is 200x200
      const masks = new Int32Array(workW * workH);

      // Grain 1: inside ROI [20..180, 20..180], untouched (working 20..30, 20..30 -> orig 40..60)
      paintRect(masks, workW, workH, 1, 20, 20, 29, 29);
      // Grain 2: inside exclusion polygon (working 60..69, 20..29 -> orig 120..140, 40..60)
      paintRect(masks, workW, workH, 2, 60, 20, 69, 29);
      // Grain 3: outside ROI (working 2..7, 2..7 -> orig 4..14)
      paintRect(masks, workW, workH, 3, 2, 2, 7, 7);
      // Grain 4: hit by brush stroke (working 40..49, 60..69 -> orig 80..100, 120..140)
      paintRect(masks, workW, workH, 4, 40, 60, 49, 69);

      const masksSnapshot = new Int32Array(masks);

      const workingGrains = computeAllGrainMorphometrics(masks, workW, workH, 0);
      // Rescale grains to original-image coordinates (200x200)
      const origGrains = workingGrains.map((g) => ({
        ...g,
        areaPx: g.areaPx / (scale * scale),
        centroidX: g.centroidX / scale,
        centroidY: g.centroidY / scale,
        aAxisPx: g.aAxisPx / scale,
        bAxisPx: g.bAxisPx / scale,
        dEqPx: g.dEqPx / scale,
        bbox: [
          g.bbox[0] / scale,
          g.bbox[1] / scale,
          g.bbox[2] / scale,
          g.bbox[3] / scale,
        ] as [number, number, number, number],
      }));

      const result = filterGrainsByRoiAndExclusion(
        masks,
        origGrains,
        workW,
        workH,
        scale,
        {
          roiPolygon: [
            { x: 20, y: 20 },
            { x: 180, y: 20 },
            { x: 180, y: 180 },
            { x: 20, y: 180 },
          ],
          exclusionPolygons: [
            [
              { x: 115, y: 35 },
              { x: 145, y: 35 },
              { x: 145, y: 65 },
              { x: 115, y: 65 },
            ],
          ],
          exclusionStrokes: [
            {
              points: [
                { x: 80, y: 130 },
                { x: 100, y: 130 },
              ],
              radiusPx: 12,
            },
          ],
          maxExcludedFraction: 0.1,
          unresolvedFinesFraction: 0.08,
        },
        0.5, // mmPerPx
      );

      // Raw masks must NEVER be mutated
      expect(masks).toEqual(masksSnapshot);

      expect(result.includedGrains.map((g) => g.id)).toEqual([1]);
      expect(result.excludedGrainIds).toEqual(new Set([2, 3, 4]));
      expect(result.sampledBedAreaPx).toBeGreaterThan(0);
      expect(result.sampledBedAreaMm2).toBeCloseTo(
        result.sampledBedAreaPx * 0.25,
        6,
      );
      expect(result.clastPackingPct).toBeGreaterThan(0);
      expect(result.clastPackingPct + result.exposedMatrixPct).toBeCloseTo(
        100,
        6,
      );
      expect(result.unresolvedFinesFraction).toBeCloseTo(0.08, 6);
    });

    it('respects maxExcludedFraction = 0.10 vs strict 0.0', () => {
      const w = 40;
      const h = 40;
      const masks = new Int32Array(w * h);
      // Grain 1: 10x10 = 100 px at [10..19, 10..19], centroid ~(14.5, 14.5)
      paintRect(masks, w, h, 1, 10, 10, 19, 19);
      const grains = computeAllGrainMorphometrics(masks, w, h, 0);

      // Exclude 1 row (10 px = 10%) at y=10 -> f_excl = 0.10 (<= 0.10)
      const exclPoly: Point2D[] = [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 20, y: 11 },
        { x: 10, y: 11 },
      ];

      const lenient = filterGrainsByRoiAndExclusion(masks, grains, w, h, 1, {
        exclusionPolygons: [exclPoly],
        exclusionStrokes: [],
        maxExcludedFraction: 0.1,
      });
      expect(lenient.includedGrains.map((g) => g.id)).toEqual([1]);

      const strict = filterGrainsByRoiAndExclusion(masks, grains, w, h, 1, {
        exclusionPolygons: [exclPoly],
        exclusionStrokes: [],
        maxExcludedFraction: 0,
      });
      expect(strict.includedGrains).toHaveLength(0);
      expect(strict.excludedGrainIds.has(1)).toBe(true);
    });

    it('buildValidBedMask handles single-point brush strokes', () => {
      const mask = buildValidBedMask(50, 50, 1, {
        exclusionPolygons: [],
        exclusionStrokes: [{ points: [{ x: 25, y: 25 }], radiusPx: 5 }],
      });
      expect(mask.valid[25 * 50 + 25]).toBe(0);
      expect(mask.valid[0]).toBe(1);
      expect(mask.validPixelCount).toBeLessThan(2500);
    });
  });

  describe('4-point planar homography rectification', () => {
    it('rectifies a synthetically tilted checkerboard with < 0.5 px corner error and uniform mmPerPx', () => {
      // Reference ortho checkerboard: 120x120 px representing 240x240 mm (2 mm/px)
      const refW = 120;
      const refH = 120;
      const refData = new Uint8ClampedArray(refW * refH * 4);
      for (let y = 0; y < refH; y++) {
        for (let x = 0; x < refW; x++) {
          const checker = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 === 0;
          const val = checker ? 240 : 20;
          const idx = (y * refW + x) * 4;
          refData[idx] = val;
          refData[idx + 1] = val;
          refData[idx + 2] = val;
          refData[idx + 3] = 255;
        }
      }

      // Define a known tilted quad inside a 200x200 source image
      const srcW = 200;
      const srcH = 200;
      const srcCorners: [Point2D, Point2D, Point2D, Point2D] = [
        { x: 40, y: 30 },   // TL
        { x: 160, y: 45 },  // TR
        { x: 180, y: 170 }, // BR
        { x: 25, y: 155 },  // BL
      ];
      const refCorners: [Point2D, Point2D, Point2D, Point2D] = [
        { x: 0, y: 0 },
        { x: refW, y: 0 },
        { x: refW, y: refH },
        { x: 0, y: refH },
      ];

      // Forward warp refData -> tilted source image using H_ref_to_src
      const hRefToSrc = solveHomography(refCorners, srcCorners);
      const hSrcToRef = invert3x3(hRefToSrc);

      const srcData = new Uint8ClampedArray(srcW * srcH * 4);
      for (let y = 0; y < srcH; y++) {
        for (let x = 0; x < srcW; x++) {
          const rp = applyHomographyPoint(hSrcToRef, { x, y });
          if (rp.x >= 0 && rp.x <= refW - 1 && rp.y >= 0 && rp.y <= refH - 1) {
            const rx = Math.round(rp.x);
            const ry = Math.round(rp.y);
            const sIdx = (y * srcW + x) * 4;
            const rIdx = (ry * refW + rx) * 4;
            srcData[sIdx] = refData[rIdx] ?? 0;
            srcData[sIdx + 1] = refData[rIdx + 1] ?? 0;
            srcData[sIdx + 2] = refData[rIdx + 2] ?? 0;
            srcData[sIdx + 3] = 255;
          }
        }
      }

      const srcImage: ImageBufferLike = { data: srcData, width: srcW, height: srcH };
      const rectified = rectifyPerspective(srcImage, {
        srcCorners,
        physicalWidthMm: 240,
        physicalHeightMm: 240,
        targetMmPerPx: 2.0,
      });

      expect(rectified.width).toBe(120);
      expect(rectified.height).toBe(120);
      expect(rectified.mmPerPx).toBeCloseTo(2.0, 6);
      expect(rectified.roiRectInOutput).toEqual([0, 0, 120, 120]);

      // Verify corner recovery error < 0.5 px
      for (let k = 0; k < 4; k++) {
        const mapped = applyHomographyPoint(rectified.homography, srcCorners[k]!);
        const expected = refCorners[k]!;
        const err = Math.hypot(mapped.x - expected.x, mapped.y - expected.y);
        expect(err).toBeLessThan(0.5);
      }

      // Verify interior checkerboard cell centers match original values
      const samplePoints = [
        { x: 10, y: 10, expected: 240 },
        { x: 30, y: 10, expected: 20 },
        { x: 30, y: 30, expected: 240 },
        { x: 50, y: 70, expected: 20 },
      ];
      for (const sp of samplePoints) {
        const idx = (sp.y * rectified.width + sp.x) * 4;
        expect(Math.abs((rectified.data[idx] ?? 0) - sp.expected)).toBeLessThan(25);
      }
    });

    it('supports paddingPx and maxOutputDimPx safety cap', () => {
      const srcImage: ImageBufferLike = {
        data: new Uint8ClampedArray(100 * 100 * 4).fill(128),
        width: 100,
        height: 100,
      };
      const res = rectifyPerspective(srcImage, {
        srcCorners: [
          { x: 10, y: 10 },
          { x: 90, y: 10 },
          { x: 90, y: 90 },
          { x: 10, y: 90 },
        ],
        physicalWidthMm: 500,
        physicalHeightMm: 500,
        targetMmPerPx: 0.1, // would request 5000px, capped to 256
        paddingPx: 10,
        maxOutputDimPx: 256,
      });

      expect(res.width).toBeLessThanOrEqual(256);
      expect(res.height).toBeLessThanOrEqual(256);
      expect(res.roiRectInOutput[0]).toBe(10);
      expect(res.roiRectInOutput[1]).toBe(10);
    });

    it('regression: output pixels are square (same mm/px on both axes) when sizes do not divide evenly', () => {
      const srcImage: ImageBufferLike = { data: new Uint8ClampedArray(200 * 200 * 4).fill(128), width: 200, height: 200 };
      // 100 mm x 7 mm reference at 3 mm/px: 33.33 x 2.33 px. Rounding each side separately
      // would give 33 x 2 px, i.e. 3.03 vs 3.5 mm/px (16% anisotropy).
      const res = rectifyPerspective(srcImage, {
        srcCorners: [{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 180, y: 31.2 }, { x: 20, y: 31.2 }],
        physicalWidthMm: 100,
        physicalHeightMm: 7,
        targetMmPerPx: 3,
      });
      expect(res.mmPerPx).toBe(3);
      const [x0, y0, rw, rh] = res.roiRectInOutput;
      expect(100 / rw).toBeCloseTo(3, 9);
      expect(7 / rh).toBeCloseTo(3, 9);
      expect(res.width).toBe(Math.ceil(rw));
      expect(res.height).toBe(Math.ceil(rh));
      // The source corners land exactly on the reference rectangle.
      const br = applyHomographyPoint(res.homography, { x: 180, y: 31.2 });
      expect(br.x).toBeCloseTo(x0 + rw, 6);
      expect(br.y).toBeCloseTo(y0 + rh, 6);
    });

    it('throws descriptive error on collinear or degenerate quadrilaterals', () => {
      const collinear: [Point2D, Point2D, Point2D, Point2D] = [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
        { x: 100, y: 100 },
        { x: 150, y: 150 },
      ];
      const dst: [Point2D, Point2D, Point2D, Point2D] = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];

      expect(() => solveHomography(collinear, dst)).toThrow(/Degenerate|collinear/i);
    });
  });
});

describe('rectification input checks (audit B16)', () => {
  const grey: ImageBufferLike = { data: new Uint8ClampedArray(100 * 100 * 4).fill(200), width: 100, height: 100 };

  it('rejects corners clicked zig-zag (a crossed bowtie) or a dented shape', () => {
    const bowtie: [Point2D, Point2D, Point2D, Point2D] = [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 10, y: 90 }, { x: 90, y: 90 }];
    expect(isConvexQuad(bowtie)).toBe(false);
    expect(() => rectifyPerspective(grey, { srcCorners: bowtie, physicalWidthMm: 100, physicalHeightMm: 100 })).toThrow(/in order around/);
    expect(isConvexQuad([{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 50, y: 30 }, { x: 10, y: 90 }])).toBe(false);
    // Either winding of a proper quad is fine.
    expect(isConvexQuad([{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }])).toBe(true);
    expect(isConvexQuad([{ x: 10, y: 10 }, { x: 10, y: 90 }, { x: 90, y: 90 }, { x: 90, y: 10 }])).toBe(true);
  });

  it('leaves output pixels beyond the horizon empty instead of an upside-down copy', () => {
    // A strongly oblique quad: the padding above it crosses the vanishing line.
    const res = rectifyPerspective(grey, {
      srcCorners: [{ x: 45, y: 40 }, { x: 55, y: 40 }, { x: 99, y: 99 }, { x: 1, y: 99 }],
      physicalWidthMm: 100,
      physicalHeightMm: 100,
      paddingPx: 40,
    });
    const inv = invert3x3(res.homography);
    const [px, py, rw, rh] = res.roiRectInOutput;
    const wAt = (x: number, y: number): number => (inv[6] ?? 0) * x + (inv[7] ?? 0) * y + (inv[8] ?? 1);
    const front = Math.sign(wAt(px + rw / 2, py + rh / 2));
    let behind = 0;
    let filled = 0;
    for (let y = 0; y < res.height; y++) {
      for (let x = 0; x < res.width; x++) {
        if ((res.data[(y * res.width + x) * 4] ?? 0) === 0) continue;
        filled++;
        if (Math.sign(wAt(x, y)) !== front) behind++; // was ~2,700 pixels before the fix
      }
    }
    expect(filled).toBeGreaterThan(1000);
    expect(behind).toBe(0);
  });
});
