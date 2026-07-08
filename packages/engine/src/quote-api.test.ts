import { test } from "node:test";
import assert from "node:assert/strict";

import type { ConfiguratorIntent } from "@kerf/core";
import { FIXTURES_B64, getFixtureBytes, getVendor } from "@kerf/registry";
import type { QuoteApiDeps } from "./quote-api.ts";
import { handleQuoteRequest, HostUnavailableError } from "./quote-api.ts";
import { intentHash, sha256HexBytes } from "./hash.ts";
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

test("quote API: multi-file intent — upload-hash claim scopes to what was actually uploaded", async () => {
  // The SCS quote playbook uploads /files/0 only. A second posted file is
  // hash-verified at the API door but never fed to the vendor — the claim
  // must say so instead of implying an upload that never happened.
  const secondBytes = Buffer.from("kerf second plate — never reached by the playbook");
  const intent = postedCanary();
  (intent.files as Array<Record<string, unknown>>).push({
    name: "second-plate.dxf",
    bytes: secondBytes.length,
    sha256: await sha256HexBytes(secondBytes),
    media_type: "image/vnd.dxf",
    bytes_base64: secondBytes.toString("base64"),
  });

  const res = await handleQuoteRequest({ vendor: "sendcutsend", intent }, makeDeps());
  assert.equal(res.status, 200);
  if (res.status !== 200) return;
  assert.equal(res.body.state, "DELIVERED");

  const claim = res.body.evidence.claims.find((c) => c.oracle === "kerf/upload-hash");
  assert.ok(claim);
  // Both files hash-true → still pass (fail-closed semantics untouched)…
  assert.equal(claim!.verdict, "pass");
  // …but the claim is honest about its scope.
  assert.equal(claim!.reason, "verified at API ingress; not all files uploaded by playbook");
  assert.match(claim!.observed ?? "", /kerf-canary-100x50\.dxf=[0-9a-f]{64}(,|$)/);
  assert.match(
    claim!.observed ?? "",
    /second-plate\.dxf=[0-9a-f]{64} \(ingress only — not uploaded\)/,
  );
  assert.ok(claim!.evidence.includes("upload:/files/0"), "uploaded file keeps upload: evidence");
  assert.ok(claim!.evidence.includes("ingress:/files/1"), "non-uploaded file is ingress: evidence");

  // Single-file canary control: everything uploaded → no scoping reason.
  const single = await handleQuoteRequest(
    { vendor: "sendcutsend", intent: postedCanary() },
    makeDeps(),
  );
  assert.equal(single.status, 200);
  if (single.status !== 200) return;
  const singleClaim = single.body.evidence.claims.find((c) => c.oracle === "kerf/upload-hash");
  assert.equal(singleClaim!.verdict, "pass");
  assert.equal(singleClaim!.reason, undefined);
  assert.ok(singleClaim!.evidence.includes("upload:/files/0"));
});

test("quote API: size caps reject oversized posted intents before decode", async () => {
  // Per-file cap: declared bytes over 25 MB → 400, no decode attempted.
  const perFile = postedCanary();
  (perFile.files as Array<Record<string, unknown>>)[0]!.bytes = 26 * 1024 * 1024;
  const res1 = await handleQuoteRequest({ vendor: "sendcutsend", intent: perFile }, makeDeps());
  assert.equal(res1.status, 400);
  if (res1.status === 400) assert.match(res1.body.error, /per-file cap/);

  // Total cap: three files under the per-file cap but 63 MB combined → 400.
  const total = postedCanary();
  const file0 = (total.files as Array<Record<string, unknown>>)[0]!;
  total.files = [0, 1, 2].map((n) => ({ ...file0, name: `plate-${n}.dxf`, bytes: 21 * 1024 * 1024 }));
  const res2 = await handleQuoteRequest({ vendor: "sendcutsend", intent: total }, makeDeps());
  assert.equal(res2.status, 400);
  if (res2.status === 400) assert.match(res2.body.error, /bytes total, over/);

  // Payload larger than the declared size implies → 400 before decode.
  const inflated = postedCanary();
  (inflated.files as Array<Record<string, unknown>>)[0]!.bytes_base64 =
    Buffer.alloc(4096).toString("base64");
  const res3 = await handleQuoteRequest({ vendor: "sendcutsend", intent: inflated }, makeDeps());
  assert.equal(res3.status, 400);
  if (res3.status === 400) assert.match(res3.body.error, /larger than the declared/);
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
