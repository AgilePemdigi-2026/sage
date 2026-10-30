# language: en
@semantic @source_contract
Feature: Source-backed feature flows and knowledge graph
  These scenarios verify deterministic source contracts, not browser or live provider acceptance.

  Scenario: A Next.js action has a source-backed endpoint and decision
    Given the semantic source fixture "nextjs"
    When I extract the semantic model
    Then the model contains the feature "Checkin"
    And the model contains a "decision" node
    And every relationship references existing nodes and source evidence
    And a helper file is not a main knowledge graph node

  Scenario: A Laravel API does not invent frontend screens
    Given the semantic source fixture "laravel"
    When I extract the semantic model
    Then the model contains a "decision" node
    And every relationship references existing nodes and source evidence
    And no frontend screen is invented for the backend fixture

  Scenario: Display corrections preserve the immutable source facts
    Given the semantic source fixture "nextjs"
    When I extract the semantic model
    And I rename the first feature to "Mood check-in"
    Then the projected feature is named "Mood check-in"
    And the source evidence and relationships remain unchanged
    And the export cache separates revision "0" from revision "1"
