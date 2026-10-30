import { createHash } from "node:crypto";

/** Keep ADD hash immutable; the renderer identity separates immutable semantic revisions. */
export function semanticRendererVersion(base: string, modelHash: string, revision: number): string {
  if (!/^[a-f0-9]{64}$/.test(modelHash) || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid semantic export pin");
  return `${base}.sem-${createHash("sha256").update(`${modelHash}:${revision}`).digest("hex").slice(0, 32)}`;
}
