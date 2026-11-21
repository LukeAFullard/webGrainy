/** The app's fixed page structure; panels fill their containers when they render. */
export const APP_SHELL_HTML = `
    <div class="landing-shell" id="landing-shell" hidden></div>
    <header class="topbar" id="topbar"></header>
    <main class="workspace" id="workspace-main">
      <aside class="sidebar-left" id="sidebar-left" aria-label="Site and Photo Workspace"></aside>
      <section class="viewport-center" aria-label="Grain Inspection Viewport">
        <div class="toolbar" id="toolbar"></div>
        <div class="sub-toolbar" id="sub-toolbar"></div>
        <div class="canvas-stage" id="canvas-stage" tabindex="0" role="region" aria-label="Grain segmentation canvas. Use arrow keys to pan, plus or minus to zoom, 0 to fit.">
          <canvas class="canvas-layer" id="base-canvas"></canvas>
          <canvas class="canvas-layer" id="mask-canvas"></canvas>
          <svg class="svg-overlay" id="svg-overlay"></svg>
          <canvas class="loupe-canvas" id="loupe-canvas"></canvas>
          <div class="viewport-empty" id="viewport-empty">
            <div class="empty-title">Measure grain sizes from photos of gravel</div>
            <div>Add photos to start. Everything runs in your browser; nothing is uploaded.</div>
            <button type="button" class="btn btn-primary empty-cta" data-action="add-photos">Add photos</button>
            <div class="empty-hint">Or drop photos anywhere on the left panel. Zoom: pinch or mouse wheel · Move: two fingers, Space+drag or middle mouse.</div>
          </div>
          <div class="inspector-card" id="inspector-card" style="display:none;"></div>
        </div>
        <div class="viewport-footer" id="viewport-footer"></div>
      </section>
      <aside class="dashboard-right" id="dashboard-right" aria-label="Scientific Dashboard"></aside>
    </main>
    <div class="activity-bar" id="activity-bar" role="status" aria-live="polite" hidden></div>
    <dialog id="app-dialog" class="app-dialog" closedby="any" aria-labelledby="dialog-title"></dialog>
    <div id="sr-announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>
    <input type="file" id="photo-file-input" accept="image/*,.tif,.tiff" multiple style="display:none;" />
    <input type="file" id="archive-file-input" accept=".webgrainy,.json" style="display:none;" />
  `;
