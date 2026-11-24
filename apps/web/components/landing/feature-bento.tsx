import { PHASE_C_ADD } from "@sage/documents/phase-c-add";
import { Icon } from "../design-system/icons.tsx";
import styles from "./landing.module.css";

/** Potongan matriks CRUD ADD (data contoh statis, struktur sama dengan bagian dokumen nyata). */
const crud = {
  entities: ["Book", "Loan", "Member"],
  rows: [
    { component: "Katalog API", cells: ["CRUD", "R", "—"] },
    { component: "Peminjaman API", cells: ["R", "CRU", "R"] },
    { component: "Anggota API", cells: ["—", "R", "CRUD"] },
  ],
} as const;

const nodeKinds = [
  { kind: "Route handler", count: 9 },
  { kind: "Function", count: 48 },
  { kind: "Class", count: 12 },
] as const;

/** Bento fitur: ADD baseline (kartu besar) + Code Knowledge Graph + Riwayat & ekspor. */
export function FeatureBento() {
  const sections = PHASE_C_ADD.sections;
  return <div className={styles.bento}>
    <article className={`${styles.bentoCard} ${styles.bentoLarge}`}>
      <p className={styles.bentoKicker}><Icon name="fileText" />TOGAF ADD baseline</p>
      <h3 className={styles.bentoTitle}>Data &amp; Application Architecture tersusun dari satu commit, lengkap dengan katalog dan matriks</h3>
      <p className={styles.bentoText}>Setiap baris dokumen menunjuk ke file dan baris sumbernya, siap ditinjau lalu diekspor.</p>
      <figure className={styles.docSnippet} aria-label={`Contoh potongan dokumen: ${sections.dataCrudMatrix.title}`}>
        <figcaption className={styles.docHeading}><span className={styles.docNumber}>2.5</span>{sections.dataCrudMatrix.title}</figcaption>
        <div className={styles.docTableWrap}>
          <table className={styles.docTable}>
            <thead><tr><th scope="col">Application Component</th>{crud.entities.map(entity => <th key={entity} scope="col">{entity}</th>)}</tr></thead>
            <tbody>{crud.rows.map(row => <tr key={row.component}>
              <th scope="row">{row.component}</th>
              {row.cells.map((cell, index) => <td key={crud.entities[index]}>{cell}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        <p className={styles.docEvidence}><Icon name="fileText" />Bukti: src/app/api/loans/route.ts:27</p>
      </figure>
    </article>

    <article className={styles.bentoCard}>
      <p className={styles.bentoKicker}><Icon name="graph" />Code Knowledge Graph</p>
      <h3 className={styles.bentoTitle}>Telusuri setiap simbol sampai baris kode sumbernya</h3>
      <ul className={styles.kindList}>
        {nodeKinds.map(item => <li key={item.kind}><span>{item.kind}</span><span className={styles.kindCount}>{item.count}</span></li>)}
      </ul>
    </article>

    <article className={styles.bentoCard}>
      <p className={styles.bentoKicker}><Icon name="history" />Riwayat &amp; ekspor</p>
      <h3 className={styles.bentoTitle}>Setiap analisis terkunci ke SHA dan bisa diekspor ke PDF atau Markdown</h3>
      <div className={styles.historyRow}>
        <span className={styles.historyRepo}>acme/perpustakaan</span>
        <span className={styles.historySha}>4f2c9e1</span>
        <span className={styles.historyFormats}><Icon name="download" />PDF · Markdown</span>
      </div>
    </article>
  </div>;
}
