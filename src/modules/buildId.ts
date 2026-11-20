/**
 * Identity of the running build, shared by the page and its workers (all are bundled in one
 * build run with the same `define`s). A worker from another build means the page is out of
 * date: a newer version took over in another tab. Its results must not be recorded, since the
 * provenance would name the page's build, not the code that computed them.
 */
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_DATE__: string | undefined;

export const BUILD_ID: string = `${typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev'}@${
  typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : 'dev'
}`;

/** Error for a worker reply from another build, or null when it matches (or does not say). */
export function buildMismatchError(workerBuild: unknown, ownBuild: string = BUILD_ID): Error | null {
  if (typeof workerBuild !== 'string' || workerBuild === ownBuild) return null;
  const err = new Error(
    'This page is out of date: a newer version of webGrainy was installed in another tab. Reload the page to continue (your data is kept).',
  );
  err.name = 'BuildMismatchError';
  return err;
}
