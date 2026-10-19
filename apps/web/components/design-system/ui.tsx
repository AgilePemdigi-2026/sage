"use client";

import Link from "next/link";
import { useState } from "react";
import assetManifest from "../../public/design/figma/manifest.json";
import styles from "./ui.module.css";

type AssetRecord = { src: string; width: string; height: string };
const assets = assetManifest as Record<string, Record<string, AssetRecord>>;

export function DesignFrame({ children, active = "none", preview = false }: {
  children: React.ReactNode;
  active?: "repositories" | "history" | "none";
  preview?: boolean;
}) {
  const prefix = preview ? "/preview" : "/workspace";
  return <div className={styles.frame}>
    <a className={styles.skip} href="#main-content">Lewati navigasi</a>
    <header className={styles.header}>
      <Link className={styles.brand} href={preview ? "/" : "/workspace"} aria-label="SAGE, halaman utama">SAGE<span>.</span></Link>
      <nav className={styles.nav} aria-label="Navigasi utama">
        {preview ? <>
          <Link href="/preview/progress">Progres</Link>
          <Link href="/preview/history" aria-current={active === "history" ? "page" : undefined}>Riwayat</Link>
          <Link href="/preview/graph?analysis=fixture-report">Knowledge Graph</Link>
          <Link href="/preview/document?analysis=fixture-report">Dokumentasi</Link>
        </> : <>
          <Link href={`${prefix}/repositories`} aria-current={active === "repositories" ? "page" : undefined}>Repositories</Link>
          <Link href="/preview/history" aria-current={active === "history" ? "page" : undefined}>Riwayat <span className={styles.navNote}>pratinjau</span></Link>
          <Link href="/preview/progress">Pratinjau</Link>
        </>}
      </nav>
      {preview ? <span className={styles.headerTag}>Mode pratinjau</span> : null}
    </header>
    <main className={styles.main} id="main-content" tabIndex={-1}>
      {preview ? <div className={styles.fixtureNotice} role="note">
        <span className={styles.noticeMark} aria-hidden="true">i</span>
        <p><strong>Data contoh, bukan hasil analisis.</strong> Layar ini memakai fixture lokal yang tidak terhubung ke GitHub dan tidak menjalankan job.</p>
      </div> : null}
      {children}
    </main>
  </div>;
}

export function Panel({ title, children, className }: { title?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={[styles.panel, className].filter(Boolean).join(" ")}>
    {title ? <h2 className={styles.panelTitle}>{title}</h2> : null}
    {children}
  </section>;
}

export function Badge({ tone = "neutral", children }: { tone?: "info" | "success" | "warning" | "error" | "neutral"; children: React.ReactNode }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{children}</span>;
}

export function CopySha({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  return <div className={styles.copySha}>
    <code>{sha}</code>
    <button type="button" onClick={() => void copy()} aria-label="Salin SHA lengkap">{copied ? "Tersalin" : "Salin"}</button>
  </div>;
}

export function AssetIcon({ group, name, className }: { group: string; name: string; className?: string }) {
  const record = assets[group]?.[name];
  if (!record) return null;
  // eslint-disable-next-line @next/next/no-img-element -- Local Figma SVGs keep their manifest dimensions.
  return <img
    className={className}
    src={record.src}
    width={Number(record.width)}
    height={Number(record.height)}
    alt=""
    aria-hidden="true"
  />;
}
