# Screenshot produk

Gambar berasal dari aplikasi SAGE asli (server standalone produksi) di browser Chromium, bukan mockup desain. Tidak ada retouch.

## Data yang dipakai

- Akun `@akun-fixture` dan repository `contoh-org/*` adalah data sintetis. Tidak ada akun GitHub atau repository pengguna nyata.
- Analisis `contoh-org/sage-pinned` memakai source fixture [`tests/fixtures/semantic/sage-pinned`](../../../tests/fixtures/semantic/sage-pinned/) (snapshot source SAGE sendiri, commit `c2dc3d8`). Graph, ADD baseline, dan evidence dihasilkan oleh analyzer, semantic model, dan ADD baseline asli, lalu disimpan ke database test.
- Empat baris lain di Riwayat hanya baris analisis sintetis tanpa artefak.
- Daftar repository, branch, dan target di halaman Repository di-mock di browser, karena akun sintetis tidak punya akses GitHub.
- Kredensial dan token di harness bersifat sintetis. Tidak ada kredensial nyata.

## Cara pengambilan

- Tanggal: 24 November 2026.
- Source aplikasi: `cabd9f0` (branch `docs/readme-dan-riwayat`).
- Harness Docker terisolasi (project `sage-bdd-ui`) dengan database disposable `sage_bdd_sprint1` dan server di port 3100.
- Viewport 1440 px, reduced motion aktif agar animasi tidak terekam di tengah jalan.
- Artefak lokal (tidak di-commit): `artifacts/bdd/readme-20261124/`.

## Berkas

| Berkas | Halaman | Ukuran | SHA-256 |
| --- | --- | --- | --- |
| `landing-hero.png` | Landing `/`, tanpa sesi | 1440 × 900 | `2f0bd32fde97807dce4b16230c564b5390c1cab99c51d9689fe51c3b8898b012` |
| `repository.png` | Pilih repository, target tervalidasi | 1440 × 1080 | `0e425b19049f930fe6e7b137cfccb66173e2eb3fa6ded47a35758f70dd527a96` |
| `progres.png` | Progres analisis, 9 dari 9 tahap | 1440 × 900 | `0a26f1c3a6557007897244b0185091e580c9acbcb4743a3bfcd665a5f9e64fd3` |
| `togaf-add.png` | Architecture Definition Document | 1440 × 900 | `12c3c99346c0f8922870ab3c6c6fe60638aef9eba57698b5d9d37fd9c152f1e4` |
| `togaf-add-review.png` | Review ADD, data object Analysis dikonfirmasi | 1440 × 900 | `9d8ed3b2054eb16d4fddb632d5e48a9e9531fee842a2dfad37f9c46676884acc` |
| `code-knowledge.png` | Code Knowledge dengan inspector terbuka | 1440 × 1000 | `529300c44963fedc0c484e4d5b55548194589dfc7f7f07457808260ced2d6ea8` |
| `riwayat.png` | Riwayat analisis, lima status | 1440 × 900 | `f4a60e5284a06c66f7cd6a82476230b2500e1f35c5e28d9d3899ce3f25bbd5be` |

Screenshot lama (`repository.png`, `code-knowledge.png`, dan `documentation.png` dari 15 November 2026, sebelum revisi ADD dan UI tahap 2) sudah diganti. Riwayatnya tetap ada di Git.

[Kembali ke README](../../../README.md) · [Panduan testing](../../guides/TESTING.md)
