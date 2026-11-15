# Setup GitHub App lokal

Dokumen ini menjelaskan pembuatan GitHub App pengembangan melalui manifest pada issue GH-01. Script menyiapkan konfigurasi dan menyimpan kredensial lokal setelah callback berhasil; script tidak membuat aplikasi sebelum pemilik akun menekan **Create GitHub App** di GitHub.

## Menjalankan bootstrap

Gunakan Node.js 24 dan pastikan port lokal `7010` tersedia. Nama app sebaiknya unik di GitHub dan tidak lebih dari 34 karakter. Contoh:

```sh
node scripts/setup-github-app.mjs --name SAGE-I2-iltizamhasan3
```

Tanpa `--name`, script membuat nama `SAGE-I2-<username-lokal>-<suffix-acak>`. Script mencetak nama yang disiapkan dan URL loopback. Buka URL itu di browser pada mesin yang sama, lalu pilih **Lanjutkan ke GitHub**. Tinjau konfigurasi dan klik **Create GitHub App** di GitHub untuk menyelesaikan pembuatan. Nama masih dapat diedit pada halaman GitHub.

Server sementara hanya mengikat `127.0.0.1:7010`. Redirect manifest kembali ke `http://127.0.0.1:7010/callback`, sedangkan OAuth aplikasi memakai callback `http://localhost:3000/auth/github/callback`. Pastikan aplikasi web lokal memakai port 3000 saat menguji login. State callback berlaku 10 menit, hanya dapat dipakai sekali, dan server lokal berhenti setelah callback selesai atau kedaluwarsa. Jika waktu habis, jalankan script lagi.

## Konfigurasi manifest

Manifest menyiapkan aplikasi publik dengan homepage repository SAGE dan meminta izin minimum berikut:

- **Contents: read** untuk membaca source repository.
- **Metadata: read** sebagai izin metadata GitHub yang wajib.
- Webhook tidak diaktifkan dan tidak ada URL webhook atau langganan event.
- Tidak meminta izin tulis atau izin email.

GitHub meminta nama aplikasi dan konfirmasi akhir melalui halaman milik akun pengguna. Pembuatan dan kepemilikan app mengikuti akun yang menekan tombol tersebut. Bootstrap hanya menukar kode manifest sementara setelah callback; pertukaran ini tidak memakai token GitHub CLI.

## Penyimpanan lokal

Setelah callback sukses, konfigurasi berikut ditambahkan atau diperbarui langsung di `.env`:

```text
GITHUB_APP_ID
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY_BASE64
GITHUB_APP_SLUG
GITHUB_APP_URL
AUTH_BASE_URL=http://localhost:3000
```

Private key disimpan sebagai Base64 agar aman dibaca sebagai satu nilai environment. File `.env` dibuat dengan izin `0600`; komentar, konfigurasi lain, dan rahasia yang sudah ada dipertahankan. Script menolak `.env` yang berupa symlink dan memeriksa bahwa `.env` diabaikan oleh `.gitignore` sebelum memulai alur. Jangan commit, menyalin ke log, atau membagikan `.env`.

## Batas hasil

Pembuatan app GitHub tetap memerlukan tindakan pemilik akun pada browser. Panduan dan pengujian lokal hanya memverifikasi form manifest, callback lokal, validasi state, serta penulisan konfigurasi sementara dalam direktori test. Tidak ada GitHub App yang dibuat atau dipasang sebagai bagian dari pemeriksaan tersebut. Instalasi app ke akun/repository dilakukan terpisah melalui halaman GitHub jika diperlukan.

Referensi resmi: [registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) dan [registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
