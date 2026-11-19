import type { AddBaselineModel } from "./baseline-add-model.ts";
import { PHASE_C_ADD } from "./phase-c-add.ts";

export type AddViewKind = "dataStructure" | "applicationCooperation";
export type AddViewNarratives = { introduction: string; interpretation: string };

/** Keep older persisted ADD snapshots readable while sharing one deterministic fallback across all outputs. */
export function addViewNarratives(model: AddBaselineModel, view: AddViewKind): AddViewNarratives {
  const viewModel = model.views[view];
  const nodes = viewModel.elementIds.map(id => model.elements.find(element => element.id === id)).filter(Boolean);
  const relationships = viewModel.relationshipIds.map(id => model.relationships.find(edge => edge.id === id)).filter(Boolean);
  const proven = relationships.filter(edge => edge?.confidence === "proven").length;
  const indicated = relationships.length - proven;

  if (view === "dataStructure") {
    return {
      introduction: model.narratives.dataViewIntroduction ??
        `Diagram ini menampilkan ${nodes.length} data object dan ${relationships.length} relasi data yang dikenali pada source snapshot. Hanya hubungan antar data object yang didukung bukti source yang dimasukkan.`,
      interpretation: model.narratives.dataViewInterpretation ??
        (nodes.length
          ? `data object yang dikenali pada snapshot beserta association yang memiliki bukti source. Node tanpa garis berarti tidak ada association yang terkonfirmasi untuk node tersebut pada snapshot ini; hal itu tidak membuktikan bahwa hubungan tidak ada di sistem yang berjalan.`
          : `snapshot ini belum menyediakan data object source-supported untuk ditampilkan pada diagram.`),
    };
  }

  return {
    introduction: model.narratives.applicationViewIntroduction ??
      `Diagram ini memetakan ${nodes.length} elemen aplikasi dan ${relationships.length} hubungan yang dikenali secara statis dari repository. Hubungan internal ditampilkan sesuai pemetaan ArchiMate yang didukung evidence.`,
    interpretation: model.narratives.applicationViewInterpretation ??
      (nodes.length
        ? `hubungan source-level yang terdeteksi di dalam satu repository. ${proven} hubungan berstatus proven dan ${indicated} berstatus indicated; hubungan indicated perlu ditinjau. Diagram ini tidak menyatakan batas deployment, business capability, atau perilaku runtime.`
        : `snapshot ini belum menyediakan elemen aplikasi source-supported untuk ditampilkan pada diagram.`),
  };
}

export function addViewFigureNumber(view: AddViewKind, page: number): string {
  const section = view === "dataStructure" ? PHASE_C_ADD.sections.logicalDataModel.number : PHASE_C_ADD.sections.applicationDesign.number;
  return `${section}.${page}`;
}
