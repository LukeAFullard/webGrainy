/** Shared helpers for the panel renderers. */

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Charts drawn in the last render, by id: their title and a renderer (light or dark theme). */
export type ChartRegistry = Map<string, { title: string; render: (light: boolean) => string }>;

/** A chart with SVG/PNG download buttons; registers its renderer so the buttons can redraw it. */
export function chartBoxFor(charts: ChartRegistry) {
  return (id: string, title: string, render: (light: boolean) => string, light: boolean): string => {
    charts.set(id, { title, render });
    return `<div class="chart-box" data-chart-id="${esc(id)}">${render(light)}
    <div class="chart-actions">
      <button type="button" class="btn btn-xs" data-chart-dl="${esc(id)}" data-fmt="svg" title="Download as SVG (vector, for reports)" aria-label="Download ${esc(title)} as SVG">SVG</button>
      <button type="button" class="btn btn-xs" data-chart-dl="${esc(id)}" data-fmt="png" title="Download as PNG image" aria-label="Download ${esc(title)} as PNG">PNG</button>
    </div>
  </div>`;
  };
}
