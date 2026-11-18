# Menggunakan SAGE

Buka [SAGE](https://sage.caiis.ai.id/) atau aplikasi lokal. Login diperlukan agar analisis dan history terikat pada akun sendiri. Repository private memerlukan hak akun dan izin Contents read pada GitHub App; login saja tidak memberikan izin semua repository.

## Pilih target

1. Login dengan GitHub, lalu buka pemilihan repository.
2. Pilih repository public sendiri, repository dari instalasi yang diizinkan, atau masukkan URL public pihak lain.
3. Pilih branch dan, jika diperlukan, commit. Setelah repository dipilih, halaman mengarahkan fokus ke target analisis.
4. Periksa target sebelum mulai. SAGE membekukan full commit SHA; perubahan branch berikutnya tidak mengubah snapshot hasil tersebut.

## Jalankan analisis

Mulai analisis dan ikuti progres tahap serta elapsed time. Worker memproses analisis satu per satu. Jangan menyamakan status antre dengan error. Jika gagal, baca pesan error dan batasannya; retry memakai snapshot serta konfigurasi yang sama setelah akses diperiksa kembali. Untuk versi extractor terbaru, buat analisis baru.

## Baca hasil

Setelah analysis selesai, navigasi menampilkan Progres, Code Knowledge, dan TOGAF ADD. Keduanya berasal dari snapshot commit yang sama, tetapi menjawab kebutuhan yang berbeda.

| Tampilan | Tujuan |
| --- | --- |
| Code Knowledge | Visual pendamping untuk menelusuri module/symbol, dependency, filter, fokus tetangga, dan evidence source |
| TOGAF ADD | Keluaran utama: baseline Data Architecture dan Application Architecture, catalog, matrix, batasan, dan evidence |

Di halaman Code Knowledge, pilih **Generate ADD** untuk menyusun baseline pertama kali. Code Knowledge adalah view struktur source, bukan Software Engineering Diagram atau model arsitektur enterprise. ADD berisi baseline saja. Target architecture, gap/RAG, business capability, owner, dan deployment memerlukan input manusia.

Klik evidence untuk membuka file GitHub pada commit dan rentang baris terkait. Akses private tetap mengikuti izin GitHub. Perbedaan `Exact`/`Unresolved` dan `Proven`/`Indicated` dijelaskan pada [reference ADD](../reference/TOGAF_ADD.md).

Pada ADD, nama dan feature group elemen dapat dikoreksi. Simpan review untuk membuat revision baru; relasi dan evidence source tetap immutable. Jika ada revision conflict, refresh halaman untuk membaca versi terbaru sebelum menyimpan kembali. Code Knowledge tidak diganti oleh diagram ADD, dan diagram ADD tidak dimaksudkan sebagai daftar file.

## Ekspor dan history

Ekspor **Markdown** menyediakan narasi, catalog, functional decomposition, matrix, relasi, batasan, review state, dan evidence link pada commit. **Download LaTeX** menghasilkan `.tex` dari snapshot dan review yang sama; compile menggunakan panduan pada [reference ADD](../reference/TOGAF_ADD.md). Pilih **Print / Save as PDF** untuk mencetak baseline dan diagram SVG ke halaman A4 dari browser. Periksa pagination diagram besar sebelum membagikan PDF.

History menyediakan pencarian dan navigasi hasil milik akun aktif. Data disimpan hingga pemilik menghapusnya. Penghapusan analisis terminal memerlukan konfirmasi dan menghapus snapshot serta ekspor; cleanup yang gagal dapat dicoba kembali. Analisis/ekspor aktif tidak dapat dihapus.

[Troubleshooting](TROUBLESHOOTING.md) · [Batas analyzer](../reference/ANALYSIS_SPEC.md) · [Beranda dokumentasi](../README.md)
