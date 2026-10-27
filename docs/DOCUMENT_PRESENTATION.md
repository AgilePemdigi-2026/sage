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

Diagram struktur merangkum Method/Property ke pemiliknya. Relasi antar pemilik dengan kind dan status sama digabung dengan jumlah observasi; relasi internal satu pemilik tidak digambar. Relasi Exact dan Unresolved tidak digabung. Ini merupakan tampilan ringkas yang dijelaskan pada caption; Markdown tetap memuat semua relasi asli. UML mempertahankan anggota yang tersedia dan pewarisan yang teramati.

PDF renderer 2.0.0 menggunakan A4 landscape dengan satu SVG utuh per diagram. Tidak ada potongan A1/A2 atau register mentah berulang. SVG tetap vektor saat diperbesar; teks diagram besar dapat memerlukan zoom. Katalog bisa berlanjut ke halaman berikutnya tanpa membuang deklarasi. Tidak ada batas halaman tetap untuk repository berukuran sembarang.

## Batas pengujian

Fixture ekspor membuktikan alur HTTP/worker/PDF dan regresi Markdown dengan data analyzer yang terkontrol; ini berbeda dari login GitHub nyata atau analisis repository pengguna. Pengujian pipeline tersendiri harus melintasi antrean dan sembilan tahap. Bukti runtime lokal harus memeriksa image yang dijalankan, bukan hanya heartbeat.

## Kapasitas dan kegagalan eksplisit

Batas pengaman renderer tetap berlaku: source Mermaid 50.000 karakter/byte, 500 node/500 relasi per diagram, SVG 4 MiB, HTML 12 MiB, PDF 32 MiB, dan deadline 45 detik. Melebihi batas menghasilkan pesan gagal eksplisit, bukan diagram atau Markdown yang dipotong diam-diam. Keberhasilan pipeline analisis tidak menjamin diagram repository besar dapat dirender pada batas ini. Ringkasan lintas folder untuk repository besar memerlukan proyeksi tersendiri; menaikkan batas saja tidak menjamin keterbacaan pada satu A4.

Penyimpanan dokumen dan publikasi hasil memakai transaksi maksimal 45 detik dengan acquisition wait 2 detik, lease worker produksi 120 detik, dan renewal maksimal 50 detik. Persiapan mirror JSON dilakukan sebelum transaksi; pemeriksaan owner, canonical content, checksum, immutable row, dan lease berdasarkan jam database tetap dijalankan. Pengujian harus mencakup transaksi lebih lama dari default Prisma lima detik serta renewal heartbeat yang bertabrakan dengan kunci transaksi.

## Audit analyzer lokal 27 Oktober 2026

Runtime lama memakai image worker yang hanya heartbeat. Setelah diperbarui, uji repository private `iltizamhasan3/sage` melalui GitHub App SAGE menemukan timeout transaksi Prisma (`P2028`), benturan renewal dengan kunci transaksi, dan OOM PostgreSQL pada plafon 384 MiB. Perbaikan memindahkan persiapan mirror keluar transaksi, menyelaraskan budget transaksi/renewal/lease, dan menaikkan plafon database menjadi 1 GiB.

Uji ulang provider nyata menyelesaikan **9/9 tahap**, publikasi atomik berstatus `COMPLETED_WITH_LIMITATIONS`, serta pembacaan graph dan dokumen dengan HTTP 200. Model memuat 6.656 node dan 8.563 relasi. Pengujian memakai credential GitHub App pengguna yang sudah tersimpan serta sesi lokal sementara yang dihapus sesudah tes; login OAuth baru tidak diuji ulang. Analisis berhasil tetap ada pada history pemiliknya.

Model besar tersebut melampaui kapasitas renderer diagram/PDF di atas. Keberhasilan analyzer ini tidak diklaim sebagai keberhasilan ekspor PDF untuk repository sebesar itu; bukti PDF 4 halaman memakai fixture ekspor yang ukurannya berada dalam budget. Markdown lengkap tetap tidak dipotong untuk memaksa ekspor berhasil.

Regresi PostgreSQL lulus untuk delayed insert >5 detik, rollback saat lease hilang, heartbeat yang benar-benar menunggu kunci dokumen pada lease 30 detik, serta SIGKILL worker produksi. Pemulihan SIGKILL menunggu expiry alami lease 120 detik, kemudian retry menyelesaikan sembilan tahap pada snapshot yang sama.
