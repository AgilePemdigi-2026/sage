# QA-02 — Integrasi sprint dan release evidence

**Status: partial.** Fresh GitHub OAuth and Playwright provider-route coverage passed on 8 November 2026 against branch head `63dc1ad5beb8b5a9594ada07e9364fd2bcce9fd9`. This evidence does not accept the complete QA-02 or REL-01 gates.

## Fresh live evidence

| Area | Result | Evidence and scope |
| --- | --- | --- |
| GitHub OAuth | PASS | A fresh local sign-in completed through GitHub and returned to the SAGE workspace as `@iltizamhasan3`; the workspace displayed the expected session expiry. No password or verification code was entered during this run. |
| Playwright provider routes | PASS | `npm run test:provider:playwright` used Playwright `APIRequestContext` against the running local Next routes and the existing real GitHub authorization. Sanitized run report: [qa-02-provider-playwright-2026-11-08.json](evidence/qa-02-provider-playwright-2026-11-08.json). |
| Session and account boundary | PASS | The temporary session resolved the authenticated account; own public repository metadata was returned, anonymous access and a mismatched account header were rejected. |
| Installation access | PASS | GitHub installation list and authorized repository metadata returned through the real provider; unauthenticated installation access was rejected. |
| Public repository and target | PASS | `octocat/Hello-World` resolved as public. Branch HEAD and an explicit commit prefix resolved to the same full 40-character SHA. Cross-origin, non-GitHub target, and malformed commit were rejected. |
| Side effects | PASS | The probes created no analysis jobs. The temporary helper session is removed by the script. |

OAuth and provider access used a temporary PostgreSQL cluster and a local web process. The real OAuth callback created a test connection in that disposable database; both are removed after evidence capture. The Playwright route script creates its own short-lived session for the already-authorized account, so its route checks are distinguished from the fresh interactive OAuth step.

## Remaining acceptance work

- No private-repository fixture was supplied, so private access was not repeated in this fresh run.
- No full analysis submission/pipeline, graph, exports, or resulting history was exercised end to end in this run.
- The clean Docker-to-demo release path remains unaccepted. The prior Docker attempt was blocked by the full shared Colima disk; no cleanup or pruning of pre-existing images was performed.
- QA-03's full viewport/accessibility review and clean release evidence are still open.

The existing controlled and component evidence for provider boundaries remains in [GH-02_CHECKS](GH-02_CHECKS.md), and history evidence remains in [HIST-01_CHECKS](HIST-01_CHECKS.md). QA-02 stays partial until the integrated user stories and release gates have fresh evidence.
