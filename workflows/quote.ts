/**
 * The quote job — Wave 0. Zero money, zero account: walk a vendor's public
 * instant-quote flow with the intent's files and configuration, extract a
 * priced, evidence-backed VendorQuote (pricing_basis "quoted", ACP-CM 0.2).
 *
 * The orchestration lives in @kerf/engine (`runQuoteJob`), fully tested
 * against a scripted host. This module binds it to the registry (manifest +
 * recorded playbook + embedded fixture bytes) and to a BrowserHost supplied
 * by the caller. The host is INJECTED rather than constructed here so the
 * job stays host-agnostic: the scripted host drives it in tests today, and
 * the Browser Use cloud CDP host drives it in production once that adapter is
 * verified against a live session.
 *
 * `"use workflow"` makes the whole job a durable run. Step-level durability
 * (wrapping each playbook action as a `"use step"`) is the next increment;
 * the seam is the engine's per-step trace.
 */

import type { BrowserHost, QuoteJobResult } from "@kerf/engine";
import { runQuoteJob } from "@kerf/engine";
import { getFixtureBytes, getVendor } from "@kerf/registry";

export interface QuoteJobInput {
  job_id: string;
  /** Registry vendor id, e.g. "sendcutsend". */
  vendor: string;
  /** Which fixture intent to quote (Wave 0 canary uses "canary"). A live
   *  order supplies a full intent instead; wired when ordering lands. */
  intentKey?: string;
  host: BrowserHost;
}

export async function quoteJob(input: QuoteJobInput): Promise<QuoteJobResult> {
  "use workflow";

  const vendor = getVendor(input.vendor);
  const playbook = vendor.playbooks.quote;
  if (!playbook) {
    throw new Error(`kerf: vendor "${input.vendor}" has no quote playbook`);
  }
  const intent = vendor.intents[input.intentKey ?? "canary"];
  if (!intent) {
    throw new Error(
      `kerf: vendor "${input.vendor}" has no intent "${input.intentKey ?? "canary"}"`,
    );
  }

  return runQuoteJob({
    host: input.host,
    intent,
    playbook,
    quoteId: input.job_id,
    // Fixture bytes are embedded in the registry (base64) — resolve the
    // intent's file pointer to uploadable bytes with no filesystem.
    resolveFile: (pointer: string) => {
      const idx = Number.parseInt(pointer.replace(/^\/files\//, ""), 10);
      const file = intent.files[idx];
      if (!file) throw new Error(`kerf: no file at "${pointer}"`);
      const bytes = getFixtureBytes(input.vendor, file.name);
      return {
        fileName: file.name,
        bytesBase64: Buffer.from(bytes).toString("base64"),
        ...(file.media_type ? { mediaType: file.media_type } : {}),
      };
    },
  });
}
