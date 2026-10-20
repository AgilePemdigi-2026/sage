# `@sage/analyzer-php`

Static PHP analysis adapter for SAGE's Common Code Model. The trusted `nikic/php-parser` process receives source bytes through stdin. It parses the supplied bytes as data and never includes or evaluates analyzed source, runs Composer scripts, loads the repository's autoloader, or installs dependencies.

## APIs

`parsePhp(source)` remains available as a compatibility probe. `analyzeDeclarations(input)` emits the declaration-only CCM subset without resolver edges. `analyzeReferences(input)` emits those declarations plus conservative, declaration-backed reference edges:

```ts
import { readFile } from "node:fs/promises";
import { analyzeReferences } from "@sage/analyzer-php";

const result = await analyzeReferences({
  snapshot: {
    repository: "owner/repository",
    branch: "main",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
  sources: {
    "src/service.php": new Uint8Array(await readFile("src/service.php")),
  },
  // Optional captured config bytes; these are parsed as JSON data only.
  configurationSources: {
    "composer.json": new Uint8Array(await readFile("composer.json")),
  },
});

if (!result.ccm) throw new Error(result.errorCode ?? "analysis failed");
```

Both APIs take snapshot-relative paths and immutable byte snapshots, return a validated and canonical CCM v1, canonical JSON, content SHA-256, per-file diagnostics, and a status. For `analyzeReferences`, `complete` means there are no unresolved references, failed/excluded files, or material extraction/resolution limitations. `partial` preserves the available graph when syntax, unsupported constructs, external/dynamic targets, or conservative ambiguity prevents full resolution. The declaration-only API may report informational resolver limitations while remaining complete because it does not perform resolution. `failed` means no PHP source could be processed or input/CCM validation failed. Abort signals stop the active parser process and propagate cancellation.

## Reference coverage

`analyzeReferences` emits reference evidence for class/function imports, `extends`, `implements`, named type references, `new`, direct function calls, static calls, safe `$this`/typed-receiver method calls, and `$this`/static property reads and writes. Properties are included as declaration nodes only in resolver mode. Namespace aliases and grouped imports use PHP-Parser's name resolver. Function fallback follows PHP's namespaced-function then global-function lookup rule. Local symbol names are case-insensitive where PHP requires it; only a unique parsed declaration can be an `Exact` target.

Composer PSR-4 and `autoload-dev` mappings may be supplied as bounded JSON bytes. A path hint never creates an `Exact` edge by itself; the corresponding unique class/interface declaration must also be present among the supplied source bytes. The resolver does not inspect Composer scripts, `autoload.files`, classmaps, or autoloaders. Missing targets remain `Unresolved` with a structured reason and reference evidence. Open-class instance dispatch, late static binding, and other ambiguous dispatch are intentionally unresolved; final/private declarations can make a subset of those references exact.

## Supported declaration subset and limits

The declaration nodes are file/namespace modules, named classes and interfaces, named functions, and named methods. In resolver mode, named class properties and constructor-promoted properties are also represented. Constant declarations, traits and trait composition, enums, anonymous classes/functions, nested or conditional declarations, dynamic variable/class/member names, and include/require/eval targets are not resolved. Inline HTML is not interpreted. Invalid UTF-8 or syntax omits declarations from that file while valid sibling files remain available.

Evidence uses half-open, zero-based UTF-8 byte offsets from the supplied source bytes. Line numbers are one-based and columns count Unicode code points, including BOM and CRLF-aware source handling. Ordering and canonical output are deterministic for the same captured bytes and snapshot.

## Checks

The focused tests are `tests/analyzer-php.test.ts` and `tests/analyzer-php-resolver.test.ts`. They cover declaration compatibility, grouped aliases, inheritance, function and static/member calls, property references, unresolved targets, ambiguity safeguards, Composer hints, no-execution canaries, exact evidence, abort handling, and canonical replay. Repository-wide checks are run with `npm test` and `npm run typecheck` on the supported Node runtime.
