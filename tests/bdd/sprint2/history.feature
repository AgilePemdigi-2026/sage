# language: en
@sprint2 @srs @controlled @application_browser
Feature: Search and navigate analysis history
  As a user
  I want to find my previous analyses
  So that I can reopen their results

  @B7_6_1 @browser_history
  Scenario: Display analysis history
    Given I am on "/analyses/{analysisId}"
    When I follow the link "Riwayat"
    Then I should be on "/workspace/history"
    Then my history should show repository "acme/fintech-core" and branch "main"
    And my history should show language "TypeScript" and the completed commit

  @B7_6_2 @browser_history
  Scenario: Search analysis history
    Given I am on "/workspace/history"
    When I search my analysis history for "fintech-core"
    Then my history should show repository "acme/fintech-core" and branch "main"

  @B7_6_3 @browser_history
  Scenario: Open completed analysis details
    Given I am on "/workspace/history"
    When I follow the link "Buka"
    Then I should be on the completed analysis detail page
    And the link "Buka Code Knowledge" should be available
    And the link "Buka TOGAF ADD" should be available

  @B7_6_4 @browser_history
  Scenario: Analysis history not found
    Given I am on "/workspace/history"
    When I search my analysis history for "repo-tidak-ada"
    Then I should see the message "Tidak ada hasil untuk “repo-tidak-ada”"
    And my history should contain no analysis rows

  @B7_6_5 @browser_history @empty_history
  Scenario: No saved analysis history
    Given I am on "/workspace/history"
    And I have no saved analysis
    Then I should see the message "Belum ada riwayat analisis"
    And my history should contain no analysis rows
    When I follow the link "Pilih repository"
    Then I should be on "/workspace/repositories"
