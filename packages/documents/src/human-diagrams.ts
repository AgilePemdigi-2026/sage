import type { CcmEdge, CcmNode, EvidenceSpan } from "@sage/contracts";
import type { DiagramProjection } from "./diagrams.ts";

export type HumanUmlRole = "boundary" | "control" | "entity";

/** Display-only BCE classification. It records the convention that caused a label, not CCM fact. */
export interface HumanUmlRoleMetadata {
  role: HumanUmlRole | null;
  basis: "name-convention" | "path-convention" | "name-and-path" | "ambiguous" | "none";
  nameConvention: string | null;
  pathConvention: string | null;
}

/** A rendered dependency can stand for several exact source edges. */
export interface HumanUmlDependencyMetadata {
  sourceId: string;
  targetId: string;
  kind: CcmEdge["kind"];
  resolution: CcmEdge["resolution"];
  representativeEdgeId: string;
  sourceEdgeIds: string[];
  evidence: EvidenceSpan[];
  sourceEdges: CcmEdge[];
}

/** Human/PDF reading hints never change canonical CCM facts or their identifiers. */
export interface HumanUmlMetadata {
  direction: "TB";
  roles: Record<string, HumanUmlRoleMetadata>;
  dependencies: HumanUmlDependencyMetadata[];
  inheritanceRelations: HumanUmlDependencyMetadata[];
  /** Number of relationship statements in the rendered class diagram after display grouping. */
  displayEdgeCount?: number;
  unresolvedReferenceCount: number;
  unresolvedSourceEdgeIds: string[];
  omittedUnresolved: number;
}

export type HumanUmlProjection = DiagramProjection & { humanMetadata?: HumanUmlMetadata };

/** Display only: canonical projections and the exhaustive Markdown remain unchanged. */
export const HUMAN_DIAGRAM_THEME = {
  primaryColor: "#e6faf6", primaryTextColor: "#061e42", primaryBorderColor: "#098577",
  secondaryColor: "#eef2ff", tertiaryColor: "#fff4d9", lineColor: "#506783",
  textColor: "#061e42", mainBkg: "#e6faf6", nodeBorder: "#098577",
  clusterBkg: "#f6f9fb", clusterBorder: "#b6c6d8", edgeLabelBackground: "#ffffff",
  fontFamily: "Arial, sans-serif", fontSize: "16px",
};

export function humanNodeName(node: CcmNode): string {
  if (node.kind === "UnresolvedReference") return node.name || "Target belum terpecahkan";
  const qualified = node.qualifiedName || node.name || node.filePath || "Deklarasi tanpa nama";
  return node.filePath && qualified.startsWith(`${node.filePath}.`) ? qualified.slice(node.filePath.length + 1) : qualified;
}

function label(value: string): string {
  return Array.from(value).map(c => /[A-Za-z0-9 .,/:=]/.test(c) ? c : `#${c.codePointAt(0)};`).join("");
}

const colors: Record<string, string> = {
  Module: "fill:#eef3f7,stroke:#506783,color:#061e42",
  Class: "fill:#d5f5ed,stroke:#098577,color:#061e42",
  Interface: "fill:#ede9fe,stroke:#7c3aed,color:#352066",
  Function: "fill:#e0eaff,stroke:#4f61c6,color:#162f67",
  UnresolvedReference: "fill:#fff4d9,stroke:#b45309,color:#78350f,stroke-dasharray:5 3",
};

const roleColors: Record<HumanUmlRole, string> = {
  boundary: "fill:#fff4d9,stroke:#b45309,color:#78350f",
  control: "fill:#e0eaff,stroke:#4f61c6,color:#162f67",
  entity: "fill:#d5f5ed,stroke:#098577,color:#061e42",
};

const dependencyLabels: Partial<Record<CcmEdge["kind"], string>> = {
  CALLS: "calls",
  INSTANTIATES: "new",
  TYPE_REFERENCES: "type",
  READS: "reads",
  WRITES: "writes",
};

/** A source-backed reading view. Members collapse into their owning classifier;
 * duplicate dependencies aggregate by kind and resolution, never across statuses.
 * Original evidence and IDs stay in the canonical model and Markdown.
 */
export function projectHumanDiagram<T extends HumanUmlProjection>(diagram: T): T {
  const aliases = new Map(diagram.nodes.map((node, i) => [node.id, `N${i + 1}`]));
  const byId = new Map(diagram.nodes.map(node => [node.id, node]));
  const nameCounts = new Map<string, number>();
  for (const node of diagram.nodes) nameCounts.set(humanNodeName(node), (nameCounts.get(humanNodeName(node)) ?? 0) + 1);
  const displayName = (node: CcmNode) => (nameCounts.get(humanNodeName(node)) ?? 0) > 1 ? `${humanNodeName(node)} · ${node.filePath ?? node.kind}` : humanNodeName(node);
  const lines = [diagram.kind === "uml-class" ? "classDiagram" : "flowchart LR"];
  if (diagram.kind === "uml-class" && diagram.humanMetadata?.direction === "TB") lines.push("  direction TB");
  const mappings: DiagramProjection["nodeMappings"] = [];
  const edgeMappings: DiagramProjection["edgeMappings"] = [];
  let displayEdgeCount = 0;
  if (diagram.kind === "uml-class") {
    const membersByParent = new Map<string, CcmNode[]>();
    for (const member of diagram.nodes) {
      if (member.parentId && (member.kind === "Method" || member.kind === "Property")) {
        const members = membersByParent.get(member.parentId) ?? [];
        members.push(member);
        membersByParent.set(member.parentId, members);
      }
    }
    for (const node of diagram.nodes.filter(n => ["Class", "Interface", "UnresolvedReference"].includes(n.kind))) {
      const alias = aliases.get(node.id)!;
      lines.push(`  class ${alias}["${label(displayName(node))}"] {`);
      mappings.push({ nodeId: node.id, mermaidId: alias, mermaidLine: lines.length, evidence: node.location });
      if (node.kind === "Interface") lines.push("    <<interface>>");
      if (node.kind === "UnresolvedReference") lines.push("    <<unresolved>>");
      const displayRole = diagram.humanMetadata?.roles[node.id]?.role;
      if (displayRole) lines.push(`    <<${displayRole}>>`);
      for (const member of membersByParent.get(node.id) ?? []) {
        // Parentheses are trusted grammar only for declared methods. No invented visibility/type.
        let memberLabel = label((member.signature ?? member.name).replace(/\)\s*:\s*/, ") "));
        if (member.kind === "Method") memberLabel = memberLabel.replace(/#40;/g, "(").replace(/#41;/g, ")");
        lines.push(`    ${memberLabel}${member.kind === "Method" && !memberLabel.includes("(") ? "(parameter tidak tersedia)" : ""}`);
        if (diagram.humanMetadata) {
          mappings.push({ nodeId: member.id, mermaidId: null, mermaidLine: lines.length, parentMermaidId: alias, evidence: member.location });
        }
      }
      lines.push("  }");
      lines.push(`  style ${alias} ${displayRole ? roleColors[displayRole] : colors[node.kind] ?? colors.Class}`);
    }
    const renderedClassifiers = new Set(diagram.nodes.filter(node => node.kind === "Class" || node.kind === "Interface").map(node => node.id));
    if (diagram.humanMetadata) {
      for (const group of diagram.humanMetadata.inheritanceRelations) {
        const sourceAlias = aliases.get(group.sourceId), targetAlias = aliases.get(group.targetId);
        if (!sourceAlias || !targetAlias || !renderedClassifiers.has(group.sourceId) || !renderedClassifiers.has(group.targetId)) continue;
        const relation = group.kind === "EXTENDS" ? "<|--" : "<|..";
        lines.push(`  ${targetAlias} ${relation} ${sourceAlias} : ${group.kind.toLowerCase()}`);
        displayEdgeCount += 1;
        for (const edge of group.sourceEdges) {
          edgeMappings.push({ edgeId: edge.id, mermaidLine: lines.length, sourceMermaidId: aliases.get(edge.sourceId)!, targetMermaidId: aliases.get(edge.targetId)!, evidence: edge.evidence });
        }
      }
    } else {
      for (const edge of diagram.edges) {
        const source = byId.get(edge.sourceId), target = byId.get(edge.targetId);
        if (!source || !target) continue;
        if (!["Class", "Interface", "UnresolvedReference"].includes(source.kind) || !["Class", "Interface", "UnresolvedReference"].includes(target.kind)) continue;
        const arrow = edge.resolution === "Unresolved" ? "..>" : edge.kind === "EXTENDS" ? "--|>" : edge.kind === "IMPLEMENTS" ? "..|>" : "..>";
        lines.push(`  ${aliases.get(edge.sourceId)} ${arrow} ${aliases.get(edge.targetId)} : ${edge.resolution === "Unresolved" ? "Unresolved" : edge.kind.toLowerCase()}`);
      }
    }
    const dependencyLines = new Map<string, { sourceId: string; targetId: string; resolution: CcmEdge["resolution"]; groups: HumanUmlDependencyMetadata[] }>();
    for (const group of diagram.humanMetadata?.dependencies ?? []) {
      const key = JSON.stringify([group.sourceId, group.targetId, group.resolution]);
      const line = dependencyLines.get(key);
      if (line) line.groups.push(group);
      else dependencyLines.set(key, { sourceId: group.sourceId, targetId: group.targetId, resolution: group.resolution, groups: [group] });
    }
    const orderedDependencyLines = [...dependencyLines.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    for (const [, line] of orderedDependencyLines) {
      const sourceAlias = aliases.get(line.sourceId), targetAlias = aliases.get(line.targetId);
      if (!sourceAlias || !targetAlias || line.sourceId === line.targetId) continue;
      const groups = [...line.groups].sort((left, right) => left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
      const kindLabels = groups.map(group => {
        const name = dependencyLabels[group.kind] ?? group.kind.toLowerCase();
        return group.sourceEdgeIds.length > 1 ? `${name} ×${group.sourceEdgeIds.length}` : name;
      });
      const caption = `${kindLabels.join(" / ")} · ${line.resolution}`;
      // Mermaid class diagrams accept the dotted UML dependency token `..>` for both
      // statuses; resolution remains explicit in the caption instead of changing grammar.
      lines.push(`  ${sourceAlias} ..> ${targetAlias} : ${label(caption)}`);
      displayEdgeCount += 1;
      for (const group of groups) for (const edge of group.sourceEdges) {
        edgeMappings.push({ edgeId: edge.id, mermaidLine: lines.length, sourceMermaidId: sourceAlias, targetMermaidId: targetAlias, evidence: edge.evidence });
      }
    }
    if (!mappings.length) lines.push('  note "Tidak ada deklarasi class atau interface"');
  } else {
    const visible = diagram.nodes.filter(n => !["Method", "Property"].includes(n.kind));
    const visibleIds = new Set(visible.map(n => n.id));
    function owner(id: string): string | null {
      const visited = new Set<string>();
      while (!visibleIds.has(id)) {
        if (visited.has(id)) return null;
        visited.add(id);
        const parent = byId.get(id)?.parentId;
        if (!parent) return null;
        id = parent;
      }
      return id;
    }
    for (const node of visible) {
      const name = node.kind === "Module" ? node.filePath || humanNodeName(node) : displayName(node);
      lines.push(`  ${aliases.get(node.id)}["${label(name)} · ${node.kind}"]`);
      mappings.push({ nodeId: node.id, mermaidId: aliases.get(node.id)!, mermaidLine: lines.length, evidence: node.location });
      lines.push(`  style ${aliases.get(node.id)} ${colors[node.kind] ?? colors.Function}`);
    }
    const relations = new Map<string, { source: string; target: string; kind: string; resolution: string; count: number }>();
    for (const edge of diagram.edges) {
      const source = owner(edge.sourceId), target = owner(edge.targetId);
      if (!source || !target || source === target) continue;
      const key = JSON.stringify([source, target, edge.kind, edge.resolution]);
      const found = relations.get(key);
      if (found) found.count++;
      else relations.set(key, { source, target, kind: edge.kind, resolution: edge.resolution, count: 1 });
    }
    for (const edge of relations.values()) {
      const arrow = edge.resolution === "Unresolved" ? "-.->" : "-->";
      const caption = `${edge.kind.toLowerCase()}${edge.count > 1 ? ` ×${edge.count}` : ""}${edge.resolution === "Unresolved" ? " · Unresolved" : ""}`;
      lines.push(`  ${aliases.get(edge.source)} ${arrow}|"${label(caption)}"| ${aliases.get(edge.target)}`);
    }
    if (!visible.length) lines.push('  Empty["Tidak ada struktur kode yang tercatat"]');
  }
  const humanMetadata = diagram.humanMetadata
    ? diagram.humanMetadata.displayEdgeCount === displayEdgeCount
      ? diagram.humanMetadata
      : { ...diagram.humanMetadata, displayEdgeCount }
    : undefined;
  return { ...diagram, ...(humanMetadata ? { humanMetadata } : {}), mermaid: lines.join("\n"), nodeMappings: mappings, edgeMappings } as T;
}
