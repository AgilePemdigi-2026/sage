import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerRuntime, waitForWorker, WorkerRuntimeFailure, type WorkerRuntimeEvent } from "../apps/worker/src/runtime.ts";

function harness() {
  const controller = new AbortController();
  const events: WorkerRuntimeEvent[] = [];
  const waits: number[] = [];
  return { controller, events, waits,
    options: { parentSignal: controller.signal, emit: (event: WorkerRuntimeEvent) => events.push(event), wait: async (ms: number, signal: AbortSignal) => {
      if ([500, 1_500, 3_000].includes(ms)) { waits.push(ms); return; }
      await waitForWorker(60_000, signal);
    } },
  };
}

test("startup heartbeat recovers before any consumer can acquire work", async () => {
  const h = harness(); let heartbeats = 0; let claims = 0;
  await runWorkerRuntime({ ...h.options, heartbeat: async () => { if (++heartbeats < 3) throw { code: "P1001", message: "SECRET" }; }, consumers: [
    { queue: "analysis", idleMs: 1_000, claim: async () => { claims++; assert.equal(heartbeats, 3); h.controller.abort(); return null; } },
  ] });
  assert.equal(claims, 1); assert.deepEqual(h.waits, [500, 1_500]);
  assert.deepEqual(h.events.map(event => [event.event, event.phase]), [["worker_retry", "startup"], ["worker_retry", "startup"], ["worker_recovered", "startup"]]);
  assert.doesNotMatch(JSON.stringify(h.events), /SECRET/);
});

test("persistent outage exhausts a fixed budget and never starts consumers", async () => {
  const h = harness(); let attempts = 0; let claims = 0;
  await assert.rejects(runWorkerRuntime({ ...h.options, heartbeat: async () => { attempts++; throw { code: "ECONNREFUSED" }; }, consumers: [
    { queue: "export", idleMs: 1_000, claim: async () => { claims++; return null; } },
  ] }), WorkerRuntimeFailure);
  assert.equal(attempts, 4); assert.equal(claims, 0); assert.deepEqual(h.waits, [500, 1_500, 3_000]);
  assert.equal(h.events.at(-1)?.phase, "startup"); assert.equal(h.events.at(-1)?.event, "worker_failed");
});

test("confirmed rollback retries acquisition, then executes the handler once", async () => {
  const h = harness(); let claims = 0; let handled = 0;
  await runWorkerRuntime({ ...h.options, heartbeat: async () => {}, consumers: [
    { queue: "export", idleMs: 1_000, claim: async () => { if (++claims === 1) throw { code: "P2034" }; return async () => { handled++; h.controller.abort(); }; } },
  ] });
  assert.equal(claims, 2); assert.equal(handled, 1); assert.deepEqual(h.waits, [500]);
  assert.equal(h.events.at(-1)?.queue, "export"); assert.equal(h.events.at(-1)?.event, "worker_recovered");
});

test("ambiguous claim transport loss stops rather than replaying an acquisition", async () => {
  const h = harness(); let claims = 0;
  await assert.rejects(runWorkerRuntime({ ...h.options, heartbeat: async () => {}, consumers: [
    { queue: "cleanup", idleMs: 2_000, claim: async () => { claims++; throw { code: "ECONNRESET", message: "SECRET postgres://token" }; } },
  ] }), WorkerRuntimeFailure);
  assert.equal(claims, 1); assert.deepEqual(h.waits, []);
  assert.equal(h.events.at(-1)?.phase, "claim"); assert.equal(h.events.at(-1)?.queue, "cleanup");
  assert.doesNotMatch(JSON.stringify(h.events), /SECRET|postgres|token/);
});

test("a handler failure is not retried even when its error code permits claim retry", async () => {
  const h = harness(); let calls = 0;
  await assert.rejects(runWorkerRuntime({ ...h.options, heartbeat: async () => {}, consumers: [
    { queue: "analysis", idleMs: 1_000, claim: async () => async () => { calls++; throw { code: "P2034" }; } },
  ] }), WorkerRuntimeFailure);
  assert.equal(calls, 1); assert.deepEqual(h.waits, []); assert.equal(h.events.at(-1)?.phase, "handler");
});

test("fatal sibling failure aborts in-flight work and waits for it to drain", async () => {
  const h = harness(); let started!: () => void; let drained = false;
  const running = new Promise<void>(resolve => { started = resolve; });
  await assert.rejects(runWorkerRuntime({ ...h.options, heartbeat: async () => {}, consumers: [
    { queue: "analysis", idleMs: 1_000, claim: async () => async signal => {
      started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { drained = true; resolve(); }, { once: true }));
    } },
    { queue: "export", idleMs: 1_000, claim: async () => { await running; throw new Error("private integrity failure"); } },
  ] }), WorkerRuntimeFailure);
  assert.equal(drained, true);
  assert.equal(h.events.filter(event => event.event === "worker_failed").length, 1);
});

test("shutdown during backoff cancels promptly and does not retry again", { timeout: 1_000 }, async () => {
  const controller = new AbortController(); let attempts = 0;
  await runWorkerRuntime({ parentSignal: controller.signal, emit: () => controller.abort(), heartbeat: async () => { attempts++; throw { code: "P1001" }; }, consumers: [] });
  assert.equal(attempts, 1);
});

test("a claim returning after shutdown is left for lease recovery, never handled", async () => {
  const h = harness(); let handled = false;
  await runWorkerRuntime({ ...h.options, heartbeat: async () => {}, consumers: [
    { queue: "analysis", idleMs: 1_000, claim: async () => { h.controller.abort(); return async () => { handled = true; }; } },
  ] });
  assert.equal(handled, false); assert.deepEqual(h.events, []);
});

test("idle polling yields between attempts and remains abortable", async () => {
  const controller = new AbortController(); let calls = 0; let waited = false;
  await runWorkerRuntime({ parentSignal: controller.signal, emit: () => {}, heartbeat: async () => {},
    wait: async (ms, signal) => { if (ms === 1_000) { waited = true; controller.abort(); } else await waitForWorker(ms, signal); },
    consumers: [{ queue: "analysis", idleMs: 1_000, claim: async () => { calls++; return null; } }],
  });
  assert.equal(calls, 1); assert.equal(waited, true);
});
