# Design guidelines

Status per 20 Oktober 2026: acuan visual diambil dari enam screen Figma yang diperiksa melalui MCP. Frontend UI-02 #59 dan UI-03 #60 sudah diperiksa pada lima viewport; hasil dan batas fidelity/fixture dicatat di [UI-02/UI-03 checks](UI-02_CHECKS.md).

## Sumber dan status

Gunakan [Data Mockup SAGE](https://www.figma.com/design/OrNk1caXIrsdC0tG4axfSA/Data-Mockup-SAGE), dengan halaman Foundations, Components, SAGE Patterns, dan Screens. Enam screen yang menjadi baseline MCP adalah node `47:4`, `57:102`, `65:875`, `79:1222`, `117:2116`, dan `119:7425`. Foundations design system v0.1 tetap menjadi acuan token. Aset hasil ekstraksi Figma disimpan pada `apps/web/public/design/figma/`.

Tema terang, Inter/JetBrains Mono, palet brand, dan layout desktop menjadi acuan. Palet kategori AST masih provisional. Wordmark yang tersedia adalah draft, bukan logo final; gunakan aset yang ada dan jangan membuat logo pengganti. Jangan memperlakukan screenshot PDF atau inventaris layer sebagai bukti bahwa seluruh component binding/prototype telah diuji.

## Warna dan bentuk

| Peran | Acuan awal |
| --- | --- |
| Brand utama | Teal; primary memakai latar teal dengan teks navy |
| Ink/text utama | Navy `#061E42` |
| Primary teal | `#2AC6AE` |
| Success | Hijau dengan label teks |
| Warning/unresolved | Warna warning dengan label teks dan garis putus-putus |
| Error | Merah dengan pesan yang menjelaskan aksi berikutnya |
| Surface | Putih/light gray; border dipakai sebelum shadow |

Primary action tidak menggunakan teks putih di teal terang. Satu area memiliki satu primary action yang jelas. Hindari gradient dan efek dekoratif yang mengurangi keterbacaan informasi teknis.

Nilai warna AST belum dikunci. Node harus memiliki bentuk/label yang membedakan kategori sehingga pembacaan tidak bergantung pada warna saja. Nilai CSS final dan contrast check ditutup pada QA-03, bukan dinyatakan lulus dari dokumen ini.

## Tipografi dan layout

| Token | Acuan |
| --- | --- |
| Display | Inter 40/48 |
| H1 | Inter 28/36 |
| H2 | Inter 20/28 |
| H3 | Inter 16/24 |
| Body | Inter 14/22 |
| Caption/label | Inter 12/16 |
| Code | JetBrains Mono 13/20 |
| Code small | JetBrains Mono 12/16 |

Path, SHA, source code, dan nomor baris memakai monospace. Font teknis tidak diperkecil agar seluruh graph dipaksakan muat pada overview.

Layout desktop Figma: lebar 1440 px, 12 kolom, margin 32 px, gutter 24 px. Lebar baca dokumen 760 px. Spacing dasar: 4, 8, 12, 16, 24, 32, 48, 64 px. Radius acuan: 4, 6, 8 px dan pill 999 px.

Rancangan responsif awal memakai mobile sebagai default, layout menengah mulai sekitar 768 px, dan layout desktop mulai sekitar 1024 px; angka breakpoint ini adalah usulan implementasi, bukan ukuran frame Figma yang telah disepakati. Uji setidaknya viewport 360, 390, 768, 1024, dan 1440 px.

## Pola mobile dan desktop

- Mobile: navigasi ringkas, target analisis tersusun vertikal, tabel menjadi daftar/card yang mempertahankan konteks repository/branch/SHA/status.
- Desktop: panel target, progress, graph, dan inspector dapat berdampingan sesuai ruang.
- Graph mempertahankan pan/zoom, focus, fit view, dan pencarian; inspector mobile dibuka sebagai panel/drawer yang bisa ditutup dan diakses keyboard.
- Daftar relasi/evidence memberi cara membaca hasil ketika canvas terlalu padat atau ruang kecil.
- Source code memakai horizontal scrolling terkontrol, line numbers, dan highlight bounds; halaman utama tidak ikut overflow horizontal.
- Header context dapat membungkus baris, sementara SHA lengkap tetap dapat dibaca/disalin.

## Bahasa antarmuka

UI utama berbahasa Indonesia. Nama produk, identifier kode, path, signature, SHA, dan istilah teknis yang memang diperlukan tetap dipertahankan.

| Istilah rancangan awal | Label UI |
| --- | --- |
| Connect with GitHub | Hubungkan GitHub |
| Repository Selection | Pilih Repository |
| Start analysis | Mulai Analisis |
| Analysis Progress | Progres Analisis |
| Analysis History | Riwayat Analisis |
| View results | Lihat Hasil Analisis |
| View document | Lihat Dokumen |
| Source preview | Pratinjau Source |
| Exact | Exact, dengan penjelasan relasi terselesaikan |
| Unresolved | Unresolved, dengan penjelasan belum terselesaikan |
| Pending / Queued | Menunggu / Dalam antrean |
| Running / Completed / Failed | Diproses / Selesai / Gagal |
| Completed with limitations | Selesai dengan keterbatasan |
| Export PDF / Markdown | Ekspor PDF / Markdown |

Label API tetap memakai enum pada kontrak. Pesan error menjelaskan kondisi yang diketahui; penyebab teknis yang belum terbukti tidak ditambahkan sebagai dugaan.

## Halaman dan state wajib

| Halaman | State/interaksi |
| --- | --- |
| Landing | Pengantar, login, koneksi gagal, izin ditolak, aksi coba lagi |
| Repository | Authorized list, input repository publik, search, loading, empty, error list/branch, branch selector, commit invalid, fallback latest |
| Progress | Context, queued, sembilan stage, running, failed/retry, completed, limitation, akses hasil sesuai status |
| History | Loading, daftar, empty, pencarian cocok/tidak cocok, load failed, navigasi berbasis status, penghapusan |
| Graph | Focus, overview, references, query/filter AND, selection, inspector, source preview, unavailable/loading/error |
| Dokumen | Tiga section, navigasi kembali, source evidence, loading/unavailable/error, export kedua format |
| Export | Queued/generating, ready/download, failed/retry; format lain nonaktif pada toolbar selama permintaan aktif |

Semua state produk menjaga analysis ID, repository, branch, dan commit. Rute `/preview/*` menggunakan fixture bersama yang tervalidasi dan tidak mewakili record atau hasil repository pengguna. Memindah halaman produk tidak mengganti record analisis secara diam-diam.

## Graph dan evidence

Kategori inti: Module, Class, Interface, Function, Method, Property, dan Unresolved reference. Controller/Service/Repository adalah nama/peran, bukan kategori AST. Kategori baru dari capability spike harus memiliki label/filter dan fixture yang konsisten.

Exact memakai garis solid navy; unresolved memakai garis putus-putus warning dan label eksplisit. Incoming/outgoing dipisahkan di inspector. Relasi berbeda yang menuju placeholder sama mempertahankan evidence masing-masing.

Query kosong/reset tidak menghapus hasil. Overview dapat menyederhanakan label sesuai zoom, tetapi jumlah canonical graph tetap tersedia. Mode Focus membantu membaca relasi langsung tanpa memaksa semua edge terlihat sekaligus.

## Aksesibilitas dan bukti

Semua control memiliki label, fokus terlihat, dan dapat digunakan keyboard. Informasi status tidak bergantung pada warna. Setelah modal/drawer ditutup, fokus kembali ke pemicu. Tombol disabled menjelaskan keadaan yang membuatnya belum tersedia.

QA-03 harus melampirkan screenshot pada viewport target, catatan keyboard/focus, serta hasil pemeriksaan kontras. UI-02/UI-03 memuat bukti pemeriksaan layar fixture, keyboard/focus, screenshot, serta pasangan kontras utama. Acceptance aksesibilitas produk lengkap tetap QA-03; tidak ada klaim sertifikasi atau kesamaan pixel seluruh frame.
