import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { pack } from "tar-stream";
import { canonicalizeCkg } from "@sage/contracts";
import { database, disconnectDatabase, persistAnalysisSemantic, readSemanticForUser, appendPresentationRevision, enqueueExport, claimExportJob, ExportDocumentChangedError } from "@sage/database";
import { analyzeReferences } from "@sage/analyzer-js";
import { projectArchitectureDocument } from "../packages/documents/src/architecture-document.ts";
import type { ArchitectureDocumentV1 } from "../packages/documents/src/architecture-document.ts";

import { evidenceSpan, semanticId, semanticEdgeId } from "../packages/documents/src/semantic/builder.ts";
import { buildSemanticModel, semanticModelHash } from "../packages/documents/src/semantic/build.ts";
import { semanticRendererVersion } from "../packages/documents/src/semantic/export-pin.ts";
import { renderSemanticPdfPages } from "../packages/documents/src/semantic/render.ts";
import { PDF_RENDERER_VERSION } from "../packages/documents/src/pdf-version.ts";
import { MARKDOWN_RENDERER_VERSION } from "../packages/documents/src/markdown.ts";
import { createExportWorker } from "../apps/worker/src/export-handlers.ts";
import type { CcmSnapshot } from "@sage/contracts";
import type { SemanticModel, SemanticNode, SemanticEdge } from "../packages/documents/src/semantic/model.ts";

const enabled = process.env.SAGE_SEMANTIC_EXPORT_TESTS === "1";
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const hashSnapshot = "d".repeat(40);

type Fixture = { analysisId: string; documentId: string; documentHash: string; ckgHash: string; source: Record<string, Uint8Array>; model: SemanticModel };

function assertIsolatedDatabase(): void {
  if (!enabled) throw new Error("Set SAGE_SEMANTIC_EXPORT_TESTS=1 to run the isolated export integration.");
  let parsed: URL;
  try { parsed = new URL(process.env.DATABASE_URL ?? ""); } catch { throw new Error("DATABASE_URL must point to the isolated QA service."); }
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55439" || parsed.pathname !== "/sage_semantic_export_20261030") {
    throw new Error("This integration is restricted to the isolated 127.0.0.1:55439/sage_semantic_export_20261030 database.");
  }
}

function makeModel(snapshot: CcmSnapshot, source: Record<string, Uint8Array>, ckgHash: string): SemanticModel {
  const path = "src/app/page.tsx", bytes = source[path]!;
  const span = evidenceSpan(path, bytes, 0, new TextDecoder().decode(bytes).length, "declaration");
  const evidence = [span];
  const featureId = semanticId("feature", path, 0, "semantic-export-fixture");
  const actorId = semanticId("actor", path, 0, "semantic-export-user");
  const actionId = semanticId("step", path, 0, "semantic-export-action");
  const componentId = semanticId("component", path, 0, "semantic-export-component");
  const node = (id: string, kind: SemanticNode["kind"], label: string, feature: string | null): SemanticNode => ({id,kind,label,featureId:feature,confidence:"proven",reason:"Literal fixture declaration in the pinned source bytes.",evidence,technicalNodeIds:[]});
  const nodes = [node(featureId,"feature","Semantic export fixture",null),node(actorId,"actor","Developer",null),node(actionId,"step","Run semantic analysis",featureId),node(componentId,"component","Analysis service",featureId)];
  const edge = (sourceId:string,target:string,label:string):SemanticEdge => ({id:semanticEdgeId(path,0,`${sourceId}:${target}:${label}`),source:sourceId,target,label,confidence:"proven",reason:"Literal interaction recorded in the test fixture model.",evidence});
  const edges = [edge(actorId,actionId,"starts"),edge(actionId,componentId,"calls")];
  return {schemaVersion:"sage-semantic-v1",extractorVersion:"integration-fixture-v1",sourceCkgHash:ckgHash,snapshot,frameworks:["Next.js App Router"],limitations:[],nodes,edges,features:[{id:featureId,label:"Semantic export fixture",entryNodeIds:[actorId],nodeIds:nodes.map(item=>item.id),edgeIds:edges.map(item=>item.id),evidence}]};
}

async function tarGz(source: Record<string, Uint8Array>): Promise<Buffer> {
  const tar = pack();
  const produce = async () => {
    for (const [path, bytes] of Object.entries(source).sort(([a],[b])=>a.localeCompare(b))) {
      await new Promise<void>((resolve,reject)=>tar.entry({name:`source/${path}`,size:bytes.byteLength,mode:0o600,mtime:new Date(0)},Buffer.from(bytes),error=>error?reject(error):resolve()));
    }
    tar.finalize();
  };
  const consume = async () => {const chunks:Buffer[]=[];for await(const chunk of tar)chunks.push(Buffer.from(chunk as Uint8Array));return Buffer.concat(chunks);};
  const [,bytes]=await Promise.all([produce().catch(error=>{tar.destroy(error);throw error;}),consume()]);
  return gzipSync(bytes);
}

async function seedFixture(db: ReturnType<typeof database>, root: string, repositoryId: string, label: string, semanticMode: "v1" | "v2" | "none"): Promise<Fixture> {
  const source:Record<string,Uint8Array>={
    "src/app/page.tsx":new TextEncoder().encode(semanticMode === "v2"
      ? `'use client';\nexport default function Page(){ async function submit(){ await fetch("/api/analyze", { method: "POST" }); } return <button onClick={submit}>Run semantic analysis</button>; }\n`
      : 'export default function Page(){ return <button>Run semantic analysis</button>; }\n'),
    "src/app/api/analyze/route.ts":new TextEncoder().encode('export async function POST(){ return Response.json({status:"queued"}); }\n'),
    ...(semanticMode === "v2" ? { "README.md":new TextEncoder().encode('# Semantic export fixture\n\nOperational note: this snapshot documents the analysis endpoint.\n\n[Analysis endpoint](src/app/api/analyze/route.ts)\n') } : {}),
  };
  const snapshot:CcmSnapshot={repository:`semantic-qa/${label}`,branch:"main",commitSha:hashSnapshot};
  const configurationHash=digest(`semantic export QA ${label}`);
  const analysisResult=await analyzeReferences({snapshot,sources:source});
  assert.ok(analysisResult.ccm,"fixture source should analyze");
  const canonical=canonicalizeCkg(analysisResult.ccm,source,configurationHash);
  assert.ok(canonical.ok,"fixture CKG should canonicalize");
  const projected=projectArchitectureDocument(canonical.json,source,canonical.sha256);
  assert.ok(projected.ok,"fixture ADD should project");
  const analysis=await db.analysis.create({data:{ownerUserId:ownerId,repositoryId,repositoryFullNameSnapshot:snapshot.repository,branchName:"main",commitSha:hashSnapshot,configuration:{fixture:"semantic export"},configurationHash,analyzerVersion:"semantic-export-fixture-v1",schemaVersion:"1",status:"COMPLETED_WITH_LIMITATIONS",completedAt:new Date()},select:{id:true}});
  const ccm=canonical.value.ccm;
  await db.graphBundle.create({data:{ownerUserId:ownerId,analysisId:analysis.id,schemaVersion:canonical.value.schemaVersion,configurationHash,canonicalContent:canonical.json,nodes:JSON.stringify(ccm.nodes),edges:JSON.stringify(ccm.edges),nodeCount:canonical.value.counts.nodes,edgeCount:canonical.value.counts.edges,contentHash:canonical.sha256}});
  const document=await db.architectureDocument.create({data:{ownerUserId:ownerId,analysisId:analysis.id,title:projected.value.title,documentModelVersion:projected.value.schemaVersion,canonicalContent:projected.json,interfaceCatalog:JSON.stringify(projected.value.interfaceCatalog),softwareEngineeringDiagram:JSON.stringify(projected.value.softwareEngineeringDiagram),umlClassDiagram:JSON.stringify(projected.value.umlClassDiagram),contentHash:projected.sha256},select:{id:true}});
  const bytes=await tarGz(source);const folder=await mkdtemp(join(root,"snapshot-"));const storageKey=`${basename(folder)}/archive.tar.gz`;await writeFile(join(folder,"archive.tar.gz"),bytes,{flag:"wx",mode:0o600});
  await db.storageObject.create({data:{ownerUserId:ownerId,analysisId:analysis.id,type:"SOURCE_ARCHIVE",storageKey,sha256:digest(bytes),byteLength:BigInt(bytes.byteLength)}});
  const model=semanticMode === "v2"
    ? buildSemanticModel({ccm,sourceCkgHash:canonical.sha256,sources:source,documentationSources:source,snapshotPaths:Object.keys(source)})
    : makeModel(snapshot,source,canonical.sha256);
  if(semanticMode !== "none") await db.$transaction(tx=>persistAnalysisSemantic(tx,{ownerUserId:ownerId,analysisId:analysis.id,sourceCkgHash:canonical.sha256,ccm,model}));
  return {analysisId:analysis.id,documentId:document.id,documentHash:projected.sha256,ckgHash:canonical.sha256,source,model};
}

let ownerId="";

test("production export worker renders immutable semantic revisions consistently in Markdown/PDF and keeps legacy exports",{skip:!enabled},async()=>{
  assertIsolatedDatabase();
  const db=database();
  const root=await mkdtemp(join(tmpdir(),"sage-semantic-export-"));
  const users:string[]=[];const analysisIds:string[]=[];let repositoryId="";
  try {
    const user=await db.user.create({data:{githubUserId:`semantic-export-${randomUUID()}`,login:`semantic-export-${randomUUID()}`},select:{id:true}});ownerId=user.id;users.push(ownerId);
    const other=await db.user.create({data:{githubUserId:`semantic-export-other-${randomUUID()}`,login:`semantic-export-other-${randomUUID()}`},select:{id:true}});users.push(other.id);
    const repository=await db.repository.create({data:{githubRepositoryId:`semantic-export-${randomUUID()}`,ownerLogin:"semantic-qa",name:"export-fixture",fullName:`semantic-qa/export-${randomUUID()}`,visibility:"PRIVATE"},select:{id:true}});repositoryId=repository.id;
    const semantic=await seedFixture(db,root,repositoryId,"semantic","v1");analysisIds.push(semantic.analysisId);
    assert.equal(await readSemanticForUser(db,users[1]!,semantic.analysisId),null,"semantic model must remain owner scoped");
    const initial=await readSemanticForUser(db,ownerId,semantic.analysisId);assert.ok(initial);assert.equal(initial.revision,0);
    assert.equal(initial.model.schemaVersion,"sage-semantic-v1","previously stored v1 semantic models remain readable");
    await mkdir(process.env.SAGE_SEMANTIC_EXPORT_ARTIFACT_DIR ?? root,{recursive:true,mode:0o700});
    const basePdf=semanticRendererVersion(PDF_RENDERER_VERSION,initial.modelHash,0);
    const baseMd=semanticRendererVersion(MARKDOWN_RENDERER_VERSION,initial.modelHash,0);
    const enqueued0=await enqueueExport(db,{ownerUserId:ownerId,analysisId:semantic.analysisId,format:"MARKDOWN",documentHash:semantic.documentHash,rendererVersion:baseMd,semanticModelHash:initial.modelHash,presentationRevision:0});assert.equal(enqueued0.created,true);
    await appendPresentationRevision(db,{ownerUserId:ownerId,analysisId:semantic.analysisId,expectedRevision:0,overlay:{labels:{[semantic.model.features[0]!.id]:"Corrected flow title",[semantic.model.nodes.find(item=>item.kind==="component")!.id]:"Corrected analysis service"},groups:{[semantic.model.nodes.find(item=>item.kind==="component")!.id]:semantic.model.features[0]!.id}}});
    assert.equal((await readSemanticForUser(db,ownerId,semantic.analysisId,0))?.overlay.labels[semantic.model.features[0]!.id],undefined,"revision zero is immutable after correction");
    await assert.rejects(enqueueExport(db,{ownerUserId:ownerId,analysisId:semantic.analysisId,format:"PDF",documentHash:semantic.documentHash,rendererVersion:basePdf,semanticModelHash:initial.modelHash,presentationRevision:0}),ExportDocumentChangedError,"stale export pins must conflict");
    const worker=createExportWorker({db,storageRoot:root});
    async function processOne(expectedExportId:string) {const claim=await claimExportJob(db,{leaseDurationMs:120_000});assert.ok(claim,"queued test export should be claimable");assert.equal(claim.exportId,expectedExportId);await worker.process(claim);const row=await db.export.findUniqueOrThrow({where:{id:expectedExportId},include:{storageObject:true}});assert.equal(row.status,"READY",`worker export failed: ${row.errorCode??"unknown"}`);assert.ok(row.storageObject);const path=join(root,...row.storageObject.storageKey.split("/"));return {row,bytes:await readFile(path),path};}
    const old=await processOne(enqueued0.export.id);assert.match(old.bytes.toString("utf8"),/Semantic export fixture/);assert.doesNotMatch(old.bytes.toString("utf8"),/Corrected flow title|Corrected analysis service/);
    for(const format of ["MARKDOWN","PDF"] as const) {
      const current=await readSemanticForUser(db,ownerId,semantic.analysisId);assert.ok(current);assert.equal(current.revision,1);
      const version=semanticRendererVersion(format==="PDF"?PDF_RENDERER_VERSION:MARKDOWN_RENDERER_VERSION,current.modelHash,current.revision);
      const queued=await enqueueExport(db,{ownerUserId:ownerId,analysisId:semantic.analysisId,format,documentHash:semantic.documentHash,rendererVersion:version,semanticModelHash:current.modelHash,presentationRevision:current.revision});assert.equal(queued.created,true);
      const rendered=await processOne(queued.export.id);
      if(format==="MARKDOWN") {const text=rendered.bytes.toString("utf8");assert.match(text,/Corrected flow title/,"Markdown must use the corrected feature label");assert.match(text,/Corrected analysis service/,"Markdown must use the corrected component label");assert.match(text,/src\/app\/page\.tsx/ ,"Markdown should include source path evidence");}
      assert.equal(rendered.row.semanticModelHash,current.modelHash);assert.equal(rendered.row.presentationRevision,1);
      if(format==="PDF") {assert.equal(rendered.bytes.subarray(0,5).toString("ascii"),"%PDF-");assert.ok(rendered.bytes.byteLength>10_000,"PDF should include the vector report pages");await writeFile(join(process.env.SAGE_SEMANTIC_EXPORT_ARTIFACT_DIR ?? root,"semantic-revision-1.pdf"),rendered.bytes,{mode:0o600});}
      else await writeFile(join(process.env.SAGE_SEMANTIC_EXPORT_ARTIFACT_DIR ?? root,"semantic-revision-1.md"),rendered.bytes,{mode:0o600});
    }

    const explainable=await seedFixture(db,root,repositoryId,"explainable","v2");analysisIds.push(explainable.analysisId);
    const v2Initial=await readSemanticForUser(db,ownerId,explainable.analysisId);assert.ok(v2Initial);
    assert.equal(v2Initial.model.schemaVersion,"sage-semantic-v2");
    assert.equal(v2Initial.modelHash,semanticModelHash(explainable.model),"the stored model hash covers the full v2 payload");
    assert.equal(await readSemanticForUser(db,users[1]!,explainable.analysisId),null,"v2 exports remain owner scoped");
    assert.ok(v2Initial.model.edges.length>0 && v2Initial.model.edges.every(edge=>!!edge.explanation),"v2 exports retain structured explanations on each source-derived relationship");
    const codeRelationship=v2Initial.model.edges.find(edge=>edge.explanation?.origin==="code" && edge.evidence.some(span=>span.filePath==="src/app/page.tsx"));
    assert.ok(codeRelationship,"fixture relationship must be grounded in the page's explicit fetch call");
    const readme=v2Initial.model.documentation?.documents.find(doc=>doc.filePath==="README.md");assert.ok(readme);
    assert.equal(readme.fileSha256,digest(explainable.source["README.md"]!),"README provenance is tied to snapshot bytes");
    const docReference=v2Initial.model.documentation?.references.find(reference=>reference.sourcePath==="README.md");assert.ok(docReference);
    assert.equal(docReference.targetPath,"src/app/api/analyze/route.ts");
    assert.equal(docReference.evidence.fileSha256,readme.fileSha256);

    const v2BaseMd=semanticRendererVersion(MARKDOWN_RENDERER_VERSION,v2Initial.modelHash,0);
    const v2Queued0=await enqueueExport(db,{ownerUserId:ownerId,analysisId:explainable.analysisId,format:"MARKDOWN",documentHash:explainable.documentHash,rendererVersion:v2BaseMd,semanticModelHash:v2Initial.modelHash,presentationRevision:0});assert.equal(v2Queued0.created,true);
    const duplicateV2=await enqueueExport(db,{ownerUserId:ownerId,analysisId:explainable.analysisId,format:"MARKDOWN",documentHash:explainable.documentHash,rendererVersion:v2BaseMd,semanticModelHash:v2Initial.modelHash,presentationRevision:0});assert.equal(duplicateV2.created,false,"the same pinned v2 export reuses its cache row");assert.equal(duplicateV2.export.id,v2Queued0.export.id);
    const v2Feature=explainable.model.nodes.find(node=>node.kind==="feature");assert.ok(v2Feature);
    const v2CorrectedLabel="Corrected documented analysis flow";
    await appendPresentationRevision(db,{ownerUserId:ownerId,analysisId:explainable.analysisId,expectedRevision:0,overlay:{labels:{[v2Feature.id]:v2CorrectedLabel},groups:{}}});
    assert.equal((await readSemanticForUser(db,ownerId,explainable.analysisId,0))?.overlay.labels[v2Feature.id],undefined,"the revision-zero v2 pin is immutable after correction");
    await assert.rejects(enqueueExport(db,{ownerUserId:ownerId,analysisId:explainable.analysisId,format:"PDF",documentHash:explainable.documentHash,rendererVersion:semanticRendererVersion(PDF_RENDERER_VERSION,v2Initial.modelHash,0),semanticModelHash:v2Initial.modelHash,presentationRevision:0}),ExportDocumentChangedError,"outdated v2 renderer/model/revision pins must conflict");

    const oldV2=await processOne(v2Queued0.export.id);const oldV2Markdown=oldV2.bytes.toString("utf8");
    await writeFile(join(process.env.SAGE_SEMANTIC_EXPORT_ARTIFACT_DIR ?? root,"semantic-v2-revision-0.md"),oldV2.bytes,{mode:0o600});
    assert.equal(oldV2.row.semanticModelHash,v2Initial.modelHash);assert.equal(oldV2.row.presentationRevision,0);
    assert.ok(oldV2Markdown.includes(codeRelationship.explanation!.summary),"pinned Markdown includes the structured relationship explanation");
    assert.ok(oldV2Markdown.includes("Operational note: this snapshot documents the analysis endpoint."));
    assert.ok(oldV2Markdown.includes("mendokumentasikan/merujuk") && oldV2Markdown.includes("` resolved `"));
    assert.ok(oldV2Markdown.includes("README.md") && oldV2Markdown.includes("src/app/api/analyze/route.ts"));
    assert.ok(oldV2Markdown.includes(readme.fileSha256),"Markdown includes the snapshot-bound documentation hash");
    assert.ok(!oldV2Markdown.includes(v2CorrectedLabel),"a revision-zero export remains unchanged after a later correction");
    for(const format of ["MARKDOWN","PDF"] as const) {
      const current=await readSemanticForUser(db,ownerId,explainable.analysisId);assert.ok(current);assert.equal(current.revision,1);
      const base=format==="PDF"?PDF_RENDERER_VERSION:MARKDOWN_RENDERER_VERSION;
      const version=semanticRendererVersion(base,current.modelHash,current.revision);
      const queued=await enqueueExport(db,{ownerUserId:ownerId,analysisId:explainable.analysisId,format,documentHash:explainable.documentHash,rendererVersion:version,semanticModelHash:current.modelHash,presentationRevision:current.revision});assert.equal(queued.created,true);
      const row=await db.export.findUniqueOrThrow({where:{id:queued.export.id}});
      assert.equal(row.semanticModelHash,v2Initial.modelHash);assert.equal(row.presentationRevision,1);
      assert.notEqual(row.rendererVersion,semanticRendererVersion(base,v2Initial.modelHash,0),"presentation revision creates a distinct v2 cache identity");
      const rendered=await processOne(queued.export.id);
      if(format==="MARKDOWN") {
        const markdown=rendered.bytes.toString("utf8");
        assert.ok(markdown.includes(v2CorrectedLabel));assert.ok(markdown.includes(codeRelationship.explanation!.summary));
        assert.ok(markdown.includes("Operational note: this snapshot documents the analysis endpoint."));
        assert.ok(markdown.includes("mendokumentasikan/merujuk") && markdown.includes("` resolved `"));
        assert.ok(markdown.includes("README.md") && markdown.includes("src/app/api/analyze/route.ts"));
        assert.ok(markdown.includes(readme.fileSha256));
        await writeFile(join(process.env.SAGE_SEMANTIC_EXPORT_ARTIFACT_DIR ?? root,"semantic-v2-revision-1.md"),rendered.bytes,{mode:0o600});
      } else {
        assert.equal(rendered.bytes.subarray(0,5).toString("ascii"),"%PDF-");assert.ok(rendered.bytes.byteLength>10_000);
        const html=renderSemanticPdfPages({model:current.model,overlay:current.overlay,revision:current.revision},{snapshot:current.model.snapshot} as ArchitectureDocumentV1);
        assert.ok(html.includes(codeRelationship.explanation!.summary),"the PDF renderer includes the same structured explanation as Markdown");
        assert.ok(html.includes("Operational note: this snapshot documents the analysis endpoint."));
        assert.ok(html.includes("README.md") && html.includes("src/app/api/analyze/route.ts"));
        assert.ok(html.includes(readme.fileSha256),"the PDF renderer includes the documentation evidence hash");
        await writeFile(join(process.env.SAGE_SEMANTIC_EXPORT_ARTIFACT_DIR ?? root,"semantic-v2-revision-1.pdf"),rendered.bytes,{mode:0o600});
      }
    }

    const legacy=await seedFixture(db,root,repositoryId,"legacy","none");analysisIds.push(legacy.analysisId);
    const oldExport=await enqueueExport(db,{ownerUserId:ownerId,analysisId:legacy.analysisId,format:"MARKDOWN",documentHash:legacy.documentHash,rendererVersion:MARKDOWN_RENDERER_VERSION});assert.equal(oldExport.created,true);
    const legacyRendered=await processOne(oldExport.export.id);const legacyText=legacyRendered.bytes.toString("utf8");assert.doesNotMatch(legacyText,/^# Fitur, user flow, dan knowledge graph/m);assert.match(legacyText,/Architecture Definition Document/);
  } finally {
    await db.workerSlot.updateMany({where:{slotKey:"export",ownerUserId:ownerId},data:{jobId:null,ownerUserId:null,leaseUntil:null,heartbeatAt:null,leaseTokenHash:null}}).catch(()=>undefined);
    for(const id of analysisIds){const outputs=await db.storageObject.findMany({where:{analysisId:id,type:"EXPORT"},select:{storageKey:true}}).catch(()=>[]);for(const output of outputs){const parts=output.storageKey.split("/");if(parts[0]?.startsWith("export-"))await rm(join(root,...parts),{force:true}).catch(()=>undefined);}await db.job.deleteMany({where:{analysisId:id,ownerUserId:ownerId}}).catch(()=>undefined);await db.export.deleteMany({where:{analysisId:id,ownerUserId:ownerId}}).catch(()=>undefined);await db.storageObject.deleteMany({where:{analysisId:id,ownerUserId:ownerId}}).catch(()=>undefined);await db.presentationRevision.deleteMany({where:{analysisId:id,ownerUserId:ownerId}}).catch(()=>undefined);await db.semanticModel.deleteMany({where:{analysisId:id,ownerUserId:ownerId}}).catch(()=>undefined);await db.architectureDocument.deleteMany({where:{analysisId:id,ownerUserId:ownerId}}).catch(()=>undefined);await db.graphBundle.deleteMany({where:{analysisId:id,ownerUserId:ownerId}}).catch(()=>undefined);await db.analysis.deleteMany({where:{id,ownerUserId:ownerId}}).catch(()=>undefined);}
    if(ownerId)await db.user.deleteMany({where:{id:ownerId}}).catch(()=>undefined);if(users[1])await db.user.deleteMany({where:{id:users[1]}}).catch(()=>undefined);if(repositoryId)await db.repository.deleteMany({where:{id:repositoryId}}).catch(()=>undefined);
    await rm(root,{recursive:true,force:true}).catch(()=>undefined);await disconnectDatabase();
  }
});
