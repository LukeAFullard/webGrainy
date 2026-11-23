/**
 * Optional "Tidy outlines": cleans the label mask the way GIS sieve / eliminate tools and
 * Cellpose's fill_holes do, so every grain is one solid piece. Only run when the user chooses it
 * (it changes measured sizes slightly); the analysis itself never calls it.
 *
 * 1. Detached fragments. Post-processing gives each pixel to the grain whose flow sink it ends in,
 *    so a few pixels can carry a grain's label without touching it. Each grain's 4-connected parts
 *    are found (pixels that meet only at a corner are separate parts, as in the outlines); the
 *    largest part stays the grain. Every other part:
 *      - with at least `minSize` pixels becomes a grain of its own;
 *      - else joins the neighbouring grain it shares the longest edge with (like GDAL's sieve
 *        filter / ArcGIS Eliminate), or becomes background if it touches no other grain.
 * 2. Holes. Background regions enclosed by a single grain (not touching the image edge or another
 *    grain) are filled, as Cellpose does for every mask; gaps between two grains are left.
 */

export interface TidyResult {
  /** Fragments that joined a neighbouring grain / became background / became their own grain. */
  fragmentsMerged: number;
  fragmentsRemoved: number;
  fragmentsSplitOff: number;
  /** Enclosed holes filled, and their pixels. */
  holesFilled: number;
  holePixels: number;
  /** Pixels whose label changed. */
  changedPixels: number;
  /** Bounding box of the changed pixels [minX, minY, maxX, maxY], or null when nothing changed. */
  bbox: [number, number, number, number] | null;
  /** Ids of the grains that changed (including new ones). */
  affectedIds: Set<number>;
  /** Ids given to fragments that became grains of their own. */
  newIds: number[];
}

/**
 * Tidies `masks` (grain ids, 0 = background, `width` x `height`) in place. `minSize` is the
 * smallest grain area in pixels (the post-processing Min size of the same mask).
 */
export function tidyLabelMask(masks: Int32Array, width: number, height: number, options: { minSize: number }): TidyResult {
  const n = width * height;
  if (masks.length !== n) throw new Error('Label mask size does not match.');
  const minSize = Math.max(1, Math.round(options.minSize));
  const before = masks.slice();

  // 4-connected parts of every grain: part id per pixel, pixels listed part by part in `order`.
  const part = new Int32Array(n).fill(-1);
  const order = new Int32Array(n);
  const partLabel: number[] = [];
  const partStart: number[] = [];
  const partSize: number[] = [];
  let filled = 0;
  for (let s = 0; s < n; s++) {
    const lbl = masks[s]!;
    if (lbl <= 0 || part[s] !== -1) continue;
    const id = partLabel.length;
    partLabel.push(lbl);
    partStart.push(filled);
    let head = filled;
    order[filled++] = s;
    part[s] = id;
    while (head < filled) {
      const p = order[head++]!;
      const x = p % width;
      const nb = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width];
      for (const q of nb) {
        if (q < 0 || q >= n || part[q] !== -1 || masks[q] !== lbl) continue;
        part[q] = id;
        order[filled++] = q;
      }
    }
    partSize.push(filled - partStart[id]!);
  }

  // The largest part of each grain stays the grain (ties: the first found, i.e. topmost).
  const mainPart = new Map<number, number>();
  for (let id = 0; id < partLabel.length; id++) {
    const cur = mainPart.get(partLabel[id]!);
    if (cur === undefined || partSize[id]! > partSize[cur]!) mainPart.set(partLabel[id]!, id);
  }

  let maxId = 0;
  for (let i = 0; i < n; i++) if (masks[i]! > maxId) maxId = masks[i]!;
  const result: TidyResult = {
    fragmentsMerged: 0, fragmentsRemoved: 0, fragmentsSplitOff: 0, holesFilled: 0, holePixels: 0,
    changedPixels: 0, bbox: null, affectedIds: new Set(), newIds: [],
  };

  // Decide every fragment from the original mask, then apply.
  const target = new Map<number, number>();
  for (let id = 0; id < partLabel.length; id++) {
    const lbl = partLabel[id]!;
    if (mainPart.get(lbl) === id) continue;
    result.affectedIds.add(lbl);
    if (partSize[id]! >= minSize) {
      const nid = ++maxId;
      target.set(id, nid);
      result.newIds.push(nid);
      result.affectedIds.add(nid);
      result.fragmentsSplitOff++;
      continue;
    }
    // Shared edge length with each neighbouring grain.
    const edges = new Map<number, number>();
    for (let k = partStart[id]!; k < partStart[id]! + partSize[id]!; k++) {
      const p = order[k]!;
      const x = p % width;
      const nb = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width];
      for (const q of nb) {
        if (q < 0 || q >= n) continue;
        const o = before[q]!;
        if (o > 0 && o !== lbl) edges.set(o, (edges.get(o) ?? 0) + 1);
      }
    }
    let best = 0;
    let bestLen = 0;
    for (const [o, len] of edges) if (len > bestLen || (len === bestLen && o < best)) { best = o; bestLen = len; }
    target.set(id, best);
    if (best > 0) {
      result.fragmentsMerged++;
      result.affectedIds.add(best);
    } else {
      result.fragmentsRemoved++;
    }
  }
  for (const [id, to] of target) {
    for (let k = partStart[id]!; k < partStart[id]! + partSize[id]!; k++) masks[order[k]!] = to;
  }

  // Enclosed holes: 4-connected background regions bordered by one grain only, off the image edge.
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (masks[s] !== 0 || seen[s]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    let edge = false;
    let owner = 0;
    let mixed = false;
    while (head < tail) {
      const p = queue[head++]!;
      const x = p % width;
      const y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
      const nb = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
      for (const q of nb) {
        if (q < 0) continue;
        const o = masks[q]!;
        if (o === 0) {
          if (!seen[q]) {
            seen[q] = 1;
            queue[tail++] = q;
          }
        } else if (owner === 0) owner = o;
        else if (o !== owner) mixed = true;
      }
    }
    if (!edge && !mixed && owner > 0) {
      for (let k = 0; k < tail; k++) masks[queue[k]!] = owner;
      result.holesFilled++;
      result.holePixels += tail;
      result.affectedIds.add(owner);
    }
  }

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < n; i++) {
    if (masks[i] === before[i]) continue;
    result.changedPixels++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (result.changedPixels > 0) result.bbox = [minX, minY, maxX, maxY];
  return result;
}
