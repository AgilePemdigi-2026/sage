import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { analyzeSnapshotSources } from "../apps/worker/src/source-analysis.ts";
import { canonicalizeCkg } from "@sage/contracts";
import { buildSemanticModel, semanticModelHash } from "../packages/documents/src/semantic/build.ts";
import { projectArchitectureDocument } from "../packages/documents/src/architecture-document.ts";
import { renderSemanticMarkdown, renderSemanticPdfPages } from "../packages/documents/src/semantic/render.ts";
import { renderMarkdownDocument } from "../packages/documents/src/markdown.ts";
import { renderPdfDocument } from "../packages/documents/src/pdf.ts";
import { isSemanticModel } from "../packages/documents/src/semantic/validation.ts";
import type { SnapshotFile } from "../apps/worker/src/snapshot/archive.ts";

const input = resolve(process.argv[2] ?? "");
const output = resolve(process.argv[3] ?? "artifacts/semantic/benchmark");
const spec = JSON.parse(await readFile(join(input,".snapshot.json"),"utf8"));
if (!/^[a-f0-9]{40}$/.test(spec.commit)) throw new Error("Pinned source snapshot required");
await mkdir(output,{recursive:true});
const reportPath=join(output,`${spec.repository.split("/").at(-1)}-report.json`);
try {await readFile(reportPath);throw new Error("Refuse overwrite of prior benchmark");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
const measuredStart = performance.now();
try {
const files:SnapshotFile[]=[];
async function collect(path:string){for(const item of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(item.name===".snapshot.json")continue;const full=join(path,item.name);if(item.isDirectory())await collect(full);else if(item.isFile()){const bytes=await readFile(full);files.push({relativePath:relative(input,full).replaceAll("\\","/"),bytes,byteLength:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});}}}
await collect(input);
const started=performance.now();
console.log(JSON.stringify({phase:"source-analysis",repository:spec.repository}));
const analyzed=await analyzeSnapshotSources({snapshot:{repository:spec.repository,branch:"pinned",commitSha:spec.commit},files});
if(!analyzed.ccm)throw new Error(`Analyzer failed: ${analyzed.errorCode}`);
const sources=Object.fromEntries(files.map(f=>[f.relativePath,f.bytes]));
const graph=canonicalizeCkg(analyzed.ccm,sources,"c".repeat(64));if(!graph.ok)throw new Error(graph.errorCode);
const sourceMs=performance.now()-started;
const semanticStarted=performance.now();
console.log(JSON.stringify({phase:"semantic-model",repository:spec.repository}));
const model=buildSemanticModel({ccm:analyzed.ccm,sourceCkgHash:graph.sha256,sources});
const semanticMs=performance.now()-semanticStarted;
await writeFile(join(output,`${spec.repository.split("/").at(-1)}-candidate.json`),JSON.stringify(model),{mode:0o600});
if(!isSemanticModel(model,{sourceCkgHash:graph.sha256,snapshot:analyzed.ccm.snapshot,ckgNodeIds:new Set(analyzed.ccm.nodes.map(n=>n.id)),fileHashes:new Map(analyzed.ccm.files.map(f=>[f.path,f.sha256]))}))throw new Error("Semantic model validation failed");
const replay=buildSemanticModel({ccm:analyzed.ccm,sourceCkgHash:graph.sha256,sources:Object.fromEntries(Object.entries(sources).reverse())});
if(semanticModelHash(replay)!==semanticModelHash(model))throw new Error("Semantic extraction is not deterministic");
// Every emitted evidence span must refer to the actual bytes, not just a valid-looking path.
for(const span of [...model.nodes.flatMap(n=>n.evidence),...model.edges.flatMap(e=>e.evidence),...model.features.flatMap(f=>f.evidence)]){
 const bytes=sources[span.filePath];if(!bytes||span.endByte>bytes.byteLength||span.startByte<0||span.endByte<span.startByte||createHash("sha256").update(bytes).digest("hex")!==span.fileSha256)throw new Error("Evidence byte/hash mismatch");
}
const allEvidence=[...model.nodes.flatMap(n=>n.evidence),...model.edges.flatMap(e=>e.evidence)];
const matching=spec.flows.map((flow:{name:string;evidence:string[];negative:string})=>({name:flow.name,expectedPaths:[...new Set(flow.evidence.map(x=>x.replace(/:\d+-\d+$/,"")))],coveredPaths:[...new Set(flow.evidence.map(x=>x.replace(/:\d+-\d+$/,"")).filter(path=>allEvidence.some(e=>e.filePath===path)))],negative:flow.negative}));
const json=JSON.stringify(model);
await writeFile(join(output,`${spec.repository.split("/").at(-1)}-semantic.json`),json,{flag:"wx",mode:0o600});
await writeFile(join(output,`${spec.repository.split("/").at(-1)}-ckg.json`),graph.json,{flag:"wx",mode:0o600});
let exportMetrics: Record<string, string | number | null> | null = null;
let exportFailure = false;
if (process.env.SAGE_SEMANTIC_RENDER === "1") {
 console.log(JSON.stringify({phase:"document-projection",repository:spec.repository}));
 const projected = projectArchitectureDocument(graph.json,sources,graph.sha256);
 if (!projected.ok) throw new Error(projected.errorCode);
 const overlay = {labels: Object.fromEntries(model.features.slice(0,1).map(feature => [feature.id, "Revisi label teruji"])), groups: {}};
 const presentation = {model,overlay,revision:1};
 const semanticMarkdown = renderSemanticMarkdown(presentation);
 const html = renderSemanticPdfPages(presentation,projected.value);
 if (model.features.length && (!semanticMarkdown.includes("Revisi label teruji") || !html.includes("Revisi label teruji"))) throw new Error("Export presentation mismatch");
 const markdown = `${semanticMarkdown}\n---\n\n${renderMarkdownDocument(projected.value)}`;
 const markdownBytes=Buffer.byteLength(markdown);
 exportMetrics={canonicalDocumentBytes:Buffer.byteLength(projected.json),markdownBytes,markdownStatus:markdownBytes<=32*1024*1024?"PASS":"EXPORT_TOO_LARGE",pdfStatus:"NOT_RUN",pdfBytes:null};
 if (markdownBytes<=32*1024*1024) await writeFile(join(output,`${spec.repository.split("/").at(-1)}-semantic.md`),markdown,{flag:"wx",mode:0o600});
 else exportFailure=true;
 const renderStarted=performance.now();
 console.log(JSON.stringify({phase:"pdf-render",repository:spec.repository}));
 try {
   const pdf=await renderPdfDocument(projected.value,{semantic:presentation});
   await writeFile(join(output,`${spec.repository.split("/").at(-1)}-semantic.pdf`),pdf,{flag:"wx",mode:0o600});
   exportMetrics.pdfBytes=pdf.byteLength;exportMetrics.pdfStatus="PASS";
 } catch(error) {exportFailure=true;exportMetrics.pdfStatus="FAIL";exportMetrics.pdfError=error instanceof Error?error.message:String(error);}
 exportMetrics.pdfMs=performance.now()-renderStarted;
}
let containerPeak:string|null=null;try{containerPeak=(await readFile("/sys/fs/cgroup/memory.peak","utf8")).trim();}catch{}
const coverageComplete=matching.every((flow:{expectedPaths:string[];coveredPaths:string[]})=>flow.expectedPaths.length===flow.coveredPaths.length);
const report={runtime:{node:process.version,platform:process.platform,architecture:process.arch},status:!coverageComplete ? "FAIL_SOURCE_COVERAGE" : exportFailure ? "FAIL_EXPORT" : "PASS",sourceStatus:coverageComplete?"PASS":"FAIL_SOURCE_COVERAGE",exportMetrics,scope:"Pinned source extraction, deterministic replay and byte/hash evidence validation; flow coverage below is not a human semantic correctness signoff",repository:spec.repository,commit:spec.commit,sourceFiles:files.length,sourceBytes:files.reduce((s,f)=>s+f.byteLength,0),sourceMs,semanticMs,processPeakRssBytes:process.resourceUsage().maxRSS*1024,containerPeakChargedBytes:containerPeak?Number(containerPeak):null,semanticBytes:Buffer.byteLength(json),modelHash:semanticModelHash(model),features:model.features.length,nodes:model.nodes.length,edges:model.edges.length,provenEdges:model.edges.filter(e=>e.confidence==="proven").length,indicatedEdges:model.edges.filter(e=>e.confidence==="indicated").length,limitations:model.limitations.length,flowCoverage:matching};
await writeFile(reportPath,JSON.stringify(report,null,2),{flag:"wx"});
console.log(JSON.stringify(report));
if(!coverageComplete||exportFailure)process.exitCode=1;

} catch (error) {
 const failure = {status: "FAIL", repository: spec.repository, commit: spec.commit, elapsedMs: performance.now()-measuredStart, processPeakRssBytes: process.resourceUsage().maxRSS*1024, error: error instanceof Error ? error.message : String(error)};
 await writeFile(reportPath, JSON.stringify(failure,null,2), {flag:"wx"});
 console.error(JSON.stringify(failure));
 process.exitCode=1;
}
