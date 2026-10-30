import type { ArchitectureDocumentV1 } from "../architecture-document.ts";
import type { EvidenceSpan } from "@sage/contracts";
import type { SemanticModel, SemanticNode, SemanticEdge, PresentationOverlay } from "./model.ts";
import { applyPresentation } from "./presentation.ts";

export interface SemanticPresentation { model: SemanticModel; overlay: PresentationOverlay; revision: number }
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
function code(text: string): string {
  const fence = "`".repeat(Math.max(1, ...(text.match(/`+/g) ?? []).map(s => s.length + 1)));
  const visible = text.replace(/\r/g,"\\r").replace(/\n/g,"\\n").replace(/\t/g,"\\t").replace(/[\u0000-\u001f\u007f]/g,"�");
  return `${fence} ${visible} ${fence}`;
}
function evidenceUrl(model: SemanticModel, span: EvidenceSpan): string | null {
  const repo = model.snapshot.repository.split("/");
  if (repo.length !== 2 || !repo.every(x => /^[\w.-]+$/.test(x)) || !/^[a-f0-9]{40}$/.test(model.snapshot.commitSha) || span.filePath.split("/").some(x => x === "..")) return null;
  return `https://github.com/${repo.join("/")}/blob/${model.snapshot.commitSha}/${span.filePath.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}#L${span.startLine}-L${span.endLine}`;
}
function markdownEvidence(model: SemanticModel, spans: EvidenceSpan[]): string[] {
  return spans.map(span => { const label = `${span.filePath}:${span.startLine}–${span.endLine}`; const url = evidenceUrl(model, span); return `  - Evidence: ${url ? `[${code(label)}](${url})` : code(label)}; file SHA-256 ${code(span.fileSha256)}; bytes ${span.startByte}–${span.endByte}.`; });
}
/** Full semantic appendix; technical ADD Markdown is retained by the caller. */
export function renderSemanticMarkdown(input: SemanticPresentation): string {
  const model = applyPresentation(input.model, input.overlay);
  const lines = ["# Fitur, user flow, dan knowledge graph", "", `Revisi tampilan: ${input.revision}. Model: ${code(model.schemaVersion)} / ${code(model.extractorVersion)}.`, "", "Terbukti = hubungan statis pada source; Indikasi = interpretasi pola yang dijelaskan, bukan jaminan runtime. Koreksi pengguna hanya mengganti label/pengelompokan.", "", "## Fitur dan alur", ""];
  for (const feature of model.features) {
    lines.push(`### ${code(feature.label)}`, `- ID: ${code(feature.id)}`, `- Entry nodes: ${feature.entryNodeIds.map(code).join(", ") || "none"}`, `- Nodes: ${feature.nodeIds.map(code).join(", ") || "none"}`, `- Edges: ${feature.edgeIds.map(code).join(", ") || "none"}`, ...markdownEvidence(model, feature.evidence), "");
  }
  lines.push("## Seluruh konsep dan langkah", "");
  for (const node of model.nodes) lines.push(`### ${code(node.label)}`, `- ID / kind / feature: ${code(node.id)} / ${code(node.kind)} / ${code(node.featureId ?? "none")}`, `- Tingkat bukti: ${node.confidence === "proven" ? "Terbukti" : "Indikasi"}; ${code(node.reason)}`, `- Technical nodes: ${node.technicalNodeIds.map(code).join(", ") || "none"}`, ...markdownEvidence(model, node.evidence), "");
  lines.push("## Seluruh hubungan", "");
  for (const edge of model.edges) lines.push(`- ${code(edge.id)}: ${code(edge.source)} → ${code(edge.target)} — ${code(edge.label)} (${edge.confidence === "proven" ? "Terbukti" : "Indikasi"})`, `  - Alasan: ${code(edge.reason)}`, ...markdownEvidence(model, edge.evidence));
  lines.push("", "## Batas pengenalan", "", ...model.limitations.map(item => `- ${code(item.filePath)}: ${code(item.reason)}`), "", "## Koreksi pengguna", "", code(JSON.stringify(input.overlay)), "");
  return lines.join("\n");
}

const colors: Record<string, [string,string]> = {
  actor:["#ddf4ff","#0969da"],feature:["#fbefff","#8250df"],concept:["#dafbe1","#1a7f37"],component:["#ddf4ff","#0969da"],store:["#dafbe1","#1a7f37"],step:["#ddf4ff","#0969da"],decision:["#fff8c5","#9a6700"],outcome:["#dafbe1","#1a7f37"],
};
function wrap(text: string, width = 28): string[] {
  const words = text.replace(/\s+/g," ").split(" "); const lines: string[] = []; let line = "";
  for (const raw of words) for (let start = 0; start < raw.length; start += width) { const word = raw.slice(start,start+width); if (line && line.length+word.length+1 > width) {lines.push(line);line="";} line += `${line ? " " : ""}${word}`; }
  if (line) lines.push(line); return lines;
}
/** A vector page, not a bitmap. Only source-model edges are drawn. */
export function renderSemanticFlowSvg(nodes: SemanticNode[], edges: SemanticEdge[]): string {
  const width = 1000, height = 510;
  const byId = new Map(nodes.map(n => [n.id,n]));
  const incoming = new Map(nodes.map(n => [n.id,0]));
  const outgoing = new Map(nodes.map(n => [n.id,[] as string[]]));
  const shownEdges = edges.filter(e => byId.has(e.source) && byId.has(e.target));
  for (const edge of shownEdges) {incoming.set(edge.target,(incoming.get(edge.target) ?? 0)+1);outgoing.get(edge.source)!.push(edge.target);}
  const rank = new Map(nodes.map(n => [n.id,0]));
  const queue = nodes.filter(n => incoming.get(n.id)===0).map(n => n.id).sort(); const seen = new Set<string>();
  while (queue.length) { const id = queue.shift()!; seen.add(id); for (const next of outgoing.get(id)!) { rank.set(next,Math.max(rank.get(next)!,rank.get(id)!+1));incoming.set(next,incoming.get(next)!-1);if(incoming.get(next)===0)queue.push(next); } }
  // Cycles remain source edges; fallback placement never invents an order edge.
  let cycleRank = Math.max(0,...rank.values());for(const n of nodes)if(!seen.has(n.id))rank.set(n.id,cycleRank++);
  const sorted = [...nodes].sort((a,b) => rank.get(a.id)!-rank.get(b.id)! || a.id.localeCompare(b.id));
  const columns = Math.min(3,Math.max(1,sorted.length)), rows = Math.max(1,Math.ceil(sorted.length/columns));
  const cardW = Math.min(270,width/columns-50), cardH = 68;
  const positions = new Map(sorted.map((n,i) => [n.id,{x:(i%columns)*(width/columns)+(width/columns-cardW)/2,y:Math.floor(i/columns)*(height/rows)+(height/rows-cardH)/2}]));
  const paths = shownEdges.map((edge,index) => {
    const a=positions.get(edge.source)!, b=positions.get(edge.target)!;
    const sameRow=a.y===b.y, forward=b.x>a.x, downward=b.y>a.y;
    const sx=sameRow?a.x+(forward?cardW:0):a.x+cardW/2;
    const sy=sameRow?a.y+cardH/2:a.y+(downward?cardH:0);
    const tx=sameRow?b.x+(forward?0:cardW):b.x+cardW/2;
    const ty=sameRow?b.y+cardH/2:b.y+(downward?0:cardH);
    const midX=(sx+tx)/2, midY=(sy+ty)/2;
    const path=sameRow?`M${sx},${sy} C${midX},${sy} ${midX},${ty} ${tx},${ty}`:`M${sx},${sy} C${sx},${midY} ${tx},${midY} ${tx},${ty}`;
    const label=edge.label.length>32?`${edge.label.slice(0,31)}…`:edge.label;
    return `<path d="${path}" fill="none" stroke="#64748b" stroke-width="1.5" ${edge.confidence==="indicated"?'stroke-dasharray="5 4"':""} marker-end="url(#arrow)"/><text x="${midX}" y="${midY-5-(index%2)*10}" text-anchor="middle" fill="#475569" font-size="10" stroke="white" stroke-width="3" paint-order="stroke">${escape(label)}</text>`;
  }).join("");
  const boxes=sorted.map(n=>{const p=positions.get(n.id)!,c=colors[n.kind]??colors.step!;const allLines=wrap(n.label,Math.floor(cardW/7));const lines=allLines.slice(0,3);if(allLines.length>3)lines[2]=`${lines[2]!.slice(0,-1)}…`;const shape=n.kind==="decision"?`<polygon points="${p.x+cardW/2},${p.y-5} ${p.x+cardW+5},${p.y+cardH/2} ${p.x+cardW/2},${p.y+cardH+5} ${p.x-5},${p.y+cardH/2}"`:`<rect x="${p.x}" y="${p.y}" width="${cardW}" height="${cardH}" rx="${n.kind==="actor"||n.kind==="outcome"?22:7}"`;return `<g>${shape} fill="${c[0]}" stroke="${c[1]}" ${n.confidence==="indicated"?'stroke-dasharray="5 3"':""}/><text x="${p.x+cardW/2}" y="${p.y+cardH/2-(lines.length-1)*7}" font-size="14" text-anchor="middle" fill="#1f2328">${lines.map((l,i)=>`<tspan x="${p.x+cardW/2}" dy="${i?14:0}">${escape(l)}</tspan>`).join("")}</text></g>`;}).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"/></marker></defs>${paths}${boxes}</svg>`;
}

export interface SemanticFlowPage { label: string; nodes: SemanticNode[]; edges: SemanticEdge[]; omittedRelations: number }

/** Divide actual entry flows into legible pages, preserving every member somewhere.
 * Cross-page relations are counted, never replaced by invented shortcut arrows. */
export function semanticFlowPages(model: SemanticModel, feature: SemanticModel["features"][number]): SemanticFlowPage[] {
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const members = new Set([...feature.nodeIds, ...feature.entryNodeIds].filter(id => id !== feature.id));
  const edges = model.edges.filter(edge => members.has(edge.source) && members.has(edge.target));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  const covered = new Set<string>();
  const pages: SemanticFlowPage[] = [];
  const uiEntries = edges.filter(edge => byId.get(edge.source)?.kind === "actor" && byId.get(edge.target)?.kind === "step").map(edge => edge.target);
  const entries = [...new Set([...uiEntries, ...feature.entryNodeIds.filter(id => members.has(id) && byId.get(id)?.kind === "step")])];
  function append(label: string, ids: string[]) {
    for (let start = 0; start < ids.length; start += 12) {
      const chunk = ids.slice(start,start+12), selected = new Set(chunk);
      chunk.forEach(id => covered.add(id));
      pages.push({label, nodes:chunk.map(id => byId.get(id)!).filter(Boolean),
        edges:edges.filter(edge => selected.has(edge.source) && selected.has(edge.target)),
        omittedRelations:edges.filter(edge => selected.has(edge.source) !== selected.has(edge.target)).length});
    }
  }
  for (const entry of entries) {
    if (covered.has(entry)) continue;
    const seen = new Set<string>(), queue = [entry];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of outgoing.get(id) ?? []) if (!seen.has(next)) queue.push(next);
    }
    const actors = edges.filter(edge => seen.has(edge.target) && byId.get(edge.source)?.kind === "actor").map(edge => edge.source);
    append(byId.get(entry)?.label ?? feature.label,[...new Set([...actors,...seen])]);
  }
  const remaining = [...members].filter(id => !covered.has(id));
  if (remaining.length) append("Konsep dan komponen terkait",remaining);

  return pages.length ? pages : [{label: feature.label, nodes: [], edges: [], omittedRelations: 0}];
}

export function renderSemanticPdfPages(input: SemanticPresentation, document: ArchitectureDocumentV1): string {
  const model=applyPresentation(input.model,input.overlay);
  const e=escape;
  const legend=`<p class="caption">Biru: tindakan/komponen · Amber: keputusan · Hijau: konsep/data/hasil · Putus-putus: indikasi. Semua hubungan berasal dari model analisis; bukan simulasi runtime. Revisi tampilan ${input.revision}.</p>`;
  const pages: string[]=[];
  for(let offset=0;offset<Math.max(1,model.features.length);offset+=20){const features=model.features.slice(offset,offset+20);pages.push(`<section class="semantic-page"><p class="eyebrow">SAGE / FITUR DAN AKTOR</p><h1>Software Engineering Diagram</h1><p>${e(document.snapshot.repository)} · ${features.length} dari ${model.features.length} fitur. ${model.frameworks.map(e).join(" · ")}</p><div class="semantic-overview">${features.map(f=>`<article><h2>${e(f.label)}</h2><p>${f.entryNodeIds.length} entry · ${f.nodeIds.length} konsep/langkah · ${f.edgeIds.length} hubungan</p></article>`).join("") || "<p>Pola user flow belum dikenali pada snapshot ini.</p>"}</div><p>Aktor: ${model.nodes.filter(n=>n.kind==="actor").map(n=>e(n.label)).join(" · ") || "Belum terbukti"}</p>${legend}<p class="caption">Seluruh fitur tetap tercantum; detail source dan keterbatasan lengkap tersedia pada Markdown.</p></section>`);}
  for (const feature of model.features) for (const flow of semanticFlowPages(model, feature)) {
    const span = flow.nodes.flatMap(node => node.evidence)[0] ?? feature.evidence[0];
    const url = span ? evidenceUrl(model, span) : null;
    const evidence = span ? `${span.filePath}:${span.startLine}–${span.endLine}` : "Tidak tercatat";
    pages.push(`<section class="semantic-page"><p class="eyebrow">SAGE / USER FLOW</p><h1>${e(feature.label)} · ${e(flow.label)}</h1><p>${flow.nodes.length} konsep/langkah dan ${flow.edges.length} hubungan pada halaman ini. ${flow.omittedRelations} hubungan melintasi bagian alur lain; seluruh relasi tersedia pada Markdown.</p><div class="semantic-figure">${renderSemanticFlowSvg(flow.nodes,flow.edges)}</div>${legend}<p class="caption">Evidence utama: ${url ? `<a href="${e(url)}">${e(evidence)}</a>` : e(evidence)}. Setiap langkah sumber tercantum pada halaman alur atau konsep terkait; tidak ada panah pengganti untuk hubungan antarhalaman.</p></section>`);
  }
  return `<style>.semantic-page{break-before:page;page-break-before:always;break-inside:avoid;min-height:175mm}.semantic-page h1{font-size:23px;margin:4px 0 8px}.semantic-page>p{font-size:10px}.semantic-figure{height:125mm;display:flex;align-items:center;justify-content:center}.semantic-figure svg{width:100%;height:100%;object-fit:contain}.semantic-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.semantic-overview article{border:1px solid #d1d9e0;border-left:3px solid #8250df;border-radius:6px;padding:8px;background:#f6f8fa;min-width:0}.semantic-overview h2{font-size:12px;overflow-wrap:anywhere;margin:0}.semantic-overview p{font-size:9px;margin:5px 0 0}</style>${pages.join("")}`;
}
