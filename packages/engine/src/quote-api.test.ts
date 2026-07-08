import { test } from "node:test";
import assert from "node:assert/strict";

import type { ConfiguratorIntent } from "@kerf/core";
import { FIXTURES_B64, getFixtureBytes, getVendor } from "@kerf/registry";
import type { QuoteApiDeps } from "./quote-api.ts";
import { handleQuoteRequest, HostUnavailableError } from "./quote-api.ts";
import { intentHash } from "./hash.ts";
import { MemoryJobStore } from "./job-store.ts";
import type { JobRecord } from "./job-store.ts";
import { ScriptedHost } from "./scripted-session.ts";

import canaryIntentJson from "../../registry/sendcutsend/fixtures/canary-intent.json" with { type: "json" };

const canaryIntent = canaryIntentJson as unknown as ConfiguratorIntent;
const CANARY_DXF_B64 = FIXTURES_B64["sendcutsend/kerf-canary-100x50.dxf"]!;

function makeDeps(records: Map<string, JobRecord> = new Map()): QuoteApiDeps {
  return {
    getVendor,
    getFixtureBytes,
    hostFor: (mode) => {
      if (mode === "live") {
        throw new HostUnavailableError("live mode unavailable: BROWSER_USE_API_KEY is not set");
      }
      return new ScriptedHost();
    },
    store: new MemoryJobStore(records),
  };
}

/** A posted-wire copy of the canary intent with inline (correct) bytes. */
function postedCanary(): Record<string, unknown> {
  return {
    ...structuredClone(canaryIntentJson as Record<string, unknown>),
    files: [
      {
        ...(canaryIntent.files[0] as unknown as Record<string, unknown>),
        bytes_base64: CANARY_DXF_B64,
      },
    ],
  };
}

test("quote API: scripted canary run delivers the $5.58 quote", async () => {
  const records = new Map<string, JobRecord>();
  const res = await handleQuoteRequest({ vendor: "sendcutsend" }, makeDeps(records));

  assert.equal(res.status, 200);
  if (res.status !== 200) return;
  assert.equal(res.body.state, "DELIVERED");
  assert.ok(res.body.quote);
  assert.equal(res.body.quote!.unit_price.amount_minor, 558);
  assert.equal(res.body.quote!.pricing_basis, "quoted");
  assert.equal(res.body.intent_hash, await intentHash(canaryIntent));
  assert.equal(res.body.live_url, "https://live.example/scripted");

  // Evidence: one upload-hash item + one screenshot, two claims, both pass.
  assert.equal(res.body.evidence.items, 2);
  const verdicts = Object.fromEntries(res.body.evidence.claims.map((c) => [c.oracle, c.verdict]));
  assert.equal(verdicts["kerf/upload-hash"], "pass");
  assert.equal(verdicts["kerf/quote-extraction"], "pass");

  // The quote references the evidence items it is backed by.
  assert.equal(res.body.quote!.evidence.length, 2);

  // The job is queryable afterwards, with the bundle attached.
  const store = new MemoryJobStore(records);
  const rec = await store.get(res.body.job_id);
  assert.ok(rec);
  assert.equal(rec!.state, "DELIVERED");
  assert.equal(rec!.kind, "quote");
  assert.equal(rec!.vendor, "sendcutsend");
  assert.ok(rec!.evidence);
  assert.equal(rec!.evidence!.items.length, 2);
});

test("quote API: posted intent with hash-true bytes succeeds; bytes never stored", async () => {
  const records = new Map<string, JobRecord>();
  const res = await handleQuoteRequest(
    { vendor: "sendcutsend", mode: "scripted", intent: postedCanary() },
    makeDeps(records),
  );

  assert.equal(res.status, 200);
  if (res.status !== 200) return;
  assert.equal(res.body.state, "DELIVERED");
  assert.equal(res.body.quote!.unit_price.amount_minor, 558);
  // Same design → same intent_hash as the registry canary (bytes_base64,
  // idempotency_key, and ship_to are all excluded from the hash).
  assert.equal(res.body.intent_hash, await intentHash(canaryIntent));

  // The upload-hash discipline: bytes are stripped before hashing/storage.
  const rec = [...records.values()][0]!;
  assert.ok(!JSON.stringify(rec).includes("bytes_base64"));
  assert.ok(!JSON.stringify(res.body).includes("bytes_base64"));
});

test("quote API: sha256 mismatch is rejected 400 at the door — no job created", async () => {
  const records = new Map<string, JobRecord>();
  const intent = postedCanary();
  (intent.files as Array<Record<string, unknown>>)[0]!.bytes_base64 =
    Buffer.from("not the canary bytes, same declared hash").toString("base64");
  (intent.files as Array<Record<string, unknown>>)[0]!.bytes = 40;

  const res = await handleQuoteRequest(
    { vendor: "sendcutsend", intent },
    makeDeps(records),
  );
  assert.equal(res.status, 400);
  if (res.status !== 400) return;
  assert.match(res.body.error, /sha256 mismatch/);
  assert.equal(records.size, 0, "a rejected request must not leave a job behind");
});

test("quote API: unknown vendor is 404", async () => {
  const res = await handleQuoteRequest({ vendor: "acme-fab" }, makeDeps());
  assert.equal(res.status, 404);
  if (res.status !== 404) return;
  assert.match(res.body.error, /unknown vendor "acme-fab"/);
});

test("quote API: live mode without a key is 503", async () => {
  const res = await handleQuoteRequest(
    { vendor: "sendcutsend", mode: "live" },
    makeDeps(),
  );
  assert.equal(res.status, 503);
  if (res.status !== 503) return;
  assert.match(res.body.error, /BROWSER_USE_API_KEY/);
});

test("quote API: a failed run records FAILED with a fail claim, still 200", async () => {
  const records = new Map<string, JobRecord>();
  const intent = postedCanary();
  (intent.config as Record<string, unknown>).material = "Unobtainium 9000";

  const res = await handleQuoteRequest(
    { vendor: "sendcutsend", intent },
    makeDeps(records),
  );
  assert.equal(res.status, 200);
  if (res.status !== 200) return;
  assert.equal(res.body.state, "FAILED");
  assert.equal(res.body.quote, null);

  const verdicts = Object.fromEntries(res.body.evidence.claims.map((c) => [c.oracle, c.verdict]));
  assert.equal(verdicts["kerf/upload-hash"], "pass");
  assert.equal(verdicts["kerf/quote-extraction"], "fail");

  const rec = [...records.values()][0]!;
  assert.equal(rec.state, "FAILED");
  assert.match(rec.error ?? "", /needs_repair/);
});

test("quote API: structural validation rejects bad intents with 400", async () => {
  const cases: Array<{ patch: (i: Record<string, unknown>) => void; want: RegExp }> = [
    { patch: (i) => (i.kind = "catalog"), want: /kind must be "configurator"/ },
    { patch: (i) => delete i.process, want: /process is required/ },
    { patch: (i) => (i.quantity = 0), want: /quantity must be an integer >= 1/ },
    { patch: (i) => delete i.budget_cap, want: /budget_cap/ },
    { patch: (i) => (i.config = "aluminum"), want: /config must be an object/ },
    {
      patch: (i) => delete (i.files as Array<Record<string, unknown>>)[0]!.bytes_base64,
      want: /bytes_base64 is required/,
    },
  ];
  for (const { patch, want } of cases) {
    const intent = postedCanary();
    patch(intent);
    const res = await handleQuoteRequest({ vendor: "sendcutsend", intent }, makeDeps());
    assert.equal(res.status, 400, `expected 400 for ${want}`);
    if (res.status !== 400) continue;
    assert.match(res.body.error, want);
  }
});

test("quote API: unknown registry intent key is 400", async () => {
  const res = await handleQuoteRequest(
    { vendor: "sendcutsend", intentKey: "nope" },
    makeDeps(),
  );
  assert.equal(res.status, 400);
  if (res.status !== 400) return;
  assert.match(res.body.error, /has no intent "nope"/);
});
