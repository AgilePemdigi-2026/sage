import assert from "node:assert/strict";
import test from "node:test";
import { classifyWorkerError } from "../apps/worker/src/diagnostics.ts";

test("claim retry requires a known pre-execution failure or rolled back transaction", () => {
  for (const code of ["P1001", "P2024", "P2034", "ECONNREFUSED", "53300", "55P03", "40001", "40P01"]) {
    assert.equal(classifyWorkerError({ code }).retryableClaim, true, code);
  }
  for (const code of ["P1017", "P1002", "P1008", "P2028", "ECONNRESET", "ETIMEDOUT", "57014", "UNTRUSTED_SECRET"]) {
    assert.equal(classifyWorkerError({ code }).retryableClaim, false, code);
  }
  assert.equal(classifyWorkerError({ code: "ECONNRESET" }).retryableHeartbeat, true);
  assert.equal(classifyWorkerError({ code: "P2028" }).retryableHeartbeat, false);
});

test("actual Prisma/pg adapter wrapper shapes map to fixed safe diagnostics", () => {
  const error = { code: "P2010", message: "SQL credentials source canary", meta: {
    driverAdapterError: { cause: { kind: "TransactionWriteConflict", originalCode: "40001", originalMessage: "private query" } },
  } };
  assert.deepEqual(classifyWorkerError(error), { code: "DATABASE_TRANSACTION_CONFLICT", retryableClaim: true, retryableHeartbeat: true });
  assert.equal(classifyWorkerError({ cause: { kind: "ConnectionClosed" } }).code, "DATABASE_CONNECTION_LOST");
  assert.equal(classifyWorkerError(new Error("timeout exceeded when trying to connect")).code, "DATABASE_POOL_TIMEOUT");
  assert.equal(classifyWorkerError(new Error("prefix timeout exceeded when trying to connect SECRET")).code, "UNCLASSIFIED");
  assert.equal(classifyWorkerError({ errorCode: "P1001" }).code, "DATABASE_UNREACHABLE");
  assert.equal(classifyWorkerError({ code: "P2010", meta: { code: "42P01" } }).code, "DATABASE_SCHEMA");
});

test("configuration, schema, storage and unknown failures stay non-retryable and private", () => {
  for (const input of [{ code: "P1000" }, { code: "P2021" }, { code: "ENOSPC" }, { code: "53100" }, { code: "53200" }, { code: "EACCES" }, new SyntaxError("SECRET"), new Error("SECRET")]) {
    const result = classifyWorkerError(input);
    assert.equal(result.retryableClaim, false);
    assert.equal(result.retryableHeartbeat, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test("safe classification neither invokes accessors nor traverses arbitrary metadata", () => {
  let touched = false;
  const hostile = Object.defineProperty({}, "code", { get() { touched = true; throw new Error("SECRET"); } });
  const cyclic = { cause: hostile, code: "not-allowed", meta: {} };
  cyclic.meta = cyclic;
  assert.equal(classifyWorkerError(cyclic).code, "UNCLASSIFIED");
  assert.equal(touched, false);
  assert.equal(classifyWorkerError({ arbitrary: { code: "P2034" } }).code, "UNCLASSIFIED");
  assert.equal(classifyWorkerError(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("SECRET"); }, getPrototypeOf() { throw new Error("SECRET"); } })).code, "UNCLASSIFIED");
  assert.equal(classifyWorkerError({ code: "constructor" }).code, "UNCLASSIFIED");
});
