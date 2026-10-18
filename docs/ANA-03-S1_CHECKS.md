# ANA-03-S1 JavaScript/TypeScript declaration checks

Scope is the first declaration-producing JS/TS adapter stage. It emits module, class, interface, function, method, and property nodes into CCM v1 from exact snapshot bytes. Resolver edges and whole-language coverage remain outside this acceptance.

## Acceptance evidence

| Check | Expected result |
| --- | --- |
| Existing `parseSource(source, fileName)` callers | Probe signature and syntax result remain available |
| JS/TS oracle declarations | Class, interface, and function nodes contain the independent oracle byte spans and snippets |
| CCM integrity | Every emitted CCM passes the existing runtime validator against the same source byte map |
| Repeatability | Reordering source-map keys produces the same canonical JSON and content hash |
| Source positions | BOM, CRLF, accented identifiers, and supplementary Unicode produce validator-valid UTF-8 byte spans and positions |
| Syntax failure | A file with parser errors is marked failed, returns diagnostics and a limitation, and contributes no nodes; valid sibling files remain analyzable |
| Unsupported syntax | Anonymous declarations, variable declarations, enums, type aliases, expressions, and dynamic computed names are recorded as limitations |
| Dynamic/resolution boundary | Dynamic imports and computed member access are reported; no import/call/heritage/type-reference edges are fabricated |
| Empty source | No zero-width module node is emitted; the limitation is retained and CCM remains valid |
| No target execution/config loading | TypeScript uses `createSourceFile`; JavaScript syntax diagnostics use a no-lib/no-resolve in-memory compiler host that refuses file reads; no source is executed and no project config is loaded |

Run with `npm test` and `npm run typecheck` from the repository root. Focused coverage is in [`../tests/analyzer-js.test.ts`](../tests/analyzer-js.test.ts); implementation and API scope are in [`../packages/analyzer-js/README.md`](../packages/analyzer-js/README.md).

This issue does not claim import/symbol resolution, TypeScript type checking, JSX application semantics, completeness for all syntax forms, or end-to-end repository analysis. Those remain follow-on ANA-03 work.

## Hasil aktual 19 Oktober 2026

Base implementasi: `cb07efa` (main setelah UI-01). Identitas commit mengikuti penanggung jawab issue, `iltizamhasan3`; review kode dan validasi di bawah dilakukan secara otomatis. Ini bukan catatan review manual anggota.

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| Build Docker dari workspace/lockfile | Instalasi kontrak tersedia pada build web dan dependency worker | PASS; `@sage/contracts` disertakan pada kedua tahap instalasi |
| `docker compose build` — check | Lint/typecheck dan seluruh tes lulus | PASS; 29 tes utama + 8 tes database, 0 gagal |
| Build Next.js production | Halaman aplikasi berhasil dikompilasi | PASS |
| Oracle deklarasi minimum | Deklarasi JS/TS memuat snippet dan batas oracle independen | PASS |
| Regresi hasil review | Sintaks TS di JS/JSX ditolak; nama anggota kosong tidak menggagalkan sibling | PASS |
| Source edge cases | Unicode/BOM/CRLF, komentar/whitespace/BOM saja, UTF-8 invalid, path traversal, dan input tanpa source ditangani | PASS |
| Determinisme | Urutan input berbeda menghasilkan JSON/hash canonical sama | PASS |

Runtime pengujian: Linux arm64, Node.js 24.22.0, TypeScript 5.9.3. SHA-256 manifest fixture: `41697b000ef84741303d82828740fcfb6cd0c0a52355dfd2b742bf94c3a54148`. SHA commit pada input tes adalah identitas fixture sintetis yang eksplisit, bukan klaim commit repository remote.

Review kode terpisah menemukan penerimaan sintaks TypeScript di JavaScript dan kegagalan validator karena nama anggota kosong. Kedua temuan diperbaiki dan diuji ulang. Pemeriksaan akhir tidak menemukan masalah material tersisa. Parent #12 tetap terbuka; tidak ada bukti login GitHub, snapshot remote, resolver lintas file, atau pipeline analisis end-to-end dari paket ini.
