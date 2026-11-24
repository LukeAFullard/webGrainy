/**
 * Site export writers: summary CSV/JSON and pooled grains CSV.
 * Split out of siteAnalysis.ts, which re-exports the public parts.
 */
import type { GrainMorphometrics } from '../types/index.js';
import { extraStatsCsvRows } from './grainStatsExtra.js';
import { computeExtendedMorphometrics, type ExtendedGrainMorphometrics } from './morphometricsExt.js';
import { baseExportMetadata, csvCell, metadataCommentLines, metadataSummaryRows } from './provenance.js';
import { filterGrainsByRoiAndExclusion } from './roiAndRectify.js';
import { filterBorderGrains } from './sedimentStats.js';
import { PSD_KEYS, siteCutoffReason } from './sitePooling.js';
import { grainStatsWeight } from './siteStatsWeights.js';
import { photoProcessingHistory, type SitePhotoInput, type SiteAnalysisOptions, type SiteAnalysisReport } from './siteTypes.js';

/** A number for a CSV cell: empty when not available (NaN/Infinity), never the text "NaN". */
const numCell = (v: number): string => (Number.isFinite(v) ? String(v) : '');

/**
 * Provenance block for site-level exports: app/ORT versions, notices, and the
 * model hash, parameters, and calibration used for each included photo.
 */
export function buildSiteExportMetadata(
  entries: readonly SitePhotoInput[],
  report?: SiteAnalysisReport,
  options?: Partial<SiteAnalysisOptions>,
): Record<string, unknown> {
  const photos = entries
    .filter((e) => e.included)
    .map((e) => {
      const prov = e.session.getProvenance();
      const cal = e.session.getCalibration();
      const wi = e.session.workingImage;
      const perPhoto = report?.perPhoto.find((p) => p.photoId === e.photoId);
      return {
        photoId: e.photoId,
        label: e.label,
        mmPerPx: cal?.mmPerPx ?? null,
        originalWidth: wi.originalWidth,
        originalHeight: wi.originalHeight,
        workingWidth: wi.width,
        workingHeight: wi.height,
        effectiveScaleFactor: wi.effectiveScaleFactor,
        ...(perPhoto?.detectionLimitPx !== undefined ? { detectionLimitPx: perPhoto.detectionLimitPx } : {}),
        roiApplied: e.roiConfig !== undefined,
        // Image-modifying steps applied before analysis (AI upscaling, deblurring, rectification).
        imageProcessing: photoProcessingHistory(e.metadata),
        ...(prov !== undefined
          ? {
              modelId: prov.modelId,
              modelSha256: prov.modelSha256,
              modelRevision: prov.modelRevision,
              executionProvider: prov.executionProvider ?? null,
              analyzedAt: prov.analyzedAt,
              analyzedWithAppVersion: prov.appVersion,
              analyzedWithAppCommit: prov.appCommit ?? null,
              inferencePipeline: prov.inferencePipeline ?? null,
              scaleMode: prov.scaleMode ?? null,
              fineGrainUpscale: prov.fineGrainUpscale ?? null,
              applyClahe: prov.applyClahe ?? null,
              claheClipLimit: prov.claheClipLimit ?? null,
              tileSkipping:
                prov.tileSkipping !== undefined
                  ? { tilesRun: prov.tileSkipping.tilesRun, tilesTotal: prov.tileSkipping.tilesTotal, marginPx: prov.tileSkipping.marginPx }
                  : null,
              postProcess: prov.postProcess ?? null,
            }
          : { provenance: 'unavailable (analysed before provenance tracking)' }),
      };
    });
  return {
    ...baseExportMetadata(),
    ...(report !== undefined
      ? {
          poolingMode: report.poolingMode,
          sizeMetric: report.sizeMetric,
          unit: report.unit,
          bootstrapConfidenceLevel: report.bootstrapCi.confidenceLevel,
          minBaxisPx: report.minBaxisPx,
          dCutoffCommonMm: report.dCutoffCommonMm,
        }
      : {}),
    ...(options !== undefined
      ? {
          siteSettings: {
            minBaxisPx: options.minBaxisPx ?? 15,
            minSizeMm: options.minSizeMm ?? 0,
            harmonizePhysicalCutoff: options.harmonizePhysicalCutoff ?? options.harmonizeCutoff ?? true,
            bootstrapReplicates: options.bootstrapReplicates ?? report?.bootstrapReplicates ?? 500,
            bootstrapSeed: options.bootstrapSeed ?? 42,
            bootstrapTwoStage: options.bootstrapTwoStage ?? false,
            wolmanPointsPerPhoto: options.wolmanPointsPerPhoto ?? 100,
            maxExcludedFraction: options.maxExcludedFraction ?? 0.1,
          },
        }
      : {}),
    photos,
  };
}

/**
 * Exports a multi-image site summary report as a JSON Blob.
 */
export function exportSiteSummaryJson(
  report: SiteAnalysisReport,
  metadata: Record<string, unknown> = baseExportMetadata(),
): Blob {
  return new Blob([JSON.stringify({ metadata, ...report }, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
}

/**
 * Exports a multi-image site summary report as a structured CSV Blob.
 */
export function exportSiteSummaryCsv(
  report: SiteAnalysisReport,
  metadata: Record<string, unknown> = baseExportMetadata(),
): Blob {
  const lines: string[] = ['section,metric,value,unit'];
  lines.push(...metadataSummaryRows(metadata));

  lines.push(`metadata,pooling_mode,${csvCell(report.poolingMode)},mode`);
  lines.push(
    `metadata,statistical_basis,${csvCell(report.statisticalBasisLabel)},label`,
  );
  lines.push(`metadata,unit,${report.unit},unit`);
  lines.push(`metadata,size_metric,${report.sizeMetric},metric`);
  lines.push(
    `metadata,included_photo_count,${report.includedPhotoCount},count`,
  );
  lines.push(`metadata,total_grain_count,${report.totalGrainCount},count`);
  lines.push(`metadata,valid_grain_count,${report.validGrainCount},count`);
  lines.push(`metadata,min_b_axis_px,${report.minBaxisPx},px`);
  lines.push(
    `metadata,d_cutoff_common_mm,${report.dCutoffCommonMm ?? ''},mm`,
  );
  lines.push(
    `metadata,excluded_truncation_count,${report.excludedTruncationCount},count`,
  );
  lines.push(
    `metadata,excluded_truncation_area_mm2,${report.excludedTruncationAreaMm2},mm2`,
  );
  lines.push(`metadata,adequacy_rating,${csvCell(report.adequacy.rating)},label`);
  lines.push(
    `metadata,bootstrap_mode,${csvCell(report.bootstrapMode)},mode`,
  );
  lines.push(`metadata,ci_method,${csvCell(report.ciStatus === 'single-photo' ? 'psd_bootstrap_ci_*: grain bootstrap percentile interval (single photo)' : 'psd_bootstrap_ci_*: t-interval on log scale, SE = larger of (cluster bootstrap SE x sqrt(n/(n-1))) and leave-one-photo-out jackknife SE, t with n-1 df (n = photos)')},label`);
  lines.push(`metadata,binomial_ci_method,${csvCell('psd_binomial_ci_*: order-statistic (binomial) interval on the effective number of grains; counting uncertainty only, ignores photo-to-photo variation')},label`);
  lines.push(`metadata,ci_status,${report.ciStatus},label`);
  lines.push(`metadata,bootstrap_seed,${report.bootstrapSeed},seed`);
  lines.push(
    `metadata,bootstrap_replicates,${report.bootstrapReplicates},count`,
  );

  for (const key of PSD_KEYS) {
    lines.push(`psd,${key},${numCell(report.psd[key])},${report.unit}`);
    lines.push(
      `psd_bootstrap_ci_lo,${key},${numCell(report.bootstrapCi.lower[key])},${report.unit}`,
    );
    lines.push(
      `psd_bootstrap_ci_hi,${key},${numCell(report.bootstrapCi.upper[key])},${report.unit}`,
    );
    lines.push(
      `psd_binomial_ci_lo,${key},${numCell(report.binomialCi.lower[key])},${report.unit}`,
    );
    lines.push(
      `psd_binomial_ci_hi,${key},${numCell(report.binomialCi.upper[key])},${report.unit}`,
    );
  }

  if (report.folkWard !== null) {
    const fw = report.folkWard;
    lines.push(`folk_ward,mean_phi,${numCell(fw.meanPhi)},phi`);
    lines.push(`folk_ward,sorting_phi,${numCell(fw.sortingPhi)},phi`);
    lines.push(`folk_ward,skewness_phi,${numCell(fw.skewnessPhi)},phi`);
    lines.push(`folk_ward,kurtosis_phi,${numCell(fw.kurtosisPhi)},phi`);
    lines.push(`folk_ward,mean_mm,${numCell(fw.meanMm)},mm`);
    lines.push(`folk_ward,sorting_label,${csvCell(fw.sortingLabel)},label`);
    lines.push(`folk_ward,skewness_label,${csvCell(fw.skewnessLabel)},label`);
    lines.push(`folk_ward,kurtosis_label,${csvCell(fw.kurtosisLabel)},label`);
  }

  if (report.extra !== null && report.extra !== undefined) {
    lines.push(...extraStatsCsvRows(report.extra, report.unit));
  }
  if (report.wentworth !== null) {
    const w = report.wentworth;
    lines.push(`wentworth,sand_pct,${numCell(w.sandPct)},%`);
    lines.push(`wentworth,gravel_pct,${numCell(w.gravelPct)},%`);
    lines.push(`wentworth,cobble_pct,${numCell(w.cobblePct)},%`);
    lines.push(`wentworth,boulder_pct,${numCell(w.boulderPct)},%`);
  }

  lines.push(`metadata,confidence_level,${report.binomialCi.confidenceLevel},fraction`);
  if (report.folkWardCi !== null) {
    const ci = report.folkWardCi;
    for (const [k, v] of Object.entries(ci) as Array<[string, [number, number]]>) {
      const unit = k === 'meanMm' ? 'mm' : 'phi';
      const name = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      lines.push(`folk_ward_ci_lo,${name},${numCell(v[0])},${unit}`);
      lines.push(`folk_ward_ci_hi,${name},${numCell(v[1])},${unit}`);
    }
  }
  for (const [sec, bins] of [
    ['size_class_1phi', report.wentworthHistogram10Phi],
    ['size_class_05phi', report.wentworthHistogram05Phi],
  ] as const) {
    for (const b of bins) {
      const label = csvCell(`${b.label} [${b.mmMin}-${b.mmMax} mm]`);
      lines.push(`${sec},${label},${numCell(b.weightPct)},%`);
      lines.push(`${sec}_count,${label},${b.grainCount},count`);
    }
  }
  const sh = report.shape;
  lines.push(`shape,grain_count,${sh.n},count`);
  lines.push(`shape,median_aspect_ratio_b_over_a,${numCell(sh.medianAspectRatio)},ratio`);
  sh.aspectRatioCounts.forEach((c, i, all) => lines.push(`shape_bin,${(i / all.length).toFixed(1)}-${((i + 1) / all.length).toFixed(1)},${c},count`));
  const fr = report.fabricRose;
  lines.push(`fabric,grain_count,${fr.grainCount},count`);
  lines.push(`fabric,mean_axial_orientation_deg,${numCell(fr.meanAxialDeg)},deg (0 = image vertical; counter-clockwise)`);
  lines.push(`fabric,resultant_length_R,${numCell(fr.resultantLength)},ratio`);
  lines.push(`fabric,circular_variance,${numCell(fr.circularVariance)},ratio`);
  lines.push(`fabric,rayleigh_z,${numCell(fr.rayleighZ)},stat`);
  lines.push(`fabric,rayleigh_p,${fr.rayleighP ?? ''},p`);
  for (const b of fr.bins) lines.push(`fabric_bin,${b.startDeg}-${b.endDeg}deg,${numCell(b.proportionPct)},%`);
  const adq = report.adequacy;
  lines.push(`adequacy,effective_grain_count,${numCell(adq.effectiveGrainCount)},count`);
  lines.push(`adequacy,rating_limited_by_photo_count,${adq.limitedByPhotoCount},flag`);
  lines.push(`adequacy,largest_clast_area_ratio,${numCell(adq.largestClastAreaRatio)},fraction`);
  lines.push(`adequacy,largest_clast_warning,${adq.largestClastWarning},label`);
  for (const o of adq.outlierPhotos) {
    lines.push(`adequacy_outlier_photo,${csvCell(o.label)},${csvCell(o.reasons.join('; '))},text`);
  }
  if (report.jackknife !== null) {
    lines.push(`jackknife,se_D16,${numCell(report.jackknife.seD16)},${report.unit}`);
    lines.push(`jackknife,se_D50,${numCell(report.jackknife.seD50)},${report.unit}`);
    lines.push(`jackknife,se_D84,${numCell(report.jackknife.seD84)},${report.unit}`);
  }
  // One row per photo: <photo label>|<field>.
  const jk = new Map((report.jackknife?.perPhoto ?? []).map((j) => [j.photoId, j]));
  const conv = new Map(report.convergence.map((c) => [c.photoId, c]));
  for (const p of report.perPhoto) {
    const name = (f: string): string => csvCell(`${p.label}|${f}`);
    const rows: Array<[string, number | string | undefined, string]> = [
      ['included', String(p.included), 'flag'],
      ['mm_per_px', p.mmPerPx, 'mm/px'],
      ['raw_grains', p.rawGrainCount, 'count'],
      ['valid_grains', p.validGrainCount, 'count'],
      ['excluded_truncation', p.excludedTruncationCount, 'count'],
      ['sampled_bed_area_mm2', p.sampledBedAreaMm2, 'mm2'],
      ['clast_packing_pct', p.clastPackingPct, '%'],
      ['exposed_matrix_pct', p.exposedMatrixPct, '%'],
      ['D16', p.D16, report.unit],
      ['D50', p.D50, report.unit],
      ['D84', p.D84, report.unit],
      ['weight_pct', p.weightContributionPct, '%'],
      ['jackknife_delta_D50', jk.get(p.photoId)?.deltaD50, report.unit],
      ['cumulative_D50', conv.get(p.photoId)?.D50, report.unit],
      ['cumulative_D50_ci_half_width_pct', conv.get(p.photoId)?.relativeHalfWidthD50Pct, '%'],
    ];
    for (const [f, v, u] of rows) {
      // NaN = not computed (e.g. convergence CI only at checkpoints): leave the row out.
      if (v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) lines.push(`per_photo_detail,${name(f)},${v},${u}`);
    }
  }
  report.warnings.forEach((w, i) => lines.push(`warning,${i + 1},${csvCell(w)},text`));

  for (const p of report.perPhoto) {
    lines.push(
      `per_photo,${csvCell(`${p.photoId}_D50`)},${numCell(p.D50)},${report.unit}`,
    );
    lines.push(
      `per_photo,${csvCell(`${p.photoId}_valid_grains`)},${p.validGrainCount},count`,
    );
    lines.push(
      `per_photo,${csvCell(`${p.photoId}_weight_pct`)},${p.weightContributionPct},%`,
    );
  }

  for (let i = 0; i < report.citations.length; i++) {
    const cit = report.citations[i];
    if (cit !== undefined) {
      lines.push(`citation,ref_${i + 1},${csvCell(cit)},text`);
    }
  }

  return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

/**
 * Exports all pooled grains across included photos with `photo_id`, `photo_name`,
 * `mm_per_px`, standard morphometrics, and extended 2D shape metrics.
 */
export function exportPooledGrainsCsv(
  entries: readonly SitePhotoInput[],
  report?: SiteAnalysisReport,
  options?: { metadata?: Record<string, unknown> },
): Blob {
  const header = [
    'photo_id',
    'photo_name',
    'mm_per_px',
    'grain_id',
    'centroid_x',
    'centroid_y',
    'area_px',
    'a_axis_px',
    'b_axis_px',
    'd_eq_px',
    'area_mm2',
    'a_axis_mm',
    'b_axis_mm',
    'd_eq_mm',
    'orientation_rad',
    'touches_border',
    'perimeter_px',
    'perimeter_mm',
    'circularity',
    'aspect_ratio',
    'elongation',
    'convex_area_px',
    'convex_area_mm2',
    'solidity',
    'sphericity_2d',
    'min_feret_px',
    'max_feret_px',
    'min_feret_mm',
    'max_feret_mm',
    'included_in_stats',
    'exclusion_reason',
    'stats_weight',
  ].join(',');

  const lines: string[] =
    options?.metadata !== undefined
      ? [...metadataCommentLines(options.metadata), header]
      : [header];

  // Same size-cutoff rule as the site statistics (rows already pass the border and ROI rules).
  // Without a report the cutoffs are unknown and both columns are left empty.
  const byId = new Map<number, GrainMorphometrics>();
  // Weight of each counted grain in the site statistics (area in mm² or px, share of photo area,
  // grid hits or 1, by pooling mode): pooling `stats_weight` reproduces the site percentiles.
  // A counted grain with no weight (missed by the Wolman grid, or in a photo with facies weight 0)
  // gets 0, so the column sums without fill-ins; a grain that is not counted stays empty.
  const weightCell = (photoId: string, grainId: number, counted: boolean | string): string | number => {
    if (report === undefined) return '';
    const w = grainStatsWeight(report, photoId, grainId);
    if (w !== undefined && Number.isFinite(w)) return w;
    return counted === true ? 0 : '';
  };
  const inclusion = (g: { id: number }): [string | boolean, string] => {
    if (report === undefined) return ['', ''];
    const grain = byId.get(g.id);
    const reason = grain ? siteCutoffReason(grain, report.sizeMetric, report.minBaxisPx, report.dCutoffCommonMm) : null;
    return [reason === null, reason ?? ''];
  };

  for (const entry of entries) {
    if (!entry.included) continue;
    const res = entry.session.getResult();
    byId.clear();
    for (const g of res.grains) byId.set(g.id, g);
    const cal = entry.session.getCalibration();
    const mmPerPx = cal?.mmPerPx;
    const excludeBorder = entry.session.getExcludeBorder();
    const borderFiltered = filterBorderGrains(res.grains, excludeBorder);
    const sWork = entry.session.workingImage.effectiveScaleFactor;

    const grains =
      entry.roiConfig !== undefined
        ? filterGrainsByRoiAndExclusion(
            res.masks,
            borderFiltered,
            res.width,
            res.height,
            sWork,
            entry.roiConfig,
            mmPerPx,
          ).includedGrains
        : borderFiltered;

    const extGrains: ExtendedGrainMorphometrics[] = computeExtendedMorphometrics(
      res.masks,
      grains,
      res.width,
      res.height,
      sWork,
      mmPerPx,
      entry.session.getHullCache(),
    );

    for (const g of extGrains) {
      lines.push(
        [
          csvCell(entry.photoId),
          csvCell(entry.label),
          mmPerPx ?? '',
          g.id,
          g.centroidX,
          g.centroidY,
          g.areaPx,
          g.aAxisPx,
          g.bAxisPx,
          g.dEqPx,
          g.areaMm2 ?? '',
          g.aAxisMm ?? '',
          g.bAxisMm ?? '',
          g.dEqMm ?? '',
          g.orientationRad,
          g.touchesBorder,
          g.perimeterPx,
          g.perimeterMm ?? '',
          g.circularity,
          g.aspectRatio,
          g.elongation,
          g.convexAreaPx,
          g.convexAreaMm2 ?? '',
          g.solidity,
          g.sphericity2D,
          g.minFeretPx,
          g.maxFeretPx,
          g.minFeretMm ?? '',
          g.maxFeretMm ?? '',
          ...inclusion(g),
          weightCell(entry.photoId, g.id, inclusion(g)[0]),
        ].join(','),
      );
    }
  }

  return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

export const exportSiteGrainsCsv = exportPooledGrainsCsv;
