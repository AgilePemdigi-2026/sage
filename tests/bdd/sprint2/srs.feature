@sprint2 @srs @application_browser
Feature: Sprint 2 SRS user story scenarios
  The production browser suites execute each interaction against isolated PostgreSQL.
  Related scenarios assert distinct checkpoints from one shared suite run.
  Source scenario IDs refer to SRS B.7.4 through B.7.6.

  @B7_4_1 @browser_graph
  Scenario: Display Code Knowledge Graph
    Given the SRS user story scenario "B7.4.1"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_4_2 @browser_graph
  Scenario: Search nodes in Knowledge Graph
    Given the SRS user story scenario "B7.4.2"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_4_3 @browser_graph
  Scenario: Filter nodes by AST category
    Given the SRS user story scenario "B7.4.3"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_4_4 @browser_graph
  Scenario: View node details
    Given the SRS user story scenario "B7.4.4"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_4_5 @browser_graph
  Scenario: Node not found
    Given the SRS user story scenario "B7.4.5"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_5_1 @browser_document
  Scenario: Open Architecture Definition Document
    Given the SRS user story scenario "B7.5.1"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_5_2 @browser_pdf
  Scenario: Successfully export documentation to PDF
    Given the SRS user story scenario "B7.5.2"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_5_3 @browser_markdown
  Scenario: Successfully export documentation to Markdown
    Given the SRS user story scenario "B7.5.3"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_5_4 @browser_pdf
  Scenario: Document generation fails and is retried
    Given the SRS user story scenario "B7.5.4"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_6_1 @browser_history
  Scenario: Display analysis history
    Given the SRS user story scenario "B7.6.1"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_6_2 @browser_history
  Scenario: Search analysis history
    Given the SRS user story scenario "B7.6.2"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_6_3 @browser_history
  Scenario: Open completed analysis details
    Given the SRS user story scenario "B7.6.3"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_6_4 @browser_history
  Scenario: Analysis history not found
    Given the SRS user story scenario "B7.6.4"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass

  @B7_6_5 @browser_history
  Scenario: No saved analysis history
    Given the SRS user story scenario "B7.6.5"
    When its production browser workflow is exercised
    Then its source scenario checkpoints pass
