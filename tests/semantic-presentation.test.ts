import test from "node:test";
import assert from "node:assert/strict";
import { applyPresentation } from "../packages/documents/src/semantic/presentation.ts";
import { semanticRendererVersion } from "../packages/documents/src/semantic/export-pin.ts";
import { renderSemanticFlowSvg, renderSemanticMarkdown, semanticFlowPages } from "../packages/documents/src/semantic/render.ts";
import type { SemanticModel } from "../packages/documents/src/semantic/model.ts";

const evidence = {filePath:"app/api/checkin/route.ts",fileSha256:"a".repeat(64),startByte:0,endByte:1,startLine:1,endLine:1,startColumn:1,endColumn:2,role:"reference" as const};
const base = {confidence:"proven" as const,reason:"literal call",evidence:[evidence],technicalNodeIds:[]};
const model:SemanticModel={schemaVersion:"sage-semantic-v1",extractorVersion:"1.0.0",sourceCkgHash:"b".repeat(64),snapshot:{repository:"fixture/app",branch:"main",commitSha:"c".repeat(40)},frameworks:["nextjs"],limitations:[],nodes:[{...base,id:"feature",kind:"feature",label:"Checkin",featureId:"feature"},{...base,id:"other",kind:"feature",label:"Profile",featureId:"other"},{...base,id:"entry",kind:"step",label:"Submit",featureId:"feature"},{...base,id:"concept",kind:"concept",label:"Mood",featureId:"feature"}],edges:[{id:"edge",source:"entry",target:"concept",label:"creates",confidence:"proven",reason:"literal call",evidence:[evidence]}],features:[{id:"feature",label:"Checkin",nodeIds:["entry","concept"],entryNodeIds:["entry"],edgeIds:["edge"],evidence:[evidence]},{id:"other",label:"Profile",nodeIds:[],entryNodeIds:[],edgeIds:[],evidence:[evidence]}]};

test("presentation overlay changes names/groups without rewriting facts and original model",()=>{
 const before=structuredClone(model);const projected=applyPresentation(model,{labels:{feature:"Mood check-in",concept:"Feeling"},groups:{concept:"other"}});
 assert.equal(projected.features[0]!.label,"Mood check-in");assert.equal(projected.nodes.find(n=>n.id==="concept")!.featureId,"other");
 assert.deepEqual(projected.features[0]!.nodeIds,["entry"]);assert.deepEqual(projected.features[1]!.nodeIds,["concept"]);
 assert.deepEqual(projected.edges,model.edges);assert.deepEqual(model,before);
});

test("semantic export cache identity separates immutable revision and model snapshots",()=>{
 const version=semanticRendererVersion("2.3.0","a".repeat(64),0);
 assert.notEqual(version,semanticRendererVersion("2.3.0","a".repeat(64),1));
 assert.notEqual(version,semanticRendererVersion("2.3.0","b".repeat(64),0));
 assert.equal(version,semanticRendererVersion("2.3.0","a".repeat(64),0));
 assert.match(version,/^[A-Za-z0-9._-]{1,64}$/);assert.throws(()=>semanticRendererVersion("2.3.0","x",0));
});

test("semantic Markdown keeps all evidence and corrected labels while SVG draws only actual edges safely",()=>{
 const hostile={...model,nodes:model.nodes.map(n=>({...n,label:n.id==="entry"?'<script>alert("x")</script>':n.label}))};
 const markdown=renderSemanticMarkdown({model:hostile,overlay:{labels:{feature:"Mood"},groups:{}},revision:3});
 assert.ok(markdown.includes("Mood"));assert.ok(markdown.includes("#L1-L1"));assert.ok(markdown.includes("file SHA-256"));assert.ok(markdown.includes("entry"));
 const svg=renderSemanticFlowSvg(hostile.nodes,hostile.edges);
 assert.ok(!svg.includes("<script>"));assert.ok(svg.includes("&lt;script&gt;"));
 assert.equal((svg.match(/marker-end=/g)??[]).length,1);
 assert.equal((renderSemanticFlowSvg(hostile.nodes,[]).match(/marker-end=/g)??[]).length,0,"layout never creates semantic arrows");
});


test("compact PDF flow pagination keeps every member and never invents cross-page arrows",()=>{
 const nodes = Array.from({length:35},(_,index)=>({...base,id:`step${index}`,kind:"step" as const,label:`Action ${index}`,featureId:"feature"}));
 const edges = nodes.slice(1).map((node,index)=>({id:`e${index}`,source:nodes[index]!.id,target:node.id,label:"calls",confidence:"proven" as const,reason:"literal call",evidence:[evidence]}));
 const large:SemanticModel={...model,nodes:[model.nodes[0]!,...nodes],edges,features:[{...model.features[0]!,nodeIds:nodes.map(n=>n.id),entryNodeIds:[nodes[0]!.id],edgeIds:edges.map(e=>e.id)}]};
 const pages=semanticFlowPages(large,large.features[0]!);
 assert.ok(pages.length>=3);
 assert.deepEqual(new Set(pages.flatMap(page=>page.nodes.map(n=>n.id))),new Set(nodes.map(n=>n.id)));
 assert.ok(pages.every(page=>page.nodes.length<=12));
 for(const page of pages) for(const edge of page.edges) assert.ok(edges.some(original=>original.id===edge.id));
 assert.ok(pages.some(page=>page.omittedRelations>0));
});
