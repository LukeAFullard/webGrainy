import type { GrainMorphometrics, Point2D } from '../types/index.js';
import type { AnalysisSession } from '../modules/pipelineController.js';
import type { PhotoRecord } from '../modules/projectStorage.js';
import type { EditorToolMode, OverlaySettings } from './state.js';

export interface CanvasViewportCallbacks {
  onInspectGrain: (grainId: number | null) => void;
  onToggleSelectGrain: (grainId: number) => void;
  onSplitLine: (grainId: number, points: Point2D[]) => void;
  onDeleteGrain: (grainId: number) => void;
  onAddPolygon: (points: Point2D[]) => void;
  onAddExclusionPolygon: (points: Point2D[]) => void;
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

function wentworthColor(grain: GrainMorphometrics): [number, number, number] {
  const mm = grain.bAxisMm;
  if (mm === undefined || mm <= 0) return hashColor(grain.id);
  if (mm < 2) return [245, 166, 35];      // Sand: amber
  if (mm < 16) return [59, 158, 255];     // Fine/Med Gravel: sky blue
  if (mm < 64) return [46, 204, 113];     // Coarse/V.Coarse Gravel: green
  if (mm < 256) return [155, 89, 182];    // Cobble: purple
  return [231, 76, 60];                   // Boulder: red
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
  private calPoints: Point2D[] = [];
  private rectifyPoints: Point2D[] = [];

  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private isPanning = false;
  private spaceDown = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

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
      } else if (this.tool === 'addPolygon' || this.tool === 'excludePoly') {
        this.activePoints.push(pt);
        this.renderVectorOverlay();
      } else if (this.tool === 'excludeBrush') {
        this.isDrawingStroke = true;
        this.activePoints = [pt];
        this.renderVectorOverlay();
      }
    });

    window.addEventListener('pointermove', (e) => {
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

    window.addEventListener('pointerup', () => {
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

    this.stage.addEventListener('dblclick', (e) => {
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

  private commitActiveShape(): void {
    if (this.tool === 'split' && this.activePoints.length >= 2) {
      let gid = this.splitTargetGrainId;
      if (gid === null) {
        for (const pt of this.activePoints) {
          gid = this.hitTestGrain(pt.x, pt.y);
          if (gid !== null) break;
        }
      }
      if (gid !== null) {
        this.callbacks.onSplitLine(gid, [...this.activePoints]);
      }
    } else if (this.tool === 'addPolygon' && this.activePoints.length >= 3) {
      this.callbacks.onAddPolygon([...this.activePoints]);
    } else if (this.tool === 'excludePoly' && this.activePoints.length >= 3) {
      this.callbacks.onAddExclusionPolygon([...this.activePoints]);
    }
    this.activePoints = [];
    this.splitTargetGrainId = null;
    this.renderVectorOverlay();
  }

  async setPhotoAndSession(
    photo: PhotoRecord | null,
    session: AnalysisSession | null,
    fitToView = false,
  ): Promise<void> {
    const photoChanged = this.photo?.photoId !== photo?.photoId || this.photo?.imageBlob !== photo?.imageBlob;
    this.photo = photo;
    this.session = session;
    this.maskDirty = true;

    if (photoChanged) {
      if (this.imageBitmap) {
        this.imageBitmap.close();
        this.imageBitmap = null;
      }
      if (photo) {
        try {
          this.imageBitmap = await createImageBitmap(photo.imageBlob);
        } catch {
          this.imageBitmap = null;
        }
      }
      if (fitToView || photoChanged) {
        this.fitToScreen();
      }
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
    calPoints: Point2D[];
    rectifyPoints: Point2D[];
  }): void {
    const colorsChanged =
      this.overlays.wentworthColors !== opts.overlays.wentworthColors ||
      this.overlays.instanceIds !== opts.overlays.instanceIds;
    if (this.tool !== opts.tool) {
      this.activePoints = [];
      this.splitTargetGrainId = null;
    }
    this.tool = opts.tool;
    this.overlays = { ...opts.overlays };
    this.selectedIds = opts.selectedIds;
    this.inspectedId = opts.inspectedId;
    this.minBaxisPx = opts.minBaxisPx;
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
    this.panX = (rect.width - this.photo.width * this.zoom) / 2;
    this.panY = (rect.height - this.photo.height * this.zoom) / 2;
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
    const wx = Math.round(origX * s);
    const wy = Math.round(origY * s);
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

    const colorCache = new Map<number, [number, number, number]>();
    for (let i = 0; i < masks.length; i++) {
      const id = masks[i] ?? 0;
      if (id <= 0) continue;
      let rgb = colorCache.get(id);
      if (!rgb) {
        if (this.overlays.wentworthColors) {
          const g = grainMap.get(id);
          rgb = g ? wentworthColor(g) : hashColor(id);
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

    const parts: string[] = [];
    const toSx = (x: number): number => x * this.zoom + this.panX;
    const toSy = (y: number): number => y * this.zoom + this.panY;

    // Exclusion polygons & strokes
    if (this.photo?.roiConfig) {
      for (const poly of this.photo.roiConfig.exclusionPolygons) {
        if (poly.length < 3) continue;
        const pts = poly.map((p) => `${toSx(p.x).toFixed(1)},${toSy(p.y).toFixed(1)}`).join(' ');
        parts.push(`<polygon points="${pts}" fill="rgba(231, 76, 60, 0.25)" stroke="#e74c3c" stroke-width="1.5" stroke-dasharray="4,2" />`);
      }
      for (const stroke of this.photo.roiConfig.exclusionStrokes) {
        if (stroke.points.length < 2) continue;
        const pts = stroke.points.map((p) => `${toSx(p.x).toFixed(1)},${toSy(p.y).toFixed(1)}`).join(' ');
        parts.push(`<polyline points="${pts}" fill="none" stroke="rgba(231, 76, 60, 0.55)" stroke-width="${(stroke.radiusPx * 2 * this.zoom).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" />`);
      }
    }

    // Grain vector overlays
    if (this.session) {
      const grains = this.session.getResult().grains;
      for (const g of grains) {
        const cx = toSx(g.centroidX);
        const cy = toSy(g.centroidY);
        if (cx < -100 || cy < -100 || cx > w + 100 || cy > h + 100) continue;

        const isSelected = this.selectedIds.has(g.id) || this.inspectedId === g.id;
        const isTruncated = this.minBaxisPx > 0 && g.bAxisPx < this.minBaxisPx;

        if (this.overlays.ellipses || isSelected) {
          const rx = Math.max(1, (g.aAxisPx / 2) * this.zoom);
          const ry = Math.max(1, (g.bAxisPx / 2) * this.zoom);
          const deg = (g.orientationRad * 180) / Math.PI + 90;
          const strokeCol = isSelected ? '#ffd166' : '#5ab0ff';
          parts.push(
            `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" transform="rotate(${deg.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})" fill="none" stroke="${strokeCol}" stroke-width="${isSelected ? 2.2 : 1}" />`,
          );
        }

        if (this.overlays.orientations) {
          const halfLen = (g.aAxisPx / 2) * this.zoom;
          const dx = Math.sin(g.orientationRad) * halfLen;
          const dy = Math.cos(g.orientationRad) * halfLen;
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
    if (this.calPoints.length > 0) {
      for (const pt of this.calPoints) {
        parts.push(`<circle cx="${toSx(pt.x).toFixed(1)}" cy="${toSy(pt.y).toFixed(1)}" r="4" fill="#2ecc71" stroke="#0c1014" stroke-width="1.5" />`);
      }
      if (this.calPoints.length === 2) {
        const a = this.calPoints[0]!;
        const b = this.calPoints[1]!;
        parts.push(`<line x1="${toSx(a.x).toFixed(1)}" y1="${toSy(a.y).toFixed(1)}" x2="${toSx(b.x).toFixed(1)}" y2="${toSy(b.y).toFixed(1)}" stroke="#2ecc71" stroke-width="2" />`);
      }
    } else if (this.photo?.calibration) {
      const c = this.photo.calibration;
      parts.push(`<line x1="${toSx(c.pointA.x).toFixed(1)}" y1="${toSy(c.pointA.y).toFixed(1)}" x2="${toSx(c.pointB.x).toFixed(1)}" y2="${toSy(c.pointB.y).toFixed(1)}" stroke="#2ecc71" stroke-width="2" stroke-dasharray="5,3" />`);
    }

    // 4-point Rectify quad
    if (this.rectifyPoints.length > 0) {
      const pts = this.rectifyPoints.map((p) => `${toSx(p.x).toFixed(1)},${toSy(p.y).toFixed(1)}`).join(' ');
      parts.push(`<polyline points="${pts}" fill="none" stroke="#ffd166" stroke-width="2" />`);
      this.rectifyPoints.forEach((p, idx) => {
        const labels = ['TL', 'TR', 'BR', 'BL'];
        parts.push(`<circle cx="${toSx(p.x).toFixed(1)}" cy="${toSy(p.y).toFixed(1)}" r="5" fill="#ffd166" />`);
        parts.push(`<text x="${(toSx(p.x) + 7).toFixed(1)}" y="${(toSy(p.y) - 5).toFixed(1)}" fill="#ffd166" font-size="11" font-weight="700" font-family="ui-monospace, monospace">${labels[idx] ?? idx + 1}</text>`);
      });
    }

    // Active rubber-band shape
    if (this.activePoints.length > 0) {
      const allPts = this.mouseImgPt && this.tool !== 'excludeBrush'
        ? [...this.activePoints, this.mouseImgPt]
        : this.activePoints;
      const pts = allPts.map((p) => `${toSx(p.x).toFixed(1)},${toSy(p.y).toFixed(1)}`).join(' ');
      const col = this.tool === 'excludePoly' || this.tool === 'excludeBrush' ? '#e74c3c' : '#3b9eff';
      parts.push(`<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="4,2" />`);
    }

    this.svgOverlay.innerHTML = parts.join('');
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
