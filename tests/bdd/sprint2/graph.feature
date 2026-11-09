# language: en
@sprint2 @srs @controlled @application_browser
Feature: Explore Code Knowledge from a completed analysis
  Synthetic owners use canonical analyzer output stored in isolated PostgreSQL.
  Every scenario has its own browser context and performs the interactions below.

  Background:
    Given I am signed in as a synthetic owner with a completed analysis

  @B7_4_1 @browser_graph
  Scenario: [SRS B.7.4.1] Display Code Knowledge Graph
    When I open the completed analysis results
    And I follow the link "Buka knowledge graph"
    Then I should see the heading "Struktur source code"
    And I should see a graph canvas with source nodes and relationships

  @B7_4_2 @browser_graph
  Scenario: [SRS B.7.4.2] Search nodes in Knowledge Graph
    Given I am viewing the completed analysis on "Code Knowledge"
    When I press the button "Detail AST"
    And I fill in "Cari node" with "Endpoint"
    Then the available focus nodes should match "Endpoint"

  @B7_4_3 @browser_graph
  Scenario: [SRS B.7.4.3] Filter nodes by AST category
    Given I am viewing the completed analysis on "Code Knowledge"
    When I press the button "Detail AST"
    And I select AST category "Class"
    Then only AST category "Class" should be available for focus

  @B7_4_4 @browser_graph
  Scenario: [SRS B.7.4.4] View node details
    Given I am viewing the completed analysis on "Code Knowledge"
    When I press the button "Detail AST"
    And I select node "Endpoint" from "Pilih node fokus"
    Then the node inspector should show "Endpoint" and its source location

  @B7_4_5 @browser_graph
  Scenario: [SRS B.7.4.5] Node not found
    Given I am viewing the completed analysis on "Code Knowledge"
    When I press the button "Detail AST"
    And I fill in "Cari node" with "node-tidak-ada"
    Then I should see the message "Tidak ada node yang sesuai dengan kueri dan jenis node yang dipilih."
    And no graph nodes should be available for focus
    When I press the button "Atur ulang filter"
    Then the graph focus picker should include node "Endpoint"
