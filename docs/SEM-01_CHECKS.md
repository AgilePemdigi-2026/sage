# SEM-01 — Fitur, alur pengguna, dan knowledge graph

Tanggal verifikasi: 30 Oktober 2026. Acuan source ditetapkan sebelum renderer pada [oracle](evidence/semantic/oracle.json) dan [storyboard](SEMANTIC_STORYBOARD.md). Hasil ini mencakup implementasi lokal dan fixture; tidak membuktikan deployment Coolify atau seluruh perilaku runtime repository target.

## Perubahan

- Model semantik canonical terpisah dari CCM/CKG: aktor, fitur, konsep domain, komponen utama, penyimpanan, tindakan, keputusan dan hasil. Semua fakta/relasi memiliki evidence. `Terbukti`/`Indikasi` terpisah dari resolver `Exact`/`Unresolved`.
- Next.js App Router memakai AST dan binding statis; Laravel memakai route/group/middleware/controller/model/service yang dapat ditelusuri. Import saja tidak menjadi alur. Callback/wrapper/data client yang belum sepenuhnya terverifikasi tetap indikasi dengan alasan. Backend Emosync tidak memperoleh layar frontend rekaan.
- Overview fitur menuju detail alur. Graph menampilkan cluster lingkaran fitur yang diperluas menjadi konsep/komponen/store; helper, properti dan konfigurasi bukan node utama. Pencarian, tetangga, filter indikasi, zoom, keyboard dan jumlah detail tersembunyi tersedia.
- Overlay label/kelompok disimpan sebagai revisi append-only. Lock analisis lalu model mengikuti urutan ekspor; revisi lama ditolak 409. Model source tidak ditulis ulang. Pemilik lain tidak dapat membaca/mengubah hasil.
- Ekspor mem-pin model dan revisi pada antrean/cache. PDF memakai halaman A4 vektor, maksimal 12 node per bagian, mengemas alur kecil dan tidak mengulang seluruh subtree endpoint bersama. Hubungan antarhalaman dihitung; tidak ada panah pengganti. Markdown mempertahankan seluruh model semantik dan register teknis ADD.
- Hasil legacy tetap tersedia dengan keterangan analisis ulang untuk kemampuan semantik baru.

## Pemeriksaan yang lulus

| Pemeriksaan | Hasil dan lingkup |
| --- | --- |
| `npm run check` | Lint, TypeScript, 475 tes unit dan 8 tes unit database lulus. |
| `npm run build` | Build produksi Next.js lulus. |
| Acuan source | 39/39 pemeriksaan positif/negatif pada tiga snapshot beku; [laporan](evidence/semantic/oracle-check-report.json). Hash file, rentang baris, identitas snapshot dan makna terbatas diperiksa; repository target tidak dijalankan. |
| Replay analyzer | Model deterministik terhadap urutan source; seluruh span diperiksa terhadap byte dan hash file. |
| PostgreSQL terisolasi | Penyimpanan/koreksi 1 tes; pipeline 2 tes; cleanup 3 tes; worker ekspor 1 tes lulus. Meliputi konflik dua penulis, barrier ekspor/koreksi bersamaan, isolasi owner, revisi historis, cache pin, Markdown/PDF dan ekspor legacy. |
| BDD semantik | 3 skenario, 17 langkah lulus; Gherkin Inggris dengan parameter berpetik. Ini suite kontrak source/presentasi, bukan OAuth live. |
| Playwright | Navigasi overview/detail, ekspansi cluster, pencarian/fokus, zoom/reset, keyboard, koreksi label/kelompok/reset, konflik/reload, indikasi, viewport desktop/mobile, pergantian akun tertunda, graph teknis 503 dan 101 file evidence diperiksa. |
| Model Perpus pada browser | Model tersimpan 616 node / 653 edge / 17 fitur dipakai untuk Auth, Bookings dan Books, termasuk evidence commit/baris dan overflow. API diintersep; bukan analisis baru melalui worker/database. |
| PDF visual | Halaman A4 landscape, diagram vektor tanpa bitmap, label aman, sumber terhubung dan batas antarhalaman. Perpus 87 halaman; Emosync 42 halaman. Jumlah halaman mengikuti seluruh alur yang dikenali, bukan satu gambar aplikasi yang diperkecil. |

Harness Playwright membuat salinan aplikasi sementara. Browser memakai alias konstanta validator yang dihasilkan dari ekspor aktual `@sage/contracts` untuk menghindari import server `node:crypto` pada Webpack QA; komponen yang diuji dan konfigurasi produk tidak diganti. Build produksi memeriksa bundle sebenarnya. Respons sesi/model/koreksi dikontrol fixture; tes PostgreSQL/worker memeriksa integrasi terpisah. Tidak ada klaim bahwa browser fixture menjalankan login provider nyata.

## Pengukuran resource dan kegagalan

Container lokal Colima Linux ARM64: 2 GiB RAM, 1,5 CPU, tanpa jaringan; batas resource aplikasi tidak dinaikkan. Analisis dan ekspor memakai proses/container terpisah. Pengukuran source yang sudah selesai digunakan ulang secara eksplisit untuk rerun renderer pada hash model yang sama; bukan analisis ulang tersembunyi. RSS proses berbeda dari charged memory cgroup. [Laporan lengkap](evidence/semantic/resource-report.json) mempertahankan keduanya.

| Snapshot | Source analyzer | Semantik | Ukuran model | Markdown | PDF |
| --- | ---: | ---: | ---: | ---: | ---: |
| Perpus `d72c353` | 2,20 s | 0,46 s | 882.540 B | 12.624.191 B | 2.260.062 B, lulus |
| SAGE `c2dc3d8` | 89,24 s | 1,07 s | 291.947 B | Gagal sebelum artefak lengkap | Gagal sebelum artefak lengkap |
| Emosync `a229926` | 4,41 s | 0,22 s | 381.430 B | 4.815.631 B | 385.207 B, lulus |

**Batas yang belum terselesaikan:** proses ekspor lengkap SAGE berhenti dengan V8 heap limit (exit 134) pada proyeksi/register dokumen teknis besar. Source/model semantiknya lulus, tetapi ekspor lengkapnya tidak lulus. Peak memori proses yang abort tidak tersedia dan tidak diisi angka perkiraan. Percobaan awal juga gagal; [catatan awal](evidence/semantic/initial-resource-failure.json) tetap disimpan. Salinan proyeksi yang berulang serta overflow argument Markdown sudah dikurangi/diperbaiki, tanpa menaikkan batas heap, RAM, ukuran PDF atau artefak. Ini belum memenuhi penerimaan ekspor untuk corpus SAGE besar dan bukan bukti kesiapan deployment.

Alur Books Perpus masih padat: cabang source yang tidak sepenuhnya terverifikasi tetap indikasi. Label inline disembunyikan pada alur padat; judul relasi, alasan dan evidence tersedia pada panel. Model adalah penjelasan hubungan statis dengan batas yang dicatat, bukan jaminan seluruh kontrol alur runtime atau seluruh framework PHP.

## Menjalankan ulang

```bash
npm run semantic:prepare
npm run test:semantic
npm run test:bdd:semantic
npm run test:semantic:ui
python3 scripts/run-semantic-benchmarks.py artifacts/semantic/run-new --image sage-semantic-qa:local --render
npm run semantic:check-oracles -- artifacts/semantic/run-new
```

Bangun image QA dengan target `bdd` sesuai [kontrak semantik](SEMANTIC_ANALYSIS.md). Gunakan direktori output baru; runner keluar nonzero bila satu corpus gagal. `--reuse-core-from <direktori>` hanya untuk rerun renderer dari hasil source yang berhasil pada commit/model hash yang sama dan dicatat pada laporan. Tes integrasi memerlukan database QA terpisah dan flag eksplisit; jangan menunjuknya ke database aplikasi.
