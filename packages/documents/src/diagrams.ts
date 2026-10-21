import {
  parseCanonicalCkg,
  type CcmEdge,
  type CcmLimitation,
  type CcmNode,
  type CcmProvenance,
  type CcmSnapshot,
  type EvidenceSpan,
  type CkgCounts,
} from "@sage/contracts";

export interface DiagramProjection {
  kind: "uml-class" | "software-structure";
  title: string;
  mermaid: string;
  nodes: CcmNode[];
  edges: CcmEdge[];
  nodeMappings: DiagramNodeMapping[];
  edgeMappings: DiagramEdgeMapping[];
  excludedNodeIds: string[];
  excludedEdgeIds: string[];
}

export interface DiagramNodeMapping {
  nodeId: string;
  mermaidId: string | null;
  mermaidLine: number;
  parentMermaidId?: string;
  parentContainmentEdgeIds?: string[];
  evidence: EvidenceSpan | null;
}

export interface DiagramEdgeMapping {
  edgeId: string;
  mermaidLine: number;
  sourceMermaidId: string;
  targetMermaidId: string;
  evidence: EvidenceSpan[];
}

export interface DiagramBundle {
  schemaVersion: "sage-diagrams-v1";
  ckgSha256: string;
  snapshot: CcmSnapshot;
  provenance: CcmProvenance;
  configurationHash: string;
  canonicalCounts: CkgCounts;
  limitations: CcmLimitation[];
  diagrams: [uml: DiagramProjection, structure: DiagramProjection];
}

export type DiagramProjectionResult =
  | { ok: true; value: DiagramBundle }
  | { ok: false; errorCode: string };

const CLASSIFIER_KINDS = new Set<CcmNode["kind"]>(["Class", "Interface"]);
const UML_RELATION_KINDS = new Set<CcmEdge["kind"]>(["EXTENDS", "IMPLEMENTS"]);
const MERMAID_ESCAPED_CHARACTERS = new Set(Array.from("\"'&<>[]{}|#;(){}+-~@`\\"));

/** Keep ordinary label text readable and entity-escape Mermaid/XML delimiters deterministically. */
function mermaidText(value: string): string {
  let encoded = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
      encoded += `#${codePoint};`;
      continue;
    }
    // XML 1.0 cannot represent NUL, most controls, noncharacters, or unpaired UTF-16 surrogates.
    // Keep these facts visible as literal escape text rather than losing them or emitting invalid SVG.
    const invalidXmlCharacter = (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint === 0xfffe || codePoint === 0xffff;
    const visible = invalidXmlCharacter
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
    for (const visibleCharacter of visible) {
      const visibleCodePoint = visibleCharacter.codePointAt(0)!;
      if (MERMAID_ESCAPED_CHARACTERS.has(visibleCharacter) ||
          (visibleCodePoint < 0x20 && visibleCodePoint !== 0x09 && visibleCodePoint !== 0x0a && visibleCodePoint !== 0x0d)) {
        encoded += `#${visibleCodePoint};`;
      } else {
        encoded += visibleCharacter;
      }
    }
  }
  return encoded;
}

function nodeDisplayName(node: CcmNode): string {
  return node.qualifiedName || node.name;
}

function nodeAlias(node: CcmNode, classifierIds: ReadonlySet<string>, unresolvedIds: ReadonlySet<string>): string | undefined {
  const digest = node.id.startsWith("node_") ? node.id.slice("node_".length) : node.id;
  if (classifierIds.has(node.id)) return `C_${digest}`;
  if (unresolvedIds.has(node.id)) return `U_${digest}`;
  return undefined;
}

function buildStructureDiagram(nodes: CcmNode[], edges: CcmEdge[]): DiagramProjection {
  const nodeAliasById = new Map(nodes.map(node => [node.id, `N_${node.id.startsWith("node_") ? node.id.slice("node_".length) : node.id}`]));
  const mermaid = ["flowchart LR"];
  const nodeMappings: DiagramNodeMapping[] = [];
  const edgeMappings: DiagramEdgeMapping[] = [];

  for (const node of nodes) {
    const alias = nodeAliasById.get(node.id)!;
    const location = node.location ? ` · ${node.filePath ?? ""}:${node.location.startLine}` : "";
    const moduleKind = node.kind === "Module" && typeof node.attributes.moduleKind === "string"
      ? ` · moduleKind: ${node.attributes.moduleKind}` : "";
    const label = `${node.kind} · ${node.origin} · ${node.language} · ${nodeDisplayName(node)}${moduleKind}${location}`;
    mermaid.push(`  ${alias}["${mermaidText(label)}"]`);
    nodeMappings.push({ nodeId: node.id, mermaidId: alias, mermaidLine: mermaid.length, evidence: node.location });
  }

  for (const edge of edges) {
    const source = nodeAliasById.get(edge.sourceId);
    const target = nodeAliasById.get(edge.targetId);
    // Canonical CKG validation rejects dangling endpoints; keep this defensive check local too.
    if (!source || !target) continue;
    const resolution = edge.resolution === "Exact" ? "Exact" : "Unresolved";
    const reason = edge.unresolvedReason ? ` · ${edge.unresolvedReason}` : "";
    const ownership = edge.kind === "CONTAINS" ? " · ownership only" : "";
    const label = `${edge.kind}${ownership} · ${resolution}${reason}`;
    const arrow = edge.resolution === "Exact" ? "-->" : "-.->";
    mermaid.push(`  ${source} ${arrow}|"${mermaidText(label)}"| ${target}`);
    edgeMappings.push({ edgeId: edge.id, mermaidLine: mermaid.length, sourceMermaidId: source, targetMermaidId: target, evidence: edge.evidence });
  }

  if (nodes.length === 0) mermaid.push("  %% Tidak ada node pada CKG ini");

  return {
    kind: "software-structure",
    title: "Software Structure",
    mermaid: mermaid.join("\n"),
    nodes,
    edges,
    nodeMappings,
    edgeMappings,
    excludedNodeIds: [],
    excludedEdgeIds: [],
  };
}

function buildUmlDiagram(allNodes: CcmNode[], allEdges: CcmEdge[]): DiagramProjection {
  const nodeById = new Map(allNodes.map(node => [node.id, node]));
  const classifiers = allNodes.filter(node => CLASSIFIER_KINDS.has(node.kind));
  const classifierIds = new Set(classifiers.map(node => node.id));
  const members = allNodes.filter(node =>
    (node.kind === "Method" || node.kind === "Property") && node.parentId !== null && classifierIds.has(node.parentId));

  const umlEdges = allEdges.filter(edge => {
    if (!UML_RELATION_KINDS.has(edge.kind)) return false;
    const source = nodeById.get(edge.sourceId);
    const target = nodeById.get(edge.targetId);
    if (!source || !target) return false;
    if (edge.resolution === "Exact") {
      return CLASSIFIER_KINDS.has(source.kind) && CLASSIFIER_KINDS.has(target.kind);
    }
    // An unresolved inheritance/implementation is a dependency observation, never an exact UML relation.
    const sourceCanBeDisplayed = CLASSIFIER_KINDS.has(source.kind) || source.kind === "UnresolvedReference";
    const targetCanBeDisplayed = CLASSIFIER_KINDS.has(target.kind) || target.kind === "UnresolvedReference";
    return sourceCanBeDisplayed && targetCanBeDisplayed &&
      (CLASSIFIER_KINDS.has(source.kind) || CLASSIFIER_KINDS.has(target.kind));
  });

  const umlNodeIds = new Set<string>([...classifierIds]);
  for (const member of members) umlNodeIds.add(member.id);
  for (const edge of umlEdges) {
    const source = nodeById.get(edge.sourceId)!;
    const target = nodeById.get(edge.targetId)!;
    if (source.kind === "UnresolvedReference") umlNodeIds.add(source.id);
    if (target.kind === "UnresolvedReference") umlNodeIds.add(target.id);
  }
  const nodes = allNodes.filter(node => umlNodeIds.has(node.id));
  const unresolved = nodes.filter(node => node.kind === "UnresolvedReference");
  const unresolvedIds = new Set(unresolved.map(node => node.id));
  const membersByParent = new Map<string, CcmNode[]>();
  for (const member of members) {
    const parentId = member.parentId!;
    const items = membersByParent.get(parentId) ?? [];
    items.push(member);
    membersByParent.set(parentId, items);
  }

  const mermaid = ["classDiagram"];
  const nodeMappings: DiagramNodeMapping[] = [];
  const edgeMappings: DiagramEdgeMapping[] = [];
  for (const classifier of classifiers) {
    const alias = nodeAlias(classifier, classifierIds, unresolvedIds)!;
    const stereotype = classifier.kind === "Interface" ? "    <<interface>>" : "";
    const ownMembers = membersByParent.get(classifier.id) ?? [];
    const label = `${classifier.kind} · ${classifier.origin} · ${nodeDisplayName(classifier)}`;
    const declarationLine = mermaid.length + 1;
    const hasBody = Boolean(stereotype) || ownMembers.length > 0;
    mermaid.push(`  class ${alias}["${mermaidText(label)}"]${hasBody ? " {" : ""}`);
    nodeMappings.push({ nodeId: classifier.id, mermaidId: alias, mermaidLine: declarationLine, evidence: classifier.location });
    if (stereotype) mermaid.push(stereotype);
    for (const member of ownMembers) {
      // No visibility or type is inferred; use only the declared signature/name carried by the CKG.
      const category = member.kind === "Method" ? "method" : "property";
      mermaid.push(`    ${category} ${mermaidText(member.signature ?? member.name)}`);
      const parentContainmentEdgeIds = allEdges
        .filter(edge => edge.kind === "CONTAINS" && edge.sourceId === classifier.id && edge.targetId === member.id)
        .map(edge => edge.id);
      nodeMappings.push({ nodeId: member.id, mermaidId: null, mermaidLine: mermaid.length, parentMermaidId: alias,
        parentContainmentEdgeIds, evidence: member.location });
    }
    if (hasBody) mermaid.push("  }");
  }
  for (const placeholder of unresolved) {
    const alias = nodeAlias(placeholder, classifierIds, unresolvedIds)!;
    const label = `UNRESOLVED · ${placeholder.origin} · ${nodeDisplayName(placeholder)}`;
    const declarationLine = mermaid.length + 1;
    mermaid.push(`  class ${alias}["${mermaidText(label)}"] {`);
    nodeMappings.push({ nodeId: placeholder.id, mermaidId: alias, mermaidLine: declarationLine, evidence: placeholder.location });
    mermaid.push("    <<unresolved>>");
    mermaid.push("  }");
  }

  if (classifiers.length === 0) {
    // Mermaid rejects an empty classDiagram; a note gives the empty projection an honest, visible state.
    mermaid.push('  note "Tidak ada deklarasi class atau interface pada CKG ini"');
  }

  for (const edge of umlEdges) {
    const sourceNode = nodeById.get(edge.sourceId)!;
    const targetNode = nodeById.get(edge.targetId)!;
    const sourceAlias = nodeAlias(sourceNode, classifierIds, unresolvedIds);
    const targetAlias = nodeAlias(targetNode, classifierIds, unresolvedIds);
    if (!sourceAlias || !targetAlias) continue;

    let statement: string;
    if (edge.resolution === "Exact") {
      // CCM inheritance/implementation facts point from the derived class to its base/interface.
      const relation = edge.kind === "EXTENDS" ? "<|--" : "<|..";
      statement = `  ${targetAlias} ${relation} ${sourceAlias} : ${edge.kind}`;
    } else {
      const reason = edge.unresolvedReason ? ` · ${edge.unresolvedReason}` : "";
      const label = `${edge.kind} · UNRESOLVED${reason}`;
      statement = `  ${sourceAlias} ..> ${targetAlias} : ${mermaidText(label)}`;
    }
    mermaid.push(statement);
    edgeMappings.push({ edgeId: edge.id, mermaidLine: mermaid.length, sourceMermaidId: sourceAlias, targetMermaidId: targetAlias, evidence: edge.evidence });
  }

  const umlEdgeIds = new Set(umlEdges.map(edge => edge.id));
  return {
    kind: "uml-class",
    title: "UML Class Diagram",
    mermaid: mermaid.join("\n"),
    nodes,
    edges: umlEdges,
    nodeMappings,
    edgeMappings,
    excludedNodeIds: allNodes.filter(node => !umlNodeIds.has(node.id)).map(node => node.id),
    excludedEdgeIds: allEdges.filter(edge => !umlEdgeIds.has(edge.id)).map(edge => edge.id),
  };
}

/** Build deterministic Mermaid views only from a canonical, source-verified CKG artifact. */
export function projectDiagrams(
  canonicalCkgJson: string,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
  expectedSha256?: string,
): DiagramProjectionResult {
  const parsed = parseCanonicalCkg(canonicalCkgJson, sourceBytes, expectedSha256);
  if (!parsed.ok) return { ok: false, errorCode: parsed.errorCode };

  const ccm = parsed.value.ccm;
  const structure = buildStructureDiagram(ccm.nodes, ccm.edges);
  const uml = buildUmlDiagram(ccm.nodes, ccm.edges);
  return {
    ok: true,
    value: {
      schemaVersion: "sage-diagrams-v1",
      ckgSha256: parsed.sha256,
      snapshot: ccm.snapshot,
      provenance: ccm.provenance,
      configurationHash: parsed.value.configurationHash,
      canonicalCounts: parsed.value.counts,
      limitations: ccm.limitations,
      diagrams: [uml, structure],
    },
  };
}
