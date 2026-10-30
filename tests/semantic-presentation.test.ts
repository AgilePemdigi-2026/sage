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


test("semantic Markdown keeps source markup and unusual filenames inert inside linked code spans",()=>{
 const sourcePath="src/a)<img src=x>\n\n*.tsx";
 const hostile={...model,nodes:model.nodes.map(n=>({...n,label:"source\n\n<img src=x>",evidence:n.evidence.map(span=>({...span,filePath:sourcePath}))}))};
 const output=renderSemanticMarkdown({model:hostile,overlay:{labels:{},groups:{}},revision:0});
 assert.ok(output.includes("%29%3Cimg%20src%3Dx%3E%0A%0A%2A.tsx"));
 assert.ok(!output.includes("source\n\n<img"));
 assert.ok(output.includes("source\\n\\n<img"));
 assert.ok(output.includes("[` "),"linked path is an inert code span");
});

test("PDF reuses a shared endpoint flow instead of repeating its entire subtree for every UI action",()=>{
 const endpoint={...base,id:"endpoint",kind:"step" as const,label:"POST /api/action",featureId:"feature"};
 const actions=Array.from({length:8},(_,index)=>({...base,id:`action${index}`,kind:"step" as const,label:`UI action ${index}`,featureId:"feature"}));
 const chain=Array.from({length:8},(_,index)=>({...base,id:`process${index}`,kind:index===7?"outcome" as const:"component" as const,label:`Process ${index}`,featureId:"feature"}));
 const nodes=[endpoint,...actions,...chain];
 const edges=[...actions.map((action,index)=>({id:`action-edge${index}`,source:action.id,target:endpoint.id,label:"calls",confidence:"proven" as const,reason:"literal call",evidence:[evidence]})),...chain.map((node,index)=>({id:`chain-edge${index}`,source:index?chain[index-1]!.id:endpoint.id,target:node.id,label:"calls",confidence:"proven" as const,reason:"literal call",evidence:[evidence]}))];
 const shared:SemanticModel={...model,nodes,edges,features:[{...model.features[0]!,nodeIds:nodes.map(n=>n.id),entryNodeIds:[endpoint.id,...actions.map(n=>n.id)],edgeIds:edges.map(e=>e.id)}]};
 const pages=semanticFlowPages(shared,shared.features[0]!);
 assert.equal(pages.flatMap(page=>page.nodes).filter(node=>node.id===chain[7]!.id).length,1);
 assert.deepEqual(new Set(pages.flatMap(page=>page.nodes.map(n=>n.id))),new Set(nodes.map(n=>n.id)));
 assert.ok(pages.length<actions.length,"small action flows share paper without duplicating the endpoint's body");
 for(const page of pages)for(const edge of page.edges)assert.ok(edges.some(original=>original.id===edge.id));
});
