import assert from "node:assert/strict";
import test from "node:test";
import type { CcmEdge, CcmNode, EvidenceSpan } from "@sage/contracts";
import { buildArchitectureUml, listArchitectureUmlScopes } from "../packages/documents/src/architecture-uml.ts";
import type { DiagramProjection } from "../packages/documents/src/diagrams.ts";
import { projectHumanDiagram } from "../packages/documents/src/human-diagrams.ts";

function node(id: string, kind: CcmNode["kind"], name: string, options: Partial<CcmNode> = {}): CcmNode {
  return {
    id, kind, name, qualifiedName: name, parentId: null, origin: "source", language: "typescript",
    filePath: "src/domain/model.ts", location: null, signature: null, attributes: {}, ...options,
  };
}

function evidence(filePath: string, startLine = 1): EvidenceSpan {
  return { filePath, fileSha256: "a".repeat(64), startByte: startLine, endByte: startLine + 1,
    startLine, endLine: startLine, startColumn: 1, endColumn: 2, role: "reference" };
}

function edge(id: string, sourceId: string, targetId: string, kind: CcmEdge["kind"], resolution: CcmEdge["resolution"] = "Exact"): CcmEdge {
  return { id, sourceId, targetId, kind, resolution, evidence: [evidence(`src/${id}.ts`)],
    unresolvedReason: resolution === "Unresolved" ? "UNKNOWN_RECEIVER" : null };
}

function projection(kind: DiagramProjection["kind"], nodes: CcmNode[], edges: CcmEdge[] = []): DiagramProjection {
  return { kind, title: kind, mermaid: kind === "uml-class" ? "classDiagram" : "flowchart LR", nodes, edges,
    nodeMappings: [], edgeMappings: [], excludedNodeIds: [], excludedEdgeIds: [] };
}

test("architecture UML lifts method and property edges to owners without inventing UML relations", () => {
  const view = node("view", "Class", "OrderView", { filePath: "src/views/OrderView.ts" });
  const render = node("render", "Method", "render", { parentId: view.id, signature: "render(): void" });
  const controller = node("controller", "Class", "OrderController", { filePath: "src/controllers/OrderController.ts" });
  const handle = node("handle", "Method", "handle", { parentId: controller.id });
  const entity = node("entity", "Class", "OrderEntity", { filePath: "src/entities/OrderEntity.ts" });
  const status = node("status", "Property", "status", { parentId: entity.id, signature: "string" });
  const calls = edge("calls-view-controller", render.id, handle.id, "CALLS");
  const typeReference = edge("type-controller-entity", handle.id, status.id, "TYPE_REFERENCES");
  const repeated = edge("calls-view-controller-2", render.id, handle.id, "CALLS");
  const software = projection("software-structure", [view, render, controller, handle, entity, status], [calls, typeReference, repeated]);
  const uml = projection("uml-class", [view, render, controller, handle, entity, status]);
  const before = JSON.stringify({ software, uml });

  const result = buildArchitectureUml(software, uml);

  assert.equal(JSON.stringify({ software, uml }), before, "input projections must remain untouched");
  assert.match(result.projection.mermaid, /^classDiagram\n  direction TB/m);
  assert.match(result.projection.mermaid, /<<boundary>>/);
  assert.match(result.projection.mermaid, /<<control>>/);
  assert.match(result.projection.mermaid, /<<entity>>/);
  assert.match(result.projection.mermaid, /calls #215;2/);
  assert.match(result.projection.mermaid, /type/);
  assert.doesNotMatch(result.projection.mermaid, /--\|>|\.\.\|>|composition|multiplicity/i);
  assert.equal(result.dependencies.length, 2, "different dependency kinds stay separate");
  const callsGroup = result.dependencies.find(group => group.kind === "CALLS")!;
  assert.deepEqual(callsGroup.sourceEdgeIds, [calls.id, repeated.id]);
  assert.equal(callsGroup.representativeEdgeId, calls.id);
  assert.equal(callsGroup.sourceEdges[0], calls);
  assert.deepEqual(callsGroup.evidence, [...calls.evidence, ...repeated.evidence]);
  assert.deepEqual(result.projection.edgeMappings.map(mapping => mapping.edgeId).sort(), [calls.id, repeated.id, typeReference.id].sort());
  const callsLine = result.projection.edgeMappings.find(mapping => mapping.edgeId === calls.id)?.mermaidLine;
  assert.equal(result.projection.edgeMappings.find(mapping => mapping.edgeId === repeated.id)?.mermaidLine, callsLine);
  assert.notEqual(result.projection.edgeMappings.find(mapping => mapping.edgeId === typeReference.id)?.mermaidLine, callsLine,
    "different owner pairs keep separate visible arrows");
  assert.equal(result.projection.humanMetadata.displayEdgeCount, 2);
  assert.deepEqual(result.projection.edgeMappings.find(mapping => mapping.edgeId === typeReference.id)?.evidence, typeReference.evidence);
  assert.deepEqual(result.summary.classificationBasis, { nameConvention: 0, pathConvention: 0, nameAndPath: 3, ambiguous: 0, none: 0 });
  assert.equal(result.summary.totalEdges, 3);
  assert.equal(result.summary.shownEdges, 3);
  assert.equal(result.summary.totalMembers, 3);
  assert.equal(result.summary.shownMembers, 3);
});

test("unresolved placeholders stay out of UML while omitted source evidence is counted", () => {
  const controller = node("controller", "Class", "CheckoutController");
  const method = node("method", "Method", "submit", { parentId: controller.id });
  const unresolved = node("unresolved", "UnresolvedReference", "UnknownPayment", { origin: "unresolved" });
  const observation = edge("unresolved-call", method.id, unresolved.id, "CALLS", "Unresolved");
  const result = buildArchitectureUml(
    projection("software-structure", [controller, method, unresolved], [observation]),
    projection("uml-class", [controller, method]),
  );

  assert.deepEqual(result.projection.nodes.map(item => item.id), [controller.id, method.id]);
  assert.doesNotMatch(result.projection.mermaid, /UnknownPayment|unresolved>>/);
  assert.equal(result.summary.unresolvedReferences, 1);
  assert.equal(result.summary.omittedUnresolved, 1);
  assert.deepEqual(result.unresolvedSourceEdgeIds, [observation.id]);
  assert.equal(result.projection.humanMetadata.omittedUnresolved, 1);
  assert.equal(result.summary.unownedDependencyEdges, 1);
  assert.equal(result.projection.edges.length, 0, "hidden source edges are exposed through metadata, not fed to the bounded renderer");
  assert.equal(result.sourceEdges[0], observation);
});

test("visible inheritance remains exact source evidence and contributes to the projection summary", () => {
  const base = node("base", "Class", "OrderEntity", { filePath: "src/entities/OrderEntity.ts" });
  const derived = node("derived", "Class", "OrderService", { filePath: "src/services/OrderService.ts" });
  const unresolved = node("unresolved-base", "UnresolvedReference", "UnknownBase", { origin: "unresolved" });
  const inheritance = edge("extends-exact", derived.id, base.id, "EXTENDS");
  const unresolvedInheritance = edge("extends-unresolved", derived.id, unresolved.id, "EXTENDS", "Unresolved");
  const result = buildArchitectureUml(
    projection("software-structure", [base, derived, unresolved]),
    projection("uml-class", [base, derived, unresolved], [inheritance, unresolvedInheritance]),
  );

  assert.match(result.projection.mermaid, /<\|--/);
  assert.doesNotMatch(result.projection.mermaid, /UnknownBase|unresolved>>/);
  assert.equal(result.summary.totalInheritanceEdges, 1);
  assert.equal(result.summary.shownInheritanceEdges, 1);
  assert.equal(result.summary.totalRelations, 1);
  assert.equal(result.summary.shownRelations, 1);
  assert.equal(result.projection.edges[0], inheritance);
  assert.deepEqual(result.projection.edgeMappings.map(mapping => mapping.edgeId), [inheritance.id]);
  assert.deepEqual(result.projection.edgeMappings[0]?.evidence, inheritance.evidence);
  assert.deepEqual(result.unresolvedSourceEdgeIds, [unresolvedInheritance.id]);
  assert.equal(result.summary.omittedUnresolved, 1);

  const capped = buildArchitectureUml(projection("software-structure", [base, derived]),
    projection("uml-class", [base, derived], [inheritance]), { maxSourceRecords: 0 });
  assert.equal(capped.summary.totalInheritanceEdges, 1);
  assert.equal(capped.summary.shownInheritanceEdges, 0);
  assert.equal(capped.projection.edges.length, 0);
  assert.deepEqual(capped.projection.excludedEdgeIds, [inheritance.id]);
});

test("unresolved class dependencies use valid UML grammar and keep their status label", () => {
  const source = node("source", "Class", "CheckoutController");
  const target = node("target", "Class", "PaymentGateway");
  const method = node("method", "Method", "submit", { parentId: source.id });
  const targetMethod = node("target-method", "Method", "charge", { parentId: target.id });
  const unresolvedCall = edge("unresolved-known-owner-call", method.id, targetMethod.id, "CALLS", "Unresolved");
  const result = buildArchitectureUml(
    projection("software-structure", [source, target, method, targetMethod], [unresolvedCall]),
    projection("uml-class", [source, target, method, targetMethod]),
  );

  assert.match(result.projection.mermaid, /\.\.>.*calls.*Unresolved/);
  assert.doesNotMatch(result.projection.mermaid, /-\.->/);
  assert.deepEqual(result.projection.edgeMappings.map(mapping => mapping.edgeId), [unresolvedCall.id]);
});

test("dependency display grouping keeps resolution states on separate lines and maps every source edge", () => {
  const source = node("source", "Class", "CustomerController");
  const target = node("target", "Class", "CustomerEntity");
  const method = node("method", "Method", "save", { parentId: source.id });
  const targetMethod = node("target-method", "Method", "persist", { parentId: target.id });
  const calls = edge("calls-exact", method.id, targetMethod.id, "CALLS");
  const type = edge("type-exact", method.id, targetMethod.id, "TYPE_REFERENCES");
  const unresolved = edge("calls-unresolved", method.id, targetMethod.id, "CALLS", "Unresolved");
  const result = buildArchitectureUml(
    projection("software-structure", [source, target, method, targetMethod], [calls, type, unresolved]),
    projection("uml-class", [source, target, method, targetMethod]),
  );

  const relationLines = result.projection.mermaid.split("\n").filter(line => line.includes(" ..> "));
  assert.equal(relationLines.length, 2);
  assert.ok(relationLines.some(line => /calls.*type.*Exact/.test(line)));
  assert.ok(relationLines.some(line => /calls.*Unresolved/.test(line)));
  const mappings = result.projection.edgeMappings;
  assert.deepEqual(mappings.map(mapping => mapping.edgeId).sort(), [calls.id, type.id, unresolved.id].sort());
  assert.equal(new Set(mappings.filter(mapping => mapping.edgeId !== unresolved.id).map(mapping => mapping.mermaidLine)).size, 1);
  assert.notEqual(mappings.find(mapping => mapping.edgeId === unresolved.id)?.mermaidLine,
    mappings.find(mapping => mapping.edgeId === calls.id)?.mermaidLine);
  assert.equal(result.dependencies.length, 3, "per-kind/status metadata remains intact despite visible aggregation");
  assert.equal(result.projection.humanMetadata.displayEdgeCount, 2);
});

test("BCE role heuristics require an unambiguous name or path and unknown classes stay plain", () => {
  const byPath = node("path-boundary", "Class", "ScreenThing", { filePath: "src/ui/screen-thing.ts" });
  const conflict = node("conflict", "Class", "InvoiceView", { filePath: "src/services/InvoiceView.ts" });
  const unknown = node("unknown", "Class", "InvoiceProcessor", { filePath: "src/core/InvoiceProcessor.ts" });
  const result = buildArchitectureUml(projection("software-structure", [byPath, conflict, unknown]),
    projection("uml-class", [byPath, conflict, unknown]));

  assert.deepEqual(result.roles[byPath.id], { role: "boundary", basis: "path-convention", nameConvention: null, pathConvention: "ui" });
  assert.deepEqual(result.roles[conflict.id], { role: null, basis: "ambiguous", nameConvention: "View", pathConvention: "services" });
  assert.equal(result.roles[unknown.id]?.role, null);
  assert.equal(result.roles[unknown.id]?.basis, "none");
  assert.match(result.projection.mermaid, /<<boundary>>/);
  assert.doesNotMatch(result.projection.mermaid, /<<control>>|<<entity>>/);
  assert.equal(result.summary.classificationBasis.pathConvention, 1);
  assert.equal(result.summary.classificationBasis.ambiguous, 1);
  assert.equal(result.summary.classificationBasis.none, 1);
});

test("large disconnected class sets render as four-class pages with deterministic offsets", () => {
  const interfaces = Array.from({ length: 12 }, (_, index) => node(
    `interface-${String(index).padStart(2, "0")}`, "Interface", `Contract${String(index).padStart(2, "0")}`,
    { filePath: `src/contracts/contract-${String(index).padStart(2, "0")}.ts` },
  ));
  const software = projection("software-structure", interfaces);
  const uml = projection("uml-class", interfaces);
  const original = JSON.stringify({ software, uml });

  const first = buildArchitectureUml(software, uml);
  const second = buildArchitectureUml(software, uml, { offset: 4 });
  const last = buildArchitectureUml(software, uml, { offset: 8 });

  assert.equal(first.summary.totalNodes, 12);
  assert.equal(first.summary.shownNodes, 4);
  assert.equal(first.summary.omittedClassifiers, 8);
  assert.equal(second.summary.shownNodes, 4);
  assert.equal(second.summary.omittedClassifiers, 8);
  assert.equal(last.summary.shownNodes, 4);
  assert.equal(last.summary.omittedClassifiers, 8);
  assert.notEqual(first.projection.mermaid, second.projection.mermaid);
  assert.notEqual(second.projection.mermaid, last.projection.mermaid);
  assert.equal(first.projection.edgeMappings.length, 0);
  assert.equal(JSON.stringify({ software, uml }), original, "page selection must not mutate source projections");
});

test("isolated class pages follow the connected relationship page", () => {
  const source = node("source", "Class", "AccountsController", { filePath: "src/controller/AccountsController.ts" });
  const target = node("target", "Class", "AccountsService", { filePath: "src/service/AccountsService.ts" });
  const sourceMethod = node("source-method", "Method", "list", { parentId: source.id });
  const targetMethod = node("target-method", "Method", "find", { parentId: target.id });
  const related = [source, target];
  const isolated = Array.from({ length: 6 }, (_, index) => node(`isolated-${index}`, "Interface", `Contract${index}`, {
    filePath: `src/contracts/contract-${index}.ts`,
  }));
  const all = [...related, sourceMethod, targetMethod, ...isolated];
  const software = projection("software-structure", all, [edge("calls", sourceMethod.id, targetMethod.id, "CALLS")]);
  const uml = projection("uml-class", all);

  const main = buildArchitectureUml(software, uml);
  const disconnected = buildArchitectureUml(software, uml, { offset: main.summary.shownNodes });
  const finalPage = buildArchitectureUml(software, uml, { offset: main.summary.shownNodes + disconnected.summary.shownNodes });

  assert.deepEqual(main.projection.nodes.filter(item => item.kind === "Class").map(item => item.id).sort(), related.map(item => item.id).sort());
  assert.equal(main.summary.shownRelations, 1);
  assert.equal(disconnected.summary.shownNodes, 4);
  assert.equal(disconnected.summary.shownRelations, 0);
  assert.equal(finalPage.summary.shownNodes, 2);
  assert.equal(finalPage.summary.omittedClassifiers, 6, "other pages remain explicitly outside this reading view");
});

test("source scopes group route classes by feature and filter only requested classifiers", () => {
  const books = node("books", "Class", "BooksPage", { filePath: "apps/web/src/app/books/page.tsx" });
  const booksController = node("books-controller", "Class", "BooksController", { filePath: "apps/web/src/app/books/controller.tsx" });
  const users = node("users", "Class", "UsersPage", { filePath: "apps/web/src/app/users/page.tsx" });
  const shared = node("shared", "Class", "SharedHeader", { filePath: "apps/web/src/components/header.tsx" });
  const software = projection("software-structure", [books, booksController, users, shared]);
  const uml = projection("uml-class", [books, booksController, users, shared]);

  const scopes = listArchitectureUmlScopes(software, uml);
  const booksScope = scopes.find(scope => scope.classifierIds.includes(books.id));
  const usersScope = scopes.find(scope => scope.classifierIds.includes(users.id));
  const sharedScope = scopes.find(scope => scope.classifierIds.includes(shared.id));
  assert.ok(booksScope);
  assert.ok(usersScope);
  assert.ok(sharedScope);
  assert.notEqual(booksScope.id, usersScope.id, "route areas stay independently readable");
  assert.equal(booksScope.label, "Apps / Web / Src / App / Books");
  assert.equal(booksScope.count, 2);
  assert.deepEqual(booksScope.filePaths, ["apps/web/src/app/books/controller.tsx", "apps/web/src/app/books/page.tsx"]);

  const focused = buildArchitectureUml(software, uml, { classifierIds: booksScope.classifierIds });
  assert.deepEqual(focused.projection.nodes.filter(item => item.kind === "Class").map(item => item.id).sort(), [books.id, booksController.id].sort());
  assert.equal(focused.summary.totalNodes, 2);
  assert.equal(focused.summary.shownNodes, 2);
  assert.equal(focused.summary.omittedClassifiers, 0);
});

test("selection, relation grouping, and escaping are deterministic under caps", () => {
  const boundary = node("boundary", "Class", "AccountPage", { filePath: "src/ui/AccountPage.ts" });
  const control = node("control", "Class", "AccountService", { filePath: "src/services/AccountService.ts" });
  const entity = node("entity", "Class", "AccountEntity", { filePath: "src/entities/AccountEntity.ts" });
  const boundaryMethod = node("boundary-method", "Method", "show", { parentId: boundary.id, signature: `show(): void; click "bad"` });
  const controlMethod = node("control-method", "Method", "save", { parentId: control.id });
  const entityProperty = node("entity-property", "Property", "value", { parentId: entity.id });
  const one = edge("one", boundaryMethod.id, controlMethod.id, "CALLS");
  const two = edge("two", controlMethod.id, entityProperty.id, "TYPE_REFERENCES");
  const unresolved = edge("three", controlMethod.id, boundaryMethod.id, "CALLS", "Unresolved");
  const nodes = [boundary, control, entity, boundaryMethod, controlMethod, entityProperty];
  const edges = [one, two, unresolved];
  const software = projection("software-structure", nodes, edges);
  const uml = projection("uml-class", nodes);
  const first = buildArchitectureUml(software, uml, { maxClassifiers: 2, maxMembersPerClassifier: 1, maxRelations: 1 });
  const second = buildArchitectureUml({ ...software, nodes: [...nodes].reverse(), edges: [...edges].reverse() },
    { ...uml, nodes: [...nodes].reverse() }, { maxClassifiers: 2, maxMembersPerClassifier: 1, maxRelations: 1 });

  assert.equal(first.projection.mermaid, second.projection.mermaid);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.dependencies.map(group => group.sourceEdgeIds), second.dependencies.map(group => group.sourceEdgeIds));
  assert.deepEqual(first.projection.nodes.filter(item => item.kind === "Class").map(item => item.id).sort(), [boundary.id, control.id].sort());
  assert.equal(first.summary.shownMembers, 2);
  assert.equal(first.summary.omittedClassifiers, 1);
  assert.equal(first.summary.omittedMembers, 1);
  assert.equal(first.summary.shownRelations, 1);
  assert.equal(first.summary.omittedUnresolved, 1);
  assert.match(first.projection.mermaid, /#59; click #34;bad#34;/);
  assert.doesNotMatch(first.projection.mermaid, /"bad"/);

  const renderedAgain = projectHumanDiagram(first.projection);
  assert.equal(renderedAgain.humanMetadata, first.projection.humanMetadata);
  assert.match(renderedAgain.mermaid, /^classDiagram\n  direction TB/m);
});

test("invalid display limits are rejected instead of silently changing the requested projection", () => {
  const emptySoftware = projection("software-structure", []);
  const emptyUml = projection("uml-class", []);
  assert.throws(() => buildArchitectureUml(emptySoftware, emptyUml, { maxRelations: -1 }), /maxRelations/);
  assert.throws(() => buildArchitectureUml(emptyUml, emptySoftware), /software-structure/);
});

test("default source-record cap omits an oversized grouped relation without trimming its evidence", () => {
  const source = node("source", "Class", "LargeService");
  const target = node("target", "Class", "LargeEntity");
  const sourceMethod = node("source-method", "Method", "send", { parentId: source.id });
  const targetMethod = node("target-method", "Method", "receive", { parentId: target.id });
  const sourceEdges = Array.from({ length: 501 }, (_, index) => edge(`edge-${String(index).padStart(3, "0")}`,
    sourceMethod.id, targetMethod.id, "CALLS"));
  const result = buildArchitectureUml(
    projection("software-structure", [source, target, sourceMethod, targetMethod], sourceEdges),
    projection("uml-class", [source, target, sourceMethod, targetMethod]),
  );

  assert.equal(result.summary.totalEdges, 501);
  assert.equal(result.summary.shownEdges, 0);
  assert.equal(result.summary.totalRelations, 1);
  assert.equal(result.summary.shownRelations, 0);
  assert.equal(result.dependencies[0]?.sourceEdges.length, 501);
  assert.equal(result.projection.edges.length, 0);
});
