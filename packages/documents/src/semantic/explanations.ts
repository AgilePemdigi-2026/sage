import type { CcmEdge } from "@sage/contracts";
import type { RelationshipExplanation, SemanticEdge } from "./model.ts";

/** Old models do not acquire invented provenance when read. */
export function relationshipExplanation(edge: SemanticEdge): RelationshipExplanation | null {
  return edge.explanation ?? null;
}

const kinds: Record<string, string> = {
  CONTAINS: "containment", IMPORTS: "import", EXPORTS: "export", INCLUDES: "include", THROWS: "throw", CALLS: "call", EXTENDS: "inheritance",
  IMPLEMENTS: "implementation", TYPE_REFERENCES: "type_reference", INSTANTIATES: "instantiation",
  READS: "read", WRITES: "write",
};
const descriptions: Record<string, string> = {
  CONTAINS: "Elemen sumber berada dalam deklarasi atau modul pemiliknya; bukan urutan eksekusi.",
  IMPORTS: "Source mendeklarasikan import; import tidak membuktikan fungsi dipanggil.",
  EXPORTS: "Source mendeklarasikan export; ini bukan urutan eksekusi.",
  INCLUDES: "Source mendeklarasikan penyertaan file; eksekusi target belum dijamin.",
  THROWS: "Source memiliki pernyataan pelemparan error pada lokasi ini.",
  CALLS: "Call site merujuk target pemanggilan; keterjangkauan runtime belum dijamin.",
  EXTENDS: "Deklarasi menyatakan pewarisan tipe.", IMPLEMENTS: "Deklarasi menyatakan implementasi interface.",
  TYPE_REFERENCES: "Source menggunakan referensi tipe; bukan perpindahan data runtime.",
  INSTANTIATES: "Source memuat konstruksi instance target.",
  READS: "Source memuat pembacaan anggota target; bukan bukti akses database eksternal.",
  WRITES: "Source memuat penulisan anggota target; bukan bukti persistensi atau durability.",
};

export function explainCkgEdge(edge: CcmEdge): RelationshipExplanation {
  return {
    kind: kinds[edge.kind] ?? edge.kind.toLowerCase(), origin: "code", rule: `ckg:${edge.kind}`,
    summary: descriptions[edge.kind] ?? `Source mencatat relasi ${edge.kind}; lihat lokasi referensinya.`,
    limitations: edge.resolution === "Unresolved"
      ? [`Target belum terpecahkan: ${edge.unresolvedReason ?? "UNKNOWN"}.`, "Tidak membuktikan hubungan runtime ke target tertentu."]
      : ["Exact berarti resolusi deklarasi dalam snapshot, bukan jaminan eksekusi runtime."],
    sourceEdgeIds: [edge.id],
  };
}

/** Called only for new extractor output, never as an upgrade of legacy data. */
export function explainExtractedEdge(edge: SemanticEdge): RelationshipExplanation {
  const label = edge.label.toLocaleLowerCase("en");
  const kind = /membaca|reads?/u.test(label) ? "read" : /menulis|writes?|menyimpan|mengubah|menghapus/u.test(label) ? "write"
    : /memeriksa|memvalidasi|diperiksa|menguji|checks?|dilindungi|jika kondisi/u.test(label) ? "guard" : /menjalankan|memanggil|calls?|invokes?/u.test(label) ? "call"
    : /merujuk|references?/u.test(label) ? "reference" : /menghasilkan|returns?/u.test(label) ? "outcome"
    : /includes|kelompok|contains/u.test(label) ? "grouping" : "source_relationship";
  return {
    kind, origin: "code", rule: `semantic:${kind}`, summary: edge.reason,
    limitations: [edge.confidence === "indicated"
      ? "Indikasi dari pola source; target, pemasangan handler, atau efek runtime belum seluruhnya terverifikasi."
      : "Terbukti hanya dalam cakupan aturan statis; bukan jaminan jalur ini dijalankan saat runtime."],
    sourceEdgeIds: [edge.id],
  };
}
