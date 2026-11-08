# Explainable analysis verification — 8 November 2026

Scope: [semantic v2 and static documentation context](EXPLAINABLE_ANALYSIS.md), based on `main` at `d48f8a955ba6f3e47090c050da31e8e4947c0302`. Work was isolated from the original checkout's three uncommitted UI files. Those files were preserved byte-for-byte. Product web, worker and database services stayed stopped; browser and database tests used disposable QA instances.

## Executed checks

| Check | Actual result |
| --- | --- |
| `npm run check` | 532 main tests passed, 2 optional saved-corpus tests skipped, 8 data tests passed; TypeScript passed; lint had no errors and three existing hook warnings |
| `npm run build` | Production Turbopack build passed after clean native dependency installation |
| `npm run test:bdd:semantic` | 3 scenarios / 17 steps passed |
| `npm run test:semantic:storage` | 2 PostgreSQL integration tests passed, preserving v1 and checking v2 provenance/hash/owner/tamper behavior |
| `npm run test:semantic:export` | 1 production worker integration test passed, including v1/v2 Markdown/PDF, cache reuse, stale pins and immutable revisions |
| Frozen snapshot oracle | 39/39 checks passed on Perpus, Emosync and SAGE |
| `npm run test:semantic:ui` | Passed with real contract modules and explicit HTTP fixtures (24 GET / 7 PATCH): pointer/keyboard aggregate and parallel flow edges, origin filters, inert documentation, v1 legacy state, final corpus desktop/mobile canvases |
| PDF QA | Generated fixture PDF text contains relationship explanations and documentation; selected pages were rendered and visually inspected |

Native Node 24.11.0 was used. Initial shared dependencies pointed outside the isolated checkout and included Linux binaries; clean `npm ci --ignore-scripts` resolved that environment issue. A production build also exposed browser imports through the server-only contracts entry. Enum registries now have a browser-safe entry; the browser fixture uses the real modules without its previous alias shim. No schema enum or hashing behavior changed.

The browser check runs a disposable server and intercepted, explicitly labeled HTTP responses; it is separate from the real PostgreSQL/worker export integration. Saved models came from final frozen extraction. Desktop and mobile overview screenshots were inspected. Documentation and extraction-limit disclosures sit below the primary canvas; parallel relationships have separate selectable curves. The canvas retains every scoped node/relationship with zoom/focus and no canvas paging.

## Frozen source replay

Fresh static source analysis was executed for the pinned corpora, including a full SAGE Git archive with Markdown. Final semantic extraction reused those canonical CKG artifacts, revalidated them against the same archive bytes, reversed input ordering, validated canonical storage, and checked code/document evidence byte bounds and hashes.

| Snapshot | Files | Features / nodes / edges | Documentation |
| --- | ---: | --- | --- |
| Emosync `a22992668658538f6fc10b904d6f7b2ed09124ac` | 85 | 14 / 233 / 350 | Curated corpus contains no Markdown |
| Perpus `d72c3532a7d59cab242fb705ab201cf99ef35e88` | 89 | 17 / 616 / 653 | Curated corpus contains no Markdown |
| Full SAGE `c2dc3d84b220c572fb5b2ce85dd3605e89b11a73` | 520 | 14 / 195 / 221 | 70 documents, 617,223 admitted bytes, 775 references, no skips |

The [machine-readable evidence summary](evidence/semantic/explainable-20261108.json) records final model and CKG hashes. Replay/oracle coverage is bounded static evidence, not proof of runtime behavior or complete semantic correctness. Large-repository PDF capacity, container memory qualification, deployment and team release signoff are outside this run. No target repository was executed.

The documentation regressions cover GFM/reference links, anchors/Unicode, exact path resolution without basename guessing, inert hostile content, file/byte/node/representation limits, encoded unsafe paths, and parser-to-canonical failure isolation. An actual JS resolver-to-semantic regression verifies that a called writer owns its store effect while an unused imported writer contributes no effect.

Independent review found and prompted regressions for UTF-8 cross-file callable offsets, statically unreachable conditional/loop effects (including loop increments after an exiting body), and default inventory of separately supplied or unavailable Markdown. These fixes passed the full check again; frozen replay hashes stayed unchanged.

Raw snapshots, generated reports, exports and screenshots remain in ignored `artifacts/`; no source archive, database credential or private export is committed. The disposable PostgreSQL container was removed after verifying zero analyses, users, repositories, exports and storage objects. Final independent review is recorded on the implementation PR at its reviewed head SHA.
