import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { CcmV1, CcmEdge } from "@sage/contracts";
import { buildSemanticModel, semanticModelHash } from "../packages/documents/src/semantic/build.ts";
import { relationshipExplanation, explainCkgEdge } from "../packages/documents/src/semantic/explanations.ts";
import { isSemanticModel } from "../packages/documents/src/semantic/validation.ts";
import { canonicalSemanticContent, SemanticModelIntegrityError } from "../packages/database/src/semantic.ts";
import { semanticRendererVersion } from "../packages/documents/src/semantic/export-pin.ts";
import { renderSemanticMarkdown, renderSemanticPdfPages } from "../packages/documents/src/semantic/render.ts";
import type { ArchitectureDocumentV1 } from "../packages/documents/src/architecture-document.ts";

function fixture(readme = '# App\n\nA documented integration with Redis.\n\n[Handler](app/api/books/route.ts)\n') {
  const sources = Object.fromEntries(Object.entries({
    'app/api/books/route.ts': 'export async function GET() { return Response.json({ok:true}); }',
    'README.md': readme,
  }).map(([path,text]) => [path,new TextEncoder().encode(text)]));
  const ccm: CcmV1 = { schemaVersion:1,snapshot:{repository:'fixture/app',branch:'main',commitSha:'a'.repeat(40)},
    provenance:{analyzer:{name:'fixture',version:'1'},resolver:{name:'fixture',version:'1'},configHash:'b'.repeat(64)},
    files:Object.entries(sources).map(([path,bytes]) => ({path,language:path.endsWith('.ts')?'typescript':null,sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,status:path.endsWith('.ts')?'processed':'excluded'})),
    nodes:[],edges:[],limitations:[] };
  const model = buildSemanticModel({ccm,sourceCkgHash:'c'.repeat(64),sources,documentationSources:sources,snapshotPaths:Object.keys(sources)});
  return {sources,ccm,model,hashes:new Map(ccm.files.map(f=>[f.path,f.sha256]))};
}

test('v2 separates documented references from code facts and gives every emitted relationship provenance', () => {
  const {model,ccm,hashes} = fixture();
  assert.equal(model.schemaVersion,'sage-semantic-v2');
  assert.ok(model.edges.length);
  assert.ok(model.edges.every(edge => relationshipExplanation(edge)?.origin === 'code'));
  assert.ok(model.edges.every(edge => edge.explanation!.rule.startsWith('next:')));
  assert.equal(model.nodes.some(node => /redis/i.test(node.label)),false,'README prose does not invent an integration');
  assert.equal(model.documentation!.documents.length,1);
  assert.equal(model.documentation!.references[0]!.targetPath,'app/api/books/route.ts');
  assert.equal(isSemanticModel(model,{fileHashes:hashes,ckgNodeIds:new Set(),snapshot:ccm.snapshot}),true);
  assert.doesNotThrow(()=>canonicalSemanticContent(model,model.sourceCkgHash,new Set(),hashes,ccm.snapshot));
  const bad=structuredClone(model);bad.documentation!.documents[0]!.fileSha256='f'.repeat(64);
  assert.throws(()=>canonicalSemanticContent(bad,model.sourceCkgHash,new Set(),hashes),SemanticModelIntegrityError);
  assert.equal(isSemanticModel({...model,edges:model.edges.map(edge=>({...edge,explanation:undefined}))}),false);
  const dangling=structuredClone(model);dangling.edges[0]!.explanation!.sourceEdgeIds=['missing-edge'];
  assert.equal(isSemanticModel(dangling),false);
  let invoked=false;
  const hostileOrigin={...model,edges:model.edges.map(edge=>({...edge,explanation:{...edge.explanation,origin:{toString(){invoked=true;return 'code';}}}}))};
  assert.equal(isSemanticModel(hostileOrigin),false);
  assert.equal(invoked,false,'provenance validation must not coerce executable object values');
});

test('documentation changes model/cache identity but never creates calls or rewrites code relationships', () => {
  const first=fixture(); const other=fixture('# App\n\nUses an undocumented queue.\n');
  assert.deepEqual(first.model.nodes,other.model.nodes);
  assert.deepEqual(first.model.edges,other.model.edges);
  assert.notEqual(semanticModelHash(first.model),semanticModelHash(other.model));
  assert.notEqual(semanticRendererVersion('1.0.0',semanticModelHash(first.model),0),semanticRendererVersion('1.0.0',semanticModelHash(other.model),0));
  const replay=buildSemanticModel({ccm:first.ccm,sourceCkgHash:first.model.sourceCkgHash,sources:Object.fromEntries(Object.entries(first.sources).reverse()),documentationSources:Object.fromEntries(Object.entries(first.sources).reverse()),snapshotPaths:Object.keys(first.sources).reverse()});
  assert.deepEqual(replay,first.model);
});

test('legacy models stay readable without backfilled provenance and keep old Markdown content', () => {
  const {model}=fixture();
  const legacy=structuredClone(model);
  delete legacy.documentation;
  legacy.schemaVersion='sage-semantic-v1';
  for (const edge of legacy.edges) delete edge.explanation;
  assert.equal(isSemanticModel(legacy),true);
  assert.equal(relationshipExplanation(legacy.edges[0]!),null);
  assert.ok(!renderSemanticMarkdown({model:legacy,overlay:{labels:{},groups:{}},revision:0}).includes('Konteks dokumentasi'));
});

test('default documentation inventory includes separate sources and unavailable manifest documents', () => {
  const {ccm,sources,model}=fixture();
  const codeSources={'app/api/books/route.ts':sources['app/api/books/route.ts']!};
  const separate=buildSemanticModel({ccm:{...ccm,files:ccm.files.filter(file=>file.path!=='README.md')},sourceCkgHash:model.sourceCkgHash,sources:codeSources,documentationSources:{'README.md':sources['README.md']!}});
  assert.equal(separate.documentation!.documents.length,1);
  assert.equal(separate.documentation!.coverage.candidateFileCount,1);
  const unavailable=buildSemanticModel({ccm,sourceCkgHash:model.sourceCkgHash,sources:codeSources});
  assert.equal(unavailable.documentation!.coverage.candidateFileCount,1);
  assert.deepEqual(unavailable.documentation!.coverage.skipped,[{filePath:'README.md',reason:'source-unavailable'}]);
});

test('CKG explanations distinguish imports, calls, types and unresolved dispatch without runtime certainty', () => {
  const base={id:'e1',sourceId:'a',targetId:'b',evidence:[],resolution:'Exact' as const,unresolvedReason:null};
  const imported=explainCkgEdge({...base,kind:'IMPORTS'} as CcmEdge);
  const called=explainCkgEdge({...base,kind:'CALLS'} as CcmEdge);
  assert.notEqual(imported.summary,called.summary);
  assert.match(imported.summary,/tidak membuktikan fungsi dipanggil/);
  assert.match(called.limitations.join(' '),/bukan jaminan/);
  assert.equal(explainCkgEdge({...base,kind:'TYPE_REFERENCES'} as CcmEdge).kind,'type_reference');
  assert.match(explainCkgEdge({...base,kind:'CALLS',resolution:'Unresolved',unresolvedReason:'UNKNOWN_RECEIVER'} as CcmEdge).limitations.join(' '),/UNKNOWN_RECEIVER/);
});

test('real JS resolution links a called writer across files without promoting an unused import', async () => {
  const {analyzeReferences}=await import('../packages/analyzer-js/src/index.ts');
  const {canonicalizeCkg}=await import('../packages/contracts/src/ckg.ts');
  const sources=Object.fromEntries(Object.entries({
    'src/app/api/books/route.ts': `import { writeBook } from '../../../lib/books';\nimport { writeAudit } from '../../../lib/audit';\nexport async function POST(){ await writeBook(); return Response.json({ok:true}); }\n`,
    'src/lib/books.ts': 'export async function writeBook(){ await db.book.create({}); }\n',
    'src/lib/audit.ts': 'export async function writeAudit(){ await db.audit.create({}); }\n',
    'README.md': '# Books\n\n[Writer](src/lib/books.ts)\n',
  }).map(([path,value])=>[path,new TextEncoder().encode(value)]));
  const result=analyzeReferences({sources,snapshot:{repository:'fixture/real-resolution',branch:'main',commitSha:'a'.repeat(40)}});
  assert.ok(result.ccm);
  const graph=canonicalizeCkg(result.ccm,sources,'b'.repeat(64));assert.ok(graph.ok);
  const model=buildSemanticModel({ccm:graph.value.ccm,sourceCkgHash:graph.sha256,sources,documentationSources:sources,snapshotPaths:Object.keys(sources)});
  const writer=model.nodes.find(node=>node.kind==='component' && /write.?book/i.test(node.label));
  const store=model.nodes.find(node=>node.kind==='store' && node.label==='Book');
  assert.ok(writer && store,'an actual resolver-produced call must expand into the writing function and its store');
  assert.ok(model.edges.some(edge=>edge.source===writer.id && edge.target===store.id && edge.explanation?.kind==='write'));
  assert.equal(model.nodes.some(node=>node.kind==='store' && node.label==='Audit'),false,'an imported but uncalled writer has no effect in this flow');
  assert.ok(isSemanticModel(model,{fileHashes:new Map(graph.value.ccm.files.map(file=>[file.path,file.sha256])),ckgNodeIds:new Set(graph.value.ccm.nodes.map(node=>node.id))}));
});

test('v2 Markdown keeps full details while PDF uses a compact safe summary', () => {
  const {model}=fixture('# App\n\n<script>alert(1)</script>\n\nDocumented only. [Missing](gone.ts)\n');
  const input={model,overlay:{labels:{},groups:{}},revision:0};
  const markdown=renderSemanticMarkdown(input);
  assert.match(markdown,/Konteks dokumentasi/);
  assert.match(markdown,/Mengapa terhubung/);
  assert.match(markdown,/Documented only/);
  const html=renderSemanticPdfPages(input,{snapshot:model.snapshot} as ArchitectureDocumentV1);
  assert.match(html,/Analysis notes/);
  assert.match(html,/full documentation text.*Markdown export/u);
  assert.doesNotMatch(html,/Mengapa terhubung|Documented only/);
  assert.ok(!html.includes('<script>'));
});
