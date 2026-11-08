"use client";

import type { ReactNode } from "react";
import type { SemanticModel } from "@sage/documents/semantic/model";
import { EvidenceLink } from "../live-document/evidence-links.tsx";
import styles from "./semantic-workspace.module.css";

type DocumentationContext = NonNullable<SemanticModel["documentation"]>;
type DocumentationBlock = DocumentationContext["documents"][number]["sections"][number]["blocks"][number];
type InlineCode = DocumentationContext["documents"][number]["sections"][number]["inlineCode"][number];

function textWithInlineCode(value: string, spans: InlineCode[]) {
  const result: Array<string | ReactNode> = [];
  let cursor = 0;
  for (const [index, span] of spans.entries()) {
    if (!span.text) continue;
    const position = value.indexOf(span.text, cursor);
    if (position < 0) continue;
    if (position > cursor) result.push(value.slice(cursor, position));
    result.push(<code key={`${span.evidence.filePath}:${span.evidence.startByte}:${index}`}>{span.text}</code>);
    cursor = position + span.text.length;
  }
  if (!result.length) return value;
  if (cursor < value.length) result.push(value.slice(cursor));
  return result;
}

function DocumentationEvidence({ evidence, repository, commitSha }: {
  evidence: DocumentationContext["documents"][number]["sections"][number]["evidence"];
  repository: string;
  commitSha: string;
}) {
  return evidence ? <EvidenceLink repository={repository} commitSha={commitSha} evidence={evidence} role="documentation" /> : <span>Source location unavailable</span>;
}

function renderBlock(block: DocumentationBlock, key: string) {
  if (block.kind === "paragraph" || block.kind === "blockquote") {
    const text = textWithInlineCode(block.text, block.inlineCode);
    return block.kind === "blockquote" ? <blockquote key={key}>{text}</blockquote> : <p key={key}>{text}</p>;
  }
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    return <List key={key} className={styles.documentationList}>{block.items.map((item, index) => <li key={`${key}:${index}`} style={{ marginInlineStart: `${Math.min(12, item.depth) * 12}px` }}>
      {item.checked === null ? null : <span aria-label={item.checked ? "checked" : "unchecked"}>{item.checked ? "☑ " : "☐ "}</span>}{textWithInlineCode(item.text, item.inlineCode)}
    </li>)}</List>;
  }
  if (block.kind === "table") return <div className={styles.documentationTableScroll} key={key}><table className={styles.documentationTable}><tbody>{block.rows.map((row, rowIndex) => <tr key={`${key}:row:${rowIndex}`}>{row.cells.map((cell, cellIndex) => row.header
    ? <th key={`${key}:${rowIndex}:${cellIndex}`} scope="col">{cell}</th>
    : <td key={`${key}:${rowIndex}:${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div>;
  if (block.kind === "example") return <figure className={styles.documentationExample} key={key}><pre><code>{block.text}</code></pre>{block.language ? <figcaption>Code example · {block.language}</figcaption> : <figcaption>Code example</figcaption>}</figure>;
  return null;
}

export function DocumentationContextPanel({ model, repository, commitSha }: {
  model: SemanticModel;
  repository: string;
  commitSha: string;
}) {
  const context = model.documentation;
  if (!context) return <details className={styles.documentationPanel} aria-label="Documentation context" data-testid="documentation-context-legacy">
    <summary><strong>Documentation context</strong><span>Unavailable for this legacy semantic model</span></summary>
    <p className={styles.unavailableExplanation}>Documentation links, coverage, and extracted Markdown sections were not stored.</p>
  </details>;

  const skippedByReason = [...context.coverage.skipped.reduce((counts, item) => counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1), new Map<string, number>())]
    .sort(([left], [right]) => left.localeCompare(right));
  const resolvedReferenceCount = context.references.filter(item => item.resolution === "resolved").length;
  const reviewReferenceCount = context.references.filter(item => item.resolution === "missing" || item.resolution === "unsafe").length;
  const otherReferenceCount = context.references.length - resolvedReferenceCount - reviewReferenceCount;
  return <details className={styles.documentationPanel} aria-label="Documentation context" data-testid="documentation-context">
    <summary>
      <strong>Documentation context</strong>
      <span className={styles.documentationCoverage} data-testid="documentation-coverage">Coverage: {context.coverage.documentCount} documents · {context.coverage.documentByteCount} bytes · {context.coverage.candidateFileCount} candidate files from {context.coverage.snapshotPathCount} snapshot paths · {context.coverage.skipped.length} skipped{skippedByReason.length ? ` (${skippedByReason.map(([reason, count]) => `${reason}: ${count}`).join(", ")})` : ""}.</span>
      {context.references.length ? <span className={styles.documentationCoverage}>Links: {resolvedReferenceCount} resolved · {reviewReferenceCount} perlu ditinjau · {otherReferenceCount} other or external references.</span> : null}
    </summary>
    <div className={styles.documentationContent}>
    {context.documents.length ? <details className={styles.documentationDisclosure}>
      <summary>Read snapshot documentation ({context.documents.length})</summary>
      <div className={styles.documentationDocuments}>{context.documents.map(document => <article key={`${document.filePath}:${document.fileSha256}`}>
        <header><h4>{document.title ?? document.filePath}</h4><p><code>{document.filePath}</code> · {document.kind} · {document.byteLength} bytes</p></header>
        {document.sections.map((section, sectionIndex) => <section className={styles.documentationSection} key={`${document.filePath}:section:${sectionIndex}`}>
          {section.heading ? <>{section.depth <= 1 ? <h5>{section.heading}</h5> : <h6>{section.heading}</h6>}<p className={styles.documentationSectionEvidence}><DocumentationEvidence evidence={section.evidence} repository={repository} commitSha={commitSha} /></p></> : null}
          {section.blocks.map((block, blockIndex) => <div className={styles.documentationBlock} data-testid="documentation-block" key={`${document.filePath}:block:${sectionIndex}:${blockIndex}`}>
            {renderBlock(block, `${document.filePath}:${sectionIndex}:${blockIndex}`)}
            <DocumentationEvidence evidence={block.evidence} repository={repository} commitSha={commitSha} />
          </div>)}
        </section>)}
      </article>)}</div>
    </details> : <p>No supported Markdown documents were included in this snapshot context.</p>}
    {context.references.length ? <details className={styles.documentationDisclosure}>
      <summary>Documentation file references ({context.references.length})</summary>
      <p>Resolved links describe what a document references; they do not imply execution or runtime behavior.</p>
      <ul className={styles.documentationReferences}>{context.references.map((reference, index) => <li key={`${reference.sourcePath}:${reference.evidence.startByte}:${index}`}>
        <p><code>{reference.sourcePath}</code> {reference.resolution === "resolved" ? "mendokumentasikan/merujuk file" : reference.resolution === "directory" ? "merujuk folder snapshot" : "references"} <code>{reference.targetPath ?? reference.target}</code> · {reference.resolution}{reference.resolution === "missing" || reference.resolution === "unsafe" ? <> · <strong>Perlu ditinjau</strong></> : null}</p>
        <DocumentationEvidence evidence={reference.evidence} repository={repository} commitSha={commitSha} />
      </li>)}</ul>
    </details> : <p>No Markdown links were extracted from selected documents.</p>}
    {context.coverage.skipped.length ? <details className={styles.documentationDisclosure}>
      <summary>Skipped documentation files ({context.coverage.skipped.length})</summary>
      <ul className={styles.documentationReferences}>{context.coverage.skipped.map((item, index) => <li key={`${item.filePath}:${item.reason}:${index}`}><code>{item.filePath}</code> · {item.reason}</li>)}</ul>
    </details> : null}
    </div>
  </details>;
}
