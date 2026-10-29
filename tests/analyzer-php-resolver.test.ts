import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReferences } from "@sage/analyzer-php";
import { validateCcm, type CcmEdge } from "@sage/contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const snapshot = {
  repository: "owner/php-resolver-fixture",
  branch: "main",
  commitSha: "1234567890abcdef1234567890abcdef12345678",
};

function edgeTo(ccm: NonNullable<Awaited<ReturnType<typeof analyzeReferences>>["ccm"]>, kind: string, qualifiedName: string) {
  return ccm.edges.filter((edge) => edge.kind === kind && ccm.nodes.find((node) => node.id === edge.targetId)?.qualifiedName === qualifiedName);
}

function edgesFrom(ccm: NonNullable<Awaited<ReturnType<typeof analyzeReferences>>["ccm"]>, kind: string, qualifiedName: string) {
  return ccm.edges.filter((edge) => edge.kind === kind && ccm.nodes.find((node) => node.id === edge.sourceId)?.qualifiedName === qualifiedName);
}

const contracts = `<?php
namespace Resolver\\Contracts;
interface Payload {}
class Base { public function inherited(): string { return 'base'; } }
function describe(string $value): string { return $value; }
`;

const app = `<?php
namespace Resolver\\App;
use Resolver\\Contracts\\{Base, Payload, function describe};
class Endpoint extends Base implements Payload {
    public function value(): string { return describe('café'); }
}
function uncertain(object $input): mixed { return $input->run(); }
describe('module', 'value');
throw new \\RuntimeException('parse-only canary');
`;

const composer = `{
  "autoload": { "psr-4": { "Resolver\\\\": "src/" } }
}`;

test("PHP resolver resolves grouped aliases, inheritance, interfaces, function calls and honest unknown receivers", async () => {
  const sources = {
    "src/contracts.php": encoder.encode(contracts),
    "src/app.php": encoder.encode(app),
  };
  const result = await analyzeReferences({
    snapshot,
    sources,
    configurationSources: { "composer.json": encoder.encode(composer) },
  });
  assert.equal(result.status, "partial", "unresolved dynamic receiver remains visible");
  assert.ok(result.ccm);
  assert.equal(result.errorCode, null);
  assert.equal(validateCcm(result.ccm, sources).ok, true);

  const endpoint = result.ccm.nodes.find((node) => node.kind === "Class" && node.qualifiedName === "Resolver\\App\\Endpoint");
  const value = result.ccm.nodes.find((node) => node.kind === "Method" && node.qualifiedName === "Resolver\\App\\Endpoint::value");
  const functionCall = edgeTo(result.ccm, "CALLS", "Resolver\\Contracts\\describe").find((edge) => {
    return result.ccm?.nodes.find((node) => node.id === edge.sourceId)?.qualifiedName === "Resolver\\App\\Endpoint::value";
  });
  assert.ok(endpoint && value && functionCall);
  assert.equal(edgesFrom(result.ccm, "EXTENDS", endpoint.qualifiedName)[0]?.resolution, "Exact");
  assert.equal(edgeTo(result.ccm, "IMPLEMENTS", "Resolver\\Contracts\\Payload")[0]?.resolution, "Exact");
  assert.equal(functionCall.resolution, "Exact");
  assert.equal(functionCall.evidence[0]?.role, "reference");
  const callSnippet = decoder.decode(sources["src/app.php"]!.subarray(functionCall.evidence[0]!.startByte, functionCall.evidence[0]!.endByte));
  assert.equal(callSnippet, "describe");

  const imports = result.ccm.edges.filter((edge) => edge.kind === "IMPORTS");
  assert.equal(imports.length, 3);
  assert.ok(imports.every((edge) => edge.resolution === "Exact"));
  assert.ok(imports.every((edge) => result.ccm?.nodes.find((node) => node.id === edge.sourceId)?.qualifiedName === "src/app.php#namespace:Resolver\\App"));
  const baseImport = imports.find((edge) => result.ccm?.nodes.find((node) => node.id === edge.targetId)?.qualifiedName === "Resolver\\Contracts\\Base");
  assert.ok(baseImport);
  assert.equal(decoder.decode(sources["src/app.php"]!.subarray(baseImport.evidence[0]!.startByte, baseImport.evidence[0]!.endByte)), "Base");
  assert.ok(result.ccm.edges.some((edge) => edge.kind === "CALLS" && edge.resolution === "Exact" &&
    result.ccm?.nodes.find((node) => node.id === edge.sourceId)?.qualifiedName === "src/app.php#namespace:Resolver\\App" &&
    result.ccm?.nodes.find((node) => node.id === edge.targetId)?.qualifiedName === "Resolver\\Contracts\\describe"));

  const unknown = result.ccm.edges.find((edge) => edge.kind === "CALLS" && edge.resolution === "Unresolved" && edge.unresolvedReason === "UNKNOWN_RECEIVER");
  assert.ok(unknown);
  const unknownTarget = result.ccm.nodes.find((node) => node.id === unknown.targetId);
  assert.equal(unknownTarget?.qualifiedName, "$input->run()");
  assert.equal(result.ccm.nodes.find((node) => node.id === unknown.sourceId)?.qualifiedName, "Resolver\\App\\uncertain");
  assert.equal(result.ccm.provenance.resolver.version, "0.3.0");
});

test("PHP resolver marks missing imports and dynamic calls unresolved with reference evidence", async () => {
  const source = `<?php
namespace Missing\\UseCase;
use Missing\\Package\\NotInstalled;
function build(callable $factory): object { return $factory(); }
`;
  const path = "src/missing.php";
  const bytes = encoder.encode(source);
  const result = await analyzeReferences({ snapshot, sources: { [path]: bytes } });
  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  const missing = result.ccm.edges.find((edge) => edge.kind === "IMPORTS");
  assert.ok(missing);
  assert.equal(missing.resolution, "Unresolved");
  assert.equal(missing.unresolvedReason, "EXTERNAL_DEPENDENCY");
  assert.equal(missing.evidence[0]?.role, "reference");
  const dynamic = result.ccm.edges.find((edge) => edge.kind === "CALLS");
  assert.ok(dynamic);
  assert.equal(dynamic.resolution, "Unresolved");
  assert.equal(dynamic.unresolvedReason, "DYNAMIC_LOAD");
  assert.equal(validateCcm(result.ccm, { [path]: bytes }).ok, true);
});

test("PHP resolver gives same-spelled class and function placeholders distinct node identities", async () => {
  const source = `<?php
namespace PlaceholderKinds;
use Missing\\Shared;
use function Missing\\Shared;
`;
  const path = "src/placeholders.php";
  const bytes = encoder.encode(source);
  const result = await analyzeReferences({ snapshot, sources: { [path]: bytes } });
  assert.ok(result.ccm);
  const unresolvedTargets = result.ccm.edges.filter((edge) => edge.kind === "IMPORTS" && edge.resolution === "Unresolved")
    .map((edge) => result.ccm?.nodes.find((node) => node.id === edge.targetId)).filter((node) => node?.kind === "UnresolvedReference");
  assert.equal(unresolvedTargets.length, 2);
  assert.notEqual(unresolvedTargets[0]?.id, unresolvedTargets[1]?.id);
  assert.notEqual(unresolvedTargets[0]?.qualifiedName, unresolvedTargets[1]?.qualifiedName);
  assert.equal(validateCcm(result.ccm, { [path]: bytes }).ok, true);
});

test("PHP resolver creates property nodes only in resolver mode and resolves safe final members", async () => {
  const source = `<?php
namespace Members;
final class Store {
    public int $count = 0;
    public static int $hits = 0;
    public function increment(): int { $this->count = $this->count + 1; $this->count += 1; ++$this->count; self::$hits = self::$hits + 1; self::$hits += 1; self::$hits++; return $this->count + self::$hits; }
    public static function bump(): int { return self::current(); }
    public static function current(): int { return self::$hits; }
    public function dynamicStatic(string $name): mixed { return self::$$name; }
    public function mutateReference(int &$value): void { $this->count =& $value; unset($this->count); }
}
`;
  const path = "src/store.php";
  const bytes = encoder.encode(source);
  const sources = { [path]: bytes };
  const result = await analyzeReferences({
    snapshot,
    sources,
    configurationSources: { "composer.json": encoder.encode('{"autoload":{"psr-4":{"Members\\\\":"src/"}}}') },
  });
  assert.equal(result.status, "partial", "a dynamic static-property name remains unresolved");
  assert.ok(result.ccm);
  assert.equal(validateCcm(result.ccm, sources).ok, true);
  const property = result.ccm.nodes.find((node) => node.kind === "Property" && node.qualifiedName === "Members\\Store.count");
  const staticProperty = result.ccm.nodes.find((node) => node.kind === "Property" && node.qualifiedName === "Members\\Store.hits");
  assert.ok(property);
  assert.ok(staticProperty);
  assert.equal(property.parentId, result.ccm.nodes.find((node) => node.kind === "Class" && node.qualifiedName === "Members\\Store")?.id);
  const propertyEdges = result.ccm.edges.filter((edge) => edge.kind === "READS" || edge.kind === "WRITES");
  assert.equal(propertyEdges.length, 18);
  assert.equal(propertyEdges.filter((edge) => edge.targetId === property.id).length, 9);
  assert.equal(propertyEdges.filter((edge) => edge.targetId === staticProperty.id).length, 8);
  assert.ok(propertyEdges.filter((edge) => edge.resolution === "Exact").every((edge) => edge.evidence[0]?.role === "reference"));
  const dynamicProperty = result.ccm.edges.find((edge) => edge.kind === "READS" && edge.sourceId === result.ccm?.nodes.find((node) => node.qualifiedName === "Members\\Store::dynamicStatic")?.id);
  assert.ok(dynamicProperty);
  assert.equal(dynamicProperty.resolution, "Unresolved");
  assert.equal(dynamicProperty.unresolvedReason, "UNSUPPORTED_CONSTRUCT");
  const staticCall = result.ccm.edges.find((edge) => edge.kind === "CALLS" && result.ccm?.nodes.find((node) => node.id === edge.sourceId)?.qualifiedName === "Members\\Store::bump");
  assert.ok(staticCall);
  assert.equal(staticCall.resolution, "Exact");
  assert.equal(result.ccm.nodes.find((node) => node.id === staticCall.targetId)?.qualifiedName, "Members\\Store::current");
});

test("PHP resolver keeps conservative dispatch for open, union, loop, closure, and duplicate receivers", async () => {
  const source = `<?php
namespace Dispatch;
class Open { public function run(): void {} }
final class Sealed { public function run(): void {} }
class Child extends Open { public function call(): void { $this->run(); } }
function union(Open|Sealed $target): void { $target->run(); }
function scalarUnion(Open|string $target): void { $target->run(); }
function reassigned(Open $target): void { $target = new Sealed(); $target->run(); }
function foreachReassigned(Open $target, array $items): void { foreach ($items as $target) {} $target->run(); }
function closureReassigned(Open $target): void { $mutator = function () use (&$target) { $target = new Sealed(); }; $target->run(); }
final class Duplicate {}
final class Duplicate {}
function construct(): object { return new Duplicate(); }
function typed(Sealed $target): void { $target->run(); }
`;
  const path = "src/dispatch.php";
  const bytes = encoder.encode(source);
  const result = await analyzeReferences({ snapshot, sources: { [path]: bytes } });
  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  assert.equal(validateCcm(result.ccm, { [path]: bytes }).ok, true);

  const childCall = edgesFrom(result.ccm, "CALLS", "Dispatch\\Child::call")[0];
  assert.ok(childCall);
  assert.equal(childCall.resolution, "Unresolved");
  assert.equal(childCall.unresolvedReason, "AMBIGUOUS_SYMBOL");
  const rebound = edgesFrom(result.ccm, "CALLS", "Dispatch\\reassigned")[0];
  assert.ok(rebound);
  assert.equal(rebound.resolution, "Exact", "a direct straight-line assignment replaces the declared receiver type");
  assert.equal(result.ccm.nodes.find((node) => node.id === rebound.targetId)?.qualifiedName, "Dispatch\\Sealed::run");
  for (const functionName of ["union", "scalarUnion", "foreachReassigned", "closureReassigned"]) {
    const call = edgesFrom(result.ccm, "CALLS", `Dispatch\\${functionName}`).find((edge) => edge.resolution !== "Exact");
    assert.ok(call, `${functionName} receiver remains unresolved`);
  }
  const duplicate = edgesFrom(result.ccm, "INSTANTIATES", "Dispatch\\construct")[0];
  assert.ok(duplicate);
  assert.equal(duplicate.resolution, "Unresolved");
  assert.equal(duplicate.unresolvedReason, "AMBIGUOUS_SYMBOL");
  const typed = edgesFrom(result.ccm, "CALLS", "Dispatch\\typed")[0];
  assert.ok(typed);
  assert.equal(typed.resolution, "Exact", "a unique final receiver type allows exact local method resolution");
});

test("PHP resolver tracks straight-line local new bindings and rejects unsafe aliases", async () => {
  const source = `<?php
namespace LocalBindings;
final class Sealed { public function run(): void {} }
class Open { public function run(): void {} }
class Duplicate { public function run(): void {} }
class Duplicate { public function run(): void {} }
final class Other { public function run(): void {} }
final class Replacer { public function replace(&$value): void { $value = new Other(); } }
function direct(): void { $target = new Sealed(); $target->run(); }
function reassigned(): void { $target = new Sealed(); $target = make(); $target->run(); }
function conditionalNew(bool $enabled): void { if ($enabled) { $target = new Sealed(); } $target->run(); }
function conditionalReassignment(bool $enabled): void { $target = new Sealed(); if ($enabled) { $target = new Open(); } $target->run(); }
function coalesceNew(): void { $flag = true; $flag ??= ($target = new Sealed()); $target->run(); }
function replace(&$value): void { $value = new Other(); }
function inspectByValue(Sealed $value): void {}
function byReferenceFunction(): void { $target = new Sealed(); replace($target); $target->run(); }
function byReferenceMethod(): void { $replacer = new Replacer(); $target = new Sealed(); $replacer->replace($target); $target->run(); }
function nullsafeByReference(?Replacer $replacer): void { $target = new Sealed(); $replacer?->replace($target); $target->run(); }
function byValueFunction(): void { $target = new Sealed(); inspectByValue($target); $target->run(); }
function unknownExternalFunction(): void { $target = new Sealed(); externalReplace($target); $target->run(); }
function referenceAlias(): void { $target = new Sealed(); $alias =& $target; $target->run(); }
function aliasReinitialized(): void { $alias =& $target; $target = new Sealed(); $alias = new Open(); $target->run(); }
function loopReassignment(array $targets): void { $target = new Sealed(); foreach ($targets as &$target) {} $target->run(); }
function closureReassignment(): void { $target = new Sealed(); $mutator = function () use (&$target) { $target = new Open(); }; $target->run(); }
function openConstruction(): void { $target = new Open(); $target->run(); }
function duplicateConstruction(): void { $target = new Duplicate(); $target->run(); }
final class Client { public function direct(): void { $target = new Sealed(); $target->run(); } }
`;
  const path = "src/local-bindings.php";
  const bytes = encoder.encode(source);
  const result = await analyzeReferences({ snapshot, sources: { [path]: bytes } });
  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  assert.equal(validateCcm(result.ccm, { [path]: bytes }).ok, true);

  const direct = edgesFrom(result.ccm, "CALLS", "LocalBindings\\direct")[0];
  assert.ok(direct);
  assert.equal(direct.resolution, "Exact");
  assert.equal(result.ccm.nodes.find((node) => node.id === direct.targetId)?.qualifiedName, "LocalBindings\\Sealed::run");
  const methodDirect = edgesFrom(result.ccm, "CALLS", "LocalBindings\\Client::direct")[0];
  assert.ok(methodDirect);
  assert.equal(methodDirect.resolution, "Exact");
  const byValue = edgesFrom(result.ccm, "CALLS", "LocalBindings\\byValueFunction").find((edge) => edge.targetId === result.ccm?.nodes.find((node) => node.qualifiedName === "LocalBindings\\Sealed::run")?.id);
  assert.ok(byValue);
  assert.equal(byValue.resolution, "Exact", "a known by-value callee does not taint its argument");

  for (const functionName of ["reassigned", "conditionalNew", "conditionalReassignment", "coalesceNew", "byReferenceFunction", "byReferenceMethod", "nullsafeByReference", "unknownExternalFunction", "referenceAlias", "aliasReinitialized", "loopReassignment", "closureReassignment"]) {
    const call = edgesFrom(result.ccm, "CALLS", `LocalBindings\\${functionName}`).find((edge) => edge.unresolvedReason === "UNKNOWN_RECEIVER");
    assert.ok(call, `${functionName} receiver remains unresolved`);
  }

  const open = edgesFrom(result.ccm, "CALLS", "LocalBindings\\openConstruction")[0];
  assert.ok(open);
  assert.equal(open.resolution, "Unresolved", "constructing an open class does not seal instance dispatch");
  assert.equal(open.unresolvedReason, "AMBIGUOUS_SYMBOL");
  const duplicate = edgesFrom(result.ccm, "CALLS", "LocalBindings\\duplicateConstruction")[0];
  assert.ok(duplicate);
  assert.equal(duplicate.resolution, "Unresolved");
  assert.equal(duplicate.unresolvedReason, "AMBIGUOUS_SYMBOL");
});

test("PHP resolver does not mark inaccessible private or protected members Exact", async () => {
  const source = `<?php
namespace Visibility;
class Base {
    private int $secret = 0;
    protected int $limit = 0;
    private function hidden(): void {}
    protected function protectedWork(): void {}
    private static function hiddenStatic(): void {}
    protected static function protectedStatic(): void {}
}
final class Child extends Base {
    public function privateViaThis(): void { $this->hidden(); }
    public function privateViaParent(): void { parent::hidden(); }
    public function protectedViaThis(): void { $this->protectedWork(); }
    public function protectedProperty(): int { return $this->limit; }
}
function outside(Base $base): void {
    $base->hidden();
    $base->protectedWork();
    Base::hiddenStatic();
    Base::protectedStatic();
    $base->secret;
    $base->limit;
}
`;
  const path = "src/visibility.php";
  const bytes = encoder.encode(source);
  const result = await analyzeReferences({ snapshot, sources: { [path]: bytes } });
  assert.ok(result.ccm);
  assert.equal(validateCcm(result.ccm, { [path]: bytes }).ok, true);
  for (const method of ["privateViaThis", "privateViaParent"]) {
    const privateCallEdge: CcmEdge | undefined = edgesFrom(result.ccm, "CALLS", `Visibility\\Child::${method}`)[0];
    assert.ok(privateCallEdge);
    assert.equal(privateCallEdge.resolution, "Unresolved");
  }
  const protectedCall = edgesFrom(result.ccm, "CALLS", "Visibility\\Child::protectedViaThis")[0];
  assert.ok(protectedCall);
  assert.equal(protectedCall.resolution, "Exact");
  const outsideCalls = edgesFrom(result.ccm, "CALLS", "Visibility\\outside");
  assert.equal(outsideCalls.length, 4);
  assert.ok(outsideCalls.every((edge) => edge.resolution === "Unresolved"));
  const protectedProperty = edgesFrom(result.ccm, "READS", "Visibility\\Child::protectedProperty")[0];
  assert.ok(protectedProperty);
  assert.equal(protectedProperty.resolution, "Exact");
  const outsidePropertyReads = edgesFrom(result.ccm, "READS", "Visibility\\outside");
  assert.equal(outsidePropertyReads.length, 2);
  assert.ok(outsidePropertyReads.every((edge) => edge.resolution === "Unresolved"));
});

test("PHP resolver reuses unresolved symbol nodes across distinct dynamic-dispatch call sites", async () => {
  const source = `<?php
namespace Collision;
class Open {
    public function work(): void {}
    public function onThis(): void { $this->work(); }
    public function onTyped(Open $other): void { $other->work(); }
}
`;
  const path = "src/collision.php";
  const bytes = encoder.encode(source);
  const result = await analyzeReferences({ snapshot, sources: { [path]: bytes } });
  assert.ok(result.ccm);
  const unresolved = result.ccm.edges.filter((edge) => edge.kind === "CALLS" && edge.resolution === "Unresolved" && edge.unresolvedReason === "AMBIGUOUS_SYMBOL");
  assert.equal(unresolved.length, 2);
  assert.equal(result.ccm.nodes.filter((node) => node.kind === "UnresolvedReference" && node.qualifiedName === "Collision\\Open::work").length, 1);
  assert.equal(validateCcm(result.ccm, { [path]: bytes }).ok, true);
});

test("PHP resolver canonical output is replay-stable and uses exact UTF-8 byte evidence", async () => {
  const source = `\uFEFF<?php\r\nfinal class Source {}\r\nfinal class Client { public function créer(): Source { return new Source(); } }\r\n`;
  const bytes = encoder.encode(source);
  const path = "src/unicode.php";
  const entries = [[path, bytes], ["src/empty.php", encoder.encode("<?php\n")]] as const;
  const first = await analyzeReferences({ snapshot, sources: Object.fromEntries(entries) });
  const second = await analyzeReferences({ snapshot, sources: Object.fromEntries([...entries].reverse()) });
  assert.equal(first.status, "complete", "local declaration evidence does not require optional Composer hints");
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.contentSha256, second.contentSha256);
  assert.ok(first.ccm);
  const edge = edgeTo(first.ccm, "INSTANTIATES", "Source")[0];
  assert.ok(edge);
  const evidence = edge.evidence[0]!;
  assert.equal(decoder.decode(bytes.subarray(evidence.startByte, evidence.endByte)), "Source");
  assert.equal(evidence.role, "reference");
  assert.equal(validateCcm(first.ccm, Object.fromEntries(entries)).ok, true);
});

test("PHP resolver snapshots source, config, and snapshot identity before awaiting the parser", async () => {
  const source = encoder.encode("<?php namespace Snapshot; final class Ready {} function make(): object { return new Ready(); }");
  const composerBytes = encoder.encode('{"autoload":{"psr-4":{"Snapshot\\\\":"src/"}}}');
  const promise = analyzeReferences({
    snapshot: { ...snapshot },
    sources: { "src/ready.php": source },
    configurationSources: { "composer.json": composerBytes },
  });
  source.fill(0);
  composerBytes.fill(0);
  const result = await promise;
  assert.equal(result.status, "complete");
  assert.ok(result.ccm);
  assert.ok(result.ccm.edges.some((edge) => edge.kind === "INSTANTIATES" && edge.resolution === "Exact"));
  assert.equal(validateCcm(result.ccm, { "src/ready.php": encoder.encode("<?php namespace Snapshot; final class Ready {} function make(): object { return new Ready(); }") }).ok, true);
});
