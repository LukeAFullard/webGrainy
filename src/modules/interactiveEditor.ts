import { orientationFromMoments } from './orientationGeometry.js';
import type {
  CalibrationResult,
  GrainMorphometrics,
  Point2D,
} from '../types/index.js';

interface MomentAccumulator {
  m00: number;
  m10: number;
  m01: number;
  m20: number;
  m02: number;
  m11: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  touchesBorder: boolean;
}

export interface EditOptions {
  borderMargin?: number;
  calibration?: CalibrationResult | number;
  grains?: readonly GrainMorphometrics[];
}

export interface MaskEditResult {
  applied: boolean;
  masks: Int32Array;
  affectedGrains: GrainMorphometrics[];
  newGrainIds: number[];
  removedGrainIds: number[];
  bbox: [number, number, number, number] | null;
  grains?: GrainMorphometrics[];
  reason?: string;
}

export interface MaskEditEntry {
  bbox: [number, number, number, number];
  imageWidth: number;
  before: Int32Array;
  after: Int32Array;
  grainsBefore?: GrainMorphometrics[];
  grainsAfter?: GrainMorphometrics[];
  label?: string;
}

function getMmPerPx(calibration?: CalibrationResult | number): number | undefined {
  if (calibration === undefined) {
    return undefined;
  }
  return typeof calibration === 'number' ? calibration : calibration.mmPerPx;
}

function finalizeMorphometrics(
  id: number,
  acc: MomentAccumulator,
  mmPerPx?: number,
): GrainMorphometrics {
  const area = acc.m00;
  const centroidX = acc.m10 / area;
  const centroidY = acc.m01 / area;
  const mu20 = acc.m20 / area - centroidX * centroidX;
  const mu02 = acc.m02 / area - centroidY * centroidY;
  const mu11 = acc.m11 / area - centroidX * centroidY;

  const common = Math.hypot(mu20 - mu02, 2 * mu11);
  const l1 = Math.max(0, (mu20 + mu02 + common) * 0.5);
  const l2 = Math.max(0, (mu20 + mu02 - common) * 0.5);

  const aAxisPx = 4 * Math.sqrt(l1);
  const bAxisPx = 4 * Math.sqrt(l2);
  const dEqPx = Math.sqrt((4 * area) / Math.PI);
  // skimage convention (angle from the vertical row axis), as in postprocessCore.
  const orientationRad = orientationFromMoments(mu20, mu02, mu11);

  const grain: GrainMorphometrics = {
    id,
    areaPx: area,
    centroidX,
    centroidY,
    aAxisPx,
    bAxisPx,
    dEqPx,
    orientationRad,
    touchesBorder: acc.touchesBorder,
    bbox: [acc.minX, acc.minY, acc.maxX, acc.maxY],
  };

  if (mmPerPx !== undefined && Number.isFinite(mmPerPx) && mmPerPx > 0) {
    grain.areaMm2 = area * mmPerPx * mmPerPx;
    grain.aAxisMm = aAxisPx * mmPerPx;
    grain.bAxisMm = bAxisPx * mmPerPx;
    grain.dEqMm = dEqPx * mmPerPx;
  }

  return grain;
}

function computeMorphometricsInBbox(
  masks: Int32Array,
  width: number,
  height: number,
  targetSet: Set<number>,
  bbox: [number, number, number, number],
  borderMargin: number,
  calibration?: CalibrationResult | number,
): GrainMorphometrics[] {
  if (targetSet.size === 0) {
    return [];
  }

  const mmPerPx = getMmPerPx(calibration);
  const minX = Math.max(0, bbox[0]);
  const minY = Math.max(0, bbox[1]);
  const maxX = Math.min(width - 1, bbox[2]);
  const maxY = Math.min(height - 1, bbox[3]);

  const accumulators = new Map<number, MomentAccumulator>();

  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * width;
    const yBorder = y < borderMargin || y >= height - borderMargin;
    const y2 = y * y;
    for (let x = minX; x <= maxX; x++) {
      const id = masks[rowOffset + x];
      if (id === undefined || id <= 0 || !targetSet.has(id)) {
        continue;
      }

      const touches = yBorder || x < borderMargin || x >= width - borderMargin;
      let acc = accumulators.get(id);
      if (acc === undefined) {
        acc = {
          m00: 1,
          m10: x,
          m01: y,
          m20: x * x,
          m02: y2,
          m11: x * y,
          minX: x,
          minY: y,
          maxX: x,
          maxY: y,
          touchesBorder: touches,
        };
        accumulators.set(id, acc);
      } else {
        acc.m00 += 1;
        acc.m10 += x;
        acc.m01 += y;
        acc.m20 += x * x;
        acc.m02 += y2;
        acc.m11 += x * y;
        if (x < acc.minX) acc.minX = x;
        if (y < acc.minY) acc.minY = y;
        if (x > acc.maxX) acc.maxX = x;
        if (y > acc.maxY) acc.maxY = y;
        if (touches) acc.touchesBorder = true;
      }
    }
  }

  const results: GrainMorphometrics[] = [];
  for (const [id, acc] of accumulators.entries()) {
    results.push(finalizeMorphometrics(id, acc, mmPerPx));
  }
  results.sort((a, b) => a.id - b.id);
  return results;
}

/**
 * Computes exact 2nd-order central moment morphometrics for a specific set of grain IDs.
 */
export function computeGrainMorphometricsForIds(
  masks: Int32Array,
  width: number,
  height: number,
  targetIds: Set<number> | number[],
  borderMargin = 2,
  calibration?: CalibrationResult | number,
): GrainMorphometrics[] {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions.');
  }

  const targetSet = new Set<number>();
  for (const id of targetIds) {
    if (id > 0) {
      targetSet.add(id);
    }
  }
  if (targetSet.size === 0) {
    return [];
  }

  return computeMorphometricsInBbox(
    masks,
    width,
    height,
    targetSet,
    [0, 0, width - 1, height - 1],
    borderMargin,
    calibration,
  );
}

/**
 * Computes morphometrics for all positive grain IDs present in `masks`.
 */
export function computeAllGrainMorphometrics(
  masks: Int32Array,
  width: number,
  height: number,
  borderMargin = 2,
  calibration?: CalibrationResult | number,
): GrainMorphometrics[] {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions.');
  }

  const mmPerPx = getMmPerPx(calibration);
  const accumulators = new Map<number, MomentAccumulator>();

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    const yBorder = y < borderMargin || y >= height - borderMargin;
    const y2 = y * y;
    for (let x = 0; x < width; x++) {
      const id = masks[rowOffset + x];
      if (id === undefined || id <= 0) {
        continue;
      }
      const touches = yBorder || x < borderMargin || x >= width - borderMargin;
      let acc = accumulators.get(id);
      if (acc === undefined) {
        acc = {
          m00: 1,
          m10: x,
          m01: y,
          m20: x * x,
          m02: y2,
          m11: x * y,
          minX: x,
          minY: y,
          maxX: x,
          maxY: y,
          touchesBorder: touches,
        };
        accumulators.set(id, acc);
      } else {
        acc.m00 += 1;
        acc.m10 += x;
        acc.m01 += y;
        acc.m20 += x * x;
        acc.m02 += y2;
        acc.m11 += x * y;
        if (x < acc.minX) acc.minX = x;
        if (y < acc.minY) acc.minY = y;
        if (x > acc.maxX) acc.maxX = x;
        if (y > acc.maxY) acc.maxY = y;
        if (touches) acc.touchesBorder = true;
      }
    }
  }

  const results: GrainMorphometrics[] = [];
  for (const [id, acc] of accumulators.entries()) {
    results.push(finalizeMorphometrics(id, acc, mmPerPx));
  }
  results.sort((a, b) => a.id - b.id);
  return results;
}

/**
 * Applies spatial calibration to an array of grain morphometrics.
 */
export function applyCalibrationToGrains(
  grains: readonly GrainMorphometrics[],
  calibration: CalibrationResult | number,
): GrainMorphometrics[] {
  return ScaleCalibrator.scaleAllMorphometrics(grains, calibration);
}

function updateGrainsList(
  existing: readonly GrainMorphometrics[] | undefined,
  affectedGrains: readonly GrainMorphometrics[],
  removedIds: readonly number[],
): GrainMorphometrics[] | undefined {
  if (existing === undefined) {
    return undefined;
  }
  const replaceIds = new Set<number>(removedIds);
  for (const g of affectedGrains) {
    replaceIds.add(g.id);
  }
  const next = existing.filter((g) => !replaceIds.has(g.id));
  for (const g of affectedGrains) {
    next.push(g);
  }
  next.sort((a, b) => a.id - b.id);
  return next;
}

function findGrainBbox(
  masks: Int32Array,
  width: number,
  height: number,
  grainId: number,
  grains?: readonly GrainMorphometrics[],
): [number, number, number, number] | null {
  if (grains !== undefined) {
    const found = grains.find((g) => g.id === grainId);
    if (found !== undefined) {
      return [found.bbox[0], found.bbox[1], found.bbox[2], found.bbox[3]];
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (masks[rowOffset + x] === grainId) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }
  return [minX, minY, maxX, maxY];
}

function findMaxGrainId(masks: Int32Array): number {
  let maxId = 0;
  for (let i = 0; i < masks.length; i++) {
    const v = masks[i];
    if (v !== undefined && v > maxId) {
      maxId = v;
    }
  }
  return maxId;
}

/**
 * Rasterizes a polyline into 4-connected pixel coordinates `(x, y)` so that
 * diagonal steps also mark an orthogonal corner `(xPrev, yNew)`, preventing
 * 8-connected BFS from leaking across 1-px diagonal cuts.
 */
function rasterize4ConnectedPolyline(
  linePoints: readonly Point2D[],
  width: number,
  height: number,
): number[] {
  const indices: number[] = [];
  const seen = new Set<number>();

  const plot = (x: number, y: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return;
    }
    const idx = y * width + x;
    if (!seen.has(idx)) {
      seen.add(idx);
      indices.push(idx);
    }
  };

  for (let i = 0; i < linePoints.length - 1; i++) {
    const p0 = linePoints[i];
    const p1 = linePoints[i + 1];
    if (
      p0 === undefined ||
      p1 === undefined ||
      !Number.isFinite(p0.x) ||
      !Number.isFinite(p0.y) ||
      !Number.isFinite(p1.x) ||
      !Number.isFinite(p1.y)
    ) {
      continue;
    }

    let x0 = Math.round(p0.x);
    let y0 = Math.round(p0.y);
    const x1 = Math.round(p1.x);
    const y1 = Math.round(p1.y);

    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    plot(x0, y0);

    while (x0 !== x1 || y0 !== y1) {
      const xPrev = x0;
      const yPrev = y0;
      const e2 = 2 * err;

      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }

      if (x0 !== xPrev && y0 !== yPrev) {
        plot(xPrev, y0);
      }
      plot(x0, y0);
    }
  }

  return indices;
}

/**
 * Splits a single grain along a user-drawn polyline using 4-connected rasterization
 * and 8-connected BFS component labeling.
 */
export function splitGrainAtLine(
  masks: Int32Array,
  grainId: number,
  linePoints: readonly Point2D[],
  width: number,
  height: number,
  minSize = 10,
  options?: EditOptions,
): MaskEditResult {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions.');
  }

  if (grainId <= 0 || linePoints.length < 2) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Invalid grainId or insufficient line points',
    };
  }

  const bbox = findGrainBbox(masks, width, height, grainId, options?.grains);
  if (bbox === null) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Grain not found',
    };
  }

  const [minX, minY, maxX, maxY] = bbox;
  const lineIndices = rasterize4ConnectedPolyline(linePoints, width, height);
  const clearedIndices: number[] = [];

  for (let i = 0; i < lineIndices.length; i++) {
    const idx = lineIndices[i];
    if (idx === undefined) continue;
    const y = Math.floor(idx / width);
    const x = idx - y * width;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY && masks[idx] === grainId) {
      masks[idx] = 0;
      clearedIndices.push(idx);
    }
  }

  if (clearedIndices.length === 0) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Line did not intersect grain',
    };
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const visited = new Uint8Array(bw * bh);
  const queue = new Int32Array(bw * bh);
  const components: number[][] = [];

  for (let ly = 0; ly < bh; ly++) {
    const gy = minY + ly;
    const globalRow = gy * width;
    const localRow = ly * bw;
    for (let lx = 0; lx < bw; lx++) {
      const localIdx = localRow + lx;
      if (visited[localIdx] !== 0) continue;
      const globalIdx = globalRow + minX + lx;
      if (masks[globalIdx] !== grainId) continue;

      const comp: number[] = [];
      let head = 0;
      let tail = 0;
      visited[localIdx] = 1;
      queue[tail++] = localIdx;

      while (head < tail) {
        const curLocal = queue[head++];
        if (curLocal === undefined) break;
        const cyLocal = Math.floor(curLocal / bw);
        const cxLocal = curLocal - cyLocal * bw;
        const cyGlobal = minY + cyLocal;
        const cxGlobal = minX + cxLocal;
        comp.push(cyGlobal * width + cxGlobal);

        for (let dy = -1; dy <= 1; dy++) {
          const ny = cyLocal + dy;
          if (ny < 0 || ny >= bh) continue;
          const nGlobalRow = (minY + ny) * width;
          const nLocalRow = ny * bw;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cxLocal + dx;
            if (nx < 0 || nx >= bw) continue;
            const nLocalIdx = nLocalRow + nx;
            if (visited[nLocalIdx] !== 0) continue;
            const nGlobalIdx = nGlobalRow + minX + nx;
            if (masks[nGlobalIdx] === grainId) {
              visited[nLocalIdx] = 1;
              queue[tail++] = nLocalIdx;
            }
          }
        }
      }

      components.push(comp);
    }
  }

  const validComponents: number[][] = [];
  const dustComponents: number[][] = [];
  for (const comp of components) {
    if (comp.length >= minSize) {
      validComponents.push(comp);
    } else {
      dustComponents.push(comp);
    }
  }

  if (validComponents.length < 2) {
    for (let i = 0; i < clearedIndices.length; i++) {
      const idx = clearedIndices[i];
      if (idx !== undefined) {
        masks[idx] = grainId;
      }
    }
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Split produced fewer than 2 valid components',
    };
  }

  validComponents.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return (a[0] ?? 0) - (b[0] ?? 0);
  });

  const maxExistingId = findMaxGrainId(masks);
  const newGrainIds: number[] = [];
  const affectedIdSet = new Set<number>([grainId]);

  for (let k = 1; k < validComponents.length; k++) {
    const comp = validComponents[k];
    if (comp === undefined) continue;
    const newId = maxExistingId + k;
    newGrainIds.push(newId);
    affectedIdSet.add(newId);
    for (let i = 0; i < comp.length; i++) {
      const idx = comp[i];
      if (idx !== undefined) {
        masks[idx] = newId;
      }
    }
  }

  for (const dust of dustComponents) {
    for (let i = 0; i < dust.length; i++) {
      const idx = dust[i];
      if (idx !== undefined) {
        masks[idx] = 0;
      }
    }
  }

  const borderMargin = options?.borderMargin ?? 2;
  const affectedGrains = computeMorphometricsInBbox(
    masks,
    width,
    height,
    affectedIdSet,
    bbox,
    borderMargin,
    options?.calibration,
  );

  return {
    applied: true,
    masks,
    affectedGrains,
    newGrainIds,
    removedGrainIds: [],
    bbox,
    grains: updateGrainsList(options?.grains, affectedGrains, []),
  };
}

/**
 * Merges 2 or more grains into `min(grainIds)` and runs a 1-pass 3x3
 * morphological closing inside the 1-px padded combined bounding box
 * to bridge 1-2 px gaps without overwriting unrelated grains.
 */
export function mergeGrains(
  masks: Int32Array,
  grainIds: readonly number[],
  width: number,
  height: number,
  options?: EditOptions,
): MaskEditResult {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions.');
  }

  const uniqueIds = Array.from(new Set(grainIds.filter((id) => id > 0)));
  if (uniqueIds.length < 2) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Need at least 2 distinct positive grain IDs to merge',
    };
  }

  const idSet = new Set<number>(uniqueIds);
  const presentIds = new Set<number>();

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const id = masks[rowOffset + x];
      if (id !== undefined && idSet.has(id)) {
        presentIds.add(id);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (presentIds.size < 2 || maxX < minX || maxY < minY) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Fewer than 2 target grains found in mask',
    };
  }

  const presentList = Array.from(presentIds).sort((a, b) => a - b);
  const targetId = presentList[0];
  if (targetId === undefined) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
    };
  }
  const removedGrainIds = presentList.slice(1);

  const padMinX = Math.max(0, minX - 1);
  const padMinY = Math.max(0, minY - 1);
  const padMaxX = Math.min(width - 1, maxX + 1);
  const padMaxY = Math.min(height - 1, maxY + 1);
  const paddedBbox: [number, number, number, number] = [
    padMinX,
    padMinY,
    padMaxX,
    padMaxY,
  ];

  // Relabel all selected IDs to targetId inside the combined bbox
  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * width;
    for (let x = minX; x <= maxX; x++) {
      const idx = rowOffset + x;
      const id = masks[idx];
      if (id !== undefined && idSet.has(id)) {
        masks[idx] = targetId;
      }
    }
  }

  // 1-pass 3x3 morphological closing on targetId inside paddedBbox:
  // Step 1: Dilate targetId into 0 (background) pixels only
  const dilatedIndices: number[] = [];
  for (let y = padMinY; y <= padMaxY; y++) {
    const rowOffset = y * width;
    for (let x = padMinX; x <= padMaxX; x++) {
      const idx = rowOffset + x;
      if (masks[idx] !== 0) continue;

      let hasTargetNeighbor = false;
      for (let dy = -1; dy <= 1 && !hasTargetNeighbor; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const nRow = ny * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (masks[nRow + nx] === targetId) {
            hasTargetNeighbor = true;
            break;
          }
        }
      }

      if (hasTargetNeighbor) {
        dilatedIndices.push(idx);
      }
    }
  }

  for (let i = 0; i < dilatedIndices.length; i++) {
    const idx = dilatedIndices[i];
    if (idx !== undefined) {
      masks[idx] = targetId;
    }
  }

  // Step 2: Erode dilated-only pixels that have any non-targetId 3x3 neighbor
  const toRevert: number[] = [];
  for (let i = 0; i < dilatedIndices.length; i++) {
    const idx = dilatedIndices[i];
    if (idx === undefined) continue;
    const y = Math.floor(idx / width);
    const x = idx - y * width;

    let shouldRevert = false;
    for (let dy = -1; dy <= 1 && !shouldRevert; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      const nRow = ny * width;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        if (masks[nRow + nx] !== targetId) {
          shouldRevert = true;
          break;
        }
      }
    }

    if (shouldRevert) {
      toRevert.push(idx);
    }
  }

  for (let i = 0; i < toRevert.length; i++) {
    const idx = toRevert[i];
    if (idx !== undefined) {
      masks[idx] = 0;
    }
  }

  const borderMargin = options?.borderMargin ?? 2;
  const affectedGrains = computeMorphometricsInBbox(
    masks,
    width,
    height,
    new Set([targetId]),
    paddedBbox,
    borderMargin,
    options?.calibration,
  );

  return {
    applied: true,
    masks,
    affectedGrains,
    newGrainIds: [],
    removedGrainIds,
    bbox: paddedBbox,
    grains: updateGrainsList(options?.grains, affectedGrains, removedGrainIds),
  };
}

/**
 * Deletes a grain by zeroing all of its pixels within its bounding box.
 */
export function deleteGrain(
  masks: Int32Array,
  grainId: number,
  width: number,
  height: number,
  options?: EditOptions,
): MaskEditResult {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions.');
  }

  if (grainId <= 0) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Invalid grainId',
    };
  }

  const bbox = findGrainBbox(masks, width, height, grainId, options?.grains);
  if (bbox === null) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Grain not found',
    };
  }

  const [minX, minY, maxX, maxY] = bbox;
  let cleared = 0;
  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * width;
    for (let x = minX; x <= maxX; x++) {
      const idx = rowOffset + x;
      if (masks[idx] === grainId) {
        masks[idx] = 0;
        cleared++;
      }
    }
  }

  if (cleared === 0) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Grain not found in mask',
    };
  }

  return {
    applied: true,
    masks,
    affectedGrains: [],
    newGrainIds: [],
    removedGrainIds: [grainId],
    bbox,
    grains: updateGrainsList(options?.grains, [], [grainId]),
  };
}

/**
 * Digitizes a new grain from a polygon using scanline fill over `0` (background)
 * pixels only. Reverts and returns `applied: false` if fewer than `minSize` pixels
 * are written.
 */
export function addPolygonGrain(
  masks: Int32Array,
  polygonPoints: readonly Point2D[],
  width: number,
  height: number,
  minSize = 10,
  options?: EditOptions,
): MaskEditResult {
  if (width <= 0 || height <= 0 || masks.length !== width * height) {
    throw new Error('Invalid mask dimensions.');
  }

  if (polygonPoints.length < 3) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Polygon requires at least 3 points',
    };
  }

  let polyMinX = Infinity;
  let polyMinY = Infinity;
  let polyMaxX = -Infinity;
  let polyMaxY = -Infinity;

  for (const pt of polygonPoints) {
    if (pt.x < polyMinX) polyMinX = pt.x;
    if (pt.y < polyMinY) polyMinY = pt.y;
    if (pt.x > polyMaxX) polyMaxX = pt.x;
    if (pt.y > polyMaxY) polyMaxY = pt.y;
  }

  const minX = Math.max(0, Math.floor(polyMinX));
  const minY = Math.max(0, Math.floor(polyMinY));
  const maxX = Math.min(width - 1, Math.ceil(polyMaxX));
  const maxY = Math.min(height - 1, Math.ceil(polyMaxY));

  if (minX > maxX || minY > maxY) {
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: 'Polygon outside image bounds',
    };
  }

  const newId = findMaxGrainId(masks) + 1;
  const writtenIndices: number[] = [];
  const n = polygonPoints.length;
  const intersections: number[] = [];

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    intersections.length = 0;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = polygonPoints[i];
      const pj = polygonPoints[j];
      if (pi === undefined || pj === undefined) continue;

      const yi = pi.y;
      const yj = pj.y;
      if ((yi <= py && yj > py) || (yj <= py && yi > py)) {
        const xInt = pi.x + ((py - yi) / (yj - yi)) * (pj.x - pi.x);
        intersections.push(xInt);
      }
    }

    if (intersections.length < 2) continue;
    intersections.sort((a, b) => a - b);

    const rowOffset = y * width;
    for (let k = 0; k + 1 < intersections.length; k += 2) {
      const xStart = intersections[k];
      const xEnd = intersections[k + 1];
      if (xStart === undefined || xEnd === undefined) continue;

      const xFrom = Math.max(minX, Math.ceil(xStart - 0.5));
      const xTo = Math.min(maxX, Math.floor(xEnd - 0.5));
      for (let x = xFrom; x <= xTo; x++) {
        const idx = rowOffset + x;
        if (masks[idx] === 0) {
          masks[idx] = newId;
          writtenIndices.push(idx);
        }
      }
    }
  }

  if (writtenIndices.length < minSize) {
    for (let i = 0; i < writtenIndices.length; i++) {
      const idx = writtenIndices[i];
      if (idx !== undefined) {
        masks[idx] = 0;
      }
    }
    return {
      applied: false,
      masks,
      affectedGrains: [],
      newGrainIds: [],
      removedGrainIds: [],
      bbox: null,
      grains: options?.grains ? [...options.grains] : undefined,
      reason: `Polygon area (${writtenIndices.length}) below minSize (${minSize})`,
    };
  }

  const bbox: [number, number, number, number] = [minX, minY, maxX, maxY];
  const borderMargin = options?.borderMargin ?? 2;
  const affectedGrains = computeMorphometricsInBbox(
    masks,
    width,
    height,
    new Set([newId]),
    bbox,
    borderMargin,
    options?.calibration,
  );

  const actualBbox = affectedGrains[0]?.bbox ?? bbox;

  return {
    applied: true,
    masks,
    affectedGrains,
    newGrainIds: [newId],
    removedGrainIds: [],
    bbox: actualBbox,
    grains: updateGrainsList(options?.grains, affectedGrains, []),
  };
}

/**
 * Lightweight Undo/Redo command stack storing Int32Array bounding-box diffs.
 */
export class MaskEditHistory {
  private entries: MaskEditEntry[] = [];
  private _cursor = -1;
  private readonly maxEntries: number;

  constructor(maxEntries = 100) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get length(): number {
    return this.entries.length;
  }

  get cursor(): number {
    return this._cursor;
  }

  get canUndo(): boolean {
    return this._cursor >= 0;
  }

  get canRedo(): boolean {
    return this._cursor < this.entries.length - 1;
  }

  static extractBboxSlice(
    masks: Int32Array,
    imageWidth: number,
    bbox: [number, number, number, number],
  ): Int32Array {
    const [minX, minY, maxX, maxY] = bbox;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const slice = new Int32Array(bw * bh);

    for (let ly = 0; ly < bh; ly++) {
      const srcStart = (minY + ly) * imageWidth + minX;
      slice.set(masks.subarray(srcStart, srcStart + bw), ly * bw);
    }

    return slice;
  }

  static applyBboxSlice(
    masks: Int32Array,
    imageWidth: number,
    bbox: [number, number, number, number],
    slice: Int32Array,
  ): void {
    const [minX, minY, maxX, maxY] = bbox;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    for (let ly = 0; ly < bh; ly++) {
      const dstStart = (minY + ly) * imageWidth + minX;
      const srcStart = ly * bw;
      masks.set(slice.subarray(srcStart, srcStart + bw), dstStart);
    }
  }

  push(entry: MaskEditEntry): void {
    if (this._cursor < this.entries.length - 1) {
      this.entries.length = this._cursor + 1;
    }
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this._cursor = this.entries.length - 1;
  }

  undo(masks: Int32Array): MaskEditEntry | null {
    if (!this.canUndo) {
      return null;
    }
    const entry = this.entries[this._cursor];
    if (entry === undefined) {
      return null;
    }
    MaskEditHistory.applyBboxSlice(masks, entry.imageWidth, entry.bbox, entry.before);
    this._cursor -= 1;
    return entry;
  }

  redo(masks: Int32Array): MaskEditEntry | null {
    if (!this.canRedo) {
      return null;
    }
    const nextCursor = this._cursor + 1;
    const entry = this.entries[nextCursor];
    if (entry === undefined) {
      return null;
    }
    MaskEditHistory.applyBboxSlice(masks, entry.imageWidth, entry.bbox, entry.after);
    this._cursor = nextCursor;
    return entry;
  }

  clear(): void {
    this.entries = [];
    this._cursor = -1;
  }
}

/**
 * Two-point spatial scale calibrator converting pixel coordinates + known
 * physical length (`mm` or `cm`) into `mmPerPx` and calibrated morphometrics.
 */
export class ScaleCalibrator {
  static calibrate(
    pointA: Point2D,
    pointB: Point2D,
    physicalLength: number,
    unit: 'mm' | 'cm' = 'mm',
  ): CalibrationResult {
    const pixelDistance = Math.hypot(pointB.x - pointA.x, pointB.y - pointA.y);
    if (!Number.isFinite(pixelDistance) || pixelDistance <= 0) {
      throw new Error('Reference points must have a positive pixel distance.');
    }
    if (!Number.isFinite(physicalLength) || physicalLength <= 0) {
      throw new Error('Physical length must be a positive finite number.');
    }

    const physicalLengthMm = unit === 'cm' ? physicalLength * 10 : physicalLength;
    const mmPerPx = physicalLengthMm / pixelDistance;

    return {
      mmPerPx,
      pointA: { x: pointA.x, y: pointA.y },
      pointB: { x: pointB.x, y: pointB.y },
      physicalLengthMm,
      pixelDistance,
    };
  }

  static scaleMorphometrics(
    grain: GrainMorphometrics,
    calibration: CalibrationResult | number,
  ): GrainMorphometrics {
    const mmPerPx = typeof calibration === 'number' ? calibration : calibration.mmPerPx;
    if (!Number.isFinite(mmPerPx) || mmPerPx <= 0) {
      throw new Error('Calibration mmPerPx must be a positive finite number.');
    }

    return {
      ...grain,
      bbox: [grain.bbox[0], grain.bbox[1], grain.bbox[2], grain.bbox[3]],
      areaMm2: grain.areaPx * mmPerPx * mmPerPx,
      aAxisMm: grain.aAxisPx * mmPerPx,
      bAxisMm: grain.bAxisPx * mmPerPx,
      dEqMm: grain.dEqPx * mmPerPx,
      ...(grain.minFeretPx !== undefined ? { minFeretMm: grain.minFeretPx * mmPerPx } : {}),
      ...(grain.maxFeretPx !== undefined ? { maxFeretMm: grain.maxFeretPx * mmPerPx } : {}),
    };
  }

  static scaleAllMorphometrics(
    grains: readonly GrainMorphometrics[],
    calibration: CalibrationResult | number,
  ): GrainMorphometrics[] {
    return grains.map((g) => ScaleCalibrator.scaleMorphometrics(g, calibration));
  }

  calibrate(
    pointA: Point2D,
    pointB: Point2D,
    physicalLength: number,
    unit: 'mm' | 'cm' = 'mm',
  ): CalibrationResult {
    return ScaleCalibrator.calibrate(pointA, pointB, physicalLength, unit);
  }

  scaleMorphometrics(
    grain: GrainMorphometrics,
    calibration: CalibrationResult | number,
  ): GrainMorphometrics {
    return ScaleCalibrator.scaleMorphometrics(grain, calibration);
  }

  scaleAllMorphometrics(
    grains: readonly GrainMorphometrics[],
    calibration: CalibrationResult | number,
  ): GrainMorphometrics[] {
    return ScaleCalibrator.scaleAllMorphometrics(grains, calibration);
  }
}
