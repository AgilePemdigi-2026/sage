# Catatan rollout Coolify 10 November 2026

Arsip ini mempertahankan pengamatan dan batas verifikasi saat rollout; bukan status layanan terbaru. [Runbook aktif](../../operations/COOLIFY.md).

## Target rollout 10 November 2026

- Resource SAGE yang tersedia: `y4etaf74uwe8blj5b5ekmb6o`, project `PPL PRAK I2`, environment `production`.
- Domain yang diberikan: `https://sage.caiis.ai.id`; gunakan origin tersebut tanpa trailing slash pada `AUTH_BASE_URL`, dan `https://sage.caiis.ai.id/auth/github/callback` sebagai callback tambahan GitHub App.
- Sebelum perubahan, resource berstatus Exited, memakai `/compose.yaml`, dan belum mempunyai domain. Ganti ke `/compose.coolify.yaml` setelah image dan environment siap.
- Batas resource awal memakai ceiling di atas; belum merupakan persetujuan quota resmi dari dosen.
- Lokasi backup di luar server belum diberikan. Sebelum menyimpan data penting, operator perlu menyediakan tujuan backup dan menjalankan restore drill dengan pasangan database/storage yang konsisten.
- Status build/pull/TLS/OAuth aktual harus dicatat setelah dieksekusi; persiapan workflow tidak berarti deployment berhasil.

### Registry untuk rollout ini

Run [42661516138](https://github.com/AgilePemdigi-2026/sage/actions/runs/42661516138) telah membangun web/worker `linux/amd64`, memverifikasi pull berdasarkan digest dan source revision, serta meluluskan smoke Compose pada source `d7787ff8a27ce1462666039c08d6b4154f9c55ee`. Organisasi menonaktifkan package public; image organisasi belum dapat ditarik secara anonymous.

Atas persetujuan pemilik project, [iltizamhasan3/sage-release-images](https://github.com/iltizamhasan3/sage-release-images) menjadi repository build-only untuk registry pribadi. Workflow mengambil commit penuh dari repository utama, tanpa credential aplikasi, dan mempublikasikan `ghcr.io/iltizamhasan3/sage-web` serta `sage-worker`. Label revision selalu menunjuk commit source, bukan commit repository workflow. Workflow utama organisasi tetap dapat dipakai bila operator kemudian menyediakan autentikasi pull; jangan mencampur digest dari namespace/run lain.

Callback produksi sudah ditambahkan pada GitHub App dengan wildcard nonaktif; callback localhost dipertahankan. Coolify memakai `/compose.coolify.yaml`, origin `https://sage.caiis.ai.id`, dan routing web internal port 3000. Credential telah disimpan pemilik, lalu deployment berhasil; lihat verifikasi runtime di bawah.

Run registry pribadi [42663739278](https://github.com/iltizamhasan3/sage-release-images/actions/runs/42663739278) selesai sukses pada 10 November 2026: build/pull `linux/amd64`, pemeriksaan revision, Compose smoke, dan artifact manifest lulus. Kedua manifest image dapat dibaca secara anonymous; digest dan batas verifikasi dicatat pada [bukti kesiapan](../../evidence/deployment-readiness-2026-11-10.json). Runtime server diverifikasi terpisah di bawah; OAuth produksi masih tertahan routing domain.

Kedua digest registry pribadi juga telah dipull langsung pada host dosen melalui terminal Coolify; inspeksi image mengonfirmasi `amd64` dan source revision yang sama. Pemeriksaan ini tidak menjalankan aplikasi atau mengubah service kelompok lain. Tindak lanjut runtime, routing, dan backup aktual dicatat berikut.

## Rollout aktual 10 November 2026

Deployment `glulyqq81cisnukle3goepoh` berhasil dalam 29 detik pada Compose commit `56acd0d`; web, worker, dan database healthy, migrasi exit 0. HTTPS langsung pada origin, dengan validasi sertifikat aktif, mengembalikan HTTP 200 dan `{"status":"ok","service":"web","database":"ok"}`. Ini tidak membuktikan akses publik berhasil: melalui Cloudflare, endpoint mengarah kembali ke URL HTTPS yang sama dan browser melaporkan `ERR_TOO_MANY_REDIRECTS`.

Cloudflare dikelola dosen. Operator perlu memeriksa mode SSL/TLS, Origin Rules, Redirect Rules, atau Service URL jika memakai Tunnel untuk hostname `sage.caiis.ai.id`. Dugaan awal adalah forwarding HTTP ke origin yang mewajibkan HTTPS; mode dashboard belum diperiksa. Gunakan HTTPS ke origin dengan validasi sertifikat, misalnya Full (strict) khusus hostname bila tersedia. Hindari perubahan global pada zone yang dipakai kelompok lain. [Panduan resmi redirect loop Cloudflare](https://developers.cloudflare.com/ssl/troubleshooting/too-many-redirects/) menjelaskan diagnosis ini. Redirect HTTPS Coolify dan konfigurasi keamanan bersama tidak dilonggarkan. Setelah operator memperbaiki routing, ulangi health publik, OAuth Iltizam, submit analisis, dan ekspor Markdown/PDF.

Backup awal dibuat dengan writer web/worker dihentikan, `pg_dump -Fc`, dan archive storage dari volume aktual; writer kemudian dinyalakan dan health diperiksa kembali. Dump 70.329 byte telah diunduh ke folder privat laptop dan SHA-256 cocok dengan server. Archive storage tersedia di server tetapi unduhannya diblokir Brave (`ERR_BLOCKED_BY_CLIENT`); pembatasan browser tidak dilewati, sehingga pasangan backup lengkap di laptop belum tersedia.

`pg_restore --exit-on-error` berhasil ke database terpisah `sage_restorecheck_20261110`, tanpa menimpa database produksi. Kedua database memiliki 0 pengguna, 0 analisis, dan 13 migrasi. Database uji masih dipertahankan. Ini hanya validasi database awal: belum menguji restore aplikasi penuh, source/export berisi data, atau dekripsi credential pengguna. Lokasi, checksum, dan batas bukti tercatat pada JSON kesiapan; jangan memasukkan dump atau secret ke Git.
