import type { AddBaselineModel } from "./baseline-add-model.ts";
import { PHASE_C_ADD } from "./phase-c-add.ts";
import { projectCoreBaselineView } from "./baseline-core-views.ts";

export type AddViewKind = "dataStructure" | "applicationCooperation";
export type AddViewNarratives = { introduction: string; interpretation: string };

/** Keep older persisted ADD snapshots readable while sharing one deterministic fallback across all outputs. */
export function addViewNarratives(model: AddBaselineModel, view: AddViewKind): AddViewNarratives {
  const core = projectCoreBaselineView(model, view);
  const stored = model.narratives;
  const storedNarrative = (text: string | undefined): string | null => {
    if (!core.relationships.length || !text || text.length > 420 || /solid line|dashed line|garis (?:solid|putus)|node tanpa garis/iu.test(text)) return null;
    const countMentions = [...text.matchAll(/\b(\d+)\s+(?:data object|application element|elemen aplikasi|relasi|relationship|associations?)/giu)];
    if (countMentions.some(match => Number(match[1]) !== core.elements.length && Number(match[1]) !== core.relationships.length)) return null;
    if (view === "applicationCooperation" && /\b(?:interfaces?|endpoints?|handlers?|functions?|fungsi)\b/iu.test(text)) return null;
    return text;
  };
  const dataFallbackIntroduction = `Diagram ini menyoroti ${core.elements.length} data object dalam ${core.relationships.length} association inti. Object lain tetap tercantum pada Data Entity Catalog.`;
  const applicationFallbackIntroduction = `Overview ini menyoroti ${core.elements.length} application component atau service dan ${core.relationships.length} relasi inti. Detail yang lebih rendah berada di katalog.`;
  const dataFallbackInterpretation = core.relationships.length
    ? `Gambar ini memperlihatkan association yang dikonfirmasi source. Object yang tidak digambar tetap ada di katalog; ketiadaannya dari view ini tidak membuktikan object tersebut tidak ada pada sistem berjalan.`
    : `Snapshot ini belum menunjukkan association data yang didukung source; data object tetap tercantum di katalog.`;
  const applicationFallbackInterpretation = core.relationships.length
    ? `Gambar ini memperlihatkan hubungan inti antar application component atau service yang ditemukan pada source. Diagram tidak membuktikan business capability, availability, atau traffic runtime.`
    : `Snapshot ini belum menunjukkan hubungan inti antar application component atau service yang didukung source.`;

  if (view === "dataStructure") {
    return {
      introduction: storedNarrative(stored.dataViewIntroduction) ?? dataFallbackIntroduction,
      interpretation: storedNarrative(stored.dataViewInterpretation) ?? dataFallbackInterpretation,
    };
  }

  return {
    introduction: storedNarrative(stored.applicationViewIntroduction) ?? applicationFallbackIntroduction,
    interpretation: storedNarrative(stored.applicationViewInterpretation) ?? applicationFallbackInterpretation,
  };
}

export function addViewFigureNumber(view: AddViewKind, page: number): string {
  const section = view === "dataStructure" ? PHASE_C_ADD.sections.logicalDataModel.number : PHASE_C_ADD.sections.applicationDesign.number;
  return `${section}.${page}`;
}
