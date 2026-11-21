# Product Requirements Document

Status saat ini: requirement produk mengikuti alur analisis repository → TOGAF Architecture Definition Document (ADD) sebagai keluaran utama; Code Knowledge adalah tampilan source pendamping. Rencana dan acceptance aktif ada di [rencana sprint baru](RESET_SPRINT.md). Bagian requirement MVP awal di bawah dipertahankan sebagai konteks dan traceability, bukan status bahwa semua sudah lulus pada implementasi frontend terbaru.

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

1. Login dengan GitHub, lalu pilih repository publik atau private yang memang diizinkan.
2. Pilih branch/commit; saat submission, SAGE memvalidasi target dan mengunci full SHA.
3. Jalankan pipeline statis dan pantau queue, stage, elapsed time, limitation, atau error yang dapat ditindaklanjuti.
4. Setelah sukses, buka dan buat TOGAF ADD baseline sebagai hasil utama. Pengguna tidak perlu membuka Code Knowledge terlebih dahulu.
5. Buka Code Knowledge bila perlu untuk menelusuri graph dan evidence source dari snapshot yang sama.
6. Review overlay, ekspor Markdown/LaTeX/PDF, dan gunakan history untuk membuka atau menghapus hasil milik sendiri.

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

Sprint 1–3 dan alokasi yang tercantum pada dokumen lama adalah riwayat, bukan kalender aktif. Pekerjaan dimulai lagi dalam satu sprint dengan tanggal, milestone, issue, serta username/frontend contributor yang perlu disepakati sebelum sprint dibuka. Acceptance produk yang baru dan urutan integrasi tercatat di [RESET_SPRINT](RESET_SPRINT.md). Deployment produksi serta kuota resource Coolify adalah keputusan terpisah; sprint ini berakhir pada kesiapan demo Docker lokal dan tidak melakukan deployment.

## Acuan

Gunakan [sumber](SOURCES.md), [decision log](DECISIONS.md), dan [traceability](REQUIREMENTS_TRACEABILITY.md) untuk membedakan kebutuhan asli, perubahan yang disepakati, dan keputusan desain awal.
