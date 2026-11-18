import assert from "node:assert/strict";
import test from "node:test";
import { validateCcm, type CcmSnapshot } from "@sage/contracts";
import { analyzePythonSources } from "../apps/worker/src/python-adapter.ts";
import { buildAddBaseline } from "../packages/documents/src/baseline-add.ts";
import { buildSemanticModel } from "../packages/documents/src/semantic/build.ts";

const snapshot: CcmSnapshot = {
  repository: "fixture/python-add",
  branch: "main",
  commitSha: "a".repeat(40),
};
const encoder = new TextEncoder();

test("Python adapter records literal route, local import, model hints, and bounded evidence without execution", () => {
  const sources = {
    "app/models.py": encoder.encode([
      "class Book(Base):",
      "    __tablename__ = 'books'",
      "    id = Column(Integer, primary_key=True)",
      "    author_id = Column(ForeignKey('authors.id'))",
      "" ,
    ].join("\n")),
    "app/routes.py": encoder.encode([
      "from app.models import Book",
      "@app.get('/books')",
      "async def list_books():",
      "    return []",
      "",
    ].join("\n")),
  };
  const result = analyzePythonSources({ snapshot, sources });
  assert.ok(result.ccm, JSON.stringify(result.diagnostics));
  assert.equal(validateCcm(result.ccm, sources).ok, true);

  const route = result.ccm.nodes.find(node => node.name === "list_books");
  const model = result.ccm.nodes.find(node => node.kind === "Class" && node.name === "Book");
  const property = result.ccm.nodes.find(node => node.kind === "Property" && node.name === "author_id");
  assert.equal(route?.attributes.routeMethod, "GET");
  assert.equal(route?.attributes.routePath, "/books");
  assert.equal(model?.attributes.dataModel, true);
  assert.equal(property?.attributes.dataProperty, true);
  assert.ok(result.ccm.edges.some(edge => edge.kind === "IMPORTS" && edge.targetId === model?.id));
  assert.ok(result.ccm.limitations.some(item => item.stage === "Python static adapter"));
  assert.equal(result.diagnostics.length, 0);
});

test("external imports remain valid CCM facts and FastAPI paths reach the ADD interface catalog", () => {
  const sources = {
    "app.py": encoder.encode([
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "@app.get('/books')",
      "def list_books():",
      "    return []",
      "",
    ].join("\n")),
  };
  const result = analyzePythonSources({ snapshot, sources });
  assert.ok(result.ccm, JSON.stringify(result.diagnostics));
  assert.equal(validateCcm(result.ccm, sources).ok, true, "unresolved external references have no source location");
  assert.ok(result.ccm.edges.some(edge => edge.kind === "IMPORTS" && edge.resolution === "Unresolved"));
  const semantic = buildSemanticModel({ ccm: result.ccm, sourceCkgHash: "f".repeat(64), sources });
  const add = buildAddBaseline({ ccm: result.ccm, semantic, sourceCkgHash: "f".repeat(64) });
  assert.ok(add.catalogs.interfaces.some(item => add.elements.find(element => element.id === item.elementId)?.name === "GET /books"));
});

test("FastAPI api_route methods expand through the semantic model into ADD interfaces", () => {
  const sources = { "app.py": encoder.encode([
    "from fastapi import FastAPI",
    "app = FastAPI()",
    "@app.api_route('/books', methods=['GET', 'POST'])",
    "def books():",
    "    return []",
    "",
  ].join("\n")) };
  const result = analyzePythonSources({ snapshot, sources });
  assert.ok(result.ccm, JSON.stringify(result.diagnostics));
  const route = result.ccm.nodes.find(node => node.name === "books");
  assert.equal(route?.attributes.routeMethod, "GET/POST");
  const semantic = buildSemanticModel({ ccm: result.ccm, sourceCkgHash: "f".repeat(64), sources });
  const add = buildAddBaseline({ ccm: result.ccm, semantic, sourceCkgHash: "f".repeat(64) });
  const interfaces = add.catalogs.interfaces.map(item => add.elements.find(element => element.id === item.elementId)?.name);
  assert.ok(interfaces.includes("GET /books"));
  assert.ok(interfaces.includes("POST /books"));
});

test("Python dynamic route path expressions are omitted and reported as limitations", () => {
  const sources = { "app.py": encoder.encode([
    "@app.get('/prefix' + suffix)",
    "def dynamic_route():",
    "    return []",
    "",
  ].join("\n")) };
  const result = analyzePythonSources({ snapshot, sources });
  assert.ok(result.ccm, JSON.stringify(result.diagnostics));
  assert.ok(!result.ccm.nodes.some(node => node.name === "dynamic_route" && typeof node.attributes.routePath === "string"));
  assert.ok(result.ccm.limitations.some(item => item.path === "app.py" && item.reason.includes("dynamic or unsupported path or methods expression")));
});

test("Python api_route dynamic methods are omitted instead of asserting a partial method list", () => {
  const sources = { "app.py": encoder.encode([
    "@app.api_route('/books', methods=['GET'] if False else ['POST'])",
    "def dynamic_methods():",
    "    return []",
    "",
  ].join("\n")) };
  const result = analyzePythonSources({ snapshot, sources });
  assert.ok(result.ccm, JSON.stringify(result.diagnostics));
  assert.ok(!result.ccm.nodes.some(node => node.name === "dynamic_methods" && typeof node.attributes.routePath === "string"));
  assert.ok(result.ccm.limitations.some(item => item.path === "app.py" && item.reason.includes("dynamic or unsupported path or methods expression")));
});

test("Python multiline strings, docstrings, and commented examples do not become source declarations", () => {
  const sources = {
    "app.py": encoder.encode([
      'example = """',
      "@app.get('/fake-assignment')",
      "def fake_assignment():",
      '"""',
      '"""',
      "@app.get('/fake-docstring')",
      "def fake_docstring():",
      '"""',
      "# @app.get('/fake-comment')",
      "# def fake_comment():",
      "@app.get('/real')",
      "def real_route():",
      "    return []",
      "",
    ].join("\n")),
  };
  const result = analyzePythonSources({ snapshot, sources });
  assert.ok(result.ccm, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.ccm.nodes.filter(node => node.attributes.routePath).map(node => node.attributes.routePath), ["/real"]);
  assert.ok(!result.ccm.nodes.some(node => /fake_/u.test(node.name)));
});

test("Python inheritance resolves same-file and explicit local imports without global basename guesses", () => {
  const sources = {
    "app/base.py": encoder.encode("class Parent:\n    pass\n"),
    "app/child.py": encoder.encode("from app.base import Parent as Base\nclass Child(Base):\n    pass\n"),
    "app/rebound.py": encoder.encode("class Parent:\n    pass\nParent = int\nclass Child(Parent):\n    pass\n"),
    "app/rebound_import.py": encoder.encode("from app.base import Parent as Base\nBase = int\nclass Child(Base):\n    pass\n"),
    "app/import_override.py": encoder.encode("class Parent:\n    pass\nfrom other.parent import Parent\nclass Child(Parent):\n    pass\n"),
    "app/function_local_import.py": encoder.encode("class Parent:\n    pass\ndef load():\n    from other.parent import Parent\nclass Child(Parent):\n    pass\n"),
    "app/wildcard_import.py": encoder.encode("class Parent:\n    pass\nfrom other.parent import *\nclass Child(Parent):\n    pass\n"),
    "app/conditional_assignment.py": encoder.encode("class Parent:\n    pass\nif True:\n    Parent = int\nclass Child(Parent):\n    pass\n"),
    "app/conditional_import.py": encoder.encode("class Parent:\n    pass\nif True:\n    from other.parent import Parent\nclass Child(Parent):\n    pass\n"),
    "other/conditional.py": encoder.encode("class Parent:\n    pass\nif True:\n    Parent = int\n"),
    "app/import_conditional_export.py": encoder.encode("from other.conditional import Parent\nclass Child(Parent):\n    pass\n"),
    "other/parent.py": encoder.encode("class Parent:\n    pass\n"),
    "other/base.py": encoder.encode("class Parent:\n    pass\n"),
    "other/unbound.py": encoder.encode("class Unbound(Parent):\n    pass\n"),
  };
  const result = analyzePythonSources({ snapshot, sources });
  assert.ok(result.ccm, JSON.stringify(result.diagnostics));
  const child = result.ccm.nodes.find(node => node.qualifiedName === "app.child.Child");
  const expectedParent = result.ccm.nodes.find(node => node.qualifiedName === "app.base.Parent");
  const unbound = result.ccm.nodes.find(node => node.qualifiedName === "other.unbound.Unbound");
  const reboundChild = result.ccm.nodes.find(node => node.qualifiedName === "app.rebound.Child");
  const reboundImportChild = result.ccm.nodes.find(node => node.qualifiedName === "app.rebound_import.Child");
  const importOverrideChild = result.ccm.nodes.find(node => node.qualifiedName === "app.import_override.Child");
  const functionLocalChild = result.ccm.nodes.find(node => node.qualifiedName === "app.function_local_import.Child");
  const wildcardImportChild = result.ccm.nodes.find(node => node.qualifiedName === "app.wildcard_import.Child");
  const conditionalAssignmentChild = result.ccm.nodes.find(node => node.qualifiedName === "app.conditional_assignment.Child");
  const conditionalImportChild = result.ccm.nodes.find(node => node.qualifiedName === "app.conditional_import.Child");
  const importedConditionalExportChild = result.ccm.nodes.find(node => node.qualifiedName === "app.import_conditional_export.Child");
  const otherParent = result.ccm.nodes.find(node => node.qualifiedName === "other.parent.Parent");
  const localFunctionParent = result.ccm.nodes.find(node => node.qualifiedName === "app.function_local_import.Parent");
  const extendsEdges = result.ccm.edges.filter(edge => edge.kind === "EXTENDS");
  assert.ok(extendsEdges.some(edge => edge.sourceId === child?.id && edge.targetId === expectedParent?.id));
  assert.ok(!extendsEdges.some(edge => edge.sourceId === unbound?.id), "same basenames from other modules are not treated as bindings");
  assert.ok(!extendsEdges.some(edge => edge.sourceId === reboundChild?.id), "same-file rebinding invalidates a previous class binding");
  assert.ok(!extendsEdges.some(edge => edge.sourceId === reboundImportChild?.id), "import alias rebinding invalidates the imported class binding");
  assert.ok(extendsEdges.some(edge => edge.sourceId === importOverrideChild?.id && edge.targetId === otherParent?.id), "a later module import overrides an earlier same-file class binding");
  assert.ok(extendsEdges.some(edge => edge.sourceId === functionLocalChild?.id && edge.targetId === localFunctionParent?.id), "a function-local import does not override the module binding");
  assert.ok(!extendsEdges.some(edge => edge.sourceId === wildcardImportChild?.id), "wildcard imports block a potentially shadowed exact base binding");
  assert.ok(!extendsEdges.some(edge => edge.sourceId === conditionalAssignmentChild?.id), "module-level control flow makes nested assignments ambiguous");
  assert.ok(!extendsEdges.some(edge => edge.sourceId === conditionalImportChild?.id), "module-level control flow makes nested imports ambiguous");
  assert.ok(!extendsEdges.some(edge => edge.sourceId === importedConditionalExportChild?.id), "export-module control flow makes imported class bindings ambiguous");
});
