/** Results panel (This photo / Whole site): summary, settings, PSD, adequacy, shape and fabric tabs. */
import { computeFabricRoseStats } from '../../modules/morphometricsExt.js';
import { aspectRatioCounts, sizeHistogramFromWentworth } from '../../modules/histograms.js';
import { computeEffectiveDetectionLimit, getPhotoQualityWarnings } from '../../modules/photoQuality.js';
import {
  renderAspectRatioHistogramSvg,
  renderConvergenceChartSvg,
  renderFabricRoseSvg,
  renderJackknifeChartSvg,
  renderPsdChartSvg,
  renderSizeHistogramSvg,
} from '../charts.js';
import { helpButton } from '../help.js';
import type { AppState, DashboardTab } from '../state.js';
import type { SiteAnalysisReport } from '../../modules/siteTypes.js';
import { getActivePhoto } from '../workspaceActions.js';
import { scopeButtonsHtml } from './compare.js';
import { chartBoxFor, esc, type ChartRegistry } from './html.js';
import { photoCutoffs } from '../../modules/siteWorkspace.js';
import { adequacyCapNote } from '../../modules/siteAdequacy.js';
import { DEFAULT_POSTPROCESS_OPTIONS } from '../../modules/postprocessCore.js';

/** Shown after the site interval, so an approximate or missing interval is never read as precise. */
const CI_STATUS_NOTE: Record<SiteAnalysisReport['ciStatus'], string> = {
  ok: '',
  'few-photos': ' · approximate (fewer than 5 photos)',
  'single-photo': ' · one photo: counting only',
  degenerate: ' · photos identical?',
  'no-grains': ' · no grains counted',
};

export interface DashboardView {
  lightTheme: boolean;
  /** Filled with this render's charts, for the SVG/PNG download buttons. */
  charts: ChartRegistry;
}

/** What the site histogram's percentages are, for the pooling mode (see siteAnalysis.ts). */
export function histogramBasis(mode: string | undefined): string {
  return mode === 'number-weighted' ? '% by grain count' : mode === 'virtual-wolman-grid' ? '% of grid points' : 'area-weighted %';
}

export function renderDashboardHtml(state: AppState, view: DashboardView): string {
  const chartBox = chartBoxFor(view.charts);
  const report = state.siteReport;
  const single = state.singlePhotoStats;
  const activePhoto = getActivePhoto(state);
  const activeSession = activePhoto ? state.sessions.get(activePhoto.photoId) ?? null : null;
  const isSite = state.dashboardScope === 'site';
  const lightTheme = view.lightTheme;

  const activeMetric = state.siteOptions.sizeMetric ?? 'bAxis';
  const psd = isSite
    ? report?.psd
    : activeMetric === 'minFeret'
      ? single?.areaWeightedMinFeret ?? single?.areaWeightedB
      : activeMetric === 'dEq'
        ? single?.areaWeightedDEq
        : single?.areaWeightedB;
  const unit = isSite ? (report?.unit ?? 'px') : (single?.unit ?? 'px');
  const fw = isSite ? report?.folkWard : single?.folkWard;
  const basisLabel = isSite
    ? report?.statisticalBasisLabel ??
      (state.siteReportError
        ? `Site statistics unavailable: ${state.siteReportError}`
        : 'Add & analyze photos to compute site statistics')
    : 'Single-Photo Area-Weighted (Grid-by-Number Equivalent)';

  // Compute effective pixel detection limit for the current view.
  const detectionLimitInfo = (() => {
    if (!psd) return null;
    if (isSite && report) {
      // The engine's per-photo detection limits (the ones behind the common cutoff).
      let maxVal = 0;
      for (const p of report.perPhoto) {
        if (p.detectionLimitPx === undefined) continue;
        const v = unit === 'mm' ? (p.mmPerPx !== undefined ? p.detectionLimitPx * p.mmPerPx : 0) : p.detectionLimitPx;
        if (v > maxVal) maxVal = v;
      }
      // The site's common mm cutoff includes the Field-count cutoff: show the larger one.
      const applied = unit === 'mm' && report.dCutoffCommonMm !== null && report.dCutoffCommonMm > maxVal ? report.dCutoffCommonMm : maxVal;
      if (applied <= 0) return null;
      return {
        value: applied,
        unit,
        nearD5: Number.isFinite(psd.D5) && psd.D5 > 0 && psd.D5 <= applied * 1.25,
        nearD16: Number.isFinite(psd.D16) && psd.D16 > 0 && psd.D16 <= applied * 1.5,
        raisedNote: applied > maxVal && maxVal > 0 ? ` (the photos resolve ~${maxVal.toFixed(1)} mm; raised to the lower size cutoff)` : '',
      };
    }
    if (!isSite && activeSession) {
      const prov = activeSession.getProvenance();
      const own = computeEffectiveDetectionLimit(
        {
          minSizeWorkingPx: prov?.postProcess?.minSize ?? DEFAULT_POSTPROCESS_OPTIONS.minSize,
          effectiveScaleFactor: activeSession.workingImage.effectiveScaleFactor,
          minBaxisPx: state.siteOptions.minBaxisPx,
          mmPerPx: unit === 'mm' ? activePhoto?.calibration?.mmPerPx : undefined,
        },
        psd,
      );
      // The mm cutoff actually applied to this photo can be larger than its own detection limit:
      // the site's common cutoff (a coarser photo's limit) or the field-count cutoff.
      const appliedMm = photoCutoffs(state.siteOptions, report, activePhoto?.photoId).minSizeMm;
      if (own && own.unit === 'mm' && appliedMm > own.value) {
        const fieldMm = state.siteOptions.minSizeMm ?? 0;
        return {
          value: appliedMm,
          unit: 'mm' as const,
          nearD5: Number.isFinite(psd.D5) && psd.D5 > 0 && psd.D5 <= appliedMm * 1.25,
          nearD16: Number.isFinite(psd.D16) && psd.D16 > 0 && psd.D16 <= appliedMm * 1.5,
          raisedNote:
            appliedMm > fieldMm
              ? ` (this photo alone resolves ~${own.value.toFixed(1)} mm; raised to the site's common cutoff, set by a coarser photo, so all photos count the same size range)`
              : ` (this photo alone resolves ~${own.value.toFixed(1)} mm; raised to the Field-count cutoff)`,
        };
      }
      return own;
    }
    return null;
  })();

  const activePhotoWarnings = !isSite ? getPhotoQualityWarnings(activePhoto?.metadata) : [];

  let tabContent = '';
  if (state.dashboardTab === 'psd') {
    const psdSvg = (light: boolean): string => psd
      ? renderPsdChartSvg({
          psd,
          unit,
          xAxis: state.psdXAxis,
          title: isSite ? 'Pooled Site Cumulative PSD' : 'Active Photo Cumulative PSD',
          subtitle: isSite && report ? `${report.includedPhotoCount} photos, n=${report.validGrainCount}` : undefined,
          ...(isSite && report ? { ciLevel: report.bootstrapCi.confidenceLevel } : {}),
          ciLower: isSite ? report?.bootstrapCi.lower : undefined,
          ciUpper: isSite ? report?.bootstrapCi.upper : undefined,
          perPhotoCurves: isSite ? report?.perPhoto : undefined,
          detectionLimit: detectionLimitInfo?.value,
          lightTheme: light,
        })
      : `<svg viewBox="0 0 400 220" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="220" fill="${light ? '#ffffff' : '#0c1014'}"/><text x="200" y="110" text-anchor="middle" fill="${light ? '#4a5568' : '#8fa0b2'}" font-size="12" font-family="system-ui, sans-serif">No segmented grains yet</text></svg>`;

    const step: 0.5 | 1 = state.histogramStepPhi === 0.5 ? 0.5 : 1;
    const sizeHist = isSite
      ? sizeHistogramFromWentworth((step === 0.5 ? report?.wentworthHistogram05Phi : report?.wentworthHistogram10Phi) ?? [], step)
      : activeSession
        ? activeSession.getSizeHistogram(step, activeMetric, photoCutoffs(state.siteOptions, report, activePhoto?.photoId))
        : sizeHistogramFromWentworth([], step);
    const detectionNoteHtml = detectionLimitInfo
      ? `<div class="${detectionLimitInfo.nearD16 || detectionLimitInfo.nearD5 ? 'warning-banner' : 'field-hint'}" style="margin-top:6px;">
          Smallest grain kept (detection limit): <strong>~${detectionLimitInfo.value.toFixed(detectionLimitInfo.unit === 'mm' ? 1 : 0)} ${detectionLimitInfo.unit}</strong>${'raisedNote' in detectionLimitInfo ? esc(detectionLimitInfo.raisedNote) : ''}${
            detectionLimitInfo.nearD16
              ? ' — fine tail (D16) is close to the resolution floor; consider a closer photo or a Field-count cutoff.'
              : detectionLimitInfo.nearD5
                ? ' — D5 is close to the resolution floor.'
                : ''
          } <span class="stats-note">Grains up to a few times this size are partly missed, so the finest percentiles lean coarse; for a reliable fine tail set the Field-count cutoff to about 3× this size.</span>
        </div>`
      : '';
    const activeEnh = !isSite ? activePhoto?.metadata?.enhancement : undefined;
    const enhBannerHtml = activeEnh
      ? `<div class="basis-banner row-between" style="margin-top:6px;gap:8px;">
          <span>Enhanced with <strong>${esc(activeEnh.modelName)}</strong> — inspect outlines against the unenhanced photo.</span>
          ${activePhoto?.originalBackup ? `<button type="button" class="btn btn-sm" data-action="enhance-revert" ${state.batchRunning || state.enhancing ? 'disabled' : ''}>Revert</button>` : ''}
        </div>`
      : '';
    const photoWarnHtml = activePhotoWarnings
      .map(
        (w) =>
          `<div class="warning-banner" style="margin-top:6px;">${esc(w.message)}${
            w.kind === 'blur' && !activeEnh
              ? `<div style="margin-top:6px;"><button type="button" class="btn btn-sm" data-action="enhance-deblur" ${state.batchRunning || state.enhancing ? 'disabled' : ''}>Try Deblur (built-in, instant)</button></div>`
              : ''
          }</div>`,
      )
      .join('');
    const downscaleBannerHtml =
      !isSite && activeSession && activeSession.workingImage.effectiveScaleFactor < 0.3
        ? `<div class="warning-banner" style="margin-top:6px;">
            This large photo (${activeSession.workingImage.originalWidth}×${activeSession.workingImage.originalHeight} px) was scaled down to <strong>${Math.round(activeSession.workingImage.effectiveScaleFactor * 100)}%</strong> (${activeSession.workingImage.width}×${activeSession.workingImage.height} px) for analysis, which can miss smaller pebbles. Try setting <strong>Image scale</strong> to <code>0.5×</code> or <code>1.0×</code> (or crop an orthomosaic into tiles) and re-running.
          </div>`
        : '';
    tabContent = `
      ${enhBannerHtml}
      ${downscaleBannerHtml}
      ${photoWarnHtml}
      <div class="row-between" style="margin-top:8px;">
        <div class="row">${
          // φ needs sizes in mm: no axis choice for an uncalibrated (pixel) distribution.
          unit === 'mm'
            ? `
          <button type="button" class="btn btn-sm ${state.psdXAxis === 'mm' ? 'active' : ''}" aria-pressed="${state.psdXAxis === 'mm' ? 'true' : 'false'}" data-psd-x="mm">mm (log₁₀)</button>
          <button type="button" class="btn btn-sm ${state.psdXAxis === 'phi' ? 'active' : ''}" aria-pressed="${state.psdXAxis === 'phi' ? 'true' : 'false'}" data-psd-x="phi">phi (φ)</button>`
            : ''
        }
        </div>
        ${
          isSite && report
            ? `<span style="font-size:0.65rem;color:var(--text-secondary);">${Math.round(report.bootstrapCi.confidenceLevel * 100)}% CI (D50): ${
                Number.isFinite(report.bootstrapCi.lower.D50) && Number.isFinite(report.bootstrapCi.upper.D50)
                  ? `[${report.bootstrapCi.lower.D50.toFixed(1)}, ${report.bootstrapCi.upper.D50.toFixed(1)}] ${unit}`
                  : 'not available'
              }${CI_STATUS_NOTE[report.ciStatus]}</span>`
            : ''
        }
      </div>
      ${chartBox('cumulative-psd', 'Cumulative grain-size distribution', psdSvg, lightTheme)}
      ${detectionNoteHtml}
      <div class="row" style="margin-top:8px;">
        <button type="button" class="btn btn-sm ${step === 0.5 ? 'active' : ''}" aria-pressed="${step === 0.5 ? 'true' : 'false'}" data-phi-step="0.5">Narrow classes (${unit === 'mm' ? '0.5 φ' : '×√2'})</button>
        <button type="button" class="btn btn-sm ${step === 1 ? 'active' : ''}" aria-pressed="${step === 1 ? 'true' : 'false'}" data-phi-step="1.0">Wide classes (${unit === 'mm' ? '1 φ' : '×2'})</button>
      </div>
      ${chartBox('size-distribution', 'Grain-size distribution histogram', (light) => renderSizeHistogramSvg(sizeHist, light, isSite ? `Site Size Distribution (${histogramBasis(state.siteOptions.poolingMode)})` : 'Photo Size Distribution (area-weighted %)'), lightTheme)}
      ${
        fw
          ? `<div class="stat-grid" style="margin-top:8px;">
              <div class="stat-card"><div class="stat-label">Folk &amp; Ward Mean</div><div class="stat-value">${fw.meanMm.toFixed(1)} mm</div><div class="stat-sub">${fw.meanPhi.toFixed(2)} φ</div></div>
              <div class="stat-card"><div class="stat-label">Sorting (σ_I)</div><div class="stat-value">${fw.sortingPhi.toFixed(2)} φ</div><div class="stat-sub">${esc(fw.sortingLabel)}</div></div>
              <div class="stat-card"><div class="stat-label">Skew / Kurt</div><div class="stat-value">${Number.isFinite(fw.skewnessPhi) ? fw.skewnessPhi.toFixed(2) : '—'}</div><div class="stat-sub">${esc(fw.skewnessLabel)} · K=${Number.isFinite(fw.kurtosisPhi) ? fw.kurtosisPhi.toFixed(2) : '—'} (${esc(fw.kurtosisLabel)})</div></div>
            </div>`
          : ''
      }
      ${(() => {
        const x = isSite ? report?.extra ?? null : single?.extra ?? null;
        if (!x || x.n === 0) return '';
        const v = (n: number | null, d = 1): string => (n === null || !Number.isFinite(n) ? '—' : n.toFixed(d));
        const row = (label: string, val: string, note: string): string =>
          `<tr><th scope="row">${label}<span class="stats-note">${note}</span></th><td>${val}</td></tr>`;
        return `<details class="advanced-block more-stats" style="margin-top:8px;" data-keep-open="more-stats">
          <summary>More statistics <span class="summary-note">Sauter mean ${v(x.sauterMeanD32)} ${unit} · Dg ${v(x.geometricMean)} ${unit}</span></summary>
          <table class="stats-table">
            <tbody>
              ${row('Sauter mean D[3,2]', `${v(x.sauterMeanD32)} ${unit}`, 'Σd³/Σd² (sphere-equivalent area-weighted mean)')}
              ${row('De Brouckère mean D[4,3]', `${v(x.deBrouckereMeanD43)} ${unit}`, 'Σd⁴/Σd³, each grain once')}
              ${row('Arithmetic mean D[1,0]', `${v(x.arithmeticMeanD10)} ${unit}`, 'each grain once')}
              ${row('Geometric mean Dg', `${v(x.geometricMean)} ${unit}`, 'same weighting as the PSD')}
              ${row('Geometric SD σg', v(x.geometricSd, 2), '1 = uniform; larger = wider spread')}
              ${row('D30 / D60 / D65', `${v(x.D30)} / ${v(x.D60)} / ${v(x.D65)} ${unit}`, 'D65: Einstein roughness')}
              ${row('Uniformity Cu', v(x.uniformityCu, 2), 'D60/D10')}
              ${row('Curvature Cc', v(x.curvatureCc, 2), 'D30²/(D10·D60)')}
              ${row('Trask sorting So', v(x.traskSorting, 2), '√(D75/D25)')}
              ${row('Span', v(x.span, 2), '(D90−D10)/D50')}
              ${row('Fredle index', v(x.fredleIndex, 1), 'Dg/So (spawning-gravel quality)')}
              ${
                x.momentMeanPhi !== null
                  ? row('Moments (φ)', `${v(x.momentMeanPhi, 2)} / ${v(x.momentSortingPhi, 2)} / ${v(x.momentSkewness, 2)} / ${v(x.momentKurtosis, 2)}`, 'mean / sorting / skewness / kurtosis (method of moments)')
                  : ''
              }
            </tbody>
          </table>
          <p class="field-hint">Included in the summary CSV and JSON exports. ${helpButton('moreStats')}</p>
        </details>`;
      })()}
    `;
  } else if (state.dashboardTab === 'adequacy') {
    const adeq = report?.adequacy;

    tabContent = `
      ${!isSite ? '<p class="field-hint" style="margin-top:8px;">Sample adequacy is a property of the whole site (all included photos), so this tab shows the site.</p>' : ''}
      ${
        adeq
          ? `<div class="stat-grid" style="margin-top:8px;">
              <div class="stat-card"><div class="stat-label">Adequacy</div><div class="stat-value">${esc(adeq.rating)}</div><div class="stat-sub">n_eff = ${Math.round(adeq.effectiveGrainCount)} (100/200/400)${adeq.limitedByPhotoCount ? `<br>${esc(adequacyCapNote(true, report?.includedPhotoCount ?? 0))}` : ''}</div></div>
              <div class="stat-card"><div class="stat-label">Max Clast Ratio</div><div class="stat-value">${(adeq.largestClastAreaRatio * 100).toFixed(1)}%</div><div class="stat-sub">${adeq.largestClastWarning === 'none' ? 'OK (<5%)' : esc(adeq.largestClastWarning.toUpperCase())}</div></div>
              <div class="stat-card"><div class="stat-label">Cutoff (mm)</div><div class="stat-value">${report?.dCutoffCommonMm !== null && report?.dCutoffCommonMm !== undefined ? report.dCutoffCommonMm.toFixed(2) : '—'}</div><div class="stat-sub">${report?.excludedTruncationCount ?? 0} trunc excl</div></div>
            </div>`
          : ''
      }
      ${chartBox('convergence', 'D50 convergence with number of photos', (light) => renderConvergenceChartSvg(report?.convergence ?? [], light, report?.bootstrapCi.confidenceLevel), lightTheme)}
      ${chartBox('jackknife', 'Leave-one-photo-out influence on D50', (light) => renderJackknifeChartSvg(report?.jackknife ?? null, light), lightTheme)}
    `;
  } else if (state.dashboardTab === 'shape') {
    const cutoffs = photoCutoffs(state.siteOptions, report, activePhoto?.photoId);
    // Whole site: every pooled grain once. This photo: the same grains as its statistics (inside
    // the ROI, border rule and cutoffs applied), so n matches.
    const siteShape = isSite ? report?.shape ?? null : null;
    const ratios = !isSite && activeSession
      ? activeSession.getExtendedStatsGrains(activeMetric, cutoffs).map((g) => g.aspectRatio)
      : [];
    const arCounts = siteShape ? siteShape.aspectRatioCounts : aspectRatioCounts(ratios, 10);
    const packingInfo = !isSite && activeSession ? activeSession.getRoiFilterResult() : null;

    tabContent = `
      ${
        packingInfo
          ? `<div class="basis-banner" style="margin-top:8px;">Clast packing: ${packingInfo.clastPackingPct.toFixed(1)}% · Exposed matrix: ${packingInfo.exposedMatrixPct.toFixed(1)}% (inside the ROI)</div>`
          : ''
      }
      ${chartBox('aspect-ratio', 'Aspect ratio (b/a) distribution', (light) => renderAspectRatioHistogramSvg(arCounts, light), lightTheme)}
      <p class="field-hint">${isSite ? `Grain shape of the whole site (every counted grain once, n = ${siteShape?.n ?? 0}).` : 'Grain shape for this photo.'} The size distribution is on the PSD tab.</p>
    `;
  } else {
    const cutoffs = photoCutoffs(state.siteOptions, report, activePhoto?.photoId);
    const rose =
      isSite && report
        ? report.fabricRose
        : activeSession
          ? activeSession.getFabricRose(activeMetric, cutoffs)
          : computeFabricRoseStats([], { weighted: true, binCount: 12 });
    tabContent = `
      ${chartBox('fabric-rose', 'Grain orientation (fabric) rose', (light) => renderFabricRoseSvg(rose, light), lightTheme)}
      ${
        rose.grainCount > 0
          ? `<div class="stat-grid" style="margin-top:8px;">
              <div class="stat-card"><div class="stat-label">Mean orientation</div><div class="stat-value">${rose.meanAxialDeg.toFixed(0)}°</div><div class="stat-sub">0° = up–down in the photo, counter-clockwise</div></div>
              <div class="stat-card"><div class="stat-label">Alignment (R)</div><div class="stat-value">${rose.resultantLength.toFixed(2)}</div><div class="stat-sub">0 = random, 1 = all parallel</div></div>
              <div class="stat-card"><div class="stat-label">Rayleigh p</div><div class="stat-value">${rose.rayleighP === null ? '—' : rose.rayleighP < 0.001 ? '&lt;0.001' : rose.rayleighP.toFixed(3)}</div><div class="stat-sub">${rose.rayleighP === null ? 'too few grains to test' : rose.rayleighP < 0.05 ? 'preferred direction' : 'no clear direction'} · n = ${rose.grainCount}</div></div>
            </div>`
          : ''
      }
      <div class="basis-banner">
        Axial 180° double-angle statistics (Curray 1956; Mardia &amp; Jupp 2000). 0° = Image Vertical (Top/Bottom), 90° = Image Horizontal.
      </div>
    `;
  }


  const metricNoteText =
    activeMetric === 'minFeret'
      ? 'Size metric: minimum Feret (rotating-calipers) width of the pixel-edge convex hull — closest 2D analogue of a caliper b-axis.'
      : activeMetric === 'dEq'
        ? "Size metric: equal-area circle diameter (d_eq = sqrt(4*Area/pi)) of each grain's visible 2D outline."
        : "Size metric: minor axis of the moment-equivalent ellipse of each grain's visible outline — not a sieve or caliper b-axis.";

  return `
    <div class="panel-section">
      <div class="row-between" style="margin-bottom:6px;">
        <span class="panel-title">Results</span>
        <div class="row">
          ${scopeButtonsHtml(state.dashboardScope)}
        </div>
      </div>
      <div class="basis-banner">${esc(basisLabel)}${(() => {
        if (isSite && report) {
          const excl = report.excludedTruncationCount > 0 ? ` (${report.excludedTruncationCount} below cutoff)` : '';
          return ` · n = ${report.validGrainCount}${excl}`;
        }
        if (!isSite && single) {
          const parts: string[] = [];
          if ((single.excludedCutoffGrains ?? 0) > 0) parts.push(`${single.excludedCutoffGrains} below cutoff`);
          if (single.excludedBorderGrains > 0) parts.push(`${single.excludedBorderGrains} edge`);
          const roiExcl = activeSession ? activeSession.getRoiExcludedGrainCount() : 0;
          if (roiExcl > 0) parts.push(`${roiExcl} excluded by ROI`);
          return ` · n = ${single.includedGrains}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
        }
        return '';
      })()}</div>
      ${(() => {
        const warns = [...(isSite ? report?.warnings ?? [] : single?.warnings ?? [])];
        // ROI enlarged after an analysis that skipped tiles outside the old ROI.
        const stale = (isSite ? state.photos.filter((p) => p.included) : activePhoto ? [activePhoto] : [])
          .map((p) => ({ p, f: state.sessions.get(p.photoId)?.getUnanalysedRoiFraction() ?? 0 }))
          .filter((x) => x.f > 0.001);
        if (stale.length > 0) {
          warns.unshift(
            isSite
              ? `${stale.length} photo(s) have ROI areas that were not analysed (the ROI was enlarged or an exclusion removed after analysis): ${stale.map((x) => x.p.label).join(', ')}. Re-analyse them.`
              : `${(stale[0]!.f * 100).toFixed(1)}% of this photo's ROI was not analysed (the ROI was enlarged or an exclusion removed after analysis). Re-analyse this photo to include it.`,
          );
        }
        return warns.length > 0
          ? `<div class="warning-banner" role="alert">${warns.map(esc).join('<br/>')}</div>`
          : '';
      })()}
      ${(() => {
        if (isSite || !activeSession || !activePhoto) return '';
        const hint = activeSession.getFineGrainHint();
        if (hint.enlarged !== null) {
          return `<div class="basis-banner row-between" style="gap:8px;">
            <span>Analysed enlarged ×${hint.enlarged} for fine grains.</span>
            <button type="button" class="btn btn-sm" data-action="fine-grain-undo" ${state.batchRunning ? 'disabled' : ''}>Undo</button>
          </div>`;
        }
        if (!hint.suggest) return '';
        return `<div class="info-banner">
          <strong>Fine grains detected</strong> (median about ${hint.medianWorkingBPx!.toFixed(0)} px). U-Net finds more of them with a temporary ×1.5 bilinear enlargement during inference (unlike the toolbar's AI 2× Upscale, it does not modify your photo): in testing on 40 photos this improved outlines with no site getting worse, taking about 1.5–2× as long. ${helpButton('fineGrainUpscale')}
          <div style="margin-top:6px;"><button type="button" class="btn btn-sm btn-primary" data-action="fine-grain-rerun" ${state.batchRunning ? 'disabled' : ''}>Re-analyse enlarged ×1.5</button></div>
        </div>`;
      })()}
      <div class="stat-grid" style="margin-top:8px;">
        <div class="stat-card"><div class="stat-label">D<sub>16</sub></div><div class="stat-value">${psd && Number.isFinite(psd.D16) ? psd.D16.toFixed(1) : '—'}</div><div class="stat-sub">${unit}</div></div>
        <div class="stat-card"><div class="stat-label">D<sub>50</sub> (median)</div><div class="stat-value">${psd && Number.isFinite(psd.D50) ? psd.D50.toFixed(1) : '—'}</div><div class="stat-sub">${unit}</div></div>
        <div class="stat-card"><div class="stat-label">D<sub>84</sub></div><div class="stat-value">${psd && Number.isFinite(psd.D84) ? psd.D84.toFixed(1) : '—'}</div><div class="stat-sub">${unit}</div></div>
      </div>
      <p class="metric-note">${esc(metricNoteText)}</p>
      <details class="advanced-block stats-settings" style="margin-top:8px;" data-keep-open="stats-settings">
        <summary>Statistics settings <span class="summary-note">${({ 'physical-area': 'area-weighted', 'equal-photo': 'equal-photo', 'virtual-wolman-grid': 'Wolman grid', 'number-weighted': 'number-weighted', 'facies-weighted': 'facies-weighted' } as Record<string, string>)[state.siteOptions.poolingMode] ?? state.siteOptions.poolingMode} · ${activeMetric === 'bAxis' ? 'b-axis' : activeMetric}</span></summary>
        <div style="margin-top:6px;">
        <div class="field-hint" style="margin-bottom:6px;">Cutoffs apply live to both This photo and Whole site without re-analysing; pooling applies to Whole site (one photo's statistics are always area-weighted).</div>
      <div class="grid-2">
        <label class="field-label">
          <span class="label-row">Pooling Mode ${helpButton('poolingMode')}</span>
          <select class="select" data-site-opt="poolingMode">
            <option value="physical-area" ${state.siteOptions.poolingMode === 'physical-area' ? 'selected' : ''}>Physical Area-Weighted</option>
            <option value="equal-photo" ${state.siteOptions.poolingMode === 'equal-photo' ? 'selected' : ''}>Equal-Photo Weighted</option>
            <option value="virtual-wolman-grid" ${state.siteOptions.poolingMode === 'virtual-wolman-grid' ? 'selected' : ''}>Virtual Wolman Grid</option>
            <option value="number-weighted" ${state.siteOptions.poolingMode === 'number-weighted' ? 'selected' : ''}>Number-Weighted</option>
            <option value="facies-weighted" ${state.siteOptions.poolingMode === 'facies-weighted' ? 'selected' : ''}>Facies-Weighted</option>
          </select>
        </label>
        <label class="field-label">
          <span class="label-row">Size Metric ${helpButton('sizeMetric')}</span>
          <select class="select" data-site-opt="sizeMetric">
            <option value="bAxis" ${activeMetric === 'bAxis' ? 'selected' : ''}>b-axis (ellipse minor)</option>
            <option value="minFeret" ${activeMetric === 'minFeret' ? 'selected' : ''}>min-Feret (caliper width)</option>
            <option value="dEq" ${activeMetric === 'dEq' ? 'selected' : ''}>d_eq (equal-area circle)</option>
          </select>
        </label>
        <label class="field-label">
          <span class="label-row">Field-count cutoff (mm) ${helpButton('minSizeMm')}</span>
          <input class="input" type="number" step="0.5" min="0" max="256" value="${state.siteOptions.minSizeMm ?? 0}" data-site-opt="minSizeMm" />
        </label>
        <label class="field-label">
          <span class="label-row">Min b-axis (px) ${helpButton('minBaxisPx')}</span>
          <input class="input" type="number" step="1" min="0" max="50" value="${state.siteOptions.minBaxisPx ?? 15}" data-site-opt="minBaxisPx" />
        </label>
        <label class="field-label">
          <span class="label-row">Exclusion overlap ${helpButton('maxExcludedFraction')}</span>
          <input class="input" type="number" step="0.05" min="0" max="1" value="${state.siteOptions.maxExcludedFraction ?? 0.1}" data-site-opt="maxExcludedFraction" />
        </label>
      </div>
      <div style="margin-top:6px;">
        <label class="checkbox-label">
          <input type="checkbox" data-site-opt="harmonizePhysicalCutoff" ${state.siteOptions.harmonizePhysicalCutoff !== false ? 'checked' : ''} /> Harmonize Cutoff ${helpButton('harmonizePhysicalCutoff')}
        </label>
      </div>
      <details class="advanced-block" style="margin-top:6px;" data-keep-open="uncertainty">
        <summary>Uncertainty &amp; sampling</summary>
        <div class="grid-2" style="margin-top:6px;">
          <label class="field-label">
            <span class="label-row">Confidence level ${helpButton('confidenceLevel')}</span>
            <select class="select" data-site-opt="confidenceLevel" data-numeric="true">
              <option value="0.95" ${(state.siteOptions.confidenceLevel ?? 0.95) === 0.95 ? 'selected' : ''}>95%</option>
              <option value="0.9" ${state.siteOptions.confidenceLevel === 0.9 ? 'selected' : ''}>90%</option>
            </select>
          </label>
          <label class="field-label">
            <span class="label-row">Bootstrap repeats ${helpButton('bootstrapReplicates')}</span>
            <input class="input" type="number" step="50" min="50" max="5000" value="${state.siteOptions.bootstrapReplicates ?? 500}" data-site-opt="bootstrapReplicates" />
          </label>
          <label class="field-label">
            <span class="label-row">Bootstrap seed ${helpButton('bootstrapSeed')}</span>
            <input class="input" type="number" step="1" min="0" max="2147483647" value="${state.siteOptions.bootstrapSeed ?? 42}" data-site-opt="bootstrapSeed" />
          </label>
          <label class="field-label">
            <span class="label-row">Virtual Wolman points ${helpButton('wolmanPointsPerPhoto')}</span>
            <input class="input" type="number" step="10" min="10" max="2000" value="${state.siteOptions.wolmanPointsPerPhoto ?? 100}" data-site-opt="wolmanPointsPerPhoto" />
          </label>
        </div>
        <label class="checkbox-label" style="margin-top:6px;">
          <input type="checkbox" data-site-opt="bootstrapTwoStage" ${state.siteOptions.bootstrapTwoStage ? 'checked' : ''} /> Two-stage bootstrap ${helpButton('bootstrapTwoStage')}
        </label>
      </details>
        </div>
      </details>
    </div>

    <div class="tabs" role="tablist" aria-label="Dashboard analyses">
      ${(['psd', 'adequacy', 'shape', 'fabric'] as DashboardTab[])
        .map((tab) => {
          const selected = state.dashboardTab === tab;
          const label =
            tab === 'psd'
              ? 'PSD'
              : tab === 'adequacy'
                ? 'Adequacy'
                : tab === 'shape'
                  ? 'Shape'
                  : 'Fabric';
          return `<button type="button" class="tab-btn" role="tab" id="tab-${tab}" aria-selected="${selected ? 'true' : 'false'}" aria-controls="dashboard-tabpanel" tabindex="${selected ? '0' : '-1'}" data-tab="${tab}">${label}</button>`;
        })
        .join('')}
    </div>

    <div class="panel-section" id="dashboard-tabpanel" role="tabpanel" aria-labelledby="tab-${state.dashboardTab}" style="border-bottom:none;">
      ${tabContent}
    </div>
  `;
}
