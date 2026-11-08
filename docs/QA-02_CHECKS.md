# QA-02 — Integrasi dan release evidence

**Hasil verifikasi lokal: lulus dengan batasan yang dicatat.** Issue [#24](https://github.com/AgilePemdigi-2026/sage/issues/24) tetap terbuka sampai PR ini mendapat independent review dan merge. Run bersih dilakukan pada 9 November 2026 dengan image Docker yang dibangun dari source commit `6174452423da75f8090d98ef63a87bef23f5cb80`. Bukti terstruktur yang aman untuk repository publik ada di [laporan live integration](evidence/QA-02-live-integration-2026-11-09.json).

## Fresh Docker-to-demo run

Compose project `sage-cleanqa` menggunakan volume database dan storage baru. Sebelum login, database tidak berisi user atau analysis. Migrasi selesai; database, web, dan worker sehat; halaman aplikasi serta `/api/health` merespons HTTP 200. Volume stack lokal lama tidak disentuh.

Login GitHub berhasil melalui browser pada akun `iltizamhasan3`. Daftar repository publik tampil dan repository `iltizamhasan3/sistem-informasi-perpus` dipilih pada branch `master`, commit [`d72c3532a7d59cab242fb705ab201cf99ef35e88`](https://github.com/iltizamhasan3/sistem-informasi-perpus/commit/d72c3532a7d59cab242fb705ab201cf99ef35e88). Analysis dimulai dari UI dan selesai dalam 45 detik.

| Check | Actual result |
| --- | --- |
| Pipeline | `COMPLETED_WITH_LIMITATIONS`; 9/9 stages |
| Code Knowledge | 105 source files; 3,116 nodes / 3,420 edges; 655 Exact / 2,765 Unresolved |
| Software Engineering Diagram | 17 features; 67 displayed connections; 189 source relationships represented; displayed links are marked **Indikasi** |
| Architecture Definition Document | Opened; Interface Catalog evidence links target the pinned GitHub commit and source line ranges |
| Markdown | `READY`; 13,234,876 bytes in storage; UI fetched the file and passed its SHA-256 check against the export record before starting the download |
| PDF | `READY`; 2,268,622 bytes in storage; UI verified PDF content type and SHA-256 against the export record before starting the download |
| History and delete | The analysis appeared in history, was permanently deleted after explicit approval, cleanup completed, and history returned to its empty state |

The export hashes in the database matched the corresponding storage-object hashes. That browser run verified download integrity, not visual layout. A separate offline replay of the pinned Perpus snapshot with the default presentation and PDF renderer 2.4.0 generated an 88-page A4 landscape PDF; all pages were checked in contact sheets, and pages 1, 5, 7, 53, 72, 87, and 88 were inspected at full resolution. No clipping or overlap was observed. This renderer review is not a claim that the offline PDF bytes are identical to the Docker UI download. The render hash, source commit, and scope are in [PDF visual review evidence](evidence/PDF-visual-review-2026-11-09.json).

## Automated regression and provider checks

- Latest code regression at `feb42d5f7dab5afe26dc33018af4963d0e6f2e17`: `npm test -- --test-concurrency=1` passed 538/538; `npm run test:data` passed 8/8; `npm run test:semantic` passed 105/105; semantic Cucumber BDD passed 3 scenarios / 17 steps. The initial parallel full-suite attempt had one PHP analyzer test return `failed` instead of `partial`; the isolated PHP suite then passed 9/9 and the serialized full suite passed. Lint and both TypeScript checks passed.
- Typecheck and production Docker build passed. Lint passed with three existing React Hooks warnings in `semantic-workspace.tsx`.
- Browser regression covers landing/health, auth/workspace, repository target and account isolation at 360, 390, 768, 1024, and 1440 px. Those deterministic cases use controlled provider responses and are not counted as live GitHub checks.
- Separate live provider checks used GitHub to read public repositories, installations, an authorized private repository, branch metadata, and the target commit without creating an analysis. The fresh clean-volume analysis above used a public repository.
- The fresh run showed `COMPLETED_WITH_LIMITATIONS`; successful completion does not imply all Code Knowledge references were resolved or every source behavior was recovered.

## Additional source coverage and limits

- An earlier private Node.js HTTP end-to-end run used app build `b29127b32afb8ac4cf427627bc60e983d2d3b230` and is recorded without private repository identity or source SHA. It produced 9/9 stages and 76 indicated semantic relationships. A later independent review found false-positive registration cases; commit `6174452` fixes them and the negative regression tests now pass, but the private repository has not been replayed through the final Docker image.
- The final source replay benchmark for that private sample recorded 147 files, 28,259,410 canonical ADD bytes, 30,290,957 Markdown bytes, 730,055 PDF bytes, 638,320,640 bytes process peak RSS, 5 features, and 76 indicated relationships. This is a static replay/resource check, not a second live app run or human semantic-correctness signoff.
- Earlier public Perpus and Emosync runs are historical comparisons; their results and unresolved references remain in the linked report. They are not substitutes for the fresh clean-volume run.
- Node HTTP relationships are static **Indikasi**: the extractor does not claim that `server.listen` executed or that a route is runtime-reachable. Dynamic registration remains unsupported. The reviewed Perpus PDF is 88 pages because the source snapshot exposes many endpoint and related-action flows; it is A4 and readable per flow, while Markdown carries the complete technical detail.
- No Coolify deployment, shared-host capacity test, backup restore, or multi-group load test was run. Private source identity and SHA are intentionally omitted from public evidence.

Provider and history component coverage remains documented in [GH-02](GH-02_CHECKS.md) and [HIST-01](HIST-01_CHECKS.md). Close #24 only after this implementation PR is independently reviewed and merged.
