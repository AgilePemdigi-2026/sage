# `@sage/analyzer-js`

Adapter JavaScript/TypeScript tahap deklarasi yang membaca byte snapshot sebagai data melalui Compiler API TypeScript. File JavaScript memakai host compiler sepenuhnya in-memory hanya untuk memperoleh syntax diagnostics khusus JavaScript; host menolak file lain dan menonaktifkan library, module resolution, dan type acquisition. Adapter tidak menjalankan source, membaca `tsconfig.json` atau `package.json`, memuat plugin, memanggil type checker, maupun menyelesaikan import dan simbol.

## API

`parseSource(source, fileName)` tetap tersedia sebagai probe kompatibilitas syntax. Untuk membuat CCM v1, panggil `analyzeDeclarations` dengan identitas snapshot yang diberikan pemanggil dan byte file yang persis berasal dari snapshot:

```ts
import { analyzeDeclarations } from "@sage/analyzer-js";

const result = analyzeDeclarations({
  snapshot: {
    repository: "owner/repository",
    branch: "main",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
  sources: {
    "src/service.ts": new Uint8Array(await readFile("src/service.ts")),
  },
});

if (!result.ccm) throw new Error(result.errorCode ?? "analysis failed");
```

The result contains a canonical CCM v1 payload, canonical JSON and its SHA-256, per-file parser diagnostics, and a status. `complete` means every recognized source parsed and its declarations were represented by this adapter. A `partial` result records syntax failures, excluded input types, unsupported declarations, or dynamic constructs. Resolver-stage limitations remain listed even when declaration extraction is complete. `failed` means no recognized source produced a usable declaration result, or the analysis input/CCM failed validation.

## Declaration subset

The adapter emits file and namespace modules, named classes, interfaces and functions, class/interface methods and properties, and TypeScript constructor parameter properties. Identifier names and computed string, numeric, or no-substitution-template names are represented. Node IDs use the supplied full snapshot SHA, path, kind, qualified name, and byte bounds. Each node's declaration evidence and file SHA are checked by `@sage/contracts` before the canonical result is returned.

Anonymous class/function declarations, class/function expressions, arrow functions, enums, type aliases, variable declarations as standalone nodes, dynamic computed member names, and unsupported class/interface members produce limitations instead of inferred nodes. Empty files have no zero-width module span and therefore produce a limitation without a Module node. Invalid UTF-8 or parser syntax marks that file failed and omits its declarations while retaining other usable files.

This phase emits no edges. Imports, calls, inheritance, implementations, and type references are deferred to the resolver work; unknown receivers are not assigned a concrete target. Runtime-computed `import()`/`require()` targets, `eval`, `new Function`, and computed member access are recorded as limitations and are never evaluated.

Evidence offsets are UTF-8 byte offsets with exclusive ends. Line and column positions follow the CCM validator convention: one-based lines and Unicode code-point columns, including CR in the prefix before LF and preserving the BOM in byte offsets. The parser does not load project configuration or resolve module paths.

## Checks

From the repository root, run `npm test` and `npm run typecheck`. `tests/analyzer-js.test.ts` checks the source-derived declaration oracles, CCM validation/canonical replay, byte spans across BOM/CRLF/Unicode, invalid syntax in JS/JSX as well as TS, and explicit limitations for unsupported or dynamic constructs. The fixture manifest remains the independent source oracle; analyzer output is checked against contained spans rather than used to generate the expected declarations.
