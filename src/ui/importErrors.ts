/**
 * Why a photo could not be opened, in words the user can act on (production readiness review
 * m3). The browser's own decode error ("The source image could not be decoded.") does not say
 * whether the file is empty, damaged, or in a format this browser cannot read, such as the
 * HEIC photos iPhones take by default (Safari can open them; Chrome and Firefox cannot).
 */

/** An Apple HEIC / HEIF photo, by file name or type. */
export function isHeicFile(file: { name: string; type?: string }): boolean {
  return /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf](-sequence)?$/i.test(file.type ?? '');
}

/** The error to report when the browser could not decode a (non-TIFF) photo file. */
export function undecodableImageError(file: { name: string; type?: string; size?: number }, cause: unknown): Error {
  const message =
    file.size === 0
      ? 'the file is empty (0 bytes).'
      : isHeicFile(file)
        ? 'HEIC/HEIF photos cannot be opened in this browser. Save or share the photo as JPEG (on an iPhone: Settings → Camera → Formats → Most Compatible) and add it again.'
        : 'the file is damaged, or not an image this browser can read. Use JPEG, PNG, WebP or TIFF.';
  return new Error(message, { cause });
}
