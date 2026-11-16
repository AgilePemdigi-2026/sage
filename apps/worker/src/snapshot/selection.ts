/** Strip validated optional selection metadata before validating the immutable manifest. */
export function snapshotManifest(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "sourceSelection")) return value;
  const record = value as Record<string, unknown>;
  const selection = record.sourceSelection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return value;
  const fields = selection as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "includedFiles,omitted,totalFiles" ||
      !Number.isSafeInteger(fields.totalFiles) || !Number.isSafeInteger(fields.includedFiles) ||
      (fields.totalFiles as number) < 0 || (fields.includedFiles as number) < 0 ||
      (fields.includedFiles as number) > (fields.totalFiles as number) ||
      !Array.isArray(fields.omitted) || fields.omitted.length > 10000 ||
      fields.omitted.some(item => !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "path,reason" || typeof item.path !== "string" || typeof item.reason !== "string")) return value;
  const manifest = { ...record };
  delete manifest.sourceSelection;
  return manifest;
}
