/**
 * Map a completed quote-playbook run to a VendorQuote (@kerf/core).
 *
 * The pricing basis is `quoted` per ACP-CM 0.2 — the fab's own displayed
 * price for the exact bytes and config, evidence-backed but held by no
 * server-side reservation. The money plane decides whether a given vendor's
 * `quoted` may gate spend (SCS's cart preserves the price through checkout,
 * so it qualifies); the executor never claims `binding` on its own.
 */

import type { ConfiguratorIntent, VendorQuote } from "@kerf/core";
import type { RunResult } from "./runner.ts";

export interface QuoteFromRunArgs {
  vendor: string;
  intent: ConfiguratorIntent;
  run: RunResult;
  quoteId: string;
  intentHash: string;
  evidenceIds?: string[];
}

export function quoteFromRun(args: QuoteFromRunArgs): VendorQuote {
  const { run, intent } = args;
  if (run.outcome !== "completed") {
    throw new Error(
      `kerf: cannot build a quote from a ${run.outcome} run (stopped at ${run.stoppedAt ?? "?"}: ${run.reason ?? ""})`,
    );
  }

  const unit = asMinor(run.bag.unit_price);
  const subtotal = asMinor(run.bag.subtotal);
  if (unit === null) {
    throw new Error("kerf: quote run completed but extracted no unit_price");
  }
  const total = subtotal ?? unit * intent.quantity;
  const lead = typeof run.bag.lead_time === "string" ? run.bag.lead_time : null;

  const notes: string[] = [];
  if (lead) notes.push(`lead: ${lead}`);
  notes.push("pricing_basis quoted — fab's displayed price, no reservation");

  return {
    quote_id: args.quoteId,
    vendor: args.vendor,
    intent_hash: args.intentHash,
    pricing_basis: "quoted",
    unit_price: { currency: "USD", amount_minor: unit },
    total: { currency: "USD", amount_minor: total },
    lead_time_days: 0, // raw lead text preserved in notes until a date parser lands
    evidence: args.evidenceIds ?? [],
    notes,
  };
}

function asMinor(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
