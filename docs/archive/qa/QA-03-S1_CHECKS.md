# QA-03-S1 — Verifikasi UI dasar

Scope: `/ui-preview` dan `/graph-preview`, seluruhnya memakai fixture. Ini bukan acceptance login GitHub, analisis repository, history, ekspor, atau seluruh layar produk; QA-03 #25 tetap terbuka.

Base aplikasi: `521704824127a497e3e24b33732ad698fe2b2205`, ditambah perubahan stylesheet pada PR ini. Penanggung jawab paket/identitas commit: `liliks13`. Pemeriksaan browser, inspeksi screenshot, dan review kode terpisah dilakukan secara otomatis; bukan klaim pengujian manual anggota.

## Cara mengulang

Jalankan aplikasi hasil production build, lalu:

```sh
BASE_URL=http://localhost:3000 UI_EVIDENCE_DIR=artifacts/qa-03-s1/ui npm run test:ui
BASE_URL=http://localhost:3000 GRAPH_EVIDENCE_DIR=artifacts/qa-03-s1/graph npm run test:graph
BASE_URL=http://localhost:3000 QA_APP_COMMIT_SHA=<full-base-sha> npm run test:ui:baseline
```

Gunakan Node 24 sesuai Docker proyek. `QA_APP_COMMIT_SHA` adalah base, bukan klaim working tree tanpa perubahan. Report tambahan mencatat hash stylesheet yang diperiksa, full SHA snapshot fixture, hash file sumber fixture, manifest, runtime, expected/actual tiap pemeriksaan, dan tanggal eksekusi. Output lokal di `artifacts/qa-03-s1/` diabaikan Git.

## Matriks penerimaan

Seluruh skenario berikut diperiksa pada lebar 360, 390, 768, 1024, dan 1440 piksel, tinggi awal 1000 piksel.

| Area/state | Expected | Actual |
| --- | --- | --- |
| Login idle/loading/denied/error/connected | Label Indonesia, loading disabled, denial/error dapat dipulihkan | PASS; report UI |
| Repository ready/loading/empty/error/search | Pilihan, validasi target, pencarian kosong, dan retry konsisten | PASS; report UI |
| Branch loading/empty/error/stale | Pilihan/submit disabled saat tidak siap; retry mengembalikan fokus | PASS; report UI |
| Progress QUEUED/RUNNING/FAILED/COMPLETED/COMPLETED_WITH_LIMITATIONS/loading/error/empty | Sembilan state tahap konsisten; downstream gagal tetap pending; tidak membuka hasil dummy | PASS; report UI |
| Graph awal/terpilih/unresolved | Sepuluh node fixture, kategori dan jenis relasi berlabel; unresolved tidak mengarang lokasi deklarasi | PASS; report graph |
| Keyboard/fokus | Skip link, Tab, Enter/Spasi, zoom, dan daftar node dapat digunakan; fokus terlihat | PASS; report tambahan |
| Lima viewport | Tidak ada overflow halaman; label dan kontrol tetap tersedia | PASS; ketiga report |
| Kontras teks DOM | Sedikitnya 4,5:1 untuk teks biasa atau 3:1 untuk teks besar | PASS; per skenario UI dan report tambahan graph |
| Batas kontrol/selected/fokus graph | Rasio sedikitnya 3:1 terhadap permukaannya | PASS; report tambahan |
| Isolasi fixture | Tidak ada request API/GitHub atau error browser | PASS; ketiga report |

## Temuan dan perbaikan

Batas tombol zoom semula 1,59:1 dan batas node terpilih 1,72:1 terhadap permukaan masing-masing. PR ini mengganti warna batas tombol menjadi `#7c8ba1` dan batas selected menjadi `#096c67`; pemeriksaan tambahan mengharuskan keduanya sedikitnya 3:1. Tidak ada perubahan alur produk.

Skrip tambahan semula memakai selector nama class CSS Modules yang tidak tersedia di browser dan helper fungsi hasil transpile yang belum terpasang; keduanya diperbaiki. Pengukuran outline kedua kini memfokuskan tombol yang benar sebelum membaca style. Kegagalan skrip tersebut tidak dihitung sebagai hasil aplikasi lulus.

## Batas pemeriksaan

Audit kontras otomatis hanya mencakup teks DOM, batas kontrol/selected, dan outline fokus. Piksel label/garis pada canvas tidak diukur otomatis. Inspeksi screenshot menemukan label graph pada fit keseluruhan mobile kecil; pengguna dapat memakai zoom dan daftar node berlabel untuk membaca konteks. Pemeriksaan ini tidak menyatakan graph besar, semua pembaca layar, semua browser, kesesuaian pixel Figma, atau seluruh UI produk sudah lolos.

Fixture UI SHA-256: `254791c679ac1f0899b9fef6b1765c4d3f87a1224f95487f60937a70ce6d4f1b`. Fixture graph SHA-256: `2f4e83c21466820c630e0eb2911db65793bad7a261eea349085d1389f077cb04`. Ini hash modul fixture; hash setiap source virtual dan full snapshot SHA juga tercantum pada report tambahan.

## Eksekusi aktual 19 Oktober 2026

Production build workspace: PASS. `npm run test:ui`: PASS, 51 pemeriksaan dan 105 skenario kontras. `npm run test:graph`: PASS, 31 pemeriksaan. `npm run test:ui:baseline`: PASS, 30 pemeriksaan tambahan, nol failure. Ketiganya dijalankan ulang setelah perbaikan stylesheet, pada lima viewport; tidak ada error browser atau request API/GitHub.

Rasio aktual sesudah perbaikan: batas kontrol 3,46:1, batas node terpilih 5,70:1, outline fokus 6,26:1. Teks DOM terendah 4,47:1 terdapat pada teks besar yang memakai ambang 3:1; teks biasa diperiksa dengan ambang 4,5:1. Kedua font Inter dan JetBrains Mono termuat. SHA-256 stylesheet yang diperiksa: `3941cc797649e093f7f13c08b628211564c8bd262a0048b3ea1330579d65c71b`.

Runtime aktual: Node.js 24.22.0, Linux arm64, Chromium 156.0.8078.4, Next.js 16.4.2. Report aman lokal: `ui/browser-report.json`, `graph/browser-report.json`, dan `baseline-addon-report.json` di `artifacts/qa-03-s1/`; screenshot tersedia pada direktori yang sama. Screenshot login 360, progres gagal 1440, graph 360, dan graph terpilih 1440 diperiksa secara visual otomatis. Uji tidak menjalankan GitHub atau pipeline repository dan tidak memakai database produk. Image produksi tidak dibangun ulang; server QA sementara menjalankan production build workspace.

`npm run check`: PASS, lint/typecheck, 47 tes utama dan 8 tes database. Review kode terpisah dan pemeriksaan report tidak menemukan masalah material tersisa; reviewer memeriksa bukti eksekusi tersebut dan tidak mengklaim menjalankan ulang browser suite sendiri.
