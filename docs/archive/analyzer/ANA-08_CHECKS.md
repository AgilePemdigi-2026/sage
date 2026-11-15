# ANA-08 — Resolver statis dan proyeksi arsitektur

Issue: [#107](https://github.com/AgilePemdigi-2026/sage/issues/107). Revisi ini memperbaiki target lokal yang sebelumnya tidak terpecahkan dan penyajian graph/UML tanpa mengubah hasil canonical yang sudah tersimpan.

## Temuan dan perubahan

- Resolver JS/TS 0.2.0 melewatkan instance `const` di scope fungsi, receiver field/constructor-property bertipe dan anggota pewarisan yang dapat dibuktikan. Versi 0.3.0 menambahkan lookup tersebut beserta scope/shadowing/mutasi/private/static/ambiguity guards. Type parameter tidak lagi keliru mengikat class global bernama sama. TS `paths` dapat dipakai tanpa `baseUrl`, dengan alias paling spesifik.
- Resolver PHP 0.3.0 melacak assignment `new` langsung dalam alur lurus. Class terbuka, union, binding kondisional, by-reference/closure/foreach serta receiver ambigu tetap konservatif. Signature parameter fungsi/method lokal dipakai untuk mendeteksi argumen by-reference; callee eksternal/dinamis tanpa signature lokal membuat binding argumen dianggap escaped. Signature by-value yang diketahui tidak membuang fakta tipe.
- UML canonical lama hanya memproyeksikan pewarisan. Proyeksi pembacaan sekarang mengambil dependency dari graph lengkap, mengangkat method/property ke class pemilik, serta mempertahankan setiap ID/endpoint/evidence asli pada mapping. Tidak mengarang asosiasi bisnis, multiplicity, aggregation atau composition.
- Graph awal **Esensial** mengutamakan deklarasi source terhubung, merangkum anggota dan relasi Exact antar-pemilik, serta mengeluarkan placeholder dan file tes/generated/vendor dari tampilan awal. Batas 60 node/150 relasi kelompok; detail AST, fokus dan semua referensi tetap tersedia dengan batas render eksplisit.
- UML utama memakai arah atas-ke-bawah dan semua class/interface source jika masih dalam batas 40 interaktif/12 PDF. Model besar dipilih deterministik berdasarkan konektivitas. Anggota maksimal 4/3 per class, kelompok relasi maksimal 100/24, dan maksimal 500 record relasi yang dirender. Seluruh canonical dan Markdown tetap lengkap.
- BCE adalah klasifikasi **tampilan** dari konvensi nama/path, dengan alasan tercatat. Class tanpa petunjuk atau dengan petunjuk bertentangan tidak dipaksakan mendapat peran. Dependency kind berbeda pada pasangan class/status sama digabung menjadi satu panah berlabel; pewarisan tetap terpisah. Jumlah kelompok source bisa melebihi jumlah panah visual.
- UI menyediakan ringkasan alasan `Unresolved` dan tidak menghitung `CONTAINS` sebagai keberhasilan resolusi. Default fit menampilkan UML utuh; zoom tersedia untuk membaca detail. Ekspor baru memakai renderer PDF 2.2.0.

## Perbandingan yang dapat direproduksi

Input: `tests/fixtures/architecture-bce/order.ts`, SHA-256 `5802e7097a448ab25301d135acb41dc76b934cbc44b90e1bafa46b16fe776a15`.

| Resolver JS/TS | Referensi, tanpa CONTAINS | Exact | Unresolved |
| --- | ---: | ---: | ---: |
| 0.2.0 | 21 | 16 | 5 |
| 0.3.0 | 21 | 21 | 0 |

Kelima perbaikan mencakup `controller.submit`, `this.controller.submit`, `this.service.create`, pewarisan `this.updateTotal` dan `this.total`. Target dan evidence diperiksa dari source. Ini fixture terkontrol, **bukan** persentase keberhasilan repository pengguna atau benchmark lintas framework. Artefak lokal di `artifacts/ana08/resolver-before.json` dan `resolver-after.json` diabaikan Git.

## Pengujian dan batas bukti

Hasil aktual pada 29 Oktober 2026 (Node 24 / PHP, container QA terpisah):

| Pemeriksaan | Hasil |
| --- | --- |
| `npm run check` pada source final, termasuk guard nullsafe PHP | Lulus: lint/typecheck, 401 unit dan 8 database foundation |
| Next production build | Lulus |
| Landing, pemilihan repository dan pergantian akun | Lulus pada 360/390/768/1024/1440; provider metadata terkontrol |
| Graph/inspector/source dan owner boundaries | Lulus 25 pemeriksaan pada 5 viewport; hash canonical tidak berubah |
| HTTP/queue/worker ekspor, retry, owner/account, Markdown equivalence | Lulus pada 390/1440 |
| BCE dari source fixture | 5/5 class dan hubungan tampil, default fit utuh tanpa internal scroll, tanpa horizontal overflow pada 390/1440 |
| PDF BCE | 4 halaman A4; UML satu SVG utuh, halaman UML diperiksa visual dan teks, tanpa image raster |

Log lokal: `artifacts/ana08/check-final.log`, `final-check-and-live.log`, `graph/report.json`, `live/report.json`; artefak test diabaikan Git. Run pertama lulus sebelum perbaikan fit/penyederhanaan panah; run final menguji ulang PDF/browser setelah perbaikan. Source final PHP nullsafe diverifikasi ulang melalui `npm run check` sesudah browser selesai.

Percobaan awal menemukan dua oracle lama yang masih mengharapkan Unresolved untuk binding lokal yang kini terbukti; ekspektasi diganti dengan assertion target spesifik, bukan sekadar menghapus assertion. Oracle TypeScript menambah dua kasus negatif source-backed yang tetap unresolved. Review independen juga menemukan scope loop/destructuring JS, `??=`/alias referensi/callee by-reference PHP, serta token panah UML yang tidak valid; semuanya mendapat regresi.

Browser memakai Next produksi, PostgreSQL disposable dan worker produksi. Identitas/snapshot adalah fixture terkontrol; pengujian ini tidak mengulang OAuth/provider GitHub nyata maupun menganalisis ulang history pengguna. Uji mencakup owner/account boundaries, graph canonical/inspector/source, Markdown byte-equivalence, PDF HTTP/queue/worker/download/retry, dan lima class BCE pada 390/1440 piksel. Data produk serta history lama tidak dihapus atau ditulis ulang.

## Pemakaian dan keterbatasan

Jalankan **analisis baru** untuk memakai resolver 0.3.0. Membuka history lama mempertahankan provenance dan fakta resolver aslinya; proyeksi baca baru tetap dapat dipakai pada hasil lama. Perilaku dinamis, source dependensi eksternal, receiver ambigu dan syntax belum didukung tetap `Unresolved`. Tidak semua repository mengikuti BCE atau memiliki class; proyeksi tidak menciptakan class untuk fungsi atau modul.

Referensi: [GitDiagram](https://github.com/ahmedkhaleel2004/gitdiagram) untuk penyajian arsitektur ringkas dengan tautan source; SAGE tetap deterministik dan tidak memakai model generatif untuk mengklaim relasi Exact. [BMC BCE](https://docs.helixops.ai/bin/Service-Management/IT-Service-Management/BMC-Helix-ITSM/itsm251/Inclusions-library/Use-case-diagram-legend/), [TypeScript paths](https://www.typescriptlang.org/tsconfig/paths.html), dan [Mermaid class diagram](https://mermaid.js.org/syntax/classDiagram.html) menjadi acuan pembagian peran, konfigurasi alias dan notasi.
