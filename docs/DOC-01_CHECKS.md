# Verifikasi model ADD dan integrasi tiga artefak DOC-01

Tanggal: 21 Oktober 2026, Asia/Jakarta. Issue [#15](https://github.com/AgilePemdigi-2026/sage/issues/15). Base `7a1070eb65293bd8d951e522521eaf4b49f6322b`. Pengiriman/commit: Zarra (`zarrrafirdaus`). Review dan merge: Iltizam (`iltizamhasan3`) setelah review PR independen.

## Implementasi

Model canonical `sage-add-v1` dibentuk dari CKG dan byte snapshot yang sama untuk Interface Catalog, Software Engineering Diagram serta UML Class Diagram. Context immutable, source metadata/hash, configuration, provenance, limitation dan traceability ID/evidence tetap melekat. Signature yang tidak tercatat tetap null; katalog deklarasi tidak mengasumsikan seluruh simbol adalah API publik. HTTP endpoint/callback/visibility/type alias yang tidak dibuktikan CCM tidak ditambahkan. Relasi unresolved beserta alasan/evidence dipertahankan.

JSON/hash dokumen deterministik; ID record, job dan waktu generate berada di luar hash. Parser meregenerasi model yang diharapkan dari canonical CKG dan menolak perubahan metadata, fakta, mapping, source atau hash. Diagram memakai proyeksi DOC-02, bukan resolver ulang.

Handler tahap 6–8 mengikat artefak ke CKG/document hash dan context yang sama. Tahap 9 memeriksa ulang ketiganya sebelum menyimpan seluruh artifact dalam satu transaksi yang dibatasi owner, active stage, attempt/token serta lease menurut jam PostgreSQL. GraphBundle harus cocok dengan CKG, mirror, config dan target immutable. Replay identik idempotent; hasil berbeda tidak menimpa. Lease yang habis ketika transaksi berjalan menyebabkan rollback.

Reader canonical mensyaratkan pemilik dan status analisis sukses, lalu memverifikasi graph, dokumen serta mirror/hash/source. Dokumen selama RUNNING tetap internal. Penulisan satu baris lengkap tidak mempublikasikan status Analysis/Job; penerbitan hasil penuh mengikuti ANA-07 #16.

## Hasil aktual

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| Migrasi fresh PostgreSQL dan generate client | Schema kompatibel, canonicalContent nullable untuk legacy | PASS; delapan migrasi diterapkan |
| Lint/typecheck root dan web | Tanpa error/warning | PASS |
| Unit/contract dan tes data | Seluruh tes lulus | 282/282 + 8/8 PASS |
| Integrasi PostgreSQL | Atomic row, fence, replay, corruption, lease rollback, handler nyata | 3/3 PASS, tidak ada skip |
| Build production Next.js | Route dokumen/API terbangun | PASS |
| Next.js/PostgreSQL/Chromium nyata | Auth/status/hash/evidence serta safe error | PASS |
| Lima viewport 360/390/768/1024/1440 | Katalog dan kedua diagram, keyboard/zoom tanpa overflow halaman | PASS |
| Label Unicode/HTML-like path | Teks SVG tetap terbaca dan inert, tanpa external resource | PASS |
| Pergantian akun dengan body lama tertahan | Session menolak identitas lama, akun baru menerima 404 dan katalog lama hilang | PASS |
| Retry UI terkontrol | Satu 503 bertanda menampilkan Coba lagi, kemudian API nyata pulih | PASS |
| Pemeriksaan browser keseluruhan | Tidak ada browser error atau provider request | 13/13 PASS; 0 error, 0 off-origin/provider request |
| Visual manual | Mobile metadata membungkus; UML dan diagram struktur dapat dibaca dengan zoom | PASS pada screenshot mobile/desktop serta diagram viewport 400% |

Lingkungan: Node 24.22.0, npm 11.17.0, PHP 8.4.26, Next.js 16.4.2, Prisma 7.10.1, PostgreSQL 17.11, Mermaid 12.2.0 dan Chromium 156.0.8078.4. Suite utama dijalankan penuh; setelah perbaikan tampilan, lint/typecheck/build serta Playwright diulang pada hasil terbaru.

Fixture browser membaca dua source resolver TypeScript yang tersimpan dan satu source Unicode terkontrol: 3 file, 20 node dan 27 relasi. Snapshot SHA sintetis `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`, hash CKG `9c3164127eac8715fb0b928a79de0053d5904c8fd615d04c25ee9838dacd6dd5`, hash dokumen `0b205c3e4b462d36ca32ad40121f19997c1b03aea2156f22f48ca653057849c4`. Full source hash/ukuran, report, sepuluh SVG dan screenshot tersimpan pada `artifacts/document-15` yang diabaikan Git. Source HTML/URL canary tetap di luar payload API; path `<script>` tampil sebagai teks, tanpa elemen aktif.

Pengujian menemukan dan memperbaiki overflow hash pada mobile serta numeric entity Mermaid yang terpotong di beberapa baris. Dekode satu lapis dilakukan hanya melalui textContent sambil mempertahankan posisi baris SVG. Zoom 100–400% dan reset memakai tombol native yang diuji Enter/Space; area diagram memiliki scroll lokal dan dapat difokuskan lewat keyboard. Batas diagram tetap 50.000 karakter/byte, 500 node/relasi dan SVG 4 MiB; input berlebih ditolak eksplisit tanpa truncation. Budget karakter/byte/node/edge diuji pada unit; report browser ini memakai diagram di bawah batas.

```sh
npm run db:generate
npm run db:migrate
npm run check
SAGE_DOCUMENT_TESTS=1 npm run test:documents:integration
npm run build
SAGE_DOCUMENT_TESTS=1 npm run test:documents:live
git diff --check
```

Script browser memerlukan server Next.js production yang berjalan terpisah, STORAGE_ROOT absolut di direktori sementara kosong dengan izin 0700, dan CREDENTIAL_ENCRYPTION_KEY khusus uji yang sama pada server/script; nilai key tidak dicatat di repository.

Integrasi wajib memakai database disposable `sage_document15` dan opt-in `SAGE_DOCUMENT_TESTS=1`; script tidak diarahkan ke database aplikasi. Runner dibatasi 1 CPU/2 GiB dan PostgreSQL 0,5 CPU/256 MiB dengan data tmpfs, jaringan internal serta tanpa port host.

## Batas penerimaan

Paket ini membuktikan model, atomic row persistence, handler dokumen serta API/halaman pembaca privat. Snapshot integrasi berasal dari source fixture publik yang disimpan dalam archive uji; tidak ada GitHub live atau credential pengguna. Stage 2–9 memakai implementasi nyata, sementara stage snapshot fixture merupakan producer terkontrol. Tidak ada klaim consumer produk aktif, retry UI, publikasi terminal hasil atau E2E GitHub penuh. Halaman produk menampilkan katalog dan merender SVG dari proyeksi Mermaid lokal, dengan batas keamanan dan state error eksplisit. Download/ekspor Markdown/PDF mengikuti #20/#21.

Gate formal QA-01 #4 dan ANA-05/06 #11/#14 tidak ditutup oleh paket ini; bukti teknis dependency dipakai tanpa mengklaim signoff manusia tim yang belum diberikan.
