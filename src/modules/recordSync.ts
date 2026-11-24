/**
 * Keeping photo and site records consistent when the app is open in several tabs.
 *
 * The UI saves whole records from its in-memory copy. Without care, a tab holding an older
 * copy silently reverts what another tab saved (e.g. ticking "include" on a photo in tab B
 * would remove the scale just calibrated in tab A). Two parts:
 *
 * 1. Three-way merge on save: the fields this tab changed since it last read the record are
 *    applied to the record as it is now in storage; every other field keeps the stored value.
 * 2. Change notices between tabs (BroadcastChannel), so the other tabs refresh their copy.
 *
 * Analysis results (label masks) cannot be merged field by field; for them the notice lets
 * the other tabs reload the photo before the user edits it there.
 */
import type { PhotoRecord, SiteRecord } from './projectStorage.js';

/** Structural equality for stored records (Blobs compare by identity). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (typeof Blob !== 'undefined' && (a instanceof Blob || b instanceof Blob)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/**
 * Fields of `mine` that differ from `base` (what this tab changed, including removals) applied
 * to `theirs` (the record as stored now). Without a base or a stored record, `mine` as is.
 */
export function threeWayMerge<T extends object>(base: T | undefined, mine: T, theirs: T | undefined): T {
  if (base === undefined || theirs === undefined) return mine;
  const out: Record<string, unknown> = { ...(theirs as Record<string, unknown>) };
  const b = base as Record<string, unknown>;
  const m = mine as Record<string, unknown>;
  for (const k of new Set([...Object.keys(b), ...Object.keys(m)])) {
    if (sameValue(m[k], b[k])) continue; // unchanged here: keep the stored value
    if (m[k] === undefined) delete out[k];
    else out[k] = m[k];
  }
  return out as T;
}

/**
 * Real IndexedDB returns a fresh structured clone of every Blob on each read, so a Blob that
 * nobody changed never has the identity this tab last saw. Where the stored record (`theirs`)
 * holds a Blob of the same size and type as the one in `base` (what this tab last read or
 * wrote), treat it as that same Blob and use `base`'s instance, so an unchanged image does
 * not look like a change made by another tab.
 */
export function adoptKnownBlobs<T extends object>(base: T | undefined, theirs: T | undefined): T | undefined {
  if (base === undefined || theirs === undefined || typeof Blob === 'undefined') return theirs;
  const b = base as Record<string, unknown>;
  const t = theirs as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(t)) {
    const tv = t[k];
    const bv = b[k];
    if (tv !== bv && tv instanceof Blob && bv instanceof Blob && tv.size === bv.size && tv.type === bv.type) {
      out ??= { ...t };
      out[k] = bv;
    }
  }
  return (out ?? theirs) as T;
}

/** A change notice between tabs. */
export interface RecordChangeNotice {
  type: 'webgrainy-records-changed';
  /** Sender tab (notices from this tab are ignored). */
  from: string;
  siteIds: string[];
  /** Photos whose record or analysis result changed (or that were deleted). */
  photoIds: string[];
}

export interface NoticeChannel {
  post(msg: RecordChangeNotice): void;
  onMessage(cb: (msg: RecordChangeNotice) => void): void;
}

/** BroadcastChannel transport, or null where it is not available. */
export function broadcastNoticeChannel(name = 'webgrainy-records'): NoticeChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const ch = new BroadcastChannel(name);
  return {
    post: (msg) => ch.postMessage(msg),
    onMessage: (cb) =>
      ch.addEventListener('message', (e: MessageEvent) => {
        const d = e.data as RecordChangeNotice | null;
        if (d && d.type === 'webgrainy-records-changed') cb(d);
      }),
  };
}

interface BaseStorage {
  listSites(): Promise<SiteRecord[]>;
  getSite(siteId: string): Promise<SiteRecord | undefined>;
  saveSite(site: SiteRecord): Promise<void>;
  listSitePhotos(siteId: string): Promise<PhotoRecord[]>;
  getPhoto(photoId: string): Promise<PhotoRecord | undefined>;
  savePhoto(photo: PhotoRecord): Promise<void>;
  deletePhoto(photoId: string): Promise<void>;
}

export interface SyncedStorageHooks {
  /**
   * A save was merged with changes from another tab: replace this tab's copy with `merged`.
   * `saved` is the record this tab asked to save; if this tab's copy has changed again since
   * (a later edit whose save is still pending), keep those later changes (see `threeWayMerge`).
   */
  onMerged?(kind: 'photo' | 'site', merged: PhotoRecord | SiteRecord, saved: PhotoRecord | SiteRecord): void;
}

/**
 * Wraps the record functions of project storage: remembers each record as last read or
 * written by this tab, merges saves with the stored record, and posts change notices.
 */
export function createSyncedRecords<S extends BaseStorage>(
  storage: S,
  opts: { tabId: string; channel: NoticeChannel | null; hooks?: SyncedStorageHooks },
) {
  const sites = new Map<string, SiteRecord>();
  const photos = new Map<string, PhotoRecord>();
  const notify = (siteIds: string[], photoIds: string[]): void => {
    opts.channel?.post({ type: 'webgrainy-records-changed', from: opts.tabId, siteIds, photoIds });
  };
  return {
    notify,
    async listSites(): Promise<SiteRecord[]> {
      const list = await storage.listSites();
      for (const s of list) sites.set(s.siteId, s);
      return list;
    },
    async listSitePhotos(siteId: string): Promise<PhotoRecord[]> {
      const list = await storage.listSitePhotos(siteId);
      for (const p of list) photos.set(p.photoId, p);
      return list;
    },
    async saveSite(site: SiteRecord): Promise<void> {
      const base = sites.get(site.siteId);
      const merged = threeWayMerge(base, site, adoptKnownBlobs(base, await storage.getSite(site.siteId)));
      await storage.saveSite(merged);
      sites.set(merged.siteId, merged);
      if (merged !== site && !sameValue(merged, site)) opts.hooks?.onMerged?.('site', merged, site);
      notify([merged.siteId], []);
    },
    async savePhoto(photo: PhotoRecord): Promise<void> {
      const base = photos.get(photo.photoId);
      const merged = threeWayMerge(base, photo, adoptKnownBlobs(base, await storage.getPhoto(photo.photoId)));
      await storage.savePhoto(merged);
      photos.set(merged.photoId, merged);
      if (merged !== photo && !sameValue(merged, photo)) opts.hooks?.onMerged?.('photo', merged, photo);
      notify([merged.siteId], [merged.photoId]);
    },
    async deletePhoto(photoId: string): Promise<void> {
      const siteId = photos.get(photoId)?.siteId;
      await storage.deletePhoto(photoId);
      photos.delete(photoId);
      notify(siteId ? [siteId] : [], [photoId]);
    },
  };
}
