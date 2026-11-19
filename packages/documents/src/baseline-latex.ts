import type { EvidenceSpan } from "@sage/contracts";
import { applyAddReviewOverlay, type AddReviewOverlay } from "./add-overlay.ts";
import type { AddBaselineModel, AddElement, AddRelationship } from "./baseline-add.ts";
import { addExportGeneratedDate, addExportModelHash, PHASE_C_ADD, type AddExportMetadata } from "./phase-c-add.ts";
import { addViewNarratives, type AddViewKind } from "./baseline-narratives.ts";

export type LatexEvidenceUrlBuilder = (span: EvidenceSpan) => string;

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
      const wordBreak = characters.length >= 9 && index < characters.length - 1;
      return escaped + (punctuationBreak ? "\\allowbreak{}" : wordBreak ? "\\-" : "");
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
  const renderHeader = (row: string[]) => row.map(value => `\\centering\\arraybackslash ${value}`).join(" & ") + " \\\\ \\hline";
  return [
    "\\begingroup", "\\small", "\\setlength{\\tabcolsep}{4pt}", "\\renewcommand{\\arraystretch}{1.18}", "\\setlength{\\extrarowheight}{2pt}", `\\begin{longtable}{|${spec}|}`, "\\hline", "\\rowcolor{green!12}", renderHeader(headers.map(value => `\\textbf{${tex(value)}}`)), "\\endfirsthead",
    "\\hline", "\\rowcolor{green!12}", renderHeader(headers.map(value => `\\textbf{${tex(value)}}`)), "\\endhead",
    ...rows.map(renderRow), "\\end{longtable}", "\\endgroup",
  ].join("\n");
}

function relationshipRows(edges: AddRelationship[], elements: ReadonlyMap<string, AddElement>, makeUrl: LatexEvidenceUrlBuilder): string[][] {
  return edges.map(edge => [
    breakableTex(elements.get(edge.sourceId)?.name ?? edge.sourceId),
    `\\textbf{${breakableTex(edge.type.replace(/Relationship$/u, ""))}}\\newline ${breakableTex(edge.label)}\\newline {\\scriptsize ${edge.confidence === "proven" ? "Proven" : "Indicated"} · ${reviewLabel(edge.review)}}`,
    breakableTex(elements.get(edge.targetId)?.name ?? edge.targetId), evidence(edge.evidence, makeUrl),
  ]);
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
  return `\\textbf{${tex(labels[element.type])}}\\\\${tex(element.name)}`;
}

function relationshipTypeName(type: AddRelationship["type"]): string {
  return type.replace(/Relationship$/u, "").replace(/([a-z])([A-Z])/gu, "$1 $2");
}

function relationshipNotation(type: AddRelationship["type"]): string {
  switch (type) {
    case "CompositionRelationship": return "{Diamond[fill=gray]}-";
    case "AssignmentRelationship": return "{Circle[fill=gray]}-{Stealth[fill=gray]}";
    case "RealizationRelationship": return "densely dotted,-{Triangle[open]}";
    case "ServingRelationship": return "-{Stealth[open]}";
    case "AccessRelationship": return "densely dotted,-{Stealth[open]}";
    case "AssociationRelationship": return "";
    case "TriggeringRelationship": return "-{Stealth[fill=gray]}";
    case "FlowRelationship": return "dashed,-{Stealth[fill=gray]}";
  }
}

type DiagramRow =
  | { source: AddElement; target: AddElement; edge: AddRelationship }
  | { isolated: AddElement };

function diagramRows(elements: AddElement[], edges: AddRelationship[]): DiagramRow[] {
  const byId = new Map(elements.map(element => [element.id, element]));
  const relationships = edges.flatMap(edge => {
    const source = byId.get(edge.sourceId); const target = byId.get(edge.targetId);
    return source && target ? [{ source, target, edge }] : [];
  });
  const connected = new Set(relationships.flatMap(row => [row.source.id, row.target.id]));
  return [
    ...relationships,
    ...elements.filter(element => !connected.has(element.id)).map(element => ({ isolated: element })),
  ];
}

function diagramPageCount(elements: AddElement[], edges: AddRelationship[]): number {
  const rows = diagramRows(elements, edges);
  return rows.length ? Math.ceil(rows.length / 5) : 0;
}

function renderDiagramPages(elements: AddElement[], edges: AddRelationship[], view: "dataStructure" | "applicationCooperation"): string {
  const rows = diagramRows(elements, edges);
  if (!rows.length) return "\\noindent No source-supported " + (view === "dataStructure" ? "data object" : "application element or relationship") + " was identified.";

  const perPage = 5;
  const pageCount = Math.ceil(rows.length / perPage);
  return Array.from({ length: pageCount }, (_, page) => {
    const pageRows = rows.slice(page * perPage, (page + 1) * perPage);
    const nodesAndEdges = pageRows.map((row, index) => {
      const y = (((pageRows.length - 1) / 2) - index) * 1.8;
      if ("isolated" in row) {
        return "\\node[" + diagramNodeKind(row.isolated) + "node] (n" + page + "_" + index + ") at (7.5," + y.toFixed(2) + ") {" + diagramNodeLabel(row.isolated) + "};";
      }
      const sourceNode = "s" + page + "_" + index; const targetNode = "t" + page + "_" + index;
      const notation = relationshipNotation(row.edge.type);
      const confidence = row.edge.confidence === "proven"
        ? "\\textcolor{green!45!black}{\\textbf{PROVEN}}"
        : "\\textcolor{orange!80!black}{\\textbf{INDICATED}}";
      const connectorLabel = tex(relationshipTypeName(row.edge.type)) + ": " + tex(row.edge.label) + "\\\\{\\scriptsize " + confidence + "}";
      return [
        "\\node[" + diagramNodeKind(row.source) + "node] (" + sourceNode + ") at (2.25," + y.toFixed(2) + ") {" + diagramNodeLabel(row.source) + "};",
        "\\node[" + diagramNodeKind(row.target) + "node] (" + targetNode + ") at (12.75," + y.toFixed(2) + ") {" + diagramNodeLabel(row.target) + "};",
        "\\draw[draw=gray!75,thick" + (notation ? "," + notation : "") + "] (" + sourceNode + ".east) -- (" + targetNode + ".west);",
        "\\node[font=\\scriptsize,align=center,text width=5.8cm] at (7.5," + (y + 0.62).toFixed(2) + ") {" + connectorLabel + "};",
      ].join("\n");
    });
    const viewTitle = view === "dataStructure" ? "ArchiMate Data Structure View" : "ArchiMate Application Cooperation View";
    const pageBreak = page > 0 ? "\\clearpage" : "";
    return [
      pageBreak, "\\Needspace{12cm}", "\\begin{center}",
      "\\begin{tikzpicture}[x=1cm,y=1cm,appcomponentnode/.style={draw=blue!65!black,fill=blue!6,rectangle,align=center,text width=4.2cm,minimum height=1.05cm,inner sep=3pt,font=\\scriptsize},appfunctionnode/.style={draw=violet!75!black,fill=violet!7,rectangle,align=center,text width=4.2cm,minimum height=1.05cm,inner sep=3pt,font=\\scriptsize},appservicenode/.style={draw=green!55!black,fill=green!8,rectangle,align=center,text width=4.2cm,minimum height=1.05cm,inner sep=3pt,font=\\scriptsize},appinterfacenode/.style={draw=orange!80!black,fill=orange!9,rectangle,align=center,text width=4.2cm,minimum height=1.05cm,inner sep=3pt,font=\\scriptsize},datanode/.style={draw=green!55!black,fill=green!8,rectangle,align=center,text width=4.2cm,minimum height=1.05cm,inner sep=3pt,font=\\scriptsize},>=Stealth]",
      ...nodesAndEdges,
      "\\end{tikzpicture}",
      "\\par\\smallskip\\captionof{figure}{" + viewTitle + (pageCount > 1 ? " (continuation " + (page + 1) + " of " + pageCount + ")" : "") + "}",
      "\\label{fig:" + view + "-" + (page + 1) + "}",
      "\\end{center}",
    ].join("\n");
  }).join("\n\n");
}

function diagramPages(elements: AddElement[], edges: AddRelationship[], view: "dataStructure" | "applicationCooperation", title: string): string {
  if (!elements.length) return `\\noindent ${tex(title)}: no source-supported elements were identified.`;
  return renderDiagramPages(elements, edges, view);
}

/** Render the same ADD model and section structure as the workspace and Markdown export. */
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
    return element ? [[breakableTex(element.name), breakableTex(element.featureGroup ?? "Unassigned"), breakableTex(row.owner ?? "Unknown"), "Not established", breakableTex(row.description ?? ""), reviewLabel(element.review), evidence(element.evidence, makeEvidenceUrl)]] : [];
  });
  const crud = model.matrices.applicationData.map(row => [
    tex(elements.get(row.applicationId)?.name ?? row.applicationId), tex(elements.get(row.dataId)?.name ?? row.dataId),
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
  const diagramInterpretation = (view: AddViewKind, elementsForView: AddElement[], edgesForView: AddRelationship[], narrative: string) => {
    const count = diagramPageCount(elementsForView, edgesForView);
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
    table(["Data entity", "Feature group", "Owner", "Distribution", "Description", "Review", "Evidence"], entities.length ? entities : noRows("No data entity was identified", 7), ["1.5cm", "2.1cm", "1.5cm", "1.9cm", "2.0cm", "1.3cm", "2.7cm"]),
    "\\Needspace{13cm}", `\\section{${tex(outline.sections.logicalDataModel.title)}}\\label{${outline.sections.logicalDataModel.id}}`,
    `\\noindent ${tex(dataViewNarratives.introduction)}`,
    "\\par\\smallskip{\\footnotesize Solid and dashed connectors show evidence confidence; end markers distinguish supported ArchiMate relationship types.}",
    "\\setcounter{figure}{0}",
    diagramPages(dataElements, dataEdges, "dataStructure", "Data Structure"),
    diagramInterpretation("dataStructure", dataElements, dataEdges, dataViewNarratives.interpretation),
    "\\medskip\\noindent Relationship labels, confidence, review state, and evidence are listed in the register below.",
    "\\Needspace{6cm}",
    table(["Source", "Relationship type, label, and review", "Target", "Evidence"], relationshipRows(dataEdges, elements, makeEvidenceUrl).length ? relationshipRows(dataEdges, elements, makeEvidenceUrl) : noRows("No explicit data-to-data relationship was identified", 4), ["2.4cm", "4.7cm", "2.4cm", "3.5cm"]),
    `\\section{${tex(outline.sections.dataManagementProcess.title)}}\\label{${outline.sections.dataManagementProcess.id}}`,
    "\\noindent\\textbf{Not assessed.} Data governance, stewardship, retention, and operational procedures are not established by code declarations alone.",
    `\\section{${tex(outline.sections.dataFunctionMatrix.title)}}\\label{${outline.sections.dataFunctionMatrix.id}}`,
    "\\noindent\\textbf{Not assessed.} No approved Phase B business-function catalog or mapping was supplied; this matrix is intentionally omitted.",
    `\\section{${tex(outline.sections.dataCrudMatrix.title)}}\\label{${outline.sections.dataCrudMatrix.id}}`,
    "\\noindent This source-based matrix uses application components. An application component is not assumed to be a business function. C = Create, R = Read, U = Update, D = Delete; Y = confirmed, N = explicitly absent, ? = unknown.",
    table(["Application component", "Data entity", "C", "R", "U", "D", "Evidence"], crud.length ? crud : noRows("No confirmed application-data operation", 7), ["2.7cm", "2.7cm", "0.6cm", "0.6cm", "0.6cm", "0.6cm", "5.2cm"]),
    `\\phantomsection\\section*{${tex(outline.applicationArchitecture.title)}}\\addcontentsline{toc}{section}{${tex(outline.applicationArchitecture.title)}}\\label{${outline.applicationArchitecture.id}}`,
    "\\Needspace{13cm}", `\\section{${tex(outline.sections.applicationDesign.title)}}\\label{${outline.sections.applicationDesign.id}}`, `\\noindent ${tex(model.narratives.applicationBaseline)}`,
    "\\medskip", `\\noindent ${tex(applicationViewNarratives.introduction)}`,
    "\\par\\smallskip{\\footnotesize Solid and dashed connectors show evidence confidence; end markers distinguish supported ArchiMate relationship types.}",
    "\\setcounter{figure}{0}",
    diagramPages(appElements, appEdges, "applicationCooperation", "Application Cooperation"),
    diagramInterpretation("applicationCooperation", appElements, appEdges, applicationViewNarratives.interpretation),
    "\\medskip\\noindent Relationship labels, confidence, review state, and evidence are listed in the register below.",
    "\\Needspace{6cm}",
    table(["Source", "Relationship type, label, and review", "Target", "Evidence"], relationshipRows(appEdges, elements, makeEvidenceUrl).length ? relationshipRows(appEdges, elements, makeEvidenceUrl) : noRows("No application cooperation relationship was extracted", 4), ["2.4cm", "4.7cm", "2.4cm", "3.5cm"]),
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
    ], ["3.8cm", "9.7cm"]),
    "\\noindent\\textbf{Items requiring confirmation}",
    ...(model.limitations.length ? model.limitations.map(item => `\\par\\noindent\\textbullet\\ ${tex(item)}`) : ["\\par\\noindent No additional analyzer limitation was recorded."]),
    "\\end{document}", "",
  ].join("\n\n");
}
