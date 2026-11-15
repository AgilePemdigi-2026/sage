# Testing

Gunakan Node.js 24 dan dependency yang sesuai lockfile. Dari root checkout:

```sh
npm ci
npm run db:generate
npm run check
```

`check` menjalankan lint, typecheck, unit test, dan pemeriksaan data. Ini bukan pengganti browser/worker/OAuth end-to-end. PHP diperlukan untuk pengujian adapter PHP pada host. Untuk browser suite, pasang Chromium dengan `npx playwright install chromium` dan ikuti prasyarat runner terkait.

| Kebutuhan | Panduan / command |
| --- | --- |
| Sprint 1, skenario SRS | [BDD Sprint 1](BDD_SPRINT1.md) |
| Sprint 2, skenario SRS dan pendukung | [BDD Sprint 2](BDD_SPRINT2.md) |
| Semantik | `npm run test:semantic`; browser/database/export memiliki runner opt-in tersendiri pada package scripts |
| Replay demo | [Final demo](FINAL_DEMO.md) |
| Requirement dan cakupan | [Test plan](../planning/TEST_PLAN.md) |

Suite integrasi yang melakukan seed/cleanup hanya boleh memakai database serta storage disposable yang disebut runner. Jangan menggunakan database produksi atau mengganti guard nama database agar tes bisa berjalan. OAuth provider nyata terpisah dari sesi fixture sintetis.

Laporan run disimpan pada `artifacts/` lokal; evidence terpilih berada pada [arsip QA](../archive/qa/) dan [evidence terstruktur](../evidence/). Baca tanggal, commit, scope, kegagalan, dan retest bersama. Pemindahan dokumentasi tidak berarti seluruh suite dijalankan ulang. Gunakan Given/When/Then berbahasa Inggris dengan parameter berpetik dua sesuai konvensi SRS proyek.
