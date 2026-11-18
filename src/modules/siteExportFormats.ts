/**
 * Site export writers: summary CSV/JSON and pooled grains CSV.
 * Split out of siteAnalysis.ts, which re-exports the public parts.
 */
import { extraStatsCsvRows } from './grainStatsExtra.js';
import { computeExtendedMorphometrics, type ExtendedGrainMorphometrics } from './morphometricsExt.js';
import { baseExportMetadata, csvCell, metadataCommentLines, metadataSummaryRows } from './provenance.js';
import { filterGrainsByRoiAndExclusion } from './roiAndRectify.js';
import { filterBorderGrains } from './sedimentStats.js';
import { PSD_KEYS } from './sitePooling.js';
import type { SitePhotoInput, SiteAnalysisOptions, SiteAnalysisReport } from './siteTypes.js';

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
      return {
        photoId: e.photoId,
        label: e.label,
        mmPerPx: cal?.mmPerPx ?? null,
        effectiveScaleFactor: e.session.workingImage.effectiveScaleFactor,
        roiApplied: e.roiConfig !== undefined,
        ...(prov !== undefined
          ? {
              modelId: prov.modelId,
              modelSha256: prov.modelSha256,
              modelRevision: prov.modelRevision,
              executionProvider: prov.executionProvider ?? null,
              analyzedAt: prov.analyzedAt,
              analyzedWithAppVersion: prov.appVersion,
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
          dCutoffCommonMm: report.dCutoffCommonMm,
        }
      : {}),
    ...(options !== undefined
      ? {
          siteSettings: {
            minBaxisPx: options.minBaxisPx ?? 15,
            minSizeMm: options.minSizeMm ?? 0,
            harmonizePhysicalCutoff: options.harmonizePhysicalCutoff ?? options.harmonizeCutoff ?? true,
            bootstrapReplicates: options.bootstrapReplicates ?? 1000,
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
  lines.push(`metadata,bootstrap_seed,${report.bootstrapSeed},seed`);
  lines.push(
    `metadata,bootstrap_replicates,${report.bootstrapReplicates},count`,
  );

  for (const key of PSD_KEYS) {
    lines.push(`psd,${key},${report.psd[key]},${report.unit}`);
    lines.push(
      `psd_bootstrap_ci_lo,${key},${report.bootstrapCi.lower[key]},${report.unit}`,
    );
    lines.push(
      `psd_bootstrap_ci_hi,${key},${report.bootstrapCi.upper[key]},${report.unit}`,
    );
    lines.push(
      `psd_binomial_ci_lo,${key},${report.binomialCi.lower[key]},${report.unit}`,
    );
    lines.push(
      `psd_binomial_ci_hi,${key},${report.binomialCi.upper[key]},${report.unit}`,
    );
  }

  if (report.folkWard !== null) {
    const fw = report.folkWard;
    lines.push(`folk_ward,mean_phi,${fw.meanPhi},phi`);
    lines.push(`folk_ward,sorting_phi,${fw.sortingPhi},phi`);
    lines.push(`folk_ward,skewness_phi,${fw.skewnessPhi},phi`);
    lines.push(`folk_ward,kurtosis_phi,${fw.kurtosisPhi},phi`);
    lines.push(`folk_ward,mean_mm,${fw.meanMm},mm`);
    lines.push(`folk_ward,sorting_label,${csvCell(fw.sortingLabel)},label`);
    lines.push(`folk_ward,skewness_label,${csvCell(fw.skewnessLabel)},label`);
    lines.push(`folk_ward,kurtosis_label,${csvCell(fw.kurtosisLabel)},label`);
  }

  if (report.extra !== null && report.extra !== undefined) {
    lines.push(...extraStatsCsvRows(report.extra, report.unit));
  }
  if (report.wentworth !== null) {
    const w = report.wentworth;
    lines.push(`wentworth,sand_pct,${w.sandPct},%`);
    lines.push(`wentworth,gravel_pct,${w.gravelPct},%`);
    lines.push(`wentworth,cobble_pct,${w.cobblePct},%`);
    lines.push(`wentworth,boulder_pct,${w.boulderPct},%`);
  }

  lines.push(`metadata,confidence_level,${report.binomialCi.confidenceLevel},fraction`);
  if (report.folkWardCi !== null) {
    const ci = report.folkWardCi;
    for (const [k, v] of Object.entries(ci) as Array<[string, [number, number]]>) {
      const unit = k === 'meanMm' ? 'mm' : 'phi';
      const name = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      lines.push(`folk_ward_ci_lo,${name},${v[0]},${unit}`);
      lines.push(`folk_ward_ci_hi,${name},${v[1]},${unit}`);
    }
  }
  for (const [sec, bins] of [
    ['size_class_1phi', report.wentworthHistogram10Phi],
    ['size_class_05phi', report.wentworthHistogram05Phi],
  ] as const) {
    for (const b of bins) {
      const label = csvCell(`${b.label} [${b.mmMin}-${b.mmMax} mm]`);
      lines.push(`${sec},${label},${b.weightPct},%`);
      lines.push(`${sec}_count,${label},${b.grainCount},count`);
    }
  }
  const fr = report.fabricRose;
  lines.push(`fabric,grain_count,${fr.grainCount},count`);
  lines.push(`fabric,mean_axial_orientation_deg,${fr.meanAxialDeg},deg (0 = image vertical)`);
  lines.push(`fabric,resultant_length_R,${fr.resultantLength},ratio`);
  lines.push(`fabric,circular_variance,${fr.circularVariance},ratio`);
  lines.push(`fabric,rayleigh_z,${fr.rayleighZ},stat`);
  lines.push(`fabric,rayleigh_p,${fr.rayleighP ?? ''},p`);
  for (const b of fr.bins) lines.push(`fabric_bin,${b.startDeg}-${b.endDeg}deg,${b.proportionPct},%`);
  const adq = report.adequacy;
  lines.push(`adequacy,effective_grain_count,${adq.effectiveGrainCount},count`);
  lines.push(`adequacy,largest_clast_area_ratio,${adq.largestClastAreaRatio},fraction`);
  lines.push(`adequacy,largest_clast_warning,${adq.largestClastWarning},label`);
  for (const o of adq.outlierPhotos) {
    lines.push(`adequacy_outlier_photo,${csvCell(o.label)},${csvCell(o.reasons.join('; '))},text`);
  }
  if (report.jackknife !== null) {
    lines.push(`jackknife,se_D16,${report.jackknife.seD16},${report.unit}`);
    lines.push(`jackknife,se_D50,${report.jackknife.seD50},${report.unit}`);
    lines.push(`jackknife,se_D84,${report.jackknife.seD84},${report.unit}`);
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
      if (v !== undefined) lines.push(`per_photo_detail,${name(f)},${v},${u}`);
    }
  }
  report.warnings.forEach((w, i) => lines.push(`warning,${i + 1},${csvCell(w)},text`));

  for (const p of report.perPhoto) {
    lines.push(
      `per_photo,${csvCell(p.photoId)}_D50,${p.D50},${report.unit}`,
    );
    lines.push(
      `per_photo,${csvCell(p.photoId)}_valid_grains,${p.validGrainCount},count`,
    );
    lines.push(
      `per_photo,${csvCell(p.photoId)}_weight_pct,${p.weightContributionPct},%`,
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
  _report?: SiteAnalysisReport,
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
  ].join(',');

  const lines: string[] =
    options?.metadata !== undefined
      ? [...metadataCommentLines(options.metadata), header]
      : [header];

  for (const entry of entries) {
    if (!entry.included) continue;
    const res = entry.session.getResult();
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
        ].join(','),
      );
    }
  }

  return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
}

export const exportSiteGrainsCsv = exportPooledGrainsCsv;
