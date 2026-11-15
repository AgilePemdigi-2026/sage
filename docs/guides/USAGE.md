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

Navigasi hasil menghubungkan Progres, Code Knowledge, dan Dokumentasi secara langsung.

| Tampilan | Tujuan |
| --- | --- |
| Code Knowledge | Komponen kode dan dependency; mode essential, pencarian, filter, fokus tetangga, dan inspector |
| Interface Catalog | Ringkasan interface dan kontrak yang ditemukan, dengan pencarian serta pagination |
| Software Engineering Diagram | Overview aktor/fitur dan detail alur yang dikenali dari source |
| UML Class Diagram | Class utama dan hubungan yang ditemukan, bukan visualisasi setiap file |

Klik evidence untuk membuka file GitHub pada commit dan rentang baris terkait. Akses private tetap tunduk pada izin GitHub. Inspector/source memakai snapshot analisis. `Exact`/`Unresolved` menjelaskan resolution referensi kode; `Proven`/`Indicated` menjelaskan confidence hubungan semantik. Hubungan indikasi dapat disembunyikan. Ketidaktersediaan model alur tidak menghapus Code Knowledge.

Label serta kelompok konsep/komponen semantik dapat dikoreksi dan dikembalikan ke hasil otomatis. Koreksi tidak mengubah source atau menambah hubungan manual. Jika revisi konflik, muat hasil terbaru sebelum mencoba lagi. Lihat [kontrak semantik](../reference/SEMANTIC_ANALYSIS.md).

## Ekspor dan history

Ekspor Markdown atau PDF dari dokumentasi, tunggu job selesai, lalu unduh. Snapshot ekspor mem-pin model dan revisi koreksi ketika diminta. Markdown memuat detail teknis; PDF menyajikan ringkasan dan diagram vektor A4, dengan alur besar dibagi per halaman. Batas ukuran dapat menghasilkan error terkendali; file gagal bukan hasil ekspor berhasil.

History menyediakan pencarian dan navigasi hasil milik akun aktif. Data disimpan hingga pemilik menghapusnya. Penghapusan analisis terminal memerlukan konfirmasi dan menghapus snapshot serta ekspor; cleanup yang gagal dapat dicoba kembali. Analisis/ekspor aktif tidak dapat dihapus.

[Troubleshooting](TROUBLESHOOTING.md) · [Batas analyzer](../reference/ANALYSIS_SPEC.md) · [Beranda dokumentasi](../README.md)
