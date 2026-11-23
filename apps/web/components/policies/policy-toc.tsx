"use client";

import { SideLink, useVisibleSection } from "../design-system/ui.tsx";
import styles from "./policies.module.css";

const SECTIONS = [
  { id: "privasi", label: "Privasi" },
  { id: "ketentuan", label: "Ketentuan layanan" },
  { id: "pengembalian-dana", label: "Pengembalian dana" },
  { id: "cookie", label: "Cookie" },
  { id: "penghapusan", label: "Penghapusan data" },
] as const;

const IDS = SECTIONS.map(section => section.id);

/** Daftar isi sticky /policies; item aktif mengikuti bagian yang sedang dibaca (scrollspy kit). */
export function PolicyToc() {
  const active = useVisibleSection(IDS);
  return <nav className={styles.toc} aria-label="Daftar kebijakan">
    <p className={styles.tocLabel}>Daftar isi</p>
    <ul>
      {SECTIONS.map(section => <li key={section.id}>
        <SideLink href={`#${section.id}`} selected={active === section.id}>{section.label}</SideLink>
      </li>)}
    </ul>
  </nav>;
}
