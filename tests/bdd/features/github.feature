# language: en

@sprint1 @controlled @browser @issue_5
Feature: GitHub connection denial and retry
  SRS section 4.1, Alternative Flow 1. This browser scenario uses a controlled denial callback; it does not verify live GitHub OAuth or full requirement acceptance.

  @US_GH_01 @SAGE_FR_GH_08 @SAGE_FR_GH_10
  Scenario: [SRS B.7.1 | SAGE-FR-GH-08 Permission Denial Handling + SAGE-FR-GH-10 Retry Connection] The developer denies GitHub access permission (controlled)
    Given I am on "/"
    When I press "Hubungkan GitHub"
    Then I should be on "/login"
    And I should see "Masuk dengan GitHub"
    And the button "Masuk dengan GitHub" is enabled
    And no OAuth authorization request or external request was started
    When the controlled GitHub denial callback is returned
    Then I should be on "/login?error=denied"
    And I should see "Permintaan akses GitHub dibatalkan. Kamu bisa memulai login lagi kapan saja."
    And I should see "Masuk dengan GitHub"
    And the button "Masuk dengan GitHub" is enabled
    And the denial response exposes no OAuth state and starts no authorization request
