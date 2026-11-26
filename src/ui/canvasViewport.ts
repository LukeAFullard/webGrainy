import { ellipseRotationDeg, majorAxisDirection } from '../modules/orientationGeometry.js';
import { grainPassesSizeCutoffs } from '../modules/sedimentStats.js';
import { firstHitAlongPolyline } from '../modules/interactiveEditor.js';
import { wentworthRgb } from '../modules/wentworthColors.js';
import type { GrainMorphometrics, Point2D, SizeMetric } from '../types/index.js';
import type { AnalysisSession } from '../modules/pipelineController.js';
import type { PhotoRecord } from '../modules/projectStorage.js';
import type { EditorToolMode, OverlaySettings } from './state.js';

export interface CanvasViewportCallbacks {
  onInspectGrain: (grainId: number | null) => void;
  onToggleSelectGrain: (grainId: number) => void;
  /** `grainId` is null when the line crosses no grain. */
  onSplitLine: (grainId: number | null, points: Point2D[]) => void;
  onDeleteGrain: (grainId: number) => void;
  onAddPolygon: (points: Point2D[]) => void;
  onAddExclusionPolygon: (points: Point2D[]) => void;
  /** Sets (replaces) the photo's region of interest. */
  onSetRoiPolygon: (points: Point2D[]) => void;
  onAddExclusionStroke: (points: Point2D[], radiusPx: number) => void;
  onCalibrationPoint: (pt: Point2D) => void;
  onRectifyPoint: (pt: Point2D) => void;
}

function hashColor(id: number): [number, number, number] {
  let x = (id * 2654435761) >>> 0;
  const r = 60 + (x & 0x7f);
  x = (x >>> 8) ^ (id * 2246822519);
  const g = 60 + (x & 0x7f);
  x = (x >>> 8) ^ (id * 3266489917);
  const b = 60 + (x & 0x7f);
  return [r, g, b];
}

function wentworthColor(grain: GrainMorphometrics, sizeMetric: SizeMetric = 'bAxis'): [number, number, number] {
  return wentworthRgb(grain, sizeMetric) ?? hashColor(grain.id);
}

export class CanvasViewport {
  private readonly stage: HTMLElement;
  private readonly baseCanvas: HTMLCanvasElement;
  private readonly maskCanvas: HTMLCanvasElement;
  private readonly svgOverlay: SVGSVGElement;
  private readonly loupeCanvas: HTMLCanvasElement;
  private readonly callbacks: CanvasViewportCallbacks;

  private maskOffscreen: HTMLCanvasElement;
  private imageBitmap: ImageBitmap | null = null;
  private photo: PhotoRecord | null = null;
  private session: AnalysisSession | null = null;
  private tool: EditorToolMode = 'inspect';
  private overlays: OverlaySettings = {
    instanceIds: true,
    wentworthColors: false,
    ellipses: false,
    orientations: false,
    borderTruncated: true,
    opacity: 0.45,
    loupe: false,
    loupeZoom: 2,
  };
  private selectedIds = new Set<number>();
  private inspectedId: number | null = null;
  private minBaxisPx = 15;
  private minSizeMm = 0;
  private sizeMetric: SizeMetric = 'bAxis';
  private calPoints: Point2D[] = [];
  private rectifyPoints: Point2D[] = [];

  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private isPanning = false;
  private spaceDown = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  /** Active touch points (pointerId -> client position) for touch gestures. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  /** One-finger touch: start point and whether it has moved enough to be a drag. */
  private touchStart: { x: number; y: number; dragging: boolean } | null = null;
  /** Two-finger pinch: starting distance, zoom and the image point under the midpoint. */
  private pinch: { dist: number; zoom: number; imgX: number; imgY: number } | null = null;
  /** The view at "fit" zoom; one-finger swipes scroll the page until the user zooms in. */
  private fitZoom = 1;

  private activePoints: Point2D[] = [];
  private isDrawingStroke = false;
  private splitTargetGrainId: number | null = null;
  private mouseImgPt: Point2D | null = null;
  private mouseStagePt: Point2D | null = null;
  private maskDirty = true;
  private rafId: number | null = null;

  constructor(
    stage: HTMLElement,
    baseCanvas: HTMLCanvasElement,
    maskCanvas: HTMLCanvasElement,
    svgOverlay: SVGSVGElement,
    loupeCanvas: HTMLCanvasElement,
    callbacks: CanvasViewportCallbacks,
  ) {
    this.stage = stage;
    this.baseCanvas = baseCanvas;
    this.maskCanvas = maskCanvas;
    this.svgOverlay = svgOverlay;
    this.loupeCanvas = loupeCanvas;
    this.callbacks = callbacks;
    this.maskOffscreen = document.createElement('canvas');

    this.bindEvents();
    this.bindRest();
  }

  private scheduleRender(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private zoomAtStagePoint(sx: number, sy: number, factor: number): void {
    if (!this.photo) return;
    const nextZoom = Math.max(0.1, Math.min(24, this.zoom * factor));
    const imgX = (sx - this.panX) / this.zoom;
    const imgY = (sy - this.panY) / this.zoom;
    this.zoom = nextZoom;
    this.panX = sx - imgX * this.zoom;
    this.panY = sy - imgY * this.zoom;
    this.scheduleRender();
  }

  private bindEvents(): void {
    this.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.photo) return;
      const rect = this.stage.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
      this.zoomAtStagePoint(sx, sy, factor);
    }, { passive: false });

    this.stage.addEventListener('pointerdown', (e) => {
      if (!this.photo) return;
      // The grain inspector card sits on top of the photo: its buttons are not photo taps.
      if (e.target instanceof Element && e.target.closest('.inspector-card')) return;
      if (e.pointerType === 'touch') {
        this.onTouchDown(e);
        return;
      }
      const rect = this.stage.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        this.isPanning = true;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
        this.stage.classList.add('panning');
        return;
      }
      if (e.button !== 0) return;
      this.applyToolAt(sx, sy);
    });

    this.stage.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') this.onTouchMove(e);
    });
    const endTouch = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') this.onTouchEnd(e, e.type === 'pointerup');
    };
    this.stage.addEventListener('pointerup', endTouch);
    this.stage.addEventListener('pointercancel', endTouch);

    this.bindMouseMoveAndUp();
  }

  /** Runs the active tool's click/tap action at a stage point. */
  private applyToolAt(sx: number, sy: number): void {
    {
      const pt = this.screenToImage(sx, sy);
      if (!pt) return;

      if (this.tool === 'inspect') {
        const id = this.hitTestGrain(pt.x, pt.y);
        this.callbacks.onInspectGrain(id);
      } else if (this.tool === 'merge') {
        const id = this.hitTestGrain(pt.x, pt.y);
        if (id !== null) this.callbacks.onToggleSelectGrain(id);
      } else if (this.tool === 'delete') {
        const id = this.hitTestGrain(pt.x, pt.y);
        if (id !== null) this.callbacks.onDeleteGrain(id);
      } else if (this.tool === 'calibrate') {
        this.callbacks.onCalibrationPoint(pt);
      } else if (this.tool === 'rectify') {
        this.callbacks.onRectifyPoint(pt);
      } else if (this.tool === 'split') {
        if (this.activePoints.length === 0) {
          this.splitTargetGrainId = this.hitTestGrain(pt.x, pt.y);
        }
        this.activePoints.push(pt);
        this.renderVectorOverlay();
      } else if (this.tool === 'addPolygon' || this.tool === 'excludePoly' || this.tool === 'roiPoly') {
        this.activePoints.push(pt);
        this.renderVectorOverlay();
      } else if (this.tool === 'excludeBrush') {
        this.isDrawingStroke = true;
        this.activePoints = [pt];
        this.renderVectorOverlay();
      }
    }
  }

  // ---- Touch gestures --------------------------------------------------------------
  // Two fingers: pinch to zoom and drag to pan. One finger: tap runs the active tool;
  // a drag pans the photo when zoomed in, otherwise scrolls the page (so a photo that
  // fills the phone screen never traps scrolling). The brush draws with one finger.

  private stagePoint(e: { clientX: number; clientY: number }): { sx: number; sy: number } {
    const rect = this.stage.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  }

  private startPinch(): void {
    const [a, b] = Array.from(this.touches.values());
    if (!a || !b) return;
    const rect = this.stage.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - rect.left;
    const my = (a.y + b.y) / 2 - rect.top;
    this.pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: this.zoom,
      imgX: (mx - this.panX) / this.zoom,
      imgY: (my - this.panY) / this.zoom,
    };
  }

  private onTouchDown(e: PointerEvent): void {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.stage.setPointerCapture?.(e.pointerId);
    if (this.touches.size === 2) {
      // A second finger turns any pending tap or stroke into a pinch.
      this.touchStart = null;
      if (this.isDrawingStroke) {
        this.isDrawingStroke = false;
        this.activePoints = [];
        this.renderVectorOverlay();
      }
      this.startPinch();
      return;
    }
    if (this.touches.size > 2) return;
    this.touchStart = { x: e.clientX, y: e.clientY, dragging: false };
    if (this.tool === 'excludeBrush') {
      const { sx, sy } = this.stagePoint(e);
      this.applyToolAt(sx, sy); // starts the stroke
    }
  }

  private onTouchMove(e: PointerEvent): void {
    const prev = this.touches.get(e.pointerId);
    if (!prev) return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.preventDefault();

    if (this.pinch && this.touches.size >= 2) {
      const [a, b] = Array.from(this.touches.values());
      if (!a || !b) return;
      const rect = this.stage.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - rect.left;
      const my = (a.y + b.y) / 2 - rect.top;
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      this.zoom = Math.max(0.05, Math.min(40, this.pinch.zoom * (dist / this.pinch.dist)));
      this.panX = mx - this.pinch.imgX * this.zoom;
      this.panY = my - this.pinch.imgY * this.zoom;
      this.scheduleRender();
      return;
    }

    const start = this.touchStart;
    if (!start) return;
    if (this.isDrawingStroke && this.tool === 'excludeBrush') {
      const { sx, sy } = this.stagePoint(e);
      const pt = this.screenToImage(sx, sy);
      if (pt) {
        this.activePoints.push(pt);
        this.renderVectorOverlay();
      }
      return;
    }
    if (!start.dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) return;
    start.dragging = true;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (this.zoom > this.fitZoom * 1.05) {
      this.panX += dx;
      this.panY += dy;
      this.scheduleRender();
    } else {
      window.scrollBy(0, -dy);
    }
  }

  private onTouchEnd(e: PointerEvent, completed: boolean): void {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    if (this.pinch) {
      if (this.touches.size < 2) this.pinch = null;
      // Lifting one of two fingers must not trigger a tap.
      this.touchStart = null;
      return;
    }
    const start = this.touchStart;
    this.touchStart = null;
    if (this.tool === 'excludeBrush' && this.isDrawingStroke) {
      this.isDrawingStroke = false;
      if (completed && this.activePoints.length >= 2) {
        this.callbacks.onAddExclusionStroke([...this.activePoints], 20);
      }
      this.activePoints = [];
      this.renderVectorOverlay();
      return;
    }
    if (completed && start && !start.dragging) {
      const { sx, sy } = this.stagePoint(e);
      this.applyToolAt(sx, sy);
    }
  }

  private bindMouseMoveAndUp(): void {
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (this.isPanning) {
        this.panX += e.clientX - this.lastPointerX;
        this.panY += e.clientY - this.lastPointerY;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
        this.scheduleRender();
        return;
      }

      const rect = this.stage.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        this.mouseStagePt = null;
        this.loupeCanvas.style.display = 'none';
        return;
      }

      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.mouseStagePt = { x: sx, y: sy };
      this.mouseImgPt = this.screenToImage(sx, sy);

      if (this.isDrawingStroke && this.tool === 'excludeBrush' && this.mouseImgPt) {
        this.activePoints.push(this.mouseImgPt);
        this.renderVectorOverlay();
      } else if (this.activePoints.length > 0) {
        this.renderVectorOverlay();
      }

      this.renderLoupe();
    });

    window.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      if (this.isPanning) {
        this.isPanning = false;
        this.stage.classList.remove('panning');
      }
      if (this.isDrawingStroke && this.tool === 'excludeBrush') {
        this.isDrawingStroke = false;
        if (this.activePoints.length >= 2) {
          this.callbacks.onAddExclusionStroke([...this.activePoints], 20);
        }
        this.activePoints = [];
        this.renderVectorOverlay();
      }
    });

  }

  private bindRest(): void {
    this.stage.addEventListener('dblclick', (e) => {
      if (e.target instanceof Element && e.target.closest('.inspector-card')) return;
      e.preventDefault();
      this.commitActiveShape();
    });

    // Keyboard panning & zoom when the canvas viewport itself is focused
    this.stage.addEventListener('keydown', (e) => {
      if (!this.photo) return;
      const step = e.shiftKey ? 120 : 40;
      const rect = this.stage.getBoundingClientRect();
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.panX += step;
        this.scheduleRender();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.panX -= step;
        this.scheduleRender();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.panY += step;
        this.scheduleRender();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.panY -= step;
        this.scheduleRender();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.zoomAtStagePoint(rect.width / 2, rect.height / 2, 1.2);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        this.zoomAtStagePoint(rect.width / 2, rect.height / 2, 1 / 1.2);
      } else if (e.key === '0') {
        e.preventDefault();
        this.fitToScreen();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isInteractiveFocused()) {
        if (e.target === this.stage) {
          e.preventDefault();
        }
        this.spaceDown = true;
        this.stage.classList.add('panning');
      } else if (e.key === 'Enter' && this.activePoints.length >= 2) {
        this.commitActiveShape();
      } else if (e.key === 'Escape') {
        this.activePoints = [];
        this.splitTargetGrainId = null;
        this.renderVectorOverlay();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        if (!this.isPanning) this.stage.classList.remove('panning');
      }
    });

    const ro = new ResizeObserver(() => this.scheduleRender());
    ro.observe(this.stage);
  }

  /** Completes the polygon / split line being drawn (touch-friendly Enter). */
  finishShape(): void {
    if (this.activePoints.length >= 2) this.commitActiveShape();
  }

  /** Discards the shape being drawn (touch-friendly Esc). */
  cancelShape(): void {
    this.activePoints = [];
    this.splitTargetGrainId = null;
    this.renderVectorOverlay();
  }

  private commitActiveShape(): void {
    if (this.tool === 'split' && this.activePoints.length >= 2) {
      // The usual cut starts and ends outside the grain: find the grain the line crosses.
      const step = this.session ? 1 / Math.max(1e-6, this.session.workingImage.effectiveScaleFactor) : 1;
      const gid = this.splitTargetGrainId ?? firstHitAlongPolyline(this.activePoints, (x, y) => this.hitTestGrain(x, y), step);
      this.callbacks.onSplitLine(gid, [...this.activePoints]);
    } else if (this.tool === 'addPolygon' && this.activePoints.length >= 3) {
      this.callbacks.onAddPolygon([...this.activePoints]);
    } else if (this.tool === 'excludePoly' && this.activePoints.length >= 3) {
      this.callbacks.onAddExclusionPolygon([...this.activePoints]);
    } else if (this.tool === 'roiPoly' && this.activePoints.length >= 3) {
      this.callbacks.onSetRoiPolygon([...this.activePoints]);
    }
    this.activePoints = [];
    this.splitTargetGrainId = null;
    this.renderVectorOverlay();
  }

  /** Increases with every photo change: a decode that finishes after a newer one started is dropped. */
  private photoLoadSeq = 0;

  async setPhotoAndSession(
    photo: PhotoRecord | null,
    session: AnalysisSession | null,
    _fitToView = false,
  ): Promise<void> {
    const photoChanged = this.photo?.photoId !== photo?.photoId || this.photo?.imageBlob !== photo?.imageBlob;
    this.photo = photo;
    this.session = session;
    // Sessions are edited in place (split, merge, tidy...), so the mask image is rebuilt on every
    // sync; selection and inspection changes use updateToolAndOverlays alone and skip this.
    this.maskDirty = true;

    if (photoChanged) {
      const seq = ++this.photoLoadSeq;
      if (this.imageBitmap) {
        this.imageBitmap.close();
        this.imageBitmap = null;
      }
      let bitmap: ImageBitmap | null = null;
      if (photo) {
        try {
          bitmap = await createImageBitmap(photo.imageBlob);
        } catch {
          bitmap = null;
        }
      }
      // Switched to another photo while this one decoded: never draw it, and free it.
      if (seq !== this.photoLoadSeq) {
        bitmap?.close();
        return;
      }
      this.imageBitmap = bitmap;
      this.fitToScreen();
    }
    this.render();
  }

  markMasksDirty(): void {
    this.maskDirty = true;
    this.render();
  }

  updateToolAndOverlays(opts: {
    tool: EditorToolMode;
    overlays: OverlaySettings;
    selectedIds: Set<number>;
    inspectedId: number | null;
    minBaxisPx: number;
    minSizeMm?: number;
    sizeMetric?: SizeMetric;
    calPoints: Point2D[];
    rectifyPoints: Point2D[];
  }): void {
    const nextMetric = opts.sizeMetric ?? 'bAxis';
    const colorsChanged =
      this.overlays.wentworthColors !== opts.overlays.wentworthColors ||
      this.overlays.instanceIds !== opts.overlays.instanceIds ||
      (opts.overlays.wentworthColors && this.sizeMetric !== nextMetric);
    if (this.tool !== opts.tool) {
      this.activePoints = [];
      this.splitTargetGrainId = null;
    }
    this.tool = opts.tool;
    this.overlays = { ...opts.overlays };
    this.selectedIds = opts.selectedIds;
    this.inspectedId = opts.inspectedId;
    this.minBaxisPx = opts.minBaxisPx;
    this.minSizeMm = opts.minSizeMm ?? 0;
    this.sizeMetric = opts.sizeMetric ?? 'bAxis';
    this.calPoints = opts.calPoints;
    this.rectifyPoints = opts.rectifyPoints;
    if (colorsChanged) this.maskDirty = true;
    this.render();
  }

  fitToScreen(): void {
    if (!this.photo) return;
    const rect = this.stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scaleX = (rect.width - 24) / this.photo.width;
    const scaleY = (rect.height - 24) / this.photo.height;
    this.zoom = Math.max(0.05, Math.min(4, Math.min(scaleX, scaleY)));
    this.fitZoom = this.zoom;
    this.panX = (rect.width - this.photo.width * this.zoom) / 2;
    this.panY = (rect.height - this.photo.height * this.zoom) / 2;
    this.render();
  }

  /** Pans to a grain, zooming in if it would be tiny on screen or out if it exceeds the viewport. */
  focusOnGrain(grainId: number): void {
    if (!this.photo || !this.session) return;
    const g = this.session.getResult().grains.find((x) => x.id === grainId);
    if (!g) return;
    // g.bbox is already in original-image coordinates (rescaled by AnalysisSession).
    const [x0, y0, x1, y1] = g.bbox;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const size = Math.max(x1 - x0, y1 - y0, 1);
    const rect = this.stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const minViewport = Math.min(rect.width, rect.height);
    if (size * this.zoom < 60) {
      this.zoom = Math.min(4, Math.max(this.zoom, 160 / size));
    } else if (size * this.zoom > minViewport * 0.9) {
      this.zoom = Math.max(this.fitZoom, (minViewport * 0.75) / size);
    }
    this.panX = rect.width / 2 - cx * this.zoom;
    this.panY = rect.height / 2 - cy * this.zoom;
    this.render();
  }

  getZoom(): number {
    return this.zoom;
  }

  getCursorImgPt(): Point2D | null {
    return this.mouseImgPt;
  }

  private screenToImage(sx: number, sy: number): Point2D | null {
    if (!this.photo) return null;
    const x = (sx - this.panX) / this.zoom;
    const y = (sy - this.panY) / this.zoom;
    return { x, y };
  }

  private hitTestGrain(origX: number, origY: number): number | null {
    if (!this.session) return null;
    const wi = this.session.workingImage;
    const s = wi.effectiveScaleFactor;
    // Image coordinates are continuous (pixel i spans [i, i + 1)): the pixel under a point is floor().
    const wx = Math.floor(origX * s);
    const wy = Math.floor(origY * s);
    if (wx < 0 || wy < 0 || wx >= wi.width || wy >= wi.height) return null;
    const id = this.session.getWorkingMasks()[wy * wi.width + wx] ?? 0;
    return id > 0 ? id : null;
  }

  private rebuildMaskOffscreen(): void {
    this.maskDirty = false;
    if (!this.session || (!this.overlays.instanceIds && !this.overlays.wentworthColors)) {
      this.maskOffscreen.width = 1;
      this.maskOffscreen.height = 1;
      return;
    }
    const wi = this.session.workingImage;
    const masks = this.session.getWorkingMasks();
    this.maskOffscreen.width = wi.width;
    this.maskOffscreen.height = wi.height;
    const ctx = this.maskOffscreen.getContext('2d');
    if (!ctx) return;

    const imgData = ctx.createImageData(wi.width, wi.height);
    const data = imgData.data;

    const grainMap = new Map<number, GrainMorphometrics>();
    for (const g of this.session.getResult().grains) {
      grainMap.set(g.id, g);
    }

    // Grains outside the ROI or inside an exclusion are still detected, but not counted:
    // draw them grey and hatched so they do not look like measured grains.
    const excluded = this.session.getRoiFilterResult()?.excludedGrainIds;
    const colorCache = new Map<number, [number, number, number]>();
    for (let i = 0; i < masks.length; i++) {
      const id = masks[i] ?? 0;
      if (id <= 0) continue;
      if (excluded?.has(id)) {
        const x = i % wi.width;
        const y = (i - x) / wi.width;
        const p = i * 4;
        data[p] = 140;
        data[p + 1] = 140;
        data[p + 2] = 140;
        data[p + 3] = ((x + y) >> 2) & 1 ? 150 : 25;
        continue;
      }
      let rgb = colorCache.get(id);
      if (!rgb) {
        if (this.overlays.wentworthColors) {
          const g = grainMap.get(id);
          rgb = g ? wentworthColor(g, this.sizeMetric) : hashColor(id);
        } else {
          rgb = hashColor(id);
        }
        colorCache.set(id, rgb);
      }
      const p = i * 4;
      data[p] = rgb[0];
      data[p + 1] = rgb[1];
      data[p + 2] = rgb[2];
      data[p + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  render(): void {
    const rect = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));

    for (const c of [this.baseCanvas, this.maskCanvas]) {
      if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
        c.width = Math.floor(w * dpr);
        c.height = Math.floor(h * dpr);
      }
    }

    const bctx = this.baseCanvas.getContext('2d');
    const mctx = this.maskCanvas.getContext('2d');
    if (!bctx || !mctx) return;

    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, w, h);

    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.clearRect(0, 0, w, h);

    if (this.photo && this.imageBitmap) {
      bctx.save();
      bctx.translate(this.panX, this.panY);
      bctx.scale(this.zoom, this.zoom);
      bctx.imageSmoothingEnabled = this.zoom < 3;
      bctx.drawImage(this.imageBitmap, 0, 0, this.photo.width, this.photo.height);
      bctx.restore();
    }

    if (this.session && this.photo && (this.overlays.instanceIds || this.overlays.wentworthColors)) {
      if (this.maskDirty) this.rebuildMaskOffscreen();
      mctx.save();
      mctx.globalAlpha = this.overlays.opacity;
      mctx.translate(this.panX, this.panY);
      mctx.scale(this.zoom, this.zoom);
      mctx.imageSmoothingEnabled = false;
      mctx.drawImage(this.maskOffscreen, 0, 0, this.photo.width, this.photo.height);
      mctx.restore();
    }

    this.renderVectorOverlay();
    this.renderLoupe();
  }

  private renderVectorOverlay(): void {
    const rect = this.stage.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.svgOverlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svgOverlay.innerHTML = this.overlayParts({ zoom: this.zoom, panX: this.panX, panY: this.panY, w, h, forExport: false }).join('');
  }

  /**
   * SVG elements of the vector overlay (ROI, exclusions, grain ellipses / orientations / flags,
   * calibration line, shapes being drawn) for a view: image point (x, y) is drawn at
   * (x * zoom + panX, y * zoom + panY) in a `w` x `h` view. `forExport` leaves out shapes still
   * being drawn (rubber band, unfinished calibration / rectify points).
   */
  private overlayParts(v: { zoom: number; panX: number; panY: number; w: number; h: number; forExport: boolean }): string[] {
    const { w, h } = v;
    const parts: string[] = [];
    const toSx = (x: number): number => x * v.zoom + v.panX;
    const toSy = (y: number): number => y * v.zoom + v.panY;

    // Region of interest (green: only grains inside count), then exclusion polygons & strokes
    if (this.photo?.roiConfig) {
      const roi = this.photo.roiConfig.roiPolygon;
      if (roi && roi.length >= 3) {
        const pts = roi.map((p) => `${toSx(p.x).toFixed(1)},${toSy(p.y).toFixed(1)}`).join(' ');
        parts.push(`<polygon points="${pts}" fill="none" stroke="#2ecc71" stroke-width="2" stroke-dasharray="6,3" />`);
      }
      for (const poly of this.photo.roiConfig.exclusionPolygons) {
        if (poly.length < 3) continue;
        const pts = poly.map((p) => `${toSx(p.x).toFixed(1)},${toSy(p.y).toFixed(1)}`).join(' ');
        parts.push(`<polygon points="${pts}" fill="rgba(231, 76, 60, 0.25)" stroke="#e74c3c" stroke-width="1.5" stroke-dasharray="4,2" />`);
      }
      for (const stroke of this.photo.roiConfig.exclusionStrokes) {
        if (stroke.points.length < 2) continue;
        const pts = stroke.points.map((p) => `${toSx(p.x).toFixed(1)},${toSy(p.y).toFixed(1)}`).join(' ');
        parts.push(`<polyline points="${pts}" fill="none" stroke="rgba(231, 76, 60, 0.55)" stroke-width="${(stroke.radiusPx * 2 * v.zoom).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" />`);
      }
    }

    // Grain vector overlays
    if (this.session) {
      const grains = this.session.getResult().grains;
      const excludedIds = this.session.getRoiFilterResult()?.excludedGrainIds;
      for (const g of grains) {
        // Centroids use pixel-centre coordinates; the photo is drawn with pixel corners at integers.
        const cx = toSx(g.centroidX + 0.5);
        const cy = toSy(g.centroidY + 0.5);
        if (cx < -100 || cy < -100 || cx > w + 100 || cy > h + 100) continue;

        const isSelected = this.selectedIds.has(g.id) || this.inspectedId === g.id;
        // Excluded grains (outside the ROI / inside an exclusion): no ellipse or orientation line.
        if (excludedIds?.has(g.id) && !isSelected) continue;
        const isTruncated = !grainPassesSizeCutoffs(g, {
          minBaxisPx: this.minBaxisPx,
          minSizeMm: this.minSizeMm,
          sizeMetric: this.sizeMetric,
        });

        if (this.overlays.ellipses || isSelected) {
          const rx = Math.max(1, (g.aAxisPx / 2) * v.zoom);
          const ry = Math.max(1, (g.bAxisPx / 2) * v.zoom);
          const deg = ellipseRotationDeg(g.orientationRad);
          const strokeCol = isSelected ? '#ffd166' : '#5ab0ff';
          parts.push(
            `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" transform="rotate(${deg.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})" fill="none" stroke="${strokeCol}" stroke-width="${isSelected ? 2.2 : 1}" />`,
          );
        }

        if (this.overlays.orientations) {
          const halfLen = (g.aAxisPx / 2) * v.zoom;
          const dir = majorAxisDirection(g.orientationRad);
          const dx = dir.dx * halfLen;
          const dy = dir.dy * halfLen;
          parts.push(
            `<line x1="${(cx - dx).toFixed(1)}" y1="${(cy - dy).toFixed(1)}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="#f5a623" stroke-width="1.3" />`,
          );
        }

        if (this.overlays.borderTruncated && (g.touchesBorder || isTruncated)) {
          const col = g.touchesBorder ? '#ff8577' : '#f5a623';
          parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.5" fill="${col}" />`);
        }
      }
    }

    // Calibration line
    if (this.calPoints.length > 0 && !v.forExport) {
      for (const pt of this.calPoints) {
        parts.push(`<circle cx="${toSx(pt.x).toFixed(1)}" cy="${toSy(pt.y).toFixed(1)}" r="4" fill="#2ecc71" stroke="#0c1014" stroke-width="1.5" />`);
      }
      if (this.calPoints.length === 2) {
        const a = this.calPoints[0]!;
        const b = this.calPoints[1]!;
        parts.push(`<line x1="${toSx(a.x).toFixed(1)}" y1="${toSy(a.y).toFixed(1)}" x2="${toSx(b.x).toFixed(1)}" y2="${toSy(b.y).toFixed(1)}" stroke="#2ecc71" stroke-width="2" />`);
      }
    } else if (this.photo?.calibration && this.photo.calibration.source !== 'entered') {
      // A typed-in scale has no reference line on the photo.
      const c = this.photo.calibration;
      parts.push(`<line x1="${toSx(c.pointA.x).toFixed(1)}" y1="${toSy(c.pointA.y).toFixed(1)}" x2="${toSx(c.pointB.x).toFixed(1)}" y2="${toSy(c.pointB.y).toFixed(1)}" stroke="#2ecc71" stroke-width="2" stroke-dasharray="5,3" />`);
    }

    // 4-point Rectify quad
    if (this.rectifyPoints.length > 0 && !v.forExport) {
      const pts = this.rectifyPoints.map((p) => `${toSx(p.x).toFixed(1)},${toSy(p.y).toFixed(1)}`).join(' ');
      parts.push(`<polyline points="${pts}" fill="none" stroke="#ffd166" stroke-width="2" />`);
      this.rectifyPoints.forEach((p, idx) => {
        const labels = ['TL', 'TR', 'BR', 'BL'];
        parts.push(`<circle cx="${toSx(p.x).toFixed(1)}" cy="${toSy(p.y).toFixed(1)}" r="5" fill="#ffd166" />`);
        parts.push(`<text x="${(toSx(p.x) + 7).toFixed(1)}" y="${(toSy(p.y) - 5).toFixed(1)}" fill="#ffd166" font-size="11" font-weight="700" font-family="ui-monospace, monospace">${labels[idx] ?? idx + 1}</text>`);
      });
    }

    // Active rubber-band shape
    if (this.activePoints.length > 0 && !v.forExport) {
      const allPts = this.mouseImgPt && this.tool !== 'excludeBrush'
        ? [...this.activePoints, this.mouseImgPt]
        : this.activePoints;
      const pts = allPts.map((p) => `${toSx(p.x).toFixed(1)},${toSy(p.y).toFixed(1)}`).join(' ');
      const col = this.tool === 'excludePoly' || this.tool === 'excludeBrush' ? '#e74c3c' : this.tool === 'roiPoly' ? '#2ecc71' : '#3b9eff';
      parts.push(`<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="4,2" />`);
    }

    return parts;
  }

  /**
   * The photo as it is drawn on screen (mask colours and opacity, ellipses, orientation lines,
   * flags, ROI / exclusions, calibration line) as a PNG at the photo's own resolution: the whole
   * photo, or only the part visible in the view. Very large outputs are scaled down to what the
   * browser can draw (`scale` < 1). Lines and markers are thickened with the output size so
   * they read as on screen. Null when no photo is shown or the browser cannot encode it.
   */
  async exportViewImage(area: 'photo' | 'visible'): Promise<{ blob: Blob; width: number; height: number; scale: number } | null> {
    if (!this.photo || !this.imageBitmap) return null;
    const pw = this.photo.width;
    const ph = this.photo.height;
    let x0 = 0, y0 = 0, x1 = pw, y1 = ph;
    if (area === 'visible') {
      const rect = this.stage.getBoundingClientRect();
      x0 = Math.max(0, Math.floor(-this.panX / this.zoom));
      y0 = Math.max(0, Math.floor(-this.panY / this.zoom));
      x1 = Math.min(pw, Math.ceil((rect.width - this.panX) / this.zoom));
      y1 = Math.min(ph, Math.ceil((rect.height - this.panY) / this.zoom));
      if (x1 <= x0 || y1 <= y0) return null;
    }
    const cw = x1 - x0;
    const ch = y1 - y0;
    // Browser canvas limits: 16384 px a side, and about 16.7 MP on Safari (try more elsewhere).
    for (const maxArea of [40e6, 16.7e6, 8e6]) {
      const scale = Math.min(1, 16384 / Math.max(cw, ch), Math.sqrt(maxArea / (cw * ch)));
      const ow = Math.max(1, Math.round(cw * scale));
      const oh = Math.max(1, Math.round(ch * scale));
      const blob = await this.drawViewImage(x0, y0, cw, ch, ow, oh);
      if (blob) return { blob, width: ow, height: oh, scale };
    }
    return null;
  }

  private async drawViewImage(x0: number, y0: number, cw: number, ch: number, ow: number, oh: number): Promise<Blob | null> {
    const canvas = document.createElement('canvas');
    canvas.width = ow;
    canvas.height = oh;
    const ctx = canvas.getContext('2d');
    if (!ctx || !this.photo || !this.imageBitmap) return null;
    const s = ow / cw;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const bx = this.imageBitmap.width / this.photo.width;
    const by = this.imageBitmap.height / this.photo.height;
    ctx.drawImage(this.imageBitmap, x0 * bx, y0 * by, cw * bx, ch * by, 0, 0, ow, oh);
    if (this.session && (this.overlays.instanceIds || this.overlays.wentworthColors)) {
      if (this.maskDirty) this.rebuildMaskOffscreen();
      const m = this.maskOffscreen;
      const fx = m.width / this.photo.width;
      const fy = m.height / this.photo.height;
      ctx.save();
      ctx.globalAlpha = this.overlays.opacity;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(m, x0 * fx, y0 * fy, cw * fx, ch * fy, 0, 0, ow, oh);
      ctx.restore();
    }
    // The vector overlay is built in a smaller virtual view and scaled up, so line widths and
    // markers grow with the output (about 1 px per 1000 px of its long side, at least 1).
    const k = Math.max(1, Math.max(ow, oh) / 1000);
    const vw = ow / k;
    const vh = oh / k;
    const z = s / k;
    const parts = this.overlayParts({ zoom: z, panX: -x0 * z, panY: -y0 * z, w: vw, h: vh, forExport: true });
    if (parts.length > 0) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ow}" height="${oh}" viewBox="0 0 ${vw} ${vh}">${parts.join('')}</svg>`;
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        ctx.drawImage(img, 0, 0, ow, oh);
      } catch {
        return null;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return new Promise((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), 'image/png');
      } catch {
        resolve(null);
      }
    });
  }

  private renderLoupe(): void {
    if (!this.overlays.loupe || !this.mouseStagePt || !this.photo) {
      this.loupeCanvas.style.display = 'none';
      return;
    }
    const size = 140;
    this.loupeCanvas.width = size;
    this.loupeCanvas.height = size;
    this.loupeCanvas.style.display = 'block';
    this.loupeCanvas.style.left = `${Math.round(this.mouseStagePt.x + 18)}px`;
    this.loupeCanvas.style.top = `${Math.round(this.mouseStagePt.y - size / 2)}px`;

    const lctx = this.loupeCanvas.getContext('2d');
    if (!lctx) return;
    const dpr = window.devicePixelRatio || 1;
    const zoom = this.overlays.loupeZoom;
    const srcW = (size / zoom) * dpr;
    const srcH = (size / zoom) * dpr;
    const srcX = this.mouseStagePt.x * dpr - srcW / 2;
    const srcY = this.mouseStagePt.y * dpr - srcH / 2;

    lctx.clearRect(0, 0, size, size);
    lctx.drawImage(this.baseCanvas, srcX, srcY, srcW, srcH, 0, 0, size, size);
    lctx.drawImage(this.maskCanvas, srcX, srcY, srcW, srcH, 0, 0, size, size);
    lctx.strokeStyle = '#3b9eff';
    lctx.lineWidth = 1.5;
    lctx.beginPath();
    lctx.moveTo(size / 2 - 8, size / 2);
    lctx.lineTo(size / 2 + 8, size / 2);
    lctx.moveTo(size / 2, size / 2 - 8);
    lctx.lineTo(size / 2, size / 2 + 8);
    lctx.stroke();
  }
}

function isInteractiveFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if (el.closest('dialog[open]')) return true;
  const tag = el.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    tag === 'button' ||
    tag === 'a' ||
    tag === 'summary' ||
    el.getAttribute('role') === 'tab'
  );
}
