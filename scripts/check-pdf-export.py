"""Check PDF text against the canonical test:pdf:live fixture.

Requires Python 3 and pdfplumber. Pass the fresh browser artifact directory.
Render and inspect every page separately: text checks do not prove layout quality.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

import pdfplumber


def compact(value):
    return re.sub(r"\s+", "", str(value))


def extract(path):
    with pdfplumber.open(path) as document:
        # Content-stream order keeps wrapped table cells together instead of
        # interleaving text from adjacent columns on the same physical line.
        pages = [page.extract_text(use_text_flow=True) or "" for page in document.pages]
        sizes = [(page.width, page.height) for page in document.pages]
        attribute_fragments = []
        for page, page_text in zip(document.pages, pages):
            if "Attributes (JSON)" not in page_text:
                continue
            for table in page.find_tables():
                attribute_column = None
                for row in table.extract():
                    headers = [compact(cell) if cell else "" for cell in row]
                    if "Attributes(JSON)" in headers:
                        attribute_column = headers.index("Attributes(JSON)")
                        continue
                    if "CanonicaledgeID" in headers:
                        attribute_column = None
                    if attribute_column is not None and attribute_column < len(row):
                        attribute_fragments.append(row[attribute_column] or "")
    return pages, sizes, "".join(attribute_fragments)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    folder = parser.parse_args().directory
    pdf = folder / "sage-pdf21-browser-390.pdf"
    expected = json.loads((folder / "expected-document.json").read_text())
    pages, sizes, attribute_text = extract(pdf)
    text = "\n".join(pages)
    normalized = compact(text)
    checks, missing = {}, []

    def required(category, values, haystack=normalized):
        values = list(dict.fromkeys(str(value) for value in values if value is not None and str(value)))
        absent = [value for value in values if compact(value) not in haystack]
        checks[category] = {"expected": len(values), "matched": len(values) - len(absent)}
        missing.extend({"category": category, "value": value} for value in absent)

    nodes = expected["softwareEngineeringDiagram"]["nodes"]
    edges = expected["interfaceCatalog"]["relations"]
    required("metadata", [expected["title"], expected["schemaVersion"], expected["ckgSha256"],
                          expected["configurationHash"], *expected["snapshot"].values()])
    required("nodeIds", [node["id"] for node in nodes])
    required("nodeNames", [node["name"] for node in nodes] + [node["qualifiedName"] for node in nodes])
    required("nodeSignatures", [node.get("signature") for node in nodes])
    required("nodeAttributes", [json.dumps(node["attributes"], sort_keys=True, ensure_ascii=False,
                                           separators=(",", ":")) for node in nodes], compact(attribute_text))
    required("edgeIds", [edge["id"] for edge in edges])
    required("relationFields", [edge["kind"] for edge in edges] + [edge["resolution"] for edge in edges]
             + [edge["unresolvedReason"] for edge in edges])
    required("files", [file["path"] for file in expected["files"]]
             + [file["sha256"] for file in expected["files"]])
    spans = [node["location"] for node in nodes if node["location"]]
    spans += [span for edge in edges for span in edge["evidence"]]
    required("evidence", [span["filePath"] for span in spans] + [span["fileSha256"] for span in spans]
             + [f"[{span['startByte']}, {span['endByte']})" for span in spans]
             + [f"{span['startLine']}:{span['startColumn']}" for span in spans]
             + [f"{span['endLine']}:{span['endColumn']}" for span in spans])
    required("limitations", [item["reason"] for item in expected["limitations"]])
    required("sections", ["Interface Catalog", "Software Engineering Diagram", "UML Class Diagram",
                          "Canonical node and edge register"])
    diagram_text = compact("\n".join(page for page in pages if "Diagram ·" in page))
    literal_paths = [file["path"] for file in expected["files"] if "#95;" in file["path"]]
    for path in literal_paths:
        assert compact(path) in diagram_text, "Diagram changed a literal numeric-token path"
    assert "UNKNOWN#95;RECEIVER" not in diagram_text and "UNKNOWN&#95;RECEIVER" not in diagram_text, "Diagram left a generated underscore escape"
    assert not missing, missing
    assert "\ufffd" not in text
    assert "PDF21_RAW_SOURCE_CANARY" not in text
    assert "PDF21_URL_CANARY" not in text
    assert all("SAGE Architecture Definition Document" in page for page in pages)
    assert all(f"{index} / {len(pages)}" in page for index, page in enumerate(pages, 1))
    retry = folder / "sage-pdf21-browser-retry.pdf"
    assert retry.is_file(), "The real retry PDF is required"
    retry_pages, _, _ = extract(retry)
    assert compact("\n".join(retry_pages)) == normalized, "Retry changed the canonical PDF text"
    (folder / "extracted-text.txt").write_text(text)
    report = {
        "status": "PASS", "pages": len(pages), "pageSizesPt": sorted(set(sizes)),
        "checks": checks, "missing": missing, "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
        "bytes": pdf.stat().st_size, "allPagesHeaderFooter": True, "canariesAbsent": True,
        "replacementGlyphAbsent": True, "retryCanonicalTextMatches": True, "diagramEscapesFaithful": True, "visualReview": "pending",
    }
    (folder / "pdf-inspection.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
