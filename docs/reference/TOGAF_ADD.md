# Architecture Definition Document (ADD)

SAGE generates an **Architecture Definition Document (ADD)** from a pinned repository snapshot. The PDF cover is titled **ARCHITECTURE DEFINITION DOCUMENTS** with the subtitle **Baseline Data and Application Architecture**. The table of contents and running header omit a Phase C banner. Numbered sections start at 1 under the unnumbered Data Architecture and Application Architecture headings.

The content follows the TOGAF Phase C scope for Data and Application Architecture, while ArchiMate supplies a vocabulary and relationship model for selected views. The supplied course template **Template PAP Prak Gasal 2026-2027 Fin - Update.docx** guides writing format and presentation only; it does not change the artifact from an ADD. Earlier report chapters and out-of-scope phases are omitted.

This is a repository-level baseline, not a complete enterprise ADD or a certified ArchiMate model. Source code can support a limited set of ArchiMate elements and relations, but cannot establish every business owner, business function, data principle, physical distribution, deployment boundary, target state, or enterprise integration.

## ADD structure

The workspace, Markdown, LaTeX, and print-to-PDF outputs follow the same section definitions from `packages/documents/src/phase-c-add.ts` and project the same canonical ADD model and review overlay.

## Architecture references

- [The Open Group: TOGAF Phase C Data Architecture](https://www.opengroup.org/architecture/doc-review/protected-d3/htmlclean/chap09.html)
- [The Open Group: TOGAF Phase C Application Architecture](https://www.opengroup.org/architecture/doc-review/protected-d3/htmlclean/chap10.html)
- [Visual Paradigm: TOGAF 10 Phase C deliverables](https://www.visual-paradigm.com/guide/deep-dive-mastering-togaf-10-phase-c-deliverables/)
- [The Open Group: ArchiMate 3.2 Specification](https://pubs.opengroup.org/architecture/archimate32-doc/)
- [A method for transforming Knowledge Discovery Metamodel to ArchiMate models, Software and Systems Modeling](https://link.springer.com/article/10.1007/s10270-021-00912-y)
- [ArchiRev: Reverse engineering of information systems toward ArchiMate models, Journal of Software: Evolution and Process](https://doi.org/10.1002/smr.2314)

These references guide the ADD's architecture scope and view content. Research shows automated ArchiMate skeletons can be derived from structured source artifacts using static analysis and explicit mappings. It also emphasizes that mappings are selective, business semantics need human validation, and source code alone cannot provide every enterprise view. SAGE therefore labels the exported diagrams as an ArchiMate 3.2 subset, uses relationship-specific connector notation for supported relations, and shows evidence confidence separately from relationship meaning.

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
- **LaTeX:** downloadable `.tex` source for the same ADD structure, tables, diagrams, and evidence links. The PDF uses an uppercase centered contents heading, left-aligned numbered section headings, repeated table headers, upright A4 pages, inline diagrams with a short introduction before each view and a numbered caption below each image, followed by an interpretation paragraph. Tables have additional cell padding. LaTeX output is a source file; compile it locally to review the exact PDF.
- **PDF:** generated using the browser's print dialog from the workspace, with A4 print rules and paginated SVG diagrams. A Playwright fixture produced and inspected a real A4 PDF. It is not compiled from the LaTeX source, and the test intercepts API responses rather than exercising production OAuth, worker, or database persistence.

With Tectonic installed, compile a downloaded file using:

```sh
tectonic repository-phase-c-add.tex
```

The formats share the same model, corrections, evidence, and section numbering. Their layout differs by medium; Markdown and LaTeX expose tabular relationship details, while the interactive workspace keeps the full registers expandable and shows concise diagrams by default. The PDF follows the supplied PAP sample's figure sequence: brief context, diagram, numbered caption below the diagram, then an explanation that refers to the figure. Only the contents title and cover are centered; numbered body headings remain left-aligned. It is a limited ArchiMate view projection, not a complete or certified enterprise model.

## How source analysis contributes to the ADD

1. The pipeline pins one repository commit and builds the Common Code Model and Code Knowledge Graph.
2. Static extractors identify supported data objects, interfaces, application components, and source-backed relationships from that snapshot.
3. The ADD projection builds the Data Structure and Application Cooperation views, catalogs, matrices, confidence explanations, and limitations.
4. A user may correct display names and feature grouping in a versioned overlay, then export the current reviewed snapshot.

Code Knowledge remains a supporting source-structure visualization. It is separate from the enterprise architecture views and is not the Software Engineering Diagram. The generated ADD is the primary architecture output.

## Analyzer and interpretation limits

The implemented adapters support selected JavaScript/TypeScript, PHP, and Python patterns. Framework behavior is pattern-specific: Next.js App Router, Laravel, limited Node HTTP patterns, and literal FastAPI-style routes are not treated as blanket support for every application using those frameworks. SQL, OpenAPI, and selected JSON Schema files can contribute data or interface contracts. The analyzer does not execute repository code or infer runtime behavior from directory layout, names, or imports alone.

The optional campus LLM is used only for narrative wording when the user consents and configuration is available. It receives a bounded summary of recognized facts, not repository source bytes, and cannot add architecture elements, relationships, ownership, or target-state facts. Deterministic narrative is used when the LLM is unavailable.

For implementation and acceptance evidence, see [TOGAF ADD traceability](../planning/TOGAF_ADD_TRACEABILITY.md). Historical presentation guidance is retained in [document presentation notes](DOCUMENT_PRESENTATION.md); it does not override this active Phase C output contract.
