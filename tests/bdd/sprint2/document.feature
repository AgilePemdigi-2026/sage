# language: en
@sprint2 @srs @controlled @application_browser
Feature: Read and export Architecture Definition Document
  Documentation reads canonical source facts; exports use the production worker.
  The failure scenario corrupts only the disposable fixture archive checksum.

  Background:
    Given I am signed in as a synthetic owner with a completed analysis

  @B7_5_1 @browser_document
  Scenario: [SRS B.7.5.1] Open Architecture Definition Document
    When I open the completed analysis results
    And I follow the link "Buka dokumentasi"
    Then I should see the heading "Architecture Definition Document"
    And I should see the heading "Interface Catalog"
    When I open documentation section "Software Engineering Diagram"
    Then I should see the heading "Software Engineering Diagram"
    When I open documentation section "UML Class Diagram"
    Then I should see the heading "UML Class Diagram"

  @B7_5_2 @browser_pdf
  Scenario: [SRS B.7.5.2] Successfully export documentation to PDF
    Given I am viewing the completed analysis on "Architecture Definition Document"
    When I press the button "Ekspor PDF"
    Then the "PDF" download should become available
    When I download the "PDF" document
    Then the downloaded "PDF" file should match the completed export

  @B7_5_3 @browser_markdown
  Scenario: [SRS B.7.5.3] Successfully export documentation to Markdown
    Given I am viewing the completed analysis on "Architecture Definition Document"
    When I press the button "Ekspor Markdown"
    Then the "Markdown" download should become available
    When I download the "Markdown" document
    Then the downloaded "Markdown" file should match the completed export

  @B7_5_4 @browser_pdf
  Scenario: [SRS B.7.5.4] Document generation fails and is retried
    Given I am viewing the completed analysis on "Architecture Definition Document"
    And the export worker will encounter an invalid test archive checksum
    When I press the button "Ekspor PDF"
    Then the PDF export should fail with a retry action
    When the test archive checksum is restored
    And I press the button "Coba ekspor PDF lagi"
    Then the "PDF" download should become available
    When I download the "PDF" document
    Then the downloaded "PDF" file should match the completed export
