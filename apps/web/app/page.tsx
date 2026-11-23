import { AssetIcon, Badge, Button, DesignFrame, FeatureCard, Reveal } from "../components/design-system/ui.tsx";
import { loginGatedHref } from "../components/design-system/login-gated.ts";
import { readHeaderAccount } from "../lib/auth/header-account.ts";
import styles from "../components/landing/landing.module.css";

const DOCS_BASE = "https://github.com/AgilePemdigi-2026/sage/blob/main/docs";

const trust = [
  { icon: "imgTrustStatic", label: "Analisis statis, kode tidak dijalankan" },
  { icon: "imgTrustToken", label: "Token hanya di server" },
  { icon: "imgTrustSha", label: "Terkunci ke full SHA" },
] as const;

const dataObjects = [
  { name: "Buku", table: "Buku", tone: "teal", status: "Exact" },
  { name: "Anggota", table: "Anggota", tone: "teal", status: "Exact" },
  { name: "Transaksi", table: "Transaksi", tone: "warning", status: "Perlu cek" },
] as const;

const features = [
  { number: "01", icon: "imgFeatureData", title: "Baseline Data Architecture", text: "Data object, relasi, katalog, dan CRUD yang didukung bukti repository." },
  { number: "02", icon: "imgFeatureApplication", title: "Baseline Application Architecture", text: "Portofolio komponen, interface API, dan relasi source yang dikenali." },
  { number: "03", icon: "imgFeatureGraph", title: "Code Knowledge", text: "Graph struktur kode untuk menelusuri node, relasi, dan source preview." },
] as const;

const steps = [
  { number: "01", icon: "imgGithub", title: "Masuk GitHub", text: "Hubungkan akun lewat GitHub App. Token disimpan dan dipakai hanya di server." },
  { number: "02", icon: "imgTrustSha", title: "Pilih repo & commit", text: "Tentukan repository dan branch. Commit di-resolve ke full SHA agar hasil dapat ditelusuri ulang." },
  { number: "03", icon: "imgTrustStatic", title: "Analisis 9 tahap", text: "Snapshot dibaca secara statis tanpa menjalankan kode. Pantau status setiap tahap sampai selesai." },
  { number: "04", icon: "imgFeatureData", title: "Baca & ekspor ADD", text: "Tinjau baseline Architecture Definition Document beserta evidence-nya, lalu ekspor ke PDF atau Markdown." },
] as const;

const guides: ReadonlyArray<{ icon: string; group?: string; title: string; text: string; href: string }> = [
  { icon: "imgFeatureApplication", title: "Panduan penggunaan", text: "Alur dari masuk, memilih repository, sampai membaca dan mengekspor hasil.", href: `${DOCS_BASE}/guides/USAGE.md` },
  { icon: "imgGithub", title: "Setup GitHub App", text: "Membuat dan menghubungkan GitHub App untuk menjalankan SAGE secara lokal.", href: `${DOCS_BASE}/guides/GITHUB_APP_SETUP.md` },
  { icon: "code", group: "icons", title: "Batas analyzer", text: "Bahasa dan pola yang didukung, serta yang masih dapat belum terpetakan.", href: `${DOCS_BASE}/reference/ANALYSIS_SPEC.md` },
  { icon: "imgFeatureData", title: "Isi Architecture Definition Document", text: "Struktur Architecture Definition Document yang disusun dari hasil analisis.", href: `${DOCS_BASE}/reference/TOGAF_ADD.md` },
] as const;

export default async function Home() {
  const signedIn = Boolean(await readHeaderAccount());
  return <DesignFrame active="home">
    <section className={styles.hero} aria-labelledby="hero-heading">
      <div className={styles.copy}>
        <p className={styles.label}>Dokumentasi arsitektur berbasis source code</p>
        <h1 id="hero-heading" className={styles.title}>From Repository to Architecture Definition Document, <span className={styles.titleAccent}>with Evidence</span></h1>
        <p className={styles.lead}>SAGE membaca commit GitHub-mu, membangun Code Knowledge Graph, lalu menyusun baseline TOGAF Phase C dengan tautan ke baris kode sumbernya.</p>
        <div className={styles.actions}>
          <Button href={loginGatedHref("/workspace/repositories", signedIn)} size="lg" arrow>Analisis repository</Button>
          <Button href="#cara-kerja" variant="secondary" size="lg">Lihat cara kerja</Button>
        </div>
        <ul className={styles.trust}>
          {trust.map(item => <li key={item.icon}><AssetIcon group="landing" name={item.icon} />{item.label}</li>)}
        </ul>
      </div>

      <div className={styles.illustration} aria-hidden="true">
        <span className={styles.glow} />
        <div className={styles.window}>
          <div className={styles.windowBar}>
            <span className={styles.dot} /><span className={styles.dot} /><span className={styles.dot} />
            <span className={styles.fileName}>add-baseline.md</span>
          </div>
          <div className={styles.windowBody}>
            <p className={styles.label}>3 · Business Data Model</p>
            {dataObjects.map(item => <div key={item.name} className={styles.dataRow}>
              <span className={styles.dataIcon}><AssetIcon group="landing" name="imgDataObject" /></span>
              <span className={styles.dataName}>{item.name}</span>
              <span className={styles.dataTable}>{item.table}</span>
              <Badge tone={item.tone}>{item.status}</Badge>
            </div>)}
          </div>
        </div>
        <span className={`${styles.chip} ${styles.chipEvidence}`}><AssetIcon group="landing" name="imgEvidence" />app/api/buku/route.ts:31</span>
        <span className={`${styles.chip} ${styles.chipSha}`}><AssetIcon group="landing" name="imgBranch" />main · 08dbdd2</span>
      </div>
    </section>

    <section className={`${styles.block} ${styles.section}`} aria-labelledby="fitur-heading">
      <h2 id="fitur-heading" className={styles.blockTitle}>Dari source code ke dokumen arsitektur</h2>
      <Reveal className={styles.grid3}>
        {features.map(item => <FeatureCard key={item.number} icon={{ group: "landing", name: item.icon }} number={item.number} title={item.title}>{item.text}</FeatureCard>)}
      </Reveal>
    </section>

    <section id="cara-kerja" className={`${styles.block} ${styles.section}`} aria-labelledby="cara-kerja-heading">
      <div className={styles.blockHead}>
        <p className={styles.label}>Cara kerja</p>
        <h2 id="cara-kerja-heading" className={styles.blockTitle}>Empat langkah dari repository ke ADD</h2>
      </div>
      <Reveal as="ol" className={styles.grid4}>
        {steps.map(item => <li key={item.number}><FeatureCard icon={{ group: "landing", name: item.icon }} number={item.number} title={item.title}>{item.text}</FeatureCard></li>)}
      </Reveal>
    </section>

    <section id="dokumentasi" className={`${styles.block} ${styles.section}`} aria-labelledby="dokumentasi-heading">
      <div className={styles.blockHead}>
        <p className={styles.label}>Dokumentasi</p>
        <h2 id="dokumentasi-heading" className={styles.blockTitle}>Panduan dan referensi</h2>
        <p className={styles.blockLead}>Dokumentasi lengkap tersedia di repository GitHub SAGE.</p>
      </div>
      <Reveal as="ul" className={styles.grid4}>
        {guides.map(item => <li key={item.title}><FeatureCard icon={{ group: item.group ?? "landing", name: item.icon }} title={item.title} href={item.href} linkLabel="Baca di GitHub">{item.text}</FeatureCard></li>)}
      </Reveal>
    </section>
  </DesignFrame>;
}
