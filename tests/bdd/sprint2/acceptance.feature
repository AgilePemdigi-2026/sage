# language: en
@sprint2
Feature: Sprint 2 regression evidence
  Contract scenarios execute real assertions at controlled boundaries.
  Database scenarios use migrated disposable PostgreSQL databases.
  A passed contract does not imply live OAuth or complete browser acceptance.

  @T_GH_01 @contract
  Scenario: GitHub session and logout remain owner scoped
    Given the Sprint 2 regression case "T-GH-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_GH_02 @contract
  Scenario: Rejected callbacks and replayed state fail safely
    Given the Sprint 2 regression case "T-GH-02"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_GH_03 @contract
  Scenario: Repository permissions and provider failures are enforced
    Given the Sprint 2 regression case "T-GH-03"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_REP_01 @contract
  Scenario: Repository search and branch selection preserve valid targets
    Given the Sprint 2 regression case "T-REP-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_REP_02 @contract
  Scenario: Submission freezes a full commit and rejects invalid targets
    Given the Sprint 2 regression case "T-REP-02"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_ANA_01 @contract
  Scenario: Queue ownership prevents duplicate concurrent claims
    Given the Sprint 2 regression case "T-ANA-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_ANA_02 @contract
  Scenario: Nine stages stop on failure and publish complete results only
    Given the Sprint 2 regression case "T-ANA-02"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_ANA_03 @contract
  Scenario: PHP JavaScript and TypeScript declarations match source oracles
    Given the Sprint 2 regression case "T-ANA-03"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_ANA_04 @contract
  Scenario: Canonical graphs retain deterministic Unicode evidence
    Given the Sprint 2 regression case "T-ANA-04"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_ANA_05 @contract
  Scenario: Mixed source and parse failures retain explicit limitations
    Given the Sprint 2 regression case "T-ANA-05"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_ANA_06 @contract
  Scenario: Worker recovery preserves leases and fails ambiguous claims safely
    Given the Sprint 2 regression case "T-ANA-06"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_GRAPH_01 @contract
  Scenario: Graph modes retain canonical counts and unresolved references
    Given the Sprint 2 regression case "T-GRAPH-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_GRAPH_02 @contract
  Scenario: Combined search filters include only matching endpoints
    Given the Sprint 2 regression case "T-GRAPH-02"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_GRAPH_03 @contract
  Scenario: Node inspection rejects corrupt source and foreign owners
    Given the Sprint 2 regression case "T-GRAPH-03"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_DOC_01 @contract
  Scenario: Three document projections preserve source facts
    Given the Sprint 2 regression case "T-DOC-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_EXP_01 @contract
  Scenario: Standalone Markdown preserves evidence and safe source text
    Given the Sprint 2 regression case "T-EXP-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_EXP_02 @contract
  Scenario: PDF projection validates bounds and compact diagram content
    Given the Sprint 2 regression case "T-EXP-02"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_EXP_03 @contract
  Scenario: Export retries and deduplication retain immutable ownership
    Given the Sprint 2 regression case "T-EXP-03"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_HIST_01 @contract
  Scenario: History handles empty search status and owned navigation
    Given the Sprint 2 regression case "T-HIST-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_DATA_01 @contract
  Scenario: Session credentials and readers enforce account isolation
    Given the Sprint 2 regression case "T-DATA-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_DATA_02 @contract
  Scenario: Deletion rejects active work and cleans storage idempotently
    Given the Sprint 2 regression case "T-DATA-02"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_UI_01 @contract
  Scenario: UI contracts retain accessible progress and readable result data
    Given the Sprint 2 regression case "T-UI-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_SEC_01 @contract
  Scenario: Unsafe archives and source code cannot execute or escape storage
    Given the Sprint 2 regression case "T-SEC-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @T_REL_01 @contract
  Scenario: Deployment configuration enforces health migrations and resource bounds
    Given the Sprint 2 regression case "T-REL-01"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_OAUTH @database
  Scenario: OAuth persistence and revoked sessions
    Given the Sprint 2 regression case "DB-OAUTH"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_QUEUE @database
  Scenario: Concurrent queue and lease persistence
    Given the Sprint 2 regression case "DB-QUEUE"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_CKG @database
  Scenario: Canonical graph ownership and stage publication
    Given the Sprint 2 regression case "DB-CKG"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_DOC @database
  Scenario: Document integrity and publication fencing
    Given the Sprint 2 regression case "DB-DOC"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_PIPELINE @database
  Scenario: Real nine-stage pipeline with controlled archive provider
    Given the Sprint 2 regression case "DB-PIPELINE"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_MARKDOWN @database
  Scenario: Markdown worker storage and retries
    Given the Sprint 2 regression case "DB-MARKDOWN"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_PDF @database
  Scenario: PDF worker integrity and ownership
    Given the Sprint 2 regression case "DB-PDF"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_HISTORY @database
  Scenario: History database search and account isolation
    Given the Sprint 2 regression case "DB-HISTORY"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_CLEANUP @database
  Scenario: Deletion and failed cleanup recovery
    Given the Sprint 2 regression case "DB-CLEANUP"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @DB_DATA @database
  Scenario: Credential storage and cross-account isolation
    Given the Sprint 2 regression case "DB-DATA"
    When I execute its production regression checks
    Then every executed check passes without skipped tests

  @live_cli
  Scenario: Rizqy reads a public repository through the real GitHub API
    Given the GitHub CLI identity "rizqy-fadhil"
    When I inspect the public repository "octocat/Hello-World" through GitHub
    Then GitHub returns a readable public repository and a full commit SHA

  @live_cli
  Scenario: Rizqy retains read permission on the authorized private fixture
    Given the GitHub CLI identity "rizqy-fadhil"
    When I inspect the explicitly authorized private fixture through GitHub
    Then GitHub confirms private repository read permission and a full commit SHA

  @browser
  Scenario: Result navigation and source connections remain readable in the browser
    When I check the result workspace with Playwright and pinned source models
    Then the controlled browser regression passes without missing corpus checks

  @B7_3 @application_browser @browser_pipeline
  Scenario: Submission through the actual queue and result publication
    When I test the application browser case "pipeline"
    Then the production application browser checks pass
