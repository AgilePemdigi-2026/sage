# FIN-03 regression — 15 November 2026

Refs #39. Application base `e85fb6fef249f81ec543fa681d8678f47bd7667a`. GitHub provider checks ran as `rizqy-fadhil`.

81 focused repository/auth/queue/stage/history/retry unit tests passed. `npm run test:bdd:sprint2` completed 57 scenarios: 56 passed and one failed because the invocation omitted `SAGE_BDD_PRIVATE_REPOSITORY`. The complete run remains recorded as FAIL; it is not rewritten to PASS. Its 218 passed steps include contract/database and browser application checks, with real disposable PostgreSQL/worker/storage and synthetic application sessions as described in BDD_SPRINT2.md.

The failed provider scenario and the public provider scenario were rerun with the explicitly authorized `iltizamhasan3/sage` fixture and `--tags @live_cli`: 2 scenarios / 6 steps passed against the real GitHub API. Together the two runs cover every scenario; this is not a single clean 57-scenario run. No application fix was required for the invocation error. OAuth login was not performed anew.

Fresh logs, Cucumber HTML/JSON, browser screenshots and pipeline/export evidence remain in `artifacts/bdd/sprint2-2026-11-15T10-33-59-539Z` and `artifacts/bdd/fin03-provider-retest-20261115`. Sanitized hashes are in the accompanying report. The local host used Node 26.4.0, outside the declared Node 24 engine; repeat release acceptance with Node 24 before claiming that environment is verified. Independent PR review and acceptance reconciliation remain pending; #39 remains open.

## Final acceptance — Node 24

A clean full run at application commit `43a48340477c824cf98fc792a232794796276b84` on Node `24.22.3` passes **57 scenarios / 220 steps, zero failures and zero skipped steps**. Invocation: `SAGE_BDD_PRIVATE_REPOSITORY=iltizamhasan3/sage npm run test:bdd:sprint2`, CLI account Rizqy. Public/private provider checks use the real GitHub API; application sessions/provider boundaries remain controlled as explicitly recorded by the runner. Production Next, PostgreSQL, queue/worker, source processing, exports, retry, history and account-isolation checks pass in disposable resources. This does not repeat live browser OAuth.

Sanitized immutable manifest: [final evidence](evidence/FIN-03-final-20261115.json). Full HTML/JSON, screenshots and component reports: `artifacts/bdd/sprint2-2026-11-15T10-47-22-227Z`. The earlier 56/57 run and provider retest remain historical, superseded for acceptance by this clean run. No product bug was invented; the prior invocation error is resolved.
