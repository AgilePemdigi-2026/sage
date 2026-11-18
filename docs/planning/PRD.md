# Product Requirements Document

Status: dokumen ini menyimpan kebutuhan MVP awal dan perlu dibaca bersama [revisi ruang lingkup TOGAF ADD](../reference/TOGAF_ADD.md). Rencana perombakan terbaru menjadikan analisis repository ke baseline ADD sebagai alur utama; Code Knowledge menjadi view pendamping. Status fitur dan bukti pemeriksaan harus dilihat pada catatan bertanggal di [arsip](../archive/README.md), bukan disimpulkan dari target penerimaan di bawah.

## Masalah dan tujuan

Developer perlu memahami struktur dan hubungan dalam source code yang sulit ditelusuri secara manual. Dokumentasi yang terpisah dari implementasi dapat tertinggal. SAGE membantu merekonstruksi struktur tersebut melalui analisis statis, graph yang dapat diperiksa, serta dokumen yang mempertahankan evidence sumber.

Keberhasilan MVP berarti seluruh alur yang disepakati berfungsi dan teruji pada cakupan bahasa/konstruksi yang dicatat. Luas cakupan dilaporkan per kemampuan analyzer. Informasi yang belum dapat dipastikan tetap diberi status `Unresolved`, termasuk ketika bagian lain berhasil dianalisis.

## Pengguna dan akses

Satu kelas pengguna utama: Developer. Semua analisis memerlukan login GitHub agar kepemilikan, history, dan penghapusan memiliki konteks pengguna.

- Repository publik dapat berasal dari akun lain melalui input `owner/repository` atau URL GitHub yang tervalidasi.
- Repository private hanya diambil melalui izin GitHub App yang sesuai dengan akses pengguna dan instalasi.
- Mengetahui ID analisis atau repository tidak memberi akses terhadap hasil milik pengguna lain.
- Aplikasi membaca source; tidak mengubah repository target dan tidak menjalankan kode aplikasi target.

## Alur utama

1. Login GitHub dan menyelesaikan otorisasi yang diperlukan.
2. Memilih repository terotorisasi atau memasukkan repository publik, branch, dan commit opsional.
3. Memvalidasi target; jika commit kosong, resolve HEAD branch sekali saat submission diterima dan simpan full SHA.
4. Menunggu antrean bila worker sedang memproses analisis lain.
5. Memantau sembilan tahap pipeline secara berurutan.
6. Meninjau keterbatasan, Code Knowledge Graph, relasi, dan evidence/source preview.
7. Meninjau baseline Data Architecture dan Application Architecture, lalu mengunduh Markdown atau PDF.
8. Membuka hasil sebelumnya melalui history atau menghapus data analisis milik sendiri.

## Cakupan wajib MVP

| Fitur | Hasil minimum |
| --- | --- |
| GitHub | Login, callback tervalidasi, izin repository, error, dan sesi pengguna |
| Target analisis | Daftar/pencarian repository, public URL, branch, commit opsional, full SHA, dan validasi |
| Pipeline | Snapshot, deteksi bahasa, analisis statis sesuai capability matrix, CCM/CKG, lalu proyeksi baseline ADD |
| Progress | Antrean, tahap aktif, gagal, selesai, dan selesai dengan keterbatasan |
| Graph | Focus/overview/references, pencarian, kategori AST, zoom, inspector, relasi dua arah, evidence, dan source preview |
| Dokumen | TOGAF Phase C baseline Data Architecture dan Application Architecture, katalog, matriks, dan ArchiMate views |
| Ekspor | Markdown dan PDF nyata, state pembuatan, ready, error, serta retry |
| History | Daftar per pengguna, pencarian repository/SHA, navigasi sesuai status, dan empty state |
| Data | Persistensi lintas restart, akses per pengguna, dan penghapusan analisis beserta turunannya |
| UI | Bahasa Indonesia, mobile first, penggunaan laptop/desktop, serta state loading/empty/error yang dapat ditindaklanjuti |

History dan ekspor tetap wajib untuk target penerimaan lokal meskipun dokumen sprint awal memberi prioritas Should Have. Fokus bahasa mencakup PHP dan JavaScript/TypeScript secara paralel; PHP tidak ditunda menjadi fitur setelah MVP.

## Batas keluaran

ADD otomatis mendokumentasikan **baseline** dari satu repository pada satu commit. Keluaran mencakup katalog data, portfolio aplikasi, interface yang dikenali, pemetaan CRUD berbasis evidence, dekomposisi fungsi, serta ArchiMate Data Structure dan Application Cooperation views. Lihat kontrak serta keterbatasannya di [TOGAF ADD](../reference/TOGAF_ADD.md).

Target architecture, gap analysis/RAG, business capability dan process mapping, ownership enterprise, deployment/distribution, serta integrasi antar-aplikasi memerlukan sumber atau konfirmasi manusia. Source code tidak digunakan untuk mengarang keadaan masa depan. Code Knowledge hanya membantu menelusuri struktur source dan bukan pengganti dokumen ADD.

LLM kampus bersifat opsional dan hanya boleh membantu narasi baseline setelah pengguna memberi consent. Fakta, hubungan, katalog, dan matriks tetap berasal dari analisis statis; jika LLM tidak tersedia, narasi deterministik digunakan.

Static analysis tidak menyatakan perilaku runtime yang tidak terbukti. Dependency framework, dynamic dispatch, reflection, atau pemuatan module dinamis yang belum terselesaikan harus dilaporkan transparan. Dukungan framework dan syntax dicatat dalam capability matrix serta fixture, bukan diasumsikan dari ekstensi file saja.

## Target penerimaan

- Login, pemilihan public repository pihak lain dan private repository berizin berhasil diuji secara nyata.
- Fixture tiap bahasa, framework, dan format kontrak yang dinyatakan didukung memiliki expected output yang direview sebelum dipakai sebagai oracle.
- Satu global analysis slot tetap terjaga saat dua permintaan datang bersamaan; submission kedua mengantre.
- Graph, inspector, source preview, ADD, dan ekspor menunjuk analysis ID serta full SHA yang sama.
- Hasil tidak menciptakan relasi `Exact` tanpa evidence; semua relasi unresolved mempertahankan alasan dan lokasi referensinya.
- Kegagalan autentikasi, target invalid, parser, pipeline, pemuatan hasil, dan ekspor menghasilkan state yang bisa dipahami.
- Markdown dan PDF dapat dibuka, mengandung baseline ADD, katalog/matriks, evidence, serta keterbatasan yang konsisten dengan hasil analisis dan koreksi pengguna.
- Setup bersih Docker dapat dijalankan ulang; hasil tersimpan setelah restart dan terhapus ketika pemilik meminta penghapusan.

Detail skenario ada di [test plan](TEST_PLAN.md); aturan lulus di [Definition of Done](DEFINITION_OF_DONE.md).

## Jadwal dan asumsi

Rencana sprint lama tidak menjadi jadwal terpisah untuk perombakan ini. Scope TOGAF ADD digabung dalam satu sprint melalui issue #142 (Iltizam: model, analyzer, API, dan acceptance fixture) serta #143 (Rizqy: workspace, ArchiMate views, katalog/matriks, overlay, ekspor, dan UI regression). Urutannya tetap: tetapkan source/evidence acuan, implementasikan model dan extractor, bangun view serta koreksi, lalu selaraskan ekspor dan evaluasi. Assignment issue bukan bukti bahwa pekerjaan atau review sudah selesai.

Deployment produksi dan anggaran ditentukan dosen. Hardware minimum, batas ukuran repository, timeout, serta target performa masih membutuhkan benchmark. Batas resource tetap harus diterapkan sebelum memproses repository arbitrer; nilai awal ditutup pada backlog ENV-01 dan QA-01.

## Acuan

Gunakan [sumber](SOURCES.md), [decision log](DECISIONS.md), dan [traceability](REQUIREMENTS_TRACEABILITY.md) untuk membedakan kebutuhan asli, perubahan yang disepakati, dan keputusan desain awal.
