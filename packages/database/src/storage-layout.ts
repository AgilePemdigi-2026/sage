/** Storage layout for canonical rows written by current SAGE versions. */
export const CANONICAL_STORAGE_LAYOUT_VERSION = 2;

/**
 * Validate the mirror columns for a row's declared storage layout.
 * Version 1 retains the historical stringified mirrors; version 2 keeps only
 * the canonical payload and requires every mirror to be SQL NULL.
 */
export function storageMirrorsMatchLayout(
  storageLayoutVersion: number,
  canonicalContent: string | null,
  mirrors: readonly unknown[],
  legacySerializedMirrors?: readonly string[],
): boolean {
  if (storageLayoutVersion === 1) {
    return legacySerializedMirrors !== undefined &&
      mirrors.length === legacySerializedMirrors.length &&
      mirrors.every((mirror, index) => mirror === legacySerializedMirrors[index]);
  }
  if (storageLayoutVersion === CANONICAL_STORAGE_LAYOUT_VERSION) {
    return canonicalContent !== null && mirrors.every(mirror => mirror === null);
  }
  return false;
}
