import { test } from "node:test";
import assert from "node:assert/strict";

import type { JobRecord, JobRecordPatch } from "./job-store.ts";
import { MemoryJobStore } from "./job-store.ts";

function record(id: string): JobRecord {
  const now = new Date().toISOString();
  return {
    job_id: id,
    kind: "quote",
    vendor: "sendcutsend",
    state: "QUEUED",
    intent_hash: "deadbeef",
    created_at: now,
    updated_at: now,
    quote: null,
    live_url: null,
    evidence: null,
  };
}

test("MemoryJobStore: create + get roundtrip, get returns a copy", async () => {
  const store = new MemoryJobStore(new Map());
  await store.create(record("j1"));

  const got = await store.get("j1");
  assert.ok(got);
  assert.equal(got!.state, "QUEUED");

  got!.state = "PLACING"; // mutating the copy must not touch the store
  const again = await store.get("j1");
  assert.equal(again!.state, "QUEUED");
});

test("MemoryJobStore: get unknown id returns null; update unknown id throws", async () => {
  const store = new MemoryJobStore(new Map());
  assert.equal(await store.get("nope"), null);
  await assert.rejects(store.update("nope", { state: "FAILED" }), /unknown job/);
});

test("MemoryJobStore: create refuses to reuse a job id", async () => {
  const store = new MemoryJobStore(new Map());
  await store.create(record("j1"));
  await assert.rejects(store.create(record("j1")), /never reused/);
});

test("MemoryJobStore: legal transitions pass, illegal transitions throw", async () => {
  const store = new MemoryJobStore(new Map());
  await store.create(record("j1"));

  await store.update("j1", { state: "SESSION_OPEN" });
  assert.equal((await store.get("j1"))!.state, "SESSION_OPEN");

  // SESSION_OPEN -> PLACING is not a legal move; the guard is assertTransition.
  await assert.rejects(
    store.update("j1", { state: "PLACING" }),
    /illegal job transition SESSION_OPEN -> PLACING/,
  );
  // The failed update must not have moved the record.
  assert.equal((await store.get("j1"))!.state, "SESSION_OPEN");
});

test("MemoryJobStore: the quote-job walk QUEUED→…→DELIVERED is legal", async () => {
  const store = new MemoryJobStore(new Map());
  await store.create(record("j1"));

  for (const state of ["SESSION_OPEN", "STAGING", "STAGED", "DELIVERED"] as const) {
    await store.update("j1", { state });
  }
  const rec = await store.get("j1");
  assert.equal(rec!.state, "DELIVERED");
});

test("MemoryJobStore: STAGED → DELIVERED is quote-only — order jobs are refused", async () => {
  const store = new MemoryJobStore(new Map());
  await store.create({ ...record("j-order"), kind: "order" });

  for (const state of ["SESSION_OPEN", "STAGING", "STAGED"] as const) {
    await store.update("j-order", { state });
  }
  // The shared table lists the edge, but the store's kind-aware guard
  // keeps DELIVERED-implies-confirmed intact for the order machinery.
  await assert.rejects(
    store.update("j-order", { state: "DELIVERED" }),
    /STAGED -> DELIVERED for kind "order"/,
  );
  assert.equal((await store.get("j-order"))!.state, "STAGED");

  // DELIVERED via the two-oracle path is still legal for orders.
  for (const state of ["AUDIT", "PLACING", "CONFIRMING", "CONFIRMED", "TRACKING", "DELIVERED"] as const) {
    await store.update("j-order", { state });
  }
  assert.equal((await store.get("j-order"))!.state, "DELIVERED");
});

test("MemoryJobStore: same-state patch attaches data without consulting the table", async () => {
  const store = new MemoryJobStore(new Map());
  await store.create(record("j1"));

  // DELIVERED is terminal — but attaching data without changing state is fine.
  await store.update("j1", { live_url: "https://live.example/x" });
  await store.update("j1", { state: "QUEUED", error: "still queued" });

  const rec = await store.get("j1");
  assert.equal(rec!.live_url, "https://live.example/x");
  assert.equal(rec!.error, "still queued");
  assert.equal(rec!.state, "QUEUED");
});

test("MemoryJobStore: undefined patch entries never blank a field", async () => {
  const store = new MemoryJobStore(new Map());
  await store.create(record("j1"));
  await store.update("j1", { live_url: "https://live.example/x" });
  // exactOptionalPropertyTypes forbids this shape at compile time, but a JS
  // caller can still produce it — the store must treat it as "no change".
  const sparse: Record<string, unknown> = { state: "SESSION_OPEN", live_url: undefined };
  await store.update("j1", sparse as JobRecordPatch);

  const rec = await store.get("j1");
  assert.equal(rec!.live_url, "https://live.example/x");
});

test("MemoryJobStore: default construction shares one module-global table", async () => {
  const a = new MemoryJobStore();
  const b = new MemoryJobStore();
  const id = `shared-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await a.create(record(id));
  const seen = await b.get(id);
  assert.ok(seen, "a record created via one instance is visible via another");
  assert.equal(seen!.job_id, id);
});
