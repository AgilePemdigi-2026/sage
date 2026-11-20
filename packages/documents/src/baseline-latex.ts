import type { EvidenceSpan } from "@sage/contracts";
import { applyAddReviewOverlay, type AddReviewOverlay } from "./add-overlay.ts";
import type { AddBaselineModel, AddElement, AddRelationship } from "./baseline-add.ts";
import { addExportGeneratedDate, addExportModelHash, PHASE_C_ADD, type AddExportMetadata } from "./phase-c-add.ts";
import { addViewNarratives, type AddViewKind } from "./baseline-narratives.ts";
import { coreRelationshipLabel, projectCoreBaselineView, type BaselineViewName, type CoreBaselineView } from "./baseline-core-views.ts";

export type LatexEvidenceUrlBuilder = (span: EvidenceSpan, fileOnly?: boolean) => string;

const PDF_EVIDENCE_LINK_LIMIT = 3;

function tex(value: string): string {
  const replacements: Record<string, string> = {
    "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$", "&": "\\&", "%": "\\%",
    "#": "\\#", "_": "\\_", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}",
  };
  return value.replace(/[\\{}$&%#_^~]/gu, character => replacements[character]!);
}

function breakableTex(value: string): string {
  return value.split(/(\s+)/u).map(token => {
    if (!token || /^\s+$/u.test(token)) return token;
    const characters = Array.from(token);
    return characters.map((character, index) => {
      const escaped = tex(character);
      const punctuationBreak = /[\/._-]/u.test(character);
      // Permit a line break inside long names and identifiers before TeX has
      // to push them through a narrow catalog cell or past its border.
      const wordBreak = characters.length >= 16 && index > 0 && index < characters.length - 4 && index % 8 === 0;
      return escaped + (punctuationBreak || wordBreak ? "\\allowbreak{}" : "");
    }).join("");
  }).join("");
}

function breakableHash(value: string): string {
  return `\\texttt{\\seqsplit{${tex(value)}}}`;
}

function reviewLabel(review: AddElement["review"]): string {
  return review === "unreviewed" ? "Pending" : review === "confirmed" ? "Confirmed" : "Rejected";
}

function crudMark(value: "yes" | "no" | "unknown"): string {
  return value === "yes" ? "Y" : value === "no" ? "N" : "?";
}

function texUrl(value: string): string {
  return value.replaceAll("\\", "%5C").replaceAll("{", "%7B").replaceAll("}", "%7D").replaceAll("%", "\\%").replaceAll("#", "\\#");
}

function evidence(spans: EvidenceSpan[], makeUrl: LatexEvidenceUrlBuilder): string {
  if (!spans.length) return "Not available";
  const files = [...new Map(spans.map(span => [span.filePath, span])).values()];
  const links = files.slice(0, PDF_EVIDENCE_LINK_LIMIT).map(span => {
    const label = breakableTex(span.filePath);
    return `\\href{${texUrl(makeUrl(span, true))}}{\\texttt{\\footnotesize ${label}}}`;
  });
  const omitted = files.length - links.length;
  if (omitted > 0) links.push(`{\\scriptsize + ${omitted} additional evidence files}`);
  return links.join("\\newline ");
}

function table(headers: string[], rows: string[][], widths: string[]): string {
  const spec = widths.map(width => `>{\\centering\\arraybackslash}p{${width}}`).join("|");
  const renderRow = (row: string[]) => row.join(" & ") + " \\\\ \\hline";
  const renderHeader = (row: string[]) => row.join(" & ") + " \\\\ \\hline";
  return [
    "\\begingroup", "\\small", "\\setlength{\\tabcolsep}{3pt}", "\\renewcommand{\\arraystretch}{1.25}", "\\setlength{\\extrarowheight}{4pt}", `\\begin{longtable}{|${spec}|}`, "\\hline", "\\rowcolor{green!12}", renderHeader(headers.map(value => `\\textbf{${breakableTex(value)}}`)), "\\endfirsthead",
    "\\hline", "\\rowcolor{green!12}", renderHeader(headers.map(value => `\\textbf{${breakableTex(value)}}`)), "\\endhead",
    ...rows.map(renderRow), "\\end{longtable}", "\\endgroup",
  ].join("\n");
}

function diagramNodeKind(element: AddElement): "appcomponent" | "appfunction" | "appservice" | "appinterface" | "data" {
  return element.type === "DataObject" ? "data" : element.type === "ApplicationComponent" ? "appcomponent"
    : element.type === "ApplicationFunction" ? "appfunction" : element.type === "ApplicationService" ? "appservice" : "appinterface";
}

function diagramNodeLabel(element: AddElement): string {
  const labels: Record<AddElement["type"], string> = {
    ApplicationComponent: "Application Component", ApplicationFunction: "Application Function",
    ApplicationService: "Application Service", ApplicationInterface: "Application Interface", DataObject: "Data Object",
  };
  return `{\\scriptsize\\color{gray!70}${tex(labels[element.type])}}\\\\{\\normalsize\\bfseries ${breakableTex(element.name)}}`;
}

function relationshipNotation(type: AddRelationship["type"]): string {
  switch (type) {
    case "CompositionRelationship": return "{Diamond[fill=gray!80!black]}-";
    case "AssignmentRelationship": return "{Circle[fill=gray!80!black]}-";
    case "RealizationRelationship": return "dashed,-{Triangle[open]}";
    case "ServingRelationship": return "-{Stealth[open]}";
    case "AccessRelationship": return "densely dotted,-{Stealth[open]}";
    case "AssociationRelationship": return "";
    case "TriggeringRelationship": return "-{Stealth[fill=gray]}";
    case "FlowRelationship": return "dashed,-{Stealth[fill=gray]}";
  }
}

type DiagramPosition = { x: number; y: number };

function coreDiagramPositions(view: CoreBaselineView, viewName: BaselineViewName): Map<string, DiagramPosition> {
  const adjacency = new Map(view.elements.map(element => [element.id, [] as string[]]));
  const outgoing = new Map(view.elements.map(element => [element.id, [] as string[]]));
  for (const edge of view.relationships) {
    adjacency.set(edge.sourceId, [...(adjacency.get(edge.sourceId) ?? []), edge.targetId]);
    adjacency.set(edge.targetId, [...(adjacency.get(edge.targetId) ?? []), edge.sourceId]);
    outgoing.set(edge.sourceId, [...(outgoing.get(edge.sourceId) ?? []), edge.targetId]);
  }
  const names = new Map(view.elements.map(element => [element.id, element.name]));
  const degree = (id: string) => adjacency.get(id)?.length ?? 0;
  const components: Array<{ ids: string[]; depths: Map<string, number> }> = [];
  const visited = new Set<string>();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const ids: string[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const id = queue.shift()!;
      ids.push(id);
      for (const next of adjacency.get(id) ?? []) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
    const depths = new Map<string, number>();
    if (viewName === "applicationCooperation") {
      const idSet = new Set(ids);
      const indegree = new Map(ids.map(id => [id, 0]));
      for (const id of ids) for (const next of outgoing.get(id) ?? []) if (idSet.has(next)) indegree.set(next, indegree.get(next)! + 1);
      const ready = ids.filter(id => indegree.get(id) === 0).sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
      const order: string[] = [];
      for (const id of ready) depths.set(id, 0);
      while (ready.length) {
        const id = ready.shift()!;
        order.push(id);
        for (const next of outgoing.get(id) ?? []) {
          if (!idSet.has(next)) continue;
          depths.set(next, Math.max(depths.get(next) ?? 0, (depths.get(id) ?? 0) + 1));
          indegree.set(next, indegree.get(next)! - 1);
          if (indegree.get(next) === 0) { ready.push(next); ready.sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b)); }
        }
      }
      if (order.length !== ids.length) depths.clear();
    }
    if (depths.size !== ids.length) {
      depths.clear();
      const root = [...ids].sort((a, b) => degree(b) - degree(a) || (names.get(a) ?? a).localeCompare(names.get(b) ?? b))[0]!;
      depths.set(root, 0);
      const levelQueue = [root];
      while (levelQueue.length) {
        const id = levelQueue.shift()!;
        for (const next of adjacency.get(id) ?? []) if (!depths.has(next)) { depths.set(next, depths.get(id)! + 1); levelQueue.push(next); }
      }
    }
    components.push({ ids, depths });
  }

  const positions = new Map<string, DiagramPosition>();
  if (viewName === "applicationCooperation") {
    const layers = new Map<number, string[]>();
    for (const component of components) for (const [id, depth] of component.depths) layers.set(depth, [...(layers.get(depth) ?? []), id]);
    for (const [depth, ids] of layers) {
      ids.sort((a, b) => degree(b) - degree(a) || (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
      ids.forEach((id, index) => positions.set(id, { x: 1.7 + depth * 5.0, y: -((index - (ids.length - 1) / 2) * 1.85) }));
    }
    return positions;
  }

  let laneTop = 0;
  for (const component of components) {
    const layers = new Map<number, string[]>();
    for (const [id, depth] of component.depths) layers.set(depth, [...(layers.get(depth) ?? []), id]);
    const rowCount = Math.max(...[...layers.values()].map(ids => ids.length), 1);
    for (const [depth, ids] of layers) {
      ids.sort((a, b) => degree(b) - degree(a) || (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
      const layerOffset = (rowCount - ids.length) * 0.9;
      ids.forEach((id, index) => positions.set(id, { x: 1.7 + depth * 4.0, y: laneTop - layerOffset - index * 1.8 }));
    }
    laneTop -= rowCount * 1.8 + 0.55;
  }
  return positions;
}

function conciseDiagramLabel(edge: AddRelationship): string | null {
  return edge.type === "FlowRelationship" ? coreRelationshipLabel(edge) : null;
}

function diagramPageCount(view: CoreBaselineView): number {
  return view.relationships.length ? 1 : 0;
}

function renderDiagramPages(viewModel: CoreBaselineView, view: BaselineViewName): string {
  if (!viewModel.relationships.length) return "\\noindent No source-supported relationship was identified for this view.";

  const positions = coreDiagramPositions(viewModel, view);
  const ids = new Map(viewModel.elements.map((element, index) => [element.id, `n${index}`]));
  const nodes = viewModel.elements.map(element => {
    const position = positions.get(element.id)!;
    return `\\node[${diagramNodeKind(element)}node] (${ids.get(element.id)}) at (${position.x.toFixed(2)},${position.y.toFixed(2)}) {${diagramNodeLabel(element)}};`;
  });
  const edges = viewModel.relationships.map(edge => {
    const label = conciseDiagramLabel(edge);
    const labelNode = label ? ` node[midway,fill=white,inner sep=1.5pt,font=\\scriptsize,align=center]{${breakableTex(label)}}` : "";
    const notation = relationshipNotation(edge.type);
    const sourcePosition = positions.get(edge.sourceId)!;
    const targetPosition = positions.get(edge.targetId)!;
    const options = Math.abs(targetPosition.x - sourcePosition.x) > 5.1 ? "[bend left=24]" : sourcePosition.x === targetPosition.x ? "[bend right=18]" : "[]";
    return "\\draw[draw=gray!80!black,thick" + (notation ? "," + notation : "") + "] (" + ids.get(edge.sourceId) + ") to" + options + labelNode + " (" + ids.get(edge.targetId) + ");";
  });
  const viewTitle = view === "dataStructure" ? "ArchiMate Information Structure Viewpoint" : "ArchiMate Application Cooperation Viewpoint";
  return [
    "\\Needspace{12cm}", "\\begin{center}",
    "\\begin{tikzpicture}[x=1cm,y=1cm,appcomponentnode/.style={draw=blue!65!black,fill=blue!6,rectangle,align=center,text width=3.15cm,minimum height=0.95cm,inner sep=5pt,font=\\small},appfunctionnode/.style={draw=blue!65!black,fill=blue!6,rectangle,rounded corners=4pt,align=center,text width=3.15cm,minimum height=0.95cm,inner sep=5pt,font=\\small},appservicenode/.style={draw=blue!65!black,fill=blue!6,rectangle,rounded corners=4pt,align=center,text width=3.15cm,minimum height=0.95cm,inner sep=5pt,font=\\small},appinterfacenode/.style={draw=blue!65!black,fill=blue!6,rectangle,align=center,text width=3.15cm,minimum height=0.95cm,inner sep=5pt,font=\\small},datanode/.style={draw=blue!65!black,fill=blue!6,rectangle,align=center,text width=3.15cm,minimum height=0.95cm,inner sep=5pt,font=\\small},>=Stealth]",
    ...nodes,
    ...edges,
    "\\end{tikzpicture}",
    `\\par\\smallskip\\captionof{figure}{${viewTitle}}`,
    `\\label{fig:${view}-1}`,
    "\\end{center}",
  ].join("\n");
}

function diagramPages(view: CoreBaselineView, name: BaselineViewName, title: string): string {
  if (!view.relationships.length) return `\\noindent ${tex(title)}: no source-supported relationships were identified.`;
  return renderDiagramPages(view, name);
}

function conciseRelationshipRows(view: CoreBaselineView, elements: ReadonlyMap<string, AddElement>, makeUrl: LatexEvidenceUrlBuilder): string[][] {
  return view.relationships.map(edge => {
    const label = coreRelationshipLabel(edge);
    return [
      breakableTex(elements.get(edge.sourceId)?.name ?? edge.sourceId),
      `\\textbf{${breakableTex(edge.type.replace(/Relationship$/u, ""))}}${label ? `\\newline ${breakableTex(label)}` : ""}\\newline {\\scriptsize ${edge.confidence === "proven" ? "Proven" : "Indicated"} · ${reviewLabel(edge.review)}}`,
      breakableTex(elements.get(edge.targetId)?.name ?? edge.targetId), evidence(edge.evidence, makeUrl),
    ];
  });
}

function coreViewNote(): string {
  return "This view shows only core source-supported relationships. Detailed source relationships remain in the corresponding catalog and relationship register.";
}

/** Render the same ADD model and section structure as the workspace and Markdown export. */
export function createAddLatex(model: AddBaselineModel, overlay: AddReviewOverlay, makeEvidenceUrl: LatexEvidenceUrlBuilder, metadata?: AddExportMetadata): string {
  model = applyAddReviewOverlay(model, overlay);
  const modelHash = addExportModelHash(metadata);
  const elements = new Map(model.elements.map(element => [element.id, element]));
  const dataView = projectCoreBaselineView(model, "dataStructure");
  const applicationView = projectCoreBaselineView(model, "applicationCooperation");
  const entities = model.catalogs.dataEntities.flatMap(row => {
    const element = elements.get(row.elementId);
    return element ? [[breakableTex(element.name), breakableTex(element.featureGroup ?? "Unassigned"), breakableTex(row.owner ?? "Unknown"), "Not established", breakableTex(row.description ?? ""), reviewLabel(element.review), evidence(element.evidence, makeEvidenceUrl)]] : [];
  });
  const crud = model.matrices.applicationData.map(row => [
    breakableTex(elements.get(row.applicationId)?.name ?? row.applicationId), breakableTex(elements.get(row.dataId)?.name ?? row.dataId),
    crudMark(row.create), crudMark(row.read), crudMark(row.update), crudMark(row.delete), evidence(row.evidence, makeEvidenceUrl),
  ]);
  const portfolio = model.catalogs.applicationPortfolio.flatMap(row => {
    const element = elements.get(row.elementId);
    return element ? [[breakableTex(element.name), "Baseline", breakableTex(row.description ?? ""), reviewLabel(element.review), evidence(element.evidence, makeEvidenceUrl)]] : [];
  });
  const functions = model.elements.filter(element => element.type === "ApplicationFunction" || element.type === "ApplicationService").map(element => [
    element.type === "ApplicationFunction" ? "Function" : "Service", breakableTex(element.name), breakableTex(element.featureGroup ?? "Unassigned"),
    breakableTex(element.description ?? ""), reviewLabel(element.review), evidence(element.evidence, makeEvidenceUrl),
  ]);
  const interfaces = model.catalogs.interfaces.flatMap(row => {
    const element = elements.get(row.elementId);
    return element ? [[breakableTex(element.name), breakableTex(row.protocol ?? "Not identified"), breakableTex(row.contract ?? ""), reviewLabel(element.review), evidence(element.evidence, makeEvidenceUrl)]] : [];
  });
  const interactions = model.matrices.applicationInteractions.map(row => [
    breakableTex(elements.get(row.sourceApplicationId)?.name ?? row.sourceApplicationId), breakableTex(elements.get(row.targetApplicationId)?.name ?? row.targetApplicationId),
    breakableTex(row.mechanism), evidence(row.evidence, makeEvidenceUrl),
  ]);
  const outline = PHASE_C_ADD;
  const generatedDate = addExportGeneratedDate(metadata);
  const dataViewNarratives = addViewNarratives(model, "dataStructure");
  const applicationViewNarratives = addViewNarratives(model, "applicationCooperation");
  const diagramInterpretation = (view: AddViewKind, projection: CoreBaselineView, narrative: string) => {
    const count = diagramPageCount(projection);
    if (!count) return `\\noindent ${tex(narrative)}`;
    const first = `\\ref{fig:${view}-1}`;
    const figureRange = count > 1 ? `Gambar~${first} sampai Gambar~\\ref{fig:${view}-${count}}` : `Gambar~${first}`;
    return `\\noindent ${figureRange} memperlihatkan bahwa ${tex(narrative)}`;
  };
  const noRows = (text: string, columns: number) => [[`\\multicolumn{${columns}}{l}{\\emph{${tex(text)}}}`]];
  return [
    "\\documentclass[12pt,a4paper,oneside]{report}",
    "\\PassOptionsToPackage{table}{xcolor}",
    "\\usepackage[T1]{fontenc}", "\\usepackage[utf8]{inputenc}", "\\usepackage{newtxtext,newtxmath}",
    "\\usepackage[indonesian]{babel}", "\\addto\\captionsindonesian{\\renewcommand{\\contentsname}{DAFTAR ISI}}", "\\usepackage[a4paper,left=3cm,right=3cm,top=4.1cm,bottom=3cm,headheight=28pt,headsep=0.65cm]{geometry}",
    "\\usepackage{array,longtable,booktabs,tabularx,needspace,seqsplit,tocloft,titlesec,caption}", "\\usepackage{tikz}", "\\usetikzlibrary{arrows.meta,positioning}",
    "\\usepackage[table]{xcolor}", "\\usepackage{fancyhdr}", "\\usepackage{hyperref}", "\\hypersetup{colorlinks=true,linkcolor=black,urlcolor=blue,citecolor=black}", "\\captionsetup{justification=centering}",
    "\\setlength{\\parindent}{1.25cm}", "\\setlength{\\parskip}{0.15em}", "\\renewcommand{\\contentsname}{DAFTAR ISI}", "\\renewcommand{\\thesection}{\\arabic{section}}", "\\renewcommand{\\thefigure}{\\thesection.\\arabic{figure}}", "\\renewcommand{\\theHfigure}{\\thesection.\\arabic{figure}}",
    "\\setlength{\\cftbeforetoctitleskip}{0pt}", "\\setlength{\\cftaftertoctitleskip}{1em}", "\\renewcommand{\\cfttoctitlefont}{\\hfill\\Large\\bfseries}", "\\renewcommand{\\cftaftertoctitle}{\\hfill}",
    "\\titleformat{\\section}[block]{\\normalfont\\Large\\bfseries\\raggedright}{\\thesection.}{0.7em}{}", "\\titleformat{\\subsection}[block]{\\normalfont\\large\\bfseries\\raggedright}{\\thesubsection}{0.7em}{}", "\\titleformat{\\subsubsection}[block]{\\normalfont\\normalsize\\bfseries\\raggedright}{\\thesubsubsection}{0.7em}{}", "\\titlespacing*{\\section}{0pt}{1.5em}{0.75em}", "\\titlespacing*{\\subsection}{0pt}{1.1em}{0.55em}", "\\titlespacing*{\\subsubsection}{0pt}{0.9em}{0.4em}",
    "\\pagestyle{fancy}", "\\fancyhf{}", `\\fancyhead[L]{\\small\\shortstack[l]{SAGE\\\\${tex(outline.document.title)}}}`, `\\fancyhead[R]{\\small ${tex(generatedDate)}}`, "\\fancyfoot[C]{\\thepage}", "\\renewcommand{\\headrulewidth}{0.8pt}",
    "\\begin{document}", "\\begin{titlepage}", "\\thispagestyle{empty}", "\\centering", "\\vspace*{3.2cm}", `{\\parbox{0.92\\textwidth}{\\centering\\fontsize{25}{30}\\selectfont\\bfseries ${tex(outline.document.title)}\\par}}`, "\\vspace{1.4cm}", "{\\Large\\bfseries Baseline Data and Application Architecture\\par}", "\\vfill", `{\\large Repository: ${tex(model.snapshot.repository)}\\par}`, `{\\large Source commit: ${breakableHash(model.snapshot.commitSha)}\\par}`, `{\\large Branch: ${tex(model.snapshot.branch ?? "Not recorded")}\\par}`, `{\\large ArchiMate profile: ${tex(model.archimateVersion)}\\par}`, "\\vspace{1cm}", "{\\large Generated from repository evidence\\par}", "\\phantomsection", `\\label{${outline.document.id}}`, "\\end{titlepage}",
    "\\pagenumbering{roman}", "\\tableofcontents", "\\clearpage", "\\pagenumbering{arabic}", "\\setcounter{section}{0}",
    `\\phantomsection\\section*{${tex(outline.dataArchitecture.title)}}\\addcontentsline{toc}{section}{${tex(outline.dataArchitecture.title)}}\\label{${outline.dataArchitecture.id}}`,
    `\\section{${tex(outline.sections.dataPrinciples.title)}}\\label{${outline.sections.dataPrinciples.id}}`,
    "\\noindent\\textbf{Architect input required.} Approved data principles were not supplied and are not inferred from repository source.",
    `\\section{${tex(outline.sections.dataBaseline.title)}}\\label{${outline.sections.dataBaseline.id}}`,
    `\\noindent ${tex(model.narratives.dataBaseline)}`, "\\medskip", "\\noindent Only the baseline is included; no target architecture is generated from this repository snapshot.",
    `\\section{${tex(outline.sections.businessDataModel.title)}}\\label{${outline.sections.businessDataModel.id}}`,
    "\\noindent Logical data objects found in the analyzed snapshot. Ownership and physical distribution require enterprise confirmation.",
    "\\subsection*{Data Entity Catalog}",
    table(["Data entity", "Feature group", "Owner", "Location", "Description", "Review", "Evidence"], entities.length ? entities : noRows("No data entity was identified", 7), ["2.1cm", "1.9cm", "1.5cm", "1.9cm", "2.1cm", "1.3cm", "2.2cm"]),
    "\\Needspace{13cm}", `\\section{${tex(outline.sections.logicalDataModel.title)}}\\label{${outline.sections.logicalDataModel.id}}`,
    `\\noindent ${tex(dataViewNarratives.introduction)}`,
    "\\par\\smallskip{\\footnotesize ArchiMate line styles and end markers identify relationship types. Evidence confidence and review state appear in the register.}",
    "\\setcounter{figure}{0}",
    `\\noindent{\\footnotesize ${tex(coreViewNote())}}`,
    diagramPages(dataView, "dataStructure", "Information Structure Viewpoint"),
    diagramInterpretation("dataStructure", dataView, dataViewNarratives.interpretation),
    "\\medskip\\noindent The compact register lists only the relationships shown in this view.",
    "\\Needspace{6cm}",
    table(["Source", "Relationship", "Target", "Evidence"], conciseRelationshipRows(dataView, elements, makeEvidenceUrl).length ? conciseRelationshipRows(dataView, elements, makeEvidenceUrl) : noRows("No explicit data-to-data relationship was identified", 4), ["2.4cm", "4.7cm", "2.4cm", "3.5cm"]),
    `\\section{${tex(outline.sections.dataManagementProcess.title)}}\\label{${outline.sections.dataManagementProcess.id}}`,
    "\\noindent\\textbf{Not assessed.} Data governance, stewardship, retention, and operational procedures are not established by code declarations alone.",
    `\\section{${tex(outline.sections.dataFunctionMatrix.title)}}\\label{${outline.sections.dataFunctionMatrix.id}}`,
    "\\noindent\\textbf{Not assessed.} No approved Phase B business-function catalog or mapping was supplied; this matrix is intentionally omitted.",
    `\\section{${tex(outline.sections.dataCrudMatrix.title)}}\\label{${outline.sections.dataCrudMatrix.id}}`,
    "\\noindent This source-based matrix uses application components. An application component is not assumed to be a business function. C = Create, R = Read, U = Update, D = Delete; Y = confirmed, N = explicitly absent, ? = unknown.",
    table(["Application component", "Data entity", "C", "R", "U", "D", "Evidence"], crud.length ? crud : noRows("No confirmed application-data operation", 7), ["3.1cm", "2.6cm", "0.55cm", "0.55cm", "0.55cm", "0.55cm", "5.1cm"]),
    `\\phantomsection\\section*{${tex(outline.applicationArchitecture.title)}}\\addcontentsline{toc}{section}{${tex(outline.applicationArchitecture.title)}}\\label{${outline.applicationArchitecture.id}}`,
    "\\Needspace{13cm}", `\\section{${tex(outline.sections.applicationDesign.title)}}\\label{${outline.sections.applicationDesign.id}}`, `\\noindent ${tex(model.narratives.applicationBaseline)}`,
    "\\medskip", `\\noindent ${tex(applicationViewNarratives.introduction)}`,
    "\\par\\smallskip{\\footnotesize ArchiMate line styles and end markers identify relationship types. Evidence confidence and review state appear in the register.}",
    "\\setcounter{figure}{0}",
    `\\noindent{\\footnotesize ${tex(coreViewNote())}}`,
    diagramPages(applicationView, "applicationCooperation", "Application Cooperation Viewpoint"),
    diagramInterpretation("applicationCooperation", applicationView, applicationViewNarratives.interpretation),
    "\\medskip\\noindent The compact register lists only the relationships shown in this view.",
    "\\Needspace{6cm}",
    table(["Source", "Relationship", "Target", "Evidence"], conciseRelationshipRows(applicationView, elements, makeEvidenceUrl).length ? conciseRelationshipRows(applicationView, elements, makeEvidenceUrl) : noRows("No application cooperation relationship was extracted", 4), ["2.4cm", "4.7cm", "2.4cm", "3.5cm"]),
    `\\section{${tex(outline.sections.applicationCatalog.title)}}\\label{${outline.sections.applicationCatalog.id}}`,
    "\\noindent Current application components are listed from the analyzed repository. No target or planned application portfolio was supplied.",
    table(["Application component", "State", "Description", "Review", "Evidence"], portfolio.length ? portfolio : noRows("No application component was identified", 5), ["2.8cm", "1.4cm", "3.2cm", "1.4cm", "4.1cm"]),
    `\\section{${tex(outline.sections.logicalApplicationComponents.title)}}\\label{${outline.sections.logicalApplicationComponents.id}}`,
    table(["Type", "Logical component", "Feature group", "Description", "Review", "Evidence"], functions.length ? functions : noRows("No logical application component was identified", 6), ["2.2cm", "2.2cm", "2.0cm", "2.2cm", "1.4cm", "3.1cm"]),
    `\\section{${tex(outline.sections.interfaceCatalog.title)}}\\label{${outline.sections.interfaceCatalog.id}}`,
    table(["Interface", "Protocol", "Contract", "Review", "Evidence"], interfaces.length ? interfaces : noRows("No interface was identified", 5), ["2.4cm", "1.7cm", "3.8cm", "1.5cm", "3.7cm"]),
    `\\section{${tex(outline.sections.applicationInteractions.title)}}\\label{${outline.sections.applicationInteractions.id}}`,
    "\\noindent Only communication between separately identified applications is recorded as an application interaction. Internal source calls are not presented as external integrations.",
    table(["Source application", "Target application", "Mechanism", "Evidence"], interactions.length ? interactions : noRows("No inter-application interaction was confirmed from this repository snapshot", 4), ["2.5cm", "2.5cm", "3.2cm", "5.0cm"]),
    "\\phantomsection\\section*{Source and analysis notes}\\addcontentsline{toc}{section}{Source and analysis notes}",
    table(["Item", "Value"], [
      ["Repository", tex(model.snapshot.repository)], ["Branch", tex(model.snapshot.branch ?? "Not recorded")],
      ["Source commit", breakableHash(model.snapshot.commitSha)], ["Source CKG SHA-256", breakableHash(model.sourceCkgHash)],
      ["ADD model SHA-256", breakableHash(modelHash)],
      ["Analyzer version", tex(model.generation.extractorVersion)],
      ["Narrative assistance", tex(model.generation.llmOutcome + (model.generation.llmModel ? " · " + model.generation.llmModel : ""))],
      ["Review overlay", tex(`${overlay.status}, revision ${overlay.revision}`)],
    ], ["3.8cm", "9.7cm"]),
    "\\noindent\\textbf{Items requiring confirmation}",
    ...(model.limitations.length ? model.limitations.map(item => `\\par\\noindent\\textbullet\\ ${tex(item)}`) : ["\\par\\noindent No additional analyzer limitation was recorded."]),
    "\\end{document}", "",
  ].join("\n\n");
}
