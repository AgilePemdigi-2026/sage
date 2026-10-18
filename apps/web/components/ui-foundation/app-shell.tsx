"use client";
import { useRef, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "./primitives";
import type { Screen } from "./types";
import styles from "./ui-foundation.module.css";
const navigation = [
  { key: "login", label: "Koneksi GitHub", icon: "github", number: "01" },
  { key: "repository", label: "Pilih Repository", icon: "repository", number: "02" },
  { key: "progress", label: "Progres Analisis", icon: "progress", number: "03" },
] as const;
export function AppShell({ screen, onNavigate, children }: { screen: Screen; onNavigate: (screen: Screen) => void; children: ReactNode }) {
  const main = useRef<HTMLElement>(null);
  function navigate(next: Screen) { onNavigate(next); requestAnimationFrame(() => main.current?.focus()); }
  return <div className={styles.shell}>
    <a href="#konten-utama" className={styles.skipLink}>Lewati navigasi</a>
    <aside className={styles.sidebar}>
      <Link className={styles.brand} href="/" aria-label="SAGE, halaman utama">SAGE<span>.</span></Link>
      <p className={styles.brandSubtitle}>Dokumentasi arsitektur<br />berlandaskan source code.</p>
      <p className={styles.navLabel}>ALUR ANALISIS</p>
      <nav className={styles.navigation} aria-label="Navigasi pratinjau">
        {navigation.map(item => <button key={item.key} className={styles.navItem} aria-current={screen === item.key ? "page" : undefined} onClick={() => navigate(item.key)}><Icon name={item.icon} /><span>{item.label}</span><span className={styles.navNumber}>{item.number}</span></button>)}
      </nav>
      <div className={styles.sidebarFoot}><span className={styles.smallDot} aria-hidden="true" /><span>PHP · JavaScript · TypeScript</span></div>
    </aside>
    <div className={styles.workspace}>
      <header className={styles.topbar}><span>Workspace <span className={styles.breadcrumbSlash} aria-hidden="true">/</span> {navigation.find(item => item.key === screen)?.label}</span><span className={styles.previewTag}>Pratinjau UI-01</span></header>
      <main ref={main} id="konten-utama" tabIndex={-1} className={styles.main}>{children}</main>
      <footer className={styles.footer}><span>SAGE · Source-code Architecture Graph Extraction</span><span>Fondasi antarmuka · Sprint 1</span></footer>
    </div>
  </div>;
}
