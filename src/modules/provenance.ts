import type { AnalysisProvenance, ModelId } from '../types/index.js';
import { MODEL_FILES, MODEL_INTEGRITY, MODEL_REVISION } from './modelCache.js';

// Injected by esbuild.config.mjs (`define`). Fallbacks apply in unit tests / ts-node.
declare const __APP_VERSION__: string | undefined;
declare const __ORT_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';
export const ORT_VERSION: string =
  typeof __ORT_VERSION__ === 'string' ? __ORT_VERSION__ : 'unknown';

export const UNOFFICIAL_NOTICE =
  'webGrainy is an independent, unofficial browser port of ImageGrains 2.0; it is not affiliated with or endorsed by the ImageGrains or Cellpose authors, and its post-processing differs from the official Python implementation.';

export const CITATION_NOTICE =
  'If you use these results, cite ImageGrains (Mair et al.; doi:10.1002/esp.5755; weights doi:10.5281/zenodo.15728186) and Cellpose (Stringer et al. 2021, doi:10.1038/s41592-020-01018-x).';

/** Definition of the reported "b-axis" size metric (see AUDIT_REPORT.md F-06). */
export const SIZE_METRIC_DEFINITION =
  'b_axis = minor axis (4*sqrt(lambda2)) of the second-moment-equivalent ellipse of the exposed 2D grain outline (NOT a sieve or caliper b-axis; can differ from min-Feret by roughly +/-15% depending on grain shape). min_feret = minimum Feret (rotating-calipers) width of the pixel-edge convex hull (closest 2D analogue of a caliper b-axis). d_eq = diameter of the equal-area circle.';

export type { AnalysisProvenance };

export function buildAnalysisProvenance(params: {
  modelId: ModelId;
  executionProvider?: string;
  scaleMode?: string;
  effectiveScaleFactor?: number;
  applyClahe?: boolean;
  claheClipLimit?: number;
  postProcess?: Record<string, number>;
  now?: Date;
}): AnalysisProvenance {
  return {
    appVersion: APP_VERSION,
    ortVersion: ORT_VERSION,
    analyzedAt: (params.now ?? new Date()).toISOString(),
    modelId: params.modelId,
    modelFile: MODEL_FILES[params.modelId],
    modelRevision: MODEL_REVISION,
    modelSha256: MODEL_INTEGRITY[params.modelId].sha256,
    ...(params.executionProvider !== undefined ? { executionProvider: params.executionProvider } : {}),
    ...(params.scaleMode !== undefined ? { scaleMode: params.scaleMode } : {}),
    ...(params.effectiveScaleFactor !== undefined
      ? { effectiveScaleFactor: params.effectiveScaleFactor }
      : {}),
    ...(params.applyClahe !== undefined ? { applyClahe: params.applyClahe } : {}),
    ...(params.claheClipLimit !== undefined ? { claheClipLimit: params.claheClipLimit } : {}),
    ...(params.postProcess !== undefined ? { postProcess: { ...params.postProcess } } : {}),
  };
}

/** Common header fields attached to every export. */
export function baseExportMetadata(): Record<string, unknown> {
  return {
    generator: 'webGrainy (ImageGrains 2.0 Web)',
    appVersion: APP_VERSION,
    ortVersion: ORT_VERSION,
    exportedAt: new Date().toISOString(),
    sizeMetricDefinition: SIZE_METRIC_DEFINITION,
    notice: UNOFFICIAL_NOTICE,
    citation: CITATION_NOTICE,
  };
}

function flatten(prefix: string, value: unknown, out: Array<[string, string]>): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(prefix ? `${prefix}.${k}` : k, v, out);
    }
    return;
  }
  out.push([prefix, Array.isArray(value) ? JSON.stringify(value) : String(value)]);
}

/** Flattens a metadata object into `[key, value]` pairs (dotted keys). */
export function flattenMetadata(meta: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  flatten('', meta, out);
  return out;
}

/** `# key: value` comment lines for prefixing tabular CSV exports. */
export function metadataCommentLines(meta: Record<string, unknown>): string[] {
  return flattenMetadata(meta).map(([k, v]) => `# ${k}: ${v.replace(/[\r\n]+/g, ' ')}`);
}

/**
 * Neutralises spreadsheet formula injection (OWASP "CSV injection") and quotes a CSV cell.
 * Cells beginning with `=`, `+`, `-`, `@`, TAB or CR are prefixed with `'` unless they are
 * plain numbers.
 */
export function csvCell(val: string | number | boolean): string {
  let str = String(val);
  if (typeof val === 'string' && /^[=+\-@\t\r]/.test(str) && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** `metadata,<key>,<value>,meta` rows for section/metric/value/unit summary CSVs. */
export function metadataSummaryRows(meta: Record<string, unknown>): string[] {
  return flattenMetadata(meta).map(([k, v]) => `metadata,${csvCell(k)},${csvCell(v)},meta`);
}
