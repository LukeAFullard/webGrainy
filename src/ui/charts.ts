import type { PsdPercentiles } from '../types/index.js';
import type { FabricRoseStats } from '../modules/morphometricsExt.js';
import type { SizeHistogram } from '../modules/histograms.js';
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
  /** Effective minimum resolvable grain diameter (same unit as `psd`). */
  detectionLimit?: number;
  lightTheme?: boolean;
}

export function renderPsdChartSvg(input: PsdChartInput): string {
  const W = 400;
  const padL = 48;
  const padR = 14;
  // A subtitle gets its own line under the title (side by side, long names overlapped).
  const padT = input.subtitle ? 36 : 26;
  const plotW = W - padL - padR;
  // The plot keeps its size; the legend below it adds rows to the height.
  const plotH = 240 - padT - 34;
  let H = 240;

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

  // Effective pixel detection limit marker
  let drewLimit = false;
  if (
    typeof input.detectionLimit === 'number' &&
    Number.isFinite(input.detectionLimit) &&
    input.detectionLimit > 0
  ) {
    const dx = xPx(toXVal(input.detectionLimit));
    if (dx >= padL && dx <= padL + plotW) {
      drewLimit = true;
      const limCol = input.lightTheme ? '#b7791f' : '#f5a623';
      const limText = `Min ~${input.detectionLimit.toFixed(input.unit === 'mm' ? 1 : 0)} ${input.unit}`;
      const anchor = dx > padL + plotW - 72 ? 'end' : 'start';
      const tx = anchor === 'end' ? dx - 4 : dx + 4;
      parts.push(
        `<line x1="${dx.toFixed(1)}" y1="${padT}" x2="${dx.toFixed(1)}" y2="${padT + plotH}" stroke="${limCol}" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.85" />`,
      );
      parts.push(
        `<text x="${tx.toFixed(1)}" y="${padT + plotH - 5}" text-anchor="${anchor}" fill="${limCol}" font-size="8.5" font-family="ui-monospace, monospace">${esc(limText)}</text>`,
      );
    }
  }

  // Faint individual photo curves (D16-D50-D84)
  const drawPhotoCurves = (input.perPhotoCurves?.length ?? 0) > 1;
  if (input.perPhotoCurves && drawPhotoCurves) {
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
  let drewCi = false;
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
      drewCi = true;
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

  // D16, D50, D84 reference lines & markers (named, with their values, in the legend)
  const MARKERS = [
    { key: 'D16' as const, pct: 16, col: '#2ecc71' },
    { key: 'D50' as const, pct: 50, col: input.lightTheme ? '#dd8a0b' : '#f5a623' },
    { key: 'D84' as const, pct: 84, col: '#e74c3c' },
  ];
  for (const { key, pct, col } of MARKERS) {
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
      `<text x="${padL}" y="27" fill="${muted}" font-size="9" font-family="system-ui, sans-serif">${esc(input.subtitle)}</text>`,
    );
  }
  parts.push(
    `<text x="${padL + plotW / 2}" y="${padT + plotH + 26}" text-anchor="middle" fill="${muted}" font-size="10" font-family="system-ui, sans-serif">${usePhi ? 'Grain Size (φ = -log₂ mm)' : `Grain Size (${input.unit}, log₁₀ scale)`}</text>`,
  );
  const yMid = padT + plotH / 2;
  parts.push(
    `<text x="11" y="${yMid.toFixed(1)}" transform="rotate(-90 11 ${yMid.toFixed(1)})" text-anchor="middle" fill="${muted}" font-size="9" font-family="system-ui, sans-serif">% finer (cumulative)</text>`,
  );

  // Legend: what every colour and line means, with the D16 / D50 / D84 values.
  const fmt = (v: number): string =>
    input.unit === 'px' ? `${v.toFixed(0)} px` : `${v.toFixed(v < 1 ? 2 : 1)} mm${usePhi ? ` (${(-Math.log2(v)).toFixed(2)} φ)` : ''}`;
  type Item = { sym: (x: number, y: number) => string; text: string };
  const items: Item[] = [];
  for (const { key, col } of MARKERS) {
    const v = input.psd[key];
    if (v > 0 && Number.isFinite(v)) {
      items.push({
        sym: (x, y) => `<circle cx="${x + 5}" cy="${y - 3}" r="3.5" fill="${col}" stroke="${bg}" stroke-width="1" />`,
        text: `${key} = ${fmt(v)}`,
      });
    }
  }
  const lineItems: Item[] = [
    {
      sym: (x, y) => `<line x1="${x}" y1="${y - 3}" x2="${x + 12}" y2="${y - 3}" stroke="#3b9eff" stroke-width="2.4" />`,
      text: 'Cumulative PSD',
    },
  ];
  if (drewCi) {
    lineItems.push({ sym: (x, y) => `<rect x="${x}" y="${y - 7}" width="12" height="8" fill="rgba(59, 158, 255, 0.22)" />`, text: '95% CI (bootstrap)' });
  }
  if (drawPhotoCurves) {
    lineItems.push({ sym: (x, y) => `<line x1="${x}" y1="${y - 3}" x2="${x + 12}" y2="${y - 3}" stroke="rgba(159, 176, 192, 0.7)" stroke-width="1" />`, text: 'Each photo (D16–D50–D84)' });
  }
  if (drewLimit) {
    const limCol = input.lightTheme ? '#b7791f' : '#f5a623';
    lineItems.push({ sym: (x, y) => `<line x1="${x + 6}" y1="${y - 8}" x2="${x + 6}" y2="${y + 1}" stroke="${limCol}" stroke-width="1.2" stroke-dasharray="3,2" />`, text: 'Smallest measurable grain' });
  }
  const rows: Item[][] = [];
  for (const group of [items, lineItems]) {
    let row: Item[] = [];
    let width = 0;
    for (const it of group) {
      const w = 18 + it.text.length * 4.7 + 10;
      if (row.length > 0 && width + w > W - padL - padR + 20) {
        rows.push(row);
        row = [];
        width = 0;
      }
      row.push(it);
      width += w;
    }
    if (row.length > 0) rows.push(row);
  }
  let y = padT + plotH + 44;
  for (const row of rows) {
    let x = padL - 20;
    for (const it of row) {
      parts.push(it.sym(x, y));
      parts.push(`<text x="${x + 16}" y="${y}" fill="${fg}" font-size="9" font-family="system-ui, sans-serif">${esc(it.text)}</text>`);
      x += 18 + it.text.length * 4.7 + 10;
    }
    y += 14;
  }
  H = Math.max(240, y - 4);
  parts[0] = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  parts[1] = `<rect width="${W}" height="${H}" fill="${bg}" />`;

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

  const allY = points.flatMap((p) => [p.D16, p.D50, p.D84, p.ciLoD50, p.ciHiD50]).filter((v) => Number.isFinite(v) && v > 0);
  if (allY.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="11" font-family="system-ui, sans-serif">No counted grains yet: convergence not available</text></svg>`;
  }
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

  // CI ribbon for D50 (through the photo counts that have a CI; large sites compute it at checkpoints)
  const ciIdx = points.map((p, i) => (Number.isFinite(p.ciLoD50) && Number.isFinite(p.ciHiD50) ? i : -1)).filter((i) => i >= 0);
  if (ciIdx.length > 1) {
    const hiPts = ciIdx.map((i) => `${xPx(i).toFixed(1)},${yPx(points[i]!.ciHiD50).toFixed(1)}`);
    const loPts = [...ciIdx].reverse().map((i) => `${xPx(i).toFixed(1)},${yPx(points[i]!.ciLoD50).toFixed(1)}`);
    parts.push(`<polygon points="${[...hiPts, ...loPts].join(' ')}" fill="rgba(245, 166, 35, 0.18)" />`);
  }

  // Photo counts with no value (e.g. no counted grains yet) break the line instead of emitting NaN.
  const line = (getter: (p: ConvergencePoint) => number, col: string, w: number): void => {
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 1) parts.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${col}" stroke-width="${w}" />`);
      run = [];
    };
    points.forEach((p, i) => {
      const v = getter(p);
      if (Number.isFinite(v)) run.push(`${xPx(i).toFixed(1)},${yPx(v).toFixed(1)}`);
      else flush();
    });
    flush();
  };
  line((p) => p.D84, '#d93829', 1.4);
  line((p) => p.D50, '#d98300', 2.2);
  line((p) => p.D16, '#1e9e56', 1.4);

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const x = xPx(i);
    if (Number.isFinite(p.D50)) parts.push(`<circle cx="${x.toFixed(1)}" cy="${yPx(p.D50).toFixed(1)}" r="${points.length > 30 ? 1.8 : 3}" fill="#d98300" />`);
    const labelEvery = Math.max(1, Math.ceil(points.length / 15));
    if (i % labelEvery === 0 || i === points.length - 1) {
      parts.push(`<text x="${x.toFixed(1)}" y="${padT + plotH + 12}" text-anchor="middle" fill="${muted}" font-size="9" font-family="ui-monospace, monospace">${p.photoCount}</text>`);
    }
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

  const maxAbs = Math.max(12, ...items.filter((p) => Number.isFinite(p.relPctD50)).map((p) => Math.abs(p.relPctD50)));
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
    if (!Number.isFinite(item.relPctD50)) {
      // Leaving this photo out leaves nothing to pool (e.g. only zero-weight facies photos).
      parts.push(`<text x="${W - 6}" y="${y + 12}" text-anchor="end" fill="${muted}" font-size="9" font-family="ui-monospace, monospace">n/a</text>`);
      return;
    }
    parts.push(`<rect x="${x.toFixed(1)}" y="${y + 3}" width="${Math.max(1.5, w).toFixed(1)}" height="11" rx="2" fill="${col}" />`);
    parts.push(`<text x="${W - 6}" y="${y + 12}" text-anchor="end" fill="${item.highInfluence ? (lightTheme ? '#b91c1c' : '#ff8577') : muted}" font-size="9" font-family="ui-monospace, monospace">${item.relPctD50 >= 0 ? '+' : ''}${item.relPctD50.toFixed(1)}%</text>`);
  });

  parts.push('</svg>');
  return parts.join('');
}

function fmtEdge(v: number): string {
  return v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(v % 1 === 0 ? 0 : 1) : v.toPrecision(2);
}

/** Area-weighted size distribution (small to large), φ classes in mm or power-of-two px classes. */
export function renderSizeHistogramSvg(hist: SizeHistogram, lightTheme = false, title?: string): string {
  const W = 400;
  const H = 190;
  const padL = 38;
  const padR = 12;
  const padT = 24;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';
  const heading = title ?? 'Size Distribution (area-weighted %)';
  if (hist.bins.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="11" font-family="system-ui, sans-serif">No grains yet</text></svg>`;
  }
  const maxPct = Math.max(10, Math.ceil(Math.max(...hist.bins.map((b) => b.weightPct)) / 10) * 10);
  const bw = plotW / hist.bins.length;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);
  parts.push(`<text x="${padL}" y="15" fill="${fg}" font-size="10.5" font-weight="700" font-family="system-ui, sans-serif">${esc(heading)} · n=${hist.n}</text>`);
  for (const f of [0.5, 1]) {
    const y = padT + plotH - f * plotH;
    parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${muted}" stroke-opacity="0.25" />`);
    parts.push(`<text x="${padL - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="${muted}" font-size="8.5" font-family="ui-monospace, monospace">${(maxPct * f).toFixed(0)}%</text>`);
  }
  const labelEvery = hist.bins.length > 14 ? 2 : 1;
  hist.bins.forEach((b, i) => {
    const h = (b.weightPct / maxPct) * plotH;
    const x = padL + i * bw;
    const y = padT + plotH - h;
    parts.push(`<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(2, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="#2b7de9" rx="1"><title>${fmtEdge(b.lo)}–${fmtEdge(b.hi)} ${hist.unit}${b.className ? ` (${esc(b.className)})` : ''}: ${b.weightPct.toFixed(1)}%, ${b.count} grains</title></rect>`);
    if (i % labelEvery === 0) {
      parts.push(`<text x="${x.toFixed(1)}" y="${padT + plotH + 12}" text-anchor="middle" fill="${muted}" font-size="8" font-family="ui-monospace, monospace">${fmtEdge(b.lo)}</text>`);
    }
  });
  const last = hist.bins[hist.bins.length - 1]!;
  parts.push(`<text x="${(padL + plotW).toFixed(1)}" y="${padT + plotH + 12}" text-anchor="middle" fill="${muted}" font-size="8" font-family="ui-monospace, monospace">${fmtEdge(last.hi)}</text>`);
  const axis = hist.unit === 'mm' ? `Grain size (mm, ${hist.step} φ classes)` : `Grain size (px, ${hist.step === 1 ? '×2' : '×√2'} classes; calibrate for mm)`;
  parts.push(`<text x="${padL + plotW / 2}" y="${H - 6}" text-anchor="middle" fill="${muted}" font-size="9.5" font-family="system-ui, sans-serif">${axis}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

/** b/a aspect-ratio counts in equal bins over [0, 1] (see histograms.aspectRatioCounts). */
export function renderAspectRatioHistogramSvg(counts: readonly number[], lightTheme = false): string {
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
  const n = counts.reduce((s, c) => s + c, 0);
  if (n === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="11" font-family="system-ui, sans-serif">No grains for Aspect Ratio (b/a) distribution</text></svg>`;
  }
  const numBins = counts.length;
  const maxC = Math.max(1, ...counts);
  const bw = plotW / numBins;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);
  parts.push(`<text x="${padL}" y="14" fill="${fg}" font-size="10.5" font-weight="700" font-family="system-ui, sans-serif">Aspect Ratio (b / a) Distribution (n=${n})</text>`);
  counts.forEach((c, i) => {
    const h = (c / maxC) * plotH;
    const x = padL + i * bw + 2;
    const y = padT + plotH - h;
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(4, bw - 4).toFixed(1)}" height="${h.toFixed(1)}" fill="#23a85c" rx="1"><title>${(i / numBins).toFixed(1)}–${((i + 1) / numBins).toFixed(1)}: ${c} grains</title></rect>`);
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
  // Angles run counter-clockwise from the photo's vertical (the same convention as each
  // grain's `orientationRad`), so 90° sits on the left and the rose reads like the photo.
  parts.push(`<text x="${cx - R - 10}" y="${cy + 3}" text-anchor="end" fill="${muted}" font-size="8.5" font-family="ui-monospace, monospace">90°</text>`);

  const maxPct = Math.max(5, ...rose.bins.map((b) => b.proportionPct));
  for (const bin of rose.bins) {
    if (bin.proportionPct <= 0) continue;
    const rad = (bin.proportionPct / maxPct) * R;
    // Draw both bin and +180° symmetric mirror; 0° = top (image vertical y-axis), angles
    // increasing counter-clockwise on screen: angle d points along (-sin d, -cos d).
    for (const offsetDeg of [0, 180]) {
      const a0 = ((bin.startDeg + offsetDeg) * Math.PI) / 180;
      const a1 = ((bin.endDeg + offsetDeg) * Math.PI) / 180;
      const x1 = cx - rad * Math.sin(a0);
      const y1 = cy - rad * Math.cos(a0);
      const x2 = cx - rad * Math.sin(a1);
      const y2 = cy - rad * Math.cos(a1);
      // sweep-flag 0: counter-clockwise on screen, matching increasing angle.
      parts.push(
        `<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${rad.toFixed(1)} ${rad.toFixed(1)} 0 0 0 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="rgba(59, 158, 255, 0.55)" stroke="#3b9eff" stroke-width="0.8" />`,
      );
    }
  }

  // Mean resultant vector
  if (rose.grainCount > 0 && rose.resultantLength > 0) {
    const meanRad = (rose.meanAxialDeg * Math.PI) / 180;
    const len = Math.max(12, rose.resultantLength * R);
    const dx = -len * Math.sin(meanRad);
    const dy = -len * Math.cos(meanRad);
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

export interface CompareSeries {
  name: string;
  color: string;
  psd: PsdPercentiles;
  ciLower?: PsdPercentiles;
  ciUpper?: PsdPercentiles;
}

/** Cumulative PSD curves of several sites overlaid, with their bootstrap CI bands and a legend. */
export function renderComparePsdSvg(
  series: readonly CompareSeries[],
  unit: 'mm' | 'px',
  xAxis: 'mm' | 'phi',
  lightTheme = false,
): string {
  const W = 400;
  const legendRows = Math.ceil(series.length / 2);
  const H = 230 + legendRows * 13;
  const padL = 44;
  const padR = 14;
  const padT = 24;
  const padB = 34 + legendRows * 13;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';
  const gridCol = lightTheme ? '#e2e8f0' : '#26323e';
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const usePhi = unit === 'mm' && xAxis === 'phi';
  const toX = (d: number): number => (usePhi ? -Math.log2(Math.max(1e-6, d)) : Math.log10(Math.max(1e-6, d)));
  const vals: number[] = [];
  for (const s of series) {
    for (const { key } of PCT_KEYS) {
      for (const v of [s.psd[key], s.ciLower?.[key], s.ciUpper?.[key]]) if (v !== undefined && v > 0 && Number.isFinite(v)) vals.push(toX(v));
    }
  }
  if (vals.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="12" font-family="system-ui, sans-serif">Choose at least one analysed, calibrated site</text></svg>`;
  }
  let xMin = Math.min(...vals);
  let xMax = Math.max(...vals);
  const span = Math.max(0.4, xMax - xMin);
  xMin -= span * 0.06;
  xMax += span * 0.06;
  // φ: coarse (negative) on the right, so size still increases to the right.
  const xPx = (x: number): number => padL + (usePhi ? (xMax - x) / (xMax - xMin) : (x - xMin) / (xMax - xMin)) * plotW;
  const yPx = (pct: number): number => padT + plotH - (pct / 100) * plotH;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);
  parts.push(`<text x="${padL}" y="15" fill="${fg}" font-size="10.5" font-weight="700" font-family="system-ui, sans-serif">Cumulative Grain-Size Distributions (${series.length} sites)</text>`);
  for (const pct of [0, 16, 50, 84, 100]) {
    const y = yPx(pct);
    parts.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="${gridCol}" stroke-dasharray="${pct === 0 || pct === 100 ? 'none' : '2,3'}" />`);
    parts.push(`<text x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="${muted}" font-size="9" font-family="ui-monospace, monospace">${pct}%</text>`);
  }
  for (let i = 0; i <= 4; i++) {
    const xv = xMin + ((xMax - xMin) * i) / 4;
    const label = usePhi ? xv.toFixed(1) : (10 ** xv >= 10 ? (10 ** xv).toFixed(0) : (10 ** xv).toPrecision(2));
    parts.push(`<text x="${xPx(xv).toFixed(1)}" y="${padT + plotH + 13}" text-anchor="middle" fill="${muted}" font-size="9" font-family="ui-monospace, monospace">${label}</text>`);
  }
  parts.push(`<text x="${padL + plotW / 2}" y="${padT + plotH + 27}" text-anchor="middle" fill="${muted}" font-size="9.5" font-family="system-ui, sans-serif">${usePhi ? 'Grain size (φ, coarse to the right)' : `Grain size (${unit}, log scale)`}</text>`);
  for (const s of series) {
    if (s.ciLower && s.ciUpper) {
      const upper = PCT_KEYS.filter(({ key }) => s.ciUpper![key] > 0).map(({ key, pct }) => `${xPx(toX(s.ciUpper![key])).toFixed(1)},${yPx(pct).toFixed(1)}`);
      const lower = PCT_KEYS.filter(({ key }) => s.ciLower![key] > 0).map(({ key, pct }) => `${xPx(toX(s.ciLower![key])).toFixed(1)},${yPx(pct).toFixed(1)}`).reverse();
      if (upper.length > 1 && lower.length > 1) parts.push(`<polygon points="${[...upper, ...lower].join(' ')}" fill="${s.color}" fill-opacity="0.13" stroke="none" />`);
    }
  }
  for (const s of series) {
    const pts = PCT_KEYS.filter(({ key }) => s.psd[key] > 0 && Number.isFinite(s.psd[key])).map(({ key, pct }) => `${xPx(toX(s.psd[key])).toFixed(1)},${yPx(pct).toFixed(1)}`);
    if (pts.length > 1) parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round"><title>${esc(s.name)}: D16 ${s.psd.D16.toFixed(1)}, D50 ${s.psd.D50.toFixed(1)}, D84 ${s.psd.D84.toFixed(1)} ${unit}</title></polyline>`);
  }
  series.forEach((s, i) => {
    const lx = padL + (i % 2) * (plotW / 2);
    const ly = padT + plotH + 40 + Math.floor(i / 2) * 13;
    parts.push(`<rect x="${lx}" y="${ly - 7}" width="14" height="3" fill="${s.color}" />`);
    parts.push(`<text x="${lx + 18}" y="${ly - 3}" fill="${fg}" font-size="9" font-family="system-ui, sans-serif">${esc(s.name.length > 30 ? `${s.name.slice(0, 29)}…` : s.name)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/** Size distributions of several sites as outlined step histograms on a shared axis (small to large). */
export function renderCompareSizeHistogramSvg(
  series: ReadonlyArray<{ name: string; color: string; hist: SizeHistogram }>,
  lightTheme = false,
): string {
  const W = 400;
  const legendRows = Math.ceil(series.length / 2);
  const H = 190 + legendRows * 13;
  const padL = 38;
  const padR = 12;
  const padT = 24;
  const padB = 40 + legendRows * 13;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';
  const all = series.flatMap((s) => s.hist.bins);
  if (all.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="11" font-family="system-ui, sans-serif">No size distributions to compare</text></svg>`;
  }
  const unit = series[0]!.hist.unit;
  const lo = Math.log2(Math.min(...all.map((b) => b.lo)));
  const hi = Math.log2(Math.max(...all.map((b) => b.hi)));
  const maxPct = Math.max(10, Math.ceil(Math.max(...all.map((b) => b.weightPct)) / 10) * 10);
  const xPx = (d: number): number => padL + ((Math.log2(d) - lo) / Math.max(1e-9, hi - lo)) * plotW;
  const yPx = (pct: number): number => padT + plotH - (pct / maxPct) * plotH;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}" />`);
  parts.push(`<text x="${padL}" y="15" fill="${fg}" font-size="10.5" font-weight="700" font-family="system-ui, sans-serif">Size Distributions (area-weighted %)</text>`);
  for (const f of [0.5, 1]) {
    const y = yPx(maxPct * f);
    parts.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${muted}" stroke-opacity="0.25" />`);
    parts.push(`<text x="${padL - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="${muted}" font-size="8.5" font-family="ui-monospace, monospace">${(maxPct * f).toFixed(0)}%</text>`);
  }
  const edges = [...new Set(all.flatMap((b) => [b.lo, b.hi]).map((v) => +v.toPrecision(6)))].sort((a, b) => a - b);
  const every = Math.max(1, Math.ceil(edges.length / 9));
  edges.forEach((e, i) => {
    if (i % every !== 0) return;
    parts.push(`<text x="${xPx(e).toFixed(1)}" y="${padT + plotH + 12}" text-anchor="middle" fill="${muted}" font-size="8" font-family="ui-monospace, monospace">${e >= 10 ? e.toFixed(0) : e.toPrecision(2)}</text>`);
  });
  for (const s of series) {
    if (s.hist.bins.length === 0) continue;
    const pts: string[] = [];
    const b0 = s.hist.bins[0]!;
    pts.push(`${xPx(b0.lo).toFixed(1)},${yPx(0).toFixed(1)}`);
    for (const b of s.hist.bins) {
      pts.push(`${xPx(b.lo).toFixed(1)},${yPx(b.weightPct).toFixed(1)}`, `${xPx(b.hi).toFixed(1)},${yPx(b.weightPct).toFixed(1)}`);
    }
    pts.push(`${xPx(s.hist.bins[s.hist.bins.length - 1]!.hi).toFixed(1)},${yPx(0).toFixed(1)}`);
    parts.push(`<polyline points="${pts.join(' ')}" fill="${s.color}" fill-opacity="0.08" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="round"><title>${esc(s.name)}</title></polyline>`);
  }
  parts.push(`<text x="${padL + plotW / 2}" y="${padT + plotH + 26}" text-anchor="middle" fill="${muted}" font-size="9.5" font-family="system-ui, sans-serif">Grain size (${unit}${unit === 'mm' ? `, ${series[0]!.hist.step} φ classes` : ''})</text>`);
  series.forEach((s, i) => {
    const lx = padL + (i % 2) * (plotW / 2);
    const ly = padT + plotH + 40 + Math.floor(i / 2) * 13;
    parts.push(`<rect x="${lx}" y="${ly - 7}" width="14" height="3" fill="${s.color}" />`);
    parts.push(`<text x="${lx + 18}" y="${ly - 3}" fill="${fg}" font-size="9" font-family="system-ui, sans-serif">${esc(s.name.length > 30 ? `${s.name.slice(0, 29)}…` : s.name)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

export interface TimeSeriesPoint {
  date: string;
  name: string;
  color: string;
  D16: number;
  D50: number;
  D84: number;
  /** Bootstrap CI of each percentile. */
  ci?: { D16: [number, number]; D50: [number, number]; D84: [number, number] };
  /** Points of the same group (place) are joined by lines; ungrouped points stand alone. */
  group?: string;
  /** Line colour of the group (several places: lines coloured by place). */
  groupColor?: string;
}

/**
 * D16 / D50 / D84 of sites over time, oldest first, with bootstrap CI error bars. The x axis is
 * calendar time; the y axis is log-scaled grain size.
 */
export function renderTimeSeriesSvg(points: readonly TimeSeriesPoint[], unit: 'mm' | 'px', lightTheme = false): string {
  // Points of the same group (place) are joined by lines, in date order.
  const groups = new Map<string, number[]>();
  points.forEach((p, i) => {
    if (p.group === undefined) return;
    const list = groups.get(p.group) ?? [];
    list.push(i);
    groups.set(p.group, list);
  });
  const multiGroup = groups.size > 1;
  const W = 400;
  const H = multiGroup ? 256 : 240;
  const padL = 44;
  const padR = 14;
  const padT = 26;
  const padB = multiGroup ? 62 : 46;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';
  const gridCol = lightTheme ? '#e2e8f0' : '#26323e';
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const font = 'font-family="system-ui, sans-serif"';
  if (points.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="12" ${font}>Give at least one compared site a survey date</text></svg>`;
  }
  const t = points.map((p) => Date.parse(`${p.date}T00:00:00Z`));
  let tMin = Math.min(...t);
  let tMax = Math.max(...t);
  if (tMax - tMin < 864e5) {
    tMin -= 15 * 864e5;
    tMax += 15 * 864e5;
  } else {
    const padT2 = (tMax - tMin) * 0.06;
    tMin -= padT2;
    tMax += padT2;
  }
  const vals: number[] = [];
  for (const p of points) {
    for (const v of [p.D16, p.D50, p.D84, ...(p.ci ? [...p.ci.D16, ...p.ci.D84] : [])]) if (v > 0 && Number.isFinite(v)) vals.push(Math.log10(v));
  }
  if (vals.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${muted}" font-size="12" ${font}>No counted grains in the dated surveys</text></svg>`;
  }
  // Surveys without a value (no counted grains) are not plotted rather than drawn at NaN.
  const has = (v: number): boolean => Number.isFinite(v) && v > 0;
  let yMin = Math.min(...vals);
  let yMax = Math.max(...vals);
  if (yMax - yMin < 0.1) {
    yMin -= 0.1;
    yMax += 0.1;
  }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad;
  yMax += yPad;
  const X = (ms: number): number => padL + ((ms - tMin) / (tMax - tMin)) * plotW;
  const Y = (v: number): number => padT + plotH - ((Math.log10(Math.max(1e-9, v)) - yMin) / (yMax - yMin)) * plotH;
  const series: Array<{ key: 'D16' | 'D50' | 'D84'; color: string; dash: string }> = [
    { key: 'D84', color: '#D55E00', dash: '4 3' },
    { key: 'D50', color: lightTheme ? '#1a202c' : '#e8eef4', dash: '' },
    { key: 'D16', color: '#0072B2', dash: '4 3' },
  ];
  // y ticks at 1-2-5 steps
  const ticksFor = (mults: readonly number[]): number[] => {
    const out: number[] = [];
    for (let e = Math.floor(yMin) - 1; e <= Math.ceil(yMax); e++) {
      for (const m of mults) {
        const lv = Math.log10(m * 10 ** e);
        if (lv >= yMin && lv <= yMax) out.push(m * 10 ** e);
      }
    }
    return out;
  };
  // 1-2-5 steps; finer steps when the size range is narrow.
  let ticks = ticksFor([1, 2, 5]);
  if (ticks.length < 3) ticks = ticksFor([1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9]);
  const fmtTick = (v: number): string => (v >= 1 ? String(Math.round(v * 10) / 10) : v.toPrecision(2));
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);
  parts.push(`<text x="${padL}" y="15" fill="${fg}" font-size="11" font-weight="600" ${font}>Grain size over time</text>`);
  for (const v of ticks) {
    const y = Y(v).toFixed(1);
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${gridCol}" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 4}" y="${y}" dy="3" text-anchor="end" fill="${muted}" font-size="9" ${font}>${fmtTick(v)}</text>`);
  }
  parts.push(`<text transform="translate(11 ${padT + plotH / 2}) rotate(-90)" text-anchor="middle" fill="${muted}" font-size="9" ${font}>Grain size (${unit}, log scale)</text>`);
  // x labels: each point's date (thinned when crowded)
  // Dates in time order, skipping any that would overlap the previous label.
  const labelOrder = points.map((_, i) => i).sort((a, b) => t[a]! - t[b]!);
  let lastLabelX = -Infinity;
  const shown = new Set<string>();
  for (const i of labelOrder) {
    const x = X(t[i]!);
    const d = points[i]!.date;
    if (shown.has(d) || x - lastLabelX < 56) continue;
    shown.add(d);
    lastLabelX = x;
    parts.push(`<text x="${x.toFixed(1)}" y="${padT + plotH + 13}" text-anchor="middle" fill="${muted}" font-size="9" ${font}>${d}</text>`);
  }
  parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="${muted}" stroke-width="1"/>`);
  // One line per group (place); several places: coloured by place, the percentile shown by
  // the line style. Points without a group are not joined to anything.
  for (const s of series) {
    for (const idx of groups.values()) {
      if (idx.length < 2) continue;
      const ordered = [...idx].filter((i) => has(points[i]![s.key])).sort((a, b) => t[a]! - t[b]!);
      if (ordered.length < 2) continue;
      const pts = ordered.map((i) => `${X(t[i]!).toFixed(1)},${Y(points[i]![s.key]).toFixed(1)}`).join(' ');
      const stroke = multiGroup ? (points[ordered[0]!]!.groupColor ?? s.color) : s.color;
      const dash = multiGroup ? (s.key === 'D50' ? '' : s.key === 'D16' ? '4 3' : '1 3') : s.dash;
      parts.push(`<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${s.key === 'D50' ? 2 : 1.3}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`);
    }
    points.forEach((p, i) => {
      const x = X(t[i]!);
      const ci = p.ci?.[s.key];
      if (ci && ci[0] > 0 && ci[1] > 0) {
        parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${Y(ci[0]).toFixed(1)}" y2="${Y(ci[1]).toFixed(1)}" stroke="${multiGroup ? (p.groupColor ?? muted) : s.color}" stroke-width="1.2"/>`);
      }
      if (!has(p[s.key])) return;
      const mark = multiGroup ? (p.groupColor ?? muted) : s.color;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${Y(p[s.key]).toFixed(1)}" r="${s.key === 'D50' ? 3.5 : 2.5}" fill="${p.color}" stroke="${mark}" stroke-width="1.2"><title>${esc(p.name)} (${p.date}): ${s.key} ${p[s.key].toFixed(1)} ${unit}</title></circle>`);
    });
  }
  // legend
  const ly = H - 10;
  series
    .slice()
    .reverse()
    .forEach((s, i) => {
      const lx = padL + i * 82;
      const dash = multiGroup ? (s.key === 'D50' ? '' : s.key === 'D16' ? '4 3' : '1 3') : s.dash;
      parts.push(`<line x1="${lx}" x2="${lx + 16}" y1="${ly - 3}" y2="${ly - 3}" stroke="${multiGroup ? fg : s.color}" stroke-width="${s.key === 'D50' ? 2 : 1.3}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`);
      parts.push(`<text x="${lx + 20}" y="${ly}" fill="${fg}" font-size="9" ${font}>${s.key}</text>`);
    });
  parts.push(`<text x="${W - padR}" y="${ly}" text-anchor="end" fill="${muted}" font-size="9" ${font}>bars: bootstrap CI</text>`);
  if (multiGroup) {
    let gx = padL;
    for (const [g, idx] of groups) {
      const c = points[idx[0]!]!.groupColor ?? fg;
      const label = g.length > 22 ? `${g.slice(0, 21)}…` : g;
      parts.push(`<rect x="${gx}" y="${H - 34}" width="9" height="9" fill="${c}"/>`);
      parts.push(`<text x="${gx + 12}" y="${H - 26}" fill="${fg}" font-size="9" ${font}>${esc(label)}</text>`);
      gx += 20 + label.length * 5;
      if (gx > W - 60) break;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="D16, D50 and D84 of the compared surveys by date, one line per place">${parts.join('')}</svg>`;
}


/** Size-class composition (sand / gravel / cobble / boulder, % of the PSD weight) per site, as stacked bars. */
export function renderCompositionBarsSvg(
  series: ReadonlyArray<{ name: string; color: string; w: { sandPct: number; gravelPct: number; cobblePct: number; boulderPct: number } }>,
  lightTheme = false,
): string {
  const rowH = 22;
  const padL = 110;
  const padR = 14;
  const padT = 28;
  const W = 400;
  const H = padT + series.length * rowH + 34;
  const plotW = W - padL - padR;
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const font = 'font-family="system-ui, sans-serif"';
  const classes: Array<{ key: 'sandPct' | 'gravelPct' | 'cobblePct' | 'boulderPct'; label: string; fill: string }> = [
    { key: 'sandPct', label: 'Sand (< 2 mm)', fill: '#F0E442' },
    { key: 'gravelPct', label: 'Gravel (2–64)', fill: '#E69F00' },
    { key: 'cobblePct', label: 'Cobble (64–256)', fill: '#56B4E9' },
    { key: 'boulderPct', label: 'Boulder (≥ 256)', fill: '#0072B2' },
  ];
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="${bg}"/>`];
  parts.push(`<text x="${padL}" y="15" fill="${fg}" font-size="11" font-weight="600" ${font}>Size-class composition (% of the distribution)</text>`);
  series.forEach((s, i) => {
    const y = padT + i * rowH;
    const label = s.name.length > 18 ? `${s.name.slice(0, 17)}…` : s.name;
    parts.push(`<rect x="4" y="${y + 6}" width="8" height="8" fill="${s.color}"/>`);
    parts.push(`<text x="16" y="${y + 14}" fill="${fg}" font-size="9.5" ${font}>${esc(label)}</text>`);
    let x = padL;
    for (const c of classes) {
      const v = Math.max(0, s.w[c.key]);
      const w = (v / 100) * plotW;
      if (w > 0) {
        parts.push(`<rect x="${x.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="${rowH - 7}" fill="${c.fill}"><title>${esc(s.name)}: ${c.label} ${v.toFixed(1)}%</title></rect>`);
        if (w > 26) parts.push(`<text x="${(x + w / 2).toFixed(1)}" y="${y + 14}" text-anchor="middle" fill="#1a202c" font-size="8.5" ${font}>${v.toFixed(0)}%</text>`);
      }
      x += w;
    }
  });
  const ly = H - 12;
  classes.forEach((c, i) => {
    const lx = 8 + i * 98;
    parts.push(`<rect x="${lx}" y="${ly - 8}" width="9" height="9" fill="${c.fill}"/>`);
    parts.push(`<text x="${lx + 12}" y="${ly}" fill="${muted}" font-size="8.5" ${font}>${c.label}</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Size-class composition by site">${parts.join('')}</svg>`;
}

/** Grain shape (b/a aspect ratio, % of grains per 0.1 bin) of several sites, overlaid. */
export function renderCompareAspectRatioSvg(
  series: ReadonlyArray<{ name: string; color: string; counts: readonly number[] }>,
  lightTheme = false,
): string {
  const W = 400;
  const legendRows = Math.ceil(series.length / 2);
  const H = 190 + legendRows * 13;
  const padL = 38;
  const padR = 12;
  const padT = 24;
  const padB = 36 + legendRows * 13;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const fg = lightTheme ? '#1a202c' : '#e8eef4';
  const muted = lightTheme ? '#4a5568' : '#8fa0b2';
  const gridCol = lightTheme ? '#e2e8f0' : '#26323e';
  const bg = lightTheme ? '#ffffff' : '#0c1014';
  const font = 'font-family="system-ui, sans-serif"';
  const pct = series.map((s) => {
    const n = s.counts.reduce((a, b) => a + b, 0);
    return s.counts.map((c) => (n > 0 ? (c / n) * 100 : 0));
  });
  const yMax = Math.max(10, ...pct.flat()) * 1.1;
  const X = (bin: number): number => padL + ((bin + 0.5) / 10) * plotW;
  const Y = (v: number): number => padT + plotH - (v / yMax) * plotH;
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="${bg}"/>`];
  parts.push(`<text x="${padL}" y="15" fill="${fg}" font-size="11" font-weight="600" ${font}>Grain shape: aspect ratio b/a (% of grains)</text>`);
  for (let v = 0; v <= yMax; v += yMax > 40 ? 20 : 10) {
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${gridCol}"/>`);
    parts.push(`<text x="${padL - 4}" y="${Y(v).toFixed(1)}" dy="3" text-anchor="end" fill="${muted}" font-size="9" ${font}>${v}</text>`);
  }
  for (let b = 0; b <= 10; b += 2) {
    parts.push(`<text x="${(padL + (b / 10) * plotW).toFixed(1)}" y="${padT + plotH + 12}" text-anchor="middle" fill="${muted}" font-size="9" ${font}>${(b / 10).toFixed(1)}</text>`);
  }
  parts.push(`<text x="${padL + plotW / 2}" y="${padT + plotH + 24}" text-anchor="middle" fill="${muted}" font-size="9" ${font}>b/a (1 = round outline, small = elongated)</text>`);
  series.forEach((s, i) => {
    const pts = pct[i]!.map((v, b) => `${X(b).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"><title>${esc(s.name)}</title></polyline>`);
    const lx = padL + (i % 2) * 180;
    const ly = padT + plotH + 38 + Math.floor(i / 2) * 13;
    parts.push(`<line x1="${lx}" x2="${lx + 14}" y1="${ly - 3}" y2="${ly - 3}" stroke="${s.color}" stroke-width="2"/>`);
    parts.push(`<text x="${lx + 18}" y="${ly}" fill="${fg}" font-size="9" ${font}>${esc(s.name.length > 30 ? `${s.name.slice(0, 29)}…` : s.name)}</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Aspect ratio distributions by site">${parts.join('')}</svg>`;
}
