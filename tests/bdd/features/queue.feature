# language: en
Feature: Global analysis queue and ownership
  These PostgreSQL scenarios use disposable owners and a repository in an isolated Sprint 1 database.

  @sprint1 @US_QueueAnalysis @SAGE_FR_REP_11 @APP_03 @NFR_05 @issue_9 @database @controlled
  Scenario: [SAGE-FR-REP-11] Analysis Initialization — Supporting SRS B.7.2: global queue slot and FIFO owner isolation (snapshot retrieval and pipeline startup are not covered)
    Given a disposable PostgreSQL database, two owners, and one test repository are available
    When the first owner enqueues commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    And the second owner enqueues commit "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    Then only one global claim is active; FIFO gives the first owner priority, and another owner cannot read the first owner's analysis

  @sprint1 @US_IdempotentAnalysisSubmission @SAGE_FR_REP_11 @APP_04 @NFR_05 @issue_8 @database @controlled
  Scenario: [SAGE-FR-REP-11] Analysis Initialization — Supporting SRS B.7.2: idempotent submission preserves the immutable full SHA and owner scope (snapshot retrieval and pipeline startup are not covered)
    Given a disposable PostgreSQL database, two owners, and one test repository are available
    When the first owner enqueues key "stable-request" with payload "repo/main/no-explicit-commit" and commit "cccccccccccccccccccccccccccccccccccccccc"
    And the first owner enqueues key "stable-request" with payload "repo/main/no-explicit-commit" and commit "dddddddddddddddddddddddddddddddddddddddd"
    And the second owner submits key "stable-request" with payload "repo/main/no-explicit-commit" and commit "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    Then the first owner's replay retains the original full SHA, while the same key creates a separate analysis for the second owner

  @sprint1 @US_QueueLeaseSafety @SAGE_FR_REP_11 @APP_03 @NFR_05 @issue_9 @database @controlled
  Scenario: [SAGE-FR-REP-11] Analysis Initialization — Supporting SRS B.7.2: expired-lease recovery and slot ownership (snapshot retrieval and pipeline startup are not covered)
    Given a disposable PostgreSQL database, two owners, and one test repository are available
    When two owners enqueue jobs, the first claim expires, and a new worker claims the next job
    Then the old lease token cannot renew or fail the new running job
