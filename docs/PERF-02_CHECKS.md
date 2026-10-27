# PERF-02 — Resource core analisis dan ekspor

Issue [#98](https://github.com/AgilePemdigi-2026/sage/issues/98), pelaksana Iltizam; mendukung #27/#26 tanpa menutup acceptance induk. Base `ee121c16d13b92c02e6fb0b46653819c0ede6796`.

## Tujuan dan cakupan

Benchmark core memakai adapter package langsung, kemudian memproses source terverifikasi menjadi canonical CKG/ADD, Markdown dan PDF melalui renderer Chromium nyata. Ia tidak menghubungkan database atau GitHub, tidak menjalankan source target, dan bukan benchmark sembilan stage/queue/API produk. Sebagian stage produksi mengulangi pembacaan source dan validasi/proyeksi; biaya itu serta scan/merge `analyzeSnapshotSources` tidak tercakup di sini.

Corpus kecil memakai fixture lokal; corpus menengah merupakan subset dipin dari repository publik SAGE/PHP-Parser. SHA source dan manifest diverifikasi sebelum analisis. Istilah kecil/menengah berlaku pada corpus terpilih, bukan kapasitas seluruh repository atau jaminan persentase kelengkapan analisis. Reference corpus penuh tersedia sebagai probe batas terpisah.

## Reproduksi

Gunakan image worker dari source yang sesuai, Node 24 dan Docker. Source publik hanya diunduh pada persiapan; pengukuran sendiri offline.

```sh
npm run benchmark:prepare
npm run benchmark:resources -- --output artifacts/resources/run-unique.json
```

Setiap iterasi memakai container baru: 1 CPU, 2 GiB memori tanpa swap, root filesystem/source read-only, tmpfs terbatas dan deadline eksternal. Tool hanya menghapus container milik run; tidak memasang volume database/storage produk. Output baru diperlukan agar bukti sebelumnya tidak tertimpa.

Waktu fase mencakup operasi core sesuai nama fase, sementara container wall mencakup start/runtime. Peak charged memory cgroup mencakup Node, PHP/Chromium, page cache dan kernel charge; bukan RSS satu proses. Peak RSS Node dicatat terpisah. CPU cgroup mencakup subprocess, dengan quota yang tercatat. Peak memori dan CPU dilaporkan untuk workload keseluruhan, bukan tambahan penggunaan masing-masing fase. Cache filesystem VM/host tidak dikosongkan.

## Batas yang sudah ada

PDF membatasi proyeksi diagram maksimum 500 node atau 500 relasi, Mermaid 50 KB, SVG 4 MiB, HTML/dokumen 12 MiB, file PDF 32 MiB dan deadline renderer 45 detik. Analisis dapat menghasilkan canonical yang valid tetapi PDF ditolak oleh batas ekspor. Benchmark tidak memotong canonical atau menaikkan guard untuk memaksa pass. Penolakan, timeout, OOM dan metrik yang tidak tersedia harus terlihat pada laporan.

Batas snapshot 2.000 file/100 MiB extracted dan 300 detik analisis adalah ceiling kebijakan; belum membuktikan seluruh repository sebesar itu dapat dianalisis atau diekspor pada kuota deployment.

## Hasil aktual

Run final `perf02-local-run3.json` mengukur source benchmark `df6ac37` pada image worker ARM64 yang dipin ID, 1 CPU/2 GiB, empat corpus × tiga iterasi. [Bukti agregat dan sampel](evidence/perf02-resource-benchmark-2026-10-28.json) memuat hash laporan mentah, image ID, source fingerprint, batas, CPU dan hasil tiap sampel. Laporan mentah serta dua percobaan awal yang gagal tetap tersimpan lokal di artifacts/resources/; tidak ditimpa.

| Corpus | Source | Core termasuk percobaan PDF | Peak charged memory | PDF |
| --- | --- | --- | --- | --- |

| small-ts | 1 file / 23 byte | 2.466–6.22 detik | 478.29–654.86 MiB | 3/3 berhasil |
| small-php | 2 file / 448 byte | 1.906–2.437 detik | 429.97–462.21 MiB | 3/3 berhasil |
| medium-ts | 12 file / 53,099 byte | 0.764–0.985 detik | 314.32–321.48 MiB | 3/3 ditolak batas diagram |
| medium-php | 24 file / 43,704 byte | 0.781–1.004 detik | 277.39–280.2 MiB | 3/3 ditolak batas diagram |

**Hasil workload keseluruhan FAILED untuk kedua corpus menengah**, bukan pass ekspor. Canonical CKG/ADD serta Markdown selesai dan hash-nya identik pada seluruh tiga iterasi tiap corpus; PDF kecil berhasil 6/6, PDF menengah ditolak 6/6 dengan `PDF_DIAGRAM_SOURCE_LIMIT_EXCEEDED`. TS menghasilkan 799 node/982 edge; PHP 352 node/448 edge tetap dapat melewati batas Mermaid 50KB. Tidak ada OOM. PDF kecil tidak memakai hash/ukuran sebagai equality replay lintas proses; renderer memeriksa signature dan ukuran output.

Catatan replay otomatis seluruh workload berstatus INCOMPLETE untuk medium karena PDF gagal; equality canonical/Markdown pada medium dihitung terpisah dari metrik yang tersimpan. Waktu medium lebih pendek karena renderer berhenti pada guard sebelum Chromium, sehingga tidak boleh dibandingkan sebagai ekspor yang lebih cepat. CPU delta mulai setelah module imports; memory peak dan Docker wall mencakup startup. Host/VM cache hangat dan container aplikasi/pengujian lain masih ada saat run; angka waktu merupakan observasi lokal dengan quota, bukan benchmark latensi server yang terkendali.

Validasi Node 24 terisolasi: lint, typecheck dan **361 unit test pass, 0 fail/skip**, termasuk 6 test benchmark. Review menemukan masking domain error pada exit Docker nonzero dan kemungkinan container tertinggal setelah create timeout; keduanya diperbaiki dengan regresi. Percobaan awal juga menemukan mount temporary macOS yang tidak diekspor Colima; mount tak diperlukan itu dihapus, tanpa mengubah model produk. Tidak ada data produk atau secret dipakai.

## Keputusan untuk persiapan deployment

Pertahankan ceiling runtime awal web 768 MiB/0,75 CPU, worker 2 GiB/1,5 CPU dan database 1 GiB/0,5 CPU. Ini baseline persiapan, bukan kapasitas universal atau reservasi server. Peak core terbesar sekitar 655 MiB belum mencakup seluruh pipeline database, pembacaan ulang/proyeksi per stage, concurrent analysis/export atau beban kelompok lain. Tidak ada dasar untuk menurunkan cap berdasarkan sampel ini saja.

Batas PDF medium dicatat sebagai [EXP-03 #101](https://github.com/AgilePemdigi-2026/sage/issues/101), penanggung jawab Rizqy. Perluasan PDF ringkas memerlukan proyeksi manusia dan guard resource tetap, bukan membuang canonical atau menaikkan batas tanpa pengukuran. Acceptance PDF medium/release tetap terbuka. Belum ada deployment Coolify, benchmark x86_64 server bersama, quota operator atau backup off-server yang diverifikasi.
