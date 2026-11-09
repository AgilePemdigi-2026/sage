# language: en
@sprint2 @srs @controlled @application_browser
Feature: Search and navigate analysis history
  History uses the actual owner-scoped API and persisted fixture records.

  @B7_6_1 @browser_history
  Scenario: [SRS B.7.6.1] Display analysis history
    Given I am signed in as a synthetic owner with a completed analysis
    When I open my analysis history
    Then my history should show repository "acme/fintech-core" and branch "main"
    And my history should show language "TypeScript" and the completed commit

  @B7_6_2 @browser_history
  Scenario: [SRS B.7.6.2] Search analysis history
    Given I am signed in as a synthetic owner with a completed analysis
    When I open my analysis history
    And I search my analysis history for "fintech-core"
    Then my history should show repository "acme/fintech-core" and branch "main"

  @B7_6_3 @browser_history
  Scenario: [SRS B.7.6.3] Open completed analysis details
    Given I am signed in as a synthetic owner with a completed analysis
    When I open my analysis history
    And I follow the link "Buka"
    Then I should be on the completed analysis detail page
    And the link "Buka knowledge graph" should be available
    And the link "Buka dokumentasi" should be available

  @B7_6_4 @browser_history
  Scenario: [SRS B.7.6.4] Analysis history not found
    Given I am signed in as a synthetic owner with a completed analysis
    When I open my analysis history
    And I search my analysis history for "repo-tidak-ada"
    Then I should see the message "Tidak ada hasil untuk “repo-tidak-ada”"
    And my history should contain no analysis rows

  @B7_6_5 @browser_history
  Scenario: [SRS B.7.6.5] No saved analysis history
    Given I am signed in as a synthetic owner without saved analyses
    When I open my analysis history
    Then I should see the message "Belum ada riwayat analisis"
    And my history should contain no analysis rows
    When I follow the link "Pilih repository"
    Then I should be on "/workspace/repositories"
