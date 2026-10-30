# Storyboard semantic workspace

This specification precedes rendering implementation. Source audit: [pinned oracle](evidence/semantic/oracle.json). Every named behavior must be checked against code; recognition gaps remain explicit.

1. **Architecture overview:** centered developer workspace, existing result navigation, title/caption and evidence legend. Actor chips above feature cards; every recognized feature is discoverable, with search if needed. Card shows source label, entry count, evidence state. Selecting one opens the same workspace, not a different analysis.
2. **Feature flow:** breadcrumb back to all features, selected actor/feature, show/hide indications. Directed activity diagram shows source-supported action, guards and result; evidence inspector opens beside/below it. Amber diamonds are decisions, green terminal outcomes, blue actions, purple API/components. Indications use dashed edges; no promise of runtime reachability. Zoom/fit remain available.
3. **Knowledge graph:** colored circular feature clusters initially; expand a cluster for domain concepts and principal API/components/store nodes. Small AST declarations live in evidence, not the semantic graph. Search, neighbors, reset, collapse and keyboard-accessible node list share selection. Show displayed/hidden counts rather than silently clipping features.
4. **Corrections:** inspector offers rename and feature reassignment only. Save displays revision; conflict offers reload rather than silent overwrite. Reset restores generated labels/groups. Technical source/evidence stay immutable.
5. **Exports:** same labels/groups and model snapshot as the selected revision; PDF overview plus A4 flow pages, Markdown full semantic records and technical detail. Legacy result without semantic artifact explains reanalysis is needed and keeps the technical result available.

Acceptance uses Perpus, SAGE and Laravel Emosync at pinned SHAs. No external AI, no execution of analyzed repositories, no Coolify deployment. This document defines intended behavior, not a claim of tested implementation.
