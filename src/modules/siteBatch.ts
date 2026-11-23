/**
 * Analysing the pending photos of a site one after another (decode within the pixel limit,
 * run the engine, save each result), with cancellation and storage-full handling.
 */
import type { AnalysisConfig } from '../types/index.js';
import type { ImageBufferLike } from './imagePreprocess.js';
import type { AnalysisSession, ImageGrainsEngine } from './pipelineController.js';
import { getPhotoResult, getSite, listSitePhotos, savePhotoResult, type PhotoRecord, type ProjectStorageOptions } from './projectDb.js';

export interface BatchRunOptions extends ProjectStorageOptions {
  siteId: string;
  engine: ImageGrainsEngine;
  photoIds?: readonly string[];
  analysisConfig?: Omit<AnalysisConfig, 'signal' | 'onProgress' | 'calibration'>;
  signal?: AbortSignal;
  decodeImage?: (
    blob: Blob,
    photo: PhotoRecord,
  ) => Promise<ImageBitmap | ImageData | ImageBufferLike>;
  onProgress?: (progress: {
    completed: number;
    total: number;
    currentPhotoId: string;
    currentLabel: string;
  }) => void;
  onPhotoStart?: (photo: PhotoRecord) => void;
  onPhotoComplete?: (photo: PhotoRecord, session: AnalysisSession) => void;
  onPhotoError?: (photo: PhotoRecord, error: Error) => void;
}

export interface BatchRunResult {
  siteId: string;
  total: number;
  completed: number;
  failed: number;
  aborted: boolean;
  completedPhotoIds: string[];
  failedPhotoIds: string[];
}

/**
 * A cancellation, not a failure: only an AbortError counts. Engine errors whose message merely
 * contains "abort" (e.g. onnxruntime-web's Emscripten "Aborted(...)" on out of memory) are
 * real failures and must be recorded as such.
 */
function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Sequentially processes pending photos in a site using a single `ImageGrainsEngine`
 * instance, releasing decoded `ImageBitmap` buffers in `finally` blocks after each photo.
 */
/**
 * Largest image (pixels) decoded for analysis. iOS Safari refuses canvases over 16.7 MP
 * (recent iPhones take 24-48 MP photos) and full-size decodes of large photos cost hundreds
 * of MB. Larger photos are decoded smaller; the engine reports results in the photo's own
 * pixels (`originalSize`). With Auto image scale the network input is unchanged (at most
 * 1024 px either way).
 */
export const MAX_DECODE_PIXELS = 16_777_216;

/** Decodes `blob`, shrinking it (aspect kept) when it exceeds MAX_DECODE_PIXELS. */
export async function decodeWithinPixelLimit(
  blob: Blob,
  createBitmap: (b: Blob, opts?: ImageBitmapOptions) => Promise<ImageBitmap>,
  maxPixels = MAX_DECODE_PIXELS,
): Promise<ImageBitmap> {
  const bmp = await createBitmap(blob);
  const px = bmp.width * bmp.height;
  if (px <= maxPixels) return bmp;
  const k = Math.sqrt(maxPixels / px);
  const resizeWidth = Math.max(1, Math.floor(bmp.width * k));
  const resizeHeight = Math.max(1, Math.floor(bmp.height * k));
  bmp.close();
  return createBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high' });
}

/**
 * The engine error as recorded for the photo. onnxruntime-web reports running out of memory
 * as an Emscripten abort ("Aborted(...)", or a bad_alloc / allocation failure); say so in words.
 */
export function describeEngineError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (/^(RuntimeError: )?Aborted\(|bad_alloc|out of memory|allocation failed/i.test(e.message)) {
    return new Error(
      `Out of memory during analysis (${e.message}). Try U-Net, a smaller image scale, or the INT8 Cellpose-SAM weights.`,
    );
  }
  return e;
}

/** The browser refused to store more data (quota exceeded / disk full). */
export function isStorageFullError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; message?: unknown };
  return e.name === 'QuotaExceededError' || /quota|storage is full|disk is full|no space/i.test(String(e.message ?? ''));
}

/** A batch stopped because browser storage is full (the finished analysis stays in the page). */
export class StorageFullError extends Error {
  constructor(readonly photoLabel: string) {
    super(
      `Browser storage is full: ${photoLabel} was analysed but could not be saved, so the batch stopped. Its results are still shown: download them now (Download results…), then free space (Free space…, or a shorter storage period) and analyse the remaining photos.`,
    );
    this.name = 'StorageFullError';
  }
}

export async function runSiteBatch(
  opts: BatchRunOptions,
): Promise<BatchRunResult> {
  const site = await getSite(opts.siteId, opts);
  if (!site) {
    throw new Error(`Site "${opts.siteId}" not found.`);
  }

  const allPhotos = await listSitePhotos(opts.siteId, opts);

  const orderedPhotos = inPhotoOrder(allPhotos, site.photoOrder);

  const targetIds = opts.photoIds ? new Set(opts.photoIds) : null;
  const queue: PhotoRecord[] = [];
  for (const p of orderedPhotos) {
    if (targetIds !== null) {
      if (targetIds.has(p.photoId)) queue.push(p);
      continue;
    }
    const existing = await getPhotoResult(p.photoId, opts);
    // 'running' at the start of a batch is stale: the page that was analysing it closed or
    // crashed (e.g. out of memory) before finishing, so analyse it again.
    if (!existing || existing.status === 'pending' || existing.status === 'error' || existing.status === 'running') {
      queue.push(p);
    }
  }

  const decode =
    opts.decodeImage ??
    (async (blob: Blob): Promise<ImageBitmap> => {
      if (typeof globalThis.createImageBitmap !== 'function') {
        throw new Error(
          'createImageBitmap is not available in this environment; provide decodeImage option.',
        );
      }
      return decodeWithinPixelLimit(blob, globalThis.createImageBitmap.bind(globalThis));
    });

  const completedPhotoIds: string[] = [];
  const failedPhotoIds: string[] = [];
  let aborted = false;

  for (let i = 0; i < queue.length; i++) {
    const photo = queue[i];
    if (photo === undefined) continue;

    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }

    opts.onPhotoStart?.(photo);
    opts.onProgress?.({
      completed: completedPhotoIds.length,
      total: queue.length,
      currentPhotoId: photo.photoId,
      currentLabel: photo.label,
    });

    await savePhotoResult(
      {
        photoId: photo.photoId,
        status: 'running',
        updatedAt: Date.now(),
      },
      opts,
    );

    let decoded: ImageBitmap | ImageData | ImageBufferLike | null = null;
    try {
      decoded = await decode(photo.imageBlob, photo);
      if (opts.signal?.aborted) {
        aborted = true;
        await savePhotoResult(
          {
            photoId: photo.photoId,
            status: 'pending',
            updatedAt: Date.now(),
          },
          opts,
        );
        break;
      }

      const mergedConfig: AnalysisConfig = {
        ...opts.analysisConfig,
        ...photo.analysisConfig,
        // Results in the photo's own pixels even if it was decoded smaller.
        originalSize: { width: photo.width, height: photo.height },
        // Skip inference tiles outside this photo's ROI / exclusions (default on).
        ...(opts.analysisConfig?.skipTilesOutsideRoi !== false && photo.roiConfig !== undefined
          ? { inferenceRoi: photo.roiConfig }
          : {}),
        ...(photo.calibration !== undefined
          ? { calibration: photo.calibration }
          : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      };

      const session = await opts.engine.analyzeImage(decoded, mergedConfig);
      try {
        await savePhotoResult(
          {
            photoId: photo.photoId,
            status: 'done',
            serializedSession: session.toSerialized(),
            updatedAt: Date.now(),
          },
          opts,
        );
      } catch (saveErr) {
        if (!isStorageFullError(saveErr)) throw saveErr;
        // Browser storage is full: keep the finished analysis in the page (it can still be
        // viewed and downloaded) and stop; further photos could not be saved either.
        opts.onPhotoComplete?.(photo, session);
        throw new StorageFullError(photo.label);
      }

      completedPhotoIds.push(photo.photoId);
      opts.onPhotoComplete?.(photo, session);
    } catch (err) {
      if (err instanceof StorageFullError) throw err;
      if (err instanceof Error && err.name === 'BuildMismatchError') {
        // A newer version took over in another tab: nothing is wrong with the photo. Leave it
        // pending and stop; the message tells the user to reload.
        await savePhotoResult({ photoId: photo.photoId, status: 'pending', updatedAt: Date.now() }, opts);
        throw err;
      }
      if (opts.signal?.aborted || isAbortError(err)) {
        aborted = true;
        await savePhotoResult(
          {
            photoId: photo.photoId,
            status: 'pending',
            updatedAt: Date.now(),
          },
          opts,
        );
        break;
      }
      const errorObj = describeEngineError(err);
      failedPhotoIds.push(photo.photoId);
      await savePhotoResult(
        {
          photoId: photo.photoId,
          status: 'error',
          errorMessage: errorObj.message,
          updatedAt: Date.now(),
        },
        opts,
      );
      opts.onPhotoError?.(photo, errorObj);
    } finally {
      if (
        decoded !== null &&
        typeof decoded === 'object' &&
        'close' in decoded &&
        typeof decoded.close === 'function'
      ) {
        decoded.close();
      }
    }
  }

  return {
    siteId: opts.siteId,
    total: queue.length,
    completed: completedPhotoIds.length,
    failed: failedPhotoIds.length,
    aborted,
    completedPhotoIds,
    failedPhotoIds,
  };
}

/** Photos in the site's `photoOrder`, then any not listed there (in their stored order). */
export function inPhotoOrder<P extends { photoId: string }>(photos: readonly P[], photoOrder: readonly string[]): P[] {
  const byId = new Map(photos.map((p) => [p.photoId, p]));
  const out: P[] = [];
  const seen = new Set<string>();
  for (const id of photoOrder) {
    const p = byId.get(id);
    if (p && !seen.has(id)) {
      out.push(p);
      seen.add(id);
    }
  }
  for (const p of photos) if (!seen.has(p.photoId)) out.push(p);
  return out;
}
