import { Button, DesignFrame, FeatureCard, Reveal } from "../components/design-system/ui.tsx";
import { Icon, type IconName } from "../components/design-system/icons.tsx";
import { loginGatedHref } from "../components/design-system/login-gated.ts";
import { readHeaderAccount } from "../lib/auth/header-account.ts";
import { ANALYSIS_STAGE_DEFINITIONS } from "@sage/contracts/stages";
import { PHASE_C_ADD } from "@sage/documents/phase-c-add";
import { ProductMockup, type MockupCopy } from "../components/landing/product-mockup.tsx";
import { FeatureBento } from "../components/landing/feature-bento.tsx";
import styles from "../components/landing/landing.module.css";

const DOCS_BASE = "https://github.com/AgilePemdigi-2026/sage/blob/main/docs";

const trust: ReadonlyArray<{ icon: IconName; label: string }> = [
  { icon: "shieldCheck", label: "Analisis statis, kode tidak dijalankan" },
  { icon: "lock", label: "Token hanya di server" },
  { icon: "gitCommit", label: "Terkunci ke full SHA" },
];

/** Teks mockup diambil dari definisi nyata: 9 tahap pipeline dan judul bagian ADD Phase C. */
const mockupCopy: MockupCopy = {
  stages: ANALYSIS_STAGE_DEFINITIONS.map(stage => stage.label),
  viewTitle: PHASE_C_ADD.sections.logicalDataModel.title,
  catalogTitle: PHASE_C_ADD.sections.businessDataModel.title,
};

const steps: ReadonlyArray<{ number: string; icon: IconName; title: string; text: string }> = [
  { number: "01", icon: "logIn", title: "Masuk GitHub", text: "Hubungkan akun lewat GitHub App. Token disimpan dan dipakai hanya di server." },
  { number: "02", icon: "gitBranch", title: "Pilih repo & commit", text: "Tentukan repository dan branch. Commit di-resolve ke full SHA agar hasil dapat ditelusuri ulang." },
  { number: "03", icon: "listChecks", title: "Analisis 9 tahap", text: "Snapshot dibaca secara statis tanpa menjalankan kode. Pantau status setiap tahap sampai selesai." },
  { number: "04", icon: "fileText", title: "Baca & ekspor ADD", text: "Tinjau baseline Architecture Definition Document beserta evidence-nya, lalu ekspor ke PDF atau Markdown." },
];

const guides: ReadonlyArray<{ icon: IconName; title: string; text: string; href: string }> = [
  { icon: "bookOpen", title: "Panduan penggunaan", text: "Alur dari masuk, memilih repository, sampai membaca dan mengekspor hasil.", href: `${DOCS_BASE}/guides/USAGE.md` },
  { icon: "key", title: "Setup GitHub App", text: "Membuat dan menghubungkan GitHub App untuk menjalankan SAGE secara lokal.", href: `${DOCS_BASE}/guides/GITHUB_APP_SETUP.md` },
  { icon: "code", title: "Batas analyzer", text: "Bahasa dan pola yang didukung, serta yang masih dapat belum terpetakan.", href: `${DOCS_BASE}/reference/ANALYSIS_SPEC.md` },
  { icon: "fileText", title: "Isi Architecture Definition Document", text: "Struktur Architecture Definition Document yang disusun dari hasil analisis.", href: `${DOCS_BASE}/reference/TOGAF_ADD.md` },
] as const;

export default async function Home() {
  const signedIn = Boolean(await readHeaderAccount());
  return <DesignFrame active="home">
    <section className={styles.hero} aria-labelledby="hero-heading">
      <div className={styles.copy}>
        <h1 id="hero-heading" className={styles.title}>From Repository to Architecture Definition Document, <span className={styles.titleAccent}>with Evidence</span></h1>
        <p className={styles.lead}>SAGE membaca commit GitHub-mu, membangun Code Knowledge Graph, lalu menyusun baseline TOGAF Phase C dengan tautan ke baris kode sumbernya.</p>
        <div className={styles.actions}>
          <Button href={loginGatedHref("/workspace/repositories", signedIn)} size="lg" arrow>Analisis repository</Button>
          <Button href="#cara-kerja" variant="secondary" size="lg">Lihat cara kerja</Button>
        </div>
        <ul className={styles.trust}>
          {trust.map(item => <li key={item.icon}><Icon name={item.icon} />{item.label}</li>)}
        </ul>
      </div>
      <p className={styles.srOnly}>Ilustrasi produk: progres analisis sembilan tahap selesai, potongan dokumen TOGAF ADD dengan diagram ArchiMate, lalu node Code Knowledge dengan evidence src/app/api/books/route.ts baris 12.</p>
      <ProductMockup copy={mockupCopy} />
    </section>

    <section className={`${styles.block} ${styles.section}`} aria-labelledby="fitur-heading">
      <h2 id="fitur-heading" className={styles.blockTitle}>Dari source code ke dokumen arsitektur</h2>
      <FeatureBento />
    </section>

    <section id="cara-kerja" className={`${styles.block} ${styles.section}`} aria-labelledby="cara-kerja-heading">
      <div className={styles.blockHead}>
        <h2 id="cara-kerja-heading" className={styles.blockTitle}>Empat langkah dari repository ke ADD</h2>
      </div>
      <Reveal as="ol" className={styles.grid4}>
        {steps.map(item => <FeatureCard key={item.number} icon={<Icon name={item.icon} />} number={item.number} title={item.title}>{item.text}</FeatureCard>)}
      </Reveal>
    </section>

    <section id="dokumentasi" className={`${styles.block} ${styles.section}`} aria-labelledby="dokumentasi-heading">
      <div className={styles.blockHead}>
        <h2 id="dokumentasi-heading" className={styles.blockTitle}>Panduan dan referensi</h2>
        <p className={styles.blockLead}>Dokumentasi lengkap tersedia di repository GitHub SAGE.</p>
      </div>
      <Reveal as="ul" className={styles.grid4}>
        {guides.map(item => <FeatureCard key={item.title} icon={<Icon name={item.icon} />} title={item.title} href={item.href} linkLabel="Baca di GitHub">{item.text}</FeatureCard>)}
      </Reveal>
    </section>
  </DesignFrame>;
}
