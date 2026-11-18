"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyAddReviewOverlay, emptyAddReviewOverlay, type AddReviewOverlay } from "@sage/documents/add-overlay";
import { isAddBaselineModel, type AddBaselineModel, type AddElement, type AddRelationship } from "@sage/documents/baseline-add-model";
import { createAddMarkdown } from "@sage/documents/baseline-markdown";
import { createAddLatex } from "@sage/documents/baseline-latex";
import { PHASE_C_ADD, PHASE_C_ADD_TOC } from "@sage/documents/phase-c-add";
import { AnalysisNavigation } from "../analysis-navigation/analysis-navigation.tsx";
import styles from "./add-workspace.module.css";

type ApiRecord = { id: string; analysisId: string; modelHash: string; sourceCkgHash: string; model: AddBaselineModel; revision: number; overlay: AddReviewOverlay; accountKey: string };
type PageState = "loading" | "not-generated" | "ready" | "error";
type AddResponse = { data?: unknown; error?: { message?: string } };

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

function githubEvidence(repository: string, commitSha: string, span: { filePath: string; startLine: number; endLine: number }): string {
  const path = span.filePath.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repository}/blob/${commitSha}/${path}#L${span.startLine}-L${span.endLine}`;
}

function EvidenceList({ model, spans }: { model: AddBaselineModel; spans: AddElement["evidence"] }) {
  if (!spans.length) return <span className={styles.muted}>Belum ada source evidence</span>;
  return <ul className={styles.evidenceList}>{spans.slice(0, 4).map((span, index) => <li key={`${span.filePath}:${span.startLine}:${index}`}><a href={githubEvidence(model.snapshot.repository, model.snapshot.commitSha, span)} target="_blank" rel="noreferrer"><code>{span.filePath}:{span.startLine}–{span.endLine}</code></a><small>{span.role}</small></li>)}</ul>;
}

function elementTypeLabel(type: AddElement["type"]): string {
  return ({ ApplicationComponent: "Application", ApplicationFunction: "Function", ApplicationService: "Service", ApplicationInterface: "Interface", DataObject: "Data object" })[type];
}

function ViewDiagram({ model, view }: { model: AddBaselineModel; view: "dataStructure" | "applicationCooperation" }) {
  const viewData = model.views[view];
  const elements = viewData.elementIds.map(id => model.elements.find(item => item.id === id)).filter((item): item is AddElement => Boolean(item));
  const relationships = viewData.relationshipIds.map(id => model.relationships.find(item => item.id === id)).filter((item): item is AddRelationship => Boolean(item));
  const width = 1240;
  const dataView = view === "dataStructure";
  const cardWidth = dataView ? 300 : 250;
  const cardHeight = 74;
  const verticalGap = 112;
  const columns = dataView
    ? ["DataObject"]
    : ["ApplicationComponent", "ApplicationFunction", "ApplicationService", "ApplicationInterface"];
  const xByType: Record<string, number> = dataView
    ? { DataObject: 25 }
    : { ApplicationComponent: 20, ApplicationFunction: 320, ApplicationService: 620, ApplicationInterface: 920 };
  const byColumn = new Map<string, AddElement[]>();
  for (const type of columns) byColumn.set(type, elements.filter(item => item.type === type).sort((a, b) => (a.featureGroup ?? "").localeCompare(b.featureGroup ?? "") || a.name.localeCompare(b.name)));
  const typeLabel = view === "dataStructure" ? "DATA STRUCTURE VIEW" : "APPLICATION COOPERATION VIEW";
  const renderSvg = (pageElements: AddElement[], pageRelationships: AddRelationship[], suffix: string, compact = false) => {
    const pageColumns = new Map<string, AddElement[]>();
    for (const type of columns) pageColumns.set(type, pageElements.filter(item => item.type === type));
    const visibleColumns = compact ? columns.filter(type => (pageColumns.get(type)?.length ?? 0) > 0) : columns;
    const pageXByType: Record<string, number> = compact
      ? Object.fromEntries(visibleColumns.map((type, index) => [type, 25 + index * (cardWidth + 65)]))
      : xByType;
    const dataColumnCount = Math.min(3, pageColumns.get("DataObject")?.length ?? 0);
    const pageWidth = compact
      ? dataView ? Math.max(350, 50 + dataColumnCount * cardWidth + Math.max(0, dataColumnCount - 1) * 85)
        : Math.max(350, 50 + visibleColumns.length * cardWidth + Math.max(0, visibleColumns.length - 1) * 65)
      : width;
    const positions = new Map<string, { x: number; y: number }>();
    if (dataView) {
      const xPositions = [25, 25 + cardWidth + 85, 25 + (cardWidth + 85) * 2];
      (pageColumns.get("DataObject") ?? []).forEach((item, index) => positions.set(item.id, { x: xPositions[index % 3]!, y: 62 + Math.floor(index / 3) * verticalGap }));
    } else {
      for (const type of visibleColumns) (pageColumns.get(type) ?? []).forEach((item, index) => positions.set(item.id, { x: pageXByType[type] ?? 20, y: 62 + index * verticalGap }));
    }
    const rowCount = dataView ? Math.ceil((pageColumns.get("DataObject")?.length ?? 0) / 3) : Math.max(0, ...[...pageColumns.values()].map(items => items.length));
    const height = Math.max(220, 100 + rowCount * verticalGap);
    const idByElement = new Map(pageElements.map(item => [item.id, item]));
    return <svg className={styles.diagram} viewBox={`0 0 ${pageWidth} ${height}`} role="img" aria-labelledby={`${view}-${suffix}-title ${view}-${suffix}-desc`}>
      <title id={`${view}-${suffix}-title`}>{typeLabel}</title><desc id={`${view}-${suffix}-desc`}>ArchiMate element and source-supported relationship overview.</desc>
      <defs><marker id={`${view}-${suffix}-arrow`} markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="#6c7786" /></marker></defs>
      {dataView ? <text x="25" y="28" className={styles.diagramLane}>DATA OBJECTS · EXPLICIT RELATIONSHIPS</text> : visibleColumns.map((type, index) => <g key={type}><text x={(pageXByType[type] ?? 20) + cardWidth / 2} y="28" textAnchor="middle" className={styles.diagramLane}>{elementTypeLabel(type as AddElement["type"]).toUpperCase()}</text>
        {index < visibleColumns.length - 1 ? <line x1={(pageXByType[type] ?? 20) + cardWidth + 14} y1="40" x2={(pageXByType[visibleColumns[index + 1]!] ?? 20) - 14} y2="40" className={styles.laneRule} /> : null}</g>)}
      {pageRelationships.map(edge => {
        const from = positions.get(edge.sourceId); const to = positions.get(edge.targetId);
        if (!from || !to) return null;
        const source = idByElement.get(edge.sourceId)!; const target = idByElement.get(edge.targetId)!;
        const sameColumn = from.x === to.x; const sourceOnLeft = sameColumn ? from.y <= to.y : from.x < to.x;
        const sideOffset = from.x + cardWidth + 26 < pageWidth ? cardWidth : 0;
        const x1 = sameColumn ? from.x + (sideOffset || -18) : sourceOnLeft ? from.x + cardWidth : from.x;
        const x2 = sameColumn ? to.x + (sideOffset || -18) : sourceOnLeft ? to.x : to.x + cardWidth;
        const y1 = from.y + cardHeight / 2; const y2 = to.y + cardHeight / 2;
        const bend = sameColumn ? x1 + (sideOffset ? 24 : -24) : (x1 + x2) / 2;
        const label = edge.label.length > 28 ? `${edge.label.slice(0, 27)}…` : edge.label;
        const strokeClass = edge.confidence === "proven" ? styles.edgeSource : styles.edgeProposed;
        const marker = edge.type === "AssociationRelationship" ? undefined : `url(#${view}-${suffix}-arrow)`;
        return <g key={edge.id} className={strokeClass}><path d={`M ${x1} ${y1} H ${bend} V ${y2} H ${x2}`} markerEnd={marker} />{label ? <text x={bend} y={(y1 + y2) / 2 - 5} textAnchor="middle" className={styles.edgeLabel}>{label}</text> : null}<title>{source.name} → {target.name}: {edge.label} ({edge.confidence}; {edge.reason})</title></g>;
      })}
      {pageElements.map(item => {
        const position = positions.get(item.id); if (!position) return null;
        const color = item.type === "DataObject" ? "data" : item.type === "ApplicationComponent" ? "application" : item.type === "ApplicationInterface" ? "interface" : item.type === "ApplicationService" ? "service" : "function";
        return <g key={item.id} className={styles[`node_${color}`]}><rect x={position.x} y={position.y} width={cardWidth} height={cardHeight} rx="7" /><text x={position.x + 16} y={position.y + 26} className={styles.diagramNodeType}>{elementTypeLabel(item.type).toUpperCase()}</text><text x={position.x + 16} y={position.y + 52} className={styles.diagramNodeName}>{item.name.length > 35 ? `${item.name.slice(0, 34)}…` : item.name}</text><title>{item.name}{item.featureGroup ? ` · ${item.featureGroup}` : ""}</title></g>;
      })}
      {pageElements.length === 0 ? <text x={30} y={90} className={styles.emptySvg}>Belum ada element yang cukup didukung evidence untuk view ini.</text> : null}
    </svg>;
  };
  const pageSize = dataView ? 24 : 8;
  const count = dataView ? (byColumn.get("DataObject")?.length ?? 0) : Math.max(0, ...[...byColumn.values()].map(items => items.length));
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const printPages = Array.from({ length: pageCount }, (_, pageIndex) => {
    const slicedElements = dataView
      ? (byColumn.get("DataObject") ?? []).slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
      : columns.flatMap(type => (byColumn.get(type) ?? []).slice(pageIndex * pageSize, (pageIndex + 1) * pageSize));
    const pageElements = dataView ? slicedElements : [...new Map([
      ...(byColumn.get("ApplicationComponent") ?? []).map(item => [item.id, item] as const),
      ...slicedElements.map(item => [item.id, item] as const),
    ]).values()];
    const visible = new Set(pageElements.map(item => item.id));
    const pageRelationships = relationships.filter(edge => visible.has(edge.sourceId) && visible.has(edge.targetId));
    return { pageElements, pageRelationships, pageIndex };
  });
  const allById = new Map(elements.map(item => [item.id, item]));
  return <div className={styles.diagramRegion}>
    <div className={styles.diagramLegend}><span><i className={styles.legendSolid} aria-hidden="true" />Proven from source structure</span><span><i className={styles.legendDashed} aria-hidden="true" />Indicated mapping, review recommended</span></div>
    <div className={styles.diagramViewport} tabIndex={0} role="region" aria-label={`${typeLabel} diagram; scroll to inspect`}>{renderSvg(elements, relationships, "screen")}</div>
    <div className={styles.printDiagramPages} aria-label={`${typeLabel} paginated print views`}>
      {printPages.map(({ pageElements, pageRelationships, pageIndex }) => <section className={`${styles.printDiagramPage} ${pageIndex === 0 ? styles.printDiagramPageFirst : ""}`} key={pageIndex}><p>{typeLabel} · Diagram {pageIndex + 1} of {pageCount}</p>{renderSvg(pageElements, pageRelationships, `print-${pageIndex}`, true)}</section>)}
    </div>
    <details className={styles.relationshipDetails}>
      <summary>{relationships.length} relationships and source evidence</summary>
      <div className={styles.tableScroll}><table><thead><tr><th>Source</th><th>ArchiMate relationship</th><th>Target</th><th>Confidence</th><th>Review</th><th>Reason</th><th>Evidence</th></tr></thead><tbody>
        {relationships.map(edge => <tr key={edge.id}><th scope="row">{allById.get(edge.sourceId)?.name ?? edge.sourceId}</th><td>{edge.label}</td><td>{allById.get(edge.targetId)?.name ?? edge.targetId}</td><td>{edge.confidence === "proven" ? "Proven" : "Indicated"}</td><td>{edge.review}</td><td>{edge.reason}</td><td><EvidenceList model={model} spans={edge.evidence} /></td></tr>)}
        {!relationships.length ? <tr><td colSpan={7} className={styles.emptyCell}>No relationship was identified.</td></tr> : null}
      </tbody></table></div>
    </details>
  </div>;
}

function DataCatalog({ model }: { model: AddBaselineModel }) {
  const [query, setQuery] = useState("");
  const entries = model.catalogs.dataEntities.map(row => ({ row, element: model.elements.find(item => item.id === row.elementId) })).filter(item => item.element && `${item.element.name} ${item.element.description ?? ""} ${item.element.featureGroup ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className={styles.sectionCard} id={PHASE_C_ADD.sections.businessDataModel.id} aria-labelledby="data-catalog-title">
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.businessDataModel.number} · BASELINE</p><h2 id="data-catalog-title">{PHASE_C_ADD.sections.businessDataModel.title}</h2><p>Data entities found in the repository. Physical hosting and ownership require architect confirmation.</p></div><label className={styles.searchLabel}>Search data <input type="search" value={query} onChange={event => { setQuery(event.currentTarget.value); }} placeholder="Name or feature" /></label></div>
    <h3 className={styles.documentSubheading}>Data Entity Catalog</h3>
    <div className={styles.tableScroll}><table><thead><tr><th>Data object</th><th>Feature group</th><th>Owner</th><th>Distribution</th><th>Review</th><th>Evidence</th></tr></thead><tbody>{entries.map(({ row, element }) => <tr key={row.elementId}><th scope="row">{element!.name}<small>{element!.description ?? "Data entity detected from a source data access path."}</small></th><td>{element!.featureGroup ?? "Unassigned"}</td><td>{row.owner ?? "Requires confirmation"}</td><td>Requires enterprise input</td><td>{element!.review}</td><td><EvidenceList model={model} spans={element!.evidence} /></td></tr>)}{!entries.length ? <tr><td colSpan={6} className={styles.emptyCell}>No data object matches this search.</td></tr> : null}</tbody></table></div>
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
    {model.catalogs.interfaces.length ? <div className={styles.tableScroll}><table><thead><tr><th>Interface</th><th>Protocol</th><th>Contract</th><th>Review</th><th>Evidence</th></tr></thead><tbody>{model.catalogs.interfaces.map(row => { const item = model.elements.find(element => element.id === row.elementId); return item ? <tr key={item.id}><th scope="row">{item.name}</th><td>{row.protocol ?? "Not identified"}</td><td>{row.contract ?? "Not extracted"}</td><td>{item.review}</td><td><EvidenceList model={model} spans={item.evidence} /></td></tr> : null; })}</tbody></table></div> : <p className={styles.muted}>No interface was identified in this repository snapshot.</p>}
  </section>;
}

function FunctionalCatalog({ model }: { model: AddBaselineModel }) {
  const entries = model.elements.filter(element => element.type === "ApplicationFunction" || element.type === "ApplicationService");
  return <section className={styles.sectionCard} id={PHASE_C_ADD.sections.logicalApplicationComponents.id} aria-labelledby="functional-decomposition-title">
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.logicalApplicationComponents.number} · CATALOG</p><h2 id="functional-decomposition-title">{PHASE_C_ADD.sections.logicalApplicationComponents.title}</h2><p>Functions and services recognized in source. Each item remains linked to evidence and relationship confidence.</p></div></div>
    <div className={styles.tableScroll}><table><thead><tr><th>Type</th><th>Function or module</th><th>Feature group</th><th>Description</th><th>Review</th><th>Evidence</th></tr></thead><tbody>
      {entries.map(item => <tr key={item.id}><td>{elementTypeLabel(item.type)}</td><th scope="row">{item.name}</th><td>{item.featureGroup ?? "Unassigned"}</td><td>{item.description ?? "No additional description was extracted."}</td><td>{item.review}</td><td><EvidenceList model={model} spans={item.evidence} /></td></tr>)}
      {!entries.length ? <tr><td colSpan={6} className={styles.emptyCell}>No application functions or modules were recognized in this snapshot.</td></tr> : null}
    </tbody></table></div>
  </section>;
}

function CrudMatrix({ model }: { model: AddBaselineModel }) {
  const appById = new Map(model.elements.filter(element => element.type === "ApplicationComponent").map(element => [element.id, element.name]));
  const dataById = new Map(model.elements.filter(element => element.type === "DataObject").map(element => [element.id, element.name]));
  const cell = (value: "yes" | "no" | "unknown") => value === "yes" ? "Yes" : value === "no" ? "No" : "Unknown";
  return <section className={styles.sectionCard} id={PHASE_C_ADD.sections.dataCrudMatrix.id} aria-labelledby="crud-matrix-title">
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.dataCrudMatrix.number} · MATRIX</p><h2 id="crud-matrix-title">{PHASE_C_ADD.sections.dataCrudMatrix.title}</h2><p>Application components are used because the repository does not establish business functions. Unknown means the operation was not confirmed; it does not mean “No”.</p></div></div>
    <div className={styles.tableScroll}><table><thead><tr><th>Application</th><th>Data object</th><th>Create</th><th>Read</th><th>Update</th><th>Delete</th><th>Evidence</th></tr></thead><tbody>{model.matrices.applicationData.map((row, index) => <tr key={`${row.applicationId}:${row.dataId}:${index}`}><th scope="row">{appById.get(row.applicationId) ?? "Unknown application"}</th><td>{dataById.get(row.dataId) ?? "Unknown data object"}</td><td>{cell(row.create)}</td><td>{cell(row.read)}</td><td>{cell(row.update)}</td><td>{cell(row.delete)}</td><td><EvidenceList model={model} spans={row.evidence} /></td></tr>)}</tbody></table></div>
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
    <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>REVIEW</p><h2 id="review-title">Review and correct the baseline</h2><p>Corrections are stored as a versioned overlay. The analyzed source facts remain unchanged.</p></div><span className={overlay.status === "reviewed" ? styles.reviewed : styles.draft}>{overlay.status === "reviewed" ? "Reviewed" : "Draft"} · revision {overlay.revision}</span></div>
    <div className={styles.reviewToolbar}><label>Search elements <input type="search" disabled={saving} value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(0); }} placeholder="Name or description" /></label><label>Feature group <select disabled={saving} value={group} onChange={event => { setGroup(event.currentTarget.value); setPage(0); }}><option value="all">All groups</option><option value="unassigned">Unassigned</option>{featureGroups.map(item => <option key={item} value={item}>{item}</option>)}</select></label><span>{filtered.length} of {reviewable.length} elements</span></div>
    <div className={styles.reviewRows}>{visible.map(element => {
      const changes = overlay.elements[element.id] ?? {}; const name = changes.name ?? element.name; const selectedGroup = changes.featureGroup === undefined ? element.featureGroup ?? "unassigned" : changes.featureGroup ?? "unassigned";
      const isConfirmed = changes.review === "confirmed";
      const isRejected = changes.review === "rejected";
      return <article key={element.id} className={styles.reviewRow}><div className={styles.reviewIdentity}><span>{elementTypeLabel(element.type)}</span><strong>{name}</strong><EvidenceList model={model} spans={element.evidence} /></div><label>Display name<input disabled={saving} value={name} maxLength={180} onChange={event => update(element.id, { name: event.currentTarget.value })} /></label><label>Feature group<select disabled={saving} value={selectedGroup} onChange={event => update(element.id, { featureGroup: event.currentTarget.value === "unassigned" ? null : event.currentTarget.value })}><option value="unassigned">Unassigned</option>{featureGroups.map(item => <option key={item} value={item}>{item}</option>)}</select></label><div className={styles.reviewActions}><button disabled={saving} type="button" className={isConfirmed ? styles.primaryButton : styles.secondaryButton} aria-pressed={isConfirmed} onClick={() => update(element.id, { review: isConfirmed ? "rejected" : "confirmed" })}>{isConfirmed ? "Confirmed" : "Confirm"}</button><button disabled={saving} type="button" className={styles.secondaryButton} aria-pressed={isRejected} onClick={() => update(element.id, { review: "rejected" })}>Reject</button><button disabled={saving} type="button" className={styles.linkButton} onClick={() => reset(element.id)}>Reset</button></div></article>;
    })}</div>
    <div className={styles.pagination}><button type="button" className={styles.secondaryButton} disabled={saving || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {pages}</span><button type="button" className={styles.secondaryButton} disabled={saving || currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>
    <div className={styles.reviewFooter}><div><button className={styles.secondaryButton} disabled={saving} type="button" onClick={() => markReviewed(overlay.status === "reviewed" ? "draft" : "reviewed")}>{overlay.status === "reviewed" ? "Reopen as draft" : "Mark document reviewed"}</button><p>Review status records your sign-off; it does not claim that source evidence changed.</p></div><button className={styles.primaryButton} type="button" disabled={saving} onClick={save}>{saving ? "Saving review…" : "Save review"}</button></div>
    {saveMessage ? <p className={styles.successMessage} role="status">{saveMessage}</p> : null}{saveError ? <p className={styles.errorMessage} role="alert">{saveError}</p> : null}
  </section>;
}

function ExportPanel({ model, modelHash, overlay }: { model: AddBaselineModel; modelHash: string; overlay: AddReviewOverlay }) {
  const repositoryName = model.snapshot.repository.split("/").at(-1) ?? "repository";
  const downloadMarkdown = () => {
    const blob = new Blob([createAddMarkdown(model, overlay, span => githubEvidence(model.snapshot.repository, model.snapshot.commitSha, span), { modelHash })], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = href; anchor.download = repositoryName + "-phase-c-add.md"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const downloadLatex = () => {
    const blob = new Blob([createAddLatex(model, overlay, span => githubEvidence(model.snapshot.repository, model.snapshot.commitSha, span), { modelHash })], { type: "application/x-tex;charset=utf-8" });
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = href; anchor.download = repositoryName + "-phase-c-add.tex"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  return <section className={`${styles.sectionCard} ${styles.exportPanel}`} id="export" aria-labelledby="export-title"><div><p className={styles.eyebrow}>EXPORT</p><h2 id="export-title">Export Architecture Definition Document (ADD)</h2><p>Markdown and LaTeX use the same Phase C baseline, repository snapshot, review overlay, catalogs, matrices, and evidence links. Print the page to save a PDF with the same content and A4 layout.</p></div><div className={styles.exportActions}><button className={styles.primaryButton} type="button" onClick={downloadMarkdown}>Download Markdown</button><button className={styles.secondaryButton} type="button" onClick={downloadLatex}>Download LaTeX</button><button className={styles.secondaryButton} type="button" onClick={() => window.print()}>Print / Save as PDF</button></div></section>;
}

export function AddWorkspace({ analysisId, accountKey }: { analysisId: string; accountKey: string }) {
  const [state, setState] = useState<PageState>("loading");
  const [data, setData] = useState<ApiRecord | null>(null);
  const [overlay, setOverlay] = useState<AddReviewOverlay>(emptyAddReviewOverlay());
  const [error, setError] = useState<string | null>(null);
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
      setState("loading"); setData(null); setError(null); setSaveError(null); setSaveMessage(null);
      if (session.status === 401 || !session.ok || !isRecord(sessionBody.data) || sessionBody.data.accountKey !== accountKey) { window.location.replace("/login?error=session"); return; }
      const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/add`, { headers: { "X-SAGE-Account": accountKey }, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const body = await response.json() as AddResponse;
      if (generation.current !== token) return;
      if (response.status === 401) { window.location.replace("/login?error=session"); return; }
      if (response.status === 409 && isRecord(body.data) && body.data.status === "not-generated") { setState("not-generated"); return; }
      if (!response.ok) throw new Error(body.error?.message ?? "ADD belum dapat dimuat.");
      const parsed = parseApiRecord(body.data, analysisId, accountKey);
      if (!parsed) throw new Error("Snapshot ADD tidak cocok dengan akun atau format hasil.");
      const finalSession = await fetch("/api/auth/session", { headers: { "X-SAGE-Account": accountKey }, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const finalBody = await finalSession.json() as AddResponse;
      if (finalSession.status === 401 || !finalSession.ok || !isRecord(finalBody.data) || finalBody.data.accountKey !== accountKey) { window.location.replace("/login?error=session"); return; }
      if (generation.current !== token) return;
      setData(parsed); setOverlay(parsed.overlay); setState("ready");
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== token) return;
      setError(cause instanceof Error ? cause.message : "ADD belum dapat dimuat."); setState("error");
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
  return <main className={styles.page}>
    <header className={styles.pageHeader} id={PHASE_C_ADD.document.id}>
      <h1>{PHASE_C_ADD.document.title}</h1>
      <p>Architecture Definition Document (ADD) · Baseline Data Architecture and Application Architecture generated from one repository snapshot.</p>
      {activeModel ? <dl className={styles.snapshotDetails}><div><dt>Repository</dt><dd>{activeModel.snapshot.repository}</dd></div><div><dt>Source commit</dt><dd><code>{activeModel.snapshot.commitSha}</code></dd></div><div><dt>Branch</dt><dd>{activeModel.snapshot.branch ?? "Not recorded"}</dd></div><div><dt>ArchiMate profile</dt><dd>{activeModel.archimateVersion}</dd></div></dl> : null}
    </header>
    <AnalysisNavigation analysisId={analysisId} active="document" />
    {pageState === "loading" ? <p className={styles.loading} role="status">Loading the Phase C baseline…</p> : null}
    {pageState === "error" ? <section className={styles.errorPanel} role="alert"><h2>ADD unavailable</h2><p>{error}</p><button className={styles.secondaryButton} type="button" onClick={() => void load()}>Retry</button></section> : null}
    {pageState === "not-generated" ? <section className={styles.emptyPanel} aria-labelledby="generate-add-title"><span className={styles.step}>04</span><p className={styles.eyebrow}>GENERATE FROM ANALYSIS</p><h2 id="generate-add-title">Phase C baseline has not been generated</h2><p>Generate the Data and Application Architecture baseline from the analyzed commit. Code Knowledge remains available as a supporting source view.</p>
      <div className={styles.portfolioItem}>
        <span>OPTIONAL</span><h3>Narrative assistance from campus LLM</h3>
        <label htmlFor="add-llm-consent" style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "10px 0", cursor: "pointer" }}><input key={`${analysisId}:${accountKey}`} ref={llmConsentInput} id="add-llm-consent" type="checkbox" aria-describedby="add-llm-consent-details" defaultChecked={false} style={{ marginTop: 4 }} /><span>Enable optional LLM narrative assistance by sending a bounded summary of ADD facts to the campus LLM.</span></label>
        <p id="add-llm-consent-details" className={styles.muted}>If enabled, SAGE sends up to 20 entries per category with application/function/data/interface names, element IDs, available owner or protocol values, and relationship labels. Interface names may contain an API route when that route is the extracted interface name. Source code, file contents, repository file paths, evidence ranges, repository URL, commit SHA, and credentials are not sent. The LLM can write only two narrative paragraphs; it cannot change architecture facts or evidence. If it fails or is not configured, SAGE uses deterministic narratives. Review the text before exporting. With this option unchecked, no LLM request is made.</p>
      </div>
      {generateError ? <p role="alert">{generateError}</p> : null}
      <button className={styles.primaryButton} type="button" disabled={generating} onClick={() => void generateBaseline()}>{generating ? "Generating baseline…" : "Generate Phase C baseline"}</button>
      <p><Link className={styles.secondaryButton} href={`/analyses/${encodeURIComponent(analysisId)}/graph`}>Open Code Knowledge</Link></p>
    </section> : null}
    {pageState === "ready" && activeModel ? <>
      <nav className={styles.contents} aria-label="Phase C contents">
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
          <div className={styles.baselineHeading}><div><p className={styles.eyebrow}>{PHASE_C_ADD.sections.logicalDataModel.number}</p><h3 id="logical-data-model-title">{PHASE_C_ADD.sections.logicalDataModel.title}</h3><p>Source-supported logical data objects and explicit data-to-data associations.</p></div><span className={styles.archimateTag}>ArchiMate Data Structure</span></div>
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
          {activeModel.matrices.applicationInteractions.length ? <div className={styles.tableScroll}><table><thead><tr><th>Source application</th><th>Target application</th><th>Mechanism</th><th>Evidence</th></tr></thead><tbody>{activeModel.matrices.applicationInteractions.map((row, index) => <tr key={`${row.sourceApplicationId}:${row.targetApplicationId}:${index}`}><td>{activeModel.elements.find(item => item.id === row.sourceApplicationId)?.name ?? row.sourceApplicationId}</td><td>{activeModel.elements.find(item => item.id === row.targetApplicationId)?.name ?? row.targetApplicationId}</td><td>{row.mechanism}</td><td><EvidenceList model={activeModel} spans={row.evidence} /></td></tr>)}</tbody></table></div> : <p className={styles.muted}>No interaction between separately identified applications or communication mechanism was confirmed in this repository snapshot. Internal calls remain in the Application Cooperation view.</p>}
        </section>
      </section>
      <section className={`${styles.sectionCard} ${styles.sourceNotes}`} id="source-notes" aria-labelledby="source-notes-title">
        <h2 id="source-notes-title">Source and analysis notes</h2>
        <div className={styles.tableScroll}><table><tbody>
          <tr><th scope="row">ADD model SHA-256</th><td><code>{visibleData!.modelHash}</code></td></tr>
          <tr><th scope="row">Source CKG SHA-256</th><td><code>{activeModel.sourceCkgHash}</code></td></tr>
          <tr><th scope="row">Analyzer version</th><td>{activeModel.generation.extractorVersion}</td></tr>
          <tr><th scope="row">Review status</th><td>{overlay.status}, revision {overlay.revision}</td></tr>
          <tr><th scope="row">Narrative assistance</th><td>{activeModel.generation.llmOutcome}{activeModel.generation.llmModel ? " · " + activeModel.generation.llmModel : ""}</td></tr>
        </tbody></table></div>
        {activeModel.limitations.length ? <><h3 className={styles.documentSubheading}>Items requiring confirmation</h3><ul>{activeModel.limitations.map(item => <li key={item}>{item}</li>)}</ul></> : null}
      </section>
      <ReviewEditor model={activeModel} overlay={overlay} update={updateElement} reset={resetElement} markReviewed={status => setOverlay(current => ({ ...current, status }))} save={() => void saveReview()} saving={saving} saveMessage={saveMessage} saveError={saveError} />
      <ExportPanel model={visibleData!.model} modelHash={visibleData!.modelHash} overlay={overlay} />
      <p className={styles.footer}>Generated from source commit {activeModel.snapshot.commitSha}. Corrections remain in review overlay revision {overlay.revision}.</p>
    </> : null}
  </main>;
}
