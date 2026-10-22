# Spesifikasi analisis

Status per 22 Oktober 2026: kontrak CCM `schemaVersion = 1`, canonical CKG `sage-ckg-v1` dan ADD `sage-add-v1` memiliki bukti komponen serta integrasi per issue. Consumer pipeline produk tersedia pada ANA-07; gate oracle formal tim tetap terbuka. Perubahan kontrak harus memperbarui API, data model, fixture, dan traceability.

## Prinsip

Analisis memakai satu snapshot full commit SHA sebagai sumber tetap. Semua fakta teknis berasal dari source yang diproses secara statis. Normalisasi menghasilkan Common Code Model (CCM), kemudian canonical Code Knowledge Graph (CKG). Semua artefak dokumen diproyeksikan dari CKG yang sama.

Bedakan jenis relasi dari status resolusinya. `CALLS` adalah jenis relasi; `Exact` atau `Unresolved` menjelaskan tingkat penyelesaiannya. `Inferred` tidak menjadi status MVP. Hubungan arsitektur, HTTP endpoint, cardinality, composition, dan perilaku runtime tidak diciptakan hanya dari nama class atau dugaan framework.

## Capability matrix target

Seluruh baris berikut adalah target Sprint 2 dan berstatus **belum terverifikasi**. Tandai dukungan per bahasa/konstruksi dengan fixture lulus, keterbatasan eksplisit, serta versi parser; tabel ini bukan klaim dukungan universal framework.

| Kemampuan | JS/TS | PHP | Kriteria |
| --- | --- | --- | --- |
| Struktur module/file dan deklarasi | Wajib | Wajib | Path, nama, kategori, bounds, dan source hash sesuai oracle |
| Class, function, method, property | Wajib | Wajib | Static/instance dan signature dipertahankan bila tersedia |
| Interface dan tipe | Wajib untuk syntax yang relevan | Wajib untuk syntax yang relevan | Deklarasi dan penggunaan tipe dapat dibedakan |
| Import/export dan namespace | ESM, CommonJS statis, alias tsconfig yang dapat dibaca | Namespace, use, pemetaan Composer statis | Resolusi mengikuti bukti dan config non-executable |
| Extends/implements | Wajib | Wajib | Arah hubungan dan target tepat |
| Calls dan instantiation | Wajib jika target terselesaikan | Wajib jika target terselesaikan | Symbol/receiver cocok; yang dinamis tetap unresolved |
| Referensi tipe dan akses member | Wajib pada konstruksi yang dipastikan | Wajib pada konstruksi yang dipastikan | Read/write/type evidence dibedakan |
| Dynamic import/require/include, reflection, receiver dinamis | Dicatat | Dicatat | Jangan diubah menjadi exact tanpa target yang terbukti |
| JSX/TSX, type alias, enum, PHP trait/enum | Spike dan fixture khusus | Spike dan fixture khusus | Ekstensi taxonomy dan dukungan parser harus dicatat eksplisit |
| Semantik framework dan routing | Terbatas pada pola yang dibuktikan fixture | Terbatas pada pola yang dibuktikan fixture | Tidak menyatakan semua framework didukung |

Keluaran adapter PHP dan JS/TS dapat dikembangkan bersamaan setelah contracts disepakati. Dalam satu job, orchestrator memproses adapter sesuai urutan deterministik; tidak ada kewajiban menjalankan kedua parser secara konkuren.

Source tanpa dependency terpasang tetap dapat dipindai. Dependency eksternal yang tidak tersedia diberi unresolved/external sesuai bukti. Tidak melakukan instalasi dependency project target untuk meningkatkan resolusi.

## Unit sumber dan evidence

Setiap source file menyimpan `path` POSIX relatif terhadap root snapshot, `language`, `sha256`, `sizeBytes`, dan status pemrosesan. Konten file yang ditampilkan harus berasal dari snapshot tersebut, bukan HEAD GitHub saat halaman dibuka.

Evidence memiliki:

| Field | Aturan |
| --- | --- |
| `filePath` | Path relatif yang telah dinormalisasi dan lolos pemeriksaan traversal |
| `fileSha256` | Hash konten dalam snapshot |
| `startLine`, `endLine` | Nomor baris berbasis 1, inklusif |
| `startColumn`, `endColumn` | Kolom berbasis 1 dengan batas akhir eksklusif; dihitung sebagai Unicode code point |
| `startByte`, `endByte` | Offset UTF-8 berbasis 0, akhir eksklusif |
| `role` | `declaration`, `reference`, atau `context` |

Adapter wajib mengonversi offset native parser ke kontrak ini dan menguji CRLF, LF, serta Unicode. Snippet diperoleh dari bounds tersebut; potongan kode bukan satu-satunya identitas evidence.

Satu edge dapat memiliki evidence utama dan konteks. Pemanggilan pada satu baris dan assignment receiver pada baris lain tidak digabung sehingga lokasi utama berubah. Source evidence yang tidak tersedia ditampilkan sebagai unavailable, bukan diganti dengan contoh kode.

## Node

Field minimum: `id`, `kind`, `name`, `qualifiedName`, `language`, `filePath`, `location`, `parentId`, `origin`, `signature`, dan `attributes`.

Kategori inti mengikuti desain: `Module`, `Class`, `Interface`, `Function`, `Method`, `Property`, dan `UnresolvedReference`. Label UI kategori terakhir adalah `Referensi belum terselesaikan`. `Controller`, `Service`, dan `Repository` adalah nama/peran kode, bukan kategori AST.

Kategori tambahan untuk `TypeAlias`, `Enum`, dan `Trait` memerlukan fixture, label/filter UI, dan keputusan taxonomy pada spike; jangan menyamarkannya sebagai kategori lain. Sampai kategorinya terdaftar, catat konstruksi yang belum terwakili sebagai keterbatasan. [Spike taxonomy ANA-05](CCM_TAXONOMY_SPIKE.md) mencatat karakterisasi dua adapter, alasan mempertahankan registry v1 saat ini, dan syarat perluasannya; bukan klaim dukungan konstruksi tersebut.

`origin` bernilai `source`, `stdlib`, `external`, atau `unresolved`. Node source memiliki lokasi deklarasi nyata. Placeholder unresolved tidak memiliki deklarasi palsu; evidence berada pada edge referensi. Simbol standard library boleh memiliki deklarasi null bila identitasnya didukung katalog bahasa berversi dan evidence referensinya tetap tersedia.

ID node deterministik terhadap full SHA, bahasa, path, kind, qualified name, dan bounds. Nama singkat saja tidak cukup untuk identitas. Jangan memakai analysis ID atau timestamp untuk membuat canonical graph berbeda pada snapshot/config yang sama.

## Edge

Field minimum: `id`, `sourceId`, `targetId`, `kind`, `resolution`, `evidence`, dan `unresolvedReason`.

Jenis relasi awal: `CONTAINS`, `IMPORTS`, `EXPORTS`, `EXTENDS`, `IMPLEMENTS`, `TYPE_REFERENCES`, `CALLS`, `INSTANTIATES`, `READS`, `WRITES`, `THROWS`, dan `INCLUDES`. Setiap adapter melaporkan jenis yang benar-benar didukung; jenis yang tidak relevan untuk bahasa tertentu tidak diwajibkan muncul.

- `CONTAINS` menjelaskan kepemilikan elemen; reference menjelaskan penggunaan/dependency. Keduanya dihitung terpisah.
- Edge `Exact` memiliki target yang dapat dipastikan oleh resolver dan evidence yang valid.
- Edge `Unresolved` mempertahankan expression/name yang diamati, placeholder target, evidence, dan alasan.
- Alasan unresolved terstruktur mencakup `DYNAMIC_LOAD`, `UNKNOWN_RECEIVER`, `EXTERNAL_DEPENDENCY`, `UNSUPPORTED_CONSTRUCT`, dan `AMBIGUOUS_SYMBOL`.
- Dua referensi berbeda dengan source/target yang sama tetap memiliki edge terpisah jika evidence atau kind berbeda.
- Deduplikasi hanya berlaku untuk edge yang benar-benar identik, termasuk kind dan bounds evidence.
- Klasifikasi resolusi tidak dapat diubah oleh renderer atau pembentuk narasi.

## Common Code Model

CCM memuat `schemaVersion`, identitas snapshot, provenance analyzer/resolver/config, `files`, `nodes`, `edges`, serta `limitations`. Hasil validasi memastikan ID unik, seluruh endpoint edge terdaftar, parent/source bounds valid, dan bahasa/kategori ada dalam registry.

Canonical serialization mengurutkan file, node, edge, dan limitation dengan aturan tetap. Timestamp/job progress berada di envelope analisis, bukan konten yang dibandingkan untuk replay. Config hash mencakup parser, resolver, exclusion rules, dan taxonomy version.

Implementasi minimum v1 berada di `packages/contracts`: registry PHP/JavaScript/TypeScript, kategori node/edge, origin, resolution/reason, tipe CCM, ID deterministik, JSON/hash canonical, dan validator runtime. Validator menerima byte source secara terpisah dari payload serializable; hash/ukuran file serta setiap evidence diverifikasi terhadap byte tersebut. Offset evidence memakai byte UTF-8 berbasis nol dengan batas akhir eksklusif; baris dan kolom berbasis satu, kolom dihitung dalam Unicode code point, mengikuti konvensi CRLF dan BOM pada fixture QA-01.

Hardening ANA-05 menolak array sparse/properti tambahan dan peta source berbasis getter, memeriksa UTF-8 seluruh file processed, serta memvalidasi bounds parent dan konsistensi edge containment yang diberikan. Registry kategori v1 tetap sama; tidak ada kategori atau relasi semantik baru yang diasumsikan. Hasil deklarasi gabungan PHP/JS/TS diuji setelah round-trip JSON bersama byte snapshot aslinya; rincian dan batas acceptance ada pada [ANA-05_CHECKS](ANA-05_CHECKS.md).

Status valid hanya menyatakan struktur payload dan konsistensinya dengan byte source yang diberikan. Status ini belum membuktikan kelengkapan temuan adapter, ketepatan semantik resolver, batas resource, persistensi/API, ataupun replay pipeline. Penerimaan ANA-05 lengkap tetap memerlukan oracle PHP/JS/TS yang direview dan integrasi analyzer.

## Canonical graph dan proyeksi UI

Canonical CKG adalah hasil lengkap yang menjadi dasar seluruh hitungan. Focus menampilkan node terpilih dan relasi langsungnya; overview mengelompokkan module; all references menampilkan lingkup reference yang diminta. Query/filter hanya mengubah proyeksi tampilan.

Filter kategori dan query digabung dengan operasi AND. Default filter aktif untuk semua kategori terdaftar. Untuk tampilan exact filter, edge hanya ditampilkan jika kedua endpoint lolos; Focus dapat menambahkan tetangga sebagai konteks dengan penanda yang jelas. Hasil kosong memiliki aksi reset yang tidak menghapus data.

Inspector memisahkan incoming dan outgoing, jenis relasi, status resolusi, serta evidence. Satu hubungan yang tampil di UI tidak membuktikan hitungan canonical hanya satu jika proyeksi mengelompokkan beberapa edge; agregasi wajib menampilkan jumlah/evidence aslinya.

Contoh 37 node, 88 edge, dan OrderService pada PDF adalah referensi desain. Nilai tersebut baru boleh menjadi oracle setelah source contoh lengkap tersedia dan diperiksa; screenshot bukan dataset analyzer yang sudah tervalidasi.

## Keterbatasan dan kegagalan

Bahasa di luar scope, syntax yang belum didukung, dependency tidak tersedia, file binary, submodule, serta file yang dikecualikan dicatat dengan path, alasan, dan tahap. Satu file gagal diparse dapat dikecualikan dengan limitation bila masih ada source didukung yang berhasil dan seluruh artefak dapat dibentuk secara jujur.

Tidak ada file didukung yang berhasil, snapshot invalid, pelanggaran resource limit pada arsip atau seluruh job, kontrak CCM invalid, atau kegagalan generator artefak mengakhiri job sebagai `FAILED`. Semua tahap sukses dengan daftar limitation nonkosong menghasilkan `COMPLETED_WITH_LIMITATIONS`; hasil tanpa limitation menghasilkan `COMPLETED`.

### Deteksi source dan exclusion ANA-02

Implementasi worker memakai policy `sage-source-policy-v1`, input dari snapshot full SHA tersimpan dan maksimum 1 MiB per source. File individual yang melampaui batas dikecualikan dengan alasan `SOURCE_FILE_TOO_LARGE`; batas seluruh archive/snapshot tetap fatal. Ekstensi JS/TS/PHP, directory dependency/build, source map, nama minified, binary/UTF-8 invalid, dan submodule dilaporkan secara deterministik. Script, konfigurasi, dependency, serta URL submodule target tidak dieksekusi atau diunduh.

Tidak ada source eligible menghasilkan `NO_SUPPORTED_SOURCE`; semua source eligible gagal parse menghasilkan `PARSE_FAILED`. Source valid tetap dianalisis ketika ada sibling gagal, dengan hasil parsial dan limitation. Handler LANGUAGE_DETECTION dan STATIC_ANALYSIS dipanggil consumer ANA-07 sebelum pembentukan graph dan ADD. Kontrak dan bukti rinci: [ANA-02_CHECKS.md](ANA-02_CHECKS.md).

## Pembentukan dokumen

Dokumen menyimpan repository, branch, full SHA, versi analyzer/schema/config, source hash, dan daftar limitation.

| Artefak | Isi dan batas |
| --- | --- |
| Interface Catalog | Interface/type contract, signature yang diekspor, serta callback yang ditemukan; HTTP URL/method hanya jika ada evidence yang didukung |
| Software Engineering Diagram | Proyeksi struktur/dependency dari graph; definisi ini dipakai untuk menyelesaikan istilah diagram yang masih umum di SRS |
| UML Class Diagram | Class, member, signature, extends/implements, dan dependency yang terbukti; composition/cardinality tidak diasumsikan |

Relasi unresolved tetap terlihat dan berbeda dari exact pada ketiga artefak yang relevan. Node synthetic projection boleh membantu layout, tetapi tidak menambah canonical fact. Setiap elemen artefak menyimpan `nodeIds`/`edgeIds` dan evidence agar sumbernya dapat ditelusuri.

Markdown dan PDF dirender dari document model yang sama. DOC-02 menyediakan source Mermaid mandiri dan SVG melalui `@sage/documents`; DOC-01 menyediakan document model dan halaman hasil; Markdown dan ekspor PDF produk tetap dikerjakan pada EXP-01/EXP-02. Export job tidak menganalisis ulang repository atau mengikuti HEAD terbaru.

## Kontrak proyeksi diagram DOC-02

`projectDiagrams(canonicalJson, sourceBytes, expectedSha256?)` memvalidasi ulang canonical CKG dan menghasilkan dua proyeksi deterministik. Diagram struktur mempertahankan seluruh node/edge; `CONTAINS` diberi label ownership, bukan dependency. UML menampilkan Class/Interface, Method/Property langsung, serta EXTENDS/IMPLEMENTS yang terbukti. Jika adapter tidak mencatat parameter method, labelnya menyatakan `parameter tidak tersedia`; ini tidak mengasumsikan parameter kosong. Fakta di luar subset UML tercatat dalam `excludedNodeIds`/`excludedEdgeIds`; visibility, composition, dan cardinality tidak ditebak.

Bundle menyimpan hash CKG, snapshot, provenance, configuration hash, limitation, salinan fakta canonical, serta pemetaan baris Mermaid ke node/edge ID dan evidence. Member UML mempertahankan ID dan relasi containment induknya walaupun tampil di dalam kotak class. Diagram struktur membedakan Exact dengan garis utuh dan Unresolved dengan garis putus-putus serta alasan. UML memakai panah generalization/realization standar untuk relasi exact; relasi unresolved diberi label UNRESOLVED beserta alasan. Label berasal dari data yang di-encode, sedangkan alias berasal dari ID canonical.

`renderDiagramBundle` menerima canonical CKG yang sama, membangkitkan proyeksi sendiri, lalu merender Mermaid lokal di Chromium tanpa akses jaringan. SVG diperiksa terhadap konten aktif dan referensi eksternal. Dua diagram diterbitkan bersama hanya jika keduanya berhasil. Guard per diagram: 50.000 karakter/byte Mermaid, 500 node, 500 edge, dan SVG 4 MiB; timeout default 15 detik, opsi 250–30.000 ms. Batas ini guard renderer, bukan klaim kapasitas repository produk. Input berlebih ditolak tanpa pemotongan fakta.

## Model ADD dan batas publikasi DOC-01

`projectArchitectureDocument` membentuk `sage-add-v1` dari satu canonical CKG dan byte snapshot tervalidasi. Model memuat context repository/branch/full SHA, hash CKG/configuration, provenance, metadata file, counts canonical, limitation, Interface Catalog, Software Engineering Diagram dan UML Class Diagram. JSON/hash deterministik tidak memasukkan ID job, waktu generate atau status antrean. `parseCanonicalArchitectureDocument` meregenerasi proyeksi yang diharapkan dan menolak JSON/hash atau fakta/mapping yang berubah.

Interface Catalog mencatat deklarasi source non-Module beserta signature nullable, ID node/relasi dan evidence. Cakupan ini tidak menyatakan semua deklarasi sebagai API publik. Ekspor hanya ditunjukkan oleh fakta EXPORTS; callback, HTTP method/URL, visibility atau type alias yang tidak direkam CCM tidak dibuat. Seluruh relasi canonical, termasuk CONTAINS serta Unresolved beserta alasan dan evidence, dipertahankan sebagai observasi. Kedua proyeksi diagram memakai kontrak DOC-02 yang sama.

Stage 6–8 menghasilkan artefak terpisah dengan identitas CKG/document dan context yang sama; stage 9 memverifikasi ulang ketiganya lalu menyimpan seluruh dokumen dalam satu transaksi. Penulisan dibatasi owner, attempt/token, lease berdasarkan jam database, tahap aktif, target immutable dan GraphBundle yang cocok. Replay identik boleh diterima; isi berbeda tidak menimpa hasil. Reader hasil hanya mengembalikan dokumen canonical milik akun untuk analisis sukses.

Atomicity DOC-01 berarti ketiga artefak dokumen tersedia bersama dalam satu baris internal. Publikasi GraphBundle + dokumen + resultHash dan status Analysis/Job terminal berhasil merupakan ANA-07 #16. Consumer ANA-07 menjalankan publikasi setelah sembilan tahap selesai; penyelesaian tahap saja tidak mengubah status terminal. Halaman dan API dokumen DOC-01 membaca model canonical hanya setelah status sukses. Diagram dirender Mermaid lokal dengan guard DOC-02 dan SVG diperiksa sebelum ditampilkan sebagai gambar Blob. Batas/kegagalan render terlihat tanpa memotong fakta atau menyatakan diagram sukses. Download Markdown/PDF tetap mengikuti #20/#21.
