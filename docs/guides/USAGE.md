# Menggunakan SAGE

Buka [SAGE](https://sage.caiis.ai.id/) atau aplikasi lokal. Login diperlukan agar analisis dan history terikat pada akun sendiri. Repository private memerlukan hak akun dan izin Contents read pada GitHub App; login saja tidak memberikan akses ke semua repository.

## Pilih target

1. Login dengan GitHub, lalu buka pemilihan repository.
2. Pilih repository public milik sendiri, repository dari instalasi yang diizinkan, atau masukkan URL public pihak lain.
3. Pilih branch dan, jika diperlukan, commit. Setelah memilih repository, lanjutkan ke target analisis.
4. Periksa target sebelum mulai. SAGE membekukan full commit SHA; perubahan branch berikutnya tidak mengubah snapshot hasil.

## Jalankan analisis

Mulai analisis dan ikuti progress tahap serta elapsed time. Worker memproses analisis satu per satu. Status antre bukan error. Jika gagal, baca pesan stage dan limitation; retry memakai snapshot serta konfigurasi yang sama setelah akses diperiksa kembali. Untuk memakai perbaikan extractor terbaru, buat analisis baru.

## Baca hasil

Setelah analisis berhasil, **Architecture Definition Document (ADD) adalah hasil utama**. Buka halaman ADD untuk melihat atau membuat baseline. Code Knowledge tersedia sebagai tampilan tambahan dari snapshot yang sama dan tidak perlu dibuka terlebih dahulu.

| Tampilan | Tujuan |
| --- | --- |
| TOGAF ADD | Baseline Data Architecture dan Application Architecture, catalog, matrix, ArchiMate views, limitation, serta evidence |
| Code Knowledge | Graph source untuk menelusuri node, relasi, filter, focus, inspector, dan source evidence |

ADD memuat baseline saja. Target architecture, gap/RAG, business capability, owner, dan deployment memerlukan input manusia. Software Engineering Diagram dan UML Class Diagram lama bukan keluaran aktif.

Klik evidence untuk membuka file GitHub pada commit dan rentang baris yang terkait. Akses private tetap mengikuti izin GitHub. Perbedaan confidence Proven/Indicated dan resolver Exact/Unresolved dijelaskan pada [reference ADD](../reference/TOGAF_ADD.md).

Pada workspace ADD, gunakan **Generate Phase C baseline** jika dokumen belum dibuat. Nama, group, dan status review yang dapat dikoreksi disimpan sebagai overlay; source facts dan relasi tidak berubah. Jika revision conflict muncul, muat ulang untuk membaca versi terbaru sebelum menyimpan kembali.

## Ekspor dan history

Markdown dan LaTeX dibuat dari model ADD dan review revision yang sama. Markdown merangkum catalog, functional decomposition, matrix, relasi, limitation, dan evidence secara ringkas. Download LaTeX menghasilkan file source untuk dikompilasi. Gunakan **Print / Save as PDF** untuk PDF A4 dari browser dan periksa pagination diagram sebelum membagikannya.

History menyediakan pencarian dan navigasi hasil milik akun aktif. Hasil disimpan sampai pemilik menghapusnya. Penghapusan analisis terminal meminta konfirmasi dan membersihkan snapshot serta ekspor; cleanup yang gagal dapat dicoba kembali. Analisis atau ekspor aktif tidak dapat dihapus.

[Troubleshooting](TROUBLESHOOTING.md) · [Batas analyzer](../reference/ANALYSIS_SPEC.md) · [Beranda dokumentasi](../README.md)
