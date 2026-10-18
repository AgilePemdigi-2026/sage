import assert from "node:assert/strict";
import test from "node:test";
import { parseSource } from "@sage/analyzer-js";

test("JS/TS dibaca sebagai data meskipun berisi throw pada top level", () => {
  for (const fileName of ["example.js", "example.ts"]) {
    const result = parseSource('throw new Error("MUST_NOT_EXECUTE"); export class Example {}', fileName);
    assert.equal(result.valid, true);
    assert.ok(result.statementKinds.includes("ClassDeclaration"));
  }
});

test("syntax invalid menghasilkan diagnostic, bukan hasil sukses", () => {
  const result = parseSource("export class {", "invalid.ts");
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.length > 0);
});
