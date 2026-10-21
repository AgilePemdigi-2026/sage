import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReferences as analyzeJavaScript } from "@sage/analyzer-js";
import { analyzeReferences as analyzePhp } from "@sage/analyzer-php";
import {
  canonicalizeCcm,
  canonicalizeCkg,
  parseCanonicalCkg,
  validateCcm,
  type CcmV1,
} from "../packages/contracts/src/index.ts";

const snapshot = {
  repository: "fixture/ccm-taxonomy",
  branch: "test/taxonomy-compatibility",
  commitSha: "a".repeat(40),
};
const configurationHash = "b".repeat(64);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const typescriptPath = "src/compat.ts";
const typescriptSources = {
  [typescriptPath]: encoder.encode(`
export type AliasPayload = { label: string };
export enum DeferredMode { Ready = "ready", Failed = "failed" }

export class SupportedService {
  handle(payload: AliasPayload, mode: DeferredMode): string {
    return payload.label + mode;
  }
}

export function supportedFunction(payload: AliasPayload, mode: DeferredMode): string {
  return payload.label + mode;
}
`),
  "src/other.ts": encoder.encode("export function unrelated(): number { return 1; }\n"),
};

const phpPath = "src/compat.php";
const phpSources = {
  [phpPath]: encoder.encode(`<?php
namespace Taxonomy;

trait DeferredTrait {
    public function fromTrait(): string { return 'trait'; }
}

enum DeferredStatus: string {
    case Ready = 'ready';
    case Failed = 'failed';

    public function fromEnum(): string { return $this->value; }
}

class SupportedService {
    use DeferredTrait;

    public function status(DeferredStatus $status): string { return $status->value; }
}

function supportedFunction(DeferredStatus $status): string { return $status->value; }
`),
  "src/other.php": encoder.encode(`<?php
namespace Taxonomy;
class OtherService {}
function unrelated(): int { return 1; }
`),
};

function reverseRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).reverse());
}

function assertNoOrphanNodes(ccm: CcmV1): void {
  const ids = new Set(ccm.nodes.map((node) => node.id));
  for (const node of ccm.nodes) {
    if (node.parentId !== null) assert.ok(ids.has(node.parentId), `${node.qualifiedName} has a missing parent`);
  }
}

function assertNoUnsupportedSourceNodes(ccm: CcmV1, unsupportedNames: string[]): void {
  for (const name of unsupportedNames) {
    const pseudoDeclarations = ccm.nodes.filter((node) => node.origin === "source" &&
      (node.name === name || node.qualifiedName === name || node.qualifiedName.includes(`.${name}`) ||
        node.qualifiedName.includes(`\\${name}`) || node.qualifiedName.includes(`${name}::`)));
    assert.deepEqual(pseudoDeclarations, [], `${name} must not be represented as a source declaration/member`);
  }
}

function assertExpectedLimitations(
  ccm: CcmV1,
  expected: Array<{ path: string; stage: string; reason: string }>,
): void {
  for (const limitation of expected) {
    assert.ok(ccm.limitations.some((item) => item.path === limitation.path && item.stage === limitation.stage && item.reason === limitation.reason),
      `missing limitation ${limitation.path} [${limitation.stage}]: ${limitation.reason}`);
  }
}

function assertUnsupportedReferencesAreNotExact(ccm: CcmV1, sources: Record<string, Uint8Array>, names: string[]): void {
  const exactUnsupportedReferences = ccm.edges.filter((edge) => edge.kind === "TYPE_REFERENCES" && edge.resolution === "Exact" &&
    edge.evidence.some((span) => {
      const source = sources[span.filePath];
      return source !== undefined && names.some((name) => decoder.decode(source.subarray(span.startByte, span.endByte)).includes(name));
    }));
  assert.deepEqual(exactUnsupportedReferences, [], "unsupported constructs must not acquire exact reference targets");
}

function assertCanonicalRoundTrips(
  ccm: CcmV1,
  canonicalJson: string | null,
  contentSha256: string | null,
  sources: Record<string, Uint8Array>,
): void {
  assert.ok(canonicalJson);
  assert.ok(contentSha256);

  const validated = validateCcm(ccm, sources);
  assert.equal(validated.ok, true, validated.ok ? undefined : validated.errorCode);
  const parsed = JSON.parse(canonicalJson) as unknown;
  const parsedValidation = validateCcm(parsed, sources);
  assert.equal(parsedValidation.ok, true, parsedValidation.ok ? undefined : parsedValidation.errorCode);

  const canonical = canonicalizeCcm(parsed, sources);
  assert.equal(canonical.ok, true, canonical.ok ? undefined : canonical.errorCode);
  if (!canonical.ok) return;
  assert.equal(canonical.json, canonicalJson);
  assert.equal(canonical.sha256, contentSha256);
  assert.deepEqual(canonical.value, ccm);

  const ckg = canonicalizeCkg(parsed, sources, configurationHash);
  assert.equal(ckg.ok, true, ckg.ok ? undefined : ckg.errorCode);
  if (!ckg.ok) return;
  assert.deepEqual(ckg.value.ccm, canonical.value, "the CKG wrapper must preserve the canonical CCM exactly");
  const replay = parseCanonicalCkg(ckg.json, sources, ckg.sha256);
  assert.deepEqual(replay, ckg);

  const reorderedCcm: CcmV1 = {
    ...ccm,
    files: [...ccm.files].reverse(),
    nodes: [...ccm.nodes].reverse(),
    edges: [...ccm.edges].reverse(),
    limitations: [...ccm.limitations].reverse(),
  };
  const reorderedCkg = canonicalizeCkg(reorderedCcm, sources, configurationHash);
  assert.equal(reorderedCkg.ok, true, reorderedCkg.ok ? undefined : reorderedCkg.errorCode);
  if (reorderedCkg.ok) {
    assert.equal(reorderedCkg.json, ckg.json);
    assert.equal(reorderedCkg.sha256, ckg.sha256);
  }
}

test("TypeScript aliases and enums stay explicit limitations beside supported declarations", () => {
  const result = analyzeJavaScript({ snapshot, sources: typescriptSources });
  assert.ok(result.ccm, result.errorCode ?? "missing CCM");
  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, null);
  const ccm = result.ccm;

  assert.equal(ccm.nodes.find((node) => node.kind === "Class" && node.qualifiedName === `${typescriptPath}.SupportedService`)?.origin, "source");
  assert.equal(ccm.nodes.find((node) => node.kind === "Method" && node.qualifiedName === `${typescriptPath}.SupportedService.handle`)?.origin, "source");
  assert.equal(ccm.nodes.find((node) => node.kind === "Function" && node.qualifiedName === `${typescriptPath}.supportedFunction`)?.origin, "source");
  assertNoUnsupportedSourceNodes(ccm, ["AliasPayload", "DeferredMode", "Ready", "Failed"]);
  assertNoOrphanNodes(ccm);
  assertExpectedLimitations(ccm, [
    { path: typescriptPath, stage: "declarations", reason: "Type alias declarations are outside the current CCM declaration subset and were omitted." },
    { path: typescriptPath, stage: "declarations", reason: "Enum declarations are outside the current CCM declaration subset and were omitted." },
  ]);
  assertUnsupportedReferencesAreNotExact(ccm, typescriptSources, ["AliasPayload", "DeferredMode"]);
  assertCanonicalRoundTrips(ccm, result.canonicalJson, result.contentSha256, typescriptSources);

  const reversedSources = reverseRecord(typescriptSources);
  const reversed = analyzeJavaScript({ snapshot, sources: reversedSources });
  assert.ok(reversed.ccm, reversed.errorCode ?? "missing CCM for reversed source order");
  assert.equal(reversed.canonicalJson, result.canonicalJson);
  assert.equal(reversed.contentSha256, result.contentSha256);
});

test("PHP traits and enums stay explicit limitations beside supported declarations", async () => {
  const result = await analyzePhp({ snapshot, sources: phpSources });
  assert.ok(result.ccm, result.errorCode ?? "missing CCM");
  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, null);
  const ccm = result.ccm;

  assert.equal(ccm.nodes.find((node) => node.kind === "Class" && node.qualifiedName === "Taxonomy\\SupportedService")?.origin, "source");
  assert.equal(ccm.nodes.find((node) => node.kind === "Method" && node.qualifiedName === "Taxonomy\\SupportedService::status")?.origin, "source");
  assert.equal(ccm.nodes.find((node) => node.kind === "Function" && node.qualifiedName === "Taxonomy\\supportedFunction")?.origin, "source");
  assertNoUnsupportedSourceNodes(ccm, ["DeferredTrait", "DeferredStatus", "fromTrait", "fromEnum", "Ready", "Failed"]);
  assertNoOrphanNodes(ccm);
  assertExpectedLimitations(ccm, [
    { path: phpPath, stage: "declarations", reason: "Trait declarations are outside this adapter subset and were omitted." },
    { path: phpPath, stage: "declarations", reason: "Enum declarations are outside this adapter subset and were omitted." },
    { path: phpPath, stage: "declarations", reason: "Trait composition is not resolved by this declaration adapter." },
  ]);
  assertUnsupportedReferencesAreNotExact(ccm, phpSources, ["DeferredStatus", "DeferredTrait"]);
  assertCanonicalRoundTrips(ccm, result.canonicalJson, result.contentSha256, phpSources);

  const reversedSources = reverseRecord(phpSources);
  const reversed = await analyzePhp({ snapshot, sources: reversedSources });
  assert.ok(reversed.ccm, reversed.errorCode ?? "missing CCM for reversed source order");
  assert.equal(reversed.canonicalJson, result.canonicalJson);
  assert.equal(reversed.contentSha256, result.contentSha256);
});
