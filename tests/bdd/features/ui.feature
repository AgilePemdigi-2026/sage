# language: en

@sprint1 @controlled @browser @issue_5
Feature: Protect workspace access for unauthenticated sessions
  This is a supporting check for APP-01 and NFR-05, aligned with SRS section 5.3's credential protection and user access isolation principle. It does not test SAGE-FR-GH-09 provider authentication failure.

  @APP_01 @NFR_05
  Scenario: [Supporting check | APP-01 / NFR-05 | SRS 5.3] An unauthenticated user is redirected away from the workspace
    Given the browser has no SAGE session cookie
    When I open the workspace page
    Then I am redirected to sign-in with a safe session message
