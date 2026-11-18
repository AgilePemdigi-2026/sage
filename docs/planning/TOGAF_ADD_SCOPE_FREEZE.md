# TOGAF Phase C ADD scope freeze

**Status:** Frozen for the one-week revision window, 16–23 November 2026.
**GitHub milestone:** [TOGAF Phase C ADD Revision](https://github.com/AgilePemdigi-2026/sage/milestone/4).

## Goal

After repository analysis, SAGE produces a source-grounded **Architecture Definition Document (ADD), Phase C baseline** for Data Architecture and Application Architecture. The ADD is the primary result. Code Knowledge is a supporting source-structure view and must remain clearly separate from the architecture document.

The model describes only what can be supported by the selected repository snapshot. It must expose missing evidence and analyzer limitations instead of filling gaps with plausible-sounding architecture.

## In scope

- One canonical ADD model tied to the same full source commit SHA as the completed repository analysis.
- Baseline Data Architecture: data entity catalog, source-supported data relationships, Data Structure view, and CRUD matrix where operations can be established from source.
- Baseline Application Architecture: application/component inventory, source-supported functional decomposition, interface catalog, Application Cooperation view, and application interaction matrix where communication is evidenced.
- ArchiMate relationships must use the project's implemented profile and cite source evidence. `Proven`/`Indicated` confidence remains separate from `Exact`/`Unresolved` resolution.
- Evidence includes repository path, pinned commit, and available line range. Unknown owner, distribution, business capability, target state, deployment, or cross-application relationship is labeled unknown or listed as a limitation.
- User review is an overlay on the generated model. It may correct supported labels/grouping/review fields; it cannot rewrite source facts or add manual architecture relationships. Revisions are owner-scoped, append-only, and stale revisions conflict.
- Markdown, LaTeX, and PDF exports use the same canonical model and review revision. Markdown is detailed; PDF is compact, A4-readable, and visually reviewed; LaTeX source is compiled and checked before it is claimed as a usable output.
- LLM narrative assistance is optional and requires explicit user consent. It receives only bounded, normalized ADD facts, never source bytes, code excerpts, secrets, or raw evidence. It may return narrative text only; it cannot add or change facts, elements, relationships, or evidence. Record whether it was used, unavailable, or not configured, and retain deterministic narrative as fallback.
- Analyzer support is limited to implemented and documented patterns. Extend a pattern only when needed to produce the agreed ADD facts and when evidence-based fixtures can be added within this timebox.

## Out of scope for this timebox

- Target architecture, gap/RAG analysis, transition states, or migration roadmaps.
- Invented Business Architecture capabilities, processes, data owners, physical distribution, deployment topology, or integrations between independently deployed applications.
- Claims of universal language/framework support, dynamic runtime tracing, or completeness beyond the tested repository patterns.
- Manual creation of architecture relationships, using LLM output as architecture facts, or changing the primary product output back to Software Engineering Diagram/UML.
- Runtime migration to Bun or Go, broad UI redesign, and unrelated feature work.

## Acceptance checklist

### 1. Model and analyzer

- [ ] ADD source hash and full commit SHA match the analysis snapshot.
- [ ] Data and application elements/relationships have valid types, evidence, and explicit confidence; unsupported patterns are visible as limitations.
- [ ] Negative checks confirm that absent business facts and unsupported relationships are not emitted as proven facts.
- [ ] Data Structure and Application Cooperation views, catalogs, functional decomposition, and matrices contain only supported entries; unknowns are explicit.

### 2. Persistence and review

- [ ] Disposable-PostgreSQL integration verifies owner isolation, canonical model persistence, revision append, and stale-revision conflict.
- [ ] User corrections do not mutate source facts; reload returns the saved overlay for the same analysis and owner.

### 3. User flow and LLM

- [ ] A fresh repository flow reaches analysis completion, generates the ADD from the pinned snapshot, reloads it, and displays its evidence.
- [ ] LLM defaults to not requested; consented use sends only bounded structured facts and changes narrative fields only.
- [ ] LLM timeout, invalid response, or unavailable configuration falls back to deterministic narrative without failing ADD generation.

### 4. Exports and presentation

- [ ] Markdown, LaTeX, and PDF reflect the same model hash and review revision as the interactive ADD.
- [ ] LaTeX compiles; PDF/LaTeX render and A4 page flow are visually reviewed; Markdown links point to the pinned source evidence.
- [ ] Main document starts at PHASE C with simple section numbering; it has no `BAB` or `4.1`-style section numbering.

### 5. Final verification and handoff

- [ ] Automated checks, database integration, browser acceptance, and export checks have recorded commands and outcomes; fixture-only results are labeled as such.
- [ ] Perpus, SAGE, and Emosync are checked at pinned commits for supported content and false-positive boundaries.
- [ ] Runtime and peak memory are measured in a Linux container with recorded resource limits; failures and outliers remain visible.
- [ ] README and active guides match the shipped behavior; GitHub issues include reviewable evidence before closure.

## Ownership and tracking

- [Issue #142](https://github.com/AgilePemdigi-2026/sage/issues/142): Iltizam — analyzer, canonical ADD model, persistence/API, evidence, and LLM narrative boundary.
- [Issue #143](https://github.com/AgilePemdigi-2026/sage/issues/143): Rizqy — ADD workspace, ArchiMate views, catalogs/matrices, review UI, exports, and browser/render evidence.
- Cross-cutting acceptance is complete only when both issue scopes work together against the same model and revision. Assignment or unit tests alone do not satisfy the checklist.
