# Penyajian dokumen arsitektur

PDF ditujukan untuk dibaca developer dan pemangku kepentingan: ringkas, berwarna berdasarkan kategori, dan menyertakan kontrak serta lokasi source. Markdown mempertahankan model lengkap sampai ID node/relasi, hash, atribut, resolusi, dan evidence. Data canonical tidak berubah akibat penyajian.

## Pedoman dan referensi

- [Figma SAGE: katalog](https://www.figma.com/design/OrNk1caXIrsdC0tG4axfSA/Data-Mockup-SAGE?node-id=119-7425), [struktur](https://www.figma.com/design/OrNk1caXIrsdC0tG4axfSA/Data-Mockup-SAGE?node-id=119-7571), dan [UML](https://www.figma.com/design/OrNk1caXIrsdC0tG4axfSA/Data-Mockup-SAGE?node-id=119-7892): navigasi bagian di kiri, panel putih, katalog Symbol/Contract/Evidence, navy/teal dan status eksplisit. Teks produk tetap Bahasa Indonesia; contoh domain di Figma tidak menjadi data analisis.
- [SAP ISA-M](https://help.sap.com/docs/integration-suite/sap-integration-suite/sap-integration-solution-advisory-methodology) menjadi referensi pemisahan kontrak/interface dan kebutuhan integrasi. Katalog source SAGE tidak diklaim sebagai template resmi atau sertifikasi SAP. Endpoint, protokol, pemilik bisnis, SLA, dan aliran data runtime tidak dibuat tanpa evidence.
- [Pedoman notasi C4](https://c4model.com/diagrams/notation) menjadi acuan judul, cakupan, legenda, kategori, arah, dan label relasi. Diagram SAGE adalah struktur kode, bukan klaim otomatis diagram container/deployment C4.
- [OMG UML 2.5.1](https://www.omg.org/spec/UML/2.5.1/About-UML): class/interface, anggota deklarasi, generalization dan realization. Tidak menyimpulkan visibility, multiplicity, aggregation atau composition dari kepemilikan AST.
- [Arsitektur GitDiagram](https://github.com/ahmedkhaleel2004/gitdiagram/blob/main/docs/architecture.md) dan [konfigurasi renderer](https://github.com/ahmedkhaleel2004/gitdiagram/blob/main/src/features/diagram/mermaid-config.ts): pelajari penyajian bertingkat, label SVG, warna konsisten, pan/zoom dan tautan source. SAGE menerapkan label yang ringkas, warna kategori dan zoom; pembentukan relasinya tetap deterministik dari CCM, bukan keluaran model generatif. Tidak menyalin asumsi layanan bisnis atau memakai klik Mermaid eksternal.

## Kontrak tampilan manusia

Hash dan ID teknis dipertahankan di data/API/Markdown untuk integritas, tidak ditampilkan sebagai label UI/PDF. Nama qualified dan path tetap digunakan untuk membedakan simbol bernama sama. Warna menyatakan kategori, bukan confidence: teal class, ungu interface, biru function, abu module, amber unresolved. Status juga ditandai teks dan garis putus-putus.

Diagram struktur merangkum Method/Property ke pemiliknya. Relasi antar pemilik dengan kind dan status sama digabung dengan jumlah observasi; relasi internal satu pemilik tidak digambar. Relasi Exact dan Unresolved tidak digabung. Ini merupakan tampilan ringkas yang dijelaskan pada caption; Markdown tetap memuat semua relasi asli. UML pembacaan merangkum anggota dan mempertahankan pewarisan yang teramati, lalu menambahkan dependency pemanggilan, konstruksi, referensi tipe, baca dan tulis dari relasi CCM. Endpoint method/property diangkat ke class pemilik untuk tampilan; ID, endpoint asli dan evidence tidak diubah.

PDF menggunakan A4 landscape dengan satu SVG utuh per diagram. Tidak ada potongan A1/A2 atau register mentah berulang. Proyeksi PDF memilih bagian graph yang terhubung dan bersumber dari model, dengan batas simbol, relasi serta anggota untuk keterbacaan. Caption menyatakan jumlah yang ditampilkan dan tidak ditampilkan; pilihan ini bukan penentuan kepentingan bisnis. Katalog menampilkan maksimal 30 simbol, kontrak 400 karakter dan 6 anggota per ringkasan; label panjang serta batasan analisis juga diringkas dengan keterangan. Markdown tetap menyimpan seluruh deklarasi, relasi dan evidence. Lihat [EXP-03](EXP-03_CHECKS.md) untuk versi renderer, pengukuran dan hasil inspeksi aktual.

## Batas pengujian

Fixture ekspor membuktikan alur HTTP/worker/PDF dan regresi Markdown dengan data analyzer yang terkontrol; ini berbeda dari login GitHub nyata atau analisis repository pengguna. Pengujian pipeline tersendiri harus melintasi antrean dan sembilan tahap. Bukti runtime lokal harus memeriksa image yang dijalankan, bukan hanya heartbeat.

## Kapasitas dan kegagalan eksplisit

Batas pengaman renderer tetap berlaku: source Mermaid 50.000 karakter/byte dan 500 node/500 relasi pada proyeksi PDF yang benar-benar dirender, SVG 4 MiB, full document/HTML 12 MiB, PDF 32 MiB, dan deadline 45 detik. Melebihi batas tetap menghasilkan kegagalan eksplisit. Pemilihan tampilan PDF tidak memotong model canonical atau Markdown; isi yang tidak masuk ringkasan disebutkan secara eksplisit. Keberhasilan pipeline analisis tidak menjamin PDF untuk ukuran repository sembarang. Proyeksi terbatas membantu penyajian, tetapi bukan alasan menaikkan guard atau menyatakan kapasitas tanpa pengujian.

Penyimpanan dokumen dan publikasi hasil memakai transaksi maksimal 45 detik dengan acquisition wait 2 detik, lease worker produksi 120 detik, dan renewal maksimal 50 detik. Persiapan mirror JSON dilakukan sebelum transaksi; pemeriksaan owner, canonical content, checksum, immutable row, dan lease berdasarkan jam database tetap dijalankan. Pengujian harus mencakup transaksi lebih lama dari default Prisma lima detik serta renewal heartbeat yang bertabrakan dengan kunci transaksi.

## Audit analyzer lokal 27 Oktober 2026

Runtime lama memakai image worker yang hanya heartbeat. Setelah diperbarui, uji repository private `iltizamhasan3/sage` melalui GitHub App SAGE menemukan timeout transaksi Prisma (`P2028`), benturan renewal dengan kunci transaksi, dan OOM PostgreSQL pada plafon 384 MiB. Perbaikan memindahkan persiapan mirror keluar transaksi, menyelaraskan budget transaksi/renewal/lease, dan menaikkan plafon database menjadi 1 GiB.

Uji ulang provider nyata menyelesaikan **9/9 tahap**, publikasi atomik berstatus `COMPLETED_WITH_LIMITATIONS`, serta pembacaan graph dan dokumen dengan HTTP 200. Model memuat 6.656 node dan 8.563 relasi. Pengujian memakai credential GitHub App pengguna yang sudah tersimpan serta sesi lokal sementara yang dihapus sesudah tes; login OAuth baru tidak diuji ulang. Analisis berhasil tetap ada pada history pemiliknya.

Pada audit 27 Oktober dengan renderer 2.0.0, model besar tersebut melampaui kapasitas renderer diagram/PDF saat itu. Keberhasilan analyzer ini tidak diklaim sebagai keberhasilan ekspor PDF untuk repository sebesar itu; bukti PDF 4 halaman memakai fixture ekspor yang ukurannya berada dalam budget. Markdown lengkap tetap tidak dipotong untuk memaksa ekspor berhasil.

Regresi PostgreSQL lulus untuk delayed insert >5 detik, rollback saat lease hilang, heartbeat yang benar-benar menunggu kunci dokumen pada lease 30 detik, serta SIGKILL worker produksi. Pemulihan SIGKILL menunggu expiry alami lease 120 detik, kemudian retry menyelesaikan sembilan tahap pada snapshot yang sama.

## Workspace interaktif UI-05

Halaman nyata kini menggantikan route pratinjau. Katalog menyediakan pencarian simbol, jenis, dan file dengan halaman berisi lima item; evidence membuka file GitHub pada SHA snapshot dan rentang barisnya. Metadata hash tidak memenuhi tampilan awal. Detail relasi, anggota, batasan, dan mapping diagram dibuka bertahap; inspector graph memulai dengan enam relasi dan dua evidence per relasi.

Budget browser diterapkan setelah proyeksi pembacaan menggabungkan anggota serta relasi yang berulang. Diagram yang masih melebihi 500 elemen/relasi atau 50.000 karakter/byte memakai ikhtisar source-backed terbatas dengan caption cakupan. Label Unresolved serta agregasi ikut dihitung; anggota UML diindeks berdasarkan parent agar proyeksi besar tidak memindai seluruh node untuk setiap classifier. SVG tetap disanitasi, dimuat sebagai image lokal, dibatasi 4 MiB, dan dibatalkan bila konteks akun berubah. Katalog dan Markdown mempertahankan detail yang tidak tampil pada ikhtisar.

Graph menggunakan jaringan lingkaran berwarna dengan zoom, pan, pemilihan keyboard, dan sorotan tetangga. Ini tampilan struktur kode statis; SAGE tidak mengarang relasi bisnis atau runtime yang tidak didukung analyzer. Bukti pengujian dan batas run ada di [UI-05_CHECKS](UI-05_CHECKS.md).

## Revisi ANA-08: graph esensial dan UML BCE

Graph mulai dari mode **Esensial**: kandidat source class/interface, function tingkat atas dan module, tanpa placeholder `UnresolvedReference`, file tes/fixture/generated/vendor. Referensi Exact antar-pemilik digabung menurut kind. Prioritas ditentukan konektivitas berbukti, bukan penilaian nilai bisnis. Maksimal 60 node/150 relasi kelompok dirender; Detail AST tetap dibatasi 200 node/500 relasi dan mode fokus tersedia. Jumlah yang diringkas atau tidak ditampilkan dijelaskan di UI; graph canonical tidak dipotong.

UML memakai arah `TB` dan seluruh class/interface source bila jumlahnya berada dalam batas: 12 pada interaktif, 12 pada PDF. Untuk model lebih besar, bagian yang terhubung dipilih deterministik dengan caption cakupan. Anggota per class dibatasi empat pada interaktif dan tiga pada PDF; katalog/Markdown menyimpan detail lengkap. Batas tambahan 100 kelompok relasi interaktif, 24 PDF dan 500 record evidence relasi menjaga renderer tetap terbatas. Kelompok yang melebihi budget tidak dipotong sebagian.

Peran **Boundary** (amber), **Control** (biru), dan **Entity** (teal) mengikuti konvensi nama/path. Contoh: `OrderView`, `OrderController`/`OrderService`, `OrderEntity`. Class tanpa petunjuk tetap tanpa stereotype; petunjuk yang bertentangan ditandai ambigu. Ini klasifikasi penyajian, bukan klaim bahwa analyzer memahami tanggung jawab bisnis. Referensi [BMC: BCE](https://docs.helixops.ai/bin/Service-Management/IT-Service-Management/BMC-Helix-ITSM/itsm251/Inclusions-library/Use-case-diagram-legend/) menjelaskan pembagian tanggung jawab; [Mermaid class diagram](https://mermaid.js.org/syntax/classDiagram.html) menjadi acuan notasi dependency, generalization dan realization. Tidak membuat aggregation/composition tanpa bukti.

Relasi yang target class-nya belum terbukti tidak digambar menjadi class pasti. UI menyediakan ringkasan resolusi dengan alasan, tanpa menghitung `CONTAINS` sebagai keberhasilan resolusi. Dependency memakai garis putus-putus UML dengan label kind/status; beberapa kind untuk pasangan class/status yang sama digabung pada satu panah, sementara jumlah kelompok kind dan seluruh evidence tetap dicatat. Tampilan awal menyesuaikan seluruh gambar ke area diagram, dengan zoom untuk membaca detail; garis putus-putus sendiri tidak berarti Unresolved. Proyeksi ini diterapkan saat membaca/mengekspor, sehingga ADD lama tetap valid dan canonical/Markdown tetap lengkap. Ekspor baru menggunakan renderer 2.3.0; hasil ekspor lama tidak ditimpa. Bukti pengujian ada pada [ANA-08_CHECKS](ANA-08_CHECKS.md).

## Workspace developer UI-06

Navigasi Progres, Knowledge graph, dan Dokumentasi tersedia langsung pada hasil analisis yang sama. Tab hasil tetap mengikuti pemeriksaan sesi dan pemilik; tautan belum aktif sebelum publikasi hasil lengkap. Tombol pemilihan repository memakai jarak 12 px dan membungkus pada layar sempit.

Software Engineering Diagram memulai dari maksimal empat area direktori source, dengan panah dependensi Exact yang diagregasi dan jumlah referensi. Memilih area membuka maksimal tiga file serta empat area tetangga. Grouping mengikuti struktur repository; ini bukan identifikasi otomatis layanan bisnis. Evidence mempertahankan ID, lokasi, dan relasi asli. Referensi Unresolved tidak berubah menjadi panah pasti.

UML dapat difilter berdasarkan area source dan dibaca per halaman. Class yang terhubung diprioritaskan, maksimal 12; deklarasi tanpa hubungan berbukti ditampilkan empat kartu class/interface per halaman, dalam dua kolom desktop atau satu kolom mobile. Tanpa hubungan yang ditemukan, UI tidak membuat garis palsu. Canonical dan Markdown tetap lengkap. Renderer PDF 2.3.0 memisahkan cache ekspor dari pemilihan classifier versi sebelumnya.

Pola navigasi memakai acuan [GitHub Primer underline navigation](https://primer.style/product/components/underline-nav/). Penyajian area dan drill-down terinspirasi [GitDiagram](https://github.com/ahmedkhaleel2004/gitdiagram), disesuaikan dengan relasi statis SAGE. Warna membedakan tindakan, fokus, area source, dan peran BCE; layout mengutamakan kedekatan kontrol, ruang baca terpusat, dan detail bertahap.

Susunan overview memakai constraint layout tak terlihat untuk menjaga area pada alur vertikal; constraint tidak menjadi relasi atau evidence source. Overview awal menampilkan empat area prioritas, sedangkan dropdown tetap menyediakan semua area.
