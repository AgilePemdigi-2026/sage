# Rencana sprint baru SAGE

**Tanggal penyusunan:** 21 November 2026
**Status:** Draft perencanaan. Kalender, milestone GitHub, issue, serta username anggota frontend belum ditetapkan. Ini rencana satu sprint yang dimulai ulang dari baseline acceptance; bukan klaim bahwa pekerjaan atau pengujian di bawah sudah selesai.

## Tujuan sprint

Pada akhir sprint, pengguna dapat masuk dengan GitHub, memilih repository, menjalankan analisis, membaca TOGAF Architecture Definition Document (ADD) sebagai hasil utama, membuka Code Knowledge sebagai tampilan pendamping, memakai history, serta mengunduh hasil yang konsisten. Seluruh alur diuji pada kode frontend dan backend yang terintegrasi, bukan hanya fixture tampilan.

Dokumen acuan produk saat ini adalah [Project Overview](../PROJECT_OVERVIEW.md), [TOGAF ADD reference](../reference/TOGAF_ADD.md), dan [Analysis specification](../reference/ANALYSIS_SPEC.md). ADD hanya menggambarkan baseline yang didukung source; sistem tidak mengarang target architecture, business capability, process, owner, atau deployment.

## Alur produk yang diterima

~~~mermaid
flowchart LR
  A["Login GitHub"] --> B["Pilih repository dan commit"]
  B --> C["Jalankan analisis"]
  C --> D{"Analisis selesai?"}
  D -->|Berhasil| E["Buka ADD sebagai hasil utama"]
  D -->|Berhasil| F["Buka Code Knowledge bila perlu"]
  E --> G["Review dan ekspor"]
  F --> E
  C -->|Gagal| H["Baca stage dan error"]
  H --> I["Retry atau pilih target lain"]
  E --> J["History dan hapus milik sendiri"]
  F --> J
~~~

Code Knowledge dan ADD berasal dari snapshot commit yang sama. Pengguna tidak perlu membuka graph terlebih dahulu untuk membuat atau membaca ADD.

## Cerita pengguna dan acceptance

Semua baris berstatus **perlu diuji ulang** pada sprint baru. Hasil lama tetap berguna sebagai petunjuk dan regression reference, tetapi tidak otomatis menjadi acceptance untuk frontend terbaru.

| ID | Cerita pengguna | Kriteria penerimaan |
| --- | --- | --- |
| US-01 | Sebagai pengguna, saya ingin login dengan GitHub dan melihat repository yang memang dapat saya akses, agar saya dapat memilih target analisis dengan aman. | OAuth, public repository milik sendiri dan pihak lain, serta private repository berizin diuji sesuai haknya; pergantian akun tidak menampilkan pilihan atau hasil akun sebelumnya. |
| US-02 | Sebagai pengguna, saya ingin memilih branch/commit dan melihat progres analisis, agar saya tahu snapshot yang diproses dan dapat menindaklanjuti kegagalan. | Submission mengunci full commit SHA; queue, elapsed time, status sukses/selesai dengan limitation, kegagalan stage, dan retry diuji. Error tidak menampilkan secret atau stack trace sensitif. |
| US-03 | Sebagai developer, saya ingin membuat ADD baseline setelah analisis berhasil, agar struktur Data Architecture dan Application Architecture dapat dipelajari dari evidence source. | ADD dapat dibuka tanpa mengunjungi Code Knowledge; katalog, ArchiMate views, matriks, CRUD yang didukung backend, limitation, serta evidence mengacu ke repository SHA yang sama. Unknown tidak ditulis sebagai fakta terbukti. |
| US-04 | Sebagai developer, saya ingin membuka Code Knowledge dan memeriksa node, relasi, serta source evidence, agar saya dapat menelusuri struktur teknis yang mendasari hasil. | Graph hanya menjadi pendamping ADD; pencarian, filter, focus, inspector, zoom, hubungan, evidence, state kosong/error, dan repository besar diperiksa. Software Engineering Diagram dan UML lama bukan deliverable aktif. |
| US-05 | Sebagai pengguna, saya ingin mencari dan membuka history milik saya, agar dapat kembali ke analisis sebelumnya. | Pencarian, daftar, detail, status aktif/selesai/gagal, akses lintas pengguna, serta navigasi ke ADD dan graph diperiksa. Perilaku retry hanya diterima bila tersedia pada implementasi saat pengujian. |
| US-06 | Sebagai pengguna, saya ingin menghapus analisis dan hasil turunannya setelah tidak diperlukan, agar data milik saya tidak tersimpan lagi. | Penghapusan terminal meminta konfirmasi, menolak job aktif, membersihkan metadata dan file terkait, idempotent saat cleanup diulang, serta tidak menghapus data pengguna lain. Gunakan database dan storage disposable. |
| US-07 | Sebagai pengguna, saya ingin meninjau ADD dan mengekspor salinan yang konsisten, agar dapat dibaca oleh stakeholder dan developer. | Koreksi hanya mengubah overlay review; konflik revision stale ditolak. Markdown, LaTeX, dan PDF memakai model/revision yang sama. PDF A4 terbaca; Markdown ringkas dan tidak menggandakan payload besar. |
| US-08 | Sebagai pengguna, saya ingin meminta bantuan LLM untuk narasi secara opsional, agar deskripsi lebih mudah dibaca tanpa mengubah fakta analyzer. | Consent mati secara default; hanya ringkasan fakta yang diizinkan dikirim; response tidak dapat menambah fakta/relasi; timeout, invalid response, dan tidak tersedianya service memakai fallback deterministik. |
| US-09 | Sebagai anggota tim, saya ingin memakai alur lokal Docker dan bukti run yang dapat diulang, agar demo dan review frontend tidak bergantung pada deployment. | Setup Docker bersih, migrasi, health, alur inti dan panduan diuji; CI sesuai branch; bukti mencatat commit, environment, test, hasil dan limitation. Sprint ini tidak melakukan deployment Coolify. |

## Urutan kerja

| Tahap | Pekerjaan | Hasil untuk direview |
| --- | --- | --- |
| 0. Re-baseline | Tetapkan tanggal sprint, commit awal, repositori fixture/commit yang diizinkan, username frontend, story, issue, owner, dan Definition of Done. | Scope dan issue baru yang punya acceptance serta bukti; tidak menyalin status Done dari snapshot backlog lama. |
| 1. Akses dan analisis | Integrasikan login, repository picker, target branch/commit, queue, snapshot, progres, error, serta retry. | Satu run dari target hingga status terminal dengan SHA dan batas analisis terlihat. |
| 2. ADD sebagai hasil utama | Integrasikan generation, Data/Application Architecture, evidence, limitation, review overlay, dan revision conflict. | User flow ADD lengkap pada snapshot yang sama, tanpa prasyarat membuka graph. |
| 3. Code Knowledge dan history | Hubungkan graph pendamping, pencarian/inspector/evidence, history, detail, ownership, dan penghapusan. | Navigasi antarhasil dan siklus hidup data yang tervalidasi. |
| 4. Ekspor dan LLM | Cocokkan Markdown/LaTeX/PDF; uji opt-in LLM serta fallback. | Artefak yang dapat diperiksa dan identitas model/revision yang konsisten. |
| 5. Frontend integration | Implementasikan layar frontend oleh teman yang ditunjuk pengguna; integrasikan dengan kontrak aktual dan review responsif. | UI tidak bergantung pada mock untuk acceptance utama; username dan issue FE dicatat saat ditetapkan. |
| 6. Regression dan demo | Jalankan unit/contract, integration, Cucumber, Playwright, Docker smoke, dan fresh end-to-end run yang sesuai environment. | Hasil pass/fail aktual, screenshot/report, known gaps, dan local demo yang dapat direplay. Tidak ada deployment. |

Tahap dapat dikerjakan paralel setelah kontrak dan commit awal disepakati. ADD, Code Knowledge, dan history tetap memiliki acceptance terpisah agar keberhasilan satu bagian tidak menutupi kegagalan bagian lain.

## Pembagian workstream awal

Pembagian issue final dibuat setelah scope, estimasi berbobot, dan akun frontend tersedia. Jumlah issue atau commit tidak digunakan sebagai ukuran pemerataan.

| Workstream | Fokus awal | Penanggung jawab rencana |
| --- | --- | --- |
| Analyzer dan backend | Analyzer/evidence, canonical ADD, persistence/overlay, CRUD, LLM boundary, export model consistency. | Iltizam |
| Integrasi aplikasi dan acceptance | Pipeline user flow, repository/history integration, Cucumber/Playwright acceptance, laporan dan regression. | Rizqy |
| Frontend | Implementasi layar dan interaksi berdasarkan kontrak produk serta feedback user. | Teman yang ditunjuk pengguna; username dan pembagian issue belum dicatat |
| Review lintas workstream | Integrasi, pemeriksaan evidence, retest defect, dan kelengkapan demonstrasi. | Iltizam dan Rizqy bersama kontributor frontend |

Peran tersebut adalah starting proposal, bukan status assignment pada GitHub. Detail penerima, estimate, reviewer, dan issue perlu dikunci di planning sebelum kerja sprint dihitung.

## Standar BDD dan bukti

- Gherkin berbahasa Inggris; langkah Given/When/Then memakai aksi serta label yang benar-benar terlihat pada UI.
- Skenario SRS mempertahankan ID pada judul dan nama halaman aktual di dalam tanda petik ganda. Acceptance baru yang tidak ada di SRS diberi ID lokal yang jelas, bukan diklaim sebagai kebutuhan SRS.
- Playwright mengambil screenshot per skenario UI utama dan laporan browser/Cucumber. Screenshot harus berasal dari aplikasi lokal yang benar-benar berjalan, bukan dibuat dari markup tiruan.
- Bukti setiap acceptance mencatat tanggal, commit aplikasi, repository dan full SHA fixture, environment, langkah/command, hasil aktual, screenshot/report, serta limitation.
- Corpus Perpus, SAGE, dan Emosync dapat digunakan sebagai regression targets pada commit yang diizinkan. Run historis tidak menggantikan run baru jika code, UI, contract, atau dependency acceptance berubah.
- Rahasia OAuth/LLM, private source, token, dan credential tidak dimasukkan ke screenshot atau artefak publik.

## Definition of Done sprint

1. Semua story US-01 sampai US-09 memiliki hasil pass, fail, atau blocked yang ditandatangani tim; tidak ada status implisit dari commit count.
2. Acceptance UI penting menempuh frontend dan backend aktual. Fixture/mocked checks dilabeli dan tidak menggantikan test yang memakai provider/worker/database nyata.
3. Bug P0/P1 ditutup dengan perbaikan dan retest; temuan lain memiliki issue, impact, dan owner.
4. Code Knowledge, ADD, dan history dapat didemonstrasikan secara terpisah dan dari alur end-to-end yang sama.
5. Dokumen ekspor dan screenshot telah direview manusia; limitation, ukuran, dan cakupan framework dinyatakan.
6. Docker local demo dapat dijalankan serta dihentikan tanpa menghapus volume. Tidak ada deployment ke Coolify dalam scope ini.
7. Dokumen aktif, planning, dan hasil BDD diperbarui; arsip lama tetap mempertahankan tanggal dan scope run asal.

## Hal yang harus ditetapkan sebelum sprint dimulai

- Tanggal mulai, tanggal akhir, periode review, dan milestone GitHub.
- Username teman yang mengerjakan frontend serta bagian layar yang ia tangani.
- Commit fixture target yang boleh dipakai dan akun/izin untuk run GitHub nyata.
- Issue baru, estimate berbobot, reviewer, dependency, dan kriteria signoff.
- Perubahan deployment atau resource server tetap keputusan terpisah dari sprint ini.
