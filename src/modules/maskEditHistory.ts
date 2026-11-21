import type { GrainMorphometrics } from '../types/index.js';

/** One undoable edit: the label-mask bounding box before and after, and the grain lists. */
export interface MaskEditEntry {
  bbox: [number, number, number, number];
  imageWidth: number;
  before: Int32Array;
  after: Int32Array;
  grainsBefore?: GrainMorphometrics[];
  grainsAfter?: GrainMorphometrics[];
  label?: string;
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
