# Troubleshooting

| Kondisi | Pemeriksaan dan tindakan |
| --- | --- |
| Localhost tidak terbuka | Pastikan Docker/Colima aktif; jalankan `docker compose ps`, lalu `docker compose start` untuk container yang sudah ada atau quick start pada setup lokal |
| Port 3000 dipakai | Periksa proses pemakai port sebelum mengubah `WEB_PORT`; sesuaikan origin dan callback GitHub App bila port berubah |
| Login belum tersedia / callback gagal | Periksa konfigurasi App privat, `AUTH_BASE_URL`, serta callback yang persis cocok; jangan menyalin secret ke issue atau log |
| Repository private tidak terlihat | Periksa akun aktif, instalasi App, Contents read, dan hak akun pada repository; daftar public berbeda dari daftar instalasi |
| Analisis lama masih memakai hasil lama | Snapshot dan versi extractor dibekukan; buat analisis baru untuk memakai extractor baru |
| No supported user flow detected | Periksa pola Next.js App Router/Laravel dan batas extractor; buka Code Knowledge. Analisis ulang tidak menjamin framework lain didukung |
| Banyak `Unresolved` | Periksa evidence dan batas resolver; source dinamis/ambigu tidak boleh dipaksakan sebagai hubungan terbukti |
| Ekspor gagal | Baca pesan job, periksa worker, storage, dan batas ukuran; retry setelah penyebab diperbaiki |
| Disk Docker penuh | Periksa image/cache yang tidak digunakan; jangan hapus volume database/storage untuk membersihkan cache |
| Konflik koreksi label | Muat revisi terbaru, lalu ulangi perubahan; revisi lama ditolak agar perubahan akun sendiri tidak tertimpa |

Periksa layanan lokal dengan `docker compose ps` dan `docker compose logs --tail 100 web worker`. Log dapat memuat informasi operasional; sanitasi sebelum dibagikan. Health tersedia di `/api/health`; HTTP 200 dan database `ok` tidak membuktikan OAuth, analisis, atau ekspor end-to-end.

Untuk error domain/routing server, gunakan [runbook operasi](../operations/COOLIFY.md). Untuk startup lengkap, gunakan [setup lokal](LOCAL_SETUP.md).
