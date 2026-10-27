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
    required("metadata", [expected["title"], expected["snapshot"]["repository"], expected["snapshot"]["branch"]])
    declarations = [row["declaration"] for row in expected["interfaceCatalog"]["entries"]]
    declaration_ids = {node["id"] for node in declarations}
    root_declarations = [node for node in declarations if not (node["kind"] in ["Method", "Property"] and node["parentId"] in declaration_ids)]
    def human_name(node):
        name = node["qualifiedName"] or node["name"]
        prefix = (node.get("filePath") or "") + "."
        return name[len(prefix):] if node.get("filePath") and name.startswith(prefix) else name
    required("catalogNames", [human_name(node) for node in root_declarations])
    required("catalogSignatures", [node.get("signature") for node in declarations])
    required("catalogEvidence", [node["location"]["filePath"] for node in declarations if node["location"]])
    required("limitations", [item["reason"] for item in expected["limitations"]])
    required("sections", ["Interface Catalog", "Software Engineering Diagram", "UML Class Diagram"])
    forbidden = [expected["ckgSha256"], expected["configurationHash"], expected["snapshot"]["commitSha"]]
    forbidden += [node["id"] for node in nodes]
    forbidden += [edge["id"] for edge in expected["interfaceCatalog"]["relations"]]
    assert all(compact(value) not in normalized for value in forbidden), "PDF exposes opaque machine identifiers"
    assert "data-grid" not in text and "Detail A1" not in text
    assert "Canonical node and edge register" not in text
    assert sum("Software Engineering Diagram" in page for page in pages) == 1
    assert sum("UML Class Diagram" in page for page in pages) == 1
    assert all(abs(w - 841.92) < 2 and abs(h - 595.92) < 2 for w,h in sizes), "A4 landscape required"
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
        "replacementGlyphAbsent": True, "retryCanonicalTextMatches": True, "compactContract": True, "opaqueIdsAbsent": True, "visualReview": "pending",
    }
    (folder / "pdf-inspection.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
