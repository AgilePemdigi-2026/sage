import type { Metadata } from "next";
import Link from "next/link";
import { Badge, DesignFrame, Panel } from "../../../components/design-system/ui";
import { DocumentPreview } from "../../../components/sprint-ui/document-preview";
import styles from "../../../components/sprint-ui/document-preview.module.css";
import { createPreviewData } from "../fixture-data";

export const metadata: Metadata = {
  title: "SAGE — Pratinjau dokumen arsitektur",
  description: "Pratinjau dokumen arsitektur dengan data fixture yang divalidasi.",
  robots: { index: false, follow: false },
};

type DocumentPreviewPageProps = {
  searchParams: Promise<{ analysis?: string | string[] }>;
};

export default async function DocumentPreviewPage({ searchParams }: DocumentPreviewPageProps) {
  const params = await searchParams;
  const analysis = params.analysis;
  const knownAnalysis = analysis === undefined || analysis === "fixture-report";

  return <DesignFrame preview>
    {knownAnalysis ? <DocumentPreview data={createPreviewData()} /> : <Panel title="Dokumen tidak tersedia">
      <div className={styles.stateCard}>
        <Badge tone="warning">Analisis tidak ditemukan</Badge>
        <p>Pratinjau dokumen tidak memuat analisis <code>{Array.isArray(analysis) ? analysis.join(", ") : analysis}</code>. Konteks ini tidak cocok dengan fixture yang tersedia.</p>
        <Link href="/preview/document?analysis=fixture-report">Buka dokumen fixture yang tervalidasi</Link>
      </div>
    </Panel>}
  </DesignFrame>;
}
