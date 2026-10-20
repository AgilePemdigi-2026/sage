import test from "node:test";
import assert from "node:assert/strict";
import { statusLabel, statusTone, formatDateTime } from "../apps/web/components/history/format.ts";

test("status labels and tones cover every analysis status", () => {
  assert.equal(statusLabel("QUEUED"), "Menunggu");
  assert.equal(statusLabel("RUNNING"), "Berjalan");
  assert.equal(statusLabel("COMPLETED"), "Selesai");
  assert.equal(statusLabel("COMPLETED_WITH_LIMITATIONS"), "Selesai dengan batasan");
  assert.equal(statusLabel("FAILED"), "Gagal");
  for (const unknown of ["UNKNOWN", ""]) assert.equal(statusLabel(unknown), null);
  assert.equal(statusTone("QUEUED"), "info");
  assert.equal(statusTone("RUNNING"), "info");
  assert.equal(statusTone("COMPLETED"), "success");
  assert.equal(statusTone("COMPLETED_WITH_LIMITATIONS"), "warning");
  assert.equal(statusTone("FAILED"), "error");
  assert.equal(statusTone("UNKNOWN"), null);
});
test("datetime formats id-ID in Asia/Jakarta", () => {
  const value = formatDateTime("2026-10-19T01:01:00Z");
  assert.match(value, /2026/);
  assert.match(value, /08[.:]01|08\.01|08:01/);
  assert.match(value, /Okt|Oct/);
});
test("formatDateTime tolerates null and invalid", () => {
  assert.equal(formatDateTime(null), "—");
  assert.equal(formatDateTime(undefined), "—");
  assert.equal(formatDateTime("not-a-date"), "—");
});
