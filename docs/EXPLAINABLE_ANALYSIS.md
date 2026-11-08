# Explainable analysis and static documentation context

## Contract

New analysis emits `sage-semantic-v2` / extractor `0.4.0`. CKG keeps its `Exact` / `Unresolved` resolution contract. `Exact` resolves a declaration in the snapshot; it is not proof that the call executes at runtime. Source analysis never executes repository code, dependency scripts, Markdown, or embedded examples.

V2 relationships carry a structured explanation: relationship kind, code/documentation/mixed provenance, extractor rule, source-grounded summary, limitations, and original relationship IDs. The origin and the confidence are different concepts. Existing v1 models remain readable with their stored reason/evidence; missing provenance is displayed as unavailable rather than inferred on read.

## Documentation inventory

The semantic builder accepts `documentationSources` separately from code sources and `snapshotPaths` for local link resolution. The worker supplies both from the same verified archive used for the canonical graph. Markdown remains excluded from code declarations: no README heading or claim becomes a function, actor, service, or runtime call merely because it is documented.

Read root/package README case-insensitively, Markdown under `docs`, and ADR/adrs directories. Dependency, vendor, generated and build trees remain excluded. Deterministic selection prioritizes root README, package READMEs, architecture/ADR and remaining docs. Defaults are 100 documents, 256 KiB/file and 4 MiB total; skipped files are reported, never silently truncated into complete coverage.

Markdown AST/GFM extraction preserves prose, headings, lists, tables, inline code, examples and local/reference-style links with byte/hash/line evidence. Local references resolve only within the snapshot. External links are not fetched. Raw HTML and examples are inert text, never injected HTML, evaluated code, or inferred topology. A resolved Markdown link proves a documented reference, not that the target is invoked.

Unresolved local references are review candidates, not proof the whole document is wrong. Free-form prose cannot be compared to source behavior reliably without semantic interpretation: it remains a documented claim, and the UI keeps code evidence and document context separate. This version deliberately does not classify arbitrary prose as agreeing or conflicting with runtime behavior.

## Compatibility and presentation

A v2 model hash includes documentation context and coverage; export pins already include the model hash and immutable overlay revision. No historical model is rewritten and no database schema migration is needed. The CKG manifest already includes excluded files and their hashes: a changed README may change the complete graph bundle hash even though the code declarations/reference topology is identical. This preserves truthful snapshot identity rather than hiding a changed source manifest.

The diagram remains a full canvas, with zoom/focus and indications visible by default. Relationship inspection explains why each relationship exists and provides source locations and uncertainty. Aggregate connections retain member relationship IDs. Documentation references appear in the context panel and are explicitly described as references, without inventing runtime edges to join isolated components.

PDF and Markdown reuse stored explanations and source-pinned documentation; existing export resource limits remain enforced. No AI provider, runtime trace collection, new framework-wide support, production deployment, or new execution of target repositories is included.

## Trace boundaries

Next.js and Node HTTP follow a direct cross-file call only when one exact CKG call site maps to one supplied callable. Expansion stops after one hop; imports, sibling calls, deferred callbacks and unresolved dispatch do not become a pipeline. ORM-like receivers remain indicated when their binding is not verified. Node HTTP method/path guards can compose across nested branches, while runtime mounting remains unverified.

Laravel keeps the controller-to-service call separate from the service's own model operation. Expansion into a uniquely declared service method requires an exact CKG call; the writing method owns the write relationship. Static return/guard checks exclude known unreachable tails and uncalled callbacks within these supported patterns. Other runtime paths are outside this static guarantee.

## Verification

Targeted tests cover bounded Markdown parsing and safe reference resolution, provenance, v1 compatibility, deterministic replay, source hash binding, cache identity, nested route guards and conservative cross-file call tracing. See [executed checks and limits](EXPLAINABLE_ANALYSIS_CHECKS.md) and the implementation PR; fixtures are not live GitHub or production deployment evidence.
