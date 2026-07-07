import { test } from "node:test";
import assert from "node:assert/strict";

import type { ConfiguratorIntent, Playbook } from "@kerf/core";
import { runPlaybook } from "./runner.ts";
import { quoteFromRun } from "./quote-from-run.ts";
import { MemoryEvidenceSink } from "./evidence-sink.ts";
import { ScriptedSession } from "./scripted-session.ts";

import quoteJson from "../../registry/sendcutsend/playbooks/quote.json" with { type: "json" };
import canaryIntentJson from "../../registry/sendcutsend/fixtures/canary-intent.json" with { type: "json" };

const playbook = quoteJson as unknown as Playbook;
const canaryIntent = canaryIntentJson as unknown as ConfiguratorIntent;

function opts(intent: ConfiguratorIntent, session: ScriptedSession, evidence?: MemoryEvidenceSink) {
  return {
    session,
    intent,
    resolveFile: (_ptr: string) => ({
      fileName: intent.files[0]!.name,
      bytesBase64: "MApTRUNUSU9O",
      mediaType: "image/vnd.dxf",
    }),
    ...(evidence ? { evidence } : {}),
  };
}

test("e2e: recorded SCS quote playbook drives the scripted flow to a quote", async () => {
  const session = new ScriptedSession();
  const evidence = new MemoryEvidenceSink();
  const run = await runPlaybook(playbook, opts(canaryIntent, session, evidence));

  assert.equal(run.outcome, "completed", run.reason ?? "");
  assert.equal(run.bag.unit_price, 558);
  assert.equal(run.bag.subtotal, 558); // qty 1
  assert.equal(run.bag.lead_time, "Arrives as soon as: Jul 11");
  assert.equal(evidence.items.length, 1);
  assert.equal(evidence.items[0]!.name, "priced_configurator");

  // Every money-adjacent step's assertions passed (they're in the trace).
  const money = run.trace.filter((t) =>
    ["select-thickness", "set-quantity", "extract-unit-price", "extract-subtotal"].includes(t.stepId),
  );
  assert.equal(money.length, 4);
  assert.ok(money.every((t) => t.ok));

  const quote = quoteFromRun({
    vendor: "sendcutsend",
    intent: canaryIntent,
    run,
    quoteId: "q_test",
    intentHash: "deadbeef",
  });
  assert.equal(quote.pricing_basis, "quoted");
  assert.equal(quote.unit_price.amount_minor, 558);
  assert.equal(quote.total.amount_minor, 558);
});

test("e2e: quantity flows through to subtotal", async () => {
  const session = new ScriptedSession();
  const intent = { ...canaryIntent, quantity: 10 };
  const run = await runPlaybook(playbook, opts(intent, session));
  assert.equal(run.outcome, "completed", run.reason ?? "");
  assert.equal(run.bag.subtotal, 5580); // 558 * 10
  const quote = quoteFromRun({ vendor: "sendcutsend", intent, run, quoteId: "q", intentHash: "h" });
  assert.equal(quote.total.amount_minor, 5580);
});

test("abort: a money-adjacent assertion failure stops the run cold", async () => {
  // Thickness label the site doesn't offer → mock selects nothing → the
  // checked-radio readback mismatches the intent code → abort.
  const session = new ScriptedSession();
  const intent = {
    ...canaryIntent,
    config: { ...canaryIntent.config, thickness_label: '.999" (nonsense)' },
  };
  const run = await runPlaybook(playbook, opts(intent, session));
  assert.equal(run.outcome, "aborted");
  assert.equal(run.stoppedAt, "select-thickness");
  assert.match(run.reason ?? "", /assertion failed/);
});

test("needs_repair: a missing navigation label escalates, never guesses", async () => {
  const session = new ScriptedSession();
  const intent = {
    ...canaryIntent,
    config: { ...canaryIntent.config, material: "Unobtainium 9000" },
  };
  const run = await runPlaybook(playbook, opts(intent, session));
  assert.equal(run.outcome, "needs_repair");
  assert.equal(run.stoppedAt, "select-alloy");
});

test("quoteFromRun refuses to fabricate a quote from a non-completed run", () => {
  assert.throws(() =>
    quoteFromRun({
      vendor: "sendcutsend",
      intent: canaryIntent,
      run: { outcome: "aborted", bag: {}, trace: [], stoppedAt: "x", reason: "y" },
      quoteId: "q",
      intentHash: "h",
    }),
  );
});
