import { describe, expect, it } from 'vitest';
import { perfBudget } from './perfBudget.js';
import {
  MaskEditHistory,
  ScaleCalibrator,
  addPolygonGrain,
  applyCalibrationToGrains,
  computeAllGrainMorphometrics,
  computeGrainMorphometricsForIds,
  deleteGrain,
  mergeGrains,
  splitGrainAtLine,
} from '../src/modules/interactiveEditor.js';

function fillRect(
  masks: Int32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  id: number,
): void {
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      masks[row + x] = id;
    }
  }
}

describe('interactiveEditor', () => {
  describe('computeGrainMorphometricsForIds & moments', () => {
    it('computes exact 2nd-order central moments, bbox, and border flag for a rectangle', () => {
      const width = 40;
      const height = 40;
      const masks = new Int32Array(width * height);
      // 11x5 rectangle at x=[10..20], y=[15..19] -> area = 55
      fillRect(masks, width, 10, 15, 20, 19, 3);
      // Border-touching grain at x=[0..3], y=[10..15]
      fillRect(masks, width, 0, 10, 3, 15, 7);

      const grains = computeGrainMorphometricsForIds(masks, width, height, [3, 7], 2);
      expect(grains).toHaveLength(2);

      const g3 = grains.find((g) => g.id === 3)!;
      expect(g3.areaPx).toBe(55);
      expect(g3.centroidX).toBeCloseTo(15, 10);
      expect(g3.centroidY).toBeCloseTo(17, 10);
      expect(g3.bbox).toEqual([10, 15, 20, 19]);
      expect(g3.touchesBorder).toBe(false);
      // Discrete uniform variance of 11 integers is (11^2 - 1)/12 = 10 -> 4*sqrt(10)
      expect(g3.aAxisPx).toBeCloseTo(4 * Math.sqrt(10), 10);
      // Discrete uniform variance of 5 integers is (5^2 - 1)/12 = 2 -> 4*sqrt(2)
      expect(g3.bAxisPx).toBeCloseTo(4 * Math.sqrt(2), 10);
      expect(g3.dEqPx).toBeCloseTo(Math.sqrt((4 * 55) / Math.PI), 10);
      expect(g3.orientationRad).toBeCloseTo(0, 10);

      const g7 = grains.find((g) => g.id === 7)!;
      expect(g7.touchesBorder).toBe(true);
    });

    it('computes calibrated mm metrics when calibration is provided', () => {
      const width = 30;
      const height = 30;
      const masks = new Int32Array(width * height);
      fillRect(masks, width, 5, 5, 14, 14, 1); // 10x10 = 100 px

      const cal = ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 'mm');
      expect(cal.mmPerPx).toBeCloseTo(0.5, 10);

      const all = computeAllGrainMorphometrics(masks, width, height, 2, cal);
      expect(all).toHaveLength(1);
      const g = all[0]!;
      expect(g.areaMm2).toBeCloseTo(100 * 0.25, 10);
      expect(g.aAxisMm).toBeCloseTo(g.aAxisPx * 0.5, 10);
      expect(g.bAxisMm).toBeCloseTo(g.bAxisPx * 0.5, 10);
      expect(g.dEqMm).toBeCloseTo(g.dEqPx * 0.5, 10);
    });
  });

  describe('splitGrainAtLine', () => {
    it('splits a grain horizontally and assigns a new ID to the smaller component', () => {
      const width = 40;
      const height = 40;
      const masks = new Int32Array(width * height);
      fillRect(masks, width, 10, 10, 29, 29, 2); // 20x20 = 400 px
      fillRect(masks, width, 2, 2, 5, 5, 5); // unrelated grain with max ID = 5

      // Cut horizontally at y = 17 -> top part y=[10..16] (7x20=140), bottom part y=[18..29] (12x20=240)
      const res = splitGrainAtLine(
        masks,
        2,
        [
          { x: 8, y: 17 },
          { x: 31, y: 17 },
        ],
        width,
        height,
        10,
      );

      expect(res.applied).toBe(true);
      expect(res.newGrainIds).toEqual([6]);
      expect(res.affectedGrains).toHaveLength(2);

      const kept = res.affectedGrains.find((g) => g.id === 2)!;
      const created = res.affectedGrains.find((g) => g.id === 6)!;
      expect(kept.areaPx).toBe(240);
      expect(created.areaPx).toBe(140);
    });

    it('splits a grain vertically', () => {
      const width = 30;
      const height = 30;
      const masks = new Int32Array(width * height);
      fillRect(masks, width, 5, 5, 24, 14, 1); // 20x10

      const res = splitGrainAtLine(
        masks,
        1,
        [
          { x: 14, y: 4 },
          { x: 14, y: 15 },
        ],
        width,
        height,
        10,
      );

      expect(res.applied).toBe(true);
      expect(res.newGrainIds).toEqual([2]);
      expect(res.affectedGrains).toHaveLength(2);
      const totalArea = res.affectedGrains.reduce((s, g) => s + g.areaPx, 0);
      expect(totalArea).toBe(190); // 200 - 10 px line
    });

    it('splits diagonally with 4-connected Bresenham without 8-connected BFS leak', () => {
      const width = 32;
      const height = 32;
      const masks = new Int32Array(width * height);
      fillRect(masks, width, 4, 4, 27, 27, 1); // 24x24 = 576 px

      // Diagonal cut from top-left to bottom-right
      const res = splitGrainAtLine(
        masks,
        1,
        [
          { x: 3, y: 3 },
          { x: 28, y: 28 },
        ],
        width,
        height,
        10,
      );

      expect(res.applied).toBe(true);
      expect(res.newGrainIds).toEqual([2]);
      expect(res.affectedGrains).toHaveLength(2);
      // Both triangles should have substantial area (~250+ px each)
      expect(res.affectedGrains[0]!.areaPx).toBeGreaterThan(200);
      expect(res.affectedGrains[1]!.areaPx).toBeGreaterThan(200);
    });

    it('reverts cleared line pixels when fewer than 2 valid components remain', () => {
      const width = 30;
      const height = 30;
      const masks = new Int32Array(width * height);
      fillRect(masks, width, 5, 5, 14, 14, 1); // 10x10 = 100 px
      const original = new Int32Array(masks);

      // Cut off only a 1-px column (10 px -> 1x10=10 if minSize=20, rejected!)
      const res = splitGrainAtLine(
        masks,
        1,
        [
          { x: 6, y: 4 },
          { x: 6, y: 15 },
        ],
        width,
        height,
        20,
      );

      expect(res.applied).toBe(false);
      expect(res.newGrainIds).toEqual([]);
      expect(Array.from(masks)).toEqual(Array.from(original));
    });

    it('zeros out sub-minSize dust components when >= 2 valid components remain', () => {
      const width = 40;
      const height = 40;
      const masks = new Int32Array(width * height);
      fillRect(masks, width, 5, 5, 25, 25, 1);

      // Zig-zag polyline that leaves a tiny 2x2 corner + 2 large components
      const res = splitGrainAtLine(
        masks,
        1,
        [
          { x: 15, y: 4 },
          { x: 15, y: 26 },
          { x: 23, y: 26 },
          { x: 23, y: 22 },
          { x: 26, y: 22 },
        ],
        width,
        height,
        15,
      );

      expect(res.applied).toBe(true);
      expect(res.affectedGrains).toHaveLength(2);
      // Verify the 2x2 corner at (24..25, 23..25) was zeroed out as dust
      expect(masks[24 * width + 24]).toBe(0);
    });
  });

  describe('mergeGrains', () => {
    it('merges 2 grains across a 1-2 px gap without overwriting adjacent unrelated grains', () => {
      const width = 30;
      const height = 30;
      const masks = new Int32Array(width * height);

      // Grain 4: x=[5..10], y=[10..15]
      fillRect(masks, width, 5, 10, 10, 15, 4);
      // 2-px gap at x=11..12
      // Grain 9: x=[13..18], y=[10..15]
      fillRect(masks, width, 13, 10, 18, 15, 9);
      // Unrelated adjacent grain 99 right next to grain 4 at y=[8..9]
      fillRect(masks, width, 5, 8, 18, 9, 99);

      const res = mergeGrains(masks, [9, 4], width, height);
      expect(res.applied).toBe(true);
      expect(res.removedGrainIds).toEqual([9]);
      expect(res.affectedGrains).toHaveLength(1);
      expect(res.affectedGrains[0]!.id).toBe(4);

      // 2-px gap at x=11..12, y=10..15 should be bridged to 4 (at least interior rows)
      expect(masks[12 * width + 11]).toBe(4);
      expect(masks[12 * width + 12]).toBe(4);

      // Unrelated grain 99 must remain completely untouched
      for (let y = 8; y <= 9; y++) {
        for (let x = 5; x <= 18; x++) {
          expect(masks[y * width + x]).toBe(99);
        }
      }
    });
  });

  describe('deleteGrain & addPolygonGrain', () => {
    it('deletes a grain and updates grains list', () => {
      const width = 20;
      const height = 20;
      const masks = new Int32Array(width * height);
      fillRect(masks, width, 3, 3, 8, 8, 1);
      fillRect(masks, width, 12, 12, 16, 16, 2);

      const initialGrains = computeAllGrainMorphometrics(masks, width, height);
      const res = deleteGrain(masks, 1, width, height, { grains: initialGrains });

      expect(res.applied).toBe(true);
      expect(res.removedGrainIds).toEqual([1]);
      expect(res.grains).toHaveLength(1);
      expect(res.grains![0]!.id).toBe(2);
      expect(masks[5 * width + 5]).toBe(0);
      expect(masks[14 * width + 14]).toBe(2);
    });

    it('adds a concave L-shaped polygon non-destructively over existing grains', () => {
      const width = 30;
      const height = 30;
      const masks = new Int32Array(width * height);
      // Existing grain 1 overlapping part of the polygon
      fillRect(masks, width, 5, 5, 8, 8, 1);

      const lShape = [
        { x: 5, y: 5 },
        { x: 15, y: 5 },
        { x: 15, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 20 },
        { x: 5, y: 20 },
      ];

      const res = addPolygonGrain(masks, lShape, width, height, 10);
      expect(res.applied).toBe(true);
      expect(res.newGrainIds).toEqual([2]);
      expect(res.affectedGrains).toHaveLength(1);
      // Existing grain 1 was NOT overwritten
      expect(masks[6 * width + 6]).toBe(1);
      // Concave cutout at (12, 15) must remain 0
      expect(masks[15 * width + 12]).toBe(0);
      // Inside L-arm at (7, 15) must be 2
      expect(masks[15 * width + 7]).toBe(2);
    });

    it('rejects and reverts polygon smaller than minSize', () => {
      const width = 20;
      const height = 20;
      const masks = new Int32Array(width * height);
      const tinyTri = [
        { x: 5, y: 5 },
        { x: 7, y: 5 },
        { x: 5, y: 7 },
      ];
      const res = addPolygonGrain(masks, tinyTri, width, height, 10);
      expect(res.applied).toBe(false);
      expect(masks.every((v) => v === 0)).toBe(true);
    });
  });

  describe('MaskEditHistory', () => {
    it('supports undo/redo round-trips and truncates redo stack on new push', () => {
      const width = 20;
      const height = 20;
      const masks = new Int32Array(width * height);
      const history = new MaskEditHistory();

      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(false);

      const bbox1: [number, number, number, number] = [2, 2, 6, 6];
      const before1 = MaskEditHistory.extractBboxSlice(masks, width, bbox1);
      fillRect(masks, width, 2, 2, 6, 6, 1);
      const after1 = MaskEditHistory.extractBboxSlice(masks, width, bbox1);
      history.push({ bbox: bbox1, imageWidth: width, before: before1, after: after1 });

      const bbox2: [number, number, number, number] = [10, 10, 14, 14];
      const before2 = MaskEditHistory.extractBboxSlice(masks, width, bbox2);
      fillRect(masks, width, 10, 10, 14, 14, 2);
      const after2 = MaskEditHistory.extractBboxSlice(masks, width, bbox2);
      history.push({ bbox: bbox2, imageWidth: width, before: before2, after: after2 });

      expect(history.length).toBe(2);
      expect(history.cursor).toBe(1);
      expect(history.canUndo).toBe(true);
      expect(history.canRedo).toBe(false);

      history.undo(masks);
      expect(masks[12 * width + 12]).toBe(0);
      expect(masks[4 * width + 4]).toBe(1);
      expect(history.canRedo).toBe(true);

      // New push while cursor < length - 1 truncates redo
      const bbox3: [number, number, number, number] = [8, 8, 9, 9];
      const before3 = MaskEditHistory.extractBboxSlice(masks, width, bbox3);
      fillRect(masks, width, 8, 8, 9, 9, 3);
      const after3 = MaskEditHistory.extractBboxSlice(masks, width, bbox3);
      history.push({ bbox: bbox3, imageWidth: width, before: before3, after: after3 });

      expect(history.length).toBe(2);
      expect(history.canRedo).toBe(false);

      history.undo(masks);
      expect(masks[8 * width + 8]).toBe(0);
      history.redo(masks);
      expect(masks[8 * width + 8]).toBe(3);

      history.clear();
      expect(history.length).toBe(0);
      expect(history.cursor).toBe(-1);
    });

    it('performs local bbox undo/redo in < 1 ms on a 1024x1024 mask', () => {
      const width = 1024;
      const height = 1024;
      const masks = new Int32Array(width * height);
      const history = new MaskEditHistory();

      const bbox: [number, number, number, number] = [200, 200, 263, 263];
      const before = MaskEditHistory.extractBboxSlice(masks, width, bbox);
      fillRect(masks, width, 200, 200, 263, 263, 42);
      const after = MaskEditHistory.extractBboxSlice(masks, width, bbox);
      history.push({ bbox, imageWidth: width, before, after });

      const t0 = performance.now();
      history.undo(masks);
      history.redo(masks);
      const elapsed = performance.now() - t0;

      expect(elapsed).toBeLessThan(perfBudget(1.0));
      expect(masks[230 * width + 230]).toBe(42);
    });
  });

  describe('ScaleCalibrator', () => {
    it('calibrates mm and cm reference lengths and scales morphometrics', () => {
      const calMm = ScaleCalibrator.calibrate({ x: 10, y: 20 }, { x: 110, y: 20 }, 25, 'mm');
      expect(calMm.pixelDistance).toBeCloseTo(100, 10);
      expect(calMm.physicalLengthMm).toBeCloseTo(25, 10);
      expect(calMm.mmPerPx).toBeCloseTo(0.25, 10);

      const calibrator = new ScaleCalibrator();
      const calCm = calibrator.calibrate({ x: 0, y: 0 }, { x: 30, y: 40 }, 10, 'cm');
      expect(calCm.pixelDistance).toBeCloseTo(50, 10);
      expect(calCm.physicalLengthMm).toBeCloseTo(100, 10);
      expect(calCm.mmPerPx).toBeCloseTo(2, 10);

      const grain = {
        id: 1,
        areaPx: 100,
        centroidX: 10,
        centroidY: 10,
        aAxisPx: 20,
        bAxisPx: 10,
        dEqPx: 11.28379,
        orientationRad: 0,
        touchesBorder: false,
        bbox: [5, 5, 15, 15] as [number, number, number, number],
      };

      const scaled = applyCalibrationToGrains([grain], calCm)[0]!;
      expect(scaled.areaMm2).toBeCloseTo(400, 10);
      expect(scaled.aAxisMm).toBeCloseTo(40, 10);
      expect(scaled.bAxisMm).toBeCloseTo(20, 10);
      expect(scaled.dEqMm).toBeCloseTo(grain.dEqPx * 2, 10);

      expect(() =>
        ScaleCalibrator.calibrate({ x: 5, y: 5 }, { x: 5, y: 5 }, 10, 'mm'),
      ).toThrow();
      expect(() =>
        ScaleCalibrator.calibrate({ x: 0, y: 0 }, { x: 10, y: 0 }, -5, 'mm'),
      ).toThrow();
    });
  });
});
