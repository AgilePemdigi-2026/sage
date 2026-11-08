# QA-02 — Integrasi dan release evidence

**Hasil verifikasi: lulus untuk signoff lokal; issue #24 tetap menunggu PR perubahan ini selesai direview dan digabung.** Fresh run 9 November 2026 memakai aplikasi lokal hasil build Docker, Node.js 24.22.0, dan akun GitHub `iltizamhasan3`. Bukti yang aman untuk repository publik disimpan di [QA-02 live integration report](evidence/QA-02-live-integration-2026-11-09.json). Identitas dan source SHA repository private sengaja tidak dicatat.

## Fresh end-to-end run

Playwright memakai UI untuk memilih repository private yang sudah diizinkan, memeriksa target, dan mengirim analisis. Worker menyelesaikan sembilan stage. Halaman Code Knowledge, Software Engineering Diagram, dan dokumentasi terbuka tanpa page error. Kedua export diunduh melalui aplikasi dan cocok dengan content hash yang disimpan.

| Check | Actual result |
| --- | --- |
| Pipeline | `COMPLETED_WITH_LIMITATIONS`; 9/9 stages; 6,594 Code Knowledge nodes dan 8,570 edges |
| Software Engineering Diagram | 5 features, 15 route candidates, 28 outcomes, 76 relationships; seluruh relasi berstatus **Indikasi** |
| Node HTTP source evidence | Handler yang di-import ditemukan dipanggil dengan pasangan request/response dari callback `node:http` `createServer`; `server.listen` dan runtime reachability tidak disimpulkan |
| Markdown | `READY`, downloaded; 30,282,983 bytes; stored content hash matched |
| PDF | `READY`, downloaded; 431,593 bytes; stored content hash matched; PDF signature valid |
| Cleanup | Test analysis dihapus sesudah verifikasi; cleanup selesai |

Relasi Node HTTP tetap **Indikasi**, bukan bukti runtime: extractor membaca source statis dan tidak menjalankan repository yang dianalisis. Batasan ini terlihat pada evidence dan model; status resolver Code Knowledge tidak diubah. Pengujian positif/negatif memastikan callback dengan urutan argumen yang salah tidak ditampilkan sebagai hubungan terdaftar.

## Regression dan provider checks

- Fresh browser regression melewati landing/health, auth/workspace, repository target, dan isolasi akun pada lebar 360, 390, 768, 1024, dan 1440 px.
- Playwright provider terpisah menggunakan akun nyata untuk membaca repository publik, installation, serta repository private yang diizinkan; alur mencakup branch dan target tanpa membuat analysis.
- Fresh authenticated UI submission dan provider checks melengkapi evidence OAuth/provider yang telah tercatat pada run sebelumnya. Regression suite memakai controlled provider responses dan tidak dihitung sebagai live GitHub test.
- Perpus dan Emosync sebelumnya menyelesaikan pipeline serta export; hasil dan keterbatasannya tetap tercatat di tabel historis di bawah. Resolusi referensi yang belum pasti tetap ditandai sebagai limitation.
- `npm run test:semantic`: 104/104 passed. Final full test suite: 537 passed, 0 failed, 0 skipped. The PDF input-boundary tests also pass. Typecheck, lint, Docker production build, and browser suites passed; lint retains three pre-existing React Hooks warnings.

## Hasil repository pembanding sebelumnya

| Public sample and pinned commit | Pipeline and Code Knowledge | Software Engineering Diagram | Export |
| --- | --- | --- | --- |
| `iltizamhasan3/sistem-informasi-perpus`, `master`, [`d72c3532a7d59cab242fb705ab201cf99ef35e88`](https://github.com/iltizamhasan3/sistem-informasi-perpus/commit/d72c3532a7d59cab242fb705ab201cf99ef35e88) | 21.5 s; 9/9 stages; 105 files; 3,116 nodes / 3,420 edges | 17/17 features; 67 displayed connections; 189 represented source relationships | Markdown READY (13,234,876 bytes); PDF READY (3,368,578 bytes); prior run did not record a separate byte-for-byte download check |
| `iltizamhasan3/emosync-backend`, `main`, [`a22992668658538f6fc10b904d6f7b2ed09124ac`](https://github.com/iltizamhasan3/emosync-backend/commit/a22992668658538f6fc10b904d6f7b2ed09124ac) | 14.7 s; 9/9 stages; 122 files; 513 nodes / 1,408 edges; 87 Exact / 1,321 Unresolved | 14/14 features; 149 source relationships | Markdown and PDF downloaded; both HTTP 200 and hash matched; PDF signature valid |

An earlier private Node HTTP baseline had zero represented relationships and its PDF exceeded the document input limit. That result is superseded by the fresh run above: source-backed registration evidence was added, and compact PDF rendering now accepts the canonical model while retaining separate HTML/PDF bounds. The earlier failure is not counted as a current pass.

## Scope and limitations

- This is local release evidence, not a Coolify deployment, shared-host capacity test, or a test of an empty database volume.
- Emosync and Perpus retain unresolved references and extraction limits; successful pipeline completion does not mean every source behavior was recovered.
- Node HTTP registration only supports the narrowly recognized static import and callback-dispatch pattern. Dynamic mounting, shadowed bindings, and runtime listening are not inferred.
- The PDF is intentionally a compact overview and per-flow document; full relationship explanations, line evidence, documentation text, and technical registers remain in Markdown.

Provider-boundary and prior history checks remain in [GH-02](GH-02_CHECKS.md) and [HIST-01](HIST-01_CHECKS.md). Close #24 after this implementation PR has an independent review and is merged.
