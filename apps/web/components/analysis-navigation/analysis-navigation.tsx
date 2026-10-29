import Link from "next/link";
import styles from "./analysis-navigation.module.css";

/** Stable destinations for one analysis; result links never replace owner checks. */
export function AnalysisNavigation({ analysisId, active, resultsAvailable = true }: {
  analysisId: string;
  active: "progress" | "graph" | "document";
  resultsAvailable?: boolean;
}) {
  const base = `/analyses/${encodeURIComponent(analysisId)}`;
  const items = [
    { id: "progress", label: "Progres", href: base, glyph: "01" },
    { id: "graph", label: "Knowledge graph", href: `${base}/graph`, glyph: "02" },
    { id: "document", label: "Dokumentasi", href: `${base}/document`, glyph: "03" },
  ];
  return <nav className={styles.navigation} aria-label="Navigasi hasil analisis">
    {items.map(item => item.id !== "progress" && !resultsAvailable
      ? <span key={item.id} className={styles.pending} aria-disabled="true"><span aria-hidden="true">{item.glyph}</span>{item.label}<small>Menunggu hasil</small></span>
      : <Link key={item.id} href={item.href} prefetch={false} aria-current={item.id === active ? "page" : undefined}>
        <span aria-hidden="true">{item.glyph}</span>{item.label}
      </Link>)}
  </nav>;
}
