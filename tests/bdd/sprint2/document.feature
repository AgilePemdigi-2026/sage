# language: en
@sprint2 @srs @controlled @application_browser
Feature: Read and export Architecture Definition Document
  As a developer
  I want to read and export architecture documentation
  So that I can study and share the analysis results

  @B7_5_1 @browser_document
  Scenario: Open Architecture Definition Document
    Given I am on "/analyses/{analysisId}"
    When I follow the link "Buka dokumentasi"
    Then I should see the heading "Architecture Definition Document"
    And I should see the heading "Interface Catalog"
    When I open documentation section "Software Engineering Diagram"
    Then I should see the heading "Software Engineering Diagram"
    When I open documentation section "UML Class Diagram"
    Then I should see the heading "UML Class Diagram"

  @B7_5_2 @browser_pdf
  Scenario: Successfully export documentation to PDF
    Given I am on "/analyses/{analysisId}/document"
    When I press the button "Ekspor PDF"
    Then the "PDF" download should become available
    When I download the "PDF" document
    Then the downloaded "PDF" file should match the completed export

  @B7_5_3 @browser_markdown
  Scenario: Successfully export documentation to Markdown
    Given I am on "/analyses/{analysisId}/document"
    When I press the button "Ekspor Markdown"
    Then the "Markdown" download should become available
    When I download the "Markdown" document
    Then the downloaded "Markdown" file should match the completed export

  @B7_5_4 @browser_pdf
  Scenario: Document generation fails and is retried
    Given I am on "/analyses/{analysisId}/document"
    And the next "PDF" export will fail
    When I press the button "Ekspor PDF"
    Then the "PDF" export should fail with a retry action
    When the export failure is resolved
    And I press the button "Coba ekspor PDF lagi"
    Then the "PDF" download should become available
    When I download the "PDF" document
    Then the downloaded "PDF" file should match the completed export
