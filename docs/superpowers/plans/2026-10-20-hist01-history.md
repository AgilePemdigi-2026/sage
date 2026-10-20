# HIST-01 — History per user, search, empty/error, navigasi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Halaman Riwayat produk yang membaca analysis nyata milik satu pengguna, dengan search/filter, state lengkap, dan navigasi status-based ke halaman detail.

**Architecture:** Query owner-scoped baru di `@sage/database` (keyset cursor), API GET handler gaya deps-injection seperti `target-handlers.ts`, dua route Next.js, halaman `/workspace/history` + `/analyses/[analysisId]` yang memakai pola styling fixture `HistoryScreen`. Label stage diambil dari `@sage/contracts` di lapisan web — `@sage/database` sengaja tidak menarik dependensi baru.

**Tech Stack:** Next.js App Router, TypeScript (ESM, import dengan sufiks `.ts`), Prisma/PostgreSQL, `node:test` + `node:assert/strict`, Tailwind + CSS module design-system yang sudah ada.

**Spec:** `docs/superpowers/specs/2026-10-20-hist01-history-design.md`

## Global Constraints

- Node `>=24.11.0 <25`, npm workspaces, TypeScript `type: "module"`, import pakai sufiks `.ts`.
- Tidak menambah dependency runtime baru apa pun.
- Seluruh query wajib memuat predicate `ownerUserId` dari session server; analisis milik orang lain → `404` (`ANALYSIS_NOT_FOUND`), bukan `403`.
- Semua response history: `Cache-Control: private, no-store`, `Vary: Cookie`, `X-Content-Type-Options: nosniff`.
- Teks UI bahasa Indonesia; tanggal `id-ID` zona `Asia/Jakarta`.
- Commit satu baris Conventional Commit, prefix `feat(hist01)` / `test(hist01)` / `docs(hist01)`.
- `@sage/database` tidak boleh bergantung pada `@sage/contracts` (merge label stage dilakukan di web; kunci stage diduplikasi dengan komentar sinkronisasi).
- Page size list = 20; cursor keyset `(createdAt DESC, id DESC)` memakai index `@@index([ownerUserId, createdAt])`.
- Dilarang menyimpan secret; bukti/artefak test hanya ke `artifacts/` (sudah diabaikan Git).
- Versi kode di plan ini adalah **versi final**; jangan menambahkan prop nama lain yang belum dideklarasi di bagian Interfaces.

---

### Task 1: Query helper DB — `packages/database/src/history.ts`

**Files:**
- Create: `packages/database/src/history.ts`
- Modify: `packages/database/src/index.ts` (tambah re-export)
- Test: `tests/history.test.ts`

**Interfaces:**
- Consumes: `PrismaClient` dari `../generated/client.ts` (pattern `access.ts`).
- Produces (dipakai Task 2, 3, 4):
  - `class HistoryQueryError extends Error` (messages: `"Status filter tidak valid."`, `"Cursor tidak valid."`, `"Query pencarian terlalu panjang."`, `"ID analisis tidak valid."`)
  - `const HISTORY_STATUS_FILTERS: readonly string[]` dan `type HistoryStatusFilter = (typeof HISTORY_STATUS_FILTERS)[number]`
  - `type HistoryListOptions = { query?: string | undefined; status?: string | undefined; cursor?: string | undefined }`
  - `interface HistoryListItem { id: string; repositoryFullName: string; branchName: string; commitSha: string; status: string; errorCode: string | null; queuedAt: Date; startedAt: Date | null; completedAt: Date | null; retryOfAnalysisId: string | null }`
  - `interface HistoryListResult { items: HistoryListItem[]; nextCursor: string | null; pageSize: number }`
  - `encodeHistoryCursor(cursor: { createdAt: Date; id: string }): string` (base64url)
  - `parseHistoryCursor(value: string): { createdAt: Date; id: string } | null`
  - `listAnalysesForUser(db: PrismaClient, userId: string, options?: HistoryListOptions): Promise<HistoryListResult>`
  - `interface AnalysisStageRecord { sequence: number; key: string; status: string; errorCode: string | null; startedAt: Date | null; finishedAt: Date | null }`
  - `interface AnalysisDetailRecord { id: string; repositoryFullName: string; branchName: string; commitSha: string; status: string; errorCode: string | null; retryOfAnalysisId: string | null; queuedAt: Date; startedAt: Date | null; completedAt: Date | null; updatedAt: Date; stateVersion: number; stages: AnalysisStageRecord[]; limitations: { stageKey: string; code: string; safeExplanation: string }[]; results: { graphUrl: string; documentUrl: string } | null }`
  - `getAnalysisDetailForUser(db: PrismaClient, userId: string, analysisId: string): Promise<AnalysisDetailRecord | null>`

- [ ] **Step 1: Tulis test gagal** — `tests/history.test.ts`

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeHistoryCursor, parseHistoryCursor, HistoryQueryError,
  listAnalysesForUser, getAnalysisDetailForUser,
} from "../packages/database/src/history.ts";
import { ANALYSIS_STAGE_DEFINITIONS } from "../packages/contracts/src/index.ts";

function fakeDb(rows: Record<string, unknown>[], findFirst: (args: unknown) => Promise<unknown> = async () => null) {
  return {
    analysis: {
      findMany: async (args: { where: Record<string, unknown> }) => { void args; return rows; },
      findFirst,
    },
  } as unknown as Parameters<typeof listAnalysesForUser>[0];
}
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "hist-row-0001-0001", repository: { fullName: "acme/report-service" }, branchName: "main",
    commitSha: "a".repeat(40), status: "COMPLETED", errorCode: null, queuedAt: new Date("2026-10-19T01:00:00Z"),
    startedAt: new Date("2026-10-19T01:01:00Z"), completedAt: new Date("2026-10-19T01:05:00Z"),
    retryOfAnalysisId: null, createdAt: new Date("2026-10-19T01:00:00Z"), ...overrides,
  };
}

test("cursor encode/parse round-trip and reject garbage", () => {
  const cursor = encodeHistoryCursor({ createdAt: new Date("2026-10-19T02:00:00.000Z"), id: "hist-row-0002-0002" });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseHistoryCursor(cursor), { createdAt: new Date("2026-10-19T02:00:00.000Z"), id: "hist-row-0002-0002" });
  const epochZero = Buffer.from(JSON.stringify({ c: "1970-01-01T00:00:00.000Z", i: "hist-row-0002-0002" })).toString("base64url");
  for (const bad of ["", "###", "!!", "eyJiYWQiOjF9", epochZero]) assert.equal(parseHistoryCursor(bad), null);
});

test("list filters status, query substring, and applies keyset where clause", async () => {
  let captured: { where: Record<string, unknown>; orderBy: unknown; take: number } | undefined;
  const db = fakeDb([]);
  (db as { analysis: { findMany: (args: never) => Promise<Record<string, unknown>[]> } }).analysis.findMany = (async (args: never) => {
    captured = args as typeof captured; return [];
  }) as never;
  await listAnalysesForUser(db, "owner", {
    status: "FAILED", query: "  report-service  ",
    cursor: encodeHistoryCursor({ createdAt: new Date("2026-10-18T00:00:00.000Z"), id: "hist-row-0000-0000" }),
  });
  const where = captured?.where;
  assert.equal(where?.ownerUserId, "owner");
  assert.equal(where?.status, "FAILED");
  assert.ok(Array.isArray(where?.OR));
  assert.ok(Array.isArray(where?.AND));
  await assert.rejects(listAnalysesForUser(db, "owner", { status: "GONE" }), HistoryQueryError);
  await assert.rejects(listAnalysesForUser(db, "owner", { cursor: "!!" }), HistoryQueryError);
  await assert.rejects(listAnalysesForUser(db, "owner", { query: "x".repeat(201) }), HistoryQueryError);
  await assert.rejects(listAnalysesForUser(db, "   ", undefined), HistoryQueryError);
});

test("list maps rows and closes pagination after pageSize items", async () => {
  const rows = Array.from({ length: 21 }, (_, index) => row({ id: `hist-row-${String(index).padStart(4, "0")}-0001`, createdAt: new Date(Date.UTC(2026, 9, 19, 1, 0, index)) }));
  const result = await listAnalysesForUser(fakeDb(rows), "owner");
  assert.equal(result.items.length, 20);
  assert.equal(result.nextCursor, encodeHistoryCursor({ createdAt: new Date(Date.UTC(2026, 9, 19, 1, 0, 19)), id: "hist-row-0019-0001" }));
  assert.deepEqual(result.items[0], {
    id: "hist-row-0000-0001", repositoryFullName: "acme/report-service", branchName: "main", commitSha: "a".repeat(40),
    status: "COMPLETED", errorCode: null, queuedAt: row().queuedAt, startedAt: row().startedAt,
    completedAt: row().completedAt, retryOfAnalysisId: null,
  });
});

test("detail returns stages filled to nine, limitations, and result links only for terminal success", async () => {
  const detailRow = {
    id: "hist-detail-0001x", branchName: "main", commitSha: "a".repeat(40), status: "COMPLETED", errorCode: null,
    retryOfAnalysisId: null, queuedAt: row().queuedAt, startedAt: row().startedAt, completedAt: row().completedAt,
    updatedAt: new Date("2026-10-19T01:05:00Z"), repository: { fullName: "acme/report-service" },
    stages: [{ sequence: 1, key: "SNAPSHOT", status: "RUNNING", errorCode: null, startedAt: row().startedAt, finishedAt: null }],
    limitations: [{ stageKey: "STATIC_ANALYSIS", code: "FILE_SKIPPED", safeExplanation: "Satu file dilewati." }],
  };
  const detail = await getAnalysisDetailForUser(fakeDb([], async () => detailRow), "owner", "hist-detail-0001x");
  assert.ok(detail);
  assert.equal(detail.stateVersion, new Date("2026-10-19T01:05:00Z").getTime());
  assert.equal(detail.stages.length, 9);
  assert.equal(ANALYSIS_STAGE_DEFINITIONS.length, 9);
  for (const [index, stage] of detail.stages.entries()) {
    assert.equal(stage.sequence, index + 1);
    assert.equal(stage.key, ANALYSIS_STAGE_DEFINITIONS[index].key);
  }
  assert.deepEqual(detail.results, { graphUrl: `/analyses/${detail.id}/graph`, documentUrl: `/analyses/${detail.id}/document` });
  const queued = await getAnalysisDetailForUser(fakeDb([], async () => ({ ...detailRow, status: "QUEUED" })), "owner", "hist-detail-0001x");
  assert.equal(queued?.results, null);
  for (const stage of queued?.stages ?? []) {
    assert.ok(stage.status === "PENDING" || stage.status === "RUNNING");
  }
});

test("detail is null across users and rejects empty ids", async () => {
  await assert.equal(await getAnalysisDetailForUser(fakeDb([]), "owner", "hist-detail-0001x"), null);
  await assert.rejects(getAnalysisDetailForUser(fakeDb([]), "owner", ""), HistoryQueryError);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx tsx --test tests/history.test.ts`
Expected: FAIL — modul `packages/database/src/history.ts` belum ada (pesan "Cannot find module" atau "does not provide an export").

- [ ] **Step 3: Implementasi** — `packages/database/src/history.ts`

```ts
import type { Prisma, PrismaClient } from "../generated/client.ts";

export class HistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryQueryError";
  }
}

export const HISTORY_STATUS_FILTERS = ["QUEUED", "RUNNING", "COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED"] as const;
export type HistoryStatusFilter = (typeof HISTORY_STATUS_FILTERS)[number];

const PAGE_SIZE = 20;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// PENTING: urutan kunci ini harus identik dengan tabel sembilan tahap di docs/ARCHITECTURE.md
// dan ANALYSIS_STAGE_DEFINITIONS pada packages/contracts/src/stages.ts.
const STAGE_KEYS_BY_SEQUENCE = [
  "SNAPSHOT", "LANGUAGE_DETECTION", "STATIC_ANALYSIS", "COMMON_CODE_MODEL", "KNOWLEDGE_GRAPH",
  "INTERFACE_CATALOG", "SOFTWARE_ENGINEERING_DIAGRAM", "UML_CLASS_DIAGRAM", "ARCHITECTURE_DOCUMENT",
] as const;
function stageKeyBySequence(sequence: number): string {
  return STAGE_KEYS_BY_SEQUENCE[sequence - 1] ?? `STAGE_${sequence}`;
}

function requireOwner(userId: string): void {
  if (typeof userId !== "string" || userId.trim().length === 0) throw new HistoryQueryError("Pemilik data tidak valid.");
}

export function encodeHistoryCursor(cursor: { createdAt: Date; id: string }): string {
  if (!(cursor.createdAt instanceof Date) || Number.isNaN(cursor.createdAt.getTime()) || cursor.createdAt.getTime() === 0
    || typeof cursor.id !== "string" || !ID_PATTERN.test(cursor.id)) {
    throw new HistoryQueryError("Cursor tidak valid.");
  }
  return Buffer.from(JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }), "utf8").toString("base64url");
}

export function parseHistoryCursor(value: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string" || !ID_PATTERN.test(parsed.i)) return null;
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime()) || createdAt.getTime() === 0) return null;
    return { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

export interface HistoryListItem {
  id: string; repositoryFullName: string; branchName: string; commitSha: string;
  status: string; errorCode: string | null; queuedAt: Date; startedAt: Date | null;
  completedAt: Date | null; retryOfAnalysisId: string | null;
}
export interface HistoryListResult {
  items: HistoryListItem[];
  nextCursor: string | null;
  pageSize: number;
}
export type HistoryListOptions = { query?: string | undefined; status?: string | undefined; cursor?: string | undefined };

export async function listAnalysesForUser(db: PrismaClient, userId: string, options: HistoryListOptions = {}): Promise<HistoryListResult> {
  requireOwner(userId);
  const where: Prisma.AnalysisWhereInput = { ownerUserId: userId };
  if (options.status !== undefined) {
    if (typeof options.status !== "string" || !(HISTORY_STATUS_FILTERS as readonly string[]).includes(options.status)) {
      throw new HistoryQueryError("Status filter tidak valid.");
    }
    where.status = options.status;
  }
  if (options.query !== undefined && options.query.trim().length > 200) throw new HistoryQueryError("Query pencarian terlalu panjang.");
  const query = typeof options.query === "string" ? options.query.trim() : "";
  if (query) {
    where.OR = [
      { repository: { is: { fullName: { contains: query, mode: "insensitive" } } } },
      { branchName: { contains: query, mode: "insensitive" } },
      { commitSha: { contains: query, mode: "insensitive" } },
    ];
  }
  if (options.cursor !== undefined) {
    const cursor = parseHistoryCursor(options.cursor);
    if (!cursor) throw new HistoryQueryError("Cursor tidak valid.");
    where.AND = [{
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: { equals: cursor.createdAt }, id: { lt: cursor.id } },
      ],
    }];
  }
  const rows = await db.analysis.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    select: {
      id: true, branchName: true, commitSha: true, status: true, errorCode: true,
      queuedAt: true, startedAt: true, completedAt: true, retryOfAnalysisId: true, createdAt: true,
      repository: { select: { fullName: true } },
    },
  });
  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const items = page.map(({ repository, ...rest }) => ({ ...rest, repositoryFullName: repository.fullName }));
  const last = page.at(-1);
  return {
    items, pageSize: PAGE_SIZE,
    nextCursor: hasMore && last ? encodeHistoryCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export interface AnalysisStageRecord {
  sequence: number; key: string; status: string; errorCode: string | null;
  startedAt: Date | null; finishedAt: Date | null;
}
export interface AnalysisDetailRecord {
  id: string; repositoryFullName: string; branchName: string; commitSha: string;
  status: string; errorCode: string | null; retryOfAnalysisId: string | null;
  queuedAt: Date; startedAt: Date | null; completedAt: Date | null; updatedAt: Date;
  stateVersion: number;
  stages: AnalysisStageRecord[];
  limitations: { stageKey: string; code: string; safeExplanation: string }[];
  results: { graphUrl: string; documentUrl: string } | null;
}

const TERMINAL_SUCCESS = ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] as const;

export async function getAnalysisDetailForUser(db: PrismaClient, userId: string, analysisId: string): Promise<AnalysisDetailRecord | null> {
  requireOwner(userId);
  if (typeof analysisId !== "string" || analysisId.trim().length === 0) throw new HistoryQueryError("ID analisis tidak valid.");
  const row = await db.analysis.findFirst({
    where: { id: analysisId, ownerUserId: userId },
    select: {
      id: true, branchName: true, commitSha: true, status: true, errorCode: true, retryOfAnalysisId: true,
      queuedAt: true, startedAt: true, completedAt: true, updatedAt: true,
      repository: { select: { fullName: true } },
      stages: { orderBy: { sequence: "asc" }, select: { sequence: true, key: true, status: true, errorCode: true, startedAt: true, finishedAt: true } },
      limitations: { orderBy: { createdAt: "desc" }, select: { stageKey: true, code: true, safeExplanation: true } },
    },
  });
  if (!row) return null;
  const stored = new Map(row.stages.map(stage => [stage.key, stage] as const));
  const stages: AnalysisStageRecord[] = Array.from({ length: 9 }, (_, index) => {
    const found = stored.get(stageKeyBySequence(index + 1));
    return found ?? { sequence: index + 1, key: stageKeyBySequence(index + 1), status: "PENDING", errorCode: null, startedAt: null, finishedAt: null };
  });
  const terminalSuccess = (TERMINAL_SUCCESS as readonly string[]).includes(row.status);
  return {
    id: row.id, repositoryFullName: row.repository.fullName, branchName: row.branchName, commitSha: row.commitSha,
    status: row.status, errorCode: row.errorCode, retryOfAnalysisId: row.retryOfAnalysisId,
    queuedAt: row.queuedAt, startedAt: row.startedAt, completedAt: row.completedAt, updatedAt: row.updatedAt,
    stateVersion: row.updatedAt.getTime(), stages, limitations: row.limitations,
    results: terminalSuccess ? { graphUrl: `/analyses/${row.id}/graph`, documentUrl: `/analyses/${row.id}/document` } : null,
  };
}
```

Tambahkan ke `packages/database/src/index.ts` (blok export):

```ts
export {
  encodeHistoryCursor,
  getAnalysisDetailForUser,
  HistoryQueryError,
  listAnalysesForUser,
  parseHistoryCursor,
} from "./history.ts";
export type {
  AnalysisDetailRecord,
  AnalysisStageRecord,
  HistoryListItem,
  HistoryListOptions,
  HistoryListResult,
  HistoryStatusFilter,
} from "./history.ts";
```

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `npx tsx --test tests/history.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/database/src/history.ts packages/database/src/index.ts tests/history.test.ts
git commit -m "feat(hist01): query riwayat owner-scoped dengan cursor keyset"
```

---

### Task 2: API handler + presenter + pembaca sesi — `apps/web/lib/analyses/`

**Files:**
- Create: `apps/web/lib/analyses/handlers.ts`
- Create: `apps/web/lib/analyses/presenters.ts`
- Create: `apps/web/lib/analyses/session.ts`
- Test: `tests/history-handlers.test.ts`

**Interfaces:**
- Consumes: Task 1 (`HistoryListResult`, `AnalysisDetailRecord`, `HistoryQueryError`); `getUniqueCookie`, `isValidOpaqueToken`, `SESSION_COOKIE` dari `../auth/handlers.ts`; `database`, `resolveSession` dari `@sage/database`; `ANALYSIS_STAGE_DEFINITIONS` dari `@sage/contracts` (web boleh berdependensi kontrak).
- Produces (dipakai Task 3, 5, 6):
  - `type AnalysisSession = { userId: string; githubUserId: string }`
  - `readAnalysisSession(request: Request): Promise<AnalysisSession | null>` (yang menolak header `x-sage-account` yang tidak cocok)
  - `type HistoryHandlerDependencies = { readSession: (request: Request) => Promise<AnalysisSession | null>; list: (userId: string, options: { query?: string; status?: string; cursor?: string }) => Promise<HistoryListResult>; detail: (userId: string, analysisId: string) => Promise<AnalysisDetailRecord | null> }`
  - `createHistoryHandlers(deps: HistoryHandlerDependencies): { list(request: Request): Promise<Response>; detail(request: Request, analysisId: string): Promise<Response> }`
  - `const ANALYSIS_STATUSES: readonly string[]` (dua spot: handler + client)
  - `presentHistoryList(result: HistoryListResult): { analyses: Record<string, unknown>[]; nextCursor: string | null }`
  - `presentAnalysisDetail(detail: AnalysisDetailRecord): Record<string, unknown>` — menambah 9 entri stage berlabel, menggabungkan key dari `ANALYSIS_STAGE_DEFINITIONS`

- [ ] **Step 1: Tulis test gagal** — `tests/history-handlers.test.ts`

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryHandlers, ANALYSIS_STATUSES, presentAnalysisDetail } from "../apps/web/lib/analyses/handlers.ts";
import type { HistoryHandlerDependencies } from "../apps/web/lib/analyses/handlers.ts";

function fixture() {
  const calls: string[] = [];
  const deps: HistoryHandlerDependencies = {
    readSession: async () => ({ userId: "owner", githubUserId: "git-1" }),
    list: async (userId) => { calls.push(`list:${userId}`); return { items: [], nextCursor: null, pageSize: 20 }; },
    detail: async () => { calls.push("detail"); return null; },
  };
  return { deps, calls };
}
function get(url: string) {
  return new Request(url);
}
const LIST_URL = "http://localhost:3000/api/analyses";

test("list requires session, validates query/status/cursor strictly, and never leaks without it", async () => {
  const { deps, calls } = fixture();
  const handlers = createHistoryHandlers(deps);
  assert.equal((await handlers.list(get(`${LIST_URL}?status=GONE`))).status, 400);
  assert.equal((await handlers.list(get(`${LIST_URL}?cursor=!!`))).status, 400);
  assert.equal((await handlers.list(get(`${LIST_URL}?query=${"x".repeat(201)}`))).status, 400);
  assert.equal((await handlers.list(get(`${LIST_URL}?page=1`))).status, 400);
  assert.equal((await handlers.list(get(`${LIST_URL}?status=QUEUED&status=FAILED`))).status, 400);
  assert.deepEqual(calls, []);
  deps.readSession = async () => null;
  assert.equal((await handlers.list(get(LIST_URL))).status, 401);
  assert.deepEqual(calls, []);
});

test("list passes owner from server session only and marks response no-store", async () => {
  const { deps, calls } = fixture();
  const handlers = createHistoryHandlers(deps);
  const response = await handlers.list(get(`${LIST_URL}?query=acme&status=QUEUED`));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["list:owner"]);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["data"]);
  assert.deepEqual(body.data, { analyses: [], nextCursor: null });
});

test("detail returns 404 for missing/foreign analyses and 400 for malformed ids", async () => {
  const { deps, calls } = fixture();
  const handlers = createHistoryHandlers(deps);
  assert.equal((await handlers.detail(get(`${LIST_URL}/hist-detail-0001x`), "hist-detail-0001x")).status, 404);
  assert.deepEqual(calls, ["detail"]);
  for (const id of ["short", "x".repeat(65), "bad id!"]) {
    assert.equal((await handlers.detail(get(`${LIST_URL}/${id}`), id)).status, 400);
  }
  assert.equal(calls.some(call => call.includes("x".repeat(65))), false);
});

test("presentAnalysisDetail shapes payload with context, nine labelled stages, canonical links", () => {
  assert.ok(ANALYSIS_STATUSES.includes("COMPLETED_WITH_LIMITATIONS"));
  const base = {
    id: "hist-detail-0001x", repositoryFullName: "acme/r", branchName: "main", commitSha: "a", status: "COMPLETED",
    errorCode: null, retryOfAnalysisId: null, queuedAt: new Date("2026-01-01T00:00:00Z"), startedAt: null,
    completedAt: new Date("2026-01-01T01:00:00Z"), updatedAt: new Date("2026-01-01T01:00:00Z"), stateVersion: 1767229200000,
    stages: [{ sequence: 1, key: "SNAPSHOT", status: "COMPLETED", errorCode: null, startedAt: null, finishedAt: null }],
    limitations: [], results: { graphUrl: "/analyses/hist-detail-0001x/graph", documentUrl: "/analyses/hist-detail-0001x/document" },
  } as never;
  const detail = presentAnalysisDetail(base);
  assert.equal(detail.stateVersion, 1767229200000);
  assert.deepEqual(detail.context, { repositoryFullName: "acme/r", branchName: "main", commitSha: "a" });
  assert.equal(detail.stages.length, 9);
  assert.deepEqual(detail.results, { graphUrl: "/analyses/hist-detail-0001x/graph", documentUrl: "/analyses/hist-detail-0001x/document" });
  assert.equal(detail.limitations.length, 0);
  const failed = presentAnalysisDetail({ ...base, status: "FAILED", results: null } as never);
  assert.equal(failed.results, null);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx tsx --test tests/history-handlers.test.ts`
Expected: FAIL — modul `lib/analyses/handlers.ts` belum ada.

- [ ] **Step 3: Implementasi**

`apps/web/lib/analyses/session.ts`:

```ts
import { database, resolveSession } from "@sage/database";
import { getUniqueCookie, isValidOpaqueToken, SESSION_COOKIE } from "../auth/handlers.ts";

/** Server-only context untuk endpoint analisis. Pemilik datang dari session cookie, tidak pernah dari field request. */
export async function readAnalysisSession(request: Request): Promise<{ userId: string; githubUserId: string } | null> {
  const token = getUniqueCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!isValidOpaqueToken(token)) return null;
  const db = database();
  const now = new Date();
  const session = await resolveSession(db, token, now);
  if (!session) return null;
  const user = await db.user.findUnique({ where: { id: session.userId }, select: { githubUserId: true } });
  if (!user) return null;
  const expectedAccount = request.headers.get("x-sage-account");
  if (expectedAccount !== null && expectedAccount !== user.githubUserId) return null;
  return { userId: session.userId, githubUserId: user.githubUserId };
}
```

`apps/web/lib/analyses/presenters.ts`:

```ts
import { ANALYSIS_STAGE_DEFINITIONS } from "@sage/contracts";
import type { AnalysisDetailRecord, HistoryListResult } from "@sage/database";

const stageLabels = new Map(ANALYSIS_STAGE_DEFINITIONS.map(stage => [stage.key, stage.label] as const));
const stageKeys = ANALYSIS_STAGE_DEFINITIONS.map(stage => stage.key);

export function presentHistoryList(result: HistoryListResult) {
  return {
    analyses: result.items.map(item => ({
      id: item.id,
      repository: { fullName: item.repositoryFullName },
      branch: item.branchName,
      commitSha: item.commitSha,
      status: item.status,
      errorCode: item.errorCode,
      queuedAt: item.queuedAt.toISOString(),
      startedAt: item.startedAt ? item.startedAt.toISOString() : null,
      completedAt: item.completedAt ? item.completedAt.toISOString() : null,
      retryOfAnalysisId: item.retryOfAnalysisId,
    })),
    nextCursor: result.nextCursor,
  };
}

export function presentAnalysisDetail(detail: AnalysisDetailRecord) {
  const stored = new Map(detail.stages.map(stage => [stage.key, stage] as const));
  return {
    stateVersion: detail.stateVersion,
    updatedAt: detail.updatedAt.toISOString(),
    context: {
      repositoryFullName: detail.repositoryFullName,
      branchName: detail.branchName,
      commitSha: detail.commitSha,
    },
    status: detail.status,
    errorCode: detail.errorCode,
    retryOfAnalysisId: detail.retryOfAnalysisId,
    timestamps: {
      queuedAt: detail.queuedAt.toISOString(),
      startedAt: detail.startedAt ? detail.startedAt.toISOString() : null,
      completedAt: detail.completedAt ? detail.completedAt.toISOString() : null,
    },
    stages: stageKeys.map((key, index) => {
      const found = stored.get(key);
      return {
        sequence: index + 1,
        key,
        label: stageLabels.get(key) ?? key,
        status: found?.status ?? "PENDING",
        errorCode: found?.errorCode ?? null,
        startedAt: found?.startedAt ? found.startedAt.toISOString() : null,
        finishedAt: found?.finishedAt ? found.finishedAt.toISOString() : null,
      };
    }),
    limitations: detail.limitations.map(limitation => ({
      stageKey: limitation.stageKey, code: limitation.code, safeExplanation: limitation.safeExplanation,
    })),
    results: detail.results,
  };
}

/** Bentuk payload yang dikirim ke klien detail; dipakai tipe DetailView pada components/history/detail-client.tsx. */
export type AnalysisDetailView = ReturnType<typeof presentAnalysisDetail>;
```

`apps/web/lib/analyses/handlers.ts`:

```ts
import { randomUUID } from "node:crypto";
import { HistoryQueryError } from "@sage/database";
import type { AnalysisDetailRecord, HistoryListResult } from "@sage/database";
import { presentAnalysisDetail, presentHistoryList } from "./presenters.ts";

/** Re-export presenter agar test & route bisa memakai satu titik impor dari handlers. */
export { presentAnalysisDetail, presentHistoryList } from "./presenters.ts";

export const ANALYSIS_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED"] as const;
export type AnalysisSession = { userId: string; githubUserId: string };
export type HistoryHandlerDependencies = {
  readSession: (request: Request) => Promise<AnalysisSession | null>;
  list: (userId: string, options: { query?: string; status?: string; cursor?: string }) => Promise<HistoryListResult>;
  detail: (userId: string, analysisId: string) => Promise<AnalysisDetailRecord | null>;
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
}
function failure(code: string, message: string, status: number) {
  return json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);
}

function listParams(request: Request): { query?: string; status?: string; cursor?: string } | null {
  const params = new URL(request.url).searchParams;
  const allowed = ["query", "status", "cursor"];
  if (allowed.some(key => params.getAll(key).length > 1) || [...params.keys()].some(key => !allowed.includes(key))) return null;
  const query = params.get("query") ?? undefined;
  const status = params.get("status") ?? undefined;
  const cursor = params.get("cursor") ?? undefined;
  if (query !== undefined && (query.length === 0 || query.length > 200)) return null;
  if (status !== undefined && !(ANALYSIS_STATUSES as readonly string[]).includes(status)) return null;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))) return null;
  return { query, status, cursor };
}

const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function createHistoryHandlers(deps: HistoryHandlerDependencies) {
  return {
    async list(request: Request) {
      const session = await deps.readSession(request);
      if (!session) return failure("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401);
      const params = listParams(request);
      if (!params) return failure("INVALID_INPUT", "Parameter pencarian tidak valid.", 400);
      try {
        return json({ data: presentHistoryList(await deps.list(session.userId, params)) });
      } catch (error) {
        if (error instanceof HistoryQueryError) return failure("INVALID_INPUT", error.message, 400);
        return failure("HISTORY_UNAVAILABLE", "Riwayat belum dapat dibaca. Coba lagi.", 503);
      }
    },
    async detail(request: Request, analysisId: string) {
      if (typeof analysisId !== "string" || !ANALYSIS_ID_PATTERN.test(analysisId)) {
        return failure("INVALID_INPUT", "ID analisis tidak valid.", 400);
      }
      const session = await deps.readSession(request);
      if (!session) return failure("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401);
      try {
        const detail = await deps.detail(session.userId, analysisId);
        if (!detail) return failure("ANALYSIS_NOT_FOUND", "Analisis tidak ditemukan.", 404);
        return json({ data: presentAnalysisDetail(detail) });
      } catch {
        return failure("HISTORY_UNAVAILABLE", "Analisis belum dapat dibaca. Coba lagi.", 503);
      }
    },
  };
}
```

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `npx tsx --test tests/history-handlers.test.ts tests/history.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/web/lib/analyses tests/history-handlers.test.ts
git commit -m "feat(hist01): handler API GET /api/analyses dengan validasi ketat"
```

---

### Task 3: Route Next.js + wiring server

**Files:**
- Modify: `apps/web/app/api/analyses/route.ts` (tambah GET; tidak mengubah `POST`)
- Create: `apps/web/app/api/analyses/[analysisId]/route.ts`
- Create: `apps/web/lib/analyses/server-handlers.ts`

**Interfaces:**
- Consumes: `createHistoryHandlers`, `readAnalysisSession` (Task 2); `database`, `listAnalysesForUser`, `getAnalysisDetailForUser` (Task 1).
- Produces: `analysisHandlers` — dipakai kedua route.

- [ ] **Step 1: Implementasi** `apps/web/lib/analyses/server-handlers.ts`

```ts
import { database, getAnalysisDetailForUser, listAnalysesForUser } from "@sage/database";
import { readAnalysisSession } from "./session.ts";
import { createHistoryHandlers } from "./handlers.ts";

/** Wiring produksi. Unit test mengganti deps; objek ini hanya mengikat database nyata. */
export const analysisHandlers = createHistoryHandlers({
  readSession: readAnalysisSession,
  list: (userId, options) => listAnalysesForUser(database(), userId, options),
  detail: (userId, analysisId) => getAnalysisDetailForUser(database(), userId, analysisId),
});
```

- [ ] **Step 2: Route list** — edit `apps/web/app/api/analyses/route.ts`; tambahkan import di atas dan export GET setelah {deklarasi POST yang sudah ada. Isi `POST` dan seluruh komentar lain tidak berubah:

```ts
import { analysisHandlers } from "../../../lib/analyses/server-handlers.ts";
// ... (isi file yang sudah ada tetap; setelah const POST:)
export const GET = analysisHandlers.list;
```

- [ ] **Step 3: Route detail** — `apps/web/app/api/analyses/[analysisId]/route.ts`

```ts
import { analysisHandlers } from "../../../../lib/analyses/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return analysisHandlers.detail(request, (await context.params).analysisId);
}
```

- [ ] **Step 4: Verifikasi**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Bentuk `params: Promise<{ analysisId: string }>` mengikuti pattern `app/api/github/installations/[id]/repositories/route.ts`.

- [ ] **Step 5: Commit**

```sh
git add apps/web/app/api/analyses apps/web/lib/analyses/server-handlers.ts
git commit -m "feat(hist01): route GET /api/analyses dan detail analisis"
```

---

### Task 4: Integration test DB riwayat

**Files:**
- Create: `tests/history.integration.ts`
- Modify: `package.json` root — tambah script `"test:history:integration"` (dijalankan di Step 3).

**Interfaces:**
- Consumes: `listAnalysesForUser`, `getAnalysisDetailForUser` (Task 1), `database`, `disconnectDatabase` (existing), Prisma client dari `@sage/database`.

- [ ] **Step 1: Tulis test** — `tests/history.integration.ts`

```ts
// Integration test destruktif terhadap database uji terisolasi yang sudah dimigrasi.
// Jalankan: SAGE_HISTORY_TESTS=1 DATABASE_URL='postgresql://sage@queue-db:5432/sage_hist01_fresh' npx tsx --test tests/history.integration.ts
import test from "node:test";
import assert from "node:assert/strict";
import { database, disconnectDatabase, getAnalysisDetailForUser, listAnalysesForUser } from "../packages/database/src/index.ts";

const suffix = process.env.SAGE_HISTORY_TESTS === "1";
if (!suffix) {
  test("history integration is opt-in", () => { assert.ok(true, "skip: set SAGE_HISTORY_TESTS=1 dan DATABASE_URL"); });
} else {
  if (!/\/sage_hist01(_fresh)?$/.test(process.env.DATABASE_URL ?? "")) {
    console.error("Integration menolak database selain sage_hist01 dan sage_hist01_fresh.");
    process.exit(1);
  }
  const db = database();
  const ownerIds: string[] = [];
  const analysisIds: string[] = [];
  const runTag = Date.now();
  const suffixLabel = `hist-int-${runTag}`;

  test("setup: seed fixed users, repository, and 22 analyses", async () => {
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `${suffixLabel}-repo`, ownerLogin: "acme", name: "report-service", fullName: "acme/report-service",
      },
      select: { id: true },
    });
    const ownerA = await db.user.create({ data: { githubUserId: `${suffixLabel}-a`, login: `${suffixLabel}-a` }, select: { id: true } });
    const ownerB = await db.user.create({ data: { githubUserId: `${suffixLabel}-b`, login: `${suffixLabel}-b` }, select: { id: true } });
    ownerIds.push(ownerA.id, ownerB.id);
    void repository;
    for (let index = 0; index < 22; index += 1) {
      const analysis = await db.analysis.create({
        data: {
          ownerUserId: ownerA.id, repositoryId: repository.id,
          branchName: index === 0 ? "feature/x" : "main", commitSha: "a".repeat(40),
          configuration: {}, configurationHash: "integration-config",
          analyzerVersion: "declarations-v1", schemaVersion: "1",
          status: index === 3 ? "FAILED" : index % 2 === 0 ? "COMPLETED" : "RUNNING",
          errorCode: index === 3 ? "SNAPSHOT_INVALID" : null,
          createdAt: new Date(runTag + index),
          updatedAt: new Date(runTag + 1_000_000 + index),
        },
        select: { id: true },
      });
      analysisIds.push(analysis.id);
    }
    const foreign = await db.analysis.create({
      data: {
        ownerUserId: ownerB.id, repositoryId: repository.id, branchName: "main", commitSha: "b".repeat(40),
        configuration: {}, configurationHash: "integration-config",
        analyzerVersion: "declarations-v1", schemaVersion: "1", status: "COMPLETED",
      },
      select: { id: true },
    });
    analysisIds.push(foreign.id);
  });

  test("owner-scoped list only returns own analyses", async () => {
    const ownerA = ownerIds[0];
    const result = await listAnalysesForUser(db, ownerA);
    assert.equal(result.items.length, 20);
    for (const item of result.items) assert.notEqual(item.id, analysisIds.at(-1));
  });

  test("status filter and query filter behave", async () => {
    const ownerA = ownerIds[0];
    const failed = await listAnalysesForUser(db, ownerA, { status: "FAILED" });
    assert.equal(failed.items.length, 1);
    assert.equal(failed.items[0].errorCode, "SNAPSHOT_INVALID");
    const searched = await listAnalysesForUser(db, ownerA, { query: "acme" });
    assert.ok(searched.items.length > 0);
    const branchSearch = await listAnalysesForUser(db, ownerA, { query: "feature/x" });
    assert.equal(branchSearch.items.length, 1);
    const shaSearch = await listAnalysesForUser(db, ownerA, { query: "a".repeat(40) });
    assert.equal(shaSearch.items.length, 20);
  });

  test("cursor pagination is stable without duplicates or overlaps", async () => {
    const ownerA = ownerIds[0];
    const first = await listAnalysesForUser(db, ownerA);
    assert.equal(first.items.length, 20);
    assert.notEqual(first.nextCursor, null);
    const second = await listAnalysesForUser(db, ownerA, { cursor: first.nextCursor ?? "" });
    assert.equal(second.items.length, 2);
    const firstIds = new Set(first.items.map(item => item.id));
    for (const item of second.items) assert.equal(firstIds.has(item.id), false);
  });

  test("detail shows stored stage then nine-entry fill and owner isolation", async () => {
    const ownerA = ownerIds[0];
    const withStages = analysisIds[0];
    await db.analysisStage.create({
      data: { ownerUserId: ownerA, analysisId: withStages, sequence: 1, key: "SNAPSHOT", status: "RUNNING", startedAt: new Date() },
    });
    const detail = await getAnalysisDetailForUser(db, ownerA, withStages);
    assert.ok(detail);
    assert.equal(detail.stages.length, 9);
    assert.equal(detail.stages[0].status, "RUNNING");
    assert.ok(detail.stages.slice(1).every(stage => stage.status === "PENDING"));
    assert.equal(detail.results === null || detail.results.graphUrl.endsWith("/graph"), true);
    const crossOwner = await getAnalysisDetailForUser(db, ownerIds[1], withStages);
    assert.equal(crossOwner, null);
  });

  test.after(async () => {
    if (!suffix) return;
    await db.analysis.deleteMany({ where: { id: { in: analysisIds } } });
    await db.user.deleteMany({ where: { id: { in: ownerIds } } });
    await db.repository.deleteMany({ where: { fullName: { startsWith: suffixLabel ? "acme/report-service" : "" } } });
    await disconnectDatabase();
  });
}
```

> **Catatan cleanup:** baris `repository.deleteMany` di atas merepotkan ketika database `sage_hist01_fresh` selalu di-recreate. Pipihkan: seluruh test di file ini incl. `test.after` bersifat throwaway terhadap DB uji; cukup hapus user + analysis + repository. Cari `repoRow` dan gunakan id repository yang dibuat di setup (simpan `repositoryId` pada variabel module-level) untuk deleteMany yang akurat.

- [ ] **Step 2: Jalankan (butuh Postgres terisolasi)**

```sh
DATABASE_URL='postgresql://sage:sage@localhost:5432/sage_hist01_fresh' npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma
SAGE_HISTORY_TESTS=1 DATABASE_URL='postgresql://sage:sage@localhost:5432/sage_hist01_fresh' npx tsx --test tests/history.integration.ts
```
Expected: PASS. Tanpa `SAGE_HISTORY_TESTS=1` → satu test skip, tetap PASS ketika `npm test` melalui `npm test` list.

- [ ] **Step 3: Registrasi script** di `package.json` root:

```json
"test:history:integration": "tsx --test tests/history.integration.ts"
```

- [ ] **Step 4: Commit**

```sh
git add tests/history.integration.ts package.json
git commit -m "test(hist01): integrasi riwayat pada PostgreSQL terisolasi"
```

---

### Task 5: Util format UI + halaman list

**Files:**
- Create: `apps/web/components/history/format.ts`
- Create: `apps/web/components/history/history-client.tsx`
- Create: `apps/web/app/workspace/history/page.tsx`
- Modify: `apps/web/components/design-system/ui.tsx` (baris 29, branch non-preview)
- Test: `tests/history-ui.test.ts`

**Interfaces:**
- Consumes: `data.analyses` / `data.nextCursor` (Task 2 `presentHistoryList`), `DesignFrame`/`Panel`/`Badge`/`AssetIcon` (design-system), CSS module `sprint-ui/preview-client.module.css`.
- Produces: halaman `/workspace/history`, util `statusLabel`, `statusTone`, `formatDateTime` (Task 6).
  - `statusLabel(status: string): string | null` (mapping: QUEUED→"Menunggu", RUNNING→"Berjalan", COMPLETED→"Selesai", COMPLETED_WITH_LIMITATIONS→"Selesai dengan batasan", FAILED→"Gagal")
  - `statusTone(status: string): "info" | "success" | "warning" | "error" | null`
  - `formatDateTime(value: string | Date | null | undefined): string` (— untuk null/invalid; `id-ID`, medium, `Asia/Jakarta`)

- [ ] **Step 1: Tulis test gagal** — `tests/history-ui.test.ts`

```ts
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
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx tsx --test tests/history-ui.test.ts`
Expected: FAIL — modul `components/history/format.ts` belum ada.

- [ ] **Step 3: Implementasi util** — `apps/web/components/history/format.ts`

```ts
export type AnalysisStatusView = "QUEUED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_LIMITATIONS" | "FAILED";
export type StatusTone = "info" | "success" | "warning" | "error";

const LABELS: Record<AnalysisStatusView, string> = {
  QUEUED: "Menunggu",
  RUNNING: "Berjalan",
  COMPLETED: "Selesai",
  COMPLETED_WITH_LIMITATIONS: "Selesai dengan batasan",
  FAILED: "Gagal",
};
const TONES: Record<AnalysisStatusView, StatusTone> = {
  QUEUED: "info", RUNNING: "info", COMPLETED: "success",
  COMPLETED_WITH_LIMITATIONS: "warning", FAILED: "error",
};

export function statusLabel(status: string): string | null {
  return (LABELS as Record<string, string>)[status] ?? null;
}
export function statusTone(status: string): StatusTone | null {
  return (TONES as Record<string, StatusTone>)[status] ?? null;
}

const formatter = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatter.format(date);
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx tsx --test tests/history-ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Implementasi client list** — `apps/web/components/history/history-client.tsx`

```tsx
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AssetIcon, Badge, DesignFrame, Panel } from "../design-system/ui.tsx";
import { formatDateTime, statusLabel, statusTone } from "./format.ts";
import styles from "../sprint-ui/preview-client.module.css";

type HistoryItem = {
  id: string;
  repository: { fullName: string };
  branch: string;
  commitSha: string;
  status: string;
  errorCode: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  retryOfAnalysisId: string | null;
};

const STATUS_OPTIONS = ["QUEUED", "RUNNING", "COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED"] as const;

export function HistoryClient({ accountKey }: { accountKey: string }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const queryRef = useRef(query);
  const statusRef = useRef(status);
  queryRef.current = query;
  statusRef.current = status;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const params = new URLSearchParams();
      const search = query.trim();
      if (search) params.set("query", search);
      if (status) params.set("status", status);
      try {
        const response = await fetch(`/api/analyses${params.size ? `?${params.toString()}` : ""}`, {
          headers: { "X-SAGE-Account": accountKey }, cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) { setError(true); return; }
        const body = await response.json() as { data: { analyses: HistoryItem[]; nextCursor: string | null } };
        setError(false);
        setItems(body.data.analyses);
        setNextCursor(body.data.nextCursor);
      } catch (caught) {
        if ((caught as Error).name !== "AbortError") setError(true);
      } finally {
        setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, [query, status, accountKey, reloadKey]);

  async function loadMore() {
    const cursor = nextCursor;
    if (!cursor) return;
    setNextCursor(null);
    try {
      const params = new URLSearchParams();
      if (queryRef.current.trim()) params.set("query", queryRef.current.trim());
      if (statusRef.current) params.set("status", statusRef.current);
      params.set("cursor", cursor);
      const response = await fetch(`/api/analyses?${params.toString()}`, {
        headers: { "X-SAGE-Account": accountKey }, cache: "no-store",
      });
      if (!response.ok) { setError(true); return; }
      const body = await response.json() as { data: { analyses: HistoryItem[]; nextCursor: string | null } };
      setItems(previous => [...(previous ?? []), ...body.data.analyses]);
      setNextCursor(body.data.nextCursor);
    } catch {
      setError(true);
    }
  }

  const trimmed = query.trim();
  return <DesignFrame active="history">
    <div className={styles.breadcrumb}>Workspace <span>/</span> Riwayat</div>
    <div className={styles.pageHeading}>
      <p className={styles.eyebrow}>02 / RIWAYAT</p>
      <h1>Riwayat analisis</h1>
      <p className={styles.muted}>Daftar analisis milik akun yang masuk, dengan status terbarui.</p>
    </div>
    <Panel title="Filter" className={styles.historyPanel}>
      <label className={styles.searchField}>Cari repository, branch, atau SHA
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Contoh: report-service" />
      </label>
      <label className={styles.searchField}>Status
        <select value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">Semua</option>
          <option value={STATUS_OPTIONS[0]}>{statusLabel(STATUS_OPTIONS[0]) ?? STATUS_OPTIONS[0]}</option>
          <option value={STATUS_OPTIONS[1]}>{statusLabel(STATUS_OPTIONS[1]) ?? STATUS_OPTIONS[1]}</option>
          <option value={STATUS_OPTIONS[2]}>{statusLabel(STATUS_OPTIONS[2]) ?? STATUS_OPTIONS[2]}</option>
          <option value={STATUS_OPTIONS[3]}>{statusLabel(STATUS_OPTIONS[3]) ?? STATUS_OPTIONS[3]}</option>
          <option value={STATUS_OPTIONS[4]}>{statusLabel(STATUS_OPTIONS[4]) ?? STATUS_OPTIONS[4]}</option>
        </select>
      </label>
      {(trimmed || status) ? (
        <button type="button" className={styles.textAction} onClick={() => { setQuery(""); setStatus(""); }}>Hapus filter</button>
      ) : null}
    </Panel>
    <Panel title="Daftar" className={styles.historyPanel}>
      {!loaded ? <div className={styles.loadingRows} role="status" aria-label="Memuat riwayat">{[0, 1].map(index => <div key={index}><span /><span /><span /></div>)}</div> : null}
      {error && !items ? <div className={styles.historyMessage} role="alert">
        <AssetIcon group="history-error" name="imgIcon2" />
        <div><strong>Riwayat gagal dimuat</strong><p>Periksa koneksi lalu muat ulang halaman.</p></div>
        <button type="button" className={styles.textAction} onClick={() => setReloadKey(key => key + 1)}>Coba lagi</button>
      </div> : null}
      {loaded && !error && items?.length === 0 && !trimmed && !status ? <div className={styles.historyMessage}>
        <AssetIcon group="history-empty" name="imgIcon1" />
        <div><strong>Belum ada analisis</strong><p>Pilih repository untuk memulai analisis pertama.</p></div>
        <Link className={styles.secondaryAction} href="/workspace/repositories">Pilih repository</Link>
      </div> : null}
      {loaded && !error && items?.length === 0 && (trimmed || status) ? <div className={styles.historyMessage}>
        <AssetIcon group="history-empty" name="imgIcon" />
        <div><strong>Tidak ada hasil untuk {trimmed ? `“${trimmed}”` : "filter ini"}</strong><p>Pencarian memeriksa repository, branch, dan SHA.</p></div>
        <button type="button" className={styles.textAction} onClick={() => { setQuery(""); setStatus(""); }}>Hapus filter</button>
      </div> : null}
      {loaded && !error && items && items.length > 0 ? <>
        <div className={styles.historyColumns} aria-hidden="true"><span>Repository dan commit</span><span>Branch</span><span>Status</span><span>Aksi</span></div>
        {items.map(item => (
          <div className={styles.historyRow} key={item.id}>
            <div><strong>{item.repository.fullName}</strong><span className={styles.shaShort}>{item.commitSha.slice(0, 7)}</span><small>Diantrekan {formatDateTime(item.queuedAt)}{item.completedAt ? ` · Selesai ${formatDateTime(item.completedAt)}` : ""}</small></div>
            <code>{item.branch || "—"}</code>
            <Badge tone={statusTone(item.status) ?? "neutral"}>{statusLabel(item.status) ?? item.status}</Badge>
            <Link href={`/analyses/${item.id}`}>Buka</Link>
          </div>
        ))}
        {nextCursor ? <button type="button" className={styles.textAction} onClick={() => void loadMore()}>Muat lebih banyak</button> : null}
      </> : null}
    </Panel>
    <p className={styles.historyFootnote}>Status diperbarui saat halaman dimuat; halaman detail analisis melakukan pembaruan otomatis.</p>
  </DesignFrame>;
}
```

- [ ] **Step 6: Implementasi halaman server** — `apps/web/app/workspace/history/page.tsx`

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readWorkspaceContext } from "../../../lib/auth/server-session.ts";
import { HistoryClient } from "../../../components/history/history-client.tsx";

export const metadata: Metadata = {
  title: "Riwayat — SAGE",
  robots: { index: false, follow: false },
};

export default async function HistoryPage() {
  const context = await readWorkspaceContext().catch(() => null);
  if (!context) redirect("/login?error=session");
  return <HistoryClient accountKey={context.accountKey} />;
}
```

- [ ] **Step 7: Nav** — `apps/web/components/design-system/ui.tsx` baris 29 (branch non-preview) ganti:

```tsx
<Link href={`${prefix}/history`} aria-current={active === "history" ? "page" : undefined}>Riwayat</Link>
```

Branch preview (baris 24) tetap `/preview/history` — jangan disentuh.

- [ ] **Step 8: Verifikasi**

Run: `npx tsx --test tests/history-ui.test.ts && npm run typecheck && npm run lint`
Expected: PASS. Smoke manual (opsional, `npm run dev`): `/workspace/history` menampilkan empty state saat belum ada analisis; dengan record test di DB menampilkan daftar nyata.

- [ ] **Step 9: Commit**

```sh
git add apps/web/components/history apps/web/app/workspace/history apps/web/components/design-system/ui.tsx tests/history-ui.test.ts
git commit -m "feat(hist01): halaman riwayat produk dengan search/filter"
```

---

### Task 6: Halaman detail + polling

**Files:**
- Create: `apps/web/components/history/detail-client.tsx`
- Create: `apps/web/app/analyses/[analysisId]/page.tsx`

**Interfaces:**
- Consumes: endpoint `GET /api/analyses/{analysisId}` (Task 3), `presentAnalysisDetail` (Task 2), `formatDateTime`/`statusLabel`/`statusTone` (Task 5).
- Produces: route produk `/analyses/{id}` — target link "Buka" list (Task 5) & acceptance "queued/running/failed ke progress".
  - `AnalysisDetailClient({ analysisId, accountKey, initial, reason }: { analysisId: string; accountKey: string; initial: DetailView | null; reason: "not-found" | null })`

- [ ] **Step 1: Implementasi** `apps/web/components/history/detail-client.tsx`

```tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AssetIcon, Badge, DesignFrame, Panel } from "../design-system/ui.tsx";
import { formatDateTime, statusLabel, statusTone } from "./format.ts";
import type { AnalysisDetailView } from "../../lib/analyses/presenters.ts";
import styles from "../sprint-ui/preview-client.module.css";

/** Bentuk payload server (presenters.ts) — di-derive, tidak ditulis manual. */
export type DetailView = AnalysisDetailView;
export type StageView = DetailView["stages"][number];

const NON_TERMINAL = ["QUEUED", "RUNNING"] as const;
function isTerminal(status: string) {
  return !(NON_TERMINAL as readonly string[]).includes(status);
}

export function AnalysisDetailClient({ analysisId, accountKey, initial, reason }: {
  analysisId: string; accountKey: string; initial: DetailView | null; reason: "not-found" | null;
}) {
  const [detail, setDetail] = useState<DetailView | null>(initial);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    if (reason === "not-found" || !detail || isTerminal(detail.status)) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/analyses/${analysisId}`, { headers: { "X-SAGE-Account": accountKey }, cache: "no-store" });
          if (!response.ok) { setFetchError(true); return; }
          const body = await response.json() as { data: DetailView };
          setFetchError(false);
          setDetail(previous => previous && body.data.stateVersion < previous.stateVersion ? previous : body.data);
        } catch { setFetchError(true); }
      })();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [detail, reason, analysisId, accountKey]);

  if (reason === "not-found") return <DesignFrame>
    <div className={styles.breadcrumb}>Workspace <span>/</span> <Link href="/workspace/history">Riwayat</Link></div>
    <div className={styles.historyMessage} role="alert">
      <AssetIcon group="history-error" name="imgIcon2" />
      <div><strong>Analisis tidak ditemukan</strong><p>Record ini bukan milik akun yang masuk, atau sudah dihapus.</p></div>
      <Link className={styles.secondaryAction} href="/workspace/history">Kembali ke riwayat</Link>
    </div>
  </DesignFrame>;
  if (!detail) return <DesignFrame>
    <div className={styles.historyMessage} role="status"><AssetIcon group="history-empty" name="imgIcon1" /><div><strong>Memuat detail analisis</strong><p>Tunggu sesaat.</p></div></div>
  </DesignFrame>;
  return <DesignFrame>
    <div className={styles.breadcrumb}>Workspace <span>/</span> <Link href="/workspace/history">Riwayat</Link> <span>/</span> Progres analisis</div>
    <div className={styles.pageHeading}>
      <p className={styles.eyebrow}>03 / PROGRES</p>
      <h1>{detail.context.repositoryFullName}</h1>
      <p className={styles.muted}>Branch {detail.context.branchName} · commit {detail.context.commitSha}</p>
    </div>
    <Panel title="Ringkasan" className={styles.historyPanel}>
      <div className={styles.historyRow}>
        <div><strong>Status</strong><small>Diantrekan {formatDateTime(detail.timestamps.queuedAt)}{detail.timestamps.completedAt ? ` · Selesai ${formatDateTime(detail.timestamps.completedAt)}` : ""}</small></div>
        <Badge tone={statusTone(detail.status) ?? "neutral"}>{statusLabel(detail.status) ?? detail.status}</Badge>
        <span aria-hidden="true" />
      </div>
      {detail.errorCode ? <div className={styles.historyMessage} role="alert">
        <AssetIcon group="history-error" name="imgIcon2" />
        <div><strong>Analisis gagal</strong><p><code>{detail.errorCode}</code> — tahap berikutnya tetap menunggu. Buat analisis baru dari target yang sama untuk mengulang.</p></div>
      </div> : null}
      {detail.limitations.length > 0 ? <div className={styles.historyMessage} role="note">
        <AssetIcon group="progress-complete" name="imgIcon2" />
        <div><strong>Batasan</strong>{detail.limitations.map((limitation, index) => (
          <p key={index}><code>{limitation.stageKey}</code> {limitation.code}: {limitation.safeExplanation}</p>
        ))}</div>
      </div> : null}
      {!isTerminal(detail.status) ? <p className={styles.historyFootnote} role="status">Halaman diperbarui otomatis setiap 3 detik sampai analisis selesai.</p> : null}
      {fetchError ? <p className={styles.historyFootnote} role="status">Pembaruan otomatis gagal sementara; mencoba lagi pada interval berikutnya.</p> : null}
    </Panel>
    <Panel title="Sembilan tahap" className={styles.historyPanel}>
      <ol>
        {detail.stages.map(stage => (
          <li key={stage.key} className={styles.historyRow}>
            <div><strong>{stage.sequence}. {stage.label}</strong><small>{stage.startedAt ? `Mulai ${formatDateTime(stage.startedAt)}` : ""}{stage.finishedAt ? ` · Selesai ${formatDateTime(stage.finishedAt)}` : ""}{stage.errorCode ? " · " + stage.errorCode : ""}</small></div>
            <Badge tone={statusTone(stage.status) ?? "neutral"}>{statusLabel(stage.status) ?? stage.status}</Badge>
            <span aria-hidden="true" />
          </li>
        ))}
      </ol>
    </Panel>
    {detail.results ? <Panel title="Hasil" className={styles.historyPanel}>
      <Link className={styles.primaryAction} href={detail.results.graphUrl}>Buka knowledge graph</Link>
      <Link className={styles.secondaryAction} href={detail.results.documentUrl}>Buka dokumentasi</Link>
      <p className={styles.historyFootnote}>Halaman hasil dibangun paket graph/dokumen (GRAPH-01/DOC-01); tautan sudah canonical.</p>
    </Panel> : null}
  </DesignFrame>;
}
```

- [ ] **Step 2: Implementasi halaman** — `apps/web/app/analyses/[analysisId]/page.tsx`

```tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { database, getAnalysisDetailForUser, resolveSession } from "@sage/database";
import { presentAnalysisDetail } from "../../../lib/analyses/presenters.ts";
import { getUniqueCookie, isValidOpaqueToken, SESSION_COOKIE } from "../../../lib/auth/handlers.ts";
import { AnalysisDetailClient } from "../../../components/history/detail-client.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Progres analisis — SAGE",
  robots: { index: false, follow: false },
};

const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export default async function AnalysisDetailPage({ params }: { params: Promise<{ analysisId: string }> }) {
  const raw = (await params).analysisId;
  if (!ANALYSIS_ID_PATTERN.test(raw)) {
    return <AnalysisDetailClient analysisId="" accountKey="" initial={null} reason="not-found" />;
  }
  const requestHeaders = await headers();
  const token = getUniqueCookie(requestHeaders.get("cookie"), SESSION_COOKIE);
  if (!token || !isValidOpaqueToken(token)) redirect("/login?error=session");
  const session = await resolveSession(database(), token, new Date());
  if (!session) redirect("/login?error=session");
  const detail = await getAnalysisDetailForUser(database(), session.userId, raw);
  return <AnalysisDetailClient
    analysisId={raw}
    accountKey={session.userId}
    initial={detail ? presentAnalysisDetail(detail) as never : null}
    reason={detail ? null : "not-found"}
  />;
}
```

> **Catatan:** `accountKey` untuk header `X-SAGE-Account` harus `githubUserId`. `resolveSession` hanya mengembalikan `userId`. Tambahkan fetch `githubUserId` pada page:

```tsx
const db = database();
const session = await resolveSession(db, token, new Date());
if (!session) redirect("/login?error=session");
const user = await db.user.findUnique({ where: { id: session.userId }, select: { githubUserId: true } });
if (!user) redirect("/login?error=session");
const detail = await getAnalysisDetailForUser(db, session.userId, raw);
return <AnalysisDetailClient
  analysisId={raw}
  accountKey={user.githubUserId}
  initial={detail ? presentAnalysisDetail(detail) as never : null}
  reason={detail ? null : "not-found"}
/>;
```

Jadikan versi ini final (ganti blok pasca `if (!token …)` sebelumnya dengan blok ini — deklarasikan `const db = database();` sekali dan gunakan ulang).

- [ ] **Step 3: Verifikasi**

Run: `npm run typecheck && npm run lint && npx tsx --test tests/history-ui.test.ts tests/history-handlers.test.ts tests/history.test.ts`
Expected: PASS.
Smoke manual (dev server + record test): klik "Buka" dari riwayat → detail menampilkan 9 tahap; record FAILED menampilkan errorCode; record COMPLETED (via `psql` pada DB uji lokal: `UPDATE "Analysis" SET status='COMPLETED', "completedAt"=now() WHERE id='…'`) menampilkan panel Hasil dengan tautan canonical; record dengan `analysisStage` PENDING/RUNNING menampilkan badge sesuai.

- [ ] **Step 4: Commit**

```sh
git add apps/web/components/history/detail-client.tsx apps/web/app/analyses
git commit -m "feat(hist01): halaman detail analisis dengan polling"
```

---

### Task 7: Registrasi test + HTTP script

**Files:**
- Modify: `package.json` root (`test` script + satu script baru)
- Create: `scripts/test-history-http.ts`

**Interfaces:**
- Consumes: endpoint Task 3; pattern `scripts/test-target-http.ts` untuk laporan & kredensial sesi.
- Produces: `npm test` mencakup tiga suite baru; `npm run test:history:http`; `test:history:integration` sudah dari Task 4.

- [ ] **Step 1: Implementasi** `scripts/test-history-http.ts`

```ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { database, createSession } from "@sage/database";
const db = database();
let sessionId: string | undefined;
try {
  const user = await db.user.findFirst({ where: { login: process.env.SAGE_TEST_LOGIN ?? "" }, select: { id: true, githubUserId: true } });
  assert.ok(user);
  const session = await createSession(db, user.id, { ttlMs: 120_000 });
  sessionId = session.session.sessionId;
  const cookie = `sage_session=${session.token}`;
  const base = new URL(process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000");
  const call = (path: string, withCookie = true) => fetch(new URL(path, base), {
    redirect: "error",
    headers: withCookie ? { Cookie: cookie, "X-SAGE-Account": user.githubUserId } : {},
  });
  const checks: string[] = [];
  const list = await call("/api/analyses");
  assert.equal(list.status, 200);
  const listBody = (await list.json()).data as { analyses: { id: string }[]; nextCursor: string | null };
  assert.ok(Array.isArray(listBody.analyses));
  checks.push("history list returns owner-scoped analyses through HTTP");
  assert.equal((await call("/api/analyses", false)).status, 401);
  checks.push("history requires a session");
  assert.equal((await call("/api/analyses?status=FAILED")).status, 200);
  checks.push("enum status filter accepted");
  const search = await call(`/api/analyses?query=${encodeURIComponent("acme")}`);
  assert.equal(search.status, 200);
  checks.push("query filter accepted (matches only owned matching records when non-empty)");
  const detailId = listBody.analyses[0]?.id;
  if (detailId) {
    const detail = await call(`/api/analyses/${detailId}`);
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()).data as { stages: unknown[]; stateVersion: number };
    assert.equal(detailBody.stages.length, 9);
    assert.equal(typeof detailBody.stateVersion, "number");
    checks.push("detail returns nine stages with monotonic stateVersion");
  }
  await mkdir("artifacts/hist-01", { recursive: true });
  const report = {
    checkedAt: new Date().toISOString(),
    checks,
    analysisCount: await db.analysis.count({ where: { ownerUserId: user.id } }),
    limitations: [
      "Graph/document target pages belong to GRAPH-01/DOC-01; links remain canonical.",
      "Temporary server-seeded session; no credentials printed.",
    ],
  };
  await writeFile("artifacts/hist-01/http-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} catch {
  console.error("History HTTP verification failed; no user data printed.");
  process.exitCode = 1;
} finally {
  if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
  await db.$disconnect();
}
```

- [ ] **Step 2: Update `package.json`**

Pada `test` script tambahkan `tests/history.test.ts tests/history-handlers.test.ts tests/history-ui.test.ts` setelah `tests/repository-target.test.ts`.

Tambahan satu script:

```json
"test:history:http": "tsx scripts/test-history-http.ts"
```

- [ ] **Step 3: Verifikasi**

Run: `npm run check`
Expected: PASS — lint, typecheck, seluruh suite unit (termasuk tiga suite baru) dan suite database lulus.

- [ ] **Step 4: Commit**

```sh
git add package.json scripts/test-history-http.ts
git commit -m "test(hist01): registrasi suite riwayat dan skrip http verifikasi"
```

---

### Task 8: Dokumentasi kontrak terdampak

**Files:**
- Modify: `docs/API_CONTRACT.md` (bagian "Analysis dan progress")
- Modify: `docs/ARCHITECTURE.md` (kalimat status baris 3)
- Modify: `docs/DATA_MODEL.md` (baris 64 dan 98)
- Modify: `README.md` (tabel rute bagian "Buka aplikasi di browser")

- [ ] **Step 1: `docs/API_CONTRACT.md`** — pada tabel bagian "Analysis dan progress" tandai kedua GET sebagai tersedia, plus paragraf penjelasan cursor/tautan canonical:

```md
| GET | `/analyses` | **Tersedia (HIST-01)**: history milik user; filter `query`, `status`, dan cursor keyset 20 per halaman |
| GET | `/analyses/{analysisId}` | **Tersedia (HIST-01)**: context, full SHA, status, sembilan stage, limitations, serta link hasil jika tersedia |
```

Paragraf baru setelah tabel (sebelum `Header Idempotency-Key` kalimat existing di bagian atas—itu konteks `/api/analyses` POST; letakkan di bagian "Analysis dan progress"):

```md
`GET /analyses` paginasi memakai cursor keyset `(createdAt DESC, id DESC)` membatasi 20 record; `nextCursor: null` berarti habis. Tautan graph/dokumen pada detail hanya muncul untuk status `COMPLETED`/`COMPLETED_WITH_LIMITATIONS` dan berformat canonical `/analyses/{analysisId}/graph` dan `/analyses/{analysisId}/document`; halaman tujuannya mengikuti paket GRAPH-01 dan DOC-01.
```

- [ ] **Step 2: `docs/ARCHITECTURE.md`** baris 3 — ganti kalimat history pada paragraf status:

```md
History produk membaca record analisis nyata melalui list/detail GET (HIST-01); graph/dokumen produk, ekspor, dan penghapusan masih mengikuti issue terbuka.
```

- [ ] **Step 3: `docs/DATA_MODEL.md`**:

- Baris 64 kalimat `Endpoint hasil untuk history, graph, dokumen, export, dan delete tetap mengikuti issue produknya.` →

```md
History membaca melalui `listAnalysesForUser` dan `getAnalysisDetailForUser` yang mengikuti konvensi `find*ForUser` (predicate `ownerUserId`); endpoint graph, dokumen, export, dan delete tetap mengikuti issue produknya.
```

- Baris 98 kalimat `Graph produk #17–19, ekspor #20–21, dan history #22 tetap terbuka.` →

```md
History #22 menyediakan pembacaan list/detail GET (HIST-01); graph produk #17–19 dan ekspor #20–21 tetap terbuka.
```

- [ ] **Step 4: `README.md`** — tabel halaman bagian "Buka aplikasi di browser", tambahkan baris (baris pratinjau dipertahankan karena QA-03 masih memerlukan fixture):

```md
| Riwayat analisis (nyata) | [http://localhost:3000/workspace/history](http://localhost:3000/workspace/history) |
```

- [ ] **Step 5: Verifikasi**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add docs/API_CONTRACT.md docs/ARCHITECTURE.md docs/DATA_MODEL.md README.md
git commit -m "docs(hist01): status riwayat tercantum pada kontrak dan arsitektur"
```

---

## Self-review (hasil pemeriksaan plan)

1. **Cakupan spec:** endpoint list (Task 1–3), endpoint detail (Task 1–3, 6), search nama/SHA/branch (Task 1 `where.OR`), filter status (Task 1 + Task 5 UI), cursor keyset (Task 1 + Task 4 test), state loading/empty/no-match/error (Task 5), navigasi status-based (Task 5 link + Task 6 halaman tujuan), polling detail (Task 6), format tanggal (Task 5), owner guard + 404 lintas user (Task 1 predicate, Task 2 handler, Task 4 test), registrasi test (Task 7), dokumentasi (Task 8). Limitasi yang dicatat di PR: halaman tujuan graph/dokumen mengikuti GRAPH-01/DOC-01; retry/delete di luar scope.
2. **Placeholder scan:** tidak ada "TBD"/"TODO"; task 4 memiliki satu catatan executor tentang cleanup repository — gunakan `repositoryId` module-level dari setup untuk `deleteMany` yang akurat.
3. **Konsistensi tipe:** `presentHistoryList` kolom dipakai identik oleh `HistoryClient` (Task 5); `presentAnalysisDetail` identik dengan `DetailView`/`StageView` (Task 6); satu encoder/decoder cursor di `packages/database/src/history.ts`; kunci stage diduplikasi di database + contracts dengan komentar sinkronisasi di kedua sisi.
