"use client";

/* Layout dokumen ADD (Figma frame 05, 253:143): daftar isi, metrik, dan panel bagian aktif.
   Semua angka diturunkan dari model ADD + overlay review yang sudah ada; tidak ada data baru. */
import { useRef } from "react";
import type { AddBaselineModel, AddElement } from "@sage/documents/baseline-add-model";
import type { AddReviewOverlay } from "@sage/documents/add-overlay";
import { PHASE_C_ADD_TOC } from "@sage/documents/phase-c-add";
import { Badge, SideLink } from "../design-system/ui.tsx";
import doc from "./add-document.module.css";

type ElementType = AddElement["type"];

/** Bagian yang memiliki elemen source untuk direview, dipetakan ke tipe elemen ArchiMate. */
const SECTION_ELEMENTS: Record<string, readonly ElementType[]> = {
  "business-data-model": ["DataObject"],
  "logical-data-model": ["DataObject"],
  "data-crud-matrix": ["DataObject", "ApplicationComponent"],
  "application-design": ["ApplicationComponent"],
  "application-catalog": ["ApplicationComponent"],
  "logical-application-components": ["ApplicationFunction", "ApplicationService"],
  "interface-catalog": ["ApplicationInterface"],
  "application-interactions": ["ApplicationComponent"],
};

const EXTRA_ITEMS = [
  { id: "source-notes", label: "Source and analysis notes" },
  { id: "review", label: "Review" },
] as const;

/** Id yang dipantau IntersectionObserver untuk menyorot daftar isi. Grup (level 1) tidak dipantau karena membungkus
 *  semua subbagiannya dan akan selalu "paling terlihat". */
export const DOCUMENT_SECTION_IDS: readonly string[] = [
  ...PHASE_C_ADD_TOC.filter(item => item.level === 2).map(item => item.id),
  ...EXTRA_ITEMS.map(item => item.id),
];

function sectionLabel(id: string): string {
  return PHASE_C_ADD_TOC.find(item => item.id === id)?.label ?? EXTRA_ITEMS.find(item => item.id === id)?.label ?? id;
}

function TocList({ activeId, onNavigate }: { activeId: string; onNavigate?: () => void }) {
  return <ol className={doc.tocList}>
    {PHASE_C_ADD_TOC.filter(item => item.level >= 1).map(item => item.level === 1
      ? <li key={item.id} className={doc.tocGroup}><a href={`#${item.id}`} onClick={onNavigate}>{item.label}</a></li>
      : <li key={item.id} onClick={onNavigate}><SideLink href={`#${item.id}`} selected={activeId === item.id} className={doc.tocLink}>{item.label}</SideLink></li>)}
    <li className={doc.tocGroup}><span>Lampiran</span></li>
    {EXTRA_ITEMS.map(item => <li key={item.id} onClick={onNavigate}><SideLink href={`#${item.id}`} selected={activeId === item.id} className={doc.tocLink}>{item.label}</SideLink></li>)}
  </ol>;
}

/** Daftar isi: sticky di desktop, dropdown <details> di bawah 1060 px. */
export function DocumentToc({ activeId }: { activeId: string }) {
  const mobile = useRef<HTMLDetailsElement>(null);
  return <>
    <nav className={doc.toc} aria-label="Daftar isi dokumen" data-print-hide>
      <p className={doc.tocTitle}>Daftar isi</p>
      <TocList activeId={activeId} />
    </nav>
    <details ref={mobile} className={doc.tocMobile} data-print-hide>
      <summary><span>Daftar isi</span><span className={doc.tocCurrent}>{sectionLabel(activeId)}</span></summary>
      <nav aria-label="Daftar isi dokumen (ringkas)"><TocList activeId={activeId} onNavigate={() => { if (mobile.current) mobile.current.open = false; }} /></nav>
    </details>
  </>;
}

function countReview(elements: readonly AddElement[]) {
  return {
    total: elements.length,
    confirmed: elements.filter(item => item.review === "confirmed").length,
    rejected: elements.filter(item => item.review === "rejected").length,
    evidence: elements.reduce((sum, item) => sum + item.evidence.length, 0),
  };
}

/** Metrik ringkas di atas dokumen (Figma: kartu angka). */
export function DocumentMetrics({ model }: { model: AddBaselineModel }) {
  const all = countReview(model.elements);
  const metrics = [
    { value: model.elements.filter(item => item.type === "DataObject").length, label: "Data object" },
    { value: model.elements.filter(item => item.type === "ApplicationInterface").length, label: "Interface" },
    { value: all.total, label: "Elemen untuk direview" },
    { value: all.confirmed + all.rejected, label: "Sudah direview" },
  ];
  return <ul className={doc.metrics} aria-label="Ringkasan isi dokumen" data-print-hide>
    {metrics.map(metric => <li key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></li>)}
  </ul>;
}

/** Panel kanan untuk bagian aktif: status review + evidence untuk elemen di bagian itu. */
export function ActiveSectionPanel({ activeId, model, overlay }: { activeId: string; model: AddBaselineModel; overlay: AddReviewOverlay }) {
  const types = SECTION_ELEMENTS[activeId];
  const elements = types ? model.elements.filter(item => types.includes(item.type)) : [];
  const stats = countReview(elements);
  const all = countReview(model.elements);
  const reviewedShare = all.total ? Math.round(((all.confirmed + all.rejected) / all.total) * 100) : 0;
  return <section className={doc.panel} aria-labelledby="active-section-title">
    <div className={doc.panelHead}>
      <p className={doc.label}>Di bagian ini</p>
      <span key={`${overlay.status}-${overlay.revision}`} className={doc.reviewStatus}>
        <Badge tone={overlay.status === "reviewed" ? "success" : "warning"}>{overlay.status === "reviewed" ? "Direview" : "Draft"} · revisi {overlay.revision}</Badge>
      </span>
    </div>
    <div key={activeId} className={doc.panelBody}>
      <h2 id="active-section-title" className={doc.panelTitle}>{sectionLabel(activeId)}</h2>
      {types && stats.total > 0 ? <dl className={doc.stats}>
        <div><dt>Elemen source</dt><dd>{stats.total}</dd></div>
        <div><dt>Dikonfirmasi</dt><dd>{stats.confirmed}</dd></div>
        <div><dt>Ditolak</dt><dd>{stats.rejected}</dd></div>
        <div><dt>Evidence</dt><dd>{stats.evidence}</dd></div>
      </dl> : <p className={doc.note}>Bagian ini naratif atau memerlukan input enterprise; tidak ada elemen source yang perlu direview di sini.</p>}
    </div>
    <div className={doc.progress}>
      <div className={doc.progressHead}><span>Progres review dokumen</span><span>{all.confirmed + all.rejected} / {all.total}</span></div>
      <div className={doc.progressTrack} role="progressbar" aria-label="Progres review dokumen" aria-valuemin={0} aria-valuemax={all.total} aria-valuenow={all.confirmed + all.rejected}><span style={{ width: `${reviewedShare}%` }} /></div>
    </div>
    <a className={doc.reviewLink} href="#review">Buka panel review elemen</a>
  </section>;
}
