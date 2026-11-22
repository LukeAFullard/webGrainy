/**
 * Canvas-based image steps of the app: TIFF to PNG on import, the blur score, enhancement and
 * rectification round trips (decode, process the pixels with the engine modules, encode PNG),
 * and report thumbnails. The pixel work itself is in src/modules; this file only moves images
 * between Blobs and pixel buffers.
 */
import { decodeTiffBuffer } from '../modules/tiffDecode.js';
import { computeBlurScoreFromRgba } from '../modules/photoQuality.js';
import { enhanceImageBuffer, type EnhanceKind, type EnhanceProgressEvent } from '../modules/imageEnhance.js';
import { rectificationCalibration } from '../modules/roiAndRectify.js';
import type { SessionCreateOptions } from '../modules/onnxInference.js';
import type { CalibrationResult, Point2D } from '../types/index.js';

export async function decodeTiffFileToPng(file: File) {
  const buf = await file.arrayBuffer();
  const decoded = decodeTiffBuffer(buf);
  const canvas = document.createElement('canvas');
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create 2D canvas context for TIFF decoding.');
  const imgData = new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height);
  ctx.putImageData(imgData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to encode decoded TIFF as PNG.'))), 'image/png');
  });
  const blurScore = await computeBlurScoreFromBlob(blob);
  const metadata =
    decoded.metadata || blurScore !== undefined
      ? { ...(decoded.metadata ?? {}), ...(blurScore !== undefined ? { blurScore } : {}) }
      : undefined;
  return {
    blob,
    width: decoded.width,
    height: decoded.height,
    ...(metadata ? { metadata } : {}),
    ...(decoded.calibration ? { calibration: decoded.calibration } : {}),
  };
}

/** Fast 256 px thumbnail Laplacian-variance sharpness check (0 MB, instant). */
export async function computeBlurScoreFromBlob(blob: Blob): Promise<number | undefined> {
  try {
    const bmp = await createImageBitmap(blob);
    const maxSide = 256;
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(3, Math.round(bmp.width * k));
    c.height = Math.max(3, Math.round(bmp.height * k));
    const ctx = c.getContext('2d');
    if (!ctx) {
      bmp.close();
      return undefined;
    }
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    return computeBlurScoreFromRgba(img.data, img.width, img.height);
  } catch {
    return undefined;
  }
}

/** Decodes a photo blob, runs memory-isolated ONNX enhancement, and encodes back to PNG. */
export async function enhanceWithCanvas(
  blob: Blob,
  kind: EnhanceKind,
  sessionOptions: SessionCreateOptions,
  onProgress?: (ev: EnhanceProgressEvent) => void,
) {
  const bmp = await createImageBitmap(blob);
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = bmp.width;
  srcCanvas.height = bmp.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) {
    bmp.close();
    throw new Error('Could not create 2D canvas context.');
  }
  srcCtx.drawImage(bmp, 0, 0);
  bmp.close();
  const srcImg = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

  const enhanced = await enhanceImageBuffer(srcImg.data, srcImg.width, srcImg.height, kind, {
    sessionOptions,
    ...(onProgress ? { onProgress } : {}),
  });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = enhanced.width;
  outCanvas.height = enhanced.height;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('Could not create output canvas context.');
  const outImgData = new ImageData(
    new Uint8ClampedArray(enhanced.data),
    enhanced.width,
    enhanced.height,
  );
  outCtx.putImageData(outImgData, 0, 0);

  const outBlob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to encode enhanced image.'))), 'image/png');
  });
  const blurScore = await computeBlurScoreFromBlob(outBlob);

  return {
    blob: outBlob,
    width: enhanced.width,
    height: enhanced.height,
    ...(blurScore !== undefined ? { blurScore } : {}),
    enhancement: {
      kind: enhanced.spec.kind,
      modelId: enhanced.spec.modelId,
      modelName: enhanced.spec.modelName,
      modelSha256: enhanced.spec.sha256,
      scaleFactor: enhanced.spec.scaleFactor,
      appliedAt: new Date().toISOString(),
    },
  };
}

/** A small JPEG of a photo for the printable report. */
export async function photoThumbDataUrl(blob: Blob, maxSide: number): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return c.toDataURL('image/jpeg', 0.82);
  } catch {
    return undefined;
  }
}

export async function rectifyWithCanvas(
  image: Blob,
  corners: [Point2D, Point2D, Point2D, Point2D],
  physWidthMm: number,
  physHeightMm: number,
  rectifyPerspective: typeof import('../modules/roiAndRectify.js').rectifyPerspective,
): Promise<{ blob: Blob; width: number; height: number; calibration: CalibrationResult } | null> {
  const bmp = await createImageBitmap(image);
  const off = document.createElement('canvas');
  off.width = bmp.width;
  off.height = bmp.height;
  const ctx = off.getContext('2d');
  if (!ctx) {
    bmp.close();
    return null;
  }
  ctx.drawImage(bmp, 0, 0);
  const imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();

  const rectified = rectifyPerspective(
    { data: imgData.data, width: imgData.width, height: imgData.height },
    {
      srcCorners: corners,
      physicalWidthMm: physWidthMm,
      physicalHeightMm: physHeightMm,
      paddingPx: 40,
      maxOutputDimPx: 2048,
    },
  );

  const outCanvas = document.createElement('canvas');
  outCanvas.width = rectified.width;
  outCanvas.height = rectified.height;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) return null;
  outCtx.putImageData(new ImageData(new Uint8ClampedArray(rectified.data), rectified.width, rectified.height), 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode rectified PNG'))),
      'image/png',
    );
  });

  const calibration = rectificationCalibration(rectified, physWidthMm);
  return { blob, width: rectified.width, height: rectified.height, calibration };
}

/** RGBA pixels of a stored photo at its own size (for reprojected photo exports). */
export async function decodePhotoRgba(blob: Blob): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { data, width: bmp.width, height: bmp.height };
  } catch {
    return null;
  }
}
