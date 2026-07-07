import { test } from "node:test";
import assert from "node:assert/strict";

import type { ConfiguratorIntent, Playbook } from "@kerf/core";
import { runQuoteJob } from "./quote-job.ts";
import { intentHash } from "./hash.ts";
import { MemoryEvidenceSink } from "./evidence-sink.ts";
import { ScriptedHost } from "./scripted-session.ts";

import quoteJson from "../../registry/sendcutsend/playbooks/quote.json" with { type: "json" };
import canaryIntentJson from "../../registry/sendcutsend/fixtures/canary-intent.json" with { type: "json" };

const playbook = quoteJson as unknown as Playbook;
const canaryIntent = canaryIntentJson as unknown as ConfiguratorIntent;

function resolveFile(intent: ConfiguratorIntent) {
  return () => ({ fileName: intent.files[0]!.name, bytesBase64: "MApTRUNUSU9O" });
}

test("runQuoteJob: happy path returns a quote, live url, and closes the session", async () => {
  const host = new ScriptedHost();
  const evidence = new MemoryEvidenceSink();
  const res = await runQuoteJob({
    host,
    intent: canaryIntent,
    playbook,
    quoteId: "q1",
    resolveFile: resolveFile(canaryIntent),
    evidence,
  });

  assert.equal(res.run.outcome, "completed", res.run.reason ?? "");
  assert.ok(res.quote);
  assert.equal(res.quote!.unit_price.amount_minor, 558);
  assert.equal(res.quote!.pricing_basis, "quoted");
  assert.equal(res.live_url, "https://live.example/scripted");
  assert.equal(host.closed, 1); // session always closed
  assert.equal(evidence.items.length, 1);
});

test("runQuoteJob: intent_hash is stable and matches intentHash()", async () => {
  const host = new ScriptedHost();
  const res = await runQuoteJob({
    host,
    intent: canaryIntent,
    playbook,
    quoteId: "q2",
    resolveFile: resolveFile(canaryIntent),
  });
  assert.equal(res.intent_hash, await intentHash(canaryIntent));
  assert.equal(res.quote!.intent_hash, res.intent_hash);
});

test("runQuoteJob: a failed run yields no quote but still closes the session", async () => {
  const host = new ScriptedHost();
  const intent = {
    ...canaryIntent,
    config: { ...canaryIntent.config, material: "Unobtainium 9000" },
  };
  const res = await runQuoteJob({
    host,
    intent,
    playbook,
    quoteId: "q3",
    resolveFile: resolveFile(intent),
  });
  assert.equal(res.run.outcome, "needs_repair");
  assert.equal(res.quote, null);
  assert.equal(host.closed, 1);
});

test("intentHash: order-invariant on config key order, sensitive to values", async () => {
  const a = { vendor: "v", quantity: 1, config: { x: "1", y: "2" }, files: [{ sha256: "s" }] };
  const b = { vendor: "v", quantity: 1, config: { y: "2", x: "1" }, files: [{ sha256: "s" }] };
  const c = { vendor: "v", quantity: 2, config: { x: "1", y: "2" }, files: [{ sha256: "s" }] };
  assert.equal(await intentHash(a), await intentHash(b)); // key order invariant
  assert.notEqual(await intentHash(a), await intentHash(c)); // qty change → new hash
});
