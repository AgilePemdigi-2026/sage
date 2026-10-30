import { Given, When, Then, setDefaultTimeout } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { analyzeReferences as analyzeJs } from "@sage/analyzer-js";
import { analyzeReferences as analyzePhp } from "@sage/analyzer-php";
import { buildSemanticModel } from "../../../packages/documents/src/semantic/build.ts";
import { applyPresentation } from "../../../packages/documents/src/semantic/presentation.ts";
import { semanticRendererVersion } from "../../../packages/documents/src/semantic/export-pin.ts";
import type { SemanticInput, SemanticModel } from "../../../packages/documents/src/semantic/model.ts";
interface State { input: SemanticInput; model: SemanticModel; before: string; projected: SemanticModel; fixture: string }
setDefaultTimeout(15_000);
Given("the semantic source fixture {string}", async function(this:State,name:string){
 this.fixture=name;
 const raw=name==="nextjs"?{
  "app/checkin/page.tsx":`export default function Page(){ async function submit(){ await fetch('/api/checkin',{method:'POST'}); } return <button onClick={submit}>Record mood</button>; }`,
  "app/api/checkin/route.ts":`export async function POST(request: Request){ if(!request.headers.get('authorization')) return Response.json({error:'Denied'},{status:401}); return Response.json({saved:true}); }`,
  "src/lib/tiny-helper.ts":"export const tinyHelper=()=>1;",
 }:{
  "routes/api.php":`<?php use Illuminate\\Support\\Facades\\Route; Route::middleware('auth:sanctum')->group(function(){Route::post('/checkin',[CheckinController::class,'store']);});`,
  "app/Http/Controllers/CheckinController.php":`<?php class CheckinController {public function store($request){$request->validate(['mood'=>'required']);if($request->mood===null){return response()->json(['error'=>'Missing'],422);}return response()->json(['saved'=>true],201);}}`,
 };
 const sources=Object.fromEntries(Object.entries(raw).map(([p,s])=>[p,new TextEncoder().encode(s)]));
 const snapshot={repository:"fixture/semantic",branch:"main",commitSha:"a".repeat(40)};
 const result=name==="nextjs"?analyzeJs({sources,snapshot}):await analyzePhp({sources,snapshot});
 assert.ok(result.ccm);this.input={sources,ccm:result.ccm,sourceCkgHash:"b".repeat(64)};
});
When("I extract the semantic model",function(this:State){this.model=buildSemanticModel(this.input);this.before=JSON.stringify(this.model);});
Then("the model contains the feature {string}",function(this:State,label:string){assert.ok(this.model.features.some(f=>f.label===label));});
Then("the model contains a {string} node",function(this:State,kind:string){assert.ok(this.model.nodes.some(n=>n.kind===kind));});
Then("every relationship references existing nodes and source evidence",function(this:State){const ids=new Set(this.model.nodes.map(n=>n.id));for(const edge of this.model.edges){assert.ok(ids.has(edge.source)&&ids.has(edge.target));assert.ok(edge.evidence.length>0);for(const span of edge.evidence)assert.ok(this.input.sources[span.filePath]);}});
Then("a helper file is not a main knowledge graph node",function(this:State){assert.ok(!this.model.nodes.some(n=>n.evidence.some(e=>e.filePath.includes('tiny-helper'))));});
Then("no frontend screen is invented for the backend fixture",function(this:State){assert.ok(!this.model.nodes.some(n=>/halaman|screen|browser|frontend/i.test(n.label)));});
When("I rename the first feature to {string}",function(this:State,label:string){const feature=this.model.features[0];assert.ok(feature);this.projected=applyPresentation(this.model,{labels:{[feature.id]:label},groups:{}});});
Then("the projected feature is named {string}",function(this:State,label:string){assert.equal(this.projected.features[0]!.label,label);});
Then("the source evidence and relationships remain unchanged",function(this:State){assert.equal(JSON.stringify(this.model),this.before);assert.deepEqual(this.projected.edges,this.model.edges);});
Then("the export cache separates revision {string} from revision {string}",function(this:State,a:string,b:string){assert.notEqual(semanticRendererVersion('2.3.0','a'.repeat(64),Number(a)),semanticRendererVersion('2.3.0','a'.repeat(64),Number(b)));});
