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

test("fatal sibling claim drains in-flight work without replaying the ambiguous claim", async () => {
  const h = harness(); let started!: () => void; let release!: () => void; let finished = false; let claims = 0;
  const running = new Promise<void>(resolve => { started = resolve; });
  const failed = new Promise<void>(resolve => { release = resolve; });
  await assert.rejects(runWorkerRuntime({ ...h.options, heartbeat: async () => {}, consumers: [
    { queue: "analysis", idleMs: 1_000, claim: async () => async signal => {
      started(); await failed; assert.equal(signal.aborted, false); finished = true;
    } },
    { queue: "export", idleMs: 1_000, claim: async () => { claims++; await running; throw { code: "P2028" }; } },
  ], emit: event => { h.events.push(event); if (event.event === "worker_failed") release(); } }), WorkerRuntimeFailure);
  assert.equal(finished, true); assert.equal(claims, 1);
  assert.equal(h.events.filter(event => event.event === "worker_failed").length, 1);
});

test("heartbeat transaction expiry retries safely while an analysis continues", async () => {
  const controller = new AbortController(); let heartbeats = 0; let handled = false;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  await runWorkerRuntime({ parentSignal: controller.signal, emit: () => {}, heartbeatIntervalMs: 1,
    heartbeat: async () => { if (++heartbeats === 2) throw { code: "P2028" }; if (heartbeats === 3) { handled = true; controller.abort(); } },
    wait: async (ms, signal) => { if (ms === 1) await running; else if (ms !== 500) await waitForWorker(ms, signal); },
    consumers: [{ queue: "analysis", idleMs: 1000, claim: async () => async signal => { started(); await waitForWorker(60_000, signal); } }],
  });
  assert.equal(heartbeats, 3); assert.equal(handled, true);
});

test("exhausted heartbeat retries drain an active handler before stopping", { timeout: 1_000 }, async () => {
  let heartbeatCalls = 0; let claimCalls = 0; let finished = false;
  let started!: () => void; let release!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const failed = new Promise<void>(resolve => { release = resolve; });
  await assert.rejects(runWorkerRuntime({
    parentSignal: new AbortController().signal,
    heartbeatIntervalMs: 1,
    heartbeat: async () => { if (++heartbeatCalls > 1) throw { code: "P2028" }; },
    wait: async (ms, signal) => { if (ms === 1) await running; else if (![500, 1_500, 3_000].includes(ms)) await waitForWorker(ms, signal); },
    emit: event => { if (event.event === "worker_failed") release(); },
    consumers: [{ queue: "analysis", idleMs: 1_000, claim: async () => { claimCalls++; return async signal => {
      started(); await failed; assert.equal(signal.aborted, false); finished = true;
    }; } }],
  }), WorkerRuntimeFailure);
  assert.equal(heartbeatCalls, 5); assert.equal(claimCalls, 1); assert.equal(finished, true);
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
