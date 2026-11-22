# Privasi dan dependensi SAGE

| Integrasi | Penggunaan dan data |
| --- | --- |
| GitHub OAuth dan REST API | Autentikasi, metadata repositori, dan pengambilan snapshot yang pengguna pilih. |
| LLM kampus | Penulisan narasi dengan opt-in. Hanya menerima ringkasan fakta arsitektur yang dibatasi. |
| Next.js, React, Cytoscape dan Mermaid | Framework dan rendering aplikasi. Paket yang terpasang bukan bukti bahwa data pengguna dikirim ke vendor. |
| Fontsource | Plus Jakarta Sans dan JetBrains Mono tersedia sebagai dependensi lokal. Lihat lisensi SIL OFL dalam paket masing-masing. |
| Devicon | Logo teknologi di dokumentasi. Lihat [lisensi Devicon](../assets/tech/LICENSE.devicon.txt). |

Cookie autentikasi adalah `sage_session` dan `sage_oauth_browser`. UI menyediakan informasi cookie tanpa pilihan persetujuan untuk pelacak. Saat menambahkan integrasi baru, periksa permintaan jaringan, penyimpanan browser, tujuan pemrosesan, dan lisensi aset.

Pengelola deployment dapat mengisi `SAGE_PRIVACY_CONTACT_EMAIL` dengan alamat kontak resmi yang dipantau, lalu mengujinya melalui halaman kebijakan. Penghapusan analisis menggunakan Riwayat. Permintaan penghapusan akun ditangani pengelola setelah verifikasi pemilik, termasuk pemeriksaan sesi, kredensial, artefak, dan retensi backup. Alamat usaha, identitas resmi pengendali, dasar pemrosesan, retensi deployment, dan prosedur untuk data anak perlu ditetapkan oleh pengelola sebelum publikasi kebijakan sebagai dokumen resmi.

Acuan pelindungan data anak dan hak penghapusan tersedia dalam [UU No. 27 Tahun 2022](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022).
