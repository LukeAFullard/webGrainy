import type { AnalysisProvenance, ModelId } from '../types/index.js';
import { MODEL_FILES, MODEL_INTEGRITY, MODEL_REVISION } from './modelCache.js';

// Injected by esbuild.config.mjs (`define`). Fallbacks apply in unit tests / ts-node.
declare const __APP_VERSION__: string | undefined;
declare const __ORT_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_DATE__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';
export const ORT_VERSION: string =
  typeof __ORT_VERSION__ === 'string' ? __ORT_VERSION__ : 'unknown';
/** Git commit the running build was made from ('-modified' if built from uncommitted changes). */
export const BUILD_COMMIT: string =
  typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev';
/** When the running build was made (ISO time). */
export const BUILD_DATE: string = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : 'dev';

export const UNOFFICIAL_NOTICE =
  'webGrainy is an independent, unofficial browser port of ImageGrains 2.0; it is not affiliated with or endorsed by the ImageGrains or Cellpose authors, and its post-processing differs from the official Python implementation.';

export const CITATION_NOTICE =
  'If you use these results, cite ImageGrains (Mair et al.; doi:10.1002/esp.5755; weights doi:10.5281/zenodo.15728186) and Cellpose (Stringer et al. 2021, doi:10.1038/s41592-020-01018-x).';

/** Definition of the reported "b-axis" size metric, included in every export. */
export const SIZE_METRIC_DEFINITION =
  'b_axis = minor axis (4*sqrt(lambda2)) of the second-moment-equivalent ellipse of the exposed 2D grain outline (NOT a sieve or caliper b-axis; can differ from min-Feret by roughly +/-15% depending on grain shape). min_feret = minimum Feret (rotating-calipers) width of the pixel-edge convex hull (closest 2D analogue of a caliper b-axis). d_eq = diameter of the equal-area circle.';

export type { AnalysisProvenance };

export function buildAnalysisProvenance(params: {
  modelId: ModelId;
  executionProvider?: string;
  inferencePipeline?: string;
  scaleMode?: string;
  fineGrainUpscale?: number;
  decodedSize?: { width: number; height: number };
  effectiveScaleFactor?: number;
  applyClahe?: boolean;
  claheClipLimit?: number;
  postProcess?: Record<string, number>;
  tileSkipping?: AnalysisProvenance['tileSkipping'];
  now?: Date;
}): AnalysisProvenance {
  return {
    appVersion: APP_VERSION,
    appCommit: BUILD_COMMIT,
    ortVersion: ORT_VERSION,
    analyzedAt: (params.now ?? new Date()).toISOString(),
    modelId: params.modelId,
    modelFile: MODEL_FILES[params.modelId],
    modelRevision: MODEL_REVISION,
    modelSha256: MODEL_INTEGRITY[params.modelId].sha256,
    ...(params.executionProvider !== undefined ? { executionProvider: params.executionProvider } : {}),
    ...(params.inferencePipeline !== undefined ? { inferencePipeline: params.inferencePipeline } : {}),
    ...(params.scaleMode !== undefined ? { scaleMode: params.scaleMode } : {}),
    ...(params.fineGrainUpscale !== undefined ? { fineGrainUpscale: params.fineGrainUpscale } : {}),
    ...(params.decodedSize !== undefined ? { decodedSize: { ...params.decodedSize } } : {}),
    ...(params.effectiveScaleFactor !== undefined
      ? { effectiveScaleFactor: params.effectiveScaleFactor }
      : {}),
    ...(params.applyClahe !== undefined ? { applyClahe: params.applyClahe } : {}),
    ...(params.claheClipLimit !== undefined ? { claheClipLimit: params.claheClipLimit } : {}),
    ...(params.postProcess !== undefined ? { postProcess: { ...params.postProcess } } : {}),
    ...(params.tileSkipping !== undefined
      ? {
          tileSkipping: {
            ...params.tileSkipping,
            analysedRects: params.tileSkipping.analysedRects.map((r) => [...r] as [number, number, number, number]),
          },
        }
      : {}),
  };
}

/** Common header fields attached to every export. */
export function baseExportMetadata(): Record<string, unknown> {
  return {
    generator: 'webGrainy (ImageGrains 2.0 Web)',
    appVersion: APP_VERSION,
    appCommit: BUILD_COMMIT,
    appBuiltAt: BUILD_DATE,
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

/** Note written above the comment lines, so readers know how to decode them. */
export const COMMENT_ESCAPE_NOTE = '# escaping: in these # lines %25 = percent  %2C = comma  %3B = semicolon  %09 = tab';

/**
 * Text of one `#` comment line with every spreadsheet cell delimiter (comma, semicolon, TAB)
 * percent-escaped, so a spreadsheet keeps the whole line in its first cell (which starts with
 * `#`) and a user-controlled value (photo label, site name, place) can never begin a new cell
 * holding a formula. Reversible with `decodeURIComponent`-style replacement of the 4 escapes.
 */
export function escapeCommentText(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/%/g, '%25')
    .replace(/,/g, '%2C')
    .replace(/;/g, '%3B')
    .replace(/\t/g, '%09');
}

/** `# key: value` comment lines for prefixing tabular CSV exports (delimiters escaped). */
export function metadataCommentLines(meta: Record<string, unknown>): string[] {
  return [...flattenMetadata(meta).map(([k, v]) => `# ${escapeCommentText(`${k}: ${v}`)}`), COMMENT_ESCAPE_NOTE];
}

/**
 * Neutralises spreadsheet formula injection (OWASP "CSV injection") and quotes a CSV cell.
 * Cells beginning with `=`, `+`, `-`, `@`, TAB or CR (after any spaces) are prefixed with `'`
 * unless they are plain numbers. Inside text, a formula character after a delimiter (`,` `;`
 * TAB or a line break) and any spaces is prefixed too: a spreadsheet that splits on another delimiter than the comma
 * (e.g. `;` in many European locales) ignores quotes in the middle of its cells, so that
 * character could otherwise start a cell.
 */
export function csvCell(val: string | number | boolean): string {
  let str = String(val);
  if (typeof val === 'string') {
    // Leading spaces count: a spreadsheet that trims spaces on import (LibreOffice "Trim spaces")
    // would otherwise turn " =1+1" into a formula.
    if (/^\s*[=+\-@\t\r]/.test(str) && !/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(str)) {
      str = `'${str}`;
    }
    str = str.replace(/([,;\t\r\n])([ ]*)([=+\-@])/g, "$1$2'$3");
  }
  // Quote on `;` and TAB too: spreadsheets in many locales split CSV files on them. Quote `#`:
  // the documented readers (pandas `comment="#"`, R `comment.char="#"`) cut an unquoted line there.
  if (/[",\n\r;\t#]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** `metadata,<key>,<value>,meta` rows for section/metric/value/unit summary CSVs. */
export function metadataSummaryRows(meta: Record<string, unknown>): string[] {
  return flattenMetadata(meta).map(([k, v]) => `metadata,${csvCell(k)},${csvCell(v)},meta`);
}
