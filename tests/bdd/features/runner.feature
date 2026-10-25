# language: en
Feature: Analysis stage runner persistence (Sprint 1)
  Handlers in these scenarios are trusted BDD-only stubs used to verify the runner contract.
  Completing nine stages does not constitute acceptance of the repository consumer, graph results, or product documents.

  @sprint1 @US_TrackAnalysisProgress @SAGE_FR_ANA_11 @issue_35 @database @controlled
  Scenario: Supporting SRS B.7.3 — Repository analysis completes successfully: stage persistence only — [SAGE-FR-ANA-11] Analysis Progress Update
    Given a disposable PostgreSQL database, two owners, and one test repository are available
    When the runner executes nine test handlers in sequence for the first owner's analysis
    Then all nine stage statuses are completed in contract order, with no terminal product result published

  @sprint1 @US_TrackAnalysisProgress @SAGE_FR_ANA_11 @APP_11 @issue_35 @database @controlled
  Scenario: Supporting SRS B.7.3 — Analysis fails (trusted-handler subset) — [SAGE-FR-ANA-11] Analysis Progress Update
    Given a disposable PostgreSQL database, two owners, and one test repository are available
    When the STATIC_ANALYSIS handler throws an internal error while the runner executes the claim
    Then the runner fails at that stage, stores a safe error code, and leaves downstream stages pending

  @sprint1 @US_QueueLeaseSafety @SAGE_FR_ANA_11 @APP_11 @issue_35 @database @controlled
  Scenario: Supporting SRS B.7.3 — Analysis fails (expired-lease recovery subset) — [SAGE-FR-ANA-11] Analysis Progress Update
    Given a disposable PostgreSQL database, two owners, and one test repository are available
    When the first owner's claim lease expires before the runner starts a stage
    Then the stale runner invokes no handler, recovery moves the claim, and the old token cannot affect the slot
