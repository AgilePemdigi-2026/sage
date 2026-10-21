import { createHash } from "node:crypto";
import { canonicalizeCcm } from "./index.ts";
import type { CcmV1 } from "./index.ts";

/** Versioned wrapper for a canonical CCM snapshot and its derived graph counts. */
export const CKG_SCHEMA_VERSION = "sage-ckg-v1" as const;

export interface CkgCounts {
  nodes: number;
  edges: number;
  containmentEdges: number;
  referenceEdges: number;
  exactEdges: number;
  unresolvedEdges: number;
}

export interface CkgV1 {
  schemaVersion: typeof CKG_SCHEMA_VERSION;
  /** Queue configuration fingerprint; adapter-specific settings remain in CCM provenance. */
  configurationHash: string;
  /** Canonical source model. Nodes, edges, IDs and evidence are preserved from CCM v1. */
  ccm: CcmV1;
  counts: CkgCounts;
}

export type CanonicalCkgResult =
  | { ok: true; value: CkgV1; json: string; sha256: string }
  | { ok: false; errorCode: string };

const CONFIGURATION_HASH = /^[a-f0-9]{64}$/;
const CKG_FIELDS = ["schemaVersion", "configurationHash", "ccm", "counts"];
const COUNT_FIELDS = ["nodes", "edges", "containmentEdges", "referenceEdges", "exactEdges", "unresolvedEdges"];

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function countsFor(ccm: CcmV1): CkgCounts {
  const containmentEdges = ccm.edges.filter(edge => edge.kind === "CONTAINS").length;
  const exactEdges = ccm.edges.filter(edge => edge.resolution === "Exact").length;
  const unresolvedEdges = ccm.edges.filter(edge => edge.resolution === "Unresolved").length;
  return {
    nodes: ccm.nodes.length,
    edges: ccm.edges.length,
    containmentEdges,
    referenceEdges: ccm.edges.length - containmentEdges,
    exactEdges,
    unresolvedEdges,
  };
}

function hasExactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => typeof key === "string" && fields.includes(key)) &&
    keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && descriptor.enumerable && "value" in descriptor;
    });
}

function serialize(ccm: CcmV1, configurationHash: string): { value: CkgV1; json: string; sha256: string } {
  const value: CkgV1 = {
    schemaVersion: CKG_SCHEMA_VERSION,
    configurationHash,
    ccm,
    counts: countsFor(ccm),
  };
  const json = JSON.stringify(value);
  return { value, json, sha256: digest(json) };
}

/** Validate and canonicalize the source model before wrapping it as a graph artifact. */
export function canonicalizeCkg(
  inputCcm: unknown,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
  configurationHash: string,
): CanonicalCkgResult {
  if (typeof configurationHash !== "string" || !CONFIGURATION_HASH.test(configurationHash)) {
    return { ok: false, errorCode: "CKG_CONFIGURATION_HASH_INVALID" };
  }
  const canonical = canonicalizeCcm(inputCcm, sourceBytes);
  if (!canonical.ok) return canonical;
  return { ok: true, ...serialize(canonical.value, configurationHash) };
}

/** Parse a persisted CKG only when its envelope, derived counts, source evidence and bytes are valid. */
export function parseCanonicalCkg(
  json: string,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
  expectedSha256?: string,
): CanonicalCkgResult {
  if (typeof json !== "string") return { ok: false, errorCode: "CKG_JSON_INVALID" };
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256))) {
    return { ok: false, errorCode: "CKG_CONTENT_HASH_INVALID" };
  }
  if (expectedSha256 !== undefined && digest(json) !== expectedSha256) {
    return { ok: false, errorCode: "CKG_CONTENT_HASH_MISMATCH" };
  }

  let input: unknown;
  try {
    input = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, errorCode: "CKG_JSON_INVALID" };
  }
  if (!hasExactFields(input, CKG_FIELDS) || input.schemaVersion !== CKG_SCHEMA_VERSION ||
      typeof input.configurationHash !== "string" || !CONFIGURATION_HASH.test(input.configurationHash) ||
      !hasExactFields(input.counts, COUNT_FIELDS)) {
    return { ok: false, errorCode: "CKG_ENVELOPE_INVALID" };
  }

  const canonical = canonicalizeCkg(input.ccm, sourceBytes, input.configurationHash);
  if (!canonical.ok) return canonical;
  if (JSON.stringify(input.counts) !== JSON.stringify(canonical.value.counts)) {
    return { ok: false, errorCode: "CKG_COUNTS_INVALID" };
  }
  // Reject alternate field/array ordering: persisted canonical bytes must be replayable exactly.
  if (canonical.json !== json) return { ok: false, errorCode: "CKG_JSON_NOT_CANONICAL" };
  return canonical;
}
