/**
 * The analysis engine: hardware probing, model download and session lifecycle (WebGPU /
 * WASM, weight-file choice, GPU fallbacks), preprocessing, Cellpose inference with ROI
 * tile skipping, post-processing (optionally in a worker), and creation of an
 * `AnalysisSession` with full provenance.
 */
import type * as ort from 'onnxruntime-web';
import type {
  AnalysisConfig,
  EngineCapabilities,
  InferenceOutput,
  ModelDownloadOptions,
  ModelId,
  ModelKind,
  PostProcessOptions,
  PostProcessResult,
  WorkerRequest,
  WorkerResponse,
} from '../types/index.js';
import { buildRegionNeedTest, ROI_TILE_MARGIN_PX } from './roiTileSkip.js';
import {
  getCachedModels,
  getLastCacheWriteError,
  getModel,
  modelKindOf,
  resolveModelId,
  WEBGPU_UNVERIFIED_MODELS,
} from './modelCache.js';
import {
  applyCLAHE,
  normalizeGray,
  normalizeRgbJoint99,
  prepareWorkingImage,
  upscaleWorkingImage,
  isMobileDevice,
  recommendModel,
  type ImageBufferLike,
} from './imagePreprocess.js';
import {
  createInferenceSession,
  isWebGpuDeviceLostError,
  NumericInstabilityError,
  probeWebGpuCapabilities,
  runCpsamCellposeInference,
  runCpsamTiledInference,
  runUnetCellposeInference,
  runUnetInference,
  type SessionCreateOptions,
} from './onnxInference.js';
import { DEFAULT_POSTPROCESS_OPTIONS, flowsToMasksBrowser } from './postprocessCore.js';
import { createAnalysisAbortError } from './abort.js';
import { buildAnalysisProvenance } from './provenance.js';
import { AnalysisSession } from './analysisSession.js';

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
    modelId: ModelId,
  ) => Promise<ort.InferenceSession | InferenceSessionLike>;
  workerFactory?: () => Worker;
  useWorker?: boolean;
  modelDownloadOptions?: ModelDownloadOptions;
  sessionCreateOptions?: SessionCreateOptions;
}



function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAnalysisAbortError();
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

function stripUndefined<T extends object>(obj: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (obj === undefined) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
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
    ModelId,
    ort.InferenceSession | InferenceSessionLike
  >();
  private readonly ownedSessions = new Set<
    ort.InferenceSession | InferenceSessionLike
  >();
  private workerInstance: Worker | null = null;
  private requestSeq = 0;
  private disposed = false;
  private readonly pendingWorkerRejects = new Set<(err: Error) => void>();
  private readonly sessionExecutionProviders = new Map<ModelId, string>();
  /** Models forced onto WASM after the GPU produced numerically invalid output. */
  private readonly wasmOnlyModels = new Set<ModelId>();
  /** Set after a WebGPU device loss; GPU inference stays off until the page reloads. */
  private webgpuDisabledReason: string | null = null;
  private readonly inFlightSessions = new Map<
    ModelId,
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

    // navigator.gpu may exist without a usable adapter (headless, blocklisted GPU) or shader-f16.
    // After a device loss WebGPU stays off for this page, whatever the adapter reports.
    const { hasAdapter: hasWebGPU, hasShaderF16 } =
      this.webgpuDisabledReason !== null
        ? { hasAdapter: false, hasShaderF16: false }
        : await probeWebGpuCapabilities();
    const hasWasmSimd = probeWasmSimd();
    const deviceMemoryGB =
      typeof nav?.deviceMemory === 'number' && Number.isFinite(nav.deviceMemory)
        ? nav.deviceMemory
        : null;

    const cachedModels = await getCachedModels().catch(() => []);

    this.capabilities = {
      hasWebGPU,
      ...(hasShaderF16 !== undefined ? { hasShaderF16 } : {}),
      isMobile: isMobileDevice(),
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
        ...(this.capabilities?.hasShaderF16 !== undefined
          ? { hasShaderF16: this.capabilities.hasShaderF16 }
          : {}),
        deviceMemoryGB: this.capabilities?.deviceMemoryGB ?? null,
        isMobile: this.capabilities?.isMobile ?? false,
      },
    );
    throwIfAborted(signal);

    const selectedModel: ModelKind =
      config?.model && config.model !== 'auto'
        ? config.model
        : recommendation.model;

    // Weight file: Cellpose-SAM has FP16 / INT8 / FP4 variants (same accuracy).
    // On phones/tablets the 617 MB FP16 weights do not fit: Auto uses INT8 (1.4 GB).
    const fp16GpuUsable =
      this.capabilities?.isMobile !== true &&
      this.capabilities?.hasWebGPU === true &&
      this.capabilities?.hasShaderF16 === true &&
      this.webgpuDisabledReason === null &&
      !this.wasmOnlyModels.has('ig2_cpsam_fp16');
    const modelId = resolveModelId(selectedModel, config?.cpsamWeights ?? 'auto', fp16GpuUsable);

    if (selectedModel === 'cpsam' && this.capabilities?.isMobile === true) {
      emit('warning', {
        code: 'cpsam-mobile',
        model: selectedModel,
        message:
          'Cellpose-SAM on a phone or tablet needs about 1.5 GB of memory and can take 10+ minutes per photo; the browser may close the tab. U-Net is recommended on mobile.',
      });
    }

    const fineGrainUpscale = config?.fineGrainUpscale !== undefined && config.fineGrainUpscale > 1 ? config.fineGrainUpscale : undefined;
    const prepared = prepareWorkingImage(preImg.data, preImg.width, preImg.height, config?.scaleMode ?? 'auto');
    // Optional enlargement for fine gravel (audit/preprocessing); results are converted back
    // to original-photo pixels through effectiveScaleFactor, so sizes are unaffected.
    const workingImage = fineGrainUpscale !== undefined ? upscaleWorkingImage(prepared, fineGrainUpscale) : prepared;
    throwIfAborted(signal);

    emit('inference', {
      model: selectedModel,
      modelId,
      width: workingImage.width,
      height: workingImage.height,
      scaleFactor: workingImage.effectiveScaleFactor,
    });

    const pipeline = config?.inferencePipeline ?? 'cellpose';
    // Skip tiles that cannot affect grains in the ROI (Cellpose pipeline only).
    const needRegion =
      pipeline === 'cellpose' && config?.inferenceRoi !== undefined
        ? buildRegionNeedTest(
            workingImage.width,
            workingImage.height,
            workingImage.effectiveScaleFactor,
            config.inferenceRoi,
          )
        : null;
    const skipOpts = needRegion ? { needRegion, needRegionMarginPx: ROI_TILE_MARGIN_PX } : {};
    const runInference = async (
      session: ort.InferenceSession | InferenceSessionLike,
    ): Promise<InferenceOutput> => {
      const onTileProgress = (progress: unknown): void => emit('inference', progress);
      if (pipeline === 'cellpose') {
        // Upstream-exact Cellpose tiling (reproduces PyTorch ImageGrains; audit/parity/).
        return selectedModel === 'unet'
          ? runUnetCellposeInference(
              session as ort.InferenceSession,
              workingImage.data,
              workingImage.width,
              workingImage.height,
              { ...(signal ? { signal } : {}), onProgress: onTileProgress, ...skipOpts },
            )
          : runCpsamCellposeInference(
              session as ort.InferenceSession,
              workingImage.data,
              workingImage.width,
              workingImage.height,
              { ...(signal ? { signal } : {}), onProgress: onTileProgress, ...skipOpts },
            );
      }
      if (selectedModel === 'unet') {
        const gray = normalizeGray(
          workingImage.data,
          workingImage.width,
          workingImage.height,
        );
        return runUnetInference(
          session as ort.InferenceSession,
          gray,
          workingImage.width,
          workingImage.height,
        );
      }
      const rgb = normalizeRgbJoint99(
        workingImage.data,
        workingImage.width,
        workingImage.height,
      );
      return runCpsamTiledInference(
        session as ort.InferenceSession,
        rgb,
        workingImage.width,
        workingImage.height,
        {
          signal,
          onProgress: onTileProgress,
          // One tile per run on CPU: a 16-tile ViT-L batch exhausts the 4 GB WASM heap.
          ...(this.sessionExecutionProviders.get(modelId) === 'webgpu' ? {} : { batchSize: 1 }),
        },
      );
    };

    let session = await this.acquireSession(modelId, signal, emit);
    throwIfAborted(signal);

    let inferenceOut: InferenceOutput;
    try {
      inferenceOut = await runInference(session);
    } catch (err) {
      if (
        err instanceof NumericInstabilityError &&
        this.sessionExecutionProviders.get(modelId) === 'webgpu' &&
        !this.wasmOnlyModels.has(modelId)
      ) {
        // Float16 GPU arithmetic produced invalid values: run this model on the CPU
        // (WASM) for the rest of the page and redo the image once.
        this.wasmOnlyModels.add(modelId);
        await this.evictSession(modelId);
        emit('warning', {
          code: 'webgpu-numeric-instability',
          model: selectedModel,
          message:
            `The GPU produced invalid results for ${selectedModel === 'cpsam' ? 'Cellpose-SAM' : 'U-Net'} ` +
            '(float16 precision). This model now runs on the CPU for this page (slower). ' +
            'Please report your GPU and browser so this can be investigated.',
        });
        throwIfAborted(signal);
        session = await this.acquireSession(modelId, signal, emit);
        throwIfAborted(signal);
        inferenceOut = await runInference(session);
      } else if (!isWebGpuDeviceLostError(err) || this.webgpuDisabledReason !== null) {
        throw err;
      } else {
        // The page's GPUDevice is gone for good: disable WebGPU for this page, drop every
        // GPU-backed session, and retry this image once on the WASM (CPU) backend.
        await this.disableWebGpu(err instanceof Error ? err.message : String(err));
        emit('warning', {
          code: 'webgpu-device-lost',
          model: selectedModel,
          message:
            'The GPU was reset during analysis. GPU acceleration is now off for this page ' +
            'and analysis continues on the CPU (slower). Reload the page to use the GPU again.',
        });
        throwIfAborted(signal);
        session = await this.acquireSession(modelId, signal, emit);
        throwIfAborted(signal);
        inferenceOut = await runInference(session);
      }
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
      borderMargin:
        config?.postProcess?.excludeBorderMargin ??
        DEFAULT_POSTPROCESS_OPTIONS.excludeBorderMargin,
      provenance: buildAnalysisProvenance({
        modelId,
        ...(this.sessionExecutionProviders.has(modelId)
          ? { executionProvider: this.sessionExecutionProviders.get(modelId)! }
          : {}),
        inferencePipeline: pipeline,
        ...(inferenceOut.tiling !== undefined ? { tileSkipping: inferenceOut.tiling } : {}),
        scaleMode: config?.scaleMode ?? 'auto',
        ...(fineGrainUpscale !== undefined ? { fineGrainUpscale } : {}),
        effectiveScaleFactor: workingImage.effectiveScaleFactor,
        applyClahe: config?.applyClahe ?? false,
        ...(config?.applyClahe ? { claheClipLimit: config.claheClipLimit ?? 2 } : {}),
        postProcess: { ...DEFAULT_POSTPROCESS_OPTIONS, ...stripUndefined(config?.postProcess) },
      }),
    });

    emit('done', {
      grainCount: analysisSession.getResult().grainCount,
      stats: analysisSession.getStats(),
    });

    return analysisSession;
  }

  /** Why WebGPU was turned off for this page (device loss), or `null` if it is available. */
  getWebGpuDisabledReason(): string | null {
    return this.webgpuDisabledReason;
  }

  /**
   * Turns WebGPU off for the rest of this page after a device loss: releases every
   * GPU-backed session so the next `acquireSession` creates WASM sessions, and marks
   * the capability as unavailable so the model router stops choosing GPU models.
   */
  /** Drops a model's cached session (releasing it if the engine owns it). */
  private async evictSession(kind: ModelId): Promise<void> {
    const sess = this.sessionCache.get(kind);
    this.sessionCache.delete(kind);
    this.sessionExecutionProviders.delete(kind);
    if (sess && this.ownedSessions.has(sess)) {
      this.ownedSessions.delete(sess);
      if (typeof sess.release === 'function') await sess.release().catch(() => undefined);
    }
  }

  private async disableWebGpu(reason: string): Promise<void> {
    this.webgpuDisabledReason = reason;
    // Evict every session not known to be WASM-backed (custom factories don't report an EP).
    for (const kind of Array.from(this.sessionCache.keys())) {
      if (this.sessionExecutionProviders.get(kind) === 'wasm') continue;
      const lost = this.sessionCache.get(kind);
      this.sessionCache.delete(kind);
      this.sessionExecutionProviders.delete(kind);
      if (lost && this.ownedSessions.has(lost)) {
        this.ownedSessions.delete(lost);
        if (typeof lost.release === 'function') {
          await lost.release().catch(() => undefined);
        }
      }
    }
    if (this.capabilities !== null) {
      this.capabilities = { ...this.capabilities, hasWebGPU: false, hasShaderF16: false };
    }
  }

  /**
   * Releases all loaded ONNX segmentation sessions to free GPU/WASM memory without
   * permanently disposing the engine. Called before loading optional enhancement models
   * so segmentation and enhancement models are never loaded simultaneously.
   */
  async releaseSessions(): Promise<void> {
    for (const session of this.ownedSessions) {
      if (typeof session.release === 'function') {
        await session.release().catch(() => undefined);
      }
    }
    this.ownedSessions.clear();
    this.sessionCache.clear();
    this.inFlightSessions.clear();
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    for (const rejectPending of Array.from(this.pendingWorkerRejects)) {
      rejectPending(
        new Error('ImageGrainsEngine was disposed while post-processing was in flight.'),
      );
    }
    this.pendingWorkerRejects.clear();

    await this.releaseSessions();

    if (this.workerInstance !== null) {
      this.workerInstance.terminate();
      this.workerInstance = null;
    }

    this.progressListeners.clear();
    this.capabilities = null;
  }

  private async acquireSession(
    modelId: ModelId,
    signal?: AbortSignal,
    emit?: (stage: string, detail?: unknown) => void,
  ): Promise<ort.InferenceSession | InferenceSessionLike> {
    if (this.disposed) {
      throw new Error('ImageGrainsEngine has been disposed.');
    }

    const modelKind = modelKindOf(modelId);
    const cached = this.sessionCache.get(modelId);
    if (cached !== undefined) {
      return cached;
    }

    const existingInFlight = this.inFlightSessions.get(modelId);
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
        session = await this.options.sessionFactory(modelKind, modelId);
      } else {
        const userOnProgress = this.options.modelDownloadOptions?.onProgress;
        const dlOpts: ModelDownloadOptions = {
          ...this.options.modelDownloadOptions,
          signal: signal ?? this.options.modelDownloadOptions?.signal,
          // Report first-time model downloads to the analysis progress UI.
          onProgress: (p) => {
            userOnProgress?.(p);
            emit?.('download', { modelId, ...p });
          },
        };
        emit?.('model-load', { modelId, phase: 'fetch' });
        const cacheErrBefore = getLastCacheWriteError();
        const modelBytes = await getModel(modelId, dlOpts);
        throwIfAborted(signal);
        const cacheErr = getLastCacheWriteError();
        if (cacheErr !== null && cacheErr !== cacheErrBefore) {
          emit?.('warning', {
            code: 'model-cache-failed',
            model: modelKind,
            modelId,
            message:
              `The model could not be saved for offline use (${cacheErr}). Analysis continues, ` +
              'but the model will be downloaded again next time. Check free disk space, or leave private browsing.',
          });
        }
        emit?.('model-load', { modelId, phase: 'create-session', sizeBytes: modelBytes.byteLength });

        const created = await createInferenceSession(modelBytes, {
          ...this.options.sessionCreateOptions,
          ...(this.webgpuDisabledReason !== null ||
          this.wasmOnlyModels.has(modelId) ||
          WEBGPU_UNVERIFIED_MODELS.has(modelId)
            ? { forceWasm: true }
            : {}),
          requireShaderF16:
            this.options.sessionCreateOptions?.requireShaderF16 ??
            modelKind === 'cpsam',
        });
        session = created.session;
        this.sessionExecutionProviders.set(modelId, created.executionProvider);
        isOwned = true;

        if (modelKind === 'cpsam' && created.executionProvider === 'wasm') {
          emit?.('warning', {
            code: 'cpsam-wasm-fallback',
            model: modelKind,
            modelId,
            executionProvider: 'wasm',
            message: WEBGPU_UNVERIFIED_MODELS.has(modelId)
              ? `Cellpose-SAM (${modelId}) runs on the CPU (WASM): these quantized weights are not yet verified on WebGPU. Expect slow inference (roughly 15 s per 256 px tile); choose FP16 weights to use a float16 GPU.`
              : `Cellpose-SAM (${modelId}) is running on the CPU (WASM) because WebGPU with shader-f16 is unavailable; expect slow inference (roughly 15 s per 256 px tile with INT8 weights).`,
          });
        }
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
      this.sessionCache.set(modelId, session);
      return session;
    })();

    this.inFlightSessions.set(modelId, createPromise);
    try {
      return await createPromise;
    } finally {
      this.inFlightSessions.delete(modelId);
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
        rejectRequest(createAnalysisAbortError());
        // The worker cannot be interrupted mid-job: stop it so a cancelled post-process does
        // not keep using a CPU core (and delay the next analysis). A new worker is created on
        // demand; any other request still waiting on this worker is rejected.
        if (this.workerInstance === worker) {
          try {
            worker.terminate();
          } catch {
            // ignore
          }
          this.workerInstance = null;
          for (const rejectOther of Array.from(this.pendingWorkerRejects)) {
            rejectOther(new Error('Post-process worker was restarted after a cancelled analysis.'));
          }
        }
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
        reject(createAnalysisAbortError());
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
