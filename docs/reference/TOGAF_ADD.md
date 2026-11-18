# Architecture Definition Document (ADD): Phase C

SAGE's output remains an **Architecture Definition Document (ADD)**. Its content is scoped to a source-grounded Phase C baseline, and starts directly with **PHASE C: INFORMATION SYSTEMS ARCHITECTURES** without a `BAB` label. Numbered sections use a simple sequence starting at 1; Data Architecture and Application Architecture remain unnumbered group headings.

TOGAF Phase C and ArchiMate define the architecture content and views. Visual Paradigm's Phase C guide is a supporting reference for the ADD narrative, Data Architecture, Application Architecture, catalogs, and ArchiMate views. The supplied course template **Template PAP Prak Gasal 2026-2027 Fin - Update.docx** guides writing format and presentation only; it does not change the artifact from an ADD or replace the TOGAF/ArchiMate model. Earlier report content and out-of-scope phases are omitted from this Phase C document.

This is a repository-level baseline, not a complete enterprise ADD or certified ArchiMate model. Source code cannot establish every business owner, business function, data principle, physical distribution, deployment boundary, target state, or enterprise integration.

## Phase C structure

The workspace, Markdown, LaTeX, and print-to-PDF outputs follow the same section definitions from `packages/documents/src/phase-c-add.ts` and project the same canonical ADD model and review overlay.

## Architecture references

- [The Open Group: TOGAF Phase C Data Architecture](https://www.opengroup.org/architecture/doc-review/protected-d3/htmlclean/chap09.html)
- [The Open Group: TOGAF Phase C Application Architecture](https://www.opengroup.org/architecture/doc-review/protected-d3/htmlclean/chap10.html)
- [Visual Paradigm: TOGAF 10 Phase C deliverables](https://www.visual-paradigm.com/guide/deep-dive-mastering-togaf-10-phase-c-deliverables/)

These references guide the ADD's architecture scope and view content. The generated result represents only the evidence available from one repository snapshot; it does not invent enterprise-owned facts that the source cannot establish.

| Section | Contents | Source limits |
| --- | --- | --- |
| 1 Data Principles | Approved data principles | Requires architecture authority input; not inferred from code |
| 2 Baseline Data Architecture | Source-grounded baseline summary | No target state or gap rating is generated |
| 3 Business Data Model (Baseline) | Data Entity Catalog with feature group, owner, distribution, review, and evidence | Owners and distribution require enterprise confirmation |
| 4 Logical Data Model (Baseline) | ArchiMate Data Structure view and relationship register | Shows only extracted objects and explicit source relationships |
| 5 Data Management Process Model (Baseline) | Assessment status | Governance, stewardship, retention, and operating procedures are not inferred |
| 6 Data Entity/Business Function Matrix (Baseline) | Assessment status | No approved business-function catalog is provided; no mapping is invented |
| 7 Data Entity/Application Component CRUD Matrix (Baseline) | Source-supported create/read/update/delete operations | Uses application components because business functions are not established by source |
| 8 Application Design (Baseline) | ArchiMate Application Cooperation view and relationship register | Internal source relationships are not automatically treated as external application integrations |
| 9 Catalog Design | Repository-level application portfolio | One repository is not assumed to equal one deployed enterprise application |
| 10 Logical Application Components | Recognized application functions and services | Scope is limited to statically recognized source patterns |
| 11 Interface Catalog | Recognized interfaces, protocols, contracts, and evidence | Only supported route/OpenAPI patterns are included |
| 12 Application Interaction Matrix | Communication between separately identified applications | An empty matrix means no cross-application mechanism was confirmed in this snapshot |

## Consistent outputs

The immutable repository commit and canonical ADD model are the data source. Review changes are a versioned overlay; they do not rewrite source facts. The web workspace, Markdown, LaTeX, and browser print-to-PDF read that model and overlay. Evidence links point to the analyzed commit and line range. `Proven` and `Indicated` describe evidence confidence; they do not change CCM/CKG `Exact` or `Unresolved` resolution.

- **Workspace:** interactive view, catalogs, matrices, evidence, review controls, and print layout.
- **Markdown:** full narrative, catalogs, matrices, relationship details, review state, limitations, and commit-pinned evidence links.
- **LaTeX:** downloadable `.tex` source for the same Phase C ADD structure, tables, diagrams, and evidence links. It is intended to be compiled with a LaTeX distribution such as TeX Live. A LaTeX compiler was not available in the current worktree, so compilation and rendered `.tex` output have not been verified here.
- **PDF:** generated using the browser's print dialog from the workspace, with A4 print rules and paginated SVG diagrams. It is not compiled from the LaTeX source. Large outputs should be reviewed for pagination before sharing.

With `latexmk` and a PDF-capable LaTeX distribution installed, compile a downloaded file using:

```sh
latexmk -pdf -interaction=nonstopmode repository-phase-c-add.tex
```

The formats share the same model, corrections, evidence, and section numbering. Their layout differs by medium; Markdown and LaTeX expose tabular relationship details, while the interactive workspace keeps the full registers expandable and shows concise diagrams by default.

## How analysis contributes to Phase C

1. The pipeline pins one repository commit and builds the Common Code Model and Code Knowledge Graph.
2. Static extractors identify supported data objects, interfaces, application components, and source-backed relationships from that snapshot.
3. The ADD projection builds the Data Structure and Application Cooperation views, catalogs, matrices, confidence explanations, and limitations.
4. A user may correct display names and feature grouping in a versioned overlay, then export the current reviewed snapshot.

Code Knowledge remains a supporting source-structure visualization. It is separate from the enterprise architecture views and is not the Software Engineering Diagram. The generated ADD is the primary architecture output.

## Analyzer and interpretation limits

The implemented adapters support selected JavaScript/TypeScript, PHP, and Python patterns. Framework behavior is pattern-specific: Next.js App Router, Laravel, limited Node HTTP patterns, and literal FastAPI-style routes are not treated as blanket support for every application using those frameworks. SQL, OpenAPI, and selected JSON Schema files can contribute data or interface contracts. The analyzer does not execute repository code or infer runtime behavior from directory layout, names, or imports alone.

The optional campus LLM is used only for narrative wording when the user consents and configuration is available. It receives a bounded summary of recognized facts, not repository source bytes, and cannot add architecture elements, relationships, ownership, or target-state facts. Deterministic narrative is used when the LLM is unavailable.

For implementation and acceptance evidence, see [TOGAF ADD traceability](../planning/TOGAF_ADD_TRACEABILITY.md). Historical presentation guidance is retained in [document presentation notes](DOCUMENT_PRESENTATION.md); it does not override this active Phase C output contract.
