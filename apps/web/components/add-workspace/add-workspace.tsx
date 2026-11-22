"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyAddReviewOverlay, emptyAddReviewOverlay, type AddReviewOverlay } from "@sage/documents/add-overlay";
import { isAddBaselineModel, type AddBaselineModel, type AddElement, type AddRelationship } from "@sage/documents/baseline-add-model";
import { createAddMarkdown } from "@sage/documents/baseline-markdown";
import { createAddLatex } from "@sage/documents/baseline-latex";
import { addViewFigureNumber, addViewNarratives } from "@sage/documents/baseline-narratives";
import { coreRelationshipLabel, projectCoreBaselineView } from "@sage/documents/baseline-core-views";
import { PHASE_C_ADD, PHASE_C_ADD_TOC } from "@sage/documents/phase-c-add";
import { AnalysisNavigation } from "../analysis-navigation/analysis-navigation.tsx";
import { AssetIcon, Badge, Button, EmptyState, Field, MaskIcon, OverflowX, SkeletonRows, useVisibleSection } from "../design-system/ui.tsx";
import { AnalysisPageHead } from "../analysis-navigation/analysis-page-head.tsx";
import type { AnalysisHeadData } from "../../lib/analyses/analysis-head.ts";
import styles from "./add-workspace.module.css";
import states from "./add-states.module.css";
import doc from "./add-document.module.css";
import { ActiveSectionPanel, DOCUMENT_SECTION_IDS, DocumentMetrics, DocumentToc } from "./add-document-chrome.tsx";

type ApiRecord = { id: string; analysisId: string; modelHash: string; sourceCkgHash: string; model: AddBaselineModel; revision: number; overlay: AddReviewOverlay; accountKey: string };
type PageState = "loading" | "not-generated" | "ready" | "error";
type AddResponse = { data?: unknown; error?: { message?: string; code?: string } };

/** Konteks analisis untuk page head (dibaca server lewat readAnalysisHead). Opsional: tanpa konteks, tampilan lama dipakai. */
export type AddPageContext = AnalysisHeadData;

/** Judul dokumen untuk tampilan: konstanta PHASE_C_ADD (dipakai juga oleh ekspor) ditulis kapital; di layar/print
 *  ditampilkan dalam title case tanpa mengubah konstanta. */
const documentTitle = PHASE_C_ADD.document.title.toLowerCase().replace(/\b\w/gu, letter => letter.toUpperCase());

/** Ringkasan isi dokumen dari struktur PHASE_C_ADD_TOC (bukan angka karangan). */
const ADD_PARTS = (() => {
  const groups = [
    { id: PHASE_C_ADD.dataArchitecture.id, title: "Data Architecture", icon: "imgFeatureData" },
    { id: PHASE_C_ADD.applicationArchitecture.id, title: "Application Architecture", icon: "imgFeatureApplication" },
  ];
  return groups.map(group => {
    const start = PHASE_C_ADD_TOC.findIndex(item => item.id === group.id);
    const sections: string[] = [];
    for (const item of PHASE_C_ADD_TOC.slice(start + 1)) { if (item.level < 2) break; sections.push(item.label.replace(/^[\d.]+\s*/, "")); }
    return { ...group, count: sections.length, summary: sections.slice(0, 3).join(", ") };
  });
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApiRecord(value: unknown, analysisId: string, accountKey: string): ApiRecord | null {
  if (!isRecord(value) || value.accountKey !== accountKey || value.analysisId !== analysisId || typeof value.id !== "string" || typeof value.modelHash !== "string" || typeof value.sourceCkgHash !== "string" || !Number.isSafeInteger(value.revision) || !isRecord(value.model) || !isRecord(value.overlay)) return null;
  const model = value.model as unknown;
  const overlay = value.overlay as unknown as AddReviewOverlay;
  if (!isAddBaselineModel(model) || overlay.revision !== value.revision || overlay.schemaVersion !== "sage-add-review-v1" || model.sourceCkgHash !== value.sourceCkgHash) return null;
  return { ...(value as unknown as ApiRecord), model };
}

function githubEvidence(repository: string, commitSha: string, span: { filePath: string; startLine: number; endLine: number }, fileOnly = false): string {
  const path = span.filePath.split("/").map(encodeURIComponent).join("/");
  const fragment = fileOnly ? "" : `#L${span.startLine}-L${span.endLine}`;
  return `https://github.com/${repository}/blob/${commitSha}/${path}${fragment}`;
}

function EvidenceList({ model, spans, showAll = false }: { model: AddBaselineModel; spans: AddElement["evidence"]; showAll?: boolean }) {
  if (!spans.length) return <span className={styles.muted}>Belum ada source evidence</span>;
  return <ul className={styles.evidenceList}>{(showAll ? spans : spans.slice(0, 4)).map((span, index) => <li key={`${span.filePath}:${span.startLine}:${index}`}><a href={githubEvidence(model.snapshot.repository, model.snapshot.commitSha, span)} target="_blank" rel="noreferrer"><code>{span.filePath}:{span.startLine}–{span.endLine}</code></a><small>{span.role}</small></li>)}</ul>;
}

function elementTypeLabel(type: AddElement["type"]): string {
  return ({ ApplicationComponent: "Application component", ApplicationFunction: "Application function", ApplicationService: "Application service", ApplicationInterface: "Application interface", DataObject: "Data object" })[type];
}

function TableColumns({ widths }: { widths: number[] }) {
  return <colgroup>{widths.map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup>;
}

function RelationshipTable({ model, relationships, showAllEvidence = false }: { model: AddBaselineModel; relationships: AddRelationship[]; showAllEvidence?: boolean }) {
  const allById = new Map(model.elements.map(item => [item.id, item]));
  return <table className={styles.relationshipTable}><TableColumns widths={[17, 24, 17, 11, 10, 21]} /><thead><tr><th>Source</th><th>Relationship</th><th>Target</th><th>Evidence status</th><th>Review</th><th>Evidence</th></tr></thead><tbody>
    {relationships.map(edge => <tr key={edge.id} data-relationship-id={edge.id}><th scope="row">{allById.get(edge.sourceId)?.name ?? edge.sourceId}</th><td><strong>{edge.type.replace(/Relationship$/u, "")}</strong>{coreRelationshipLabel(edge) ? <small>{coreRelationshipLabel(edge)}</small> : null}</td><td>{allById.get(edge.targetId)?.name ?? edge.targetId}</td><td>{edge.confidence === "proven" ? "Proven" : "Indicated"}</td><td>{edge.review}</td><td><EvidenceList model={model} spans={edge.evidence} showAll={showAllEvidence} /></td></tr>)}
    {!relationships.length ? <tr><td colSpan={6} className={styles.emptyCell}>No source-supported relationship was identified.</td></tr> : null}
  </tbody></table>;
}

function PrintRelationshipRegister({ model }: { model: AddBaselineModel }) {
  const data = projectCoreBaselineView(model, "dataStructure");
  const application = projectCoreBaselineView(model, "applicationCooperation");
  const relationships = [...data.relationships, ...application.relationships];
  return <section className={styles.printRelationshipRegister} aria-labelledby="complete-relationship-register-title">
    <h3 id="complete-relationship-register-title">Core Relationship Register</h3>
    <p>Only the source-supported relationships shown in the stakeholder views are listed here. Lower-level endpoint and function links remain available in their catalogs.</p>
    <OverflowX className={styles.tableScroll} label="Tabel dokumen; geser untuk melihat kolom lain"><RelationshipTable model={model} relationships={relationships} showAllEvidence /></OverflowX>
  </section>;
}

type DiagramPoint = { x: number; y: number; level: number };

type ArchimateMarker = "association" | "composition" | "assignment" | "realization" | "serving" | "access" | "triggering" | "flow";

function markerFor(type: AddRelationship["type"]): ArchimateMarker {
  const markers: Record<AddRelationship["type"], ArchimateMarker> = {
    AssociationRelationship: "association",
    CompositionRelationship: "composition",
    AssignmentRelationship: "assignment",
    RealizationRelationship: "realization",
    ServingRelationship: "serving",
    AccessRelationship: "access",
    TriggeringRelationship: "triggering",
    FlowRelationship: "flow",
  };
  return markers[type];
}

function diagramNameLines(value: string, maxLength = 28): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/u)) {
    if (line && (line + " " + word).length > maxLength) { lines.push(line); line = ""; }
    if (word.length > maxLength) {
      if (line) { lines.push(line); line = ""; }
      for (let index = 0; index < word.length; index += maxLength) lines.push(word.slice(index, index + maxLength));
    } else line = line ? line + " " + word : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function diagramPositions(elements: AddElement[], relationships: AddRelationship[], view: "dataStructure" | "applicationCooperation", cardWidth: number, cardHeight: number): { positions: Map<string, DiagramPoint>; width: number; height: number } {
  const byId = new Map(elements.map(element => [element.id, element]));
  const adjacent = new Map(elements.map(element => [element.id, new Set<string>()]));
  const incoming = new Map(elements.map(element => [element.id, 0]));
  const outgoing = new Map(elements.map(element => [element.id, [] as string[]]));
  for (const edge of relationships) {
    if (!byId.has(edge.sourceId) || !byId.has(edge.targetId)) continue;
    adjacent.get(edge.sourceId)!.add(edge.targetId);
    adjacent.get(edge.targetId)!.add(edge.sourceId);
    outgoing.get(edge.sourceId)!.push(edge.targetId);
    incoming.set(edge.targetId, incoming.get(edge.targetId)! + 1);
  }
  const label = (id: string) => byId.get(id)?.name ?? id;
  const groups: string[][] = [];
  const visited = new Set<string>();
  for (const element of elements) {
    if (visited.has(element.id) || !(adjacent.get(element.id)?.size)) continue;
    const queue = [element.id];
    const group: string[] = [];
    visited.add(element.id);
    while (queue.length) {
      const current = queue.shift()!;
      group.push(current);
      for (const next of adjacent.get(current) ?? []) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
    groups.push(group);
  }

  const levelsByGroup = groups.map(group => {
    const root = [...group].sort((left, right) => (adjacent.get(right)?.size ?? 0) - (adjacent.get(left)?.size ?? 0) || label(left).localeCompare(label(right)))[0]!;
    const levels = new Map<string, number>();
    if (view === "applicationCooperation") {
      const indegree = new Map(group.map(id => [id, 0]));
      for (const id of group) for (const next of outgoing.get(id) ?? []) if (indegree.has(next)) indegree.set(next, indegree.get(next)! + 1);
      const ready = group.filter(id => indegree.get(id) === 0).sort((left, right) => label(left).localeCompare(label(right)));
      const order: string[] = [];
      for (const id of ready) levels.set(id, 0);
      while (ready.length) {
        const current = ready.shift()!;
        order.push(current);
        for (const next of outgoing.get(current) ?? []) {
          if (!indegree.has(next)) continue;
          levels.set(next, Math.max(levels.get(next) ?? 0, (levels.get(current) ?? 0) + 1));
          indegree.set(next, indegree.get(next)! - 1);
          if (indegree.get(next) === 0) { ready.push(next); ready.sort((left, right) => label(left).localeCompare(label(right))); }
        }
      }
      if (order.length !== group.length) levels.clear();
    }
    if (levels.size !== group.length) {
      levels.clear();
      levels.set(root, 0);
      const queue = [root];
      while (queue.length) {
        const current = queue.shift()!;
        for (const next of adjacent.get(current) ?? []) if (!levels.has(next)) { levels.set(next, levels.get(current)! + 1); queue.push(next); }
      }
    }
    return levels;
  });

  const positions = new Map<string, DiagramPoint>();
  const xGap = view === "applicationCooperation" ? 350 : 430;
  const marginX = 70;
  if (view === "dataStructure") {
    let laneTop = 65;
    for (const levels of levelsByGroup) {
      const grouped = new Map<number, string[]>();
      for (const [id, level] of levels) grouped.set(level, [...(grouped.get(level) ?? []), id]);
      const rowCount = Math.max(...[...grouped.values()].map(items => items.length), 1);
      for (const [level, ids] of grouped) {
        ids.sort((left, right) => label(left).localeCompare(label(right)));
        const top = laneTop + (rowCount - ids.length) * 60;
        ids.forEach((id, index) => positions.set(id, { x: marginX + level * xGap, y: top + index * 120, level }));
      }
      laneTop += rowCount * 120 + 55;
    }
  } else {
    const rowsByLevel = new Map<number, string[]>();
    for (const levels of levelsByGroup) for (const [id, level] of levels) rowsByLevel.set(level, [...(rowsByLevel.get(level) ?? []), id]);
    for (const [level, ids] of rowsByLevel) {
      ids.sort((left, right) => label(left).localeCompare(label(right)));
      ids.forEach((id, index) => positions.set(id, { x: marginX + level * xGap, y: 120 + (index - (ids.length - 1) / 2) * 145, level }));
    }
  }
  const maxLevel = Math.max(0, ...[...positions.values()].map(point => point.level));
  const maxY = Math.max(0, ...[...positions.values()].map(point => point.y));
  return { positions, width: marginX * 2 + cardWidth + maxLevel * xGap, height: maxY + cardHeight + 65 };
}

function ViewDiagram({ model, view }: { model: AddBaselineModel; view: "dataStructure" | "applicationCooperation" }) {
  const narratives = addViewNarratives(model, view);
  const core = projectCoreBaselineView(model, view);
  const elements = core.elements;
  const relationships = core.relationships;
  const dataView = view === "dataStructure";
  const cardWidth = 300;
  const cardHeight = 112;
  const typeLabel = dataView ? "DATA STRUCTURE VIEW" : "APPLICATION COOPERATION VIEW";
  const figureTitle = dataView ? "ArchiMate Information Structure Viewpoint" : "ArchiMate Application Cooperation Viewpoint";
  const layout = diagramPositions(elements, relationships, view, cardWidth, cardHeight);
  const markerId = (type: AddRelationship["type"]) => view + "-" + markerFor(type);
  const byId = new Map(elements.map(item => [item.id, item]));
  const hasDiagram = relationships.length > 0;
  // Fit-to-width: SVG mengikuti lebar kartu; lebar minimum = 60% ukuran asli agar teks tetap terbaca (lalu scroll).
  const renderSvg = () => <svg className={styles.diagram} style={{ "--diagram-width": layout.width } as React.CSSProperties} viewBox={"0 0 " + layout.width + " " + layout.height} role="img" aria-labelledby={view + "-diagram-title " + view + "-diagram-desc"}>
    <title id={view + "-diagram-title"}>{typeLabel}</title>
    <desc id={view + "-diagram-desc"}>Compact ArchiMate stakeholder view with {elements.length} connected elements and {relationships.length} source-supported relationships.</desc>
    <defs>
      <marker id={markerId("CompositionRelationship")} markerWidth="12" markerHeight="12" refX="1" refY="6" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M 1 6 L 6 1 L 11 6 L 6 11 Z" fill="#57606a" stroke="#57606a" strokeWidth="1.5" /></marker>
      <marker id={markerId("AssignmentRelationship")} markerWidth="9" markerHeight="9" refX="1" refY="4.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><circle cx="4.5" cy="4.5" r="3.3" fill="#57606a" /></marker>
      <marker id={markerId("RealizationRelationship")} markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M 1 1 L 11 6 L 1 11 Z" fill="#fbfcfe" stroke="#57606a" strokeWidth="1.5" /></marker>
      <marker id={markerId("ServingRelationship")} markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M 2 1 L 10 6 L 2 11" fill="none" stroke="#57606a" strokeWidth="1.5" /></marker>
      <marker id={markerId("AccessRelationship")} markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M 2 1 L 10 6 L 2 11" fill="none" stroke="#57606a" strokeWidth="1.5" /></marker>
      <marker id={markerId("TriggeringRelationship")} markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M 1 1 L 11 6 L 1 11 Z" fill="#57606a" /></marker>
      <marker id={markerId("FlowRelationship")} markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M 1 1 L 11 6 L 1 11 Z" fill="#57606a" /></marker>
    </defs>
    {relationships.map(edge => {
      const from = layout.positions.get(edge.sourceId);
      const to = layout.positions.get(edge.targetId);
      const source = byId.get(edge.sourceId);
      const target = byId.get(edge.targetId);
      if (!from || !to || !source || !target) return null;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      const x1 = horizontal ? from.x + (dx >= 0 ? cardWidth : 0) : from.x + cardWidth / 2;
      const y1 = horizontal ? from.y + cardHeight / 2 : from.y + (dy >= 0 ? cardHeight : 0);
      const x2 = horizontal ? to.x + (dx >= 0 ? 0 : cardWidth) : to.x + cardWidth / 2;
      const y2 = horizontal ? to.y + cardHeight / 2 : to.y + (dy >= 0 ? 0 : cardHeight);
      const needsCurve = Math.abs(to.level - from.level) > 1 || from.level === to.level;
      const curve = dx >= 0 ? -90 : 90;
      const path = needsCurve
        ? "M " + x1 + " " + y1 + " C " + (x1 + (dx >= 0 ? 75 : -75)) + " " + (y1 + curve) + ", " + (x2 - (dx >= 0 ? 75 : -75)) + " " + (y2 + curve) + ", " + x2 + " " + y2
        : "M " + x1 + " " + y1 + " L " + x2 + " " + y2;
      const label = coreRelationshipLabel(edge);
      const marker = markerFor(edge.type);
      const markerStart = marker === "composition" || marker === "assignment" ? "url(#" + markerId(edge.type) + ")" : undefined;
      const markerEnd = marker === "association" || marker === "composition" || marker === "assignment" ? undefined : "url(#" + markerId(edge.type) + ")";
      return <g key={edge.id} data-relationship-id={edge.id} data-confidence={edge.confidence} className={styles.edge + " " + styles["edge_" + marker]}>
        <path d={path} markerStart={markerStart} markerEnd={markerEnd} />
        {label ? <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 12} textAnchor="middle" className={styles.edgeLabel}>{label}</text> : null}
        <title>{source.name + " → " + target.name + ": " + edge.type.replace(/Relationship$/u, "") + (label ? " (" + label + ")" : "") + ". " + (edge.confidence === "proven" ? "Proven" : "Indicated") + " evidence; " + edge.reason}</title>
      </g>;
    })}
    {elements.map(item => {
      const position = layout.positions.get(item.id);
      if (!position) return null;
      const color = item.type === "DataObject" ? "data" : item.type === "ApplicationService" || item.type === "ApplicationFunction" ? "applicationBehavior" : "application";
      const lines = diagramNameLines(item.name);
      const nameStartY = position.y + (lines.length === 1 ? 66 : lines.length === 2 ? 56 : 46);
      const rx = item.type === "ApplicationService" || item.type === "ApplicationFunction" ? 11 : 2;
      return <g key={item.id} className={styles["node_" + color]}>
        <rect x={position.x} y={position.y} width={cardWidth} height={cardHeight} rx={rx} />
        <text x={position.x + cardWidth / 2} y={position.y + 25} textAnchor="middle" className={styles.diagramNodeType}>{elementTypeLabel(item.type).toUpperCase()}</text>
        <text x={position.x + cardWidth / 2} y={nameStartY} textAnchor="middle" className={styles.diagramNodeName}>{lines.map((line, index) => <tspan key={item.id + ":" + index} x={position.x + cardWidth / 2} dy={index === 0 ? 0 : 22}>{line}</tspan>)}</text>
        <title>{item.name + (item.featureGroup ? " · " + item.featureGroup : "")}</title>
      </g>;
    })}
    {!hasDiagram ? <text x="30" y="90" className={styles.emptySvg}>No source-supported relationships were identified for this view.</text> : null}
  </svg>;

  return <div className={styles.diagramRegion}>
    <p className={styles.viewIntroduction}>{narratives.introduction}</p>
    <p className={styles.coreViewNote}>Showing the core source-supported relationships. Endpoints and lower-level details remain in the catalogs.</p>
    <div className={styles.diagramLegend}>
      <span><i className={styles.legendSolid} aria-hidden="true" />Solid line: Association, Composition, or Serving</span>
      <span><i className={styles.legendDashed} aria-hidden="true" />Dashed arrow: Flow or Realization</span>
      <span>ArchiMate end markers identify relationship types; evidence confidence appears in the register.</span>
    </div>
    <figure className={styles.screenDiagramFigure}>
      <div className={styles.diagramViewport} tabIndex={0} role="region" aria-label={typeLabel + " diagram; scroll to inspect"}>{renderSvg()}</div>
      {hasDiagram ? <figcaption className={styles.figureCaption}>Gambar {addViewFigureNumber(view, 1)}: {figureTitle}</figcaption> : null}
    </figure>
    <p className={styles.figureInterpretation}>{hasDiagram ? "Gambar " + addViewFigureNumber(view, 1) + " memperlihatkan bahwa " : ""}{narratives.interpretation}</p>
    <details className={styles.relationshipDetails}>
      <summary>{relationships.length} core relationships and source evidence</summary>
      <OverflowX className={styles.tableScroll} label="Tabel dokumen; geser untuk melihat kolom lain"><RelationshipTable model={model} relationships={relationships} /></OverflowX>
    </details>
  </div>;
}

type DataCatalogEntry = { row: AddBaselineModel["catalogs"]["dataEntities"][number]; element: AddElement };

function DataEntityTable({ model, entries }: { model: AddBaselineModel; entries: DataCatalogEntry[] }) {
  return <table className={styles.dataEntityTable}><TableColumns widths={[20, 16, 13, 17, 13, 21]} /><thead><tr><th>Data object</th><th>Feature group</th><th>Owner</th><th>Distribution</th><th>Review</th><th>Evidence</th></tr></thead><tbody>{entries.map(({ row, element }) => <tr key={row.elementId} data-element-id={row.elementId}><th scope="row">{element.name}<small>{row.description ?? "Data entity detected from a source data access path."}</small></th><td>{element.featureGroup ?? "Unassigned"}</td><td>{row.owner ?? "Requires confirmation"}</td><td>Requires enterprise input</td><td>{element.review}</td><td><EvidenceList model={model} spans={element.evidence} /></td></tr>)}{!entries.length ? <tr><td colSpan={6} className={styles.emptyCell}>No data object matches this search.</td></tr> : null}</tbody></table>;
}

function DataCatalog({ model }: { model: AddBaselineModel }) {
  const [query, setQuery] = useState("");
  const allEntries = model.catalogs.dataEntities.flatMap(row => {
    const element = model.elements.find(item => item.id === row.elementId);
    return element ? [{ row, element }] : [];
  });
  const entries = allEntries.filter(({ element }) => `${element.name} ${element.description ?? ""} ${element.featureGroup ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className={styles.sectionCard} id={PHASE_C_ADD.sections.businessDataModel.id} aria-labelledby="data-catalog-title">
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.businessDataModel.number} · BASELINE</p><h2 id="data-catalog-title">{PHASE_C_ADD.sections.businessDataModel.title}</h2><p>Data entities found in the repository. Physical hosting and ownership require architect confirmation.</p></div><label className={styles.searchLabel}>Search data <input type="search" value={query} onChange={event => { setQuery(event.currentTarget.value); }} placeholder="Name or feature" /></label></div>
    <h3 className={styles.documentSubheading}>Data Entity Catalog</h3>
    <OverflowX className={`${styles.tableScroll} ${styles.screenDataCatalog}`} label="Katalog data entity; geser untuk melihat kolom lain"><DataEntityTable model={model} entries={entries} /></OverflowX>
    <OverflowX className={`${styles.tableScroll} ${styles.printDataCatalog}`} label="Katalog data entity; geser untuk melihat kolom lain"><DataEntityTable model={model} entries={allEntries} /></OverflowX>
  </section>;
}

function ApplicationCatalog({ model }: { model: AddBaselineModel }) {
  return <section className={styles.sectionCard} id={PHASE_C_ADD.sections.applicationCatalog.id} aria-labelledby="application-catalog-title">
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.applicationCatalog.number} · CATALOG</p><h2 id="application-catalog-title">{PHASE_C_ADD.sections.applicationCatalog.title}</h2><p>Current application components and interfaces found in the analyzed source snapshot.</p></div></div>
    <div className={styles.portfolioGrid}>{model.catalogs.applicationPortfolio.length ? model.catalogs.applicationPortfolio.map(row => { const item = model.elements.find(element => element.id === row.elementId); return item ? <article className={styles.portfolioItem} key={item.id}><span>Baseline · {elementTypeLabel(item.type)}</span><h3>{item.name}</h3><p>{item.description ?? "Component in the analyzed repository."}</p><EvidenceList model={model} spans={item.evidence} /></article> : null; }) : <p className={styles.muted}>No application component was identified in this repository snapshot.</p>}</div>
  </section>;
}

function InterfaceCatalog({ model }: { model: AddBaselineModel }) {
  return <section className={styles.sectionCard} id={PHASE_C_ADD.sections.interfaceCatalog.id} aria-labelledby="interface-catalog-title">
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.interfaceCatalog.number} · CATALOG</p><h2 id="interface-catalog-title">{PHASE_C_ADD.sections.interfaceCatalog.title}</h2></div></div>
    {model.catalogs.interfaces.length ? <OverflowX className={styles.tableScroll} label="Tabel dokumen; geser untuk melihat kolom lain"><table className={styles.interfaceTable}><TableColumns widths={[22, 17, 23, 15, 23]} /><thead><tr><th>Interface</th><th>Protocol</th><th>Contract</th><th>Review</th><th>Evidence</th></tr></thead><tbody>{model.catalogs.interfaces.map(row => { const item = model.elements.find(element => element.id === row.elementId); return item ? <tr key={item.id}><th scope="row">{item.name}</th><td>{row.protocol ?? "Not identified"}</td><td>{row.contract ?? "Not extracted"}</td><td>{item.review}</td><td><EvidenceList model={model} spans={item.evidence} /></td></tr> : null; })}</tbody></table></OverflowX> : <p className={styles.muted}>No interface was identified in this repository snapshot.</p>}
  </section>;
}

function FunctionalCatalog({ model }: { model: AddBaselineModel }) {
  const entries = model.elements.filter(element => element.type === "ApplicationFunction" || element.type === "ApplicationService");
  return <section className={styles.sectionCard} id={PHASE_C_ADD.sections.logicalApplicationComponents.id} aria-labelledby="functional-decomposition-title">
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.logicalApplicationComponents.number} · CATALOG</p><h2 id="functional-decomposition-title">{PHASE_C_ADD.sections.logicalApplicationComponents.title}</h2><p>Functions and services recognized in source. Each item remains linked to evidence and relationship confidence.</p></div></div>
    <OverflowX className={styles.tableScroll} label="Tabel dokumen; geser untuk melihat kolom lain"><table className={styles.functionalTable}><TableColumns widths={[16, 17, 13, 19, 17, 18]} /><thead><tr><th>Type</th><th>Function or module</th><th>Feature group</th><th>Description</th><th>Review</th><th>Evidence</th></tr></thead><tbody>
      {entries.map(item => <tr key={item.id}><td>{elementTypeLabel(item.type)}</td><th scope="row">{item.name}</th><td>{item.featureGroup ?? "Unassigned"}</td><td>{item.description ?? "No additional description was extracted."}</td><td>{item.review}</td><td><EvidenceList model={model} spans={item.evidence} /></td></tr>)}
      {!entries.length ? <tr><td colSpan={6} className={styles.emptyCell}>No application functions or modules were recognized in this snapshot.</td></tr> : null}
    </tbody></table></OverflowX>
  </section>;
}

function CrudMatrix({ model }: { model: AddBaselineModel }) {
  const appById = new Map(model.elements.filter(element => element.type === "ApplicationComponent").map(element => [element.id, element.name]));
  const dataById = new Map(model.elements.filter(element => element.type === "DataObject").map(element => [element.id, element.name]));
  const cell = (value: "yes" | "no" | "unknown") => value === "yes" ? "Y" : value === "no" ? "N" : "?";
  return <section className={styles.sectionCard} id={PHASE_C_ADD.sections.dataCrudMatrix.id} aria-labelledby="crud-matrix-title">
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.dataCrudMatrix.number} · MATRIX</p><h2 id="crud-matrix-title">{PHASE_C_ADD.sections.dataCrudMatrix.title}</h2><p>Application components are used because the repository does not establish business functions. C = Create, R = Read, U = Update, D = Delete. ? means not confirmed; it does not mean “No”.</p></div></div>
    <OverflowX className={styles.tableScroll} label="Tabel dokumen; geser untuk melihat kolom lain"><table className={styles.crudTable}><TableColumns widths={[20, 19, 8, 8, 8, 8, 29]} /><thead><tr><th>Application component</th><th>Data entity</th><th>C</th><th>R</th><th>U</th><th>D</th><th>Evidence</th></tr></thead><tbody>{model.matrices.applicationData.map((row, index) => <tr key={`${row.applicationId}:${row.dataId}:${index}`}><th scope="row">{appById.get(row.applicationId) ?? "Unknown application"}</th><td>{dataById.get(row.dataId) ?? "Unknown data object"}</td><td>{cell(row.create)}</td><td>{cell(row.read)}</td><td>{cell(row.update)}</td><td>{cell(row.delete)}</td><td><EvidenceList model={model} spans={row.evidence} /></td></tr>)}</tbody></table></OverflowX>
    {!model.matrices.applicationData.length ? <p className={styles.muted}>No application–data operation has enough source evidence for this matrix yet.</p> : null}
  </section>;
}

function ReviewEditor({ model, overlay, update, reset, markReviewed, save, saving, saveMessage, saveError }: {
  model: AddBaselineModel; overlay: AddReviewOverlay; update: (id: string, patch: NonNullable<AddReviewOverlay["elements"][string]>) => void; reset: (id: string) => void;
  markReviewed: (status: "draft" | "reviewed") => void; save: () => void; saving: boolean; saveMessage: string | null; saveError: string | null;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [page, setPage] = useState(0);
  const effectiveGroup = (element: AddElement) => {
    const correction = overlay.elements[element.id]?.featureGroup;
    return correction === undefined ? element.featureGroup ?? null : correction;
  };
  const featureGroups = [...new Set(model.elements.map(effectiveGroup).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
  const reviewable = model.elements;
  const filtered = reviewable.filter(element => {
    const change = overlay.elements[element.id]; const name = change?.name ?? element.name; const assignedGroup = change?.featureGroup === undefined ? element.featureGroup : change.featureGroup;
    return `${name} ${element.description ?? ""} ${elementTypeLabel(element.type)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (group === "all" || (assignedGroup ?? "unassigned") === group);
  });
  const pageSize = 12; const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  return <section className={styles.sectionCard + " " + styles.reviewPanel} id="review" aria-labelledby="review-title">
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>REVIEW</p><h2 id="review-title">Review and correct the baseline</h2><p>Corrections are stored as a versioned overlay. The analyzed source facts remain unchanged.</p></div><span className={styles.reviewStatusPill}><Badge tone={overlay.status === "reviewed" ? "success" : "warning"}>{overlay.status === "reviewed" ? "Reviewed" : "Draft"} · revision {overlay.revision}</Badge></span></div>
    <div className={styles.reviewToolbar}><label>Search elements <input type="search" disabled={saving} value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(0); }} placeholder="Name or description" /></label><label>Feature group <select disabled={saving} value={group} onChange={event => { setGroup(event.currentTarget.value); setPage(0); }}><option value="all">All groups</option><option value="unassigned">Unassigned</option>{featureGroups.map(item => <option key={item} value={item}>{item}</option>)}</select></label><span>{filtered.length} of {reviewable.length} elements</span></div>
    <div className={styles.reviewRows}>{visible.map(element => {
      const changes = overlay.elements[element.id] ?? {}; const name = changes.name ?? element.name; const selectedGroup = changes.featureGroup === undefined ? element.featureGroup ?? "unassigned" : changes.featureGroup ?? "unassigned";
      const isConfirmed = changes.review === "confirmed";
      const isRejected = changes.review === "rejected";
      const reviewState = changes.review ?? element.review;
      const groupId = `review-group-${element.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      // Baris atas: identitas + status; baris bawah: field berdampingan lalu aksi (turun dan wrap di layar sempit).
      return <article key={element.id} className={styles.reviewRow}>
        <div className={styles.reviewHead}>
          <div className={styles.reviewIdentity}><span>{elementTypeLabel(element.type)}</span><strong>{name}</strong><EvidenceList model={model} spans={element.evidence} /></div>
          <Badge tone={reviewState === "confirmed" ? "success" : reviewState === "rejected" ? "error" : "neutral"}>{reviewState === "confirmed" ? "Dikonfirmasi" : reviewState === "rejected" ? "Ditolak" : "Belum direview"}</Badge>
        </div>
        <div className={styles.reviewEdit}>
          <div className={styles.reviewFields}>
            <Field className={styles.reviewField} label="Display name" disabled={saving} value={name} maxLength={180} onChange={event => update(element.id, { name: event.currentTarget.value })} />
            <Field className={styles.reviewField} id={groupId} label="Feature group" disabled={saving} trailing={<AssetIcon group="header" name="imgIconChevronDown" />}>
              <select id={groupId} disabled={saving} value={selectedGroup} onChange={event => update(element.id, { featureGroup: event.currentTarget.value === "unassigned" ? null : event.currentTarget.value })}><option value="unassigned">Unassigned</option>{featureGroups.map(item => <option key={item} value={item}>{item}</option>)}</select>
            </Field>
          </div>
          <div className={styles.reviewActions}>
            <Button variant="secondary" disabled={saving} className={styles.reviewAction} data-tone={isConfirmed ? "success" : undefined} aria-pressed={isConfirmed} onClick={() => update(element.id, { review: isConfirmed ? "rejected" : "confirmed" })}>{isConfirmed ? "Confirmed" : "Confirm"}</Button>
            <Button variant="secondary" disabled={saving} className={styles.reviewAction} data-tone={isRejected ? "error" : undefined} aria-pressed={isRejected} onClick={() => update(element.id, { review: "rejected" })}>Reject</Button>
            <Button variant="link" disabled={saving} onClick={() => reset(element.id)}>Reset</Button>
          </div>
        </div>
      </article>;
    })}</div>
    <div className={styles.pagination}><button type="button" className={styles.secondaryButton} disabled={saving || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {pages}</span><button type="button" className={styles.secondaryButton} disabled={saving || currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>
    <div className={styles.reviewFooter}><div><button className={styles.secondaryButton} disabled={saving} type="button" onClick={() => markReviewed(overlay.status === "reviewed" ? "draft" : "reviewed")}>{overlay.status === "reviewed" ? "Reopen as draft" : "Mark document reviewed"}</button><p>Review status records your sign-off; it does not claim that source evidence changed.</p></div><button className={styles.primaryButton} type="button" disabled={saving} onClick={save}>{saving ? "Saving review…" : "Save review"}</button></div>
    {saveMessage ? <p className={styles.successMessage} role="status">{saveMessage}</p> : null}{saveError ? <p className={styles.errorMessage} role="alert">{saveError}</p> : null}
  </section>;
}

function ExportPanel({ model, modelHash, overlay }: { model: AddBaselineModel; modelHash: string; overlay: AddReviewOverlay }) {
  const repositoryName = model.snapshot.repository.split("/").at(-1) ?? "repository";
  const downloadMarkdown = () => {
    const blob = new Blob([createAddMarkdown(model, overlay, (span, fileOnly) => githubEvidence(model.snapshot.repository, model.snapshot.commitSha, span, fileOnly), { modelHash })], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = href; anchor.download = repositoryName + "-phase-c-add.md"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const downloadLatex = () => {
    const blob = new Blob([createAddLatex(model, overlay, (span, fileOnly) => githubEvidence(model.snapshot.repository, model.snapshot.commitSha, span, fileOnly), { modelHash, generatedAt: new Date().toISOString() })], { type: "application/x-tex;charset=utf-8" });
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = href; anchor.download = repositoryName + "-phase-c-add.tex"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  return <section className={`${styles.sectionCard} ${styles.exportPanel}`} id="export" aria-labelledby="export-title"><div><p className={styles.eyebrow}>EXPORT</p><h2 id="export-title">Export Architecture Definition Document (ADD)</h2><p>Markdown and LaTeX use the same Phase C baseline, repository snapshot, review overlay, catalogs, matrices, and evidence links. Print the page to save a PDF with the same content and A4 layout.</p></div><div className={styles.exportActions}><button className={styles.primaryButton} type="button" onClick={downloadMarkdown}>Download Markdown</button><button className={styles.secondaryButton} type="button" onClick={downloadLatex}>Download LaTeX</button><button className={styles.secondaryButton} type="button" onClick={() => window.print()}>Print / Save as PDF</button></div></section>;
}

export function AddWorkspace({ analysisId, accountKey, context }: { analysisId: string; accountKey: string; context?: AddPageContext }) {
  const [state, setState] = useState<PageState>("loading");
  const [data, setData] = useState<ApiRecord | null>(null);
  const [overlay, setOverlay] = useState<AddReviewOverlay>(emptyAddReviewOverlay());
  const [error, setError] = useState<string | null>(null);
  // Kode error dari API (mis. ADD_NOT_READY) hanya untuk memilih tampilan state; logika muat tidak berubah.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const llmConsentInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const aborter = useRef<AbortController | null>(null);
  const visibleData = data?.accountKey === accountKey && data.analysisId === analysisId ? data : null;
  const pageState = state === "ready" && !visibleData ? "loading" : state;
  const reviewedModel = useMemo(() => visibleData ? applyAddReviewOverlay(visibleData.model, overlay) : null, [visibleData, overlay]);

  const load = useCallback(async () => {
    const token = ++generation.current;
    aborter.current?.abort(); const controller = new AbortController(); aborter.current = controller;
    try {
      const session = await fetch("/api/auth/session", { headers: { "X-SAGE-Account": accountKey }, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const sessionBody = await session.json() as AddResponse;
      if (generation.current !== token) return;
      setState("loading"); setData(null); setError(null); setErrorCode(null); setSaveError(null); setSaveMessage(null);
      if (session.status === 401 || !session.ok || !isRecord(sessionBody.data) || sessionBody.data.accountKey !== accountKey) { window.location.replace("/login?error=session"); return; }
      const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/add`, { headers: { "X-SAGE-Account": accountKey }, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const body = await response.json() as AddResponse;
      if (generation.current !== token) return;
      if (response.status === 401) { window.location.replace("/login?error=session"); return; }
      if (response.status === 409 && isRecord(body.data) && body.data.status === "not-generated") { setState("not-generated"); return; }
      if (!response.ok) throw Object.assign(new Error(body.error?.message ?? "ADD belum dapat dimuat."), { code: body.error?.code });
      const parsed = parseApiRecord(body.data, analysisId, accountKey);
      if (!parsed) throw new Error("Snapshot ADD tidak cocok dengan akun atau format hasil.");
      const finalSession = await fetch("/api/auth/session", { headers: { "X-SAGE-Account": accountKey }, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const finalBody = await finalSession.json() as AddResponse;
      if (finalSession.status === 401 || !finalSession.ok || !isRecord(finalBody.data) || finalBody.data.accountKey !== accountKey) { window.location.replace("/login?error=session"); return; }
      if (generation.current !== token) return;
      setData(parsed); setOverlay(parsed.overlay); setState("ready");
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== token) return;
      setError(cause instanceof Error ? cause.message : "ADD belum dapat dimuat.");
      const code = cause instanceof Error ? (cause as Error & { code?: unknown }).code : undefined;
      setErrorCode(typeof code === "string" ? code : null);
      setState("error");
    } finally { if (aborter.current === controller) aborter.current = null; }
  }, [analysisId, accountKey]);

  useEffect(() => {
    let active = true;
    const verifySession = async () => {
      try {
        const response = await fetch("/api/auth/session", { headers: { "X-SAGE-Account": accountKey }, credentials: "same-origin", cache: "no-store" });
        const body = await response.json() as AddResponse;
        if (!active) return;
        if (!response.ok || !isRecord(body.data) || body.data.accountKey !== accountKey) { setData(null); window.location.replace("/login?error=session"); }
      } catch { /* A transient session probe does not replace the displayed snapshot. */ }
    };
    void Promise.resolve().then(() => { if (active) return load(); });
    const onVisibility = () => { if (document.visibilityState === "visible") void verifySession(); };
    window.addEventListener("focus", onVisibility); document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void verifySession(); }, 20_000);
    return () => { active = false; generation.current += 1; aborter.current?.abort(); window.clearInterval(interval); window.removeEventListener("focus", onVisibility); document.removeEventListener("visibilitychange", onVisibility); };
  }, [load, accountKey]);

  async function generateBaseline() {
    if (generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const session = await fetch("/api/auth/session", { headers: { "X-SAGE-Account": accountKey }, credentials: "same-origin", cache: "no-store" });
      const sessionBody = await session.json() as AddResponse;
      if (session.status === 401 || !session.ok || !isRecord(sessionBody.data) || sessionBody.data.accountKey !== accountKey) {
        window.location.replace("/login?error=session");
        return;
      }
      const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SAGE-Account": accountKey },
        body: JSON.stringify({ allowLlm: llmConsentInput.current?.checked === true }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = await response.json() as AddResponse;
      if (response.status === 401) {
        window.location.replace("/login?error=session");
        return;
      }
      if (!response.ok) throw new Error(body.error?.message ?? "ADD belum dapat dibuat. Coba lagi.");
      await load();
    } catch (cause) {
      setGenerateError(cause instanceof Error ? cause.message : "ADD belum dapat dibuat. Coba lagi.");
    } finally {
      setGenerating(false);
    }
  }

  function updateElement(id: string, patch: NonNullable<AddReviewOverlay["elements"][string]>) {
    setSaveMessage(null); setSaveError(null);
    setOverlay(current => ({ ...current, elements: { ...current.elements, [id]: { ...current.elements[id], ...patch } } }));
  }
  function resetElement(id: string) { setOverlay(current => { const elements = { ...current.elements }; delete elements[id]; return { ...current, elements }; }); setSaveMessage(null); }

  async function saveReview() {
    if (!visibleData) return;
    setSaving(true); setSaveError(null); setSaveMessage(null);
    try {
      const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/add`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-SAGE-Account": accountKey }, body: JSON.stringify({ expectedRevision: visibleData.revision, overlay: { schemaVersion: overlay.schemaVersion, status: overlay.status, elements: overlay.elements } }), credentials: "same-origin", cache: "no-store" });
      const body = await response.json() as AddResponse;
      if (response.status === 401) { setData(null); window.location.replace("/login?error=session"); return; }
      if (!response.ok || !isRecord(body.data) || body.data.accountKey !== accountKey) throw new Error(body.error?.message ?? "Review belum tersimpan.");
      const nextOverlay = body.data.overlay as AddReviewOverlay;
      if (nextOverlay.schemaVersion !== "sage-add-review-v1" || !Number.isSafeInteger(nextOverlay.revision)) throw new Error("Respons review tidak valid.");
      setOverlay(nextOverlay); setData(current => current ? { ...current, revision: nextOverlay.revision, overlay: nextOverlay } : current); setSaveMessage(`Review saved as revision ${nextOverlay.revision}.`);
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : "Review belum tersimpan."); }
    finally { setSaving(false); }
  }

  const activeModel = reviewedModel;
  // Bagian yang paling terlihat: menyorot daftar isi dan mengisi panel kanan (presentasi saja).
  const activeSection = useVisibleSection(DOCUMENT_SECTION_IDS, pageState === "ready" && Boolean(visibleData));
  const analysisHref = `/analyses/${encodeURIComponent(analysisId)}`;
  const notReady = pageState === "error" && errorCode === "ADD_NOT_READY";
  const analysisActive = context?.status === "QUEUED" || context?.status === "RUNNING";
  const shortSha = context?.commitSha.slice(0, 7);
  const documentHeader = activeModel ? <header className={styles.pageHeader} id={PHASE_C_ADD.document.id}>
    {context ? <h2>{documentTitle}</h2> : <h1>{documentTitle}</h1>}
    <p>Architecture Definition Document (ADD) · Baseline Data Architecture and Application Architecture generated from one repository snapshot.</p>
    <dl className={styles.snapshotDetails}><div><dt>Repository</dt><dd>{activeModel.snapshot.repository}</dd></div><div><dt>Source commit</dt><dd><code>{activeModel.snapshot.commitSha}</code></dd></div><div><dt>Branch</dt><dd>{activeModel.snapshot.branch ?? "Not recorded"}</dd></div><div><dt>ArchiMate profile</dt><dd>{activeModel.archimateVersion}</dd></div></dl>
  </header> : null;
  return <main className={styles.page}>
    {context ? <AnalysisPageHead head={context} tab="TOGAF ADD" /> : null}
    {!context ? documentHeader : null}
    <AnalysisNavigation analysisId={analysisId} active="document" resultsAvailable={context ? context.resultsAvailable : true} />
    {context && context.limitationsCount > 0 && pageState !== "ready" ? <div className={states.banner} role="note">
      <span>{context.limitationsCount} batasan analisis tercatat pada snapshot ini. Bagian yang tidak didukung source akan ditandai, bukan ditebak.</span>
      <Link href={analysisHref}>Lihat detail</Link>
    </div> : null}

    <div key={pageState} className={states.stateBlock}>
      {pageState === "loading" ? <section className={states.card} aria-label="Memuat ADD"><SkeletonRows rows={3} label="Memuat baseline Phase C…" /></section> : null}

      {pageState === "error" && notReady ? <section className={states.card} aria-labelledby="add-not-ready-title">
        <p className={states.label}>TOGAF ADD</p>
        <h2 id="add-not-ready-title" className={states.heading}>{analysisActive ? "Analisis belum selesai" : "Hasil analisis belum siap untuk ADD"}</h2>
        <EmptyState role="status" icon={{ group: "landing", name: "imgFeatureData" }} action={<Button href={analysisHref} variant="secondary" arrow>Buka progres analisis</Button>}>{error}</EmptyState>
      </section> : null}

      {pageState === "error" && !notReady ? <section className={states.card}>
        <EmptyState tone="error" role="alert" icon={{ group: "landing", name: "imgFeatureData" }} title="ADD belum dapat dimuat" action={<Button variant="secondary" onClick={() => void load()}>Coba lagi</Button>}>{errorCode ? <><code>{errorCode}</code> — </> : null}{error}</EmptyState>
      </section> : null}

      {pageState === "not-generated" ? <div className={states.columns}>
        <section className={states.card} aria-labelledby="generate-add-title">
          <p className={states.labelTeal}>Buat dokumen</p>
          <h2 id="generate-add-title" className={states.heading}>TOGAF Phase C baseline</h2>
          <p className={states.lead}>Dokumen disusun dari Code Knowledge Graph dan model semantik {shortSha ? <>commit <code>{shortSha}</code></> : "snapshot yang dianalisis"}. Fakta yang tidak didukung source ditandai sebagai perlu konfirmasi, bukan ditebak.</p>
          <ul className={states.parts}>
            {ADD_PARTS.map(part => <li key={part.title} className={states.part}>
              <span className={states.partIcon}><MaskIcon group="landing" name={part.icon} size={20} /></span>
              <span className={states.partCopy}><strong>{part.title}</strong><span>{part.count} bagian · {part.summary}</span></span>
            </li>)}
          </ul>
          <div className={states.consentBox}>
            <label htmlFor="add-llm-consent" className={states.consent}>
              <input key={`${analysisId}:${accountKey}`} ref={llmConsentInput} id="add-llm-consent" type="checkbox" aria-describedby="add-llm-consent-summary add-llm-consent-details" defaultChecked={false} disabled={generating} />
              <span><strong>Bantu narasi dengan LLM kampus (opsional)</strong><span id="add-llm-consent-summary">Opsional. Hanya ringkasan fakta ADD yang dikirim; source code dan kredensial tidak pernah dikirim.</span></span>
            </label>
            {/* Teks pengungkapan lengkap tetap ada di DOM (aria-describedby) dan bisa dibuka. */}
            <details className={states.disclosure}>
              <summary>Data apa yang dikirim?</summary>
              <p id="add-llm-consent-details">Jika dicentang, SAGE mengirim ringkasan fakta ADD yang dibatasi (maksimal 20 entri per kategori: nama aplikasi/fungsi/data/interface, ID elemen, owner atau protokol yang tersedia, label relasi, dan fakta diagram terbatas). Nama interface bisa memuat route API bila route itu nama interface yang diekstrak. Source code, isi file, path file repository, rentang evidence, URL repository, SHA commit, dan kredensial tidak dikirim. LLM hanya menulis ringkasan baseline dan empat deskripsi diagram singkat; LLM tidak dapat mengubah fakta arsitektur atau evidence. Jika gagal atau belum dikonfigurasi, SAGE memakai narasi deterministik. Tinjau teks sebelum ekspor. Tanpa centang, tidak ada permintaan ke LLM.</p>
            </details>
          </div>
          {generateError ? <p className={states.alert} role="alert">{generateError}</p> : null}
          <Button size="lg" block loading={generating} onClick={() => void generateBaseline()}>{generating ? "Menyusun baseline…" : "Generate ADD baseline"}</Button>
        </section>
        <section className={`${states.card} ${states.resultPanel}`} aria-labelledby="add-result-title">
          <h2 id="add-result-title" className={states.heading}>Hasil</h2>
          {generating ? <SkeletonRows rows={4} label="Menyusun baseline ADD…" /> : <div className={states.empty}>
            <span className={states.emptyIcon}><MaskIcon group="landing" name="imgFeatureData" size={34} /></span>
            <strong>ADD belum dibuat</strong>
            <p>Pilih “Generate ADD baseline” untuk menyusun Data Architecture dan Application Architecture beserta diagram ArchiMate (Data Structure dan Application Cooperation) dari snapshot yang sama.</p>
            <Button href={`${analysisHref}/graph`} variant="ghost">Lihat Code Knowledge</Button>
          </div>}
        </section>
      </div> : null}
    </div>

    {pageState === "ready" && activeModel ? <div className={doc.layout}>
      <DocumentToc activeId={activeSection} />
      <div className={doc.content}>
      {context ? documentHeader : null}
      <DocumentMetrics model={activeModel} />
      <nav className={`${styles.contents} ${styles.printOnlyContents}`} aria-label="Phase C contents">
        <h2>Contents</h2>
        <ol className={styles.tocList}>{PHASE_C_ADD_TOC.map(item => <li className={item.level === 0 ? styles.tocDocument : item.level === 1 ? styles.tocGroup : styles.tocSection} key={item.id}><a href={`#${item.id}`}>{item.label}</a></li>)}</ol>
      </nav>
      <section className={styles.chapterGroup} id={PHASE_C_ADD.dataArchitecture.id} aria-labelledby="data-architecture-title">
        <h2 id="data-architecture-title">{PHASE_C_ADD.dataArchitecture.title}</h2>
        <section className={`${styles.sectionCard} ${styles.templateSection}`} id={PHASE_C_ADD.sections.dataPrinciples.id} aria-labelledby="data-principles-title">
          <p className={styles.eyebrow}>{PHASE_C_ADD.sections.dataPrinciples.number}</p><h3 id="data-principles-title">{PHASE_C_ADD.sections.dataPrinciples.title}</h3>
          <p>Approved data principles were not supplied. They require confirmation by the architecture authority and are not inferred from repository source.</p>
        </section>
        <section className={`${styles.baseline} ${styles.templateSection}`} id={PHASE_C_ADD.sections.dataBaseline.id} aria-labelledby="data-baseline-title">
          <p className={styles.eyebrow}>{PHASE_C_ADD.sections.dataBaseline.number}</p><h3 id="data-baseline-title">{PHASE_C_ADD.sections.dataBaseline.title}</h3><p>{activeModel.narratives.dataBaseline}</p>
          <p>Only the baseline is included. Target architecture is outside this generated document.</p>
        </section>
        <DataCatalog model={activeModel} />
        <section className={`${styles.baseline} ${styles.templateSection}`} id={PHASE_C_ADD.sections.logicalDataModel.id} aria-labelledby="logical-data-model-title">
          <div className={styles.baselineHeading}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.logicalDataModel.number}</p><h3 id="logical-data-model-title">{PHASE_C_ADD.sections.logicalDataModel.title}</h3></div><span className={styles.archimateTag}>ArchiMate Data Structure</span></div>
          <ViewDiagram model={activeModel} view="dataStructure" />
        </section>
        <section className={`${styles.sectionCard} ${styles.templateSection}`} id={PHASE_C_ADD.sections.dataManagementProcess.id} aria-labelledby="data-management-process-title">
          <p className={styles.eyebrow}>{PHASE_C_ADD.sections.dataManagementProcess.number}</p><h3 id="data-management-process-title">{PHASE_C_ADD.sections.dataManagementProcess.title}</h3>
          <p>Not assessed. Data governance, stewardship, retention, and operational procedures cannot be established from repository declarations alone.</p>
        </section>
        <section className={`${styles.sectionCard} ${styles.templateSection}`} id={PHASE_C_ADD.sections.dataFunctionMatrix.id} aria-labelledby="data-function-matrix-title">
          <p className={styles.eyebrow}>{PHASE_C_ADD.sections.dataFunctionMatrix.number}</p><h3 id="data-function-matrix-title">{PHASE_C_ADD.sections.dataFunctionMatrix.title}</h3>
          <p>Not assessed. An approved business-function catalog or mapping was not supplied, so this matrix is omitted.</p>
        </section>
        <CrudMatrix model={activeModel} />
      </section>
      <section className={styles.chapterGroup} id={PHASE_C_ADD.applicationArchitecture.id} aria-labelledby="application-architecture-title">
        <h2 id="application-architecture-title">{PHASE_C_ADD.applicationArchitecture.title}</h2>
        <section className={`${styles.baseline} ${styles.templateSection}`} id={PHASE_C_ADD.sections.applicationDesign.id} aria-labelledby="application-design-title">
          <div className={styles.baselineHeading}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.applicationDesign.number}</p><h3 id="application-design-title">{PHASE_C_ADD.sections.applicationDesign.title}</h3><p>{activeModel.narratives.applicationBaseline}</p></div><span className={styles.archimateTag}>ArchiMate Application Cooperation</span></div>
          <ViewDiagram model={activeModel} view="applicationCooperation" />
        </section>
        <ApplicationCatalog model={activeModel} />
        <FunctionalCatalog model={activeModel} />
        <InterfaceCatalog model={activeModel} />
        <section className={`${styles.sectionCard} ${styles.templateSection}`} id={PHASE_C_ADD.sections.applicationInteractions.id} aria-labelledby="application-interactions-title">
          <p className={styles.eyebrow}>{PHASE_C_ADD.sections.applicationInteractions.number}</p><h3 id="application-interactions-title">{PHASE_C_ADD.sections.applicationInteractions.title}</h3>
          {activeModel.matrices.applicationInteractions.length ? <OverflowX className={styles.tableScroll} label="Tabel dokumen; geser untuk melihat kolom lain"><table className={styles.interactionTable}><TableColumns widths={[22, 22, 26, 30]} /><thead><tr><th>Source application</th><th>Target application</th><th>Mechanism</th><th>Evidence</th></tr></thead><tbody>{activeModel.matrices.applicationInteractions.map((row, index) => <tr key={`${row.sourceApplicationId}:${row.targetApplicationId}:${index}`}><td>{activeModel.elements.find(item => item.id === row.sourceApplicationId)?.name ?? row.sourceApplicationId}</td><td>{activeModel.elements.find(item => item.id === row.targetApplicationId)?.name ?? row.targetApplicationId}</td><td>{row.mechanism}</td><td><EvidenceList model={activeModel} spans={row.evidence} /></td></tr>)}</tbody></table></OverflowX> : <p className={styles.muted}>No interaction between separately identified applications or communication mechanism was confirmed in this repository snapshot. Internal calls remain in the Application Cooperation view.</p>}
        </section>
      </section>
      <PrintRelationshipRegister model={activeModel} />
      <section className={`${styles.sectionCard} ${styles.sourceNotes}`} id="source-notes" aria-labelledby="source-notes-title">
        <h2 id="source-notes-title">Source and analysis notes</h2>
        <OverflowX className={styles.tableScroll} label="Tabel dokumen; geser untuk melihat kolom lain"><table><tbody>
          <tr><th scope="row">ADD model SHA-256</th><td><code>{visibleData!.modelHash}</code></td></tr>
          <tr><th scope="row">Source CKG SHA-256</th><td><code>{activeModel.sourceCkgHash}</code></td></tr>
          <tr><th scope="row">Analyzer version</th><td>{activeModel.generation.extractorVersion}</td></tr>
          <tr><th scope="row">Review status</th><td>{overlay.status}, revision {overlay.revision}</td></tr>
          <tr><th scope="row">Narrative assistance</th><td>{activeModel.generation.llmOutcome}{activeModel.generation.llmModel ? " · " + activeModel.generation.llmModel : ""}</td></tr>
        </tbody></table></OverflowX>
        {activeModel.limitations.length ? <><h3 className={styles.documentSubheading}>Items requiring confirmation</h3><ul>{activeModel.limitations.map(item => <li key={item}>{item}</li>)}</ul></> : null}
      </section>
      <ReviewEditor model={activeModel} overlay={overlay} update={updateElement} reset={resetElement} markReviewed={status => setOverlay(current => ({ ...current, status }))} save={() => void saveReview()} saving={saving} saveMessage={saveMessage} saveError={saveError} />
      <p className={styles.footer}>Generated from source commit {activeModel.snapshot.commitSha}. Corrections remain in review overlay revision {overlay.revision}.</p>
      </div>
      <aside className={doc.rail} aria-label="Panel bagian aktif dan ekspor" data-print-hide>
        <ActiveSectionPanel activeId={activeSection} model={activeModel} overlay={overlay} />
        <ExportPanel model={visibleData!.model} modelHash={visibleData!.modelHash} overlay={overlay} />
      </aside>
    </div> : null}
  </main>;
}
