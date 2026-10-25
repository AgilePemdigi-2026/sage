# language: en

@sprint1 @controlled @browser @issue_5
Feature: GitHub connection denial and retry
  SRS section 4.1, Alternative Flow 1. This browser scenario uses a controlled denial callback; it does not verify live GitHub OAuth or full requirement acceptance.

  @US_GH_01 @SAGE_FR_GH_08 @SAGE_FR_GH_10
  Scenario: [SRS B.7.1 | SAGE-FR-GH-08 Permission Denial Handling + SAGE-FR-GH-10 Retry Connection] The developer denies GitHub access permission (controlled)
    Given I am on the SAGE landing page
    When I select the Connect with GitHub link
    Then the sign-in form appears without starting an authorization request
    When the controlled GitHub denial callback is returned
    Then the UI shows a safe denial message and offers a retry action
