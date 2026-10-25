# language: en

@sprint1 @controlled @browser @issue_7 @issue_66
Feature: Select a repository and validate the analysis target
  Browser coverage for SRS section 4.2 uses controlled API responses. The scenarios check selected normal and alternative flows, not full acceptance of every mapped requirement.

  @US_REP_01 @SAGE_FR_REP_01
  Scenario: [Supporting check | SRS 4.2 | SAGE-FR-REP-01 Authorized Repository List] Authorized repositories are listed for a synthetic account
    # Supporting check for the authorized repository list using controlled API fixtures.
    Given repository APIs are controlled for the browser scenario
    When I open "/workspace/repositories" as synthetic account "primary"
    Then I should see the public repository for synthetic account "primary"
    When I press "org-primary"
    Then I should see the authorized private repository for synthetic account "primary"
    And I should see "Private · berizin"
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_01 @SAGE_FR_REP_13
  Scenario: [SRS B.7.2 | SAGE-FR-REP-13 Repository Search Empty Result] Repository not found (controlled)
    # SRS 4.2, Alternative Flow 1; the authorized list is retained while the empty search result is shown.
    Given repository APIs are controlled for the browser scenario
    When I open "/workspace/repositories" as synthetic account "primary"
    And I press "org-primary"
    When I fill in "Cari pada repository App yang sudah dimuat" with "repo-tidak-ada"
    Then I should see "Tidak ada hasil pencarian pada halaman yang dimuat."
    When I fill in "Cari pada repository App yang sudah dimuat" with ""
    Then I should see the authorized private repository for synthetic account "primary"
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_02 @SAGE_FR_REP_08
  Scenario: [SRS B.7.2 | SAGE-FR-REP-08 Latest Commit Fallback] Successfully select a repository and branch without a commit (controlled)
    # SRS 4.2 normal flow, steps 5-10; target checks use controlled API responses.
    Given repository APIs are controlled for the browser scenario
    When I open "/workspace/repositories" as synthetic account "primary"
    And I select the public repository for synthetic account "primary"
    And I select "feature/sprint-one" from "Branch"
    And I fill in "Commit (opsional)" with ""
    And I press "Periksa target"
    Then I should see "4e2c15d5c357d8a451bd99d4544f111353dcad80"
    And the target request for repository "public" of synthetic account "primary" uses branch "feature/sprint-one" and commit ""
    And no analysis request was made
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_02 @SAGE_FR_REP_07
  Scenario: [SRS B.7.2 | SAGE-FR-REP-07 Optional Commit Selection] Successfully select a repository with a specific commit (controlled)
    # SRS 4.2 normal flow, steps 5-9; the selected full SHA is checked against a controlled API fixture.
    Given repository APIs are controlled for the browser scenario
    When I open "/workspace/repositories" as synthetic account "primary"
    And I select the public repository for synthetic account "primary"
    And I select "feature/sprint-one" from "Branch"
    And I fill in "Commit (opsional)" with "4e2c15d5c357d8a451bd99d4544f111353dcad80"
    And I press "Periksa target"
    Then I should see "4e2c15d5c357d8a451bd99d4544f111353dcad80"
    And the target request for repository "public" of synthetic account "primary" uses branch "feature/sprint-one" and commit "4e2c15d5c357d8a451bd99d4544f111353dcad80"
    And no analysis request was made
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_02 @SAGE_FR_REP_05 @SAGE_FR_REP_09
  Scenario: [Supporting check | SRS 4.2 | SAGE-FR-REP-05 Branch Retrieval + SAGE-FR-REP-09 Analysis Target Validation] Controlled branch and target failures can be retried
    # Supporting check for controlled branch retrieval and target validation failures and retries.
    Given repository APIs are controlled for the browser scenario
    And the branch API fails on the first request
    And the target validation API fails on the first request
    When I open "/workspace/repositories" as synthetic account "primary"
    And I select the public repository for synthetic account "primary"
    Then I should see "Branch dari GitHub belum dapat dimuat. Coba lagi."
    And I should see "Muat ulang branch"
    When I press "Muat ulang branch"
    Then "Branch" should be set to "main"
    When I press "Periksa target"
    Then I should see "Target belum dapat divalidasi. Coba lagi."
    And "Branch" should be set to "main"
    When I press "Periksa target"
    Then I should see "Target tervalidasi"
    And there were "2" target validation requests
    And no analysis request was made
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_01 @SAGE_FR_REP_01
  Scenario: [Supporting check | SRS 4.2 | SAGE-FR-REP-01 Authorized Repository List] A controlled public repository list failure can be retried
    # Supporting check for the authorized list using a controlled failure and retry.
    Given repository APIs are controlled for the browser scenario
    And the public repository list API fails on the first request
    When I open "/workspace/repositories" as synthetic account "primary"
    Then I should see "Daftar repository public belum tersedia. Coba lagi."
    And I should see "Coba lagi"
    When I press "Coba lagi"
    Then I should see the public repository for synthetic account "primary"
    And the public repository list recovered after its retry
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_02 @SAGE_FR_REP_05 @SAGE_FR_REP_09
  Scenario: [Supporting check | SRS 4.2 | SAGE-FR-REP-05 Branch Retrieval + SAGE-FR-REP-09 Analysis Target Validation] An empty branch list blocks target validation until reloaded
    # Supporting check for the empty-branch guard with controlled API responses.
    Given repository APIs are controlled for the browser scenario
    And the branch API returns an empty list on the first request
    When I open "/workspace/repositories" as synthetic account "primary"
    And I select the public repository for synthetic account "primary"
    Then I should see "Repository ini belum memiliki branch. Tambahkan commit di GitHub sebelum memilih target."
    And the button "Periksa target" is disabled
    When I press "Muat ulang branch"
    Then "Branch" should be set to "main"
    And no target validation request was made
    And no analysis request was made
    And the UI has no JavaScript errors or API requests outside the scenario

  @US_REP_01 @SAGE_FR_GH_06
  Scenario: [Supporting check | SRS 4.1 / 5.3 | SAGE-FR-GH-06 Repository Access Restriction] Switching accounts isolates the visible repositories
    # Supporting check for repository access restriction and SRS 5.3 user access isolation; synthetic accounts and controlled APIs do not represent live provider authorization.
    Given repository APIs are controlled for the browser scenario
    When I open "/workspace/repositories" as synthetic account "primary"
    Then I should see the public repository for synthetic account "primary"
    When I press "org-primary"
    Then I should see the authorized private repository for synthetic account "primary"
    When the browser session switches to synthetic account "secondary"
    Then only the repositories for synthetic account "secondary" are visible instead of those for "primary"
    And the UI has no JavaScript errors or API requests outside the scenario
