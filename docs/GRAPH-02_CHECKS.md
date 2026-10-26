# Verifikasi query dan filter graph GRAPH-02

Issue [#18](https://github.com/AgilePemdigi-2026/sage/issues/18), requirement SAGE-FR-GRAPH-03/04/05 dan T-GRAPH-02. Base `0a2f76769d0e46da48da5c2ce37f703c4ed633e3`. Pengiriman: Valentina (`liliks13`); review/merge: Iltizam (`iltizamhasan3`).

## Perilaku

Halaman hasil `/analyses/{analysisId}/graph` menyaring proyeksi lengkap dari canonical CKG yang telah diotorisasi. Query merupakan substring literal tanpa membedakan huruf besar/kecil pada nama, kind, qualified name, atau path berkas. Beberapa kategori terpilih digabung OR; query dan pilihan kategori digabung AND. Tanpa kategori terpilih berarti semua kind. Selanjutnya mode Ikhtisar/Fokus/Semua referensi diterapkan sebelum batas render 200 node/500 edge. Edge hanya ditampilkan jika kedua endpoint masuk subset. Node di luar budget awal tetap bisa ditemukan dengan filter.

Kategori diambil dari kind canonical yang benar-benar tersedia, bukan klasifikasi nama atau teks source. Kontrol **Atur ulang filter** menghapus query/kategori dan mempertahankan mode yang sedang dipilih. Hasil kosong tetap menyediakan kontrol filter; canonical counts, hash CKG/configuration, repository/branch/full SHA dan payload asal tidak diubah oleh filter. Filter tidak menulis database atau mengirim query ke provider. API graph tetap menolak seluruh query parameter dan mengirim proyeksi lengkap setelah validasi pemilik serta integritas archive.

## Verifikasi

Status **PASS**, konten implementasi dan tes pada `331e1909b196173d14cd8ef0f7c691b3b516b721`. Lint serta typecheck root/web, 297 tes utama dan 8 tes data, serta build Next production lulus. Lima tes filter terbaru dijalankan ulang di image yang sama; perubahan terakhir pada script browser dan tes dipasang read-only, tanpa mengganti source aplikasi yang dibangun.

Playwright menyelesaikan **18 kelompok pemeriksaan**, nol error browser dan nol request provider, pada 360/390/768/1024/1440 px. Interaksi filter di 390 px memeriksa query melalui keyboard, irisan query dengan Class, pilihan node fokus, hitungan tepat, hasil kosong, reset melalui Enter, payload API yang tetap sama, dan tidak adanya request graph tambahan. Regresi mode/layout, auth/ownership, hash/archive, retry 503, respons terlambat, preview, dan graph canonical kosong tetap lulus. Unit menguji multi-kind OR, query literal, kombinasi AND, edge endpoint, fokus di subset, reset, immutability, serta pencarian node di luar budget awal dan batas 200/500.

Run pertama gagal dengan error React 185 dan karakter input hilang pada pencarian panjang tanpa hasil. Canvas kini mempertahankan region aksesibel tanpa membuat Cytoscape saat node kosong; zoom 100% dan kontrol nonaktif diuji, lalu aktif kembali setelah reset. Urutan input panjang yang sama lulus pada run kedua. Screenshot filter dan hasil kosong 390 px ditinjau secara visual: kontrol, focus ring, status serta hitungan terbaca tanpa overflow.

Laporan lokal dan screenshot: `artifacts/graph-18/2026-10-26-run2/`. Fingerprint serta ringkasan aman: [evidence GRAPH-02](evidence/GRAPH-02-2026-10-26.json). Node 24.22.0, Next 16.4.2, PostgreSQL 17.11. Source aplikasi dibangun ulang di image dependency yang telah tersedia; runner 1 CPU/2 GiB, DB 0,5 CPU/256 MiB, jaringan internal tanpa port host. Container/network milik run telah dihapus.

```sh
npm run check
npm run build
SAGE_GRAPH_TESTS=1 npm run test:graph:live
git diff --check
```

Command live memerlukan server production aktif serta database disposable bernama `sage_graph17`, STORAGE_ROOT sementara privat 0700 yang sama, AUTH_BASE_URL/SAGE_GRAPH_BASE_URL loopback yang sama, dan key enkripsi test-only yang sama untuk server dan runner. Migrasikan database uji terlebih dahulu. Jangan menjalankannya terhadap database atau storage pengguna. Pengujian aktual menyiapkan layanan tersebut di container terisolasi; bukan memakai aplikasi lokal pengguna.

## Batas bukti

Browser menggunakan server Next production dan PostgreSQL sementara `sage_graph17`, dengan fixture TypeScript dari adapter nyata yang disimpan langsung sebagai canonical bundle dan source archive. Ini memeriksa pembacaan hasil tersimpan, filter serta isolasi akun; bukan login OAuth GitHub nyata atau eksekusi baru pipeline sembilan tahap. Kasus 503 dan respons tertunda dikendalikan secara eksplisit untuk memeriksa retry/race. Inspector/source evidence tetap mengikuti GRAPH-03 #19; ekspor mengikuti #20/#21.
