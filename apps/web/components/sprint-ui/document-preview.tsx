"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CcmEdge, CcmNode } from "@sage/contracts";
import { AssetIcon, Badge, CopySha, Panel } from "../design-system/ui";
import type { PreviewData } from "./types";
import styles from "./document-preview.module.css";

type SectionId = "catalog" | "diagram" | "uml";
type PreviewState = "ready" | "loading" | "unavailable" | "error";
type SourceReference = {
  filePath: string;
  startLine: number;
  endLine: number;
  label: string;
};
type PositionedNode = { node: CcmNode; x: number; y: number };

const sections: { id: SectionId; number: string; title: string }[] = [
  { id: "catalog", number: "01", title: "Interface Catalog" },
  { id: "diagram", number: "02", title: "Software Engineering Diagram" },
  { id: "uml", number: "03", title: "UML Class Diagram" },
];

function locationText(reference: Pick<SourceReference, "filePath" | "startLine" | "endLine">): string {
  const range = reference.startLine === reference.endLine
    ? String(reference.startLine)
    : `${reference.startLine}–${reference.endLine}`;
  return `${reference.filePath}:${range}`;
}

function referenceFromNode(node: CcmNode): SourceReference | null {
  if (!node.location) return null;
  return {
    filePath: node.location.filePath,
    startLine: node.location.startLine,
    endLine: node.location.endLine,
    label: node.qualifiedName,
  };
}

function referenceFromEdge(edge: CcmEdge): SourceReference | null {
  const evidence = edge.evidence[0];
  if (!evidence) return null;
  return {
    filePath: evidence.filePath,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    label: `${edge.kind} reference`,
  };
}

function excerptFor(reference: SourceReference, sources: Record<string, string>, before = 2, after = 7) {
  const source = sources[reference.filePath];
  if (source === undefined) return [];
  const lines = source.split("\n");
  const from = Math.max(1, reference.startLine - before);
  const to = Math.min(lines.length, Math.max(reference.endLine, reference.startLine + after));
  return lines.slice(from - 1, to).map((text, index) => ({ number: from + index, text }));
}

function displayName(node: CcmNode | undefined, fallbackId: string): string {
  return node?.qualifiedName ?? fallbackId;
}

function markdownFor(data: PreviewData): string {
  const { model } = data;
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const sourceSymbols = model.nodes.filter((node) => node.origin === "source" && node.kind !== "Module");
  const lines = [
    `# Architecture Definition Document — ${model.snapshot.repository}`,
    "",
    "> Contoh lokal dari fixture SAGE. Dokumen ini tidak berasal dari analisis repository pengguna.",
    "",
    "## Snapshot",
    "",
    `- Repository: \`${model.snapshot.repository}\``,
    `- Branch: \`${model.snapshot.branch ?? "(tidak tersedia)"}\``,
    `- Commit: \`${model.snapshot.commitSha}\``,
    "",
    "## Source symbols in the validated CCM",
    "",
    "| Symbol | Kind | Signature | Evidence |",
    "| --- | --- | --- | --- |",
    ...sourceSymbols.map((node) => {
      const reference = referenceFromNode(node);
      const signature = node.signature?.replaceAll("|", "\\|") ?? "—";
      return `| \`${node.qualifiedName}\` | ${node.kind} | ${signature} | ${reference ? `\`${locationText(reference)}\`` : "—"} |`;
    }),
    "",
    "## Relationships recorded in the CCM",
    "",
    "| Source | Relationship | Target | Resolution | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...model.edges.map((edge) => {
      const reference = referenceFromEdge(edge);
      return `| \`${displayName(nodeById.get(edge.sourceId), edge.sourceId)}\` | ${edge.kind} | \`${displayName(nodeById.get(edge.targetId), edge.targetId)}\` | ${edge.resolution} | ${reference ? `\`${locationText(reference)}\`` : "—"} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

function downloadMarkdown(data: PreviewData) {
  const file = new Blob([markdownFor(data)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "contoh-report-service-architecture.md";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function SourceLink({ reference, onOpen }: { reference: SourceReference | null; onOpen: (reference: SourceReference) => void }) {
  if (!reference) return <span className={styles.muted}>Bukti lokasi tidak tersedia</span>;
  return <button
    className={styles.sourceLink}
    type="button"
    onClick={() => onOpen(reference)}
    aria-label={`Buka bukti ${locationText(reference)}`}
    title={`Buka ${locationText(reference)}`}
  >
    <AssetIcon group="document-export" name="imgIcon" className={styles.icon} />
    <code>{locationText(reference)}</code>
  </button>;
}

function StateMessage({ state, onRetry }: { state: Exclude<PreviewState, "ready">; onRetry: () => void }) {
  const message = {
    loading: {
      tone: "info" as const,
      label: "Contoh state · Memuat",
      title: "Dokumen contoh sedang dimuat",
      description: "Ini state pratinjau lokal. Tidak ada request atau progres analisis yang berjalan.",
    },
    unavailable: {
      tone: "warning" as const,
      label: "Contoh state · Tidak tersedia",
      title: "Dokumen untuk analisis ini tidak tersedia",
      description: "Pratinjau hanya menyediakan satu analisis fixture yang tervalidasi.",
    },
    error: {
      tone: "error" as const,
      label: "Contoh state · Gagal dimuat",
      title: "Dokumen contoh gagal dimuat",
      description: "Ini state error lokal. Tidak ada job atau request layanan yang dibuat.",
    },
  }[state];
  return <section className={styles.stateCard} role="status" aria-live="polite">
    <Badge tone={message.tone}>{message.label}</Badge>
    <h2>{message.title}</h2>
    <p>{message.description}</p>
    {state !== "loading" && <button className={styles.secondaryButton} type="button" onClick={onRetry}>Coba lagi di pratinjau</button>}
  </section>;
}

function Catalog({ data, onOpen }: { data: PreviewData; onOpen: (reference: SourceReference) => void }) {
  const { model } = data;
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const sourceSymbols = model.nodes.filter((node) => node.origin === "source" && node.kind !== "Module");
  const unresolved = model.edges.filter((edge) => edge.resolution === "Unresolved");

  return <div className={styles.documentCard}>
    <div className={styles.sectionHeading}>
      <div>
        <h2>Interface Catalog</h2>
        <p>Simbol source yang tercatat dalam CCM, dengan bukti file dan baris.</p>
      </div>
      <Badge tone="info">{sourceSymbols.length} simbol source</Badge>
    </div>
    <div className={styles.tableScroll}>
      <table className={styles.catalogTable}>
        <thead><tr><th scope="col">Symbol</th><th scope="col">Kind / contract</th><th scope="col">Evidence</th></tr></thead>
        <tbody>
          {sourceSymbols.map((node) => (
            <tr key={node.id}>
              <td data-label="Symbol"><code className={styles.symbolName}>{node.qualifiedName}</code></td>
              <td data-label="Kind / contract"><span className={styles.kind}>{node.kind}</span>{node.signature ? <code className={styles.contract}>{node.signature}</code> : <span className={styles.muted}>Kontrak tidak tersedia di CCM</span>}</td>
              <td data-label="Evidence"><SourceLink reference={referenceFromNode(node)} onOpen={onOpen} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {sourceSymbols.length === 0 && <p className={styles.emptyMessage}>CCM ini tidak mencatat simbol source.</p>}
    {unresolved.length > 0 && <div className={styles.limitationNote}>
      <Badge tone="warning">{unresolved.length} relasi belum terpecahkan</Badge>
      <ul>
        {unresolved.map((edge) => {
          const reference = referenceFromEdge(edge);
          return <li key={edge.id}>
            <span><code>{displayName(nodeById.get(edge.sourceId), edge.sourceId)}</code> — {edge.kind} — <code>{displayName(nodeById.get(edge.targetId), edge.targetId)}</code></span>
            {reference && <SourceLink reference={reference} onOpen={onOpen} />}
          </li>;
        })}
      </ul>
    </div>}
    <SourceEvidencePreview data={data} node={sourceSymbols[0]} onOpen={onOpen} />
  </div>;
}

function SourceEvidencePreview({ data, node, onOpen }: { data: PreviewData; node?: CcmNode; onOpen: (reference: SourceReference) => void }) {
  const reference = node ? referenceFromNode(node) : null;
  if (!reference) return null;
  const excerpt = excerptFor(reference, data.sources);
  return <section className={styles.evidenceSection} aria-labelledby="source-evidence-title">
    <div className={styles.sectionHeading}>
      <div><h3 id="source-evidence-title">Source Evidence — {node?.name}</h3><p>Potongan diambil langsung dari file source fixture.</p></div>
      <SourceLink reference={reference} onOpen={onOpen} />
    </div>
    <div className={styles.evidenceBlock}>
      <div className={styles.evidenceLocation}><AssetIcon group="document-export" name="imgIcon" className={styles.icon} /><code>{locationText(reference)}</code></div>
      <div className={styles.sourceExcerpt} role="region" aria-label={`Source ${reference.filePath}`}>
        <ol start={excerpt[0]?.number ?? reference.startLine}>
          {excerpt.map((line) => <li key={line.number} className={line.number >= reference.startLine && line.number <= reference.endLine ? styles.highlightedLine : undefined}><code>{line.text || " "}</code></li>)}
        </ol>
      </div>
    </div>
    <button className={styles.secondaryButton} type="button" onClick={() => onOpen(reference)}>Buka source preview</button>
  </section>;
}

function layoutNodes(nodes: CcmNode[], cardWidth = 168, cardHeight = 56): { nodes: PositionedNode[]; width: number; height: number } {
  const columns = Math.min(3, Math.max(nodes.length, 1));
  const horizontalGap = 64;
  const verticalGap = 54;
  const left = 24;
  const top = 28;
  const width = Math.max(240, left * 2 + columns * cardWidth + Math.max(0, columns - 1) * horizontalGap);
  const rows = Math.ceil(nodes.length / columns);
  const positioned = nodes.map((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return { node, x: left + column * (cardWidth + horizontalGap), y: top + row * (cardHeight + verticalGap) };
  });
  return { nodes: positioned, width, height: Math.max(150, top * 2 + rows * cardHeight + Math.max(0, rows - 1) * verticalGap) };
}

function edgeLine(start: PositionedNode, end: PositionedNode, cardWidth = 168, cardHeight = 56) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const scale = 1 / Math.max(Math.abs(dx) / (cardWidth / 2), Math.abs(dy) / (cardHeight / 2), 1);
  return {
    x1: start.x + cardWidth / 2 + dx * scale,
    y1: start.y + cardHeight / 2 + dy * scale,
    x2: end.x + cardWidth / 2 - dx * scale,
    y2: end.y + cardHeight / 2 - dy * scale,
  };
}

function RelationshipRows({ data, edges, onOpen }: { data: PreviewData; edges: CcmEdge[]; onOpen: (reference: SourceReference) => void }) {
  const nodeById = new Map(data.model.nodes.map((node) => [node.id, node]));
  return <div className={styles.relationshipList}>
    <h3>Source relationships</h3>
    {edges.length === 0 ? <p className={styles.emptyMessage}>CCM ini tidak mencatat relasi pada diagram.</p> : <ul>
      {edges.map((edge) => {
        const reference = referenceFromEdge(edge);
        return <li key={edge.id}>
          <div className={styles.relationshipText}>
            <code>{displayName(nodeById.get(edge.sourceId), edge.sourceId)}</code>
            <span>{edge.kind}</span>
            <code>{displayName(nodeById.get(edge.targetId), edge.targetId)}</code>
            <Badge tone={edge.resolution === "Exact" ? "success" : "warning"}>{edge.resolution}</Badge>
          </div>
          <SourceLink reference={reference} onOpen={onOpen} />
        </li>;
      })}
    </ul>}
  </div>;
}

function SoftwareEngineeringDiagram({ data, onOpen }: { data: PreviewData; onOpen: (reference: SourceReference) => void }) {
  const graphNodes = data.model.nodes;
  const graph = layoutNodes(graphNodes);
  const positions = new Map(graph.nodes.map((position) => [position.node.id, position]));
  const edges = data.model.edges.filter((edge) => positions.has(edge.sourceId) && positions.has(edge.targetId));

  return <div className={styles.documentCard}>
    <div className={styles.sectionHeading}>
      <div><h2>Software Engineering Diagram</h2><p>Node dan relasi mengikuti CCM; garis putus-putus menandai relasi unresolved.</p></div>
      <Badge tone="info">{graphNodes.length} node · {edges.length} relasi</Badge>
    </div>
    {graphNodes.length === 0 ? <p className={styles.emptyMessage}>Diagram tidak tersedia karena CCM tidak memiliki node.</p> : <div className={styles.diagramViewport}>
      <svg className={styles.diagramSvg} viewBox={`0 0 ${graph.width} ${graph.height}`} role="img" aria-labelledby="diagram-title diagram-description">
        <title id="diagram-title">Relasi source dari CCM</title>
        <desc id="diagram-description">Diagram menampilkan semua node dan edge yang tercatat dalam model tervalidasi.</desc>
        <defs>
          <marker id="document-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
          <marker id="document-unresolved-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
        </defs>
        {edges.map((edge) => {
          const start = positions.get(edge.sourceId)!;
          const end = positions.get(edge.targetId)!;
          const line = edgeLine(start, end);
          const marker = edge.resolution === "Unresolved" ? "url(#document-unresolved-arrow)" : "url(#document-arrow)";
          return <line key={edge.id} {...line} className={edge.resolution === "Unresolved" ? styles.unresolvedEdge : styles.diagramEdge} markerEnd={marker} />;
        })}
        {graph.nodes.map(({ node, x, y }) => <g key={node.id}>
          <title>{`${node.kind}: ${node.qualifiedName}`}</title>
          <rect x={x} y={y} width="168" height="56" rx="7" className={node.origin === "unresolved" ? styles.unresolvedNode : node.kind === "Class" || node.kind === "Interface" ? styles.structureNode : styles.symbolNode} />
          <text x={x + 12} y={y + 22} className={styles.diagramKind}>{node.kind}</text>
          <text x={x + 12} y={y + 42} className={styles.diagramName}>{node.name}</text>
        </g>)}
      </svg>
    </div>}
    <RelationshipRows data={data} edges={edges} onOpen={onOpen} />
  </div>;
}

function UmlClassDiagram({ data, onOpen }: { data: PreviewData; onOpen: (reference: SourceReference) => void }) {
  const types = data.model.nodes.filter((node) => node.kind === "Class" || node.kind === "Interface");
  const memberCountByType = new Map(types.map((node) => [node.id, data.model.nodes.filter((member) => member.parentId === node.id && (member.kind === "Method" || member.kind === "Property")).length]));
  const umlCardHeight = Math.max(164, ...Array.from(memberCountByType.values(), (count) => 68 + Math.max(count, 1) * 26));
  const layout = layoutNodes(types, 204, umlCardHeight);
  const positions = new Map(layout.nodes.map((position) => [position.node.id, position]));
  const typeRelations = data.model.edges.filter((edge) =>
    (edge.kind === "IMPLEMENTS" || edge.kind === "EXTENDS") && positions.has(edge.sourceId) && positions.has(edge.targetId));

  return <div className={styles.documentCard}>
    <div className={styles.sectionHeading}>
      <div><h2>UML Class Diagram</h2><p>Class, interface, anggota, dan relasi direpresentasikan hanya bila tercatat dalam CCM.</p></div>
      <Badge tone="info">{types.length} class / interface</Badge>
    </div>
    {types.length === 0 ? <p className={styles.emptyMessage}>CCM ini tidak mencatat class atau interface untuk diagram UML.</p> : <div className={styles.diagramViewport}>
      <svg className={styles.umlSvg} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-labelledby="uml-title uml-description">
        <title id="uml-title">Class dan interface dari CCM</title>
        <desc id="uml-description">Anggota mengikuti parentId pada CCM. Relasi hanya menampilkan edge implements dan extends yang tercatat.</desc>
        <defs>
          <marker id="uml-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
          <marker id="uml-unresolved-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
        </defs>
        {typeRelations.map((edge) => {
          const start = positions.get(edge.sourceId)!;
          const end = positions.get(edge.targetId)!;
          const line = edgeLine(start, end, 204, 164);
          const marker = edge.resolution === "Unresolved" ? "url(#uml-unresolved-arrow)" : "url(#uml-arrow)";
          return <line key={edge.id} {...line} className={edge.resolution === "Unresolved" ? styles.unresolvedEdge : styles.diagramEdge} markerEnd={marker} />;
        })}
        {layout.nodes.map(({ node, x, y }) => {
          const members = data.model.nodes.filter((member) => member.parentId === node.id && (member.kind === "Method" || member.kind === "Property"));
          const memberRows = members.length ? members : [{ id: `${node.id}-empty`, name: "Anggota tidak tercatat", signature: null }];
          const rowHeight = 26;
          const boxHeight = umlCardHeight;
          return <g key={node.id}>
            <title>{`${node.kind}: ${node.qualifiedName}`}</title>
            <rect x={x} y={y} width="204" height={boxHeight} rx="7" className={styles.umlClass} />
            <line x1={x} y1={y + 58} x2={x + 204} y2={y + 58} className={styles.umlDivider} />
            <text x={x + 12} y={y + 22} className={styles.diagramKind}>{node.kind === "Interface" ? "«interface»" : node.kind}</text>
            <text x={x + 12} y={y + 44} className={styles.diagramName}>{node.name}</text>
            {memberRows.map((member, index) => <text key={member.id} x={x + 12} y={y + 80 + index * rowHeight} className={styles.umlMember}>{member.name}{member.signature ? ` · ${member.signature}` : ""}</text>)}
          </g>;
        })}
      </svg>
    </div>}
    <RelationshipRows data={data} edges={typeRelations} onOpen={onOpen} />
    <div className={styles.umlEvidence}>
      <h3>Class / interface evidence</h3>
      <ul>{types.map((node) => <li key={node.id}><code>{node.qualifiedName}</code><SourceLink reference={referenceFromNode(node)} onOpen={onOpen} /></li>)}</ul>
    </div>
  </div>;
}

export function DocumentPreview({ data }: { data: PreviewData }) {
  const [section, setSection] = useState<SectionId>("catalog");
  const [previewState, setPreviewState] = useState<PreviewState>("ready");
  const [sourceReference, setSourceReference] = useState<SourceReference | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sectionButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const sha = data.model.snapshot.commitSha;
  const activeTab = sections.find((item) => item.id === section) ?? sections[0];

  useEffect(() => {
    if (sourceReference && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
  }, [sourceReference]);

  function openSource(reference: SourceReference) {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSourceReference(reference);
  }

  function closeSource() {
    if (dialogRef.current?.open) dialogRef.current.close();
  }

  function handleDialogClose() {
    setSourceReference(null);
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    requestAnimationFrame(() => returnFocus?.focus());
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % sections.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + sections.length) % sections.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = sections.length - 1;
    else return;
    event.preventDefault();
    setSection(sections[next].id);
    sectionButtons.current[next]?.focus();
  }

  const previewStateOptions: { value: PreviewState; label: string }[] = [
    { value: "ready", label: "Siap" },
    { value: "loading", label: "Memuat" },
    { value: "unavailable", label: "Tidak tersedia" },
    { value: "error", label: "Gagal" },
  ];

  return <div className={styles.page}>
    <div className={styles.pageHeading}>
      <p className={styles.eyebrow}>PRATINJAU / DOKUMEN ARSITEKTUR</p>
      <h1>Architecture Definition Document</h1>
      <p>Tinjau artefak arsitektur dengan bukti source dari snapshot contoh yang tervalidasi.</p>
    </div>

    <Panel title="Analysis snapshot" className={styles.snapshotPanel}>
      <div className={styles.snapshotGrid}>
        <div className={styles.snapshotField}><span>Repository</span><code>{data.model.snapshot.repository}</code></div>
        <div className={styles.snapshotField}><span>Branch</span><code>{data.model.snapshot.branch ?? "(tidak tersedia)"}</code></div>
        <div className={styles.snapshotField}><span>Commit</span><div className={styles.commitValue}><code>{sha.slice(0, 7)}</code><CopySha sha={sha} /></div></div>
        <div className={styles.snapshotField}><span>Status data</span><Badge tone="info">CCM tervalidasi</Badge></div>
      </div>
    </Panel>

    <div className={styles.actionRow}>
      <Link className={styles.secondaryButton} href="/preview/graph?analysis=fixture-report">← Kembali ke graph</Link>
      <details className={styles.scenarioControl}>
        <summary>Uji state pratinjau</summary>
        <div className={styles.scenarioBody}>
          <label htmlFor="document-preview-state">State layar</label>
          <select id="document-preview-state" value={previewState} onChange={(event) => setPreviewState(event.target.value as PreviewState)}>
            {previewStateOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <p>Kontrol ini hanya mengubah tampilan lokal; tidak mengirim request atau membuat job.</p>
        </div>
      </details>
    </div>

    {previewState === "ready" ? <div className={styles.documentLayout}>
      <nav className={styles.sectionNav} aria-label="Bagian dokumen" role="tablist" aria-orientation="vertical">
        {sections.map((item, index) => <button
          key={item.id}
          ref={(element) => { sectionButtons.current[index] = element; }}
          className={item.id === section ? styles.sectionButtonActive : styles.sectionButton}
          id={`document-tab-${item.id}`}
          type="button"
          role="tab"
          aria-selected={item.id === section}
          aria-controls="document-panel"
          tabIndex={item.id === section ? 0 : -1}
          onClick={() => setSection(item.id)}
          onKeyDown={(event) => handleTabKey(event, index)}
        >
          <span className={styles.sectionNumber}>{item.number}</span><span>{item.title}</span>
        </button>)}
      </nav>

      <div className={styles.readingColumn}>
        <section className={styles.exportPanel} aria-label="Export dokumen">
          <div className={styles.exportActions}>
            <button className={styles.secondaryButton} type="button" disabled title="Ekspor PDF belum tersedia di pratinjau.">
              <AssetIcon group="document-export" name="imgIcon1" className={styles.icon} />Export PDF
            </button>
            <button className={styles.secondaryButton} type="button" onClick={() => downloadMarkdown(data)}>
              <AssetIcon group="document-export" name="imgIcon1" className={styles.icon} />Export Markdown
            </button>
          </div>
          <p>Markdown mengunduh snapshot contoh ini. Ekspor PDF belum tersedia di pratinjau.</p>
        </section>

        <div className={styles.tabPanel} id="document-panel" role="tabpanel" aria-labelledby={`document-tab-${activeTab.id}`} tabIndex={0}>
          {section === "catalog" && <Catalog data={data} onOpen={openSource} />}
          {section === "diagram" && <SoftwareEngineeringDiagram data={data} onOpen={openSource} />}
          {section === "uml" && <UmlClassDiagram data={data} onOpen={openSource} />}
        </div>
      </div>
    </div> : <StateMessage state={previewState} onRetry={() => setPreviewState("ready")} />}

    <dialog
      ref={dialogRef}
      className={styles.sourceDialog}
      aria-labelledby="source-dialog-title"
      onCancel={(event) => { event.preventDefault(); closeSource(); }}
      onClose={handleDialogClose}
    >
      {sourceReference && <div className={styles.dialogContent}>
        <div className={styles.dialogHeader}>
          <div><p className={styles.eyebrow}>SOURCE EVIDENCE</p><h2 id="source-dialog-title">{sourceReference.label}</h2><code>{locationText(sourceReference)}</code></div>
          <button type="button" className={styles.closeButton} onClick={closeSource} aria-label="Tutup source evidence">Tutup</button>
        </div>
        <div className={styles.dialogSource}>
          {excerptFor(sourceReference, data.sources, 3, 8).length === 0 ? <p className={styles.emptyMessage}>Source fixture tidak memuat file ini.</p> : <ol start={excerptFor(sourceReference, data.sources, 3, 8)[0].number}>
            {excerptFor(sourceReference, data.sources, 3, 8).map((line) => <li key={line.number} className={line.number >= sourceReference.startLine && line.number <= sourceReference.endLine ? styles.highlightedLine : undefined}><code>{line.text || " "}</code></li>)}
          </ol>}
        </div>
        <p className={styles.dialogNote}>Source ditampilkan persis dari bytes fixture yang tervalidasi untuk snapshot ini.</p>
      </div>}
    </dialog>
  </div>;
}
