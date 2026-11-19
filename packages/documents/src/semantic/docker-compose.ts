import { posix } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";
import type { EvidenceSpan } from "@sage/contracts";
import { emptyFragment, evidenceSpan, semanticEdgeId, semanticNode } from "./builder.ts";
import type { SemanticEdge, SemanticFragment, SemanticInput } from "./model.ts";

const MAX_COMPOSE_BYTES = 1_048_576;
const MAX_SOURCE_BYTES = 524_288;
const COMPOSE_PATH = /(?:^|\/)(?:docker-compose|compose)(?:\.[^.]+)?\.ya?ml$/iu;
const SOURCE_PATH = /\.[cm]?[jt]sx?$|\.py$/iu;

type Source = { path: string; bytes: Uint8Array; text: string };
type RuntimeService = { name: string; context: string; nodeId: string; evidence: EvidenceSpan[]; environment: Array<{ name: string; value: string; evidence: EvidenceSpan }> };
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeSpan(source: Source, node: Node | null | undefined, role: EvidenceSpan["role"]): EvidenceSpan | null {
  const range = node?.range;
  return range ? evidenceSpan(source.path, source.bytes, range[0], Math.max(range[0] + 1, range[1]), role) : null;
}

function normalizeContext(value: string): string | null {
  if (!value.trim() || value.includes("${") || value.startsWith("/") || /^[a-z]+:\/\//iu.test(value)) return null;
  const normalized = posix.normalize(value.replaceAll("\\", "/").trim()).replace(/^\.\//u, "");
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized || ".";
}

function componentLabel(serviceName: string): string {
  const known: Record<string, string> = { api: "API", app: "Application", nlp: "NLP", ui: "UI", web: "Web" };
  return known[serviceName.toLowerCase()] ?? serviceName.replace(/[-_]+/gu, " ").replace(/^\p{L}/u, letter => letter.toLocaleUpperCase("id-ID"));
}

function environmentValues(source: Source, serviceNode: Node): RuntimeService["environment"] {
  if (!isMap(serviceNode)) return [];
  const envNode = serviceNode.get("environment", true);
  const values: RuntimeService["environment"] = [];
  if (isMap(envNode)) {
    for (const pair of envNode.items) {
      if (!isScalar(pair.key)) continue;
      const name = String(pair.key.value ?? "");
      const valueNode = pair.value;
      const value = isScalar(valueNode) ? valueNode.value : undefined;
      const evidence = nodeSpan(source, pair.key, "reference");
      if (name && typeof value === "string" && evidence) values.push({ name, value, evidence });
    }
  } else if (isSeq(envNode)) {
    for (const item of envNode.items) {
      if (!isScalar(item) || typeof item.value !== "string") continue;
      const separator = item.value.indexOf("=");
      if (separator <= 0) continue;
      const evidence = nodeSpan(source, item, "reference");
      if (evidence) values.push({ name: item.value.slice(0, separator), value: item.value.slice(separator + 1), evidence });
    }
  }
  return values;
}

function serviceRuntimeHint(config: RecordValue): boolean {
  const restart = config.restart;
  const restartEnabled = typeof restart === "string" && !["no", "false"].includes(restart.toLowerCase()) || restart === true;
  const hasNetworkOrHealthSurface = ["ports", "expose"].some(key => Array.isArray(config[key]) ? config[key].length > 0 : typeof config[key] === "string") || record(config.healthcheck);
  return restartEnabled || hasNetworkOrHealthSurface;
}

function readComposeServices(source: Source, fragment: SemanticFragment): RuntimeService[] {
  const document = parseDocument(source.text, { uniqueKeys: true });
  if (document.errors.length) {
    fragment.limitations.push({ filePath: source.path, reason: "Docker Compose YAML could not be parsed safely; no deployment component or service interaction was inferred." });
    return [];
  }
  const services = document.get("services", true);
  if (!isMap(services)) return [];

  const parsed: RuntimeService[] = [];
  for (const pair of services.items) {
    if (!isScalar(pair.key) || !isMap(pair.value)) continue;
    const name = String(pair.key.value ?? "");
    const config = pair.value.toJSON();
    if (!name || !record(config) || !serviceRuntimeHint(config)) continue;
    const rawBuild = config.build;
    const rawContext = typeof rawBuild === "string" ? rawBuild : record(rawBuild) ? (rawBuild.context ?? ".") : null;
    if (typeof rawContext !== "string") continue;
    const context = normalizeContext(rawContext);
    if (!context) {
      fragment.limitations.push({ filePath: source.path, reason: `Docker Compose service ${name} uses a dynamic or external build context; its source ownership was not inferred.` });
      continue;
    }
    const keyEvidence = nodeSpan(source, pair.key, "declaration");
    if (!keyEvidence) continue;
    const id = semanticNode({ kind: "component", filePath: source.path, startByte: keyEvidence.startByte,
      key: `compose-application:${name}:${context}`, label: componentLabel(name), featureId: null, confidence: "proven",
      reason: `Docker Compose declares an application service with buildContext=${context}; configuration does not prove current runtime availability.`,
      evidence: [keyEvidence] });
    fragment.nodes.push(id);
    parsed.push({ name, context, nodeId: id.id, evidence: [keyEvidence], environment: environmentValues(source, pair.value) });
  }
  if (parsed.length) fragment.frameworks.push("Docker Compose");
  return parsed;
}

function sourceWithinContext(path: string, context: string): boolean {
  return context === "." || path === context || path.startsWith(`${context}/`);
}

function environmentUseAndHttp(source: Source, name: string): EvidenceSpan[] | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(`process\\.env(?:\\.${escaped}|\\[\\s*["']${escaped}["']\\s*\\])`, "u"),
    new RegExp(`(?:os\\.getenv|os\\.environ\\.get)\\s*\\(\\s*["']${escaped}["']`, "u"),
    new RegExp(`os\\.environ\\s*\\[\\s*["']${escaped}["']\\s*\\]`, "u"),
  ];
  const use = patterns.map(pattern => pattern.exec(source.text)).find((match): match is RegExpExecArray => Boolean(match));
  const request = /\bfetch\s*\(|\b(?:requests|httpx)\.(?:request|get|post|put|patch|delete)\s*\(/iu.exec(source.text);
  if (!use || !request) return null;
  return [
    evidenceSpan(source.path, source.bytes, use.index, use.index + use[0].length, "reference"),
    evidenceSpan(source.path, source.bytes, request.index, request.index + request[0].length, "reference"),
  ];
}

function configuredHost(value: string): string | null {
  const url = value.match(/https?:\/\/([a-z0-9][a-z0-9._-]*)(?::\d+)?(?:\/|$)/iu);
  return url?.[1]?.toLowerCase() ?? null;
}

function addConfiguredHttpEdges(sources: Source[], services: RuntimeService[], fragment: SemanticFragment): void {
  const serviceByName = new Map(services.map(service => [service.name.toLowerCase(), service]));
  for (const sourceService of services) {
    for (const entry of sourceService.environment) {
      const host = configuredHost(entry.value);
      const targetService = host ? serviceByName.get(host) : undefined;
      if (!targetService || targetService.nodeId === sourceService.nodeId) continue;
      const callers = sources.filter(source => SOURCE_PATH.test(source.path) && sourceWithinContext(source.path, sourceService.context))
        .map(source => ({ source, evidence: environmentUseAndHttp(source, entry.name) }))
        .filter((item): item is { source: Source; evidence: EvidenceSpan[] } => Boolean(item.evidence))
        .slice(0, 3);
      if (!callers.length) continue;
      const evidence = [entry.evidence, ...callers.flatMap(caller => caller.evidence), ...targetService.evidence];
      const edge: SemanticEdge = {
        id: semanticEdgeId(entry.evidence.filePath, entry.evidence.startByte, `compose-http:${sourceService.name}:${entry.name}:${targetService.name}`),
        source: sourceService.nodeId,
        target: targetService.nodeId,
        label: `HTTP request using ${entry.name}`,
        confidence: "proven",
        reason: `Docker Compose configures ${entry.name} to resolve to service ${targetService.name}, and source code reads that variable before issuing an HTTP request. This proves a configured integration path, not live traffic or availability.`,
        evidence,
      };
      fragment.edges.push(edge);
    }
  }
}

/** Extract only long-running, build-backed application services and explicit config-to-code HTTP links. */
export function extractDockerCompose(input: SemanticInput): SemanticFragment {
  const fragment = emptyFragment();
  const sourceFiles = Object.entries(input.sources)
    .filter(([path, bytes]) => SOURCE_PATH.test(path) && bytes.byteLength <= MAX_SOURCE_BYTES)
    .map(([path, bytes]) => ({ path, bytes, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const composeSources = Object.entries(input.sources)
    .filter(([path, bytes]) => COMPOSE_PATH.test(path) && bytes.byteLength <= MAX_COMPOSE_BYTES)
    .map(([path, bytes]) => ({ path, bytes, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const services = new Map<string, RuntimeService>();
  for (const source of composeSources) {
    const parsed = readComposeServices(source, fragment);
    for (const service of parsed) {
      const key = `${service.name.toLowerCase()}\0${service.context}`;
      const existing = services.get(key);
      if (existing) {
        const duplicate = fragment.nodes.find(node => node.id === existing.nodeId);
        if (duplicate) duplicate.evidence = [...duplicate.evidence, ...service.evidence];
        existing.environment.push(...service.environment);
      } else services.set(key, service);
    }
  }
  if (services.size) addConfiguredHttpEdges(sourceFiles, [...services.values()], fragment);
  return fragment;
}
