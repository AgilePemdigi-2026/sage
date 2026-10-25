# language: en

@sprint1 @controlled @browser @issue_7 @issue_66
Feature: Select a repository and validate the analysis target
  Browser coverage for SRS section 4.2 uses controlled API responses. The scenarios check selected normal and alternative flows, not full acceptance of every mapped requirement.

  @US_REP_01 @SAGE_FR_REP_01
  Scenario: [Supporting check | SRS 4.2 | SAGE-FR-REP-01 Authorized Repository List] Authorized repositories are listed for a synthetic account
    # Supporting check for the authorized repository list using controlled API fixtures.
    Given repository APIs are controlled for the browser scenario
    When I open the repositories page as synthetic account "primary"
    Then I see the account's public repository and its authorized private repository
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_01 @SAGE_FR_REP_13
  Scenario: [SRS B.7.2 | SAGE-FR-REP-13 Repository Search Empty Result] Repository not found (controlled)
    # SRS 4.2, Alternative Flow 1; the authorized list is retained while the empty search result is shown.
    Given repository APIs are controlled for the browser scenario
    When I open the repositories page as synthetic account "primary"
    Then I see the account's public repository and its authorized private repository
    When I search for a repository that is not in the loaded page
    Then the search result is empty without clearing the stored repository list
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_02 @SAGE_FR_REP_08
  Scenario: [SRS B.7.2 | SAGE-FR-REP-08 Latest Commit Fallback] Successfully select a repository and branch without a commit (controlled)
    # SRS 4.2 normal flow, steps 5-10; target checks use controlled API responses.
    Given repository APIs are controlled for the browser scenario
    When I open the repositories page as synthetic account "primary"
    And I select the account's public repository on branch "feature/sprint-one"
    When I check the target without specifying a commit
    Then an empty commit uses the branch's full SHA
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_02 @SAGE_FR_REP_07
  Scenario: [SRS B.7.2 | SAGE-FR-REP-07 Optional Commit Selection] Successfully select a repository with a specific commit (controlled)
    # SRS 4.2 normal flow, steps 5-9; the selected full SHA is checked against a controlled API fixture.
    Given repository APIs are controlled for the browser scenario
    When I open the repositories page as synthetic account "primary"
    And I select the account's public repository on branch "feature/sprint-one"
    When I check the target with a specific full SHA
    Then the validation request includes the selected full SHA
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_02 @SAGE_FR_REP_05 @SAGE_FR_REP_09
  Scenario: [Supporting check | SRS 4.2 | SAGE-FR-REP-05 Branch Retrieval + SAGE-FR-REP-09 Analysis Target Validation] Controlled branch and target failures can be retried
    # Supporting check for controlled branch retrieval and target validation failures and retries.
    Given repository APIs are controlled for the browser scenario
    And the branch API fails on the first request
    And the target validation API fails on the first request
    When I open the repositories page as synthetic account "primary"
    And I select the account's public repository
    Then the UI shows a controlled branch error with a retry action
    When I retry branch loading
    And I submit target validation
    Then the UI shows a controlled target error without losing the selection
    When I retry target validation
    Then target validation succeeds after the retry
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_01 @SAGE_FR_REP_01
  Scenario: [Supporting check | SRS 4.2 | SAGE-FR-REP-01 Authorized Repository List] A controlled public repository list failure can be retried
    # Supporting check for the authorized list using a controlled failure and retry.
    Given repository APIs are controlled for the browser scenario
    And the public repository list API fails on the first request
    When I open the repositories page as synthetic account "primary"
    Then the public repository list shows an error and a retry action
    When I retry loading the public repository list
    Then the public repository list recovers after the retry
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_02 @SAGE_FR_REP_05 @SAGE_FR_REP_09
  Scenario: [Supporting check | SRS 4.2 | SAGE-FR-REP-05 Branch Retrieval + SAGE-FR-REP-09 Analysis Target Validation] An empty branch list blocks target validation until reloaded
    # Supporting check for the empty-branch guard with controlled API responses.
    Given repository APIs are controlled for the browser scenario
    And the branch API returns an empty list on the first request
    When I open the repositories page as synthetic account "primary"
    And I select the account's public repository
    Then an empty branch list prevents target validation and can be reloaded
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_01 @SAGE_FR_GH_06
  Scenario: [Supporting check | SRS 4.1 / 5.3 | SAGE-FR-GH-06 Repository Access Restriction] Switching accounts isolates the visible repositories
    # Supporting check for repository access restriction and SRS 5.3 user access isolation; synthetic accounts and controlled APIs do not represent live provider authorization.
    Given repository APIs are controlled for the browser scenario
    When I open the repositories page as synthetic account "primary"
    Then I see the account's public repository and its authorized private repository
    When the browser session switches to synthetic account "secondary"
    Then only the new account's repositories are visible
    And the UI has no JavaScript errors or API requests outside the scenario
