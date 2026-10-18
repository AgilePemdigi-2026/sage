# Pemeriksaan fondasi knowledge graph GRAPH-01-S1

Implementasi menyediakan `/graph-preview` sebagai pratinjau interaktif dari fixture source TypeScript tetap. Halaman memvalidasi payload CCM terhadap byte source yang sama sebelum mengirim model berseri ke client. Proyeksi tampilan memakai tipe CCM saja dan tidak mengubah payload atau source. Halaman memakai metadata `noindex` dan menampilkan banner bahwa fixture tidak terhubung ke GitHub.

Kanvas Cytoscape membedakan kategori node lewat bentuk/warna dan membedakan relasi `Exact` serta `Unresolved` lewat label dan garis. Kontrol perbesar/perkecil/sesuaikan tampilan memperbarui zoom; daftar node berisi tombol keyboard yang memilih node dan memperbarui detail source. Issue ini hanya mengirim fixture kecil untuk memeriksa interaksi dasar. Filter graph, ringkasan hitungan, integrasi repository, serta knowledge graph produksi berada pada issue lanjutan.

Tes otomatis pada `tests/graph-foundation.test.ts` memeriksa validasi byte source, hash file, relasi unresolved tanpa target exact rekaan, kategori dan label proyeksi, data tidak berubah, serta state validasi gagal saat byte source rusak. Verifikasi terfokus yang sudah dijalankan dalam container Node project: tiga tes lulus, ESLint pada file GRAPH-01 lulus, dan typecheck workspace web lulus. Production build dan browser responsive masih dijalankan oleh integrasi branch; dokumen ini tidak mengklaim inspeksi manual atau hasil browser yang belum terekam.

## Hasil aktual 19 Oktober 2026

Base: `093c391`. Identitas commit mengikuti penanggung jawab issue `liliks13`; pemeriksaan kode, review terpisah, pengujian, serta pemeriksaan gambar dilakukan secara otomatis dan tidak menyatakan review manual anggota.

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| `npm run check` dalam Docker | Lint, typecheck, dan suite lulus | PASS; 40 tes utama + 8 tes database |
| `npm run build` | Production build memuat `/graph-preview` tanpa import Node pada client | PASS |
| `npm run test:graph` | Canvas/legenda, zoom/fit, keyboard, pilihan unresolved, resize, dan overflow lulus pada lima viewport | PASS; 31 pemeriksaan, 0 page error, 0 request API/GitHub |
| Viewport | 360, 390, 768, 1024, 1440 px | PASS pada kelimanya |
| Evidence source | Semua tujuh kind CCM, 10 node dan 9 edge berasal dari byte fixture | PASS; hash/bounds divalidasi, proyeksi tidak mengubah fakta |
| Tampilan Unresolved | Tidak menampilkan deklarasi source rekaan | PASS; `formatter.format` menggunakan receiver tanpa implementasi konkret |
| Pemeriksaan gambar | Canvas, label fixture, daftar node, dan konteks terbaca dan tidak overflow | PASS; gambar mobile 360 dan desktop 1440 diperiksa |

Runtime: Linux arm64, Node.js 24.22.0, Next.js 16.4.2, Cytoscape.js 3.34.4. Bukti lokal yang tidak di-commit: `artifacts/graph-01-s1/browser-report.json` dan 10 screenshot. Server browser memakai production build dari workspace bind; paket ini tidak mengklaim rebuild image produksi baru.

Snapshot pada fixture merupakan identitas sintetis tetap, bukan commit repository remote yang dianalisis. Pada mobile, fit menyediakan overview; gunakan zoom atau daftar node untuk membaca detail. Integrasi CKG nyata, filter, mode graph penuh, canonical counts, dan inspector/source preview lengkap tetap berada pada parent #17 serta issue #18/#19.
