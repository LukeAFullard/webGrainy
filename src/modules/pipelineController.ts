import type * as ort from 'onnxruntime-web';
import type {
  AnalysisConfig,
  CalibrationResult,
  EngineCapabilities,
  GrainMorphometrics,
  InferenceOutput,
  ModelDownloadOptions,
  ModelId,
  ModelKind,
  ModelRecommendation,
  Point2D,
  PostProcessOptions,
  PostProcessResult,
  SedimentStatsReport,
  WorkerRequest,
  WorkerResponse,
  WorkingImageResult,
} from '../types/index.js';
import { getCachedModels, getModel } from './modelCache.js';
import {
  applyCLAHE,
  normalizeGray,
  normalizeRgbJoint99,
  prepareWorkingImage,
  recommendModel,
  type ImageBufferLike,
} from './imagePreprocess.js';
import {
  createInferenceSession,
  runCpsamTiledInference,
  runUnetInference,
  type SessionCreateOptions,
} from './onnxInference.js';
import { flowsToMasksBrowser } from './postprocessCore.js';
import {
  addPolygonGrain as editorAddPolygonGrain,
  computeAllGrainMorphometrics,
  deleteGrain as editorDeleteGrain,
  MaskEditHistory,
  mergeGrains as editorMergeGrains,
  ScaleCalibrator,
  splitGrainAtLine as editorSplitGrainAtLine,
} from './interactiveEditor.js';
import { computeSedimentStats } from './sedimentStats.js';

export interface InferenceSessionLike {
  run(
    feeds: Record<string, unknown>,
    options?: unknown,
  ): Promise<Record<string, { data: unknown; dims?: readonly number[] }>>;
  release?: () => Promise<void>;
}

export interface ImageGrainsEngineOptions {
  sessionFactory?: (
    modelKind: ModelKind,
  ) => Promise<ort.InferenceSession | InferenceSessionLike>;
  workerFactory?: () => Worker;
  useWorker?: boolean;
  modelDownloadOptions?: ModelDownloadOptions;
  sessionCreateOptions?: SessionCreateOptions;
}

const DEFAULT_PERCENTILES = [5, 10, 16, 25, 50, 75, 84, 90, 95] as const;

const MODEL_ID_BY_KIND: Record<ModelKind, ModelId> = {
  unet: 'ig2_unet_fp32',
  cpsam: 'ig2_cpsam_fp16',
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0;
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD_ADLER = 65521;
  for (let i = 0; i < data.length; i++) {
    a = (a + (data[i] ?? 0)) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeUint32BE(chunk, 0, data.length);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  writeUint32BE(chunk, 8 + data.length, crc);
  return chunk;
}

function deflateStoredZlib(raw: Uint8Array): Uint8Array {
  const maxBlock = 65535;
  const numBlocks = Math.max(1, Math.ceil(raw.length / maxBlock));
  const totalLen = 2 + numBlocks * 5 + raw.length + 4;
  const out = new Uint8Array(totalLen);

  out[0] = 0x78;
  out[1] = 0x01;

  let outPos = 2;
  let inPos = 0;

  for (let b = 0; b < numBlocks; b++) {
    const remaining = raw.length - inPos;
    const blockLen = Math.min(maxBlock, remaining);
    const isFinal = b === numBlocks - 1 ? 1 : 0;
    const nlen = ~blockLen & 0xffff;

    out[outPos++] = isFinal;
    out[outPos++] = blockLen & 0xff;
    out[outPos++] = (blockLen >>> 8) & 0xff;
    out[outPos++] = nlen & 0xff;
    out[outPos++] = (nlen >>> 8) & 0xff;

    if (blockLen > 0) {
      out.set(raw.subarray(inPos, inPos + blockLen), outPos);
      outPos += blockLen;
      inPos += blockLen;
    }
  }

  const adler = adler32(raw);
  writeUint32BE(out, outPos, adler);
  return out;
}

type ContourRing = Array<[number, number]>;

function traceGrainContours(
  masks: Int32Array,
  width: number,
  height: number,
  grainId: number,
  bbox: [number, number, number, number],
  scaleInv: number,
): { outers: ContourRing[]; holes: ContourRing[] } {
  const minX = Math.max(0, Math.floor(bbox[0]));
  const minY = Math.max(0, Math.floor(bbox[1]));
  const maxX = Math.min(width - 1, Math.ceil(bbox[2]));
  const maxY = Math.min(height - 1, Math.ceil(bbox[3]));

  const isInside = (x: number, y: number): number => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return masks[y * width + x] === grainId ? 1 : 0;
  };

  const strideX = (width + 2) * 2;
  const toKey = (x2: number, y2: number): number => (y2 + 2) * strideX + (x2 + 2);

  const adj = new Map<number, number[]>();
  const addSegment = (
    ax2: number,
    ay2: number,
    bx2: number,
    by2: number,
  ): void => {
    const kA = toKey(ax2, ay2);
    const kB = toKey(bx2, by2);
    let list = adj.get(kA);
    if (list === undefined) {
      list = [kB];
      adj.set(kA, list);
    } else {
      list.push(kB);
    }
  };

  for (let cy = minY - 1; cy <= maxY; cy++) {
    for (let cx = minX - 1; cx <= maxX; cx++) {
      const tl = isInside(cx, cy);
      const tr = isInside(cx + 1, cy);
      const br = isInside(cx + 1, cy + 1);
      const bl = isInside(cx, cy + 1);
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      const tx = 2 * cx + 2;
      const ty = 2 * cy + 1;
      const rx = 2 * cx + 3;
      const ry = 2 * cy + 2;
      const bx = 2 * cx + 2;
      const by = 2 * cy + 3;
      const lx = 2 * cx + 1;
      const ly = 2 * cy + 2;

      switch (code) {
        case 1:
          addSegment(bx, by, lx, ly);
          break;
        case 2:
          addSegment(rx, ry, bx, by);
          break;
        case 3:
          addSegment(rx, ry, lx, ly);
          break;
        case 4:
          addSegment(tx, ty, rx, ry);
          break;
        case 5:
          addSegment(tx, ty, rx, ry);
          addSegment(bx, by, lx, ly);
          break;
        case 6:
          addSegment(tx, ty, bx, by);
          break;
        case 7:
          addSegment(tx, ty, lx, ly);
          break;
        case 8:
          addSegment(lx, ly, tx, ty);
          break;
        case 9:
          addSegment(bx, by, tx, ty);
          break;
        case 10:
          addSegment(lx, ly, tx, ty);
          addSegment(rx, ry, bx, by);
          break;
        case 11:
          addSegment(rx, ry, tx, ty);
          break;
        case 12:
          addSegment(lx, ly, rx, ry);
          break;
        case 13:
          addSegment(bx, by, rx, ry);
          break;
        case 14:
          addSegment(lx, ly, bx, by);
          break;
      }
    }
  }

  const decodePoint = (key: number): [number, number] => {
    const y2 = Math.floor(key / strideX) - 2;
    const x2 = (key % strideX) - 2;
    return [x2 * 0.5 * scaleInv, y2 * 0.5 * scaleInv];
  };

  const outersWithArea: Array<{ ring: ContourRing; absArea2: number }> = [];
  const holes: ContourRing[] = [];

  for (const [startKey, startNeighbors] of adj.entries()) {
    while (startNeighbors.length > 0) {
      const ring: ContourRing = [decodePoint(startKey)];
      const firstNext = startNeighbors.pop();
      if (firstNext === undefined) break;

      let curr = firstNext;
      while (curr !== startKey) {
        ring.push(decodePoint(curr));
        const neighbors = adj.get(curr);
        if (neighbors === undefined || neighbors.length === 0) {
          break;
        }
        const next = neighbors.pop();
        if (next === undefined) break;
        curr = next;
      }

      const firstPt = ring[0];
      if (firstPt !== undefined) {
        ring.push([firstPt[0], firstPt[1]]);
      }

      if (ring.length < 4) continue;

      let signedArea2 = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const p0 = ring[i];
        const p1 = ring[i + 1];
        if (p0 === undefined || p1 === undefined) continue;
        signedArea2 += p0[0] * p1[1] - p1[0] * p0[1];
      }

      if (signedArea2 <= 0) {
        outersWithArea.push({ ring, absArea2: Math.abs(signedArea2) });
      } else {
        holes.push(ring);
      }
    }
  }

  outersWithArea.sort((a, b) => b.absArea2 - a.absArea2);
  const outers = outersWithArea.map((entry) => entry.ring);
  return { outers, holes };
}

function pointInRing(pt: [number, number], ring: ContourRing): boolean {
  const px = pt[0];
  const py = pt[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (pi === undefined || pj === undefined) continue;
    const xi = pi[0];
    const yi = pi[1];
    const xj = pj[0];
    const yj = pj[1];
    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function createAbortError(message = 'Analysis aborted'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function probeWasmSimd(): boolean {
  try {
    if (
      typeof WebAssembly === 'undefined' ||
      typeof WebAssembly.validate !== 'function'
    ) {
      return false;
    }
    const simdWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x16, 0x01, 0x14, 0x00,
      0xfd, 0x0c,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0x0b,
    ]);
    return WebAssembly.validate(simdWasm);
  } catch {
    return false;
  }
}

function isImageBufferLike(
  image: ImageBitmap | ImageData | ImageBufferLike,
): image is ImageData | ImageBufferLike {
  return (
    typeof image === 'object' &&
    image !== null &&
    'data' in image &&
    'width' in image &&
    'height' in image
  );
}

function extractImageBuffer(
  image: ImageBitmap | ImageData | ImageBufferLike,
): ImageBufferLike {
  if (isImageBufferLike(image)) {
    return {
      data: image.data,
      width: image.width,
      height: image.height,
    };
  }

  const width = image.width;
  const height = image.height;

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context on OffscreenCanvas.');
    }
    ctx.drawImage(image, 0, 0);
    const imgData = ctx.getImageData(0, 0, width, height);
    return {
      data: imgData.data,
      width: imgData.width,
      height: imgData.height,
    };
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context on HTMLCanvasElement.');
    }
    ctx.drawImage(image, 0, 0);
    const imgData = ctx.getImageData(0, 0, width, height);
    return {
      data: imgData.data,
      width: imgData.width,
      height: imgData.height,
    };
  }

  throw new Error(
    'Cannot convert ImageBitmap: neither OffscreenCanvas nor document is available.',
  );
}

function cloneGrain(grain: GrainMorphometrics): GrainMorphometrics {
  return {
    ...grain,
    bbox: [grain.bbox[0], grain.bbox[1], grain.bbox[2], grain.bbox[3]],
  };
}

function rescaleGrainToOriginal(
  grain: GrainMorphometrics,
  scaleFactor: number,
): GrainMorphometrics {
  if (scaleFactor === 1 || scaleFactor <= 0) {
    return cloneGrain(grain);
  }
  const inv = 1 / scaleFactor;
  const invSq = inv * inv;
  return {
    ...grain,
    centroidX: grain.centroidX * inv,
    centroidY: grain.centroidY * inv,
    aAxisPx: grain.aAxisPx * inv,
    bAxisPx: grain.bAxisPx * inv,
    dEqPx: grain.dEqPx * inv,
    areaPx: grain.areaPx * invSq,
    bbox: [
      grain.bbox[0] * inv,
      grain.bbox[1] * inv,
      grain.bbox[2] * inv,
      grain.bbox[3] * inv,
    ],
  };
}

/**
 * Reactive analysis session holding segmentation masks, morphometrics,
 * undo/redo edit history, spatial calibration, statistics, and synchronous exports.
 */
export class AnalysisSession {
  readonly workingImage: WorkingImageResult;
  readonly recommendation: ModelRecommendation;

  private readonly workingMasks: Int32Array;
  private workingGrains: GrainMorphometrics[];
  private grains: GrainMorphometrics[];
  private stats: SedimentStatsReport;
  private calibration: CalibrationResult | undefined;
  private excludeBorder: boolean;
  private readonly borderMargin: number;
  private readonly history = new MaskEditHistory();
  private readonly listeners = new Set<(session: AnalysisSession) => void>();

  constructor(params: {
    workingImage: WorkingImageResult;
    recommendation: ModelRecommendation;
    masks: Int32Array;
    workingGrains: GrainMorphometrics[];
    calibration?: CalibrationResult;
    excludeBorder?: boolean;
    borderMargin?: number;
  }) {
    this.workingImage = params.workingImage;
    this.recommendation = params.recommendation;
    this.workingMasks = params.masks;
    this.workingGrains = params.workingGrains.map(cloneGrain);
    this.calibration = params.calibration;
    this.excludeBorder = params.excludeBorder ?? true;
    this.borderMargin = params.borderMargin ?? 2;
    this.grains = [];
    this.stats = computeSedimentStats([], { excludeBorder: this.excludeBorder });
    this.recomputeDerivedState(false);
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  getResult(): PostProcessResult {
    return {
      masks: this.workingMasks,
      width: this.workingImage.width,
      height: this.workingImage.height,
      grains: this.grains.map(cloneGrain),
      grainCount: this.grains.length,
    };
  }

  getStats(): SedimentStatsReport {
    return this.stats;
  }

  subscribe(listener: (session: AnalysisSession) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  splitGrainAtLine(
    grainId: number,
    linePoints: readonly Point2D[],
    options?: { minSize?: number },
  ): boolean {
    const s = this.workingImage.effectiveScaleFactor;
    const scaledPoints =
      s !== 1 && s > 0
        ? linePoints.map((pt) => ({ x: pt.x * s, y: pt.y * s }))
        : linePoints;

    const prevMasks = this.workingMasks.slice();
    const prevGrains = this.workingGrains.map(cloneGrain);

    const res = editorSplitGrainAtLine(
      this.workingMasks,
      grainId,
      scaledPoints,
      this.workingImage.width,
      this.workingImage.height,
      options?.minSize,
      {
        borderMargin: this.borderMargin,
        grains: this.workingGrains,
      },
    );

    if (!res.applied || !res.bbox) {
      return false;
    }

    const nextGrains =
      res.grains ??
      computeAllGrainMorphometrics(
        this.workingMasks,
        this.workingImage.width,
        this.workingImage.height,
        this.borderMargin,
      );

    this.history.push({
      bbox: res.bbox,
      imageWidth: this.workingImage.width,
      before: MaskEditHistory.extractBboxSlice(
        prevMasks,
        this.workingImage.width,
        res.bbox,
      ),
      after: MaskEditHistory.extractBboxSlice(
        this.workingMasks,
        this.workingImage.width,
        res.bbox,
      ),
      grainsBefore: prevGrains,
      grainsAfter: nextGrains.map(cloneGrain),
      label: 'split',
    });

    this.workingGrains = nextGrains;
    this.recomputeDerivedState(true);
    return true;
  }

  splitGrain(
    grainId: number,
    linePoints: readonly Point2D[],
    options?: { minSize?: number },
  ): boolean {
    return this.splitGrainAtLine(grainId, linePoints, options);
  }

  mergeGrains(grainIds: readonly number[]): boolean {
    const prevMasks = this.workingMasks.slice();
    const prevGrains = this.workingGrains.map(cloneGrain);

    const res = editorMergeGrains(
      this.workingMasks,
      grainIds,
      this.workingImage.width,
      this.workingImage.height,
      {
        borderMargin: this.borderMargin,
        grains: this.workingGrains,
      },
    );

    if (!res.applied || !res.bbox) {
      return false;
    }

    const nextGrains =
      res.grains ??
      computeAllGrainMorphometrics(
        this.workingMasks,
        this.workingImage.width,
        this.workingImage.height,
        this.borderMargin,
      );

    this.history.push({
      bbox: res.bbox,
      imageWidth: this.workingImage.width,
      before: MaskEditHistory.extractBboxSlice(
        prevMasks,
        this.workingImage.width,
        res.bbox,
      ),
      after: MaskEditHistory.extractBboxSlice(
        this.workingMasks,
        this.workingImage.width,
        res.bbox,
      ),
      grainsBefore: prevGrains,
      grainsAfter: nextGrains.map(cloneGrain),
      label: 'merge',
    });

    this.workingGrains = nextGrains;
    this.recomputeDerivedState(true);
    return true;
  }

  deleteGrain(grainId: number): boolean {
    const prevMasks = this.workingMasks.slice();
    const prevGrains = this.workingGrains.map(cloneGrain);

    const res = editorDeleteGrain(
      this.workingMasks,
      grainId,
      this.workingImage.width,
      this.workingImage.height,
      {
        borderMargin: this.borderMargin,
        grains: this.workingGrains,
      },
    );

    if (!res.applied || !res.bbox) {
      return false;
    }

    const nextGrains =
      res.grains ??
      computeAllGrainMorphometrics(
        this.workingMasks,
        this.workingImage.width,
        this.workingImage.height,
        this.borderMargin,
      );

    this.history.push({
      bbox: res.bbox,
      imageWidth: this.workingImage.width,
      before: MaskEditHistory.extractBboxSlice(
        prevMasks,
        this.workingImage.width,
        res.bbox,
      ),
      after: MaskEditHistory.extractBboxSlice(
        this.workingMasks,
        this.workingImage.width,
        res.bbox,
      ),
      grainsBefore: prevGrains,
      grainsAfter: nextGrains.map(cloneGrain),
      label: 'delete',
    });

    this.workingGrains = nextGrains;
    this.recomputeDerivedState(true);
    return true;
  }

  addPolygonGrain(
    polygonPoints: readonly Point2D[],
    options?: { minSize?: number },
  ): number {
    const s = this.workingImage.effectiveScaleFactor;
    const scaledPoints =
      s !== 1 && s > 0
        ? polygonPoints.map((pt) => ({ x: pt.x * s, y: pt.y * s }))
        : polygonPoints;

    const prevMasks = this.workingMasks.slice();
    const prevGrains = this.workingGrains.map(cloneGrain);

    const res = editorAddPolygonGrain(
      this.workingMasks,
      scaledPoints,
      this.workingImage.width,
      this.workingImage.height,
      options?.minSize,
      {
        borderMargin: this.borderMargin,
        grains: this.workingGrains,
      },
    );

    const newGrainId = res.newGrainIds[0] ?? 0;
    if (!res.applied || !res.bbox || newGrainId <= 0) {
      return 0;
    }

    const nextGrains =
      res.grains ??
      computeAllGrainMorphometrics(
        this.workingMasks,
        this.workingImage.width,
        this.workingImage.height,
        this.borderMargin,
      );

    this.history.push({
      bbox: res.bbox,
      imageWidth: this.workingImage.width,
      before: MaskEditHistory.extractBboxSlice(
        prevMasks,
        this.workingImage.width,
        res.bbox,
      ),
      after: MaskEditHistory.extractBboxSlice(
        this.workingMasks,
        this.workingImage.width,
        res.bbox,
      ),
      grainsBefore: prevGrains,
      grainsAfter: nextGrains.map(cloneGrain),
      label: 'addPolygon',
    });

    this.workingGrains = nextGrains;
    this.recomputeDerivedState(true);
    return newGrainId;
  }

  undo(): boolean {
    const entry = this.history.undo(this.workingMasks);
    if (!entry) {
      return false;
    }
    this.workingGrains = entry.grainsBefore
      ? entry.grainsBefore.map(cloneGrain)
      : computeAllGrainMorphometrics(
          this.workingMasks,
          this.workingImage.width,
          this.workingImage.height,
          this.borderMargin,
        );
    this.recomputeDerivedState(true);
    return true;
  }

  redo(): boolean {
    const entry = this.history.redo(this.workingMasks);
    if (!entry) {
      return false;
    }
    this.workingGrains = entry.grainsAfter
      ? entry.grainsAfter.map(cloneGrain)
      : computeAllGrainMorphometrics(
          this.workingMasks,
          this.workingImage.width,
          this.workingImage.height,
          this.borderMargin,
        );
    this.recomputeDerivedState(true);
    return true;
  }

  setCalibration(calibration: CalibrationResult | undefined): void {
    this.calibration = calibration;
    this.recomputeDerivedState(true);
  }

  calibrateScale(
    pointA: Point2D,
    pointB: Point2D,
    physicalLength: number,
    unit: 'mm' | 'cm' = 'mm',
  ): CalibrationResult {
    const cal = ScaleCalibrator.calibrate(pointA, pointB, physicalLength, unit);
    this.setCalibration(cal);
    return cal;
  }

  setExcludeBorder(excludeBorder: boolean): void {
    this.excludeBorder = excludeBorder;
    this.recomputeDerivedState(true);
  }

  exportCsv(): string {
    const header =
      'grain_id,centroid_x,centroid_y,area_px,a_axis_px,b_axis_px,d_eq_px,a_axis_mm,b_axis_mm,d_eq_mm,touches_border';
    const lines: string[] = [header];

    for (const g of this.grains) {
      const row = [
        g.id,
        g.centroidX,
        g.centroidY,
        g.areaPx,
        g.aAxisPx,
        g.bAxisPx,
        g.dEqPx,
        g.aAxisMm !== undefined ? g.aAxisMm : '',
        g.bAxisMm !== undefined ? g.bAxisMm : '',
        g.dEqMm !== undefined ? g.dEqMm : '',
        g.touchesBorder,
      ].join(',');
      lines.push(row);
    }

    return lines.join('\n');
  }

  exportSummaryJson(): string {
    return JSON.stringify(this.stats, null, 2);
  }

  exportSummaryCsv(): string {
    const report = this.stats;
    const lines: string[] = ['section,metric,value,unit'];

    lines.push(`summary,total_grains,${report.totalGrains},count`);
    lines.push(`summary,included_grains,${report.includedGrains},count`);
    lines.push(
      `summary,excluded_border_grains,${report.excludedBorderGrains},count`,
    );
    lines.push(`summary,unit,${report.unit},unit`);

    const distributions: Array<[string, typeof report.areaWeightedB]> = [
      ['area_weighted_b', report.areaWeightedB],
      ['number_weighted_b', report.numberWeightedB],
      ['area_weighted_d_eq', report.areaWeightedDEq],
      ['number_weighted_d_eq', report.numberWeightedDEq],
    ];

    for (const [section, psd] of distributions) {
      for (const p of DEFAULT_PERCENTILES) {
        const key = `D${p}` as keyof typeof psd;
        lines.push(`${section},${key},${psd[key]},${report.unit}`);
      }
    }

    if (report.folkWard !== null) {
      const fw = report.folkWard;
      lines.push(`folk_ward,mean_phi,${fw.meanPhi},phi`);
      lines.push(`folk_ward,sorting_phi,${fw.sortingPhi},phi`);
      lines.push(`folk_ward,skewness_phi,${fw.skewnessPhi},phi`);
      lines.push(`folk_ward,kurtosis_phi,${fw.kurtosisPhi},phi`);
      lines.push(`folk_ward,mean_mm,${fw.meanMm},mm`);
      lines.push(`folk_ward,sorting_label,"${fw.sortingLabel}",label`);
      lines.push(`folk_ward,skewness_label,"${fw.skewnessLabel}",label`);
      lines.push(`folk_ward,kurtosis_label,"${fw.kurtosisLabel}",label`);
    }

    if (report.wentworth !== null) {
      const w = report.wentworth;
      lines.push(`wentworth,sand_pct,${w.sandPct},%`);
      lines.push(`wentworth,gravel_pct,${w.gravelPct},%`);
      lines.push(`wentworth,cobble_pct,${w.cobblePct},%`);
      lines.push(`wentworth,boulder_pct,${w.boulderPct},%`);
    }

    return lines.join('\n');
  }

  exportMaskPng(bitDepth: 16 | 32 = 16): Uint8Array {
    const width = this.workingImage.width;
    const height = this.workingImage.height;
    const masks = this.workingMasks;
    if (width <= 0 || height <= 0 || masks.length !== width * height) {
      throw new Error('Invalid mask dimensions for PNG export.');
    }

    const bytesPerPixel = bitDepth === 16 ? 2 : 4;
    const rowBytes = 1 + width * bytesPerPixel;
    const raw = new Uint8Array(rowBytes * height);

    if (bitDepth === 16) {
      for (let y = 0; y < height; y++) {
        const rawRow = y * rowBytes;
        raw[rawRow] = 0;
        const maskRow = y * width;
        for (let x = 0; x < width; x++) {
          const id = masks[maskRow + x] ?? 0;
          const clamped = id <= 0 ? 0 : id > 65535 ? 65535 : id;
          const pos = rawRow + 1 + x * 2;
          raw[pos] = (clamped >>> 8) & 0xff;
          raw[pos + 1] = clamped & 0xff;
        }
      }
    } else {
      for (let y = 0; y < height; y++) {
        const rawRow = y * rowBytes;
        raw[rawRow] = 0;
        const maskRow = y * width;
        for (let x = 0; x < width; x++) {
          const id = (masks[maskRow + x] ?? 0) >>> 0;
          const pos = rawRow + 1 + x * 4;
          raw[pos] = (id >>> 24) & 0xff;
          raw[pos + 1] = (id >>> 16) & 0xff;
          raw[pos + 2] = (id >>> 8) & 0xff;
          raw[pos + 3] = id & 0xff;
        }
      }
    }

    const ihdrData = new Uint8Array(13);
    writeUint32BE(ihdrData, 0, width);
    writeUint32BE(ihdrData, 4, height);
    ihdrData[8] = bitDepth === 16 ? 16 : 8;
    ihdrData[9] = bitDepth === 16 ? 0 : 6;
    ihdrData[10] = 0;
    ihdrData[11] = 0;
    ihdrData[12] = 0;

    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdrChunk = makePngChunk('IHDR', ihdrData);
    const idatChunk = makePngChunk('IDAT', deflateStoredZlib(raw));
    const iendChunk = makePngChunk('IEND', new Uint8Array(0));

    const pngBytes = new Uint8Array(
      signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
    );
    let offset = 0;
    pngBytes.set(signature, offset);
    offset += signature.length;
    pngBytes.set(ihdrChunk, offset);
    offset += ihdrChunk.length;
    pngBytes.set(idatChunk, offset);
    offset += idatChunk.length;
    pngBytes.set(iendChunk, offset);

    return pngBytes;
  }

  exportGeoJson(): string {
    const width = this.workingImage.width;
    const height = this.workingImage.height;
    const s = this.workingImage.effectiveScaleFactor;
    const scaleInv = s !== 1 && s > 0 ? 1 / s : 1;

    const grainById = new Map<number, GrainMorphometrics>();
    for (const g of this.grains) {
      grainById.set(g.id, g);
    }

    const features: Array<{
      type: 'Feature';
      geometry:
        | { type: 'Polygon'; coordinates: ContourRing[] }
        | { type: 'MultiPolygon'; coordinates: ContourRing[][] };
      properties: Record<string, unknown>;
    }> = [];

    for (const wg of this.workingGrains) {
      const g = grainById.get(wg.id) ?? wg;
      const { outers, holes } = traceGrainContours(
        this.workingMasks,
        width,
        height,
        wg.id,
        wg.bbox,
        scaleInv,
      );
      if (outers.length === 0) continue;

      let geometry:
        | { type: 'Polygon'; coordinates: ContourRing[] }
        | { type: 'MultiPolygon'; coordinates: ContourRing[][] };

      if (outers.length === 1) {
        geometry = {
          type: 'Polygon' as const,
          coordinates: [outers[0]!, ...holes],
        };
      } else {
        const polygons: ContourRing[][] = outers.map((outer) => [outer]);
        for (const hole of holes) {
          const testPt = hole[0];
          let targetIdx = 0;
          if (testPt !== undefined) {
            for (let i = outers.length - 1; i >= 0; i--) {
              const outer = outers[i];
              if (outer !== undefined && pointInRing(testPt, outer)) {
                targetIdx = i;
                break;
              }
            }
          }
          polygons[targetIdx]!.push(hole);
        }
        geometry = {
          type: 'MultiPolygon' as const,
          coordinates: polygons,
        };
      }

      const properties: Record<string, unknown> = {
        grainId: g.id,
        areaPx: g.areaPx,
        centroidX: g.centroidX,
        centroidY: g.centroidY,
        aAxisPx: g.aAxisPx,
        bAxisPx: g.bAxisPx,
        dEqPx: g.dEqPx,
        orientationRad: g.orientationRad,
        touchesBorder: g.touchesBorder,
      };

      if (g.areaMm2 !== undefined) properties['areaMm2'] = g.areaMm2;
      if (g.aAxisMm !== undefined) properties['aAxisMm'] = g.aAxisMm;
      if (g.bAxisMm !== undefined) properties['bAxisMm'] = g.bAxisMm;
      if (g.dEqMm !== undefined) properties['dEqMm'] = g.dEqMm;

      features.push({
        type: 'Feature',
        geometry,
        properties,
      });
    }

    return JSON.stringify({
      type: 'FeatureCollection',
      features,
    });
  }

  exportSvg(): string {
    const width = this.workingImage.width;
    const height = this.workingImage.height;
    const origWidth = this.workingImage.originalWidth;
    const origHeight = this.workingImage.originalHeight;
    const s = this.workingImage.effectiveScaleFactor;
    const scaleInv = s !== 1 && s > 0 ? 1 / s : 1;

    const paths: string[] = [];

    for (const wg of this.workingGrains) {
      const { outers, holes } = traceGrainContours(
        this.workingMasks,
        width,
        height,
        wg.id,
        wg.bbox,
        scaleInv,
      );
      if (outers.length === 0) continue;

      const allRings = [...outers, ...holes];
      const dParts: string[] = [];

      for (const ring of allRings) {
        if (ring.length < 3) continue;
        const first = ring[0];
        if (first === undefined) continue;
        let d = `M ${first[0]} ${first[1]}`;
        for (let i = 1; i < ring.length - 1; i++) {
          const pt = ring[i];
          if (pt !== undefined) {
            d += ` L ${pt[0]} ${pt[1]}`;
          }
        }
        d += ' Z';
        dParts.push(d);
      }

      if (dParts.length > 0) {
        paths.push(
          `  <path data-grain-id="${wg.id}" fill="rgba(56, 189, 248, 0.25)" stroke="#0284c7" stroke-width="1" fill-rule="evenodd" d="${dParts.join(' ')}" />`,
        );
      }
    }

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${origWidth} ${origHeight}" width="${origWidth}" height="${origHeight}">`,
      ...paths,
      '</svg>',
    ].join('\n');
  }

  private recomputeDerivedState(notify: boolean): void {
    const s = this.workingImage.effectiveScaleFactor;
    let derived = this.workingGrains.map((g) => rescaleGrainToOriginal(g, s));
    if (this.calibration !== undefined) {
      derived = ScaleCalibrator.scaleAllMorphometrics(
        derived,
        this.calibration,
      );
    }
    this.grains = derived;
    this.stats = computeSedimentStats(this.grains, {
      excludeBorder: this.excludeBorder,
    });
    if (notify) {
      for (const listener of this.listeners) {
        listener(this);
      }
    }
  }
}

/**
 * End-to-end ImageGrains 2.0 Web orchestrator managing capability probing,
 * model session lifecycle, preprocessing, ONNX inference, post-processing,
 * and reactive `AnalysisSession` creation.
 */
export class ImageGrainsEngine {
  private readonly options: ImageGrainsEngineOptions;
  private capabilities: EngineCapabilities | null = null;
  private readonly sessionCache = new Map<
    ModelKind,
    ort.InferenceSession | InferenceSessionLike
  >();
  private readonly ownedSessions = new Set<
    ort.InferenceSession | InferenceSessionLike
  >();
  private workerInstance: Worker | null = null;
  private requestSeq = 0;
  private disposed = false;
  private readonly pendingWorkerRejects = new Set<(err: Error) => void>();
  private readonly inFlightSessions = new Map<
    ModelKind,
    Promise<ort.InferenceSession | InferenceSessionLike>
  >();
  private readonly progressListeners = new Set<
    (stage: string, detail?: unknown) => void
  >();

  constructor(options: ImageGrainsEngineOptions = {}) {
    this.options = options;
  }

  onProgress(listener: (stage: string, detail?: unknown) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  subscribe(listener: (stage: string, detail?: unknown) => void): () => void {
    return this.onProgress(listener);
  }

  async initialize(): Promise<EngineCapabilities> {
    const nav = globalThis.navigator as
      | { gpu?: unknown; deviceMemory?: number }
      | undefined;

    const hasWebGPU = Boolean(nav?.gpu);
    const hasWasmSimd = probeWasmSimd();
    const deviceMemoryGB =
      typeof nav?.deviceMemory === 'number' && Number.isFinite(nav.deviceMemory)
        ? nav.deviceMemory
        : null;

    const cachedModels = await getCachedModels().catch(() => []);

    this.capabilities = {
      hasWebGPU,
      hasWasmSimd,
      deviceMemoryGB,
      cachedModels,
    };

    return this.capabilities;
  }

  async analyzeImage(
    image: ImageBitmap | ImageData | ImageBufferLike,
    config?: AnalysisConfig,
  ): Promise<AnalysisSession> {
    const signal = config?.signal;
    throwIfAborted(signal);

    if (this.capabilities === null) {
      await this.initialize();
      throwIfAborted(signal);
    }

    const emit = (stage: string, detail?: unknown): void => {
      config?.onProgress?.(stage, detail);
      for (const listener of this.progressListeners) {
        listener(stage, detail);
      }
    };

    const rawImg = extractImageBuffer(image);
    emit('preprocess', { width: rawImg.width, height: rawImg.height });

    const preImg: ImageBufferLike = config?.applyClahe
      ? applyCLAHE(rawImg, config.claheClipLimit)
      : rawImg;

    const recommendation = await recommendModel(
      preImg.data,
      preImg.width,
      preImg.height,
      {
        hasWebGPU: this.capabilities?.hasWebGPU ?? false,
        deviceMemoryGB: this.capabilities?.deviceMemoryGB ?? null,
      },
    );
    throwIfAborted(signal);

    const selectedModel: ModelKind =
      config?.model && config.model !== 'auto'
        ? config.model
        : recommendation.model;

    const workingImage = prepareWorkingImage(
      preImg.data,
      preImg.width,
      preImg.height,
      config?.scaleMode ?? 'auto',
    );
    throwIfAborted(signal);

    emit('inference', {
      model: selectedModel,
      width: workingImage.width,
      height: workingImage.height,
      scaleFactor: workingImage.effectiveScaleFactor,
    });

    const session = await this.acquireSession(selectedModel, signal);
    throwIfAborted(signal);

    let inferenceOut: InferenceOutput;
    if (selectedModel === 'unet') {
      const gray = normalizeGray(
        workingImage.data,
        workingImage.width,
        workingImage.height,
      );
      inferenceOut = await runUnetInference(
        session as ort.InferenceSession,
        gray,
        workingImage.width,
        workingImage.height,
      );
    } else {
      const rgb = normalizeRgbJoint99(
        workingImage.data,
        workingImage.width,
        workingImage.height,
      );
      inferenceOut = await runCpsamTiledInference(
        session as ort.InferenceSession,
        rgb,
        workingImage.width,
        workingImage.height,
        {
          signal,
          onProgress: (progress) => emit('inference', progress),
        },
      );
    }
    throwIfAborted(signal);

    emit('postprocess', {
      width: inferenceOut.width,
      height: inferenceOut.height,
    });

    const ppResult = await this.runPostprocess(
      inferenceOut,
      config?.postProcess,
      signal,
      (stage, percent) => emit('postprocess', { stage, percent }),
    );
    throwIfAborted(signal);

    emit('stats', { grainCount: ppResult.grainCount });

    const analysisSession = new AnalysisSession({
      workingImage,
      recommendation,
      masks: ppResult.masks,
      workingGrains: ppResult.grains,
      calibration: config?.calibration,
      excludeBorder: config?.excludeBorder ?? true,
      borderMargin: config?.postProcess?.excludeBorderMargin ?? 2,
    });

    emit('done', {
      grainCount: analysisSession.getResult().grainCount,
      stats: analysisSession.getStats(),
    });

    return analysisSession;
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    for (const rejectPending of Array.from(this.pendingWorkerRejects)) {
      rejectPending(
        new Error('ImageGrainsEngine was disposed while post-processing was in flight.'),
      );
    }
    this.pendingWorkerRejects.clear();

    for (const session of this.ownedSessions) {
      if (typeof session.release === 'function') {
        await session.release().catch(() => undefined);
      }
    }
    this.ownedSessions.clear();
    this.sessionCache.clear();
    this.inFlightSessions.clear();

    if (this.workerInstance !== null) {
      this.workerInstance.terminate();
      this.workerInstance = null;
    }

    this.progressListeners.clear();
    this.capabilities = null;
  }

  private async acquireSession(
    modelKind: ModelKind,
    signal?: AbortSignal,
  ): Promise<ort.InferenceSession | InferenceSessionLike> {
    if (this.disposed) {
      throw new Error('ImageGrainsEngine has been disposed.');
    }

    const cached = this.sessionCache.get(modelKind);
    if (cached !== undefined) {
      return cached;
    }

    const existingInFlight = this.inFlightSessions.get(modelKind);
    if (existingInFlight !== undefined) {
      const session = await existingInFlight;
      if (this.disposed) {
        throw new Error('ImageGrainsEngine has been disposed.');
      }
      throwIfAborted(signal);
      return session;
    }

    const createPromise = (async () => {
      let session: ort.InferenceSession | InferenceSessionLike;
      let isOwned = false;

      if (this.options.sessionFactory !== undefined) {
        session = await this.options.sessionFactory(modelKind);
      } else {
        const modelId = MODEL_ID_BY_KIND[modelKind];
        const dlOpts: ModelDownloadOptions = {
          ...this.options.modelDownloadOptions,
          signal: signal ?? this.options.modelDownloadOptions?.signal,
        };
        const modelBytes = await getModel(modelId, dlOpts);
        throwIfAborted(signal);

        const created = await createInferenceSession(
          modelBytes,
          this.options.sessionCreateOptions,
        );
        session = created.session;
        isOwned = true;
      }

      if (this.disposed) {
        if (typeof session.release === 'function') {
          await session.release().catch(() => undefined);
        }
        throw new Error('ImageGrainsEngine has been disposed.');
      }

      if (isOwned) {
        this.ownedSessions.add(session);
      }
      this.sessionCache.set(modelKind, session);
      return session;
    })();

    this.inFlightSessions.set(modelKind, createPromise);
    try {
      return await createPromise;
    } finally {
      this.inFlightSessions.delete(modelKind);
    }
  }

  private shouldUseWorker(): boolean {
    if (this.options.workerFactory !== undefined) {
      return true;
    }
    return this.options.useWorker === true && typeof Worker !== 'undefined';
  }

  private getOrCreateWorker(): Worker {
    if (this.workerInstance !== null) {
      return this.workerInstance;
    }
    if (this.options.workerFactory !== undefined) {
      this.workerInstance = this.options.workerFactory();
      return this.workerInstance;
    }
    this.workerInstance = new Worker(
      new URL('../workers/grainPostprocess.worker.js', import.meta.url),
      { type: 'module' },
    );
    return this.workerInstance;
  }

  private async runPostprocess(
    inferenceOut: InferenceOutput,
    options?: PostProcessOptions,
    signal?: AbortSignal,
    onProgress?: (stage: string, percent: number) => void,
  ): Promise<PostProcessResult> {
    if (this.disposed) {
      throw new Error('ImageGrainsEngine has been disposed.');
    }

    if (!this.shouldUseWorker()) {
      return flowsToMasksBrowser(
        inferenceOut.flowY,
        inferenceOut.flowX,
        inferenceOut.cellprob,
        inferenceOut.width,
        inferenceOut.height,
        options,
        onProgress,
      );
    }

    const worker = this.getOrCreateWorker();
    const requestId = `pp_${++this.requestSeq}_${Date.now()}`;

    return new Promise<PostProcessResult>((resolve, reject) => {
      let settled = false;

      const rejectRequest = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const cleanup = (): void => {
        this.pendingWorkerRejects.delete(rejectRequest);
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
        signal?.removeEventListener('abort', handleAbort);
      };

      const handleAbort = (): void => {
        rejectRequest(createAbortError());
      };

      const handleError = (ev: Event | ErrorEvent): void => {
        if (this.workerInstance === worker) {
          try {
            worker.terminate();
          } catch {
            // ignore
          }
          this.workerInstance = null;
        }
        const message =
          'message' in ev && typeof ev.message === 'string' && ev.message.length > 0
            ? ev.message
            : 'Post-process worker error';
        rejectRequest(new Error(message));
      };

      const handleMessage = (ev: MessageEvent<WorkerResponse>): void => {
        if (settled) return;
        const data = ev.data;
        if (!data || data.requestId !== requestId) {
          return;
        }
        if (data.type === 'progress') {
          onProgress?.(data.stage, data.percent);
          return;
        }
        if (data.type === 'result') {
          settled = true;
          cleanup();
          resolve(data.result);
          return;
        }
        if (data.type === 'error') {
          rejectRequest(new Error(data.message));
        }
      };

      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }

      if (this.disposed) {
        reject(new Error('ImageGrainsEngine has been disposed.'));
        return;
      }

      this.pendingWorkerRejects.add(rejectRequest);
      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);
      signal?.addEventListener('abort', handleAbort, { once: true });

      const req: WorkerRequest = {
        type: 'postprocess',
        requestId,
        flowY: inferenceOut.flowY,
        flowX: inferenceOut.flowX,
        cellprob: inferenceOut.cellprob,
        width: inferenceOut.width,
        height: inferenceOut.height,
        options,
      };

      worker.postMessage(req, [
        inferenceOut.flowY.buffer,
        inferenceOut.flowX.buffer,
        inferenceOut.cellprob.buffer,
      ]);
    });
  }
}
