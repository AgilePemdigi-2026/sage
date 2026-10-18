"use client";

import Link from "next/link";
import type { CcmErrorCode, CcmV1 } from "@sage/contracts";
import { useMemo, useState } from "react";
import ui from "../ui-foundation/ui-foundation.module.css";
import { GraphCanvas } from "./knowledge-graph";
import { projectCcmForGraph } from "./graph-projection";
import styles from "./graph-foundation.module.css";

const categories = [
  { name: "Berkas", className: styles.categoryFile },
  { name: "Struktur", className: styles.categoryStructure },
  { name: "Simbol", className: styles.categorySymbol },
  { name: "Belum terpecahkan", className: styles.categoryUnresolved },
] as const;

export function GraphPreviewClient({ model, validationError }: { model: CcmV1 | null; validationError?: CcmErrorCode }) {
  const graph = useMemo(() => model ? projectCcmForGraph(model) : null, [model]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;

  return <div className={`${ui.shell} ${styles.graphShell}`}>
    <a href="#graph-content" className={ui.skipLink}>Lewati navigasi</a>
    <aside className={ui.sidebar}>
      <Link className={ui.brand} href="/" aria-label="SAGE, halaman utama">SAGE<span>.</span></Link>
      <p className={ui.brandSubtitle}>Dokumentasi arsitektur<br />berlandaskan source code.</p>
      <p className={ui.navLabel}>PRATINJAU</p>
      <nav className={ui.navigation} aria-label="Navigasi pratinjau">
        <Link className={ui.navItem} href="/graph-preview" aria-current="page"><span>Knowledge Graph</span><span className={ui.navNumber}>04</span></Link>
        <Link className={ui.navItem} href="/ui-preview"><span>Alur analisis</span><span className={ui.navNumber}>UI</span></Link>
      </nav>
      <div className={ui.sidebarFoot}><span className={styles.sidebarDot} aria-hidden="true" /><span>PHP · JavaScript · TypeScript</span></div>
    </aside>

    <div className={ui.workspace}>
      <header className={ui.topbar}><span>Workspace <span className={ui.breadcrumbSlash} aria-hidden="true">/</span> Knowledge Graph</span><span className={ui.previewTag}>Pratinjau GRAPH-01</span></header>
      <main id="graph-content" tabIndex={-1} className={`${ui.main} ${styles.graphMain}`}>
        <div className={ui.fixtureBanner}>
          <span className={ui.fixtureDot} aria-hidden="true" />
          <div><strong>{graph ? "Fixture tervalidasi" : "Fixture tidak valid"} · Tidak terhubung ke GitHub</strong><span>Graph ini berasal dari source contoh tetap dan tidak menyajikan hasil analisis repository nyata.</span></div>
        </div>

        <div className={ui.pageHeading}>
          <p className={ui.eyebrow}>04 / KNOWLEDGE GRAPH</p>
          <h1>Jelajahi relasi antar simbol</h1>
          <p className={ui.muted}>Pilih node pada kanvas atau gunakan daftar aksesibel untuk melihat sumber dan konteksnya.</p>
        </div>

        {graph ? <>
          <section className={styles.graphCard} aria-label="Knowledge graph contoh">
            <div className={styles.graphCardHeader}>
              <div>
                <h2>Repository contoh</h2>
                <p className={styles.repositoryPath}>{graph.repository}<span aria-hidden="true"> · </span>{graph.branch ?? "branch tidak diketahui"}</p>
              </div>
              <p className={styles.snapshotLabel}>Snapshot <code>{graph.commitSha}</code></p>
            </div>

            <div className={styles.legend} aria-label="Kategori node dan jenis relasi">
              <div className={styles.categoryLegend}>{categories.map((category) => <span key={category.name} className={styles.legendItem}><i className={`${styles.categoryMark} ${category.className}`} aria-hidden="true" />{category.name}</span>)}</div>
              <div className={styles.edgeLegend}>
                <span className={styles.legendItem}><i className={styles.exactMark} aria-hidden="true" />Exact</span>
                <span className={styles.legendItem}><i className={styles.unresolvedMark} aria-hidden="true" />Unresolved</span>
              </div>
            </div>

            <GraphCanvas graph={graph} selectedId={selectedId} onSelect={setSelectedId} />
          </section>

          <div className={styles.supportGrid}>
            <section className={styles.nodeListCard} aria-labelledby="node-list-heading">
              <div className={styles.sectionHeading}>
                <div><p className={ui.eyebrow}>ALTERNATIF AKSES</p><h2 id="node-list-heading">Daftar node</h2></div>
                <p className={styles.keyboardHint}>Tab lalu Enter atau Spasi untuk memilih.</p>
              </div>
              <div className={styles.nodeList} role="group" aria-label="Pilih node untuk melihat detail">
                {graph.nodes.map((node) => <button key={node.id} type="button" className={styles.nodeOption} aria-pressed={selectedId === node.id} onClick={() => setSelectedId(node.id)}>
                  <span className={`${styles.categoryMark} ${categories.find((item) => item.name === node.category)?.className ?? ""}`} aria-hidden="true" />
                  <span className={styles.nodeOptionCopy}><strong>{node.name}</strong><span>{node.kind} · {node.filePath ? `${node.filePath}${node.line ? `:${node.line}` : ""}` : "tanpa deklarasi source"}</span></span>
                </button>)}
              </div>
            </section>

            <section className={styles.selectedCard} aria-labelledby="selected-node-heading" aria-live="polite">
              <p className={ui.eyebrow}>KONTEKS SUMBER</p>
              <h2 id="selected-node-heading">Node terpilih</h2>
              {selected ? <dl className={styles.nodeDetails}>
                <dt>Nama</dt><dd>{selected.qualifiedName}</dd>
                <dt>Kategori</dt><dd>{selected.category} · {selected.kind}</dd>
                <dt>Source</dt><dd>{selected.filePath ? `${selected.filePath}${selected.line ? `:${selected.line}` : ""}` : "Tidak memiliki deklarasi source; target relasi belum terpecahkan."}</dd>
              </dl> : <p className={styles.emptySelection}>Pilih node untuk melihat lokasi deklarasi yang berasal dari evidence fixture.</p>}
              {validationError && <p className={ui.fieldError}>Validasi fixture gagal: {validationError}</p>}
            </section>
          </div>
        </> : <section className={ui.notice + " " + ui.error} role="alert"><strong>Fixture graph tidak dapat ditampilkan</strong><p>Payload tidak lolos validasi source dan evidence ({validationError ?? "CCM_INPUT_INVALID"}).</p></section>}
      </main>
      <footer className={ui.footer}><span>SAGE · Source-code Architecture Graph Extraction</span><span>Fondasi graph · Sprint 1</span></footer>
    </div>
  </div>;
}
