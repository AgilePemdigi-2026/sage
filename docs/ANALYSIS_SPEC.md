# Spesifikasi analisis

Status: kontrak teknis awal `schemaVersion = 1`; belum menjadi hasil analyzer yang telah diuji. Perubahan kontrak harus memperbarui API, data model, fixture, dan traceability.

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

Kategori tambahan untuk `TypeAlias`, `Enum`, dan `Trait` memerlukan fixture, label/filter UI, dan keputusan taxonomy pada spike; jangan menyamarkannya sebagai kategori lain. Sampai kategorinya terdaftar, catat konstruksi yang belum terwakili sebagai keterbatasan.

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

## Canonical graph dan proyeksi UI

Canonical CKG adalah hasil lengkap yang menjadi dasar seluruh hitungan. Focus menampilkan node terpilih dan relasi langsungnya; overview mengelompokkan module; all references menampilkan lingkup reference yang diminta. Query/filter hanya mengubah proyeksi tampilan.

Filter kategori dan query digabung dengan operasi AND. Default filter aktif untuk semua kategori terdaftar. Untuk tampilan exact filter, edge hanya ditampilkan jika kedua endpoint lolos; Focus dapat menambahkan tetangga sebagai konteks dengan penanda yang jelas. Hasil kosong memiliki aksi reset yang tidak menghapus data.

Inspector memisahkan incoming dan outgoing, jenis relasi, status resolusi, serta evidence. Satu hubungan yang tampil di UI tidak membuktikan hitungan canonical hanya satu jika proyeksi mengelompokkan beberapa edge; agregasi wajib menampilkan jumlah/evidence aslinya.

Contoh 37 node, 88 edge, dan OrderService pada PDF adalah referensi desain. Nilai tersebut baru boleh menjadi oracle setelah source contoh lengkap tersedia dan diperiksa; screenshot bukan dataset analyzer yang sudah tervalidasi.

## Keterbatasan dan kegagalan

Bahasa di luar scope, syntax yang belum didukung, dependency tidak tersedia, file binary, submodule, serta file yang dikecualikan dicatat dengan path, alasan, dan tahap. Satu file gagal diparse dapat dikecualikan dengan limitation bila masih ada source didukung yang berhasil dan seluruh artefak dapat dibentuk secara jujur.

Tidak ada file didukung yang berhasil, snapshot invalid, pelanggaran resource limit, kontrak CCM invalid, atau kegagalan generator artefak mengakhiri job sebagai `FAILED`. Semua tahap sukses dengan daftar limitation nonkosong menghasilkan `COMPLETED_WITH_LIMITATIONS`; hasil tanpa limitation menghasilkan `COMPLETED`.

## Pembentukan dokumen

Dokumen menyimpan repository, branch, full SHA, versi analyzer/schema/config, source hash, dan daftar limitation.

| Artefak | Isi dan batas |
| --- | --- |
| Interface Catalog | Interface/type contract, signature yang diekspor, serta callback yang ditemukan; HTTP URL/method hanya jika ada evidence yang didukung |
| Software Engineering Diagram | Proyeksi struktur/dependency dari graph; definisi ini dipakai untuk menyelesaikan istilah diagram yang masih umum di SRS |
| UML Class Diagram | Class, member, signature, extends/implements, dan dependency yang terbukti; composition/cardinality tidak diasumsikan |

Relasi unresolved tetap terlihat dan berbeda dari exact pada ketiga artefak yang relevan. Node synthetic projection boleh membantu layout, tetapi tidak menambah canonical fact. Setiap elemen artefak menyimpan `nodeIds`/`edgeIds` dan evidence agar sumbernya dapat ditelusuri.

Markdown dan PDF dirender dari document model yang sama. Renderer diagram diputuskan setelah spike; Markdown memuat source diagram yang mandiri, sedangkan PDF memuat diagram terender tanpa tautan aset lokal yang hilang. Export job tidak menganalisis ulang repository atau mengikuti HEAD terbaru.
