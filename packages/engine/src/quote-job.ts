/**
 * runQuoteJob — orchestration around the runner: open a session, run the
 * playbook, build the quote, always close the session. Pure with respect to
 * the browser (it takes a BrowserHost), so it is testable end-to-end with a
 * scripted host and reused verbatim by the durable `quoteJob` workflow.
 */

import type { ConfiguratorIntent, VendorQuote } from "@kerf/core";
import type { BrowserHost } from "./browser-host.ts";
import type { EvidenceSink } from "./evidence-sink.ts";
import type { Playbook } from "@kerf/core";
import type { RunResult } from "./runner.ts";
import { runPlaybook } from "./runner.ts";
import { quoteFromRun } from "./quote-from-run.ts";
import { intentHash } from "./hash.ts";

export interface RunQuoteJobArgs {
  host: BrowserHost;
  intent: ConfiguratorIntent;
  playbook: Playbook;
  quoteId: string;
  resolveFile: (pointer: string) => {
    fileName: string;
    bytesBase64: string;
    mediaType?: string;
  };
  evidence?: EvidenceSink;
}

export interface QuoteJobResult {
  run: RunResult;
  /** The quote, or null when the run did not complete (see run.outcome). */
  quote: VendorQuote | null;
  intent_hash: string;
  live_url: string | null;
}

export async function runQuoteJob(args: RunQuoteJobArgs): Promise<QuoteJobResult> {
  const hash = await intentHash(args.intent);
  const session = await args.host.open();
  try {
    const run = await runPlaybook(args.playbook, {
      session,
      intent: args.intent,
      resolveFile: args.resolveFile,
      ...(args.evidence ? { evidence: args.evidence } : {}),
    });
    const quote = run.outcome === "completed"
      ? quoteFromRun({
          vendor: args.intent.vendor,
          intent: args.intent,
          run,
          quoteId: args.quoteId,
          intentHash: hash,
        })
      : null;
    return { run, quote, intent_hash: hash, live_url: session.liveUrl };
  } finally {
    await args.host.close(session);
  }
}
