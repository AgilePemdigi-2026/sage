# Product Requirements Document

Status: baseline produk disepakati pada 18 Oktober 2026; implementasi berjalan per 20 Oktober 2026. Login GitHub, akses repository, validasi branch/full SHA, submission idempotent ke durable queue, serta handler snapshot/source tersedia. Consumer pipeline sembilan tahap masih nonaktif, sehingga alur target di dokumen ini tetap merupakan cakupan MVP yang belum selesai. Bukti per slice tersedia pada [GH-02](GH-02_CHECKS.md), [REP-01](REP-01_CHECKS.md), [REP-02](REP-02_CHECKS.md), dan [ANA-02](ANA-02_CHECKS.md).

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
7. Membaca Architecture Definition Document dan mengunduh Markdown atau PDF.
8. Membuka hasil sebelumnya melalui history atau menghapus data analisis milik sendiri.

## Cakupan wajib MVP

| Fitur | Hasil minimum |
| --- | --- |
| GitHub | Login, callback tervalidasi, izin repository, error, dan sesi pengguna |
| Target analisis | Daftar/pencarian repository, public URL, branch, commit opsional, full SHA, dan validasi |
| Pipeline | Snapshot, deteksi bahasa, static analysis PHP dan JS/TS, CCM, CKG, tiga artefak, dan ADD |
| Progress | Antrean, tahap aktif, gagal, selesai, dan selesai dengan keterbatasan |
| Graph | Focus/overview/references, pencarian, kategori AST, zoom, inspector, relasi dua arah, evidence, dan source preview |
| Dokumen | Interface Catalog, Software Engineering Diagram, dan UML Class Diagram dari graph yang sama |
| Ekspor | Markdown dan PDF nyata, state pembuatan, ready, error, serta retry |
| History | Daftar per pengguna, pencarian repository/SHA, navigasi sesuai status, dan empty state |
| Data | Persistensi lintas restart, akses per pengguna, dan penghapusan analisis beserta turunannya |
| UI | Bahasa Indonesia, mobile first, penggunaan laptop/desktop, serta state loading/empty/error yang dapat ditindaklanjuti |

History dan ekspor tetap wajib untuk target penerimaan lokal meskipun dokumen sprint awal memberi prioritas Should Have. Fokus bahasa mencakup PHP dan JavaScript/TypeScript secara paralel; PHP tidak ditunda menjadi fitur setelah MVP.

## Batas keluaran

Artefak yang dihasilkan adalah tiga bagian ADD di atas. BPMN, Use Case Diagram, Activity Diagram, Sequence Diagram, ERD, target architecture, gap analysis, dan roadmap tetap di luar keluaran analisis. Diagram tersebut dapat digunakan sebagai dokumentasi pengembangan project.

LLM tidak menjadi dependency jalur MVP. Setelah MVP freeze, usulan narasi atau semantic abstraction harus melalui keputusan terpisah dan hanya memakai fakta yang sudah tersedia.

Static analysis tidak menyatakan perilaku runtime yang tidak terbukti. Dependency framework, dynamic dispatch, reflection, atau pemuatan module dinamis yang belum terselesaikan harus dilaporkan transparan. Dukungan framework dan syntax dicatat dalam capability matrix serta fixture, bukan diasumsikan dari ekstensi file saja.

## Target penerimaan

- Login, pemilihan public repository pihak lain dan private repository berizin berhasil diuji secara nyata.
- Fixture PHP, JavaScript, dan TypeScript memiliki expected output yang direview sebelum dipakai sebagai oracle.
- Satu global analysis slot tetap terjaga saat dua permintaan datang bersamaan; submission kedua mengantre.
- Graph, inspector, source preview, ADD, dan ekspor menunjuk analysis ID serta full SHA yang sama.
- Hasil tidak menciptakan relasi `Exact` tanpa evidence; semua relasi unresolved mempertahankan alasan dan lokasi referensinya.
- Kegagalan autentikasi, target invalid, parser, pipeline, pemuatan hasil, dan ekspor menghasilkan state yang bisa dipahami.
- Markdown dan PDF dapat dibuka, mengandung tiga artefak dan keterbatasan, serta cocok dengan hasil analisis.
- Setup bersih Docker dapat dijalankan ulang; hasil tersimpan setelah restart dan terhapus ketika pemilik meminta penghapusan.

Detail skenario ada di [test plan](TEST_PLAN.md); aturan lulus di [Definition of Done](DEFINITION_OF_DONE.md).

## Jadwal dan asumsi

Target fitur lengkap pada pengerjaan Sprint 2, review user story pada minggu ketiga setiap siklus, dan finishing pada Sprint 3. Jadwal rinci ada di [sprint plan](SPRINT_PLAN.md).

Deployment produksi dan anggaran ditentukan dosen. Hardware minimum, batas ukuran repository, timeout, serta target performa masih membutuhkan benchmark. Batas resource tetap harus diterapkan sebelum memproses repository arbitrer; nilai awal ditutup pada backlog ENV-01 dan QA-01.

## Acuan

Gunakan [sumber](SOURCES.md), [decision log](DECISIONS.md), dan [traceability](REQUIREMENTS_TRACEABILITY.md) untuk membedakan kebutuhan asli, perubahan yang disepakati, dan keputusan desain awal.
