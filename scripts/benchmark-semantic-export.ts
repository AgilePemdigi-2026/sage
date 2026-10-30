import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { projectArchitectureDocument } from "../packages/documents/src/architecture-document.ts";
import { renderMarkdownDocument } from "../packages/documents/src/markdown.ts";
import { renderPdfDocument } from "../packages/documents/src/pdf.ts";
import { renderSemanticMarkdown } from "../packages/documents/src/semantic/render.ts";
import { createHash } from "node:crypto";
import type { SemanticModel } from "../packages/documents/src/semantic/model.ts";

// A fresh process mirrors export-worker isolation: no retained analyzer AST, replay model or CCM.
const [input, output] = process.argv.slice(2) as [string, string];
const spec = JSON.parse(await readFile(join(input, ".snapshot.json"), "utf8"));
const slug = spec.repository.split("/").at(-1);
const reportPath = join(output, `${slug}-report.json`);
const report = JSON.parse(await readFile(reportPath, "utf8"));
const sources: Record<string, Uint8Array> = {};
async function collect(path: string): Promise<void> {
  for (const item of await readdir(path, {withFileTypes:true})) {
    if (item.name === ".snapshot.json") continue;
    const full=join(path,item.name);
    if(item.isDirectory()) await collect(full);
    else if(item.isFile()) sources[relative(input,full).replaceAll("\\","/")]=await readFile(full);
  }
}
await collect(input);
const started=performance.now();
let failed=false;
try {
  const model=JSON.parse(await readFile(join(output,`${slug}-semantic.json`),"utf8")) as SemanticModel;
  if(createHash("sha256").update(JSON.stringify(model),"utf8").digest("hex")!==report.modelHash || model.snapshot.commitSha!==spec.commit || model.snapshot.repository!==spec.repository) throw new Error("Pinned semantic model differs from source measurement");
  const graphJson=await readFile(join(output,`${slug}-ckg.json`),"utf8");
  console.log(JSON.stringify({phase:"document-projection",repository:spec.repository}));
  const document=projectArchitectureDocument(graphJson,sources,model.sourceCkgHash);
  if(!document.ok) throw new Error(document.errorCode);
  const presentation={model,overlay:{labels:Object.fromEntries(model.features.slice(0,1).map(f=>[f.id,"Revisi label teruji"])),groups:{}},revision:1};
  console.log(JSON.stringify({phase:"markdown-render",repository:spec.repository}));
  const markdown=`${renderSemanticMarkdown(presentation)}\n---\n\n${renderMarkdownDocument(document.value)}`;
  const markdownBytes=Buffer.byteLength(markdown);
  const metrics:Record<string,string|number|null>={canonicalDocumentBytes:Buffer.byteLength(document.json),markdownBytes,markdownStatus:markdownBytes<=32*1024*1024?"PASS":"EXPORT_TOO_LARGE",pdfStatus:"NOT_RUN",pdfBytes:null};
  if(markdownBytes<=32*1024*1024) await writeFile(join(output,`${slug}-semantic.md`),markdown,{flag:"wx",mode:0o600});
  else failed=true;
  console.log(JSON.stringify({phase:"pdf-render",repository:spec.repository}));
  const pdfStarted=performance.now();
  try {
    const pdf=await renderPdfDocument(document.value,{semantic:presentation});
    await writeFile(join(output,`${slug}-semantic.pdf`),pdf,{flag:"wx",mode:0o600});
    metrics.pdfBytes=pdf.byteLength;metrics.pdfStatus="PASS";
  } catch(error) { failed=true;metrics.pdfStatus="FAIL";metrics.pdfError=error instanceof Error?error.message:String(error); }
  metrics.pdfMs=performance.now()-pdfStarted;
  report.exportMetrics=metrics;
} catch(error) {failed=true;report.exportError=error instanceof Error?error.message:String(error);}
let peak:null|number=null;try{peak=Number((await readFile("/sys/fs/cgroup/memory.peak","utf8")).trim());}catch{}
report.exportProcess={runtime:{node:process.version,platform:process.platform,architecture:process.arch},elapsedMs:performance.now()-started,processPeakRssBytes:process.resourceUsage().maxRSS*1024,containerPeakChargedBytes:peak};
report.status=report.sourceStatus!=="PASS"?report.sourceStatus:failed?"FAIL_EXPORT":"PASS";
await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report));
if(failed)process.exitCode=1;
