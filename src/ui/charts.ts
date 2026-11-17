import type { PsdPercentiles } from '../types/index.js';
import type {
  ExtendedGrainMorphometrics,
  FabricRoseStats,
  WentworthBin,
} from '../modules/morphometricsExt.js';
import type {
  ConvergencePoint,
  JackknifeSensitivityReport,
  PerPhotoSiteBreakdown,
  SiteAnalysisReport,
} from '../modules/siteAnalysis.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PCT_KEYS: ReadonlyArray<{ key: keyof PsdPercentiles; pct: number }> = [
  { key: 'D5', pct: 5 },
  { key: 'D10', pct: 10 },
  { key: 'D16', pct: 16 },
  { key: 'D25', pct: 25 },
  { key: 'D50', pct: 50 },
  { key: 'D75', pct: 75 },
  { key: 'D84', pct: 84 },
  { key: 'D90', pct: 90 },
  { key: 'D95', pct: 95 },
];

export interface PsdChartInput {
  psd: PsdPercentiles;
  unit: 'mm' | 'px';
  xAxis: 'mm' | 'phi';
  title: string;
  subtitle?: string;
  ciLower?: PsdPercentiles;
  ciUpper?: PsdPercentiles;
  perPhotoCurves?: Array<{ label: string; D16: number; D50: number; D84: number }>;
  lightTheme?: boolean;
}

export function renderPsdChartSvg(input: PsdChartInput): string {
  const W = 400;
  const H = 240;
  const padL = 44;
  const padR = 14;
  const padT = 26;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const fg = input.lightTheme ? '#1a202c' : '#e8eef4';
  const muted = input.lightTheme ? '#4a5568' : '#8fa0b2';
  const gridCol = input.lightTheme ? '#e2e8f0' : '#26323e';
  const bg = input.lightTheme ? '#ffffff' : '#0c1014';

  const vals: number[] = [];
  for (const { key } of PCT_KEYS) {
    const v = input.psd[key];
    if (v > 0 && Number.isFinite(v)) vals.push(v);
    if (input.ciLower) {
      const lo = input.ciLower[key];
      if (lo > 0 && Number.isFinite(lo)) vals.push(lo);
    }
    if (input.ciUpper) {
      const hi = input.ciUpper[key];
      if (hi > 0 && Number.isFinite(hi)) vals.push(hi);
    }
  }

  if (vals.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="12" font-family="system-ui, sans-serif">No valid grains to plot PSD</text></svg>`;
  }

  const usePhi = input.unit === 'mm' && input.xAxis === 'phi';
  const toXVal = (d: number): number =>
    usePhi ? -Math.log2(Math.max(1e-6, d)) : Math.log10(Math.max(1e-6, d));

  const xVals = vals.map(toXVal);
  let xMin = Math.min(...xVals);
  let xMax = Math.max(...xVals);
  if (Math.abs(xMax - xMin) < 0.2) {
    xMin -= 0.5;
    xMax += 0.5;
  } else {
    const span = xMax - xMin;
    xMin -= span * 0.08;
    xMax += span * 0.08;
  }

  const xPx = (xVal: number): number =>
    padL + ((xVal - xMin) / (xMax - xMin)) * plotW;
  const yPx = (pct: number): number =>
    padT + plotH - (pct / 100) * plotH;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);

  // Wentworth grade shading when in mm
  if (input.unit === 'mm') {
    const grades: Array<{ name: string; minMm: number; maxMm: number; col: string }> = [
      { name: 'Sand', minMm: 0.0625, maxMm: 2, col: 'rgba(245, 166, 35, 0.08)' },
      { name: 'Gravel', minMm: 2, maxMm: 64, col: 'rgba(59, 158, 255, 0.07)' },
      { name: 'Cobble', minMm: 64, maxMm: 256, col: 'rgba(46, 204, 113, 0.08)' },
      { name: 'Boulder', minMm: 256, maxMm: 4096, col: 'rgba(231, 76, 60, 0.08)' },
    ];
    for (const g of grades) {
      const x1 = xPx(toXVal(g.minMm));
      const x2 = xPx(toXVal(g.maxMm));
      const left = Math.max(padL, Math.min(x1, x2));
      const right = Math.min(padL + plotW, Math.max(x1, x2));
      if (right > left) {
        parts.push(
          `<rect x="${left.toFixed(1)}" y="${padT}" width="${(right - left).toFixed(1)}" height="${plotH}" fill="${g.col}" />`,
        );
        if (right - left > 28) {
          parts.push(
            `<text x="${((left + right) / 2).toFixed(1)}" y="${padT + 11}" text-anchor="middle" fill="${muted}" font-size="9" font-family="system-ui, sans-serif">${g.name}</text>`,
          );
        }
      }
    }
  }

  // Horizontal grid
  for (const pct of [0, 16, 50, 84, 100]) {
    const y = yPx(pct);
    parts.push(
      `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="${gridCol}" stroke-dasharray="${pct === 0 || pct === 100 ? 'none' : '2,3'}" />`,
    );
    parts.push(
      `<text x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="${muted}" font-size="9" font-family="ui-monospace, monospace">${pct}%</text>`,
    );
  }

  // X-axis ticks
  const tickCount = 5;
  for (let i = 0; i <= tickCount; i++) {
    const xv = xMin + (i / tickCount) * (xMax - xMin);
    const x = xPx(xv);
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${padT + plotH}" stroke="${gridCol}" stroke-dasharray="2,3" />`,
    );
    const label = usePhi ? `${xv.toFixed(1)}` : Math.pow(10, xv).toFixed(Math.pow(10, xv) >= 10 ? 0 : 1);
    parts.push(
      `<text x="${x.toFixed(1)}" y="${padT + plotH + 13}" text-anchor="middle" fill="${muted}" font-size="9" font-family="ui-monospace, monospace">${label}</text>`,
    );
  }

  // Faint individual photo curves (D16-D50-D84)
  if (input.perPhotoCurves && input.perPhotoCurves.length > 1) {
    for (const ph of input.perPhotoCurves) {
      if (ph.D16 > 0 && ph.D50 > 0 && ph.D84 > 0) {
        const pts = [
          `${xPx(toXVal(ph.D16)).toFixed(1)},${yPx(16).toFixed(1)}`,
          `${xPx(toXVal(ph.D50)).toFixed(1)},${yPx(50).toFixed(1)}`,
          `${xPx(toXVal(ph.D84)).toFixed(1)},${yPx(84).toFixed(1)}`,
        ].join(' ');
        parts.push(
          `<polyline points="${pts}" fill="none" stroke="rgba(159, 176, 192, 0.35)" stroke-width="1" />`,
        );
      }
    }
  }

  // 95% Bootstrap CI ribbon
  if (input.ciLower && input.ciUpper) {
    const loPts: string[] = [];
    const hiPts: string[] = [];
    for (const { key, pct } of PCT_KEYS) {
      const lo = input.ciLower[key];
      const hi = input.ciUpper[key];
      if (lo > 0 && hi > 0) {
        loPts.push(`${xPx(toXVal(lo)).toFixed(1)},${yPx(pct).toFixed(1)}`);
        hiPts.unshift(`${xPx(toXVal(hi)).toFixed(1)},${yPx(pct).toFixed(1)}`);
      }
    }
    if (loPts.length > 1 && hiPts.length > 1) {
      parts.push(
        `<polygon points="${[...loPts, ...hiPts].join(' ')}" fill="rgba(59, 158, 255, 0.22)" />`,
      );
    }
  }

  // Main cumulative curve
  const curvePts: string[] = [];
  for (const { key, pct } of PCT_KEYS) {
    const v = input.psd[key];
    if (v > 0) {
      curvePts.push(`${xPx(toXVal(v)).toFixed(1)},${yPx(pct).toFixed(1)}`);
    }
  }
  if (curvePts.length > 1) {
    parts.push(
      `<polyline points="${curvePts.join(' ')}" fill="none" stroke="#3b9eff" stroke-width="2.4" stroke-linejoin="round" />`,
    );
  }

  // D16, D50, D84 reference lines & markers
  for (const { key, pct, col } of [
    { key: 'D16' as const, pct: 16, col: '#2ecc71' },
    { key: 'D50' as const, pct: 50, col: '#f5a623' },
    { key: 'D84' as const, pct: 84, col: '#e74c3c' },
  ]) {
    const v = input.psd[key];
    if (v > 0) {
      const x = xPx(toXVal(v));
      const y = yPx(pct);
      parts.push(
        `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x.toFixed(1)}" y2="${padT + plotH}" stroke="${col}" stroke-width="1" stroke-dasharray="3,2" />`,
      );
      parts.push(
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${col}" stroke="${bg}" stroke-width="1" />`,
      );
    }
  }

  // Titles & Axis Labels
  parts.push(
    `<text x="${padL}" y="15" fill="${fg}" font-size="11" font-weight="700" font-family="system-ui, sans-serif">${esc(input.title)}</text>`,
  );
  if (input.subtitle) {
    parts.push(
      `<text x="${W - padR}" y="15" text-anchor="end" fill="${muted}" font-size="9" font-family="system-ui, sans-serif">${esc(input.subtitle)}</text>`,
    );
  }
  parts.push(
    `<text x="${padL + plotW / 2}" y="${H - 5}" text-anchor="middle" fill="${muted}" font-size="10" font-family="system-ui, sans-serif">${usePhi ? 'Grain Size (φ = -log₂ mm)' : `Grain Size (${input.unit}, log₁₀ scale)`}</text>`,
  );

  parts.push('</svg>');
  return parts.join('');
}

export function renderConvergenceChartSvg(
  points: readonly ConvergencePoint[],
  lightTheme = false,
): string {
  const W = 400;
  const H = 180;
  const padL = 44;
  const padR = 14;
  const padT = 22;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';

  if (points.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="11" font-family="system-ui, sans-serif">Add &amp; analyze photos to view 1..N convergence</text></svg>`;
  }

  const allY = points.flatMap((p) => [p.D16, p.D50, p.D84, p.ciLoD50, p.ciHiD50]).filter((v) => v > 0);
  const yMin = Math.max(0, Math.min(...allY) * 0.85);
  const yMax = Math.max(...allY, yMin + 1) * 1.1;

  const xPx = (idx: number): number =>
    points.length === 1 ? padL + plotW / 2 : padL + (idx / (points.length - 1)) * plotW;
  const yPx = (val: number): number =>
    padT + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);
  parts.push(`<text x="${padL}" y="14" fill="${fg}" font-size="10.5" font-weight="700" font-family="system-ui, sans-serif">Cumulative Convergence (1..N Photos): D16 / D50 ± 95% CI / D84</text>`);

  // CI ribbon for D50
  if (points.length > 1) {
    const hiPts = points.map((p, i) => `${xPx(i).toFixed(1)},${yPx(p.ciHiD50).toFixed(1)}`);
    const loPts = [...points].reverse().map((p, ri) => `${xPx(points.length - 1 - ri).toFixed(1)},${yPx(p.ciLoD50).toFixed(1)}`);
    parts.push(`<polygon points="${[...hiPts, ...loPts].join(' ')}" fill="rgba(245, 166, 35, 0.18)" />`);
  }

  const line = (getter: (p: ConvergencePoint) => number, col: string, w: number): void => {
    const pts = points.map((p, i) => `${xPx(i).toFixed(1)},${yPx(getter(p)).toFixed(1)}`).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="${w}" />`);
  };
  line((p) => p.D84, '#d93829', 1.4);
  line((p) => p.D50, '#d98300', 2.2);
  line((p) => p.D16, '#1e9e56', 1.4);

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const x = xPx(i);
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${yPx(p.D50).toFixed(1)}" r="3" fill="#d98300" />`);
    parts.push(`<text x="${x.toFixed(1)}" y="${padT + plotH + 12}" text-anchor="middle" fill="${muted}" font-size="9" font-family="ui-monospace, monospace">${p.photoCount}</text>`);
  }

  parts.push(`<text x="${padL - 4}" y="${padT + 6}" text-anchor="end" fill="${muted}" font-size="8.5" font-family="ui-monospace, monospace">${yMax.toFixed(1)}</text>`);
  parts.push(`<text x="${padL - 4}" y="${padT + plotH}" text-anchor="end" fill="${muted}" font-size="8.5" font-family="ui-monospace, monospace">${yMin.toFixed(1)}</text>`);
  parts.push(`<text x="${padL + plotW / 2}" y="${H - 4}" text-anchor="middle" fill="${muted}" font-size="9.5" font-family="system-ui, sans-serif">Number of Pooled Photos (k)</text>`);
  parts.push('</svg>');
  return parts.join('');
}

export function renderJackknifeChartSvg(
  jackknife: JackknifeSensitivityReport | null,
  lightTheme = false,
): string {
  const W = 400;
  const barH = 18;
  const items = jackknife?.perPhoto ?? [];
  const H = Math.max(90, 36 + items.length * barH);
  const padL = 110;
  const padR = 45;
  const padT = 24;
  const plotW = W - padL - padR;
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';
  const axisCol = lightTheme ? '#cbd5e1' : '#3b4b5c';

  if (items.length === 0) {
    return `<svg viewBox="0 0 ${W} 90" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="90" fill="${bg}"/><text x="${W / 2}" y="48" text-anchor="middle" fill="${muted}" font-size="11" font-family="system-ui, sans-serif">Requires ≥ 2 included photos for Jackknife sensitivity</text></svg>`;
  }

  const maxAbs = Math.max(12, ...items.map((p) => Math.abs(p.relPctD50)));
  const zeroX = padL + plotW / 2;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);
  parts.push(`<text x="10" y="15" fill="${fg}" font-size="10.5" font-weight="700" font-family="system-ui, sans-serif">Leave-One-Out Jackknife Influence on D50 (%)</text>`);
  parts.push(`<line x1="${zeroX.toFixed(1)}" y1="${padT}" x2="${zeroX.toFixed(1)}" y2="${H - 8}" stroke="${axisCol}" />`);

  items.forEach((item, i) => {
    const y = padT + i * barH;
    const w = (Math.abs(item.relPctD50) / maxAbs) * (plotW / 2);
    const x = item.relPctD50 >= 0 ? zeroX : zeroX - w;
    const col = item.highInfluence ? '#e74c3c' : '#2b7de9';
    const shortLabel = item.label.length > 14 ? `${item.label.slice(0, 13)}…` : item.label;

    parts.push(`<text x="${padL - 6}" y="${y + 12}" text-anchor="end" fill="${muted}" font-size="9.5" font-family="system-ui, sans-serif">${esc(shortLabel)}</text>`);
    parts.push(`<rect x="${x.toFixed(1)}" y="${y + 3}" width="${Math.max(1.5, w).toFixed(1)}" height="11" rx="2" fill="${col}" />`);
    parts.push(`<text x="${W - 6}" y="${y + 12}" text-anchor="end" fill="${item.highInfluence ? (lightTheme ? '#b91c1c' : '#ff8577') : muted}" font-size="9" font-family="ui-monospace, monospace">${item.relPctD50 >= 0 ? '+' : ''}${item.relPctD50.toFixed(1)}%</text>`);
  });

  parts.push('</svg>');
  return parts.join('');
}

export function renderWentworthHistogramSvg(
  bins: readonly WentworthBin[],
  lightTheme = false,
): string {
  const W = 400;
  const H = 180;
  const padL = 38;
  const padR = 12;
  const padT = 22;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';

  if (bins.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="11" font-family="system-ui, sans-serif">Calibrate in mm to view Wentworth φ histogram</text></svg>`;
  }

  const maxPct = Math.max(10, ...bins.map((b) => b.weightPct));
  const bw = plotW / bins.length;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);
  parts.push(`<text x="${padL}" y="14" fill="${fg}" font-size="10.5" font-weight="700" font-family="system-ui, sans-serif">Wentworth Size Histogram (Weight %)</text>`);

  bins.forEach((b, i) => {
    const h = (b.weightPct / maxPct) * plotH;
    const x = padL + i * bw + 1;
    const y = padT + plotH - h;
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(2, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="#2b7de9" rx="1" />`);
    if (bins.length <= 16 || i % 2 === 0) {
      parts.push(`<text x="${(x + bw / 2 - 1).toFixed(1)}" y="${padT + plotH + 12}" text-anchor="middle" fill="${muted}" font-size="8" font-family="ui-monospace, monospace">${b.phiMin.toFixed(1)}</text>`);
    }
  });

  parts.push(`<text x="${padL - 4}" y="${padT + 8}" text-anchor="end" fill="${muted}" font-size="8.5" font-family="ui-monospace, monospace">${maxPct.toFixed(0)}%</text>`);
  parts.push(`<text x="${padL + plotW / 2}" y="${H - 4}" text-anchor="middle" fill="${muted}" font-size="9.5" font-family="system-ui, sans-serif">φ Size Class (lower bound)</text>`);
  parts.push('</svg>');
  return parts.join('');
}

export function renderAspectRatioHistogramSvg(
  grains: readonly ExtendedGrainMorphometrics[],
  lightTheme = false,
): string {
  const W = 400;
  const H = 145;
  const padL = 38;
  const padR = 12;
  const padT = 22;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';

  if (grains.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="11" font-family="system-ui, sans-serif">No grains for Aspect Ratio (b/a) distribution</text></svg>`;
  }

  const numBins = 10;
  const counts = new Array<number>(numBins).fill(0);
  for (const g of grains) {
    const idx = Math.min(numBins - 1, Math.max(0, Math.floor(g.aspectRatio * numBins)));
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const maxC = Math.max(1, ...counts);
  const bw = plotW / numBins;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);
  parts.push(`<text x="${padL}" y="14" fill="${fg}" font-size="10.5" font-weight="700" font-family="system-ui, sans-serif">Aspect Ratio (b / a) Distribution (n=${grains.length})</text>`);

  counts.forEach((c, i) => {
    const h = (c / maxC) * plotH;
    const x = padL + i * bw + 2;
    const y = padT + plotH - h;
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(4, bw - 4).toFixed(1)}" height="${h.toFixed(1)}" fill="#23a85c" rx="1" />`);
    parts.push(`<text x="${(x + bw / 2 - 2).toFixed(1)}" y="${padT + plotH + 11}" text-anchor="middle" fill="${muted}" font-size="8" font-family="ui-monospace, monospace">${(i / numBins).toFixed(1)}</text>`);
  });

  parts.push('</svg>');
  return parts.join('');
}

export function renderFabricRoseSvg(rose: FabricRoseStats, lightTheme = false): string {
  const W = 320;
  const H = 220;
  const cx = W / 2;
  const cy = H / 2 + 6;
  const R = 76;
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';
  const gridCol = lightTheme ? '#cbd5e1' : '#26323e';

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);
  parts.push(`<text x="${cx}" y="15" text-anchor="middle" fill="${fg}" font-size="10.5" font-weight="700" font-family="system-ui, sans-serif">180° Symmetric Axial Fabric Rose (n=${rose.grainCount})</text>`);

  for (const frac of [0.33, 0.66, 1.0]) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${(R * frac).toFixed(1)}" fill="none" stroke="${gridCol}" />`);
  }
  parts.push(`<line x1="${cx - R - 6}" y1="${cy}" x2="${cx + R + 6}" y2="${cy}" stroke="${gridCol}" />`);
  parts.push(`<line x1="${cx}" y1="${cy - R - 6}" x2="${cx}" y2="${cy + R + 6}" stroke="${gridCol}" />`);
  parts.push(`<text x="${cx}" y="${cy - R - 9}" text-anchor="middle" fill="${muted}" font-size="8.5" font-family="ui-monospace, monospace">0° (Vert)</text>`);
  parts.push(`<text x="${cx + R + 10}" y="${cy + 3}" text-anchor="start" fill="${muted}" font-size="8.5" font-family="ui-monospace, monospace">90°</text>`);

  const maxPct = Math.max(5, ...rose.bins.map((b) => b.proportionPct));
  for (const bin of rose.bins) {
    if (bin.proportionPct <= 0) continue;
    const rad = (bin.proportionPct / maxPct) * R;
    // Draw both bin and +180° symmetric mirror; 0° = top (image vertical y-axis)
    for (const offsetDeg of [0, 180]) {
      const a0 = ((bin.startDeg + offsetDeg - 90) * Math.PI) / 180;
      const a1 = ((bin.endDeg + offsetDeg - 90) * Math.PI) / 180;
      const x1 = cx + rad * Math.cos(a0);
      const y1 = cy + rad * Math.sin(a0);
      const x2 = cx + rad * Math.cos(a1);
      const y2 = cy + rad * Math.sin(a1);
      parts.push(
        `<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${rad.toFixed(1)} ${rad.toFixed(1)} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="rgba(59, 158, 255, 0.55)" stroke="#3b9eff" stroke-width="0.8" />`,
      );
    }
  }

  // Mean resultant vector
  if (rose.grainCount > 0 && rose.resultantLength > 0) {
    const meanRad = ((rose.meanAxialDeg - 90) * Math.PI) / 180;
    const len = Math.max(12, rose.resultantLength * R);
    const dx = len * Math.cos(meanRad);
    const dy = len * Math.sin(meanRad);
    parts.push(
      `<line x1="${(cx - dx).toFixed(1)}" y1="${(cy - dy).toFixed(1)}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="#d98300" stroke-width="2.2" />`,
    );
  }

  parts.push(
    `<text x="${cx}" y="${H - 6}" text-anchor="middle" fill="${muted}" font-size="9" font-family="ui-monospace, monospace">Mean: ${rose.meanAxialDeg.toFixed(1)}° | R=${rose.resultantLength.toFixed(3)} | Z=${rose.rayleighZ.toFixed(2)}${rose.rayleighP !== null ? ` (p=${rose.rayleighP.toFixed(3)})` : ''}</text>`,
  );
  parts.push('</svg>');
  return parts.join('');
}

export function renderPrintablePsdSvg(
  report: SiteAnalysisReport,
  siteName: string,
  xAxis: 'mm' | 'phi',
): string {
  const perPhotoCurves: Array<{ label: string; D16: number; D50: number; D84: number }> = report.perPhoto.map(
    (p: PerPhotoSiteBreakdown) => ({
      label: p.label,
      D16: p.D16,
      D50: p.D50,
      D84: p.D84,
    }),
  );
  return renderPsdChartSvg({
    psd: report.psd,
    unit: report.unit,
    xAxis,
    title: `${siteName} — Cumulative PSD (${report.poolingMode})`,
    subtitle: `${report.includedPhotoCount} photos, n=${report.validGrainCount}, metric=${report.sizeMetric}, ${report.statisticalBasisLabel}`,
    ciLower: report.bootstrapCi.lower,
    ciUpper: report.bootstrapCi.upper,
    perPhotoCurves,
    lightTheme: true,
  });
}
