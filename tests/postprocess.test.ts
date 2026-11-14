import { describe, expect, it, vi } from 'vitest';
import parityFixture from './fixtures/regionprops_parity.json' with { type: 'json' };
import {
  computeGrainMorphometrics,
  evaluateGrainFlowQcV4,
  flowsToMasksBrowser,
  multigridJacobiHeat,
  trySplitDumbbellV4,
} from '../src/modules/postprocessCore.js';
import type { WorkerRequest, WorkerResponse } from '../src/types/index.js';

/**
 * Helper to generate Cellpose-style radial inward flows (scaled by 5.0)
 * for a set of circular grains.
 */
function makeSyntheticRadialField(
  width: number,
  height: number,
  circles: Array<{ cx: number; cy: number; r: number }>,
): { flowY: Float32Array; flowX: Float32Array; cellprob: Float32Array } {
  const nPix = width * height;
  const flowY = new Float32Array(nPix);
  const flowX = new Float32Array(nPix);
  const cellprob = new Float32Array(nPix);
  cellprob.fill(-5.0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let bestDist = Infinity;
      let bestCy = 0;
      let bestCx = 0;
      let inside = false;

      for (const c of circles) {
        const dy = y - c.cy;
        const dx = x - c.cx;
        const d = Math.hypot(dy, dx);
        if (d <= c.r && d < bestDist) {
          bestDist = d;
          bestCy = c.cy;
          bestCx = c.cx;
          inside = true;
        }
      }

      if (inside) {
        const idx = y * width + x;
        cellprob[idx] = 5.0;
        const dy = bestCy - y;
        const dx = bestCx - x;
        const norm = Math.hypot(dy, dx);
        if (norm > 1e-6) {
          flowY[idx] = (dy / norm) * 5.0;
          flowX[idx] = (dx / norm) * 5.0;
        }
      }
    }
  }

  return { flowY, flowX, cellprob };
}

describe('computeGrainMorphometrics — skimage.measure.regionprops parity', () => {
  for (const testCase of parityFixture) {
    it(`matches skimage.measure.regionprops for ${testCase.name}`, () => {
      const masks = Int32Array.from(testCase.mask);
      const grains = computeGrainMorphometrics(
        masks,
        testCase.width,
        testCase.height,
        2,
      );

      expect(grains).toHaveLength(1);
      const g = grains[0]!;
      const exp = testCase.expected;

      expect(g.id).toBe(1);
      expect(g.areaPx).toBe(exp.areaPx);
      expect(g.bbox).toEqual(exp.bbox);
      expect(Math.abs(g.centroidX - exp.centroidX)).toBeLessThan(1e-4);
      expect(Math.abs(g.centroidY - exp.centroidY)).toBeLessThan(1e-4);
      expect(Math.abs(g.aAxisPx - exp.aAxisPx)).toBeLessThan(1e-4);
      expect(Math.abs(g.bAxisPx - exp.bAxisPx)).toBeLessThan(1e-4);
      expect(Math.abs(g.dEqPx - exp.dEqPx)).toBeLessThan(1e-4);
      if (Math.abs(exp.aAxisPx - exp.bAxisPx) < 1e-9) {
        expect(g.orientationRad).toBe(0);
      } else {
        expect(Math.abs(g.orientationRad - exp.orientationRad)).toBeLessThan(
          1e-4,
        );
      }
    });
  }
});

describe('multigridJacobiHeat — 8x/4x/2x/1x coarse-to-fine PDE', () => {
  it('solves >= 192 px boulder mask with 8x multigrid quickly and smoothly', () => {
    const bw = 200;
    const bh = 200;
    const localMask = new Uint8Array(bw * bh);
    const cx = 100;
    const cy = 100;
    const r = 95;

    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) {
          localMask[y * bw + x] = 1;
        }
      }
    }

    const t0 = performance.now();
    const u = multigridJacobiHeat(localMask, bw, bh, cx, cy);
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(150);
    // Heat injection += 1.0 before each 9-point stencil sweep accumulates > 1.0 at center sink
    const uCenter = u[cy * bw + cx]!;
    const uMid = u[cy * bw + (cx + 40)]!;
    const uRim = u[cy * bw + (cx + 85)]!;
    expect(uCenter).toBeGreaterThan(1.0);
    expect(uCenter).toBeGreaterThan(uMid);
    expect(uMid).toBeGreaterThan(uRim);
    expect(uRim).toBeGreaterThan(0);
    // Outside mask must remain 0
    expect(u[0]).toBe(0);
  });

  it('solves 4x (128x128), 2x (64x64), and 1x (32x32) masks cleanly', () => {
    for (const dim of [128, 64, 32]) {
      const localMask = new Uint8Array(dim * dim);
      localMask.fill(1);
      const c = Math.floor(dim / 2);
      const u = multigridJacobiHeat(localMask, dim, dim, c, c);
      expect(u[c * dim + c]!).toBeGreaterThan(1.0);
      expect(u[c * dim + c]!).toBeGreaterThan(
        u[c * dim + (c + Math.floor(dim / 4))]!,
      );
      expect(u[c * dim + (c + Math.floor(dim / 4))]!).toBeGreaterThan(0);
    }
  });
});

describe('v4.1 Upper-Area Guard (3ca10b7c regression) & F3_SplitOnFailure', () => {
  it('blocks background sheet > 15% of image area from splitting or being accepted', () => {
    const width = 100;
    const height = 100;
    const nPix = width * height;
    const flowY = new Float32Array(nPix);
    const flowX = new Float32Array(nPix);
    const cellprob = new Float32Array(nPix);
    cellprob.fill(-5.0);

    // Giant 50x45 = 2250 px (22.5% > 15%) background sand sheet with two closely
    // spaced inward peaks (3 px apart) that merge during 2-pass 3x3 seed dilation
    // into ONE >15% component. Without the v4.1 upper-area guard, it would be
    // evaluated/split instead of rejected.
    const peak1 = { x: 48, y: 50 };
    const peak2 = { x: 51, y: 50 };

    for (let y = 25; y < 70; y++) {
      for (let x = 25; x < 75; x++) {
        const idx = y * width + x;
        cellprob[idx] = 5.0;
        const target = x < 50 ? peak1 : peak2;
        const dy = target.y - y;
        const dx = target.x - x;
        const norm = Math.hypot(dy, dx);
        if (norm > 1e-6) {
          flowY[idx] = (dy / norm) * 5.0;
          flowX[idx] = (dx / norm) * 5.0;
        }
      }
    }

    const res = flowsToMasksBrowser(flowY, flowX, cellprob, width, height, {
      maxGrainAreaFraction: 0.15,
      minSize: 30,
    });

    expect(res.grainCount).toBe(0);
    expect(res.grains).toHaveLength(0);
    expect(res.masks.every((v) => v === 0)).toBe(true);
  });

  it('trySplitDumbbellV4 refuses to split masks exceeding maxArea', () => {
    const width = 100;
    const height = 100;
    const nPix = width * height;
    const flowY = new Float32Array(nPix);
    const flowX = new Float32Array(nPix);
    const pixList: number[] = [];

    for (let y = 20; y < 70; y++) {
      for (let x = 20; x < 70; x++) {
        pixList.push(y * width + x);
      }
    }

    const split = trySplitDumbbellV4(
      pixList,
      flowY,
      flowX,
      width,
      height,
      30,
      1500, // 2500 > 1500
      0.45,
    );
    expect(split).toBeNull();
  });

  it('recovers valid touching dumbbell pebbles (< 15% area) via F3_SplitOnFailure', () => {
    const width = 140;
    const height = 140;
    // Two barely-touching pebbles of radius 14 (centers 27 px apart, ~1220 px combined = 6.2% < 15%)
    const { flowY, flowX, cellprob } = makeSyntheticRadialField(width, height, [
      { cx: 56, cy: 70, r: 14 },
      { cx: 83, cy: 70, r: 14 },
    ]);

    // Build pixel list of the merged dumbbell component and verify trySplitDumbbellV4 splits it
    const pixList: number[] = [];
    for (let i = 0; i < width * height; i++) {
      if (cellprob[i]! > 0) pixList.push(i);
    }

    const qcParent = evaluateGrainFlowQcV4(
      pixList,
      flowY,
      flowX,
      width,
      height,
      0.25,
    );
    expect(qcParent.passed).toBe(false);

    const split = trySplitDumbbellV4(
      pixList,
      flowY,
      flowX,
      width,
      height,
      30,
      0.15 * width * height,
      0.25,
    );
    expect(split).not.toBeNull();
    expect(split![0].length).toBeGreaterThanOrEqual(400);
    expect(split![1].length).toBeGreaterThanOrEqual(400);

    // End-to-end flowsToMasksBrowser also recovers 2 separate pebbles
    const res = flowsToMasksBrowser(flowY, flowX, cellprob, width, height, {
      flowThreshold: 0.25,
    });
    expect(res.grainCount).toBe(2);
  });
});

describe('flowsToMasksBrowser — segmentation, border flag, minSize, edge cases', () => {
  it('segments separated grains, flags touchesBorder (margin=2), and filters minSize', () => {
    const width = 128;
    const height = 128;
    const { flowY, flowX, cellprob } = makeSyntheticRadialField(width, height, [
      { cx: 50, cy: 50, r: 14 }, // interior grain (~615 px)
      { cx: 10, cy: 118, r: 10 }, // touches bottom border (y=127 >= 128 - 2)
      { cx: 100, cy: 30, r: 2 }, // tiny grain (< minSize=30)
    ]);

    const res = flowsToMasksBrowser(flowY, flowX, cellprob, width, height, {
      minSize: 30,
      excludeBorderMargin: 2,
    });

    expect(res.grainCount).toBe(2);
    const interior = res.grains.find((g) => g.centroidX > 30);
    const border = res.grains.find((g) => g.centroidX < 30);

    expect(interior).toBeDefined();
    expect(interior!.touchesBorder).toBe(false);
    expect(Math.abs(interior!.centroidX - 50)).toBeLessThan(1.0);
    expect(Math.abs(interior!.centroidY - 50)).toBeLessThan(1.0);

    expect(border).toBeDefined();
    expect(border!.touchesBorder).toBe(true);
  });

  it('handles empty / zero-foreground inputs gracefully', () => {
    const w = 32;
    const h = 32;
    const zeros = new Float32Array(w * h);
    const negProb = new Float32Array(w * h).fill(-2.0);

    const resEmpty = flowsToMasksBrowser(zeros, zeros, negProb, w, h);
    expect(resEmpty.grainCount).toBe(0);
    expect(resEmpty.grains).toHaveLength(0);
    expect(resEmpty.masks.length).toBe(w * h);

    const resZeroDim = flowsToMasksBrowser(
      new Float32Array(0),
      new Float32Array(0),
      new Float32Array(0),
      0,
      0,
    );
    expect(resZeroDim.grainCount).toBe(0);
    expect(resZeroDim.masks.length).toBe(0);
  });
});

describe('eval_core.py Cell 11 exact parity', () => {
  it('uses unit flow normalization & squared 5.0-scaled unit error in F5_MagWeightedQC', () => {
    const width = 40;
    const height = 40;
    const { flowY, flowX, cellprob } = makeSyntheticRadialField(width, height, [
      { cx: 20, cy: 20, r: 10 },
    ]);

    // Scale raw flows to magnitude 2.0 (instead of 5.0). Because F5_MagWeightedQC
    // normalizes to unit flows before scaling by 5.0, a clean radial field still passes.
    const pixList: number[] = [];
    for (let i = 0; i < width * height; i++) {
      if (cellprob[i]! > 0) {
        pixList.push(i);
        flowY[i] = (flowY[i]! / 5.0) * 2.0;
        flowX[i] = (flowX[i]! / 5.0) * 2.0;
      }
    }

    const qc = evaluateGrainFlowQcV4(pixList, flowY, flowX, width, height, 0.45);
    expect(qc.passed).toBe(true);
    expect(qc.normalizedErr).toBeLessThan(0.1);
  });

  it('falls back to sinkHist > 0 when no pixel reaches minSeedDensity', () => {
    const width = 48;
    const height = 48;
    const { flowY, flowX, cellprob } = makeSyntheticRadialField(width, height, [
      { cx: 24, cy: 24, r: 8 },
    ]);

    // Set minSeedDensity impossibly high (> area of circle) so dense check fails
    // and must fall back to threshold = 1 (sinkHist > 0).
    const res = flowsToMasksBrowser(flowY, flowX, cellprob, width, height, {
      minSeedDensity: 10000,
      minSize: 30,
    });
    expect(res.grainCount).toBe(1);
    expect(res.grains[0]!.areaPx).toBeGreaterThan(150);
  });
});

describe('grainPostprocess.worker.ts — Web Worker message handler', () => {
  it('emits progress and result with Transferable masks buffer, and handles errors', async () => {
    const posted: Array<{ msg: WorkerResponse; transfer?: Transferable[] }> = [];
    const mockSelf = {
      onmessage: null as ((ev: MessageEvent<WorkerRequest>) => void) | null,
      postMessage: vi.fn((msg: WorkerResponse, transfer?: Transferable[]) => {
        posted.push({ msg, transfer });
      }),
    };

    vi.stubGlobal('self', mockSelf);
    try {
      const workerMod = await import(
        '../src/workers/grainPostprocess.worker.js'
      );

      expect(mockSelf.onmessage).toBe(workerMod.handleWorkerMessage);

      const width = 64;
      const height = 64;
      const { flowY, flowX, cellprob } = makeSyntheticRadialField(
        width,
        height,
        [{ cx: 32, cy: 32, r: 10 }],
      );

      const req: WorkerRequest = {
        type: 'postprocess',
        requestId: 'req-1',
        flowY,
        flowX,
        cellprob,
        width,
        height,
      };

      mockSelf.onmessage!({ data: req } as MessageEvent<WorkerRequest>);

      const progressMsgs = posted.filter((p) => p.msg.type === 'progress');
      const resultMsgs = posted.filter((p) => p.msg.type === 'result');

      expect(progressMsgs.length).toBeGreaterThan(0);
      expect(resultMsgs).toHaveLength(1);

      const resEntry = resultMsgs[0]!;
      expect(resEntry.msg.requestId).toBe('req-1');
      if (resEntry.msg.type === 'result') {
        expect(resEntry.msg.result.grainCount).toBe(1);
        expect(resEntry.transfer).toEqual([resEntry.msg.result.masks.buffer]);
      }

      // Error handling on mismatched buffer sizes
      posted.length = 0;
      mockSelf.onmessage!({
        data: {
          type: 'postprocess',
          requestId: 'req-err',
          flowY: new Float32Array(1),
          flowX,
          cellprob,
          width,
          height,
        },
      } as MessageEvent<WorkerRequest>);

      const errMsgs = posted.filter((p) => p.msg.type === 'error');
      expect(errMsgs).toHaveLength(1);
      expect(errMsgs[0]!.msg.requestId).toBe('req-err');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
