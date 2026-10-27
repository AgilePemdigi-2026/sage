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
