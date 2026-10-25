# Acceptance Cucumber BDD Sprint 1

Dokumen ini mencatat suite Cucumber BDD Sprint 1 dan pemetaannya terhadap skenario sumber SRS. Semua feature, scenario, dan step pada revisi ini memakai Gherkin berbahasa Inggris (`# language: en`). Suite berisi 10 skenario browser dan 10 skenario domain. Terjemahan judul skenario SRS ditandai dengan referensi B.7; pemeriksaan lokal yang hanya mendukung sebagian kebutuhan diberi label supporting check atau local check. Perubahan English Gherkin dan traceability ini dikerjakan pada [issue #84](https://github.com/AgilePemdigi-2026/sage/issues/84).

## Batas suite

Skenario browser menggunakan session sintetis dan respons API terkendali. Request ke origin lain diblokir; tes ini tidak membuktikan OAuth, izin repository, atau metadata GitHub nyata. Skenario domain menggunakan snapshot fixture statis, antrean PostgreSQL disposable, dan handler uji tepercaya untuk runner. Tes tersebut memeriksa kontrak pada batas source, queue, dan runner; tes itu bukan penerimaan penuh alur produk atau consumer pipeline.

Untuk pemilihan commit, SRS B.7.2 memberi contoh short SHA 7f3b89a, sedangkan aplikasi saat ini memvalidasi full SHA sesuai APP-04. Skenario browser karena itu memakai full SHA terkontrol dan berhenti pada validasi target; skenario tersebut tidak menekan Mulai Analisis atau membuktikan job masuk antrean. Interpretasi ini dicatat sebagai adaptasi perilaku aplikasi, bukan salinan persis langkah UI asli SRS.

Suite ini memberi bukti parsial pada beberapa bagian kontrak. Tidak ada skenario kanonis B.7 yang diterima penuh oleh suite terkendali ini. Suite tidak menutup keseluruhan kasus T-*, acceptance backlog, QA-01 signoff, atau gate release T-REL-01.

## Status revisi dan bukti historis

Revisi feature Inggris saat ini: **PASS — 20 skenario, 120 langkah**, run `2026-10-25T07-16-57-387Z` pada commit tes `01be063`. Lint pada berkas BDD dan typecheck lulus. Run menggunakan PostgreSQL disposable baru dan memasang berkas tes Inggris saat ini pada production image teruji dari 23 Oktober; source aplikasi tidak berubah pada revisi ini, sehingga image aplikasi tidak dibangun ulang. Semua container/network uji dibersihkan setelah eksekusi. Manifest, JSON, dan HTML pada `artifacts/bdd/2026-10-25T07-16-57-387Z/` mencatat bukti eksekusi tersebut. Dry-run mengenali seluruh 20 skenario/120 langkah tanpa step undefined.

Bukti berikut berasal dari **revisi sebelumnya**, bukan feature berbahasa Inggris; catatan run 23 Oktober awalnya dibuat untuk [issue #82](https://github.com/AgilePemdigi-2026/sage/issues/82):

- Run 2026-10-23T14-19-08-140Z mencatat PASS untuk 18 skenario/108 langkah pada Node.js 24.22.0, PostgreSQL 17, PHP 8.4.26, dan Chromium headless. Run tersebut memakai server Next.js production dan database uji terpisah.
- Replay Docker 2026-10-23T14-23-50-467Z juga mencatat PASS untuk 18/108 dan membersihkan project uji otomatis.
- Dry-run revisi lama mengenali 18 skenario/108 langkah dengan status VALIDATED_ONLY, yang bukan bukti assertion perilaku.
- Pada revisi lama, lint, typecheck, 292 tes utama, dan 8 tes data lulus. Guard menolak database selain sage_bdd_sprint1 sebelum akses data dan menolak pemilihan tag tanpa skenario. Kontrol negatif menolak port 3000 yang sudah dipakai sebelum migrasi; kontrol positif Composer menulis canary hanya ketika hook sengaja dijalankan di container terpisah.

Laporan historis tersimpan di `artifacts/bdd/<run-id>/` dan direktori itu diabaikan Git. Angka dan status di atas tidak berlaku untuk revisi sekarang.

## Menjalankan

Gunakan Node.js versi >=24.11.0 <25 dan dependency project yang sudah dipasang.

| Command | Kebutuhan | Arti hasil |
| --- | --- | --- |
| **npm run test:bdd:dry** | Tidak memerlukan database atau browser | Memeriksa parsing feature/step dengan dry-run; tidak menjalankan assertion perilaku. Status laporan VALIDATED_ONLY. |
| **npm run test:bdd** | SAGE_BDD_TESTS=1, DATABASE_URL menuju DB disposable sage_bdd_sprint1 yang sudah dimigrasikan, dan server Next.js tersedia di SAGE_BDD_BASE_URL | Menjalankan skenario browser dan domain pada layanan yang dituju. AUTH_BASE_URL dan SAGE_BDD_BASE_URL harus menunjuk ke origin HTTP loopback yang sama. DATABASE_URL dan CREDENTIAL_ENCRYPTION_KEY juga harus sama untuk Next.js dan runner. Gunakan hanya DB/key uji khusus. |
| **npm run test:bdd:docker** | Docker Compose tersedia | Membuat project Compose bernama unik, menjalankan DB disposable, membangun target BDD, lalu menjalankan server production lokal di container runner tanpa host port. Project, volume dan network milik run ini dibersihkan setelah selesai. |

Untuk mode langsung, siapkan file privat lokal .env.bdd.local (diabaikan Git) berisi konfigurasi khusus test: DATABASE_URL dengan nama sage_bdd_sprint1, AUTH_BASE_URL dan SAGE_BDD_BASE_URL ke origin loopback yang sama, serta CREDENTIAL_ENCRYPTION_KEY test-only. Gunakan key 32 byte Base64 dan source file yang sama sebelum menjalankan Next.js production server serta runner, sehingga keduanya membaca database, origin, dan key yang sama. Jangan menyalin nilai key ke dokumentasi atau chat.

Contoh mode langsung:

    set -a
    . ./.env.bdd.local
    set +a
    export SAGE_BDD_TESTS=1
    npm run test:bdd

Runner menolak database dengan nama selain sage_bdd_sprint1. Mode langsung tidak memigrasikan database atau menyalakan server; siapkan database uji dan server production terlebih dahulu. Mode Docker membuat nilai AUTH/key sintetis khusus di dalam runner dan menyiapkan database serta server sendiri. Jangan arahkan suite ke database atau aplikasi pengguna.

Setiap run membuat folder baru di artifacts/bdd/<run-id> dan tidak menimpa laporan lama. Laporan Cucumber HTML/JSON dan run.json menyimpan mode, status, kode keluar, versi Node, hash lockfile, commit aplikasi bila tersedia, serta batas suite. Kegagalan browser dapat menyertakan screenshot tanpa cookie, header, token, atau URL callback. Artefak ini merupakan bukti run tersebut; daftar skenario atau dry-run sendiri bukan bukti lulus.

## Katalog skenario sumber SRS B.7.1–B.7.3

Judul berikut diterjemahkan ke bahasa Inggris dari B.7 pada SRS. Nomor PDF merujuk halaman PDF sumber 76–79. ID SAGE-FR-* menghubungkan skenario dengan requirement pada [requirement traceability](REQUIREMENTS_TRACEABILITY.md); SRS B.7 sendiri tidak menuliskan ID tersebut pada judul skenario.

| SRS | English translation of original scenario | PDF page | Related SAGE-FR IDs | Executable mapping and coverage |
| --- | --- | --- | --- | --- |
| B.7.1 — Connect GitHub Account | Successfully connect a GitHub account | 76–77 | GH-01, GH-02, GH-03, GH-04, GH-07 | **NOT_COVERED.** No test follows successful authorization to the repositories page. A controlled denial does not cover success. |
| B.7.1 — Connect GitHub Account | The developer is not signed in to GitHub | 77 | GH-01, GH-02, GH-03, GH-09, GH-10 | **NOT_COVERED.** The local workspace session guard is an APP/NFR check, not GitHub sign-in or provider authentication. |
| B.7.1 — Connect GitHub Account | The developer denies GitHub access permission | 77 | GH-01, GH-02, GH-03, GH-08, GH-10 | **PARTIAL.** github.feature checks a synthetic denial callback, safe feedback, and retry; it does not contact GitHub. |
| B.7.1 — Connect GitHub Account | GitHub authentication fails | 77 | GH-01, GH-02, GH-03, GH-09, GH-10 | **NOT_COVERED.** No provider credential failure is tested. The unauthenticated workspace check must not be treated as GH-09. |
| B.7.2 — Select a Repository | Successfully select a repository and branch without a commit | 77–78 | REP-01, REP-03, REP-04, REP-05, REP-06, REP-07, REP-08, REP-09 | **PARTIAL.** repository.feature checks an empty commit falling back to the branch full SHA using controlled APIs. It stops at target validation and does not start analysis. |
| B.7.2 — Select a Repository | Successfully select a repository with a specific commit | 78 | REP-01, REP-03, REP-04, REP-05, REP-06, REP-07, REP-09 | **PARTIAL.** repository.feature checks a controlled full-SHA validation request. This adapts the SRS short-SHA example to the current APP-04 contract and does not start analysis. |
| B.7.2 — Select a Repository | The repository is not found | 78 | REP-02, REP-13 | **PARTIAL.** repository.feature checks an empty search result against a controlled loaded list, not a live repository provider. |
| B.7.3 — Analyze a Repository | Repository analysis completes successfully | 78 | REP-10, REP-11, REP-12, ANA-01–ANA-11, ANA-14, ANA-15 | **PARTIAL.** Source adapter/policy scenarios and a trusted-handler runner scenario cover selected domain contracts. No test proves the full progress UI, graph/documents, or published product result. |
| B.7.3 — Analyze a Repository | Some source code uses an unsupported language | 79 | ANA-03, ANA-12, ANA-13, ANA-14 | **PARTIAL.** source.feature includes an unsupported Ruby file and checks classification/exclusion plus supported-source analysis. It does not verify the complete limitation message and result action in the analysis UI. |
| B.7.3 — Analyze a Repository | Analysis fails | 79 | REP-12, ANA-11, ANA-14 | **PARTIAL.** runner.feature injects a trusted handler failure and checks the runner state. It does not verify the canonical Failed screen, error message, or retry action. |

## Skenario feature yang dapat dijalankan

Judul pada kolom pertama adalah nama skenario aktual pada revisi saat ini. Status di sini menjelaskan hubungan ruang lingkup tes dengan SRS; status ini bukan hasil run.

### Browser terkendali — 10 skenario

| File | Scenario title in feature file | SRS or local label | Coverage relation | Boundary |
| --- | --- | --- | --- | --- |
| [github.feature](../tests/bdd/features/github.feature) | <code>[SRS B.7.1 \| SAGE-FR-GH-08 Permission Denial Handling + SAGE-FR-GH-10 Retry Connection] The developer denies GitHub access permission (controlled)</code> | B.7.1 permission denial; GH-08, GH-10 | PARTIAL | Controlled callback/API; no live OAuth or provider permission. |
| [repository.feature](../tests/bdd/features/repository.feature) | <code>[Supporting check \| SRS 4.2 \| SAGE-FR-REP-01 Authorized Repository List] Authorized repositories are listed for a synthetic account</code> | Supporting check; SRS 4.2; REP-01 | LOCAL SUPPORT | Public/private repositories come from a synthetic account fixture. |
| [repository.feature](../tests/bdd/features/repository.feature) | <code>[SRS B.7.2 \| SAGE-FR-REP-13 Repository Search Empty Result] Repository not found (controlled)</code> | B.7.2 repository not found; REP-13 | PARTIAL | Empty search result against a controlled loaded list. |
| [repository.feature](../tests/bdd/features/repository.feature) | <code>[SRS B.7.2 \| SAGE-FR-REP-08 Latest Commit Fallback] Successfully select a repository and branch without a commit (controlled)</code> | B.7.2 no-commit selection; REP-08 | PARTIAL | Empty commit uses the branch full SHA; stops at target validation. |
| [repository.feature](../tests/bdd/features/repository.feature) | <code>[SRS B.7.2 \| SAGE-FR-REP-07 Optional Commit Selection] Successfully select a repository with a specific commit (controlled)</code> | B.7.2 specific-commit selection; REP-07 | PARTIAL | Controlled full SHA validation; does not start analysis. |
| [repository.feature](../tests/bdd/features/repository.feature) | <code>[Supporting check \| SRS 4.2 \| SAGE-FR-REP-05 Branch Retrieval + SAGE-FR-REP-09 Analysis Target Validation] Controlled branch and target failures can be retried</code> | Supporting check; SRS 4.2; REP-05, REP-09 | LOCAL SUPPORT | Controlled API errors and retries, not canonical normal-flow acceptance. |
| [repository.feature](../tests/bdd/features/repository.feature) | <code>[Supporting check \| SRS 4.2 \| SAGE-FR-REP-01 Authorized Repository List] A controlled public repository list failure can be retried</code> | Supporting check; SRS 4.2; REP-01 | LOCAL SUPPORT | Controlled repository-list error and recovery. |
| [repository.feature](../tests/bdd/features/repository.feature) | <code>[Supporting check \| SRS 4.2 \| SAGE-FR-REP-05 Branch Retrieval + SAGE-FR-REP-09 Analysis Target Validation] An empty branch list blocks target validation until reloaded</code> | Supporting check; SRS 4.2; REP-05, REP-09 | LOCAL SUPPORT | Controlled empty-branch guard. |
| [repository.feature](../tests/bdd/features/repository.feature) | <code>[Supporting check \| SRS 4.1 / 5.3 \| SAGE-FR-GH-06 Repository Access Restriction] Switching accounts isolates the visible repositories</code> | Supporting check; SRS 4.1/5.3; GH-06 | LOCAL SUPPORT | Synthetic sessions; does not prove live GitHub authorization. |
| [ui.feature](../tests/bdd/features/ui.feature) | <code>[Supporting check \| APP-01 / NFR-05 \| SRS 5.3] An unauthenticated user is redirected away from the workspace</code> | Supporting check; APP-01, NFR-05; SRS 5.3 | LOCAL APP/NFR | Local workspace session guard, not GitHub login or GH-09. |

### Domain dan database — 10 skenario

| File | Scenario title in feature file | SRS or local label | Coverage relation | Boundary |
| --- | --- | --- | --- | --- |
| [source.feature](../tests/bdd/features/source.feature) | <code>[SAGE-FR-ANA-04] Supported Source Code Analysis; [SAGE-FR-ANA-05] Common Code Model Generation — Supporting SRS B.7.3: mixed-language adapter subset</code> | Supporting B.7.3 success; ANA-04, ANA-05 | PARTIAL | Checks JavaScript/PHP declarations from a snapshot, not all stages or pipeline outputs. |
| [source.feature](../tests/bdd/features/source.feature) | <code>[SAGE-FR-ANA-03] Language and Project Structure Detection — Supporting SRS B.7.3: source-policy exclusions only</code> | Supporting B.7.3; ANA-03 | LOCAL SUPPORT | Checks exclusion reasons for generated files/metadata/dependencies, not unsupported-language UX. |
| [source.feature](../tests/bdd/features/source.feature) | <code>Supporting SRS B.7.3 — Some source code uses an unsupported language (domain subset) — [SAGE-FR-ANA-13] Partial Analysis Continuation; syntax-invalid sibling is supporting local robustness coverage</code> | B.7.3 unsupported-language; ANA-13 | PARTIAL | Ruby fixture checks classification/exclusion and supported-source analysis. Syntax-invalid sibling is local robustness; limitation UI is not tested. |
| [source.feature](../tests/bdd/features/source.feature) | <code>[NFR-04] Original source remains unchanged and target code is not executed — supporting local source-safety check: Composer hook non-execution</code> | Local NFR-04 | LOCAL APP/NFR | Checks Composer canary non-creation; not SAGE-FR-ANA-12. |
| [queue.feature](../tests/bdd/features/queue.feature) | <code>[SAGE-FR-REP-11] Analysis Initialization — Supporting local queue checks: global slot and FIFO owner isolation (snapshot retrieval and pipeline startup are not covered)</code> | REP-11; APP-03, NFR-05 | LOCAL SUPPORT | Checks slot/FIFO and owner scope in disposable PostgreSQL; no snapshot retrieval or pipeline start. |
| [queue.feature](../tests/bdd/features/queue.feature) | <code>[SAGE-FR-REP-11] Analysis Initialization — Supporting local queue checks: idempotent submission preserves the immutable full SHA and owner scope (snapshot retrieval and pipeline startup are not covered)</code> | REP-11; APP-04, NFR-05 | LOCAL SUPPORT | Checks queue replay/idempotency, not B.7.2 repository selection or pipeline acceptance. |
| [queue.feature](../tests/bdd/features/queue.feature) | <code>[SAGE-FR-REP-11] Analysis Initialization — Supporting local queue checks: expired-lease recovery and slot ownership (snapshot retrieval and pipeline startup are not covered)</code> | REP-11; APP-03, NFR-05 | LOCAL SUPPORT | Checks lease/slot state in disposable PostgreSQL; no snapshot retrieval or pipeline start. |
| [runner.feature](../tests/bdd/features/runner.feature) | <code>Supporting SRS B.7.3 — Repository analysis completes successfully: stage persistence only — [SAGE-FR-ANA-11] Analysis Progress Update</code> | Supporting B.7.3 success; ANA-11 | PARTIAL | Persists nine trusted handlers in sequence; publishes no graph, document, or terminal product result. |
| [runner.feature](../tests/bdd/features/runner.feature) | <code>Supporting SRS B.7.3 — Analysis fails (trusted-handler subset) — [SAGE-FR-ANA-11] Analysis Progress Update</code> | Supporting B.7.3 failure; ANA-11 | PARTIAL | Checks an injected handler failure and pending downstream stages, not the Failed UI or retry action. |
| [runner.feature](../tests/bdd/features/runner.feature) | <code>[SAGE-FR-ANA-11] Analysis Progress Update — Supporting local runner lease guard: an expired claim prevents stage execution</code> | Local runner lease guard; ANA-11 | LOCAL SUPPORT | Checks stale runner does not invoke a handler or touch the slot after recovery. |

## Tag dan traceability

- `@sprint1`, `@browser`, `@domain`, `@database`, dan `@controlled` mengelompokkan cakupan dan boundary. database menandai state queue/runner; skenario browser juga memakai DB hanya untuk fixture session/OAuth.
- `@US_*` adalah label user story lokal, bukan ID user story asli SRS.
- `@SAGE_FR_*` menulis ID normatif dengan underscore agar dapat dipakai sebagai tag; katalog menampilkan ID kanonis SAGE-FR-*. Mapping parsial tidak berarti keseluruhan requirement diterima.
- `@APP_*` dan `@NFR_*` adalah label kebutuhan aplikasi/nonfungsional lokal. Keduanya ditampilkan terpisah dari FR SRS pada tabel skenario dan tidak diperlakukan sebagai ID B.7.
- `@issue_*` merujuk backlog GitHub, bukan ID SRS.
- Positive, Alternative/recovery, dan Failure/guard menjelaskan jenis contoh, bukan hasil eksekusi.

Sumber nama feature, scenario, dan step adalah berkas .feature; bila skenario berubah, perbarui kedua tabel pemetaan. Untuk requirement SRS, backlog, dan test case lengkap, lihat [requirement traceability](REQUIREMENTS_TRACEABILITY.md), [product backlog](PRODUCT_BACKLOG.md), dan [test plan](TEST_PLAN.md).

## Referensi Cucumber

Suite memakai [Cucumber-JS](https://github.com/cucumber/cucumber-js) dan sintaks [Gherkin](https://cucumber.io/docs/gherkin/reference/). File feature menggunakan lokalisasi keyword Inggris (`# language: en`).
