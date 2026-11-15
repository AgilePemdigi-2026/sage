# Definition of Done

Status: kriteria penerimaan; belum menjadi laporan hasil pengujian. Gunakan bersama acceptance criteria issue, [traceability](REQUIREMENTS_TRACEABILITY.md), dan [test plan](TEST_PLAN.md).

## Done untuk satu paket

- Scope dan requirement terkait jelas; kontrak yang berubah diperbarui sebelum integrasi.
- File perubahan dan dependensi sesuai paket; diff dapat ditinjau tanpa menimpa pekerjaan lain.
- Acceptance criteria dijalankan dengan langkah dan hasil aktual yang dicatat.
- Pengujian yang relevan lulus; command yang tidak tersedia atau belum dijalankan tidak ditulis sebagai pass.
- Happy path dan error yang termasuk scope berfungsi, dengan pesan UI yang dapat ditindaklanjuti.
- Pemilik/verifier memeriksa hasil dan melampirkan bukti pada issue/PR.
- Commit memakai Conventional Commit satu baris/satu kalimat dan identitas pengirim yang benar.
- PR direview dan terintegrasi; issue baru ditutup setelah deliverable terkait benar-benar tersedia.
- Dokumentasi, fixture, dan expected output tetap sinkron; keterbatasan yang tersisa dinyatakan jelas.

Paket dokumentasi dapat Done berdasarkan pemeriksaan dokumen/commit tanpa mengklaim runtime aplikasi telah lulus. Paket implementasi tidak dapat Done hanya berdasarkan desain, typecheck, mock, compile, screenshot UI, atau toast keberhasilan.

## Done untuk analyzer

- PHP dan JavaScript/TypeScript masing-masing melewati source -> CCM -> CKG pada fixture yang direview.
- Capability matrix menyatakan kemampuan yang teruji dan keterbatasan per konstruksi.
- Tidak ada source target yang dieksekusi, install script yang dijalankan, atau plugin project target yang dimuat.
- Node, relasi, kind, resolution, dan evidence sesuai oracle; Unicode/CRLF/bounds diuji.
- Dynamic atau ambiguous target yang belum terbukti tetap unresolved; tidak ada inferred relation pada MVP.
- ID dan canonical content deterministik untuk snapshot/config yang sama; provenance cukup untuk replay.
- Containment/reference terpisah dan referensi berbeda tidak hilang akibat deduplikasi yang terlalu agresif.
- Bahasa/file yang dikecualikan dan parse error dicatat; failure total dibedakan dari hasil dengan keterbatasan.

## Done untuk pipeline dan data

- Full SHA dibekukan sebelum antrean; source preview dan hasil tidak mengikuti HEAD terbaru.
- Dua submission dan dua worker percobaan tidak melanggar satu analysis slot global.
- Sembilan tahap berurutan, progress terbaca, failure menghentikan tahap berikutnya, dan result bundle dipublikasikan atomik.
- Worker restart/interruption tidak mengubah pekerjaan gagal menjadi Completed; retry membuat record baru dengan SHA yang sama.
- Hasil, snapshot, dan export bertahan setelah restart Docker; akses antar-user ditolak.
- Hapus data menghapus seluruh objek turunannya, dengan status pending/failed yang jujur selama cleanup belum selesai.
- Secret tidak muncul pada diff, browser, error, log, screenshot bukti, atau export.

## Done untuk graph dan dokumen

- Query, kategori AST, focus/overview/references, incoming/outgoing, inspector, evidence, dan source preview berfungsi pada hasil nyata.
- Canonical counts tidak tercampur dengan counts subset tampilan; context repository/branch/SHA konsisten.
- Interface Catalog, Software Engineering Diagram, dan UML Class Diagram berasal dari graph yang sama dan dapat ditelusuri.
- Artefak tidak menambah HTTP endpoint, composition, cardinality, atau dependency yang tidak didukung source.
- Relasi unresolved beserta batas cakupan tetap terlihat pada hasil yang relevan.

## Done untuk ekspor

- File `.md` dan `.pdf` benar-benar dibuat, diunduh, dapat dibuka, dan memiliki content hash.
- Kedua format memuat tiga artefak, context target, versi/provenance, evidence, dan limitations yang sesuai document model.
- Diagram pada PDF terender dan terbaca; Markdown menyediakan representasi diagram yang mandiri.
- Tidak ada path lokal yang rusak, placeholder palsu, halaman terpotong, atau source private di luar izin.
- Generating/ready/error/retry teruji; kegagalan export tidak menghapus atau mengubah graph/dokumen sumber.
- Download dan penghapusan tetap memeriksa pemilik meskipun ID/URL diketahui.

## Done untuk UI

- UI berbahasa Indonesia dan konsisten dengan terminologi yang disepakati.
- State loading, empty, permission denied, unavailable, failed, retry, serta completed with limitations tersedia sesuai halaman.
- Viewport 360, 390, 768, 1024, dan 1440 px diperiksa; informasi teknis tetap terbaca.
- Keyboard, focus, label kontrol, serta pembeda bentuk/teks selain warna diperiksa.
- Screenshot/bukti menggambarkan hasil nyata, dengan identitas/source sensitif disamarkan bila diperlukan.

## Gate MVP freeze lokal

Seluruh requirement wajib pada traceability telah terverifikasi; sumber uji dan expected output tersedia; integration run bersih Docker, login GitHub nyata, public pihak lain, private berizin, analisis kedua bahasa, history, error, deletion, serta dua format ekspor lulus.

Tidak ada issue yang menghalangi alur inti atau akses data dengan benar. Keterbatasan analyzer yang memang diizinkan didokumentasikan, bukan dianggap mendukung konstruksi tersebut. Panduan setup/demo menggunakan command yang benar-benar telah dijalankan dan data contoh yang dapat direplay.

Target freeze adalah Sprint 2. Baseline planning ini tidak memenuhi gate tersebut dan tidak mencatat hasil runtime sebagai selesai.
