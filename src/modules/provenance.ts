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
  'If you use these results, cite ImageGrains 2.0 (Mair et al. 2026, doi:10.5194/esurf-14-527-2026; weights doi:10.5281/zenodo.15728186), ImageGrains (Mair et al. 2023, doi:10.1002/esp.5755), Cellpose-SAM (Pachitariu et al. 2025, doi:10.1101/2025.04.28.651001) and Cellpose (Stringer et al. 2021, doi:10.1038/s41592-020-01018-x).';

/**
 * Validated accuracy and its limits, included in every export and in the printable report
 * (pre-publication audit S7). Figures from validation/heldout/heldout_app_results.md; tests/docNumbers.test.ts
 * keeps them in step.
 */
export const ACCURACY_NOTICE =
  'Accuracy: on the held-out ImageGrains 2.0 test photos (held-out tiles from the 13 training sites, many cut from the same source photos as training tiles, mostly analysed at full resolution), the median D50 error was 2.6% with Cellpose-SAM and 5.7% with U-Net, but 5% and 10% of photos had D50 errors above 50%. Accuracy at new sites and on large photos analysed at reduced resolution is not established; check the outlines.';

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
    accuracy: ACCURACY_NOTICE,
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

/**
 * Text of one `#` comment line, kept readable: line breaks and tabs become spaces, and commas,
 * semicolons and pipes are written as they are. A spreadsheet may then split the line over a few
 * cells, so a user-controlled value (photo label, site name, place) that would start a formula
 * after a delimiter or a space is prefixed with `'` (as in `csvCell`), and can never become one.
 */
export function escapeCommentText(text: string): string {
  return guardAfterDelimiters(guardInnerFormulaStarts(text.replace(/[\r\n\t]+/g, ' ')));
}

/** A plain number, optionally followed by a unit made of letters, `%` or `°` (e.g. `-4φ`, `-5mm`). */
const NUMBER_WITH_UNIT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[\p{L}\p{M}%°]*[)\]}.,:;]*$/u;

/**
 * Prefixes `'` to a formula character (`=` `+` `-` `@`) that follows a cell delimiter (`,` `;` `|`
 * TAB or a line break) and any whitespace, unless it starts a plain number such as `-3` or `-4φ`.
 */
function guardAfterDelimiters(text: string): string {
  return text.replace(/([,;|\t\r\n])(\s*)([=+\-@])([^,;|\t\r\n]*)/g, (m, d: string, sp: string, f: string, rest: string) =>
    (f === '-' || f === '+') && NUMBER_WITH_UNIT.test(`${f}${rest.split(/\s/, 1)[0] ?? ''}`) ? m : `${d}${sp}'${f}${rest}`,
  );
}

/**
 * A spreadsheet told to split on spaces would start a cell at every word: prefix `'` to a word
 * that would start a formula: `=` or `@`, or `+` / `-` followed by anything (`-2+3+cmd|...`,
 * `+$A$1`, `+=1+1`, `--1+1`) unless the word is a plain number or an arrow. A lone "-" or "+"
 * (as in "IMG 1 - copy"), arrows ("->") and numbers such as "-5", "-4φ" or "-5mm" are kept: a
 * number followed only by letters cannot run anything.
 */
function guardInnerFormulaStarts(text: string): string {
  return text.replace(/(?<=\S)( +)(\S+)/g, (m, spaces: string, word: string) => {
    const formula =
      /^[=@]/.test(word) ||
      (/^[+-][^\s<>]/.test(word) && !NUMBER_WITH_UNIT.test(word));
    return formula ? `${spaces}'${word}` : m;
  });
}

/** `# key: value` comment lines for prefixing tabular CSV exports (delimiters escaped). */
export function metadataCommentLines(meta: Record<string, unknown>): string[] {
  return flattenMetadata(meta).map(([k, v]) => `# ${escapeCommentText(`${k}: ${v}`)}`);
}

/**
 * Neutralises spreadsheet formula injection (OWASP "CSV injection") and quotes a CSV cell.
 * Cells beginning with `=`, `+`, `-`, `@`, TAB or CR (after any spaces) are prefixed with `'`
 * unless they are plain numbers. Inside text, a formula character after a delimiter (`,` `;` `|`
 * TAB or a line break) and any spaces is prefixed too, and so is a word that would start a formula
 * if the file were split on spaces: a spreadsheet that splits on another delimiter than the comma
 * (e.g. `;` in many European locales) ignores quotes in the middle of its cells, so that
 * character could otherwise start a cell.
 */
export function csvCell(val: string | number | boolean): string {
  let str = String(val);
  if (typeof val === 'string') {
    str = guardInnerFormulaStarts(str);
    // Leading spaces count: a spreadsheet that trims spaces on import (LibreOffice "Trim spaces")
    // would otherwise turn " =1+1" into a formula.
    if (/^\s*[=+\-@\t\r]/.test(str) && !/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(str)) {
      str = `'${str}`;
    }
    // Any whitespace after the delimiter (a trimming import also drops no-break spaces).
    str = guardAfterDelimiters(str);
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

/**
 * A CSV file as a Blob, UTF-8 with a byte-order mark: without it Excel reads the file as the
 * local code page and shows `φ` as `Ï†` and `–` as `â€“`. pandas, R readr and LibreOffice skip the mark.
 */
export function csvBlob(text: string): Blob {
  return new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' });
}
