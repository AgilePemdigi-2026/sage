# Verifikasi proyeksi diagram DOC-02

Tanggal: 21 Oktober 2026, Asia/Jakarta. Issue [#38](https://github.com/AgilePemdigi-2026/sage/issues/38). Base `b552d2c8a9b674c3cc9472de91c12ccf04a9e40b`. Pengiriman dan commit: Valentina (`liliks13`). Review dan merge: Iltizam (`iltizamhasan3`) setelah review kode independen.

Commit implementasi: `51af784` (proyeksi/traceability) dan `695457d` (renderer serta pengujian browser/cetak).

## Perubahan

`@sage/documents` menyediakan `projectDiagrams` serta `renderDiagramBundle` dari canonical CKG tervalidasi dan byte source snapshot. Bundle mengikat kedua proyeksi ke hash CKG/configuration, snapshot, provenance, limitation, ID dan evidence. Source Mermaid mandiri tersedia bersama SVG; tidak ada fetch source atau analisis ulang HEAD.

Diagram struktur mempertahankan semua fakta canonical dan membedakan ownership dari dependency. UML adalah subset Class/Interface, member langsung, dan EXTENDS/IMPLEMENTS; ID fakta di luar subset dicatat eksplisit. Node unresolved dan alasan tetap terlihat. Tidak ada visibility, composition, atau cardinality yang ditebak.

Label di-encode sebagai data, alias diturunkan dari ID canonical. Chromium memakai Mermaid lokal, strict mode, CSP, blokir jaringan dan service worker, serta pemeriksaan SVG terhadap konten aktif/tautan eksternal. API tidak menerima source Mermaid bebas. Batas renderer dijelaskan dalam [spesifikasi analisis](ANALYSIS_SPEC.md#kontrak-proyeksi-diagram-doc-02); input melebihi batas gagal tanpa truncation. Dua diagram dikembalikan bersama setelah keduanya berhasil.

## Verifikasi

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| Lint dan typecheck root/web | Tanpa error/warning | PASS |
| Suite utama dan tes data | Seluruh tes lulus | 245/245 + 8/8 PASS |
| Proyeksi source-backed JS/TS/PHP | ID, evidence, hash, provenance dan fakta canonical dipertahankan | PASS |
| Replay dan input palsu | Mermaid deterministik; hash/source/JSON yang salah ditolak | PASS |
| Chromium/Mermaid nyata | UML dan struktur dari satu CKG, label dapat dibaca | PASS |
| Label HTML/URL berbahaya | Tampil sebagai teks inert; tidak ada resource jaringan atau source execution | PASS |
| CKG tanpa classifier dan tanpa node | Empty-state jujur, SVG valid, tanpa fakta buatan | PASS |
| Input melewati 50 KB | Error eksplisit, tanpa truncation | PASS |
| Timeout dan kegagalan diagram kedua | Browser ditutup, hasil parsial tidak dikembalikan | PASS dengan browser double terkontrol |
| Cetak A4 | Dua halaman terbaca tanpa clipping | PASS; kedua halaman dirasterisasi dan diperiksa visual |

Tes proyeksi memakai resolver nyata masing-masing bahasa. Tes Chromium memakai CKG gabungan 32 node/27 edge dari tiga source fixture, termasuk Exact/Unresolved, quoted computed member, URL/HTML berbahaya, dan canary source JS/PHP. Byte source fixture dan full snapshot SHA sintetis direkam dalam canonical CKG; ini bukan analisis GitHub live. Hash CKG keamanan `49a8ac87a82c24b914efd7bb65f55c1f102320ca61f461d95cc25e63a5170074`.

Untuk cetak terbaca, PDF memakai fixture campuran terpisah yang ringkas (8 node/5 edge), hash CKG `8533d526d690fd0bd3c8819f64b6513d026426ca4baf97dd93c040223b2d93bf`. Fixture keamanan yang panjang tetap diuji melalui Chromium dan pemeriksaan DOM/SVG, tanpa mengklaim graph besar otomatis terbaca pada satu lembar A4. Layout dan pagination ekspor produk tetap EXP-02.

Mermaid 12.2.0, Chromium 156.0.8078.4, Node 24.22.0, PHP 8.4.26. Renderer membaca Mermaid lokal; HTML preview juga tidak mengakses jaringan. Kegagalan browser menggantung dan diagram kedua disimulasikan untuk memeriksa cleanup/atomic return, sedangkan rendering sukses, input berlebih, empty-state, serta label berbahaya memakai browser nyata.

Command pada image Node 24 `sage-worker:local`, dependency terkunci:

```sh
npm run check
npm run test:documents:diagrams
git diff --check
```

Container dibatasi 1 CPU/2 GiB dan jaringan nonaktif. Tidak perlu menjalankan web atau database aplikasi. Laporan, screenshot, serta PDF pemeriksaan disimpan pada `artifacts/document-diagrams` yang diabaikan Git.

## Review PR

Review independen pada [PR #78](https://github.com/AgilePemdigi-2026/sage/pull/78), head awal `031dcfd4bef17c07dff22ce79faa19b3e693c0aa`, menemukan method masuk ke kompartemen atribut karena tanda kurung ikut di-escape. Koreksi mempertahankan grammar method dan menandai parameter yang tidak direkam adapter sebagai `parameter tidak tersedia`. Regresi baru memeriksa jumlah method/property pada hasil parsing Mermaid asli untuk classifier JS, TS dan PHP; label, security, PDF, serta suite utama diuji ulang setelah koreksi.

## Batas penerimaan

PDF pemeriksaan merupakan bukti cetak renderer, bukan ekspor PDF produk terotorisasi. Integrasi Interface Catalog/ADD masih DOC-01 #15; publikasi hasil pipeline, UI dokumen, ekspor Markdown dan PDF masih mengikuti parent terkait. Komponen ini tidak mengaktifkan consumer queue produk dan tidak mengubah data pengguna. Dependency ANA-06 menyediakan canonical CKG yang diuji; signoff formal parent tidak diklaim selesai oleh paket ini.
