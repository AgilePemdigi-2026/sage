import styles from "./analysis-quality.module.css";

type Relation = { kind: string; resolution: string; unresolvedReason: string | null };
const explanations: Record<string, string> = {
  UNKNOWN_RECEIVER: "Tipe penerima atau target pemanggilan belum bisa dipastikan dari snapshot.",
  EXTERNAL_DEPENDENCY: "Dependensi berada di luar source yang tersedia dalam snapshot.",
  DYNAMIC_LOAD: "Target dipilih saat runtime, misalnya import dengan nilai dinamis.",
  UNSUPPORTED_CONSTRUCT: "Bentuk sintaks ini belum didukung resolver statis.",
  AMBIGUOUS_SYMBOL: "Ada beberapa kandidat; analyzer mempertahankannya sebagai ambigu.",
};

/** Counts references only: containment does not inflate the resolution success ratio. */
export function AnalysisQuality({ edges }: { edges: readonly Relation[] }) {
  const references = edges.filter(edge => edge.kind !== "CONTAINS");
  const unresolved = references.filter(edge => edge.resolution === "Unresolved");
  const byReason = new Map<string, number>();
  for (const edge of unresolved) {
    const reason = edge.unresolvedReason ?? "UNSUPPORTED_CONSTRUCT";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  return <details className={styles.quality}>
    <summary>Resolusi referensi: {references.length - unresolved.length} terbukti · {unresolved.length} belum terpecahkan</summary>
    <p>Jumlah ini mengecualikan relasi kepemilikan. Unresolved tidak otomatis berarti kode error; target eksternal dan perilaku dinamis tetap dicatat beserta buktinya.</p>
    {byReason.size ? <ul>{[...byReason].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([reason, count]) => <li key={reason}><strong>{count} · {reason}</strong><span>{explanations[reason] ?? "Lihat alasan dan evidence pada katalog relasi."}</span></li>)}</ul> : <p>Semua referensi yang tercatat pada snapshot ini memiliki target terbukti.</p>}
    <p>Perbaikan resolver berlaku pada analisis baru. Hasil tersimpan mempertahankan snapshot dan provenance versi aslinya.</p>
  </details>;
}
