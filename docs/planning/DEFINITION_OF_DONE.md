# Definition of Done

Status: kriteria penerimaan, bukan laporan hasil pengujian. Gunakan bersama acceptance per issue dan [rencana sprint baru](RESET_SPRINT.md). Hasil baru dinyatakan selesai setelah langkah, environment, commit, expected/actual, dan bukti run dicatat.

## Done untuk satu issue

- Story dan batas penerimaan dapat ditinjau sebelum implementasi.
- Perubahan memenuhi alur produk saat ini: analisis repository menghasilkan TOGAF ADD sebagai output utama; Code Knowledge adalah pendamping.
- Acceptance yang relevan dijalankan pada lapisan yang sesuai: unit/contract, integrasi database/worker, browser, atau provider nyata.
- Fixture, mock, build, screenshot statis, dan hasil run lama diberi label; tidak menggantikan pemeriksaan yang memakai integrasi sesungguhnya.
- Happy path, empty/loading/error, izin, dan retry diuji saat berada dalam scope.
- Evidence menyebut versi aplikasi, repository dan pinned SHA (jika ada), lingkungan, hasil, artefak, serta batas uji.
- Secret, private source, token, dan data pengguna lain tidak muncul pada diff, log, export, atau screenshot.
- PR direview, dokumentasi dan fixture diperbarui, dan issue ditutup setelah acceptance benar-benar terpenuhi.
- Commit memakai Conventional Commit satu baris dan identitas author yang benar.

Paket dokumentasi dapat selesai berdasarkan pemeriksaan isi/tautan tanpa mengklaim runtime lulus. Paket fitur tidak selesai hanya dari rancangan, typecheck, mock, compile, atau toast keberhasilan.

## Done untuk analyzer dan ADD

- Analyzer memproses snapshot repository yang tidak dieksekusi; full commit SHA dan provenance tetap terikat pada hasil.
- Bahasa, framework, format, dan pola yang didukung dinyatakan sesuai implementasi serta fixture aktual.
- Data entity, component, interface, relation, CRUD, dan evidence hanya diterbitkan jika aturan source mendukung klaimnya.
- Nilai yang tidak diketahui tetap unknown/limitation; kode dinamis atau relasi tak pasti tidak ditulis sebagai fakta terbukti.
- ADD mencakup baseline Data Architecture dan Application Architecture dengan catalog, matrix, ArchiMate views, dan evidence yang relevan.
- ADD tidak mengarang target state, gap/RAG, business capability, process bisnis, owner, deployment, atau interaksi antar aplikasi tanpa bukti atau input manusia.
- Koreksi pengguna tetap pada overlay berversi; source facts dan relations tidak berubah; revision stale menghasilkan conflict.
- LLM hanya digunakan setelah consent eksplisit untuk narasi, tidak menambah fakta dan memiliki fallback deterministik.

## Done untuk pipeline, Code Knowledge, dan history

- Repository selection memeriksa akses dan target; submission mematok full SHA sebelum worker berjalan.
- Queue, progress, elapsed time, failure stage, retry, serta terminal status dapat dibaca dan tidak menyamarkan kegagalan sebagai sukses.
- Code Knowledge menunjukkan graph source dari snapshot yang sama dengan ADD, dengan search/filter/focus/inspector/evidence sesuai UI aktif.
- Graph tetap terpisah dari ADD dan tidak menghidupkan kembali Software Engineering Diagram atau UML sebagai keluaran utama.
- History hanya menampilkan hasil akun sendiri; detail, navigasi, dan penghapusan mengikuti owner checks.
- Hapus terminal membersihkan metadata dan file turunan secara idempotent; job aktif ditolak dan pengujian memakai data disposable.
- Secret tidak bocor ke UI, error, log, screenshot, history, ataupun export.

## Done untuk UI dan ekspor

- Frontend bekerja dengan API dan state aplikasi yang sebenarnya untuk acceptance utama.
- Mobile dan desktop, keyboard/focus, label kontrol, loading, empty, permission, failed/retry, dan completed-with-limitations ditinjau.
- Markdown, LaTeX, dan PDF berasal dari model ADD serta revision yang sama dan memuat limitation/evidence yang sesuai.
- PDF A4 dan tabel/diagram dibaca dengan pemeriksaan visual; Markdown ringkas, navigable, dan tidak menduplikasi payload source.
- LLM consent dan penolakan/fallback dapat dibedakan dengan jelas.

## Done untuk sprint baru

Semua story US-01 sampai US-09 pada [rencana sprint baru](RESET_SPRINT.md) mempunyai status pass/fail/blocked dan bukti. Defect prioritas tinggi diperbaiki dan dites ulang; issue sisanya memiliki dampak dan owner. Alur login → pilih target → analisis → ADD, Code Knowledge, history, dan export dapat didemonstrasikan pada local Docker environment.

Kriteria ini tidak menyetujui deployment Coolify. Deployment, resource, backup, dan domain memerlukan gate operasional serta keputusan terpisah.
