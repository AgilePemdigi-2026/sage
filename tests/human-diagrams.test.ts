import "./architecture-uml.test.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { projectHumanDiagram } from "../packages/documents/src/human-diagrams.ts";
import type { DiagramProjection } from "../packages/documents/src/diagrams.ts";
import type { CcmNode, CcmEdge } from "@sage/contracts";
const node = (id: string, kind: CcmNode["kind"], name: string, parentId: string | null = null): CcmNode => ({ id,kind,name,qualifiedName:name,parentId,origin:"source",language:"typescript",filePath:"src/model.ts",location:null,signature:null,attributes:{} });
const edge = (id: string, sourceId: string, targetId: string, resolution: CcmEdge["resolution"]): CcmEdge => ({ id,sourceId,targetId,kind:"CALLS",resolution,evidence:[],unresolvedReason:resolution === "Unresolved" ? "UNKNOWN_RECEIVER" : null });
test("human projection aggregates member dependencies without changing canonical data or merging resolution states", () => {
 const original: DiagramProjection = { kind:"software-structure", title:"Structure", mermaid:"flowchart LR", nodes:[node("node_hash_a","Class","OrderService"),node("node_hash_b","Method","place","node_hash_a"),node("node_hash_c","Function","validate")], edges:[edge("e1","node_hash_b","node_hash_c","Exact"),edge("e2","node_hash_b","node_hash_c","Exact"),edge("e3","node_hash_b","node_hash_c","Unresolved")], nodeMappings:[],edgeMappings:[],excludedNodeIds:[],excludedEdgeIds:[] };
 const before = JSON.stringify(original); const view = projectHumanDiagram(original);
 assert.equal(JSON.stringify(original), before);
 assert.doesNotMatch(view.mermaid,/node_hash/); assert.match(view.mermaid,/OrderService/);
 assert.match(view.mermaid,/calls #215;2/); assert.match(view.mermaid,/Unresolved/);
 assert.equal(view.nodeMappings.length,2);
});
test("human UML retains declared names and escapes untrusted Mermaid syntax", () => {
 const diagram: DiagramProjection = { kind:"uml-class",title:"UML",mermaid:"classDiagram",nodes:[node("node_hash","Interface",'A\";click evil')],edges:[],nodeMappings:[],edgeMappings:[],excludedNodeIds:[],excludedEdgeIds:[] };
 const view=projectHumanDiagram(diagram); assert.doesNotMatch(view.mermaid,/node_hash/);assert.match(view.mermaid,/#34;#59;click/);assert.match(view.mermaid,/<<interface>>/);
});

test("large UML member index preserves each classifier's source member order", () => {
 const classifiers = Array.from({ length: 2000 }, (_, i) => node(`class-${i}`, "Class", `Class${i}`));
 const members = classifiers.flatMap((owner, i) => [node(`method-${i}`, "Method", `method${i}`, owner.id), node(`property-${i}`, "Property", `property${i}`, owner.id)]);
 const input: DiagramProjection = { kind:"uml-class",title:"Large UML",mermaid:"classDiagram",nodes:[...classifiers,...members],edges:[],nodeMappings:[],edgeMappings:[],excludedNodeIds:[],excludedEdgeIds:[] };
 const before = JSON.stringify(input);
 const result = projectHumanDiagram(input);
 assert.equal(result.nodeMappings.length, classifiers.length);
 for (const i of [0, 999, 1999]) assert.match(result.mermaid, new RegExp(`method${i}\\(parameter tidak tersedia\\)\\n    property${i}\\n`));
 assert.equal(JSON.stringify(input), before);
});
