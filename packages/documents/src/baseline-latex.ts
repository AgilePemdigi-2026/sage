import type { EvidenceSpan } from "@sage/contracts";
import { applyAddReviewOverlay, type AddReviewOverlay } from "./add-overlay.ts";
import type { AddBaselineModel, AddElement, AddRelationship } from "./baseline-add.ts";
import { addExportModelHash, PHASE_C_ADD, type AddExportMetadata } from "./phase-c-add.ts";

export type LatexEvidenceUrlBuilder = (span: EvidenceSpan) => string;

function tex(value: string): string {
  const replacements: Record<string, string> = {
    "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$", "&": "\\&", "%": "\\%",
    "#": "\\#", "_": "\\_", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}",
  };
  return value.replace(/[\\{}$&%#_^~]/gu, character => replacements[character]!);
}

function breakableTex(value: string): string {
  return tex(value).replaceAll("/", "/\\allowbreak{}").replaceAll(".", ".\\allowbreak{}")
    .replaceAll("\\_", "\\_\\allowbreak{}").replaceAll("-", "-\\allowbreak{}");
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
  return spans.map(span => {
    const label = breakableTex(`${span.filePath}:${span.startLine}-${span.endLine}`);
    return `\\href{${texUrl(makeUrl(span))}}{\\texttt{\\footnotesize ${label}}}`;
  }).join("\\newline ");
}

function table(headers: string[], rows: string[][], widths: string[]): string {
  const spec = widths.map(width => `p{${width}}`).join("|");
  const renderRow = (row: string[]) => (row.length === 1 && row[0]?.startsWith("\\multicolumn")
    ? row[0]
    : row.map(value => `\\raggedright\\arraybackslash ${value}`).join(" & ")) + " \\\\ \\hline";
  return [
    "\\small", "\\setlength{\\tabcolsep}{2pt}", `\\begin{longtable}{|${spec}|}`, "\\hline", "\\rowcolor{green!12}", renderRow(headers.map(value => `\\textbf{${tex(value)}}`)), "\\endfirsthead",
    "\\hline", "\\rowcolor{green!12}", renderRow(headers.map(value => `\\textbf{${tex(value)}}`)), "\\endhead",
    ...rows.map(renderRow), "\\end{longtable}", "\\normalsize",
  ].join("\n");
}

function relationshipRows(edges: AddRelationship[], elements: ReadonlyMap<string, AddElement>, makeUrl: LatexEvidenceUrlBuilder): string[][] {
  return edges.map(edge => [
    tex(elements.get(edge.sourceId)?.name ?? edge.sourceId),
    `\\textbf{${tex(edge.type.replace(/Relationship$/u, ""))}}\\newline ${tex(edge.label)}\\newline {\\scriptsize ${edge.confidence === "proven" ? "Proven" : "Indicated"} · ${reviewLabel(edge.review)}}`,
    tex(elements.get(edge.targetId)?.name ?? edge.targetId), evidence(edge.evidence, makeUrl),
  ]);
}

function diagramNodeKind(element: AddElement): "app" | "function" | "service" | "interface" | "data" {
  return element.type === "DataObject" ? "data" : element.type === "ApplicationComponent" ? "app"
    : element.type === "ApplicationFunction" ? "function" : element.type === "ApplicationService" ? "service" : "interface";
}

function diagramNodeLabel(element: AddElement): string {
  const prefix = element.type === "DataObject" ? "Data object" : element.type.replace("Application", "");
  return `\\textbf{${tex(prefix)}}\\\\${tex(element.name)}`;
}

function applicationCooperationPages(elements: AddElement[], edges: AddRelationship[]): string {
  const byId = new Map(elements.map(element => [element.id, element]));
  const relationships = edges.flatMap(edge => {
    const source = byId.get(edge.sourceId); const target = byId.get(edge.targetId);
    return source && target ? [{ source, target, edge }] : [];
  });
  const connected = new Set(relationships.flatMap(row => [row.source.id, row.target.id]));
  const isolated = elements.filter(element => !connected.has(element.id));
  const rows: ({ source: AddElement; target: AddElement; edge: AddRelationship } | { isolated: AddElement })[] = [
    ...relationships,
    ...isolated.map(element => ({ isolated: element })),
  ];
  if (!rows.length) return "\\noindent No source-supported application component relationship was identified.";

  const perPage = 8;
  const pageCount = Math.ceil(rows.length / perPage);
  return Array.from({ length: pageCount }, (_, page) => {
    const pageRows = rows.slice(page * perPage, (page + 1) * perPage);
    const nodesAndEdges = pageRows.map((row, index) => {
      const y = (((pageRows.length - 1) / 2) - index) * 1.5;
      if ("isolated" in row) {
        return `\\node[${diagramNodeKind(row.isolated)}node] (n${page}_${index}) at (11.25,${y.toFixed(2)}) {${diagramNodeLabel(row.isolated)}};`;
      }
      const sourceNode = `s${page}_${index}`; const targetNode = `t${page}_${index}`;
      const style = row.edge.confidence === "proven" ? "provenedge" : "indicatededge";
      const arrow = row.edge.type === "AssociationRelationship" ? "" : "-{Stealth},";
      return [
        `\\node[${diagramNodeKind(row.source)}node] (${sourceNode}) at (2.4,${y.toFixed(2)}) {${diagramNodeLabel(row.source)}};`,
        `\\node[${diagramNodeKind(row.target)}node] (${targetNode}) at (20.2,${y.toFixed(2)}) {${diagramNodeLabel(row.target)}};`,
        `\\draw[${arrow}${style}] (${sourceNode}.east) -- node[font=\\scriptsize,fill=white,inner sep=2pt,text width=10cm,align=center] {${tex(row.edge.label)}} (${targetNode}.west);`,
      ].join("\n");
    });
    return [
      "\\begin{landscape}", "\\begin{figure}[p]", "\\centering",
      `\\caption{ArchiMate Application Cooperation View${pageCount > 1 ? ` (${page + 1} of ${pageCount})` : ""}}`,
      `\\label{fig:applicationCooperation-${page + 1}}`,
      "\\begin{tikzpicture}[x=1cm,y=1cm,appnode/.style={draw=blue!65!black,fill=blue!6,rounded corners,align=center,text width=4.8cm,minimum height=1.1cm,font=\\scriptsize},functionnode/.style={draw=violet!75!black,fill=violet!7,rounded corners,align=center,text width=4.8cm,minimum height=1.1cm,font=\\scriptsize},servicenode/.style={draw=green!55!black,fill=green!8,rounded corners,align=center,text width=4.8cm,minimum height=1.1cm,font=\\scriptsize},interfacenode/.style={draw=orange!80!black,fill=orange!9,rounded corners,align=center,text width=4.8cm,minimum height=1.1cm,font=\\scriptsize},provenedge/.style={draw=gray!70,thick},indicatededge/.style={draw=orange!85!black,thick,dashed}]",
      ...nodesAndEdges,
      "\\node[font=\\scriptsize,anchor=west] at (0,-6.35) {Solid relationship: Proven \\quad Dashed relationship: Indicated};",
      "\\end{tikzpicture}", "\\end{figure}", "\\end{landscape}",
    ].join("\n");
  }).join("\n\n");
}

function dataStructurePages(elements: AddElement[], edges: AddRelationship[]): string {
  const dataElements = elements.filter(element => element.type === "DataObject");
  const buckets = Array.from({ length: Math.max(1, Math.ceil(dataElements.length / 24)) }, (_, page) => dataElements.slice(page * 24, (page + 1) * 24));
  return buckets.map((pageElements, page) => {
    const positions = new Map(pageElements.map((element, index) => [element.id, {
      name: `data${page}_${index}`, x: (index % 3) * 5.0, y: -Math.floor(index / 3) * 2.3,
    }]));
    const pageEdges = edges.filter(edge => positions.has(edge.sourceId) && positions.has(edge.targetId));
    const nodes = pageElements.map(element => {
      const position = positions.get(element.id)!;
      return `\\node[datanode] (${position.name}) at (${position.x.toFixed(2)},${position.y.toFixed(2)}) {${diagramNodeLabel(element)}};`;
    });
    const links = pageEdges.map(edge => {
      const from = positions.get(edge.sourceId)!; const to = positions.get(edge.targetId)!;
      const style = edge.confidence === "proven" ? "provenedge" : "indicatededge";
      const arrow = edge.type === "AssociationRelationship" ? "" : "-{Stealth},";
      return `\\draw[${arrow}${style}] (${from.name}) -- node[font=\\tiny,fill=white,inner sep=1pt,sloped] {${tex(edge.label)}} (${to.name});`;
    });
    return [
      "\\begin{figure}[p]", "\\centering", `\\caption{ArchiMate Data Structure View${buckets.length > 1 ? ` (${page + 1} of ${buckets.length})` : ""}}`,
      `\\label{fig:dataStructure-${page + 1}}`,
      "\\begin{tikzpicture}[x=1cm,y=1cm,datanode/.style={draw=green!55!black,fill=green!8,rounded corners,align=center,text width=4.4cm,minimum height=1.0cm,font=\\scriptsize},provenedge/.style={draw=gray!70,thick},indicatededge/.style={draw=orange!85!black,thick,dashed}]",
      ...nodes, ...links, "\\end{tikzpicture}", "\\end{figure}",
    ].join("\n");
  }).join("\n\n");
}

function diagramPages(elements: AddElement[], edges: AddRelationship[], view: "dataStructure" | "applicationCooperation", title: string): string {
  if (view === "applicationCooperation") return applicationCooperationPages(elements, edges);
  if (!elements.length) return `\\noindent ${tex(title)}: no source-supported elements were identified.`;
  return dataStructurePages(elements, edges);
}

/** Render the same Phase C model and section structure as the workspace and Markdown export. */
export function createAddLatex(model: AddBaselineModel, overlay: AddReviewOverlay, makeEvidenceUrl: LatexEvidenceUrlBuilder, metadata?: AddExportMetadata): string {
  model = applyAddReviewOverlay(model, overlay);
  const modelHash = addExportModelHash(metadata);
  const elements = new Map(model.elements.map(element => [element.id, element]));
  const dataElements = model.views.dataStructure.elementIds.map(id => elements.get(id)).filter((element): element is AddElement => Boolean(element));
  const appElements = model.views.applicationCooperation.elementIds.map(id => elements.get(id)).filter((element): element is AddElement => Boolean(element));
  const dataEdges = model.views.dataStructure.relationshipIds.map(id => model.relationships.find(edge => edge.id === id)).filter((edge): edge is AddRelationship => Boolean(edge));
  const appEdges = model.views.applicationCooperation.relationshipIds.map(id => model.relationships.find(edge => edge.id === id)).filter((edge): edge is AddRelationship => Boolean(edge));
  const entities = model.catalogs.dataEntities.flatMap(row => {
    const element = elements.get(row.elementId);
    return element ? [[tex(element.name), tex(element.featureGroup ?? "Unassigned"), tex(row.owner ?? "Requires confirmation"), "Requires enterprise input", tex(row.description ?? ""), reviewLabel(element.review), evidence(element.evidence, makeEvidenceUrl)]] : [];
  });
  const crud = model.matrices.applicationData.map(row => [
    tex(elements.get(row.applicationId)?.name ?? row.applicationId), tex(elements.get(row.dataId)?.name ?? row.dataId),
    crudMark(row.create), crudMark(row.read), crudMark(row.update), crudMark(row.delete), evidence(row.evidence, makeEvidenceUrl),
  ]);
  const portfolio = model.catalogs.applicationPortfolio.flatMap(row => {
    const element = elements.get(row.elementId);
    return element ? [[tex(element.name), "Baseline", tex(row.description ?? ""), reviewLabel(element.review), evidence(element.evidence, makeEvidenceUrl)]] : [];
  });
  const functions = model.elements.filter(element => element.type === "ApplicationFunction" || element.type === "ApplicationService").map(element => [
    element.type === "ApplicationFunction" ? "Function" : "Service", tex(element.name), tex(element.featureGroup ?? "Unassigned"),
    tex(element.description ?? ""), reviewLabel(element.review), evidence(element.evidence, makeEvidenceUrl),
  ]);
  const interfaces = model.catalogs.interfaces.flatMap(row => {
    const element = elements.get(row.elementId);
    return element ? [[tex(element.name), tex(row.protocol ?? "Not identified"), tex(row.contract ?? ""), reviewLabel(element.review), evidence(element.evidence, makeEvidenceUrl)]] : [];
  });
  const interactions = model.matrices.applicationInteractions.map(row => [
    tex(elements.get(row.sourceApplicationId)?.name ?? row.sourceApplicationId), tex(elements.get(row.targetApplicationId)?.name ?? row.targetApplicationId),
    tex(row.mechanism), evidence(row.evidence, makeEvidenceUrl),
  ]);
  const outline = PHASE_C_ADD;
  const noRows = (text: string, columns: number) => [[`\\multicolumn{${columns}}{l}{\\emph{${tex(text)}}}`]];
  return [
    "\\documentclass[12pt,a4paper,oneside]{report}",
    "\\PassOptionsToPackage{table}{xcolor}",
    "\\usepackage[T1]{fontenc}", "\\usepackage[utf8]{inputenc}", "\\usepackage{newtxtext,newtxmath}",
    "\\usepackage[indonesian]{babel}", "\\usepackage[a4paper,left=3cm,right=3cm,top=4.1cm,bottom=3cm,headheight=28pt,headsep=0.65cm]{geometry}",
    "\\usepackage{array,longtable,booktabs,tabularx,needspace,seqsplit,pdflscape}", "\\usepackage{tikz}", "\\usetikzlibrary{arrows.meta,positioning}",
    "\\usepackage[table]{xcolor}", "\\usepackage{fancyhdr}", "\\usepackage{hyperref}", "\\hypersetup{colorlinks=true,linkcolor=black,urlcolor=blue,citecolor=black}",
    "\\setlength{\\parindent}{1.25cm}", "\\setlength{\\parskip}{0.15em}", "\\renewcommand{\\contentsname}{CONTENTS}", "\\renewcommand{\\thesection}{\\arabic{section}}",
    "\\pagestyle{fancy}", "\\fancyhf{}", `\\fancyhead[L]{\\small\\shortstack[l]{Repository: ${tex(model.snapshot.repository)}\\\\Branch: ${tex(model.snapshot.branch ?? "Not recorded")}}}`, "\\fancyhead[R]{\\small PHASE C}", "\\fancyfoot[C]{\\thepage}", "\\renewcommand{\\headrulewidth}{0.8pt}",
    "\\begin{document}", "\\begin{titlepage}", "\\thispagestyle{empty}", "\\centering", "\\vspace*{3cm}", `{\\LARGE\\bfseries ${tex(outline.document.title)}\\par}`, "\\vspace{1.2cm}", "{\\Large Architecture Definition Document (ADD)\\par}", "\\vspace{0.4cm}", "{\\large Baseline Data and Application Architecture\\par}", "\\vfill", `{\\large Repository: ${tex(model.snapshot.repository)}\\par}`, `{\\large Source commit: ${breakableHash(model.snapshot.commitSha)}\\par}`, `{\\large Branch: ${tex(model.snapshot.branch ?? "Not recorded")}\\par}`, `{\\large ArchiMate profile: ${tex(model.archimateVersion)}\\par}`, "\\vspace{1cm}", "{\\large Generated from repository evidence\\par}", "\\phantomsection", `\\label{${outline.document.id}}`, `\\addcontentsline{toc}{chapter}{${tex(outline.document.title)}}`, "\\end{titlepage}",
    "\\pagenumbering{roman}", "\\tableofcontents", "\\clearpage", "\\pagenumbering{arabic}", "\\setcounter{section}{0}",
    `\\phantomsection\\section*{${tex(outline.dataArchitecture.title)}}\\addcontentsline{toc}{section}{${tex(outline.dataArchitecture.title)}}\\label{${outline.dataArchitecture.id}}`,
    `\\section{${tex(outline.sections.dataPrinciples.title)}}\\label{${outline.sections.dataPrinciples.id}}`,
    "\\noindent\\textbf{Architect input required.} Approved data principles were not supplied and are not inferred from repository source.",
    `\\section{${tex(outline.sections.dataBaseline.title)}}\\label{${outline.sections.dataBaseline.id}}`,
    `\\noindent ${tex(model.narratives.dataBaseline)}`, "\\medskip", "\\noindent Only the baseline is included; no target architecture is generated from this repository snapshot.",
    `\\section{${tex(outline.sections.businessDataModel.title)}}\\label{${outline.sections.businessDataModel.id}}`,
    "\\noindent Logical data objects found in the analyzed snapshot. Ownership and physical distribution require enterprise confirmation.",
    "\\subsection*{Data Entity Catalog}",
    table(["Data entity", "Feature group", "Owner", "Distribution", "Description", "Review", "Evidence"], entities.length ? entities : noRows("No data entity was identified", 7), ["1.8cm", "1.2cm", "1.4cm", "2.1cm", "1.9cm", "1.5cm", "3.8cm"]),
    `\\section{${tex(outline.sections.logicalDataModel.title)}}\\label{${outline.sections.logicalDataModel.id}}`,
    "\\noindent Data Structure view of source-supported data objects and explicit data-to-data associations. Solid edges are proven from source; dashed edges are indicated mappings.",
    diagramPages(dataElements, dataEdges, "dataStructure", "Data Structure"),
    "\\noindent Full relationship explanations remain available in the detailed Markdown export.",
    "\\Needspace{6cm}",
    table(["Source", "Relationship type, label, and review", "Target", "Evidence"], relationshipRows(dataEdges, elements, makeEvidenceUrl).length ? relationshipRows(dataEdges, elements, makeEvidenceUrl) : noRows("No explicit data-to-data relationship was identified", 4), ["2.5cm", "5.2cm", "2.5cm", "3.5cm"]),
    `\\section{${tex(outline.sections.dataManagementProcess.title)}}\\label{${outline.sections.dataManagementProcess.id}}`,
    "\\noindent\\textbf{Not assessed.} Data governance, stewardship, retention, and operational procedures are not established by code declarations alone.",
    `\\section{${tex(outline.sections.dataFunctionMatrix.title)}}\\label{${outline.sections.dataFunctionMatrix.id}}`,
    "\\noindent\\textbf{Not assessed.} No approved Phase B business-function catalog or mapping was supplied; this matrix is intentionally omitted.",
    `\\section{${tex(outline.sections.dataCrudMatrix.title)}}\\label{${outline.sections.dataCrudMatrix.id}}`,
    "\\noindent This source-based matrix uses application components. An application component is not assumed to be a business function. C = Create, R = Read, U = Update, D = Delete; Y = confirmed, N = explicitly absent, ? = unknown.",
    table(["Application component", "Data entity", "C", "R", "U", "D", "Evidence"], crud.length ? crud : noRows("No confirmed application-data operation", 7), ["2.5cm", "2.5cm", "0.6cm", "0.6cm", "0.6cm", "0.6cm", "4.1cm"]),
    `\\phantomsection\\section*{${tex(outline.applicationArchitecture.title)}}\\addcontentsline{toc}{section}{${tex(outline.applicationArchitecture.title)}}\\label{${outline.applicationArchitecture.id}}`,
    `\\section{${tex(outline.sections.applicationDesign.title)}}\\label{${outline.sections.applicationDesign.id}}`, `\\noindent ${tex(model.narratives.applicationBaseline)}`,
    "\\medskip", "\\noindent The view shows application components, functions, services, interfaces, and source-supported relationships. It does not establish deployment boundaries or business capabilities.",
    diagramPages(appElements, appEdges, "applicationCooperation", "Application Cooperation"),
    "\\noindent Full relationship explanations remain available in the detailed Markdown export.",
    "\\Needspace{6cm}",
    table(["Source", "Relationship type, label, and review", "Target", "Evidence"], relationshipRows(appEdges, elements, makeEvidenceUrl).length ? relationshipRows(appEdges, elements, makeEvidenceUrl) : noRows("No application cooperation relationship was extracted", 4), ["2.5cm", "5.2cm", "2.5cm", "3.5cm"]),
    `\\section{${tex(outline.sections.applicationCatalog.title)}}\\label{${outline.sections.applicationCatalog.id}}`,
    "\\noindent Current application components are listed from the analyzed repository. No target or planned application portfolio was supplied.",
    table(["Application component", "State", "Description", "Review", "Evidence"], portfolio.length ? portfolio : noRows("No application component was identified", 5), ["2.3cm", "1.2cm", "3.7cm", "1.5cm", "4.2cm"]),
    `\\section{${tex(outline.sections.logicalApplicationComponents.title)}}\\label{${outline.sections.logicalApplicationComponents.id}}`,
    table(["Type", "Logical component", "Feature group", "Description", "Review", "Evidence"], functions.length ? functions : noRows("No logical application component was identified", 6), ["1.2cm", "2.4cm", "1.8cm", "2.8cm", "1.4cm", "3.5cm"]),
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
    ], ["4.0cm", "10.0cm"]),
    "\\noindent\\textbf{Items requiring confirmation}",
    ...(model.limitations.length ? model.limitations.map(item => `\\par\\noindent\\textbullet\\ ${tex(item)}`) : ["\\par\\noindent No additional analyzer limitation was recorded."]),
    "\\end{document}", "",
  ].join("\n\n");
}
