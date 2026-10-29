# UI-06 — Developer workspace reading

Issue: #109. Scope: source architecture presentation, readable UML pages, connected result navigation, repository action spacing and developer-oriented visual hierarchy.

## Behavior

- Direct Progres / Knowledge graph / Dokumentasi links keep the same analysis context and existing owner/session gates.
- Software Engineering Diagram shows source directory areas and aggregated Exact dependencies first. Area selection opens source files and neighboring areas, with source evidence retained.
- UML prioritizes connected classifiers, provides source-area filters and paging, and uses four readable class/interface cards when a page has no proven relations. No relationships or business services are invented.
- Repository controls have a 12 px wrapping gap. Neutral panels, blue focus/links, green primary actions and coral active tabs follow familiar developer interaction patterns.
- Canonical and Markdown remain complete. PDF renderer 2.3.0 invalidates the previous projection cache identity.

## Verification

Node 24.22.0 with the repository lockfile in a disposable Docker QA environment:

- Lint, typecheck and 412 unit tests: PASS.
- Eight database foundation tests: PASS.
- Next production build: PASS.
- Landing, repository selection/spacing and account-boundary browser suites: PASS at 360, 390, 768, 1024 and 1440 px.

- Live document/PDF suite with real Next, PostgreSQL and production worker: PASS at 390/1440 px, including owner boundaries, retry, source-backed BCE and the 100-interface scoped/paged reading flow.
- Knowledge graph browser regression: 25 checks PASS across five viewports.
- Controlled API replay of a read-only stored canonical document: PASS at 390/1440 px, 3,116 source-model nodes and 32 source classifiers, no page overflow or uncaught browser errors. This replays presentation; it is not a fresh analyzer/provider run.

Evidence: `artifacts/ui06/final-check-and-live.log`, `live-final/report.json`, `stored-reading-report.json`, and `graph/`. Stored canonical content/screenshots remain private and gitignored. The final canvas-fit correction passed a separate 390/1440 px replay using the standard Docker production web build: the entire architecture diagram fits without internal overflow. Evidence: `production-canvas-fit.log`. Controlled provider responses are UI evidence, not fresh GitHub OAuth acceptance or Coolify capacity evidence.

## Failed attempts retained

The first image build encountered npm ECONNRESET. A subsequent check exposed a stale label-escaping expectation and an unused local variable; both were corrected. One QA run lacked the resource benchmark manifest; copying the checked-in docs/config fixed the fixture environment. A browser run was interrupted while diagnosing a fixture archive stream deadlock; tar production and draining now run concurrently, and the browser helper sets a 30-second timeout. A case-sensitive test scope lookup was corrected. Visual replay exposed fan-in spreading areas horizontally; the overview now uses four prioritized areas and invisible vertical layout constraints. Retry guards correctly refused reused storage, evidence folders and prior QA exports; the dedicated disposable database was reset and fresh output paths selected. Product storage and history were not reset.

## References and limits

[GitHub Primer underline navigation](https://primer.style/product/components/underline-nav/) informs result navigation; [GitDiagram](https://github.com/ahmedkhaleel2004/gitdiagram) informs overview-to-detail reading. SAGE uses deterministic source grouping and proven static dependencies; it does not infer business responsibilities from prose. BCE roles remain name/path heuristics, and unresolved references remain explicit. Scope caps and pages prevent unreadable full-model diagrams; complete evidence remains in the catalog and Markdown.
