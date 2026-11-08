"use client";

import type { SemanticEdge, SemanticNode } from "@sage/documents/semantic/model";
import { relationshipExplanation } from "@sage/documents/semantic/explanations";
import { EvidenceLink } from "../live-document/evidence-links.tsx";
import type { ExplanationOriginFilter } from "./architecture-projection.ts";
import styles from "./semantic-workspace.module.css";

export type { ExplanationOriginFilter } from "./architecture-projection.ts";

export function edgeExplanationOrigin(edge: SemanticEdge): Exclude<ExplanationOriginFilter, "all"> {
  return relationshipExplanation(edge)?.origin ?? "legacy";
}

export function matchesExplanationOrigin(edge: SemanticEdge, origin: ExplanationOriginFilter): boolean {
  return origin === "all" || edgeExplanationOrigin(edge) === origin;
}

export function ExplanationOriginControl({ value, onChange, label = "Relationship origin" }: {
  value: ExplanationOriginFilter;
  onChange: (value: ExplanationOriginFilter) => void;
  label?: string;
}) {
  return <label className={styles.originFilter}>{label}<select aria-label={label} value={value} onChange={event => onChange(event.currentTarget.value as ExplanationOriginFilter)}>
    <option value="all">All origins</option>
    <option value="code">Code</option>
    <option value="documentation">Documentation</option>
    <option value="mixed">Mixed</option>
    <option value="legacy">Legacy · explanation unavailable</option>
  </select></label>;
}

export function RelationshipExplanationPanel({ edges, nodes, repository, commitSha, onClose, title = "Mengapa terhubung?" }: {
  edges: readonly SemanticEdge[];
  nodes: readonly SemanticNode[];
  repository: string;
  commitSha: string;
  onClose: () => void;
  title?: string;
}) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  return <aside className={styles.explanationPanel} aria-label={title} data-testid="relationship-explanation">
    <div className={styles.explanationHeading}><h3>{title}</h3><button type="button" onClick={onClose}>Close explanation</button></div>
    {edges.map(edge => {
      const explanation = relationshipExplanation(edge);
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      return <article className={styles.explanationItem} key={edge.id} data-source-edge-id={edge.id}>
        <h4>{source?.label ?? edge.source} <span aria-hidden="true">→</span> {target?.label ?? edge.target}</h4>
        <p className={styles.explanationLabel}>{edge.label} · {edge.confidence === "proven" ? "Proven confidence" : "Indicated confidence"}</p>
        {explanation ? <>
          <dl className={styles.explanationDetails}>
            <div><dt>Origin</dt><dd>{explanation.origin}</dd></div>
            <div><dt>Rule</dt><dd><code>{explanation.rule}</code></dd></div>
            <div><dt>Reason</dt><dd>{explanation.summary}</dd></div>
          </dl>
          <p className={styles.explanationSourceIds}>Source edge IDs: {explanation.sourceEdgeIds.length ? explanation.sourceEdgeIds.map(id => <code key={id}>{id}</code>) : <span>not recorded</span>}</p>
          <h5>Limitations</h5>
          {explanation.limitations.length ? <ul>{explanation.limitations.map((item, index) => <li key={`${edge.id}:limitation:${index}`}>{item}</li>)}</ul> : <p>Limitations were not recorded.</p>}
        </> : <>
          <p className={styles.unavailableExplanation}>Explanation provenance is unavailable for this legacy relationship. No origin or rule is inferred.</p>
          <dl className={styles.explanationDetails}>
            <div><dt>Stored reason</dt><dd>{edge.reason}</dd></div>
            <div><dt>Origin / rule</dt><dd>Unavailable in this model version</dd></div>
          </dl>
          <h5>Limitations</h5><p>Unavailable: this legacy relationship has no structured limitation metadata.</p>
          <p className={styles.explanationSourceIds}>Source edge ID: <code>{edge.id}</code></p>
        </>}
        <h5>Source evidence</h5>
        {edge.evidence.length ? <ul className={styles.explanationEvidence}>{edge.evidence.map((item, index) => <li key={`${item.filePath}:${item.startLine}:${item.endLine}:${index}`}>
          <EvidenceLink repository={repository} commitSha={commitSha} evidence={item} role={item.role} />
        </li>)}</ul> : <p>Source evidence is unavailable.</p>}
      </article>;
    })}
  </aside>;
}
