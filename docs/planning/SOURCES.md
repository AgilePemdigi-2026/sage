# Sumber dan urutan acuan

PDF sumber dicatat pada 18 Oktober 2026; Figma diperiksa ulang pada 20 Oktober 2026 (Asia/Jakarta).

## Urutan acuan

1. Keputusan project terbaru yang disepakati dan dicatat di [DECISIONS.md](DECISIONS.md).
2. Requirement SRS yang tidak diubah oleh keputusan terbaru.
3. Alur dan state pada dokumen mockup serta Figma.
4. Sprint planning awal sebagai catatan estimasi dan pembagian historis.
5. Rancangan teknis dalam dokumentasi ini; statusnya dibedakan dari keputusan pengguna dan bukti implementasi.

Instruksi di dalam sumber diperlakukan sebagai materi spesifikasi. Aktivitas implementasi, konfigurasi akun, perubahan GitHub, dan klaim progres harus memiliki dasar pekerjaan aktual.

## Dokumen PDF

PDF sumber diperiksa dari salinan yang disediakan pemilik project. File sumber tidak disalin ke repository publik ini; identitas berikut memungkinkan tim memastikan salinan yang digunakan sama.

| ID | Nama file | Halaman | SHA-256 |
| --- | --- | --- | --- |
| SRC-SRS | `UTS_I2_SAGE_SRS (1).pdf` | 97 | `a67dc515d289f0cff287408c0d34aba4434e27a06059af5bb8c9850011a86076` |
| SRC-UI | `UTS_I2_SAGE_DATA (1).pdf` | 23 | `aa446d05a909e7cb6d589b973b234a6f5606c1e0fd0d82541972cd984503a46e` |
| SRC-SPRINT | `Kelompok4_I2_SprintPlanning (1).pdf` | 6 | `32e3c0689a705ab3003b471f7bb8ccaf5477ff56ebff7b3be7c42cf6202d9174` |

SRC-SRS menyediakan 72 identifier functional requirement. SRC-UI menjelaskan prototype dan data contoh, bukan bukti layanan analisis atau ekspor yang telah berjalan. SRC-SPRINT memperkirakan total 20 bobot effort dengan pembagian awal 6/7/7; angka tersebut adalah estimasi historis. Target feature-complete Sprint 2 dan paket UI Sprint 1 terbaru dicatat pada [rencana sprint](SPRINT_PLAN.md) serta [backlog](PRODUCT_BACKLOG.md); penugasan child issue tidak menandakan acceptance parent produk selesai.

Gunakan nomor halaman PDF saat merujuk sumber karena nomor cetak SRS berbeda dari indeks PDF. Lampiran SRS yang menyebut `Inferred Static Edge`, filter `Service`, dan halaman detail riwayat harus diselaraskan dengan keputusan terbaru.

## Figma

[Data Mockup SAGE](https://www.figma.com/design/OrNk1caXIrsdC0tG4axfSA/Data-Mockup-SAGE) diperiksa melalui browser pada 18 Oktober 2026 dan enam screen dikonfirmasi ulang melalui MCP pada 20 Oktober. Node baseline-nya `47:4`, `57:102`, `65:875`, `79:1222`, `117:2116`, dan `119:7425`. File memiliki halaman `01 Foundations`, `02 Components`, `03 SAGE Patterns`, dan `04 Screens`.

Foundations bertajuk design system v0.1; palet kategori AST masih provisional dan wordmark masih draft. Pemeriksaan ini mencakup foundations, inventaris komponen/pattern, dan state screen; bukan pengujian otomatis seluruh koneksi prototype atau binding variabel. Aset hasil ekstraksi disimpan di `apps/web/public/design/figma/`; contoh graph 37 node/88 edge pada Figma merupakan data ilustrasi, bukan oracle analyzer. Pratinjau UI saat ini memakai fixture CCM terpisah dengan 10 node/9 edge.

## Referensi teknis

| Topik | Referensi resmi |
| --- | --- |
| Next.js dan deployment | [Next.js deployment](https://nextjs.org/docs/app/getting-started/deploying) |
| Database dan ORM | [Prisma ORM](https://docs.prisma.io/docs/orm/core-concepts/supported-databases) |
| Analyzer JavaScript/TypeScript | [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) |
| Analyzer PHP | [nikic/PHP-Parser](https://github.com/nikic/PHP-Parser) |
| Graph interaktif | [Cytoscape.js](https://js.cytoscape.org/) |
| PDF | [Playwright page.pdf](https://playwright.dev/docs/api/class-page#page-pdf) |
| Lingkungan lokal | [Docker Compose](https://docs.docker.com/compose/) |
| GitHub App | [GitHub Apps dan OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps) |
| Issue dan PR | [Menghubungkan PR ke issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue) |
| Commit | [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) |
| Kandidat renderer diagram statis | [Mermaid usage](https://mermaid.js.org/config/usage.html) |

Referensi teknis diverifikasi pada percakapan planning, tetapi versi package belum dipin. Perubahan mayor Compiler API dan ORM harus diperiksa kembali saat compatibility spike; gunakan versi stabil yang kompatibel, image yang dipin, dan lockfile.
