import type { CcmNode } from "@sage/contracts";
import type { DiagramProjection } from "./diagrams.ts";

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

/** A source-backed reading view. Members collapse into their owning classifier;
 * duplicate dependencies aggregate by kind and resolution, never across statuses.
 * Original evidence and IDs stay in the canonical model and Markdown.
 */
export function projectHumanDiagram(diagram: DiagramProjection): DiagramProjection {
  const aliases = new Map(diagram.nodes.map((node, i) => [node.id, `N${i + 1}`]));
  const byId = new Map(diagram.nodes.map(node => [node.id, node]));
  const nameCounts = new Map<string, number>();
  for (const node of diagram.nodes) nameCounts.set(humanNodeName(node), (nameCounts.get(humanNodeName(node)) ?? 0) + 1);
  const displayName = (node: CcmNode) => (nameCounts.get(humanNodeName(node)) ?? 0) > 1 ? `${humanNodeName(node)} · ${node.filePath ?? node.kind}` : humanNodeName(node);
  const lines = [diagram.kind === "uml-class" ? "classDiagram" : "flowchart LR"];
  const mappings: DiagramProjection["nodeMappings"] = [];
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
      for (const member of membersByParent.get(node.id) ?? []) {
        // Parentheses are trusted grammar only for declared methods. No invented visibility/type.
        let memberLabel = label((member.signature ?? member.name).replace(/\)\s*:\s*/, ") "));
        if (member.kind === "Method") memberLabel = memberLabel.replace(/#40;/g, "(").replace(/#41;/g, ")");
        lines.push(`    ${memberLabel}${member.kind === "Method" && !memberLabel.includes("(") ? "(parameter tidak tersedia)" : ""}`);
      }
      lines.push("  }");
      lines.push(`  style ${alias} ${colors[node.kind] ?? colors.Class}`);
    }
    for (const edge of diagram.edges) {
      const source = byId.get(edge.sourceId), target = byId.get(edge.targetId);
      if (!source || !target || !["Class", "Interface", "UnresolvedReference"].includes(source.kind) || !["Class", "Interface", "UnresolvedReference"].includes(target.kind)) continue;
      const arrow = edge.resolution === "Unresolved" ? "..>" : edge.kind === "EXTENDS" ? "--|>" : edge.kind === "IMPLEMENTS" ? "..|>" : "..>";
      lines.push(`  ${aliases.get(edge.sourceId)} ${arrow} ${aliases.get(edge.targetId)} : ${edge.resolution === "Unresolved" ? "Unresolved" : edge.kind.toLowerCase()}`);
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
  return { ...diagram, mermaid: lines.join("\n"), nodeMappings: mappings, edgeMappings: [] };
}
