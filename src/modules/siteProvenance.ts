/**
 * What the photos of a site were analysed with, from each photo's own provenance record (not
 * from the app's current settings, which may have changed since). Used for the within-site
 * consistency warning, the site comparison's like-for-like check and the printable report.
 */
import { photoProcessingHistory, type SiteAnalysisOptions, type SiteAnalysisReport, type SitePhotoInput } from './siteTypes.js';

/**
 * The analysis settings that change results, per setting: its value, or the distinct values
 * joined by " | " when the included photos differ.
 */
export function analysisSettingsOf(inputs: readonly SitePhotoInput[]): Record<string, string> {
  const values = new Map<string, Set<string>>();
  const add = (k: string, v: unknown): void => {
    const set = values.get(k) ?? new Set<string>();
    set.add(v === undefined || v === null ? 'none' : typeof v === 'string' ? v : JSON.stringify(v));
    values.set(k, set);
  };
  for (const p of inputs) {
    if (!p.included) continue;
    const prov = p.session.getProvenance();
    add('model weights', prov?.modelId ?? 'unknown');
    add('inference pipeline', prov?.inferencePipeline ?? 'unknown');
    add('image scale', prov?.scaleMode ?? 'unknown');
    add('CLAHE', prov?.applyClahe ? `on (clip ${prov.claheClipLimit ?? 2})` : 'off');
    add('fine-grain enlargement', prov?.fineGrainUpscale ?? 'off');
    add('post-processing', prov?.postProcess ?? 'unknown');
    const steps = photoProcessingHistory(p.metadata).map((x) => (x.step === 'enhancement' ? x.modelId : 'rectification'));
    add('image enhancement / rectification', steps.length > 0 ? steps.join(' + ') : 'none');
    // Tidying joins fragments and fills holes, so it changes grain sizes a little.
    add('Tidy outlines', p.session.getTidyCount() > 0 ? 'applied' : 'not applied');
  }
  const out: Record<string, string> = {};
  for (const [k, set] of values) out[k] = [...set].sort().join(' | ');
  return out;
}

/** Settings that differ between the included photos of one site (empty when all agree). */
export function withinSiteSettingDifferences(inputs: readonly SitePhotoInput[]): Array<{ setting: string; values: string }> {
  return Object.entries(analysisSettingsOf(inputs))
    .filter(([, v]) => v.includes(' | '))
    .map(([setting, values]) => ({ setting, values }));
}

export interface SiteReportProvenance {
  /** Model weights of the photos in the site statistics, with photo counts. */
  models: Array<{ modelId: string; modelSha256: string | null; modelRevision: string | null; photos: number }>;
  /** Settings table rows (label, value), from the photos' own records. */
  settings: Array<[string, string]>;
  /** Photos whose outlines were edited by hand (persisted edits, not only this page's undo history). */
  manualEditsCount: number;
  /** Photos whose outlines were tidied ("Tidy outlines": fragments reassigned, holes filled). */
  tidiedPhotosCount: number;
  /** Photos with an image enhancement step before analysis. */
  enhancedPhotosCount: number;
  /** Largest detection limit of the photos (report unit), as used for the common cutoff. */
  detectionLimit?: number;
  /** Smallest grain counted (report unit): the detection limit, or the common / Field-count cutoff when larger. */
  sizeCutoff?: number;
  /** Min/max mm per pixel of the calibrated photos. */
  resolutionRangeMmPerPx?: [number, number];
}

const distinct = (vals: readonly string[]): string => [...new Set(vals)].sort().join(' | ') || 'unknown';

/** Provenance of the photos behind a site report (only the photos the report includes). */
export function siteReportProvenance(
  inputs: readonly SitePhotoInput[],
  report: SiteAnalysisReport,
  siteOptions: Pick<SiteAnalysisOptions, 'minBaxisPx' | 'minSizeMm'>,
): SiteReportProvenance {
  const ids = new Set(report.perPhoto.map((p) => p.photoId));
  const used = inputs.filter((i) => i.included && ids.has(i.photoId));
  const byModel = new Map<string, { modelSha256: string | null; modelRevision: string | null; photos: number }>();
  for (const i of used) {
    const prov = i.session.getProvenance();
    const id = prov?.modelId ?? 'unknown (analysed before provenance tracking)';
    const e = byModel.get(id) ?? { modelSha256: prov?.modelSha256 ?? null, modelRevision: prov?.modelRevision ?? null, photos: 0 };
    e.photos++;
    byModel.set(id, e);
  }
  const models = [...byModel].map(([modelId, e]) => ({ modelId, ...e }));
  const post = used.map((i) => i.session.getProvenance()?.postProcess);
  const fmtPost = (k: string): string => distinct(post.map((p) => (p && typeof p[k] === 'number' ? String(p[k]) : 'unknown')));
  const cutoff = [`${siteOptions.minBaxisPx ?? 15} px`];
  if (report.dCutoffCommonMm !== null) cutoff.push(`${report.dCutoffCommonMm.toFixed(2)} mm (common cutoff)`);
  const settings: Array<[string, string]> = [
    ['Model', models.map((m) => `${m.modelId}${models.length > 1 ? ` (${m.photos} photo${m.photos === 1 ? '' : 's'})` : ''}`).join(' + ')],
    ['Pooling', report.statisticalBasisLabel],
    ['Size metric', report.sizeMetric],
    ['Smallest grain counted', cutoff.join(' and ')],
    ['Flow threshold / cell probability', `${fmtPost('flowThreshold')} / ${fmtPost('cellprobThreshold')}`],
    ['Run on', distinct(used.map((i) => i.session.getProvenance()?.executionProvider ?? 'unknown'))],
    ['Grains touching the photo edge', distinct(used.map((i) => (i.session.getExcludeBorder() ? 'left out' : 'counted')))],
    ['Image scale', distinct(used.map((i) => i.session.getProvenance()?.scaleMode ?? 'unknown'))],
  ];
  const limits = report.perPhoto
    .map((p) => (p.detectionLimitPx !== undefined ? (report.unit === 'mm' ? (p.mmPerPx !== undefined ? p.detectionLimitPx * p.mmPerPx : Number.NaN) : p.detectionLimitPx) : Number.NaN))
    .filter((v) => Number.isFinite(v) && v > 0);
  const scales = report.perPhoto.map((p) => p.mmPerPx).filter((v): v is number => v !== undefined && v > 0);
  return {
    models,
    settings,
    manualEditsCount: used.filter((i) => i.session.getManualEditCount() > 0).length,
    tidiedPhotosCount: used.filter((i) => i.session.getTidyCount() > 0).length,
    enhancedPhotosCount: used.filter((i) => photoProcessingHistory(i.metadata).some((s) => s.step === 'enhancement')).length,
    ...(limits.length > 0 ? { detectionLimit: Math.max(...limits) } : {}),
    ...(() => {
      // The cutoff actually applied: the detection limit, or the site's common mm cutoff when
      // larger (it includes the Field-count cutoff, minSizeMm).
      const det = limits.length > 0 ? Math.max(...limits) : 0;
      const common = report.unit === 'mm' && report.dCutoffCommonMm !== null && Number.isFinite(report.dCutoffCommonMm) ? report.dCutoffCommonMm : 0;
      const c = Math.max(det, common);
      return c > 0 ? { sizeCutoff: c } : {};
    })(),
    ...(scales.length > 0 ? { resolutionRangeMmPerPx: [Math.min(...scales), Math.max(...scales)] as [number, number] } : {}),
  };
}
