# language: en
@sprint2 @srs @controlled @application_browser
Feature: Explore Code Knowledge from a completed analysis
  As a developer
  I want to explore source code relationships
  So that I can understand the analyzed application

  @B7_4_1 @browser_graph
  Scenario: Display Code Knowledge Graph
    Given I am on "/analyses/{analysisId}"
    When I follow the link "Buka knowledge graph"
    Then I should see the heading "Struktur source code"
    And I should see a graph canvas with source nodes and relationships

  @B7_4_2 @browser_graph
  Scenario: Search nodes in Knowledge Graph
    Given I am on "/analyses/{analysisId}/graph"
    When I press the button "Detail AST"
    And I fill in "Cari node" with "Endpoint"
    Then the available focus nodes should match "Endpoint"

  @B7_4_3 @browser_graph
  Scenario: Filter nodes by AST category
    Given I am on "/analyses/{analysisId}/graph"
    When I press the button "Detail AST"
    And I select AST category "Class"
    Then only AST category "Class" should be available for focus

  @B7_4_4 @browser_graph
  Scenario: View node details
    Given I am on "/analyses/{analysisId}/graph"
    When I press the button "Detail AST"
    And I select node "Endpoint" from "Pilih node fokus"
    Then the node inspector should show "Endpoint" and its source location

  @B7_4_5 @browser_graph
  Scenario: Node not found
    Given I am on "/analyses/{analysisId}/graph"
    When I press the button "Detail AST"
    And I fill in "Cari node" with "node-tidak-ada"
    Then I should see the message "Tidak ada node yang sesuai dengan kueri dan jenis node yang dipilih."
    And no graph nodes should be available for focus
    When I press the button "Atur ulang filter"
    Then the graph focus picker should include node "Endpoint"
