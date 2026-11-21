# Spesifikasi analisis

Kontrak teknis memakai CCM `schemaVersion = 1`, canonical CKG `sage-ckg-v1`, semantic model `sage-semantic-v2`, dan ADD baseline `sage-add-baseline-v1`. `sage-add-v1` adalah model dokumen legacy yang masih ada untuk kompatibilitas dan bukan keluaran ADD aktif. Bukti adapter terdahulu tercatat di [arsip analyzer](../archive/README.md#analyzer); bukti itu tidak otomatis memvalidasi kontrak ADD baru. Perubahan kontrak harus memperbarui API, model data, fixture, dan traceability.

## Prinsip

Analisis memakai satu snapshot full commit SHA sebagai sumber tetap. Adapter statis menghasilkan Common Code Model (CCM), lalu canonical Code Knowledge Graph (CKG). Semantic model fitur dan data dibangun dari CKG beserta source bytes snapshot yang sama. TOGAF ADD baseline memproyeksikan kedua model canonical tersebut; Code Knowledge adalah view pendamping, bukan dokumen arsitektur utama.

Bedakan jenis relasi dari status resolusinya. `CALLS` adalah jenis relasi; `Exact` atau `Unresolved` menjelaskan tingkat penyelesaiannya. `Inferred` tidak menjadi status MVP. Hubungan arsitektur, HTTP endpoint, cardinality, composition, dan perilaku runtime tidak diciptakan hanya dari nama class atau dugaan framework.

## Kriteria capability

Tabel berikut menjelaskan kriteria kontrak, bukan jaminan semua pola source didukung. Dukungan aktual dibatasi fixture dan versi adapter/resolver pada [ANA-03 JS/TS](../archive/analyzer/ANA-03_CHECKS.md), [ANA-04 PHP](../archive/analyzer/ANA-04_CHECKS.md), serta [pemeriksaan resolver](../archive/analyzer/RESOLVER_CHECKS.md).

| Kemampuan | JS/TS | PHP | Python | Kriteria |
| --- | --- | --- | --- | --- |
| Struktur module/file dan deklarasi | Parser AST | PHP-Parser | Pemindai line-structured terbatas | Hasil aktual harus dicocokkan dengan fixture; status kolom bukan jaminan kelengkapan bahasa |
| Class, function, method, property | Didukung sesuai grammar adapter | Didukung sesuai grammar adapter | Deklarasi dasar dan properti terbatas | Signature/source evidence mengikuti bentuk yang berhasil dibaca |
| Import, inheritance, relasi lokal | Static subset | Static subset | Import/inheritance literal terbatas | Dynamic dispatch tetap unresolved atau menjadi limitation |
| Routing | Pola framework terpilih | Laravel patterns | FastAPI-style literal decorator | Tidak menganggap seluruh framework atau runtime route terdeteksi |
| Data/interface contracts | SQL, OpenAPI JSON/YAML, selected JSON Schema | Sama, independen bahasa | Sama, independen bahasa | File format dipindai secara statis dan memiliki limitation saat pola tidak dikenali |

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

Kategori tambahan untuk `TypeAlias`, `Enum`, dan `Trait` memerlukan fixture, label/filter UI, dan keputusan taxonomy pada spike; jangan menyamarkannya sebagai kategori lain. Sampai kategorinya terdaftar, catat konstruksi yang belum terwakili sebagai keterbatasan. [Spike taxonomy ANA-05](../archive/analyzer/CCM_TAXONOMY_SPIKE.md) mencatat karakterisasi dua adapter, alasan mempertahankan registry v1 saat ini, dan syarat perluasannya; bukan klaim dukungan konstruksi tersebut.

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

Implementasi minimum v1 berada di `packages/contracts`: registry PHP/JavaScript/TypeScript/Python, kategori node/edge, origin, resolution/reason, tipe CCM, ID deterministik, JSON/hash canonical, dan validator runtime. Validator menerima byte source secara terpisah dari payload serializable; hash/ukuran file serta setiap evidence diverifikasi terhadap byte tersebut. Offset evidence memakai byte UTF-8 berbasis nol dengan batas akhir eksklusif; baris dan kolom berbasis satu, kolom dihitung dalam Unicode code point, mengikuti konvensi CRLF dan BOM pada fixture QA-01.

Hardening ANA-05 menolak array sparse/properti tambahan dan peta source berbasis getter, memeriksa UTF-8 seluruh file processed, serta memvalidasi bounds parent dan konsistensi edge containment yang diberikan. Registry kategori v1 tetap sama; tidak ada kategori atau relasi semantik baru yang diasumsikan. Catatan pemeriksaan gabungan PHP/JS/TS di [ANA-05_CHECKS](../archive/analyzer/ANA-05_CHECKS.md) adalah bukti historis untuk fixture saat itu. Adapter Python yang ditambahkan kemudian menggunakan registry bahasa, tetapi belum memiliki validasi oracle setara yang dicatat di arsip.

Status valid hanya menyatakan struktur payload dan konsistensinya dengan byte source yang diberikan. Status ini belum membuktikan kelengkapan temuan adapter, ketepatan semantik resolver, batas resource, persistensi/API, ataupun replay pipeline. Cakupan oracle PHP/JS/TS pada [review oracle](../archive/qa/QA-01_ORACLE_REVIEW.md) bersifat historis; kemampuan Python dan proyeksi ADD baru memerlukan oracle tersendiri dan tidak boleh disimpulkan dari validasi schema saja.

## Canonical graph dan proyeksi UI

Canonical CKG adalah hasil lengkap yang menjadi dasar seluruh hitungan. Focus menampilkan node terpilih dan relasi langsungnya; overview mengelompokkan module; all references menampilkan lingkup reference yang diminta. Query/filter hanya mengubah proyeksi tampilan.

Filter kategori dan query digabung dengan operasi AND. Default filter aktif untuk semua kategori terdaftar. Untuk tampilan exact filter, edge hanya ditampilkan jika kedua endpoint lolos; Focus dapat menambahkan tetangga sebagai konteks dengan penanda yang jelas. Hasil kosong memiliki aksi reset yang tidak menghapus data.

Inspector memisahkan incoming dan outgoing, jenis relasi, status resolusi, serta evidence. Satu hubungan yang tampil di UI tidak membuktikan hitungan canonical hanya satu jika proyeksi mengelompokkan beberapa edge; agregasi wajib menampilkan jumlah/evidence aslinya.

Contoh 37 node, 88 edge, dan OrderService pada PDF adalah referensi desain. Nilai tersebut baru boleh menjadi oracle setelah source contoh lengkap tersedia dan diperiksa; screenshot bukan dataset analyzer yang sudah tervalidasi.

## Keterbatasan dan kegagalan

Bahasa di luar scope, syntax yang belum didukung, dependency tidak tersedia, file binary, submodule, serta file yang dikecualikan dicatat dengan path, alasan, dan tahap. Satu file gagal diparse dapat dikecualikan dengan limitation bila masih ada source didukung yang berhasil dan seluruh artefak dapat dibentuk secara jujur.

Tidak ada file didukung yang berhasil, snapshot invalid, pelanggaran resource limit pada arsip atau seluruh job, kontrak CCM invalid, atau kegagalan generator artefak mengakhiri job sebagai `FAILED`. Semua tahap sukses dengan daftar limitation nonkosong menghasilkan `COMPLETED_WITH_LIMITATIONS`; hasil tanpa limitation menghasilkan `COMPLETED`.

### Deteksi source dan exclusion ANA-02

Implementasi worker memakai policy `sage-source-policy-v1`, input dari snapshot full SHA tersimpan dan maksimum 1 MiB per source. File individual yang melampaui batas dikecualikan dengan alasan `SOURCE_FILE_TOO_LARGE`; batas seluruh archive/snapshot tetap fatal. Ekstensi JS/TS/PHP/Python, directory dependency/build, source map, nama minified, binary/UTF-8 invalid, dan submodule dilaporkan secara deterministik. Script, konfigurasi, dependency, serta URL submodule target tidak dieksekusi atau diunduh. SQL/OpenAPI/JSON Schema dibaca sebagai data kontrak; dukungan format ini tidak berarti semua bahasa pemrogramannya didukung.

Tidak ada source eligible menghasilkan `NO_SUPPORTED_SOURCE`; semua source eligible gagal parse menghasilkan `PARSE_FAILED`. Source valid tetap dianalisis ketika ada sibling gagal, dengan hasil parsial dan limitation. Handler LANGUAGE_DETECTION dan STATIC_ANALYSIS dipanggil consumer ANA-07 sebelum pembentukan graph dan ADD. Kontrak dan bukti rinci: [ANA-02_CHECKS.md](../archive/analyzer/ANA-02_CHECKS.md).

## TOGAF Phase C ADD baseline

ADD aktif memakai `sage-add-baseline-v1`, profile ArchiMate subset versi 3.2, satu snapshot source, source CKG hash, canonical semantic model, provenance, evidence, dan limitations. Ia dibuat setelah pipeline analisis selesai melalui endpoint owner-scoped Generate ADD. Legacy `sage-add-v1` dan stage lama tetap tersedia demi kompatibilitas data, bukan sebagai output aktif.

| Bagian baseline | Keluaran | Batas inferensi |
| --- | --- | --- |
| Data Architecture | Data entity catalog, Data Structure view, application-data CRUD matrix | Owner, distribusi fisik, runtime schema, dan akses dinamis tidak diasumsikan |
| Application Architecture | Application portfolio, interface catalog, functional decomposition, Application Cooperation view | Satu repository diproyeksikan sebagai satu scope aplikasi; deployment dan business capability tidak disimpulkan |
| Application interactions | Matriks komunikasi antar aplikasi | Dibiarkan kosong jika source tidak membuktikan aplikasi terpisah dan mekanisme interaksi |
| Narrative | Ringkasan baseline data dan aplikasi | Narrative deterministik secara default; LLM opsional hanya setelah consent dan hanya untuk wording |

`Proven`/`Indicated` adalah kategori evidence untuk ADD relationship; keduanya tidak mengubah resolver status `Exact`/`Unresolved`. ArchiMate view hanya menggunakan tipe elemen/relasi yang diizinkan subset saat ini. Model tidak menyatakan kepatuhan penuh ke ArchiMate metamodel atau menghasilkan native exchange file.

Review user mengubah label, feature group, dan status review melalui append-only overlay berversi. Fakta source canonical tidak ditimpa dan hubungan baru tidak dibuat. Simpan memakai optimistic revision; revisi basi mendapat conflict. Snapshot ADD terikat ke owner, analysis dan source CKG hash.

Markdown memuat katalog, matriks, view, relationships, confidence/reason, limitations, status review, serta evidence dengan commit dan line range. PDF menggunakan halaman A4 dan SVG melalui print browser. Cache/export harus mengambil snapshot model dan overlay yang sama; renderer/cache key perlu menyertakan identitas model, koreksi, dan renderer. Detail implementasi dan batas saat ini ada di [kontrak TOGAF ADD](TOGAF_ADD.md).


## Lapisan semantik fitur dan alur

Model `sage-semantic-v2` dibangun setelah CCM/CKG tervalidasi, dari byte source snapshot yang sama. Model ini mengenali fitur, aktor, konsep, komponen, penyimpanan, langkah, keputusan, dan hasil; hubungan memiliki evidence, alasan dan kategori `proven`/`indicated`. Kategori tersebut tidak mengubah `Exact`/`Unresolved`. Resolver bahasa dan extractor framework adalah kontrak berbeda. Source repository tidak dijalankan. Extractor semantik deterministic tanpa layanan eksternal; hanya wording ADD yang dapat memakai LLM opsional dengan consent.

Next.js App Router dan Laravel adalah pola awal; unsupported/dynamic bindings dicatat sebagai batasan. Source backend saja tidak membuktikan layar frontend. Koreksi tersimpan terpisah dari fakta canonical. Lihat [kontrak semantik](SEMANTIC_ANALYSIS.md) dan [snapshot acuan](../evidence/semantic/oracle.json).

## Dukungan alur dan keluaran

Model semantik terpisah mengenali pola Next.js App Router, Laravel, Node HTTP terbatas, FastAPI-style literal route, serta SQL/OpenAPI/selected JSON Schema contracts. Dukungan berlaku pada pola yang dikenali saja; tidak semua repository dengan framework atau format tersebut otomatis memperoleh alur. Hubungan memiliki evidence dan confidence Proven/Indicated tanpa mengubah resolution Exact/Unresolved. Import dan kedekatan direktori tidak dipakai sebagai bukti urutan aktivitas. Lihat [kontrak semantik](SEMANTIC_ANALYSIS.md) dan [kontrak ADD](TOGAF_ADD.md).

PDF menyajikan ringkasan serta diagram vektor A4; alur besar dibagi agar terbaca. Markdown memuat detail hingga batas 32 MiB. Detail teknis file/metode tidak harus menjadi node utama diagram semantik; lihat [aturan keluaran](DOCUMENT_PRESENTATION.md).

### Snapshot source untuk repository dengan aset besar

Worker memeriksa Git tree pada commit target sebelum mengunduh arsip. Repository sampai 20 MiB tetap memakai arsip lengkap. Untuk repository lebih besar, snapshot mengambil Git blob file reguler yang lolos filter, dengan maksimal 250 file, 1 MiB per file, total source 20 MiB, empat request paralel, dan deadline snapshot 60 detik. Arsip yang disimpan tetap dibatasi 25 MiB; batas resource tidak dinaikkan.

Model biner seperti ONNX, aset gambar/font/media, direktori dependency/generated, symlink, submodule, dan file yang melebihi batas dilewati. Hash Git blob diverifikasi sebelum pengarsipan. Daftar file yang dilewati disimpan pada hasil tahap snapshot dan ditampilkan sebagai batasan analisis; submodule tidak diunduh. Python didukung secara konservatif dengan pemindai line-structured, bukan parser AST penuh. Bahasa/framework lain belum otomatis didukung.

Request API menggunakan token pengguna yang sudah login. Snapshot lama tidak diubah; jalankan ulang analisis yang sebelumnya gagal.
